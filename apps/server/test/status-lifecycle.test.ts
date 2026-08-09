/**
 * The agent / session STATUS LIFECYCLE — the one state machine, end to end.
 *
 * The rule this file pins, and the reason it exists:
 *
 *   READING A TRANSCRIPT PROVES ACTIVITY, NEVER TERMINATION.
 *
 * Ingest may therefore only ever assert `'working'`. A terminal verdict has to
 * be OBSERVED (a `Stop` / `SubagentStop` hook) or INFERRED and marked as such
 * (the WP-IN12 watchdog's `'unknown'`). Before this file existed, ingest derived
 * status from `ParsedAgent.endedAt` — a field the parser always populates with
 * the last record's timestamp — so every agent and session was stamped
 * `'completed'` while it was still running, `'working'`/`'waiting'` were written
 * nowhere, the watchdog had no candidates and `DASHBOARD_WATCHDOG_MINUTES`
 * tuned nothing.
 *
 * The five states (packages/shared AgentStatusSchema — unchanged, nothing
 * widened) and their sole producers:
 *
 *   working    ingest    first sighting, or activity ADVANCED since last time
 *   waiting    hook      `Stop` — the main agent finished a turn and is idle
 *   completed  hook      `SubagentStop` — an identified subagent terminated
 *   error      (no producer in v1 — reserved, never guessed)
 *   unknown    watchdog  no activity for DASHBOARD_WATCHDOG_MINUTES
 *
 * Two asymmetries carry the honesty rule:
 *   - an OBSERVED terminal (`completed` / `error`) is STICKY: a trailing
 *     transcript flush after `SubagentStop` must not resurrect a dead agent;
 *   - an INFERRED terminal (`unknown`) and idle (`waiting`) YIELD to fresh
 *     activity evidence — that is the OPEN-2 revert rule, made concrete.
 *
 * CD-1 is asserted structurally at the end: a hook moves `status` and nothing
 * else — never creating, deleting or re-parenting an agent.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { type PricingEntry, type SessionSubstrate } from '@agenthropic/core';
import { getFixture } from '@agenthropic/test-fixtures';
import { loadConfig } from '../src/config';
import { applyAgentStatus, setAgentStatus } from '../src/db/agents';
import { SqliteEventStore } from '../src/db/event-store';
import { applyHookLiveness, resolveHookStatusTarget } from '../src/hooks/liveness-status';
import { HOOK_DELIVERY_ID_HEADER, HOOK_EVENT_PATH, registerHookRoutes } from '../src/hooks/routes';
import { createCorpusWatcher } from '../src/ingest/corpus-watcher';
import { ingestSession, type IngestDeps } from '../src/ingest/ingest-session';
import { runWatchdogSweep } from '../src/ingest/watchdog';
import { buildServer } from '../src/server';
import { makeFakeCorpusFs } from './corpus/fake-corpus-fs';
import { TEST_TOKEN, createMigratedTempDb, type TempDb } from './helpers';

const FIXED_NOW = '2026-07-11T00:00:00.000Z';
const AUTH = { authorization: `Bearer ${TEST_TOKEN}` };
const BUCKETS = ['input', 'output', 'cache_read', 'cache_write_5m', 'cache_write_1h'] as const;

/** The flat-tool-use fixture's ids (see packages/test-fixtures). */
const SESSION_ID = '11111111-2222-4333-8444-555555555555';
const SUBAGENT_ID = '3fa9c2d1';

const PRICING: readonly PricingEntry[] = ['synthetic-model-a', 'synthetic-model-b'].flatMap(
  (model): PricingEntry[] =>
    BUCKETS.map((bucket) => ({ model, bucket, usdPerMtok: 1, effectiveFrom: '2020-01-01' })),
);

/**
 * Append one timestamped user record to the fixture's MAIN transcript, so the
 * main agent's activity anchor genuinely moves forward. Everything else about
 * the substrate is byte-identical — this isolates "activity advanced" from
 * "the session changed shape".
 */
function withAdvancedActivity(substrate: SessionSubstrate, timestamp: string): SessionSubstrate {
  const [main, ...rest] = substrate.files;
  if (main === undefined) {
    throw new Error('fixture has no main transcript');
  }
  const extra = JSON.stringify({
    parentUuid: null,
    isSidechain: false,
    userType: 'external',
    sessionId: SESSION_ID,
    type: 'user',
    message: { role: 'user', content: 'A later synthetic turn.' },
    uuid: 'aaaaaaaa-0000-4000-8000-00000000ffff',
    timestamp,
  });
  return { files: [{ ...main, lines: [...main.lines, extra] }, ...rest] };
}

