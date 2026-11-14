/**
 * R17 / QA-2 — the OPT-IN real-corpus contract suite.
 *
 * Synthetic fixtures cannot stand in for the real corpus (docs/site/contributing/
 * testing.md): every parser surprise so far — streamed partials, fast-mode model
 * renames, fork copies, legacy edges — was found on real transcripts. This suite
 * ingests one or more REAL corpora into a throwaway database and asserts the
 * structural invariants the census of record (parser-spec section 4.2) measured:
 *
 *  1. every discovered session ingests: 0 `SubstrateError`, 0 `UsageConflictError`,
 *     0 failures of any other kind;
 *  2. P0-1 reconciliation: every `token_usage` cell equals an independent read of
 *     the very bytes the ingest consumed (see ./independent-ledger.ts), and no
 *     independently seen message is missing;
 *  3. every usage row is attributed to exactly one agent of its own session;
 *  4. 0 orphans: every subagent has a parent and a persisted spawn edge;
 *  5. the edge census does not regress against the last recorded value.
 *
 * It never runs in `pnpm test` (the default config excludes this directory) and
 * refuses to run without its input:
 *
 *   AGENTHROPIC_REAL_CORPUS=~/.claude/projects pnpm test:real
 *
 * `AGENTHROPIC_REAL_CORPUS` is a `path.delimiter`-separated list of DISJOINT
 * corpus roots in the Claude Code projects layout (`<slug>/<uuid>.jsonl`), all
 * ingested into one database. The optional `AGENTHROPIC_REAL_CORPUS_CENSUS=<file>`
 * names a JSON census: the run fails if it regresses against the file, and
 * rewrites the file when it passes. Delete the file to reset the baseline.
 *
 * Read-only on the corpus. The database lives in a temp dir that is removed
 * afterwards, and the printed report carries counts and ids only — never a
 * record's content.
 */
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseSession, type SessionSubstrate } from '@agenthropic/core';
import {
  ingestSession,
  loadPricing,
  nodeCorpusFs,
  openDatabase,
  runCorpusIngest,
  runMigrations,
  type CorpusIngestSummary,
  type SqliteDatabase,
} from '../../src/index';
import { DB_BUCKETS, corpusEnv, type DbBucket } from '../p0/harness';
import {
  expectedLedger,
  tappingCorpusFs,
  type ExpectedMessage,
  type TappedTranscript,
} from './independent-ledger';

const CORPUS_ENV = 'AGENTHROPIC_REAL_CORPUS';
const CENSUS_ENV = 'AGENTHROPIC_REAL_CORPUS_CENSUS';
/** How many offending ids a failing assertion prints — enough to start, never a dump. */
const SAMPLE = 10;

const corpusRoots = (process.env[CORPUS_ENV] ?? '')
  .split(delimiter)
  .map((root) => root.trim())
  .filter((root) => root !== '')
  .map((root) => resolve(root.replace(/^~(?=$|\/)/, process.env['HOME'] ?? '~')));
if (corpusRoots.length === 0) {
  throw new Error(
    `${CORPUS_ENV} is not set. This suite is opt-in: point it at one or more corpus roots, ` +
      `e.g. ${CORPUS_ENV}=~/.claude/projects pnpm test:real`,
  );
}
const censusPath = process.env[CENSUS_ENV];

/** The persisted edge census the ratchet compares against. */
interface EdgeCensus {
  readonly sessionsDiscovered: number;
  readonly subagents: number;
  readonly edgedSubagents: number;
  readonly edges: number;
  readonly edgesBySource: Record<string, number>;
}

interface FailureRecord {
  readonly sessionId: string;
  readonly kind: string;
  readonly error: string;
}

/** The error class behind a failed ingest, recovered by re-parsing its substrate. */
function failureKind(substrate: SessionSubstrate): string {
  try {
    parseSession(substrate);
    return 'ingest (parse succeeded: storage, pricing or identity)';
  } catch (err) {
    return err instanceof Error ? err.name : 'non-Error throw';
  }
}

function sample<T>(items: readonly T[]): string {
  return JSON.stringify(items.slice(0, SAMPLE), null, 2);
}

