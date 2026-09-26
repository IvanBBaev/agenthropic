/**
 * Every instant ingest stores is canonical ISO-8601 (`toISOString` form).
 *
 * `agents.first_seen_at` / `last_seen_at` and `sessions.started_at` /
 * `last_activity_at` are compared as TEXT: the monotonic
 * `MAX(excluded.x, stored.x)` and the status CASE's "strictly advance" `>`.
 * Text order equals instant order only when every value shares one spelling.
 * The parser passes each transcript's first/last record `timestamp` through
 * verbatim, so without a canonicalizing boundary a transcript written with an
 * offset, without milliseconds, or with junk would store a value that
 * misorders against its neighbours - permanently, because MAX never lets a
 * wrongly "larger" anchor go.
 *
 * Canonical input must stay byte-identical: that is what keeps the P0
 * double-replay proof and the checksum fixtures unchanged.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ParsedAgent, ParsedSession, PricingEntry } from '@agenthropic/core';
import { ingestSession, loadPricing } from '../src/index';
import type { IngestDeps } from '../src/index';
import { normalizeSession, type NormalizeOptions } from '../src/ingest/normalize-session';
import { createMigratedTempDb, type TempDb } from './helpers';

const SESSION = 'ssssssss-0000-4000-8000-00000000c0de';
const CHILD = 'c0de0001';
const OPTIONS: NormalizeOptions = {
  projectSlug: '-Users-synthetic-project',
  instance: 'test-instance',
  hostId: 'test-host',
};

function agent(id: string, overrides: Partial<ParsedAgent> = {}): ParsedAgent {
  return {
    id,
    type: 'subagent',
    subagentType: 'general-purpose',
    parentAgentId: null,
    startedAt: '2026-07-11T10:00:00.000Z',
    endedAt: '2026-07-11T10:00:05.000Z',
    ...overrides,
  };
}

function parsed(agents: ParsedAgent[]): ParsedSession {
  return { sessionId: SESSION, agents, edges: [], usage: [] };
}

describe('normalizeSession canonicalizes every stored instant', () => {
  it('rewrites offset and millisecond-less spellings to toISOString form', () => {
    const out = normalizeSession(
      parsed([
        agent(SESSION, {
          type: 'main',
          subagentType: null,
          startedAt: '2026-07-11T12:00:00+02:00',
          endedAt: '2026-07-11T10:00:01Z',
        }),
      ]),
      OPTIONS,
    );
    expect(out.agents[0]?.firstSeenAt).toBe('2026-07-11T10:00:00.000Z');
    expect(out.agents[0]?.lastSeenAt).toBe('2026-07-11T10:00:01.000Z');
    expect(out.session.startedAt).toBe('2026-07-11T10:00:00.000Z');
    expect(out.session.lastActivityAt).toBe('2026-07-11T10:00:01.000Z');
  });

  it('picks the session span by instant, not by raw text', () => {
    // As raw text '...:01Z' > '...:01.500Z' and '...+02:00' < '...Z' for the
    // same wall digits; by instant the .500Z agent is the latest and the
    // offset agent the earliest.
    const out = normalizeSession(
      parsed([
        agent('a0000001', {
          startedAt: '2026-07-11T10:00:00.100Z',
          endedAt: '2026-07-11T10:00:01Z',
        }),
        agent('a0000002', {
          startedAt: '2026-07-11T11:00:00.000+02:00',
          endedAt: '2026-07-11T10:00:01.500Z',
        }),
      ]),
      OPTIONS,
    );
    expect(out.session.startedAt).toBe('2026-07-11T09:00:00.000Z');
    expect(out.session.lastActivityAt).toBe('2026-07-11T10:00:01.500Z');
  });

  it('returns canonical input byte-identical', () => {
    const main = agent(SESSION, { type: 'main', subagentType: null });
    const out = normalizeSession(parsed([main, agent(CHILD, { parentAgentId: SESSION })]), OPTIONS);
    expect(out.session.startedAt).toBe(main.startedAt);
    expect(out.session.lastActivityAt).toBe(main.endedAt);
    expect(out.agents.map((a) => [a.firstSeenAt, a.lastSeenAt])).toEqual([
      [main.startedAt, main.endedAt],
      ['2026-07-11T10:00:00.000Z', '2026-07-11T10:00:05.000Z'],
    ]);
  });

  it.each([
    ['startedAt', { startedAt: 'garbage' }],
    ['endedAt', { endedAt: '2026-07-11t10:00:05.000z' }],
    ['endedAt', { endedAt: '2026-07-11T10:00:05' }],
  ] as const)('fails loudly on an unorderable %s', (_field, overrides) => {
    expect(() => normalizeSession(parsed([agent('a0000003', overrides)]), OPTIONS)).toThrow(
      /agent "a0000003".*unparsable ISO-8601 timestamp/,
    );
  });
});

describe('ingestSession stores canonical instants end to end', () => {
  const BUCKETS = ['input', 'output', 'cache_read', 'cache_write_5m', 'cache_write_1h'] as const;
  const PRICING: readonly PricingEntry[] = BUCKETS.map((bucket) => ({
    model: 'synthetic-model-a',
    bucket,
    usdPerMtok: 1,
    effectiveFrom: '2020-01-01',
  }));
  let temp: TempDb;

  beforeEach(() => {
    temp = createMigratedTempDb();
  });

  afterEach(() => {
    temp.cleanup();
  });

  function deps(): IngestDeps {
    return {
      db: temp.db,
      pricing: [...loadPricing(temp.db), ...PRICING],
      instance: 'local',
      hostId: 'test-host',
      projectSlug: 'test-slug',
      now: () => '2026-07-11T00:00:00.000Z',
    };
  }

  function mainLines(first: string, last: string): string[] {
    return [
      JSON.stringify({
        sessionId: SESSION,
        type: 'user',
        timestamp: first,
        message: { role: 'user', content: 'x' },
      }),
      JSON.stringify({
        sessionId: SESSION,
        type: 'assistant',
        timestamp: last,
        message: { id: 'm_main', model: 'synthetic-model-a', usage: { input_tokens: 1 } },
      }),
    ];
  }

  function stored(): { agent: unknown; session: unknown } {
    return {
      agent: temp.db
        .prepare('SELECT first_seen_at, last_seen_at FROM agents WHERE id = ?')
        .get(SESSION),
      session: temp.db
        .prepare('SELECT started_at, last_activity_at FROM sessions WHERE id = ?')
        .get(SESSION),
    };
  }

  it('an offset/millisecond-less transcript lands canonical, and a canonical re-read is a no-op', () => {
    const first = ingestSession(
      {
        files: [
          {
            relativePath: `${SESSION}.jsonl`,
            lines: mainLines('2026-05-01T02:00:00+02:00', '2026-05-01T00:00:01Z'),
          },
        ],
      },
      deps(),
    );
    expect(first.error).toBeNull();
    expect(stored()).toEqual({
      agent: {
        first_seen_at: '2026-05-01T00:00:00.000Z',
        last_seen_at: '2026-05-01T00:00:01.000Z',
      },
      session: {
        started_at: '2026-05-01T00:00:00.000Z',
        last_activity_at: '2026-05-01T00:00:01.000Z',
      },
    });

    // The same instants spelled canonically, plus one later record at .500:
    // a raw '...:01Z' anchor would have beaten '...:01.500Z' under MAX forever.
    const lines = mainLines('2026-05-01T00:00:00.000Z', '2026-05-01T00:00:01.000Z');
    lines.push(
      JSON.stringify({
        sessionId: SESSION,
        type: 'user',
        timestamp: '2026-05-01T00:00:01.500Z',
        message: { role: 'user', content: 'y' },
      }),
    );
    const second = ingestSession({ files: [{ relativePath: `${SESSION}.jsonl`, lines }] }, deps());
    expect(second.error).toBeNull();
    expect(stored()).toEqual({
      agent: {
        first_seen_at: '2026-05-01T00:00:00.000Z',
        last_seen_at: '2026-05-01T00:00:01.500Z',
      },
      session: {
        started_at: '2026-05-01T00:00:00.000Z',
        last_activity_at: '2026-05-01T00:00:01.500Z',
      },
    });
  });

  it('a junk boundary timestamp fails the session instead of poisoning the anchor', () => {
    const outcome = ingestSession(
      {
        files: [
          {
            relativePath: `${SESSION}.jsonl`,
            // Junk on the non-usage record: the cost halt gate never reads it.
            lines: mainLines('not-a-time', '2026-05-01T00:00:01.000Z'),
          },
        ],
      },
      deps(),
    );
    expect(outcome.ok).toBe(false);
    expect(outcome.error).toMatch(/unparsable ISO-8601 timestamp "not-a-time"/);
    expect(stored()).toEqual({ agent: undefined, session: undefined });
  });
});