function statusOfAgent(temp: TempDb, id: string): string | null {
  const row = temp.db.prepare('SELECT status FROM agents WHERE id = ?').get(id) as
    { status: string | null } | undefined;
  return row?.status ?? null;
}

function statusOfSession(temp: TempDb, id: string): string | null {
  const row = temp.db.prepare('SELECT status FROM sessions WHERE id = ?').get(id) as
    { status: string | null } | undefined;
  return row?.status ?? null;
}

describe('status lifecycle', () => {
  let temp: TempDb;

  beforeEach(() => {
    temp = createMigratedTempDb();
  });

  afterEach(() => {
    temp.cleanup();
  });

  function deps(overrides: Partial<IngestDeps> = {}): IngestDeps {
    return {
      db: temp.db,
      pricing: PRICING,
      instance: 'local',
      hostId: 'test-host',
      projectSlug: 'test-slug',
      now: () => FIXED_NOW,
      ...overrides,
    };
  }

  // --- ingest: activity, never termination ---------------------------------

  describe('ingest never concludes completion', () => {
    it("writes 'working' for every agent and for the session on first sighting", () => {
      const outcome = ingestSession(getFixture('flat-tool-use'), deps());
      expect(outcome.ok).toBe(true);

      const statuses = temp.db
        .prepare('SELECT id, status FROM agents ORDER BY id')
        .all() as ReadonlyArray<{ id: string; status: string | null }>;
      expect(statuses.length).toBeGreaterThan(1);
      for (const row of statuses) {
        expect(row.status).toBe('working');
      }
      expect(statusOfSession(temp, SESSION_ID)).toBe('working');
    });

    it("never writes 'completed' for ANY fixture — no transcript proves termination", () => {
      for (const name of ['flat-tool-use', 'nested-workflow', 'depth-2-sync'] as const) {
        const fresh = createMigratedTempDb();
        try {
          const outcome = ingestSession(getFixture(name), deps({ db: fresh.db }));
          expect(outcome.ok).toBe(true);
          const terminal = fresh.db
            .prepare("SELECT COUNT(*) AS n FROM agents WHERE status IN ('completed','error')")
            .get() as { n: number };
          expect(terminal.n).toBe(0);
        } finally {
          fresh.cleanup();
        }
      }
    });
  });

  describe('re-ingest', () => {
    it('leaves status untouched when nothing advanced (the byte-identical replay rule)', () => {
      ingestSession(getFixture('flat-tool-use'), deps());
      setAgentStatus(temp.db, SESSION_ID, 'unknown');

      ingestSession(getFixture('flat-tool-use'), deps());

      expect(statusOfAgent(temp, SESSION_ID)).toBe('unknown');
    });

    it("reverts an inferred 'unknown' to 'working' when activity actually advanced (OPEN-2)", () => {
      const fixture = getFixture('flat-tool-use');
      ingestSession(fixture, deps());
      setAgentStatus(temp.db, SESSION_ID, 'unknown');
      setAgentStatus(temp.db, SUBAGENT_ID, 'unknown');

      const outcome = ingestSession(
        withAdvancedActivity(fixture, '2026-01-15T23:59:00.000Z'),
        deps(),
      );
      expect(outcome.ok).toBe(true);

      // The MAIN agent's anchor moved, so its inferred verdict yields.
      expect(statusOfAgent(temp, SESSION_ID)).toBe('working');
      expect(statusOfSession(temp, SESSION_ID)).toBe('working');
      // The subagent's transcript did NOT change: no new evidence, no revert.
      expect(statusOfAgent(temp, SUBAGENT_ID)).toBe('unknown');
    });

    it('keeps an OBSERVED terminal sticky even when a later flush advances activity', () => {
      const fixture = getFixture('flat-tool-use');
      ingestSession(fixture, deps());
      setAgentStatus(temp.db, SESSION_ID, 'completed');

      ingestSession(withAdvancedActivity(fixture, '2026-01-15T23:59:00.000Z'), deps());

      expect(statusOfAgent(temp, SESSION_ID)).toBe('completed');
    });
  });

  // --- watchdog: the inferred arm ------------------------------------------

  describe("watchdog reachability — 'working' -> 'unknown' is live code", () => {
    it('flips an ingested agent that goes quiet, and mirrors it onto the session', () => {
      ingestSession(getFixture('flat-tool-use'), deps());
      expect(statusOfAgent(temp, SESSION_ID)).toBe('working');

      const transitions = runWatchdogSweep(temp.db, Date.parse('2026-07-11T00:00:00Z'), 60_000);

      expect(transitions).toContainEqual({
        type: 'agent-status-changed',
        agentId: SESSION_ID,
        sessionId: SESSION_ID,
        oldStatus: 'working',
        newStatus: 'unknown',
      });
      expect(statusOfAgent(temp, SESSION_ID)).toBe('unknown');
      expect(statusOfSession(temp, SESSION_ID)).toBe('unknown');
    });

    it('DASHBOARD_WATCHDOG_MINUTES actually decides the verdict (the knob is real)', () => {
      const base = { DASHBOARD_TOKEN: TEST_TOKEN, DASHBOARD_INGEST: '0' };

      const patient = loadConfig({ ...base, DASHBOARD_WATCHDOG_MINUTES: '60' });
      const impatient = loadConfig({ ...base, DASHBOARD_WATCHDOG_MINUTES: '10' });
      expect(patient.watchdogMinutes).toBe(60);
      expect(impatient.watchdogMinutes).toBe(10);

      ingestSession(getFixture('flat-tool-use'), deps());

      // Read the anchor the watchdog will actually use rather than restating a
      // fixture constant, then sit exactly 30 minutes past it: a 60-minute
      // window is not exceeded, a 10-minute one is. Nothing else differs
      // between the two watchers.
      const anchor = temp.db
        .prepare('SELECT last_seen_at FROM agents WHERE id = ?')
        .get(SESSION_ID) as { last_seen_at: string };
      const nowMs = Date.parse(anchor.last_seen_at) + 30 * 60_000;

      const quiet = createCorpusWatcher({
        db: temp.db,
        pricing: [],
        env: { CLAUDE_PROJECTS_DIR: '/fake/corpus' },
        intervalMs: 1000,
        watchdogThresholdMs: patient.watchdogMinutes * 60_000,
        fs: makeFakeCorpusFs('/fake/corpus', {}),
        nowMs: () => nowMs,
      });
      quiet.tick();
      expect(statusOfAgent(temp, SESSION_ID)).toBe('working');

      const strict = createCorpusWatcher({
        db: temp.db,
        pricing: [],
        env: { CLAUDE_PROJECTS_DIR: '/fake/corpus' },
        intervalMs: 1000,
        watchdogThresholdMs: impatient.watchdogMinutes * 60_000,
        fs: makeFakeCorpusFs('/fake/corpus', {}),
        nowMs: () => nowMs,
      });
      strict.tick();
      expect(statusOfAgent(temp, SESSION_ID)).toBe('unknown');
    });
  });

  // --- hooks: the observed arm ---------------------------------------------

  describe('resolveHookStatusTarget', () => {
    it("maps Stop onto the session's main agent as 'waiting' (Stop ends a TURN, not a session)", () => {
      expect(
        resolveHookStatusTarget('Stop', { session_id: SESSION_ID, stop_hook_active: false }),
      ).toEqual({ agentId: SESSION_ID, status: 'waiting' });
    });

    it("maps SubagentStop onto an explicitly named subagent as 'completed'", () => {
      expect(
        resolveHookStatusTarget('SubagentStop', {
          session_id: SESSION_ID,
          agent_id: SUBAGENT_ID,
        }),
      ).toEqual({ agentId: SUBAGENT_ID, status: 'completed' });
    });

    it('derives the subagent from a transcript_path basename when no id is carried', () => {
      expect(
        resolveHookStatusTarget('SubagentStop', {
          session_id: SESSION_ID,
          transcript_path: `/home/u/.claude/projects/slug/subagents/agent-${SUBAGENT_ID}.jsonl`,
        }),
      ).toEqual({ agentId: SUBAGENT_ID, status: 'completed' });
    });

    it('accepts the camelCase transcriptPath spelling of the same fact', () => {
      expect(
        resolveHookStatusTarget('SubagentStop', {
          session_id: SESSION_ID,
          transcriptPath: `subagents/agent-${SUBAGENT_ID}.jsonl`,
        }),
      ).toEqual({ agentId: SUBAGENT_ID, status: 'completed' });
    });

    it('reads a bare filename with no directory part', () => {
      expect(
        resolveHookStatusTarget('SubagentStop', {
          transcript_path: `agent-${SUBAGENT_ID}.jsonl`,
        }),
      ).toEqual({ agentId: SUBAGENT_ID, status: 'completed' });
    });

    it('returns NO target rather than guessing when the subagent is unidentifiable', () => {
      expect(
        resolveHookStatusTarget('SubagentStop', {
          session_id: SESSION_ID,
          transcript_path: `/home/u/.claude/projects/slug/${SESSION_ID}.jsonl`,
        }),
      ).toBeNull();
      expect(resolveHookStatusTarget('SubagentStop', { session_id: SESSION_ID })).toBeNull();
      expect(resolveHookStatusTarget('Stop', { transcript_path: '/x.jsonl' })).toBeNull();
      expect(resolveHookStatusTarget('UserPromptSubmit', { session_id: SESSION_ID })).toBeNull();
      expect(resolveHookStatusTarget('PreCompact', { session_id: SESSION_ID })).toBeNull();
      expect(resolveHookStatusTarget('Stop', null)).toBeNull();
      expect(resolveHookStatusTarget('Stop', ['not', 'an', 'object'])).toBeNull();
    });

    it('refuses a filename that merely CONTAINS the agent- prefix', () => {
      // `not-agent-<hex>.jsonl` is not a subagent transcript; matching it would
      // invent an id and mark an unrelated agent completed.
      expect(
        resolveHookStatusTarget('SubagentStop', {
          transcript_path: `/home/u/not-agent-${SUBAGENT_ID}.jsonl`,
        }),
      ).toBeNull();
    });

    it('refuses a SubagentStop whose payload is not an object at all', () => {
      // The transcript-path fallback is the only route to an id here, so every
      // non-object shape has to bottom out at "no target", not at a throw.
      expect(resolveHookStatusTarget('SubagentStop', null)).toBeNull();
      expect(resolveHookStatusTarget('SubagentStop', ['not', 'an', 'object'])).toBeNull();
      expect(resolveHookStatusTarget('SubagentStop', 'a string')).toBeNull();
      expect(resolveHookStatusTarget('SubagentStop', 42)).toBeNull();
    });

    it('refuses a transcript_path that is present but unusable', () => {
      expect(resolveHookStatusTarget('SubagentStop', { transcript_path: '' })).toBeNull();
      expect(resolveHookStatusTarget('SubagentStop', { transcript_path: 42 })).toBeNull();
      expect(resolveHookStatusTarget('SubagentStop', { transcriptPath: null })).toBeNull();
    });
  });

  describe('applyHookLiveness', () => {
    it("Stop marks the main agent AND its session 'waiting'", () => {
      ingestSession(getFixture('flat-tool-use'), deps());

      const events = applyHookLiveness(temp.db, 'Stop', { session_id: SESSION_ID });

      expect(events).toEqual([
        {
          type: 'agent-status-changed',
          agentId: SESSION_ID,
          sessionId: SESSION_ID,
          oldStatus: 'working',
          newStatus: 'waiting',
        },
      ]);
      expect(statusOfAgent(temp, SESSION_ID)).toBe('waiting');
      expect(statusOfSession(temp, SESSION_ID)).toBe('waiting');
    });

    it("SubagentStop marks the named subagent 'completed' and leaves the session alone", () => {
      ingestSession(getFixture('flat-tool-use'), deps());

      const events = applyHookLiveness(temp.db, 'SubagentStop', {
        session_id: SESSION_ID,
        agent_id: SUBAGENT_ID,
      });

      expect(events).toHaveLength(1);
      expect(statusOfAgent(temp, SUBAGENT_ID)).toBe('completed');
      expect(statusOfAgent(temp, SESSION_ID)).toBe('working');
      expect(statusOfSession(temp, SESSION_ID)).toBe('working');
    });

    it("a fresh observation overrides an inferred 'unknown' — observed beats inferred", () => {
      ingestSession(getFixture('flat-tool-use'), deps());
      setAgentStatus(temp.db, SESSION_ID, 'unknown');

      const events = applyHookLiveness(temp.db, 'Stop', { session_id: SESSION_ID });

      expect(events[0]?.oldStatus).toBe('unknown');
      expect(statusOfAgent(temp, SESSION_ID)).toBe('waiting');
    });

    it('emits nothing when the status is already the observed value (no SSE noise per turn)', () => {
      ingestSession(getFixture('flat-tool-use'), deps());
      applyHookLiveness(temp.db, 'Stop', { session_id: SESSION_ID });

      expect(applyHookLiveness(temp.db, 'Stop', { session_id: SESSION_ID })).toEqual([]);
    });

    it('emits nothing for a hook that names no target', () => {
      ingestSession(getFixture('flat-tool-use'), deps());
      expect(applyHookLiveness(temp.db, 'UserPromptSubmit', { session_id: SESSION_ID })).toEqual(
        [],
      );
    });
  });

  // --- CD-1: liveness only, never structure --------------------------------

  describe('CD-1 — a hook moves liveness and NOTHING else', () => {
    function dumpAgents(): unknown[] {
      return temp.db.prepare('SELECT * FROM agents ORDER BY id').all();
    }

    it('never creates an agent for an id the JSONL has not produced', () => {
      ingestSession(getFixture('flat-tool-use'), deps());
      const before = dumpAgents();

      applyHookLiveness(temp.db, 'Stop', { session_id: 'no-such-session' });
      applyHookLiveness(temp.db, 'SubagentStop', {
        session_id: SESSION_ID,
        agent_id: 'deadbeef',
      });

      expect(dumpAgents()).toEqual(before);
    });

    it('changes ONLY the status column — never the parent, type, session or stamps', () => {
      ingestSession(getFixture('flat-tool-use'), deps());
      const before = dumpAgents() as ReadonlyArray<Record<string, unknown>>;

      applyHookLiveness(temp.db, 'Stop', { session_id: SESSION_ID });
      applyHookLiveness(temp.db, 'SubagentStop', {
        session_id: SESSION_ID,
        agent_id: SUBAGENT_ID,
      });

      const after = dumpAgents() as ReadonlyArray<Record<string, unknown>>;
      expect(after).toHaveLength(before.length);
      after.forEach((row, index) => {
        const original = before[index] as Record<string, unknown>;
        expect({ ...row, status: null }).toEqual({ ...original, status: null });
      });
    });

    it('deletes nothing and adds no edge', () => {
      ingestSession(getFixture('flat-tool-use'), deps());
      const edgesBefore = temp.db.prepare('SELECT * FROM orchestration_edges ORDER BY id').all();

      applyHookLiveness(temp.db, 'Stop', { session_id: SESSION_ID });
      applyHookLiveness(temp.db, 'SubagentStop', {
        session_id: SESSION_ID,
        agent_id: SUBAGENT_ID,
      });

      expect(temp.db.prepare('SELECT * FROM orchestration_edges ORDER BY id').all()).toEqual(
        edgesBefore,
      );
    });
  });

  describe('applyAgentStatus (the UPDATE-only primitive)', () => {
    it('returns null for an unknown agent id and writes nothing', () => {
      expect(applyAgentStatus(temp.db, 'nope', 'waiting')).toBeNull();
      const count = temp.db.prepare('SELECT COUNT(*) AS n FROM agents').get() as { n: number };
      expect(count.n).toBe(0);
    });
  });

  // --- the HTTP seam -------------------------------------------------------

  describe('POST /api/hooks/event applies liveness', () => {
    let app: FastifyInstance;
    let published: unknown[];

    beforeEach(async () => {
      published = [];
      ingestSession(getFixture('flat-tool-use'), deps());
      app = buildServer({ token: TEST_TOKEN, schemaVersion: 1 });
      await registerHookRoutes(app, {
        eventStore: new SqliteEventStore(temp.db),
        applyStatus: (hookName, payload) => {
          for (const event of applyHookLiveness(temp.db, hookName, payload)) {
            published.push(event);
          }
        },
      });
      await app.ready();
    });

    afterEach(async () => {
      await app.close();
    });

    it("a delivered Stop moves the main agent to 'waiting' and publishes the transition", async () => {
      const response = await app.inject({
        method: 'POST',
        url: HOOK_EVENT_PATH,
        headers: { ...AUTH, [HOOK_DELIVERY_ID_HEADER]: 'firing-1' },
        payload: { hook_event_name: 'Stop', session_id: SESSION_ID },
      });

      expect(response.statusCode).toBe(202);
      expect(response.json()).toEqual({ stored: true });
      expect(statusOfAgent(temp, SESSION_ID)).toBe('waiting');
      expect(published).toHaveLength(1);
    });

    it('a REDELIVERY (same delivery id) applies nothing a second time', async () => {
      const send = async (): Promise<number> => {
        const response = await app.inject({
          method: 'POST',
          url: HOOK_EVENT_PATH,
          headers: { ...AUTH, [HOOK_DELIVERY_ID_HEADER]: 'firing-1' },
          payload: {
            hook_event_name: 'SubagentStop',
            session_id: SESSION_ID,
            agent_id: SUBAGENT_ID,
          },
        });
        return response.statusCode;
      };

      expect(await send()).toBe(202);
      expect(await send()).toBe(202);
      expect(statusOfAgent(temp, SUBAGENT_ID)).toBe('completed');
      expect(published).toHaveLength(1);
    });

    it('an unauthenticated hook applies nothing', async () => {
      const response = await app.inject({
        method: 'POST',
        url: HOOK_EVENT_PATH,
        payload: { hook_event_name: 'Stop', session_id: SESSION_ID },
      });

      expect(response.statusCode).toBe(401);
      expect(statusOfAgent(temp, SESSION_ID)).toBe('working');
      expect(published).toEqual([]);
    });
  });
});