describe(`real-corpus contract (${String(corpusRoots.length)} root(s))`, () => {
  let tempDir: string;
  let db: SqliteDatabase;
  const summaries: CorpusIngestSummary[] = [];
  const tapped = new Map<string, TappedTranscript>();
  const admitted = new Set<string>();
  /** Failed ingest's error message -> the error class behind it. */
  const failureKinds = new Map<string, string>();
  const skippedByReason = new Map<string, number>();
  let usageCollisions = 0;
  let ledger: Map<string, Map<string, ExpectedMessage>>;
  let ingestMs = 0;

  beforeAll(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'agenthropic-real-corpus-'));
    db = openDatabase(join(tempDir, 'agent.db'));
    runMigrations(db);
    const pricing = loadPricing(db);

    const started = Date.now();
    for (const root of corpusRoots) {
      const realRoot = realpathSync(root);
      summaries.push(
        runCorpusIngest({
          db,
          pricing,
          env: corpusEnv(realRoot, 'real-corpus-contract'),
          fs: tappingCorpusFs(nodeCorpusFs(), realRoot, tapped),
          ingest: (substrate, deps) => {
            const outcome = ingestSession(substrate, deps);
            if (!outcome.ok) {
              failureKinds.set(outcome.error ?? '', failureKind(substrate));
            }
            return outcome;
          },
          onSessionIngested: (event) => admitted.add(event.sessionId),
          onUsageCollisions: (count) => {
            usageCollisions += count;
          },
          onWarning: (skipped) => {
            skippedByReason.set(skipped.reason, (skippedByReason.get(skipped.reason) ?? 0) + 1);
          },
        }),
      );
    }
    ingestMs = Date.now() - started;
    ledger = expectedLedger(tapped.values(), admitted);
  });

  afterAll(() => {
    db.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  function total(key: keyof Omit<CorpusIngestSummary, 'failures'>): number {
    return summaries.reduce((sum, summary) => sum + summary[key], 0);
  }

  function count(sql: string): number {
    return (db.prepare(sql).get() as { n: number }).n;
  }

  function census(): EdgeCensus {
    const bySource = db
      .prepare(
        'SELECT source, COUNT(*) AS n FROM orchestration_edges GROUP BY source ORDER BY source',
      )
      .all() as { source: string; n: number }[];
    return {
      sessionsDiscovered: total('sessionsDiscovered'),
      subagents: count(`SELECT COUNT(*) AS n FROM agents WHERE type = 'subagent'`),
      edgedSubagents: count(
        `SELECT COUNT(*) AS n FROM agents a
          WHERE a.type = 'subagent'
            AND EXISTS (SELECT 1 FROM orchestration_edges e
                         WHERE e.child_agent_id = a.id AND e.session_id = a.session_id)`,
      ),
      edges: count('SELECT COUNT(*) AS n FROM orchestration_edges'),
      edgesBySource: Object.fromEntries(bySource.map((row) => [row.source, row.n])),
    };
  }

  it('reports the corpus it ingested (counts only)', () => {
    const report = {
      roots: corpusRoots.length,
      ingestSeconds: Math.round(ingestMs / 1000),
      sessionsOk: total('sessionsOk'),
      sessionsFailed: total('sessionsFailed'),
      sessionsSkipped: total('sessionsSkipped'),
      filesSkipped: Object.fromEntries(skippedByReason),
      transcriptsRead: tapped.size,
      usageMessages: count(`SELECT COUNT(*) AS n FROM token_usage WHERE bucket = 'output'`),
      crossSessionUsageCollisions: usageCollisions,
      unpricedTokens: total('totalUnpricedTokens'),
      ...census(),
    };
    console.log(`[real-corpus] ${JSON.stringify(report, null, 2)}`);
    expect(report.sessionsDiscovered).toBeGreaterThan(0);
  });

  it('ingests every session: 0 SubstrateError, 0 UsageConflictError, 0 failures', () => {
    const failures: FailureRecord[] = summaries.flatMap((summary) =>
      summary.failures.map((failure) => ({
        sessionId: failure.sessionId,
        kind: failureKinds.get(failure.error) ?? 'pre-ingest (session id mismatch)',
        error: failure.error.slice(0, 300),
      })),
    );
    const byKind: Record<string, number> = {};
    for (const failure of failures) {
      byKind[failure.kind] = (byKind[failure.kind] ?? 0) + 1;
    }
    expect(
      failures,
      `failures by kind ${JSON.stringify(byKind)}; first: ${sample(failures)}`,
    ).toHaveLength(0);
  });

  it('P0-1: every token_usage cell equals the independent read of the same bytes', () => {
    const mismatches: string[] = [];
    const stored = new Map<string, string>(); // messageId -> owning session
    let rows = 0;
    const statement = db.prepare(
      'SELECT session_id, agent_id, message_id, model, bucket, tokens FROM token_usage',
    );
    for (const row of statement.iterate() as Iterable<{
      session_id: string;
      agent_id: string | null;
      message_id: string;
      model: string;
      bucket: DbBucket;
      tokens: number;
    }>) {
      rows += 1;
      stored.set(row.message_id, row.session_id);
      const expected = ledger.get(row.session_id)?.get(row.message_id);
      if (expected === undefined) {
        mismatches.push(`${row.session_id}/${row.message_id}: stored, never read independently`);
        continue;
      }
      if (row.tokens !== expected.usage.buckets[row.bucket]) {
        mismatches.push(
          `${row.session_id}/${row.message_id}/${row.bucket}: db ${String(row.tokens)} != jsonl ${String(expected.usage.buckets[row.bucket])}`,
        );
      }
      if (row.model !== expected.usage.model) {
        mismatches.push(`${row.session_id}/${row.message_id}/${row.bucket}: model differs`);
      }
      if (row.agent_id === null || !expected.owners.has(row.agent_id)) {
        mismatches.push(
          `${row.session_id}/${row.message_id}/${row.bucket}: agent not a transcript owner`,
        );
      }
    }

    // Completeness: each independently seen message is stored exactly once, by
    // one of the sessions carrying it (M-12: the first-ingested copy owns it).
    for (const [sessionId, messages] of ledger) {
      for (const messageId of messages.keys()) {
        if (!stored.has(messageId)) {
          mismatches.push(
            `${sessionId}/${messageId}: read independently, missing from token_usage`,
          );
        }
      }
    }

    expect(stored.size).toBeGreaterThan(0);
    expect(rows, 'every stored message fans out to all five buckets').toBe(
      stored.size * DB_BUCKETS.length,
    );
    expect(
      mismatches,
      `${String(mismatches.length)} mismatch(es); first: ${sample(mismatches)}`,
    ).toHaveLength(0);

    // Not vacuous: the corpus really contains streamed partials to dedup.
    let usageLines = 0;
    for (const transcript of tapped.values()) {
      usageLines += admitted.has(transcript.sessionId) ? transcript.usageLines : 0;
    }
    expect(usageLines).toBeGreaterThan(stored.size);
  });

  it('attributes every usage row to exactly one agent of its own session', () => {
    const unattributed = db
      .prepare(
        `SELECT tu.session_id, tu.message_id
           FROM token_usage tu
           LEFT JOIN agents a ON a.id = tu.agent_id AND a.session_id = tu.session_id
          WHERE tu.agent_id IS NULL OR a.id IS NULL
          LIMIT ${String(SAMPLE)}`,
      )
      .all();
    expect(unattributed, `unattributed rows: ${sample(unattributed)}`).toEqual([]);

    const split = db
      .prepare(
        `SELECT session_id, message_id FROM token_usage
          GROUP BY session_id, message_id
         HAVING COUNT(DISTINCT agent_id) <> 1
          LIMIT ${String(SAMPLE)}`,
      )
      .all();
    expect(split, `messages split across agents: ${sample(split)}`).toEqual([]);
  });

  it('has 0 orphans: every subagent has a parent and a persisted spawn edge', () => {
    const orphans = db
      .prepare(
        `SELECT a.session_id, a.id, a.parent_agent_id IS NULL AS parentless
           FROM agents a
          WHERE a.type = 'subagent'
            AND (a.parent_agent_id IS NULL
                 OR NOT EXISTS (SELECT 1 FROM orchestration_edges e
                                 WHERE e.child_agent_id = a.id AND e.session_id = a.session_id))`,
      )
      .all();
    expect(orphans, `${String(orphans.length)} orphan(s); first: ${sample(orphans)}`).toHaveLength(
      0,
    );
  });

  it('does not regress the edge census against the last recorded value', () => {
    const current = census();
    expect(current.edges).toBeGreaterThan(0);
    if (censusPath === undefined) {
      return; // nothing recorded to compare against; the census is printed above
    }
    if (existsSync(censusPath)) {
      const previous = JSON.parse(readFileSync(censusPath, 'utf8')) as EdgeCensus;
      // The reconstruction RATE always ratchets. The absolute edge count only
      // does while the corpus has not shrunk: Claude Code prunes old sessions
      // (`cleanupPeriodDays`), which removes edges without any parser regression.
      expect(
        current.edgedSubagents * previous.subagents,
        `edge rate ${String(current.edgedSubagents)}/${String(current.subagents)} fell below ` +
          `${String(previous.edgedSubagents)}/${String(previous.subagents)}`,
      ).toBeGreaterThanOrEqual(previous.edgedSubagents * current.subagents);
      if (current.sessionsDiscovered >= previous.sessionsDiscovered) {
        expect(current.edges, `edges fell from ${String(previous.edges)}`).toBeGreaterThanOrEqual(
          previous.edges,
        );
      }
    }
    writeFileSync(censusPath, `${JSON.stringify(current, null, 2)}\n`);
  });
});
