/**
 * WP-D3 - ordered, idempotent, in-code migration runner - plus the Phase-1
 * schema migrations (WP-D4..D8) and the pricing seed (WP-C1).
 *
 * Applied migration ids are recorded in `schema_version` together with a
 * content checksum; running the runner twice yields an identical schema and
 * applies nothing the second time, and a migration edited after being applied
 * fails the run loudly (see `migrationChecksum`).
 */
import { createHash } from 'node:crypto';
import type { SqliteDatabase } from './connection';

export interface Migration {
  /** Strictly increasing, never reused, never reordered. */
  readonly id: number;
  readonly name: string;
  readonly up: (db: SqliteDatabase) => void;
}

/** The five priced token buckets (parser-spec section 5.4). */
const TOKEN_BUCKETS = ['input', 'output', 'cache_read', 'cache_write_5m', 'cache_write_1h'];
const BUCKET_CHECK = TOKEN_BUCKETS.map((b) => `'${b}'`).join(',');

/**
 * WP-C1 pricing seed, authored 2026-07-11, from parser-spec section 5.4.
 *
 * These are APPROXIMATE LIST prices - a mechanism proof for the cost engine,
 * NOT a billing source. Derived buckets per model: cache_read = 0.1 x input,
 * cache_write_5m = 1.25 x input, cache_write_1h = 2.0 x input.
 * '<synthetic>' is priced 0 for all buckets. The parser must halt loudly on
 * an unknown model id - never silently price it at 0.
 *
 * effective_from is the FLOOR from which these list prices apply, NOT the seed
 * authoring date. computeCostUsd resolves the latest rate with
 * effectiveFrom <= message timestamp and throws when none is effective; the
 * real corpus contains messages back to 2026-07-03 (~12.2k before the authoring
 * date), so a 2026-07-11 floor would halt every historical ingest. These are a
 * single flat mechanism-proof price applied across the whole observed window,
 * so the floor is set before the corpus. PROVISIONAL (WP-C1) - the price
 * NUMBERS are unchanged and still await ratification; only the coverage floor
 * moved so the engine can price historical data at all.
 *
 * FROZEN: these constants are covered by every migration's content checksum
 * (see `migrationChecksum`) because an in-place edit of exactly these values
 * is how migration 7 diverged from the operator database (review H-1). A
 * pricing change must ship as a NEW migration carrying its own inline data,
 * never by editing these.
 */
const PRICING_SEED_EFFECTIVE_FROM = '2026-01-01';
const PRICING_SEED: ReadonlyArray<{
  model: string;
  inputUsdPerMtok: number;
  outputUsdPerMtok: number;
}> = [
  // Keys are the EXACT `message.model` byte-strings emitted in the corpus
  // (verified 2026-07-13 against ~/.claude/projects: claude-opus-4-8 x4819,
  // claude-sonnet-5 x3286, claude-fable-5 x1849, claude-haiku-4-5-20251001 x2,
  // <synthetic> x17). computeCostUsd does a HARD exact-string lookup and halts
  // loudly on any id absent here - so a bare 'opus-4-8' key (no 'claude-'
  // prefix; haiku also carries a date suffix) would make every real ingest
  // halt. Do not "normalize" the id on the read side; add the exact string.
  { model: 'claude-opus-4-8', inputUsdPerMtok: 5, outputUsdPerMtok: 25 },
  { model: 'claude-sonnet-5', inputUsdPerMtok: 3, outputUsdPerMtok: 15 },
  { model: 'claude-fable-5', inputUsdPerMtok: 10, outputUsdPerMtok: 50 },
  { model: 'claude-haiku-4-5-20251001', inputUsdPerMtok: 1, outputUsdPerMtok: 5 },
  { model: '<synthetic>', inputUsdPerMtok: 0, outputUsdPerMtok: 0 },
];

export const migrations: readonly Migration[] = [
  {
    id: 1,
    name: 'events-raw-append-only',
    up(db) {
      // WP-D4: the immutable raw-event substrate. Append-only is enforced in
      // the storage engine itself, not by adapter discipline.
      db.exec(`
        CREATE TABLE events_raw (
          id              INTEGER PRIMARY KEY,
          idempotency_key TEXT NOT NULL UNIQUE,
          source          TEXT NOT NULL CHECK (source IN ('hook','jsonl')),
          event_type      TEXT NOT NULL,
          payload         TEXT NOT NULL,
          received_at     TEXT NOT NULL
        );
        CREATE TRIGGER events_raw_no_update
        BEFORE UPDATE ON events_raw
        BEGIN
          SELECT RAISE(ABORT, 'events_raw is append-only');
        END;
        CREATE TRIGGER events_raw_no_delete
        BEFORE DELETE ON events_raw
        BEGIN
          SELECT RAISE(ABORT, 'events_raw is append-only');
        END;
      `);
    },
  },
  {
    id: 2,
    name: 'sessions',
    up(db) {
      // Keyed on session-uuid, never the project slug (parser-spec 6.2:
      // two same-slug concurrent sessions must stay two roots).
      db.exec(`
        CREATE TABLE sessions (
          id               TEXT PRIMARY KEY,
          project_slug     TEXT,
          started_at       TEXT,
          last_activity_at TEXT,
          status           TEXT
        );
      `);
    },
  },
  {
    id: 3,
    name: 'events',
    up(db) {
      // WP-D5: normalized event projection; every row points back at its
      // immutable raw source (FK enforced by the WP-D2 connection pragmas).
      db.exec(`
        CREATE TABLE events (
          id           INTEGER PRIMARY KEY,
          raw_event_id INTEGER NOT NULL REFERENCES events_raw(id),
          session_id   TEXT,
          agent_id     TEXT,
          event_type   TEXT,
          occurred_at  TEXT
        );
        CREATE INDEX idx_events_session_id ON events(session_id);
      `);
    },
  },
  {
    id: 4,
    name: 'agents-self-referential',
    up(db) {
      // WP-D6: agents are first-class queryable entities; the subagent tree
      // is a data fact via the self-referential parent_agent_id.
      // 'unknown' status is REQUIRED (open-decisions OPEN-2: the missing-Stop
      // watchdog assigns it).
      db.exec(`
        CREATE TABLE agents (
          id              TEXT PRIMARY KEY,
          session_id      TEXT NOT NULL REFERENCES sessions(id),
          type            TEXT CHECK (type IN ('main','subagent')),
          subagent_type   TEXT,
          status          TEXT CHECK (status IN ('working','waiting','completed','error','unknown')),
          parent_agent_id TEXT REFERENCES agents(id) ON DELETE SET NULL,
          first_seen_at   TEXT,
          last_seen_at    TEXT
        );
        CREATE INDEX idx_agents_parent_agent_id ON agents(parent_agent_id);
        CREATE INDEX idx_agents_session_id ON agents(session_id);
      `);
    },
  },
  {
    id: 5,
    name: 'orchestration-edges',
    up(db) {
      // WP-D7: the moat artifact - persisted, per-instance spawn edges
      // (never a render-time reconstruction). source enumerates the four
      // structural join paths of parser-spec section 4. instance/host_id are
      // NOT NULL by design for future fleet aggregation (DESIGN.md 2.4).
      // Insert path is INSERT OR IGNORE against the UNIQUE logical key.
      db.exec(`
        CREATE TABLE orchestration_edges (
          id              INTEGER PRIMARY KEY,
          session_id      TEXT NOT NULL,
          parent_agent_id TEXT NOT NULL,
          child_agent_id  TEXT NOT NULL,
          source          TEXT NOT NULL CHECK (source IN ('tool_use','directory','task_notification','queue_operation')),
          instance        TEXT NOT NULL,
          host_id         TEXT NOT NULL,
          created_at      TEXT,
          UNIQUE (session_id, parent_agent_id, child_agent_id)
        );
        CREATE INDEX idx_orchestration_edges_session_id ON orchestration_edges(session_id);
      `);
    },
  },
  {
    id: 6,
    name: 'token-usage',
    up(db) {
      // WP-D8: ground-truth token usage. UNIQUE(message_id, bucket) is the
      // N3 dedup guarantee at the storage level - one usage row per message
      // per bucket (parser-spec 5.2: naive row summation over-counts ~2.4x).
      // It is also the conflict target of the convergence upsert in
      // db/token-usage.ts, which corrects a mid-stream partial in place.
      // agent_id is nullable by design: the writer resolves a main-transcript
      // turn to the session id (the main agent's node id), so a NULL here means
      // a row whose owner genuinely could not be joined - surfaced as
      // `unattributed`, never hidden (parser-spec 5.1).
      db.exec(`
        CREATE TABLE token_usage (
          id                      INTEGER PRIMARY KEY,
          session_id              TEXT NOT NULL,
          agent_id                TEXT,
          message_id              TEXT NOT NULL,
          model                   TEXT NOT NULL,
          bucket                  TEXT NOT NULL CHECK (bucket IN (${BUCKET_CHECK})),
          tokens                  INTEGER NOT NULL,
          is_compaction_baseline  INTEGER NOT NULL DEFAULT 0,
          occurred_at             TEXT,
          UNIQUE (message_id, bucket)
        );
        CREATE INDEX idx_token_usage_session_id ON token_usage(session_id);
        CREATE INDEX idx_token_usage_agent_id ON token_usage(agent_id);
      `);
    },
  },
  {
    id: 7,
    name: 'model-pricing-with-seed',
    up(db) {
      // WP-C1: versioned bucket-and-model-aware pricing. The composite PK
      // lets multiple effective_from rows per (model, bucket) coexist.
      db.exec(`
        CREATE TABLE model_pricing (
          model          TEXT NOT NULL,
          bucket         TEXT NOT NULL CHECK (bucket IN (${BUCKET_CHECK})),
          usd_per_mtok   REAL NOT NULL,
          effective_from TEXT NOT NULL,
          PRIMARY KEY (model, bucket, effective_from)
        );
      `);
      const insert = db.prepare(
        'INSERT INTO model_pricing (model, bucket, usd_per_mtok, effective_from) VALUES (?, ?, ?, ?)',
      );
      for (const { model, inputUsdPerMtok, outputUsdPerMtok } of PRICING_SEED) {
        const rates: Record<string, number> = {
          input: inputUsdPerMtok,
          output: outputUsdPerMtok,
          cache_read: inputUsdPerMtok * 0.1,
          cache_write_5m: inputUsdPerMtok * 1.25,
          cache_write_1h: inputUsdPerMtok * 2.0,
        };
        for (const bucket of TOKEN_BUCKETS) {
          insert.run(model, bucket, rates[bucket], PRICING_SEED_EFFECTIVE_FROM);
        }
      }
    },
  },
  {
    id: 8,
    name: 'token-usage-main-agent-attribution',
    up(db) {
      // Repairs databases written before db/token-usage.ts attributed
      // main-transcript turns at insert time: those rows carry agent_id NULL,
      // so the session root reported a permanent $0 while its spend showed up
      // as `unattributed`. This is the hard join the original schema comment
      // promised - session_id onto the main agent node that already exists in
      // `agents` - and it invents nothing: rows with no such node stay NULL and
      // stay visible as unattributed, and no token value is touched.
      //
      // A live corpus also self-heals without this (the next re-ingest of a
      // session rewrites its attribution); the migration covers the sessions
      // whose transcripts are no longer on disk to be re-read.
      db.exec(`
        UPDATE token_usage
           SET agent_id = session_id
         WHERE agent_id IS NULL
           AND EXISTS (
             SELECT 1 FROM agents a
             WHERE a.id = token_usage.session_id AND a.type = 'main'
           );
      `);
    },
  },
  {
    id: 9,
    name: 'ingest-checkpoints',
    up(db) {
      // WP-IN10 replay checkpoint: the persisted memory that lets a restart
      // skip the sessions whose bytes have not moved since the last run. Rows
      // are a CACHE of work already done, never a source of dashboard truth -
      // dropping the whole table costs one full replay and changes no result.
      //
      // `scope` is a sha-256 of the resolved corpus root, not the root itself:
      // an absolute path on this machine encodes the user's home directory, and
      // the same hygiene that makes `sanitizeFailureReason` strip paths out of
      // failure reports applies to anything the database persists. A different
      // corpus root is a different scope and therefore a full replay.
      //
      // `ingest_revision` is the code-side semantics stamp (see
      // REPLAY_CHECKPOINT_REVISION): bumping it invalidates every checkpoint at
      // once, which is how a parser / cost-engine / schema change forces the
      // corpus to be re-read instead of silently keeping stale projections.
      //
      // WITHOUT ROWID: every access is a point lookup or a scan on the primary
      // key, and there is no surrogate id worth storing.
      db.exec(`
        CREATE TABLE ingest_checkpoints (
          scope           TEXT NOT NULL,
          session_id      TEXT NOT NULL,
          fingerprint     TEXT NOT NULL,
          ingest_revision INTEGER NOT NULL,
          recorded_at     TEXT NOT NULL,
          PRIMARY KEY (scope, session_id)
        ) WITHOUT ROWID;
      `);
    },
  },
  {
    id: 10,
    name: 'retention-scan-indexes',
    up(db) {
      // WP-D10 retention: pruning selects by age, in id order, in bounded
      // batches (`MAX_ROWS_PER_RUN`). Without these the delete pass is a full
      // table scan of the two tables that grow without bound - exactly the
      // tables retention exists to bound - so the maintenance job gets slower
      // precisely as the database gets bigger.
      //
      // `(occurred_at, id)` and not `(occurred_at)` alone: the batch cursor is
      // (age, id), so the trailing id makes the scan a covering range read and
      // keeps the batch boundary stable across runs rather than depending on
      // whatever order the engine happens to return for equal timestamps.
      //
      // These are pure read-path accelerators. They change no result, only the
      // time it takes to reach it - a dropped index costs speed, never truth.
      db.exec(`
        CREATE INDEX idx_events_occurred_at_id ON events(occurred_at, id);
        CREATE INDEX idx_token_usage_occurred_at_id ON token_usage(occurred_at, id);
      `);
    },
  },
  {
    id: 11,
    name: 'model-pricing-seed-convergence',
    up(db) {
      // Corrective migration (review H-1). Migration 7's seed was edited IN
      // PLACE after the operator database had applied it: the original seed
      // wrote bare model keys ('opus-4-8', 'sonnet-5', 'fable-5', 'haiku-4-5')
      // with a '2026-07-11' floor, while the current 7 writes the corpus-exact
      // 'claude-'-prefixed keys (haiku date-suffixed) at '2026-01-01'. The
      // runner skips by recorded id, so a database that ran the ORIGINAL 7
      // kept the old rows - and under current code every real-model message
      // failed the PricingError halt gate. This migration converges both
      // histories: delete exactly the original seed's rows, then upsert the
      // canonical ones. On a database that ran the current 7 the delete
      // matches nothing and the upsert rewrites identical values - either
      // start state ends row-identical. Operator-authored rows (any other
      // model key or effective_from) are never touched.
      db.exec(`
        DELETE FROM model_pricing
        WHERE effective_from = '2026-07-11'
          AND model IN ('opus-4-8', 'sonnet-5', 'fable-5', 'haiku-4-5', '<synthetic>');
      `);
      const upsert = db.prepare(
        `INSERT INTO model_pricing (model, bucket, usd_per_mtok, effective_from)
         VALUES (?, ?, ?, ?)
         ON CONFLICT (model, bucket, effective_from) DO UPDATE SET usd_per_mtok = excluded.usd_per_mtok`,
      );
      // Same derivation as migration 7, duplicated INSIDE this up() body on
      // purpose: the content checksum covers this function's source, and a
      // shared helper would let a rate-multiplier edit escape it.
      for (const { model, inputUsdPerMtok, outputUsdPerMtok } of PRICING_SEED) {
        const rates: Record<string, number> = {
          input: inputUsdPerMtok,
          output: outputUsdPerMtok,
          cache_read: inputUsdPerMtok * 0.1,
          cache_write_5m: inputUsdPerMtok * 1.25,
          cache_write_1h: inputUsdPerMtok * 2.0,
        };
        for (const bucket of TOKEN_BUCKETS) {
          upsert.run(model, bucket, rates[bucket], PRICING_SEED_EFFECTIVE_FROM);
        }
      }
    },
  },
  {
    id: 12,
    name: 'orchestration-edge-endpoint-indexes',
    up(db) {
      // Review M-5 (index half): the global-DAG edge query filters on
      // parent_agent_id AND child_agent_id, but migration 5 indexed only
      // session_id - so every DAG page full-scanned the edge table. Pure
      // read-path accelerators, same contract as migration 10: a dropped
      // index costs speed, never truth.
      db.exec(`
        CREATE INDEX idx_orchestration_edges_parent_agent_id ON orchestration_edges(parent_agent_id);
        CREATE INDEX idx_orchestration_edges_child_agent_id ON orchestration_edges(child_agent_id);
      `);
    },
  },
  {
    id: 13,
    name: 'orchestration-edges-legacy-explore-source',
    up(db) {
      // Parser gate #7: pre-2.1.71 bare-`Explore` sidecars join via a
      // name-based heuristic, and the parser emits that edge with the
      // DISTINCT source 'legacy_explore' (never disguised as 'tool_use' -
      // provenance honesty is the design rule the CHECK exists to defend).
      // Migration 5's CHECK enumerates only the four structural paths, so
      // ingesting such a session would abort on the constraint and the whole
      // legacy DAG would silently stay frozen. SQLite cannot ALTER a CHECK:
      // rebuild the table, copy every row byte-for-byte, and recreate the
      // three indexes (migrations 5 and 12) that DROP TABLE takes with it.
      db.exec(`
        CREATE TABLE orchestration_edges_new (
          id              INTEGER PRIMARY KEY,
          session_id      TEXT NOT NULL,
          parent_agent_id TEXT NOT NULL,
          child_agent_id  TEXT NOT NULL,
          source          TEXT NOT NULL CHECK (source IN ('tool_use','directory','task_notification','queue_operation','legacy_explore')),
          instance        TEXT NOT NULL,
          host_id         TEXT NOT NULL,
          created_at      TEXT,
          UNIQUE (session_id, parent_agent_id, child_agent_id)
        );
        INSERT INTO orchestration_edges_new
          (id, session_id, parent_agent_id, child_agent_id, source, instance, host_id, created_at)
          SELECT id, session_id, parent_agent_id, child_agent_id, source, instance, host_id, created_at
            FROM orchestration_edges;
        DROP TABLE orchestration_edges;
        ALTER TABLE orchestration_edges_new RENAME TO orchestration_edges;
        CREATE INDEX idx_orchestration_edges_session_id ON orchestration_edges(session_id);
        CREATE INDEX idx_orchestration_edges_parent_agent_id ON orchestration_edges(parent_agent_id);
        CREATE INDEX idx_orchestration_edges_child_agent_id ON orchestration_edges(child_agent_id);
      `);
    },
  },
];

export interface MigrationRunResult {
  /** Ids applied by THIS run (empty when the schema was already current). */
  readonly appliedIds: readonly number[];
}

/**
 * Content checksum for a migration, recorded in `schema_version` at apply
 * time and re-verified on every run, so an in-place edit of an already
 * applied migration fails loudly instead of silently diverging (review H-1:
 * the live database keeps the OLD effect while a fresh database gets the NEW
 * one, and nothing detects it).
 *
 * The hash covers the migration's own `up` source AND the module-level seed
 * constants, because the historical in-place edit went through PRICING_SEED -
 * a constant OUTSIDE any up() body, invisible to a body-only hash. Whitespace
 * is stripped before hashing so formatting and TS-transform differences never
 * trip the verifier; the trade-off is that a whitespace-only edit inside a
 * string literal is not detectable.
 */
export function migrationChecksum(migration: Migration): string {
  const frozenConstants = JSON.stringify({
    TOKEN_BUCKETS,
    PRICING_SEED_EFFECTIVE_FROM,
    PRICING_SEED,
  });
  return createHash('sha256')
    .update(`${String(migration.id)}\n${migration.name}\n`)
    .update(migration.up.toString().replace(/\s+/g, ''))
    .update('\n')
    .update(frozenConstants)
    .digest('hex');
}

/**
 * Apply all pending migrations in order, each inside a transaction that also
 * records its id and content checksum in `schema_version`. Idempotent: a
 * second run applies nothing and leaves the schema byte-identical. Throws
 * before applying anything when an already-applied migration's current
 * content no longer matches its recorded checksum.
 */
export function runMigrations(
  db: SqliteDatabase,
  list: readonly Migration[] = migrations,
): MigrationRunResult {
  assertOrdered(list);
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_version (
      id         INTEGER PRIMARY KEY,
      name       TEXT NOT NULL,
      applied_at TEXT NOT NULL,
      checksum   TEXT
    );
  `);
  ensureChecksumColumn(db);
  verifyAppliedChecksums(db, list);
  const appliedBefore = new Set(
    (db.prepare('SELECT id FROM schema_version').all() as Array<{ id: number }>).map((r) => r.id),
  );
  const record = db.prepare(
    'INSERT INTO schema_version (id, name, applied_at, checksum) VALUES (?, ?, ?, ?)',
  );
  const appliedIds: number[] = [];
  for (const migration of list) {
    if (appliedBefore.has(migration.id)) {
      continue;
    }
    db.transaction(() => {
      migration.up(db);
      record.run(
        migration.id,
        migration.name,
        new Date().toISOString(),
        migrationChecksum(migration),
      );
    })();
    appliedIds.push(migration.id);
  }
  return { appliedIds };
}

/**
 * Databases migrated before checksum recording carry the three-column
 * `schema_version`; CREATE TABLE IF NOT EXISTS never alters an existing shape,
 * so the column is added here. It stays nullable: NULL means "applied before
 * checksums existed" until the trust-on-first-verify backfill fills it.
 */
function ensureChecksumColumn(db: SqliteDatabase): void {
  const columns = db
    .prepare("SELECT name FROM pragma_table_info('schema_version')")
    .pluck()
    .all() as string[];
  if (!columns.includes('checksum')) {
    db.exec('ALTER TABLE schema_version ADD COLUMN checksum TEXT;');
  }
}

function verifyAppliedChecksums(db: SqliteDatabase, list: readonly Migration[]): void {
  const byId = new Map(list.map((m) => [m.id, m] as const));
  const rows = db.prepare('SELECT id, checksum FROM schema_version').all() as Array<{
    id: number;
    checksum: string | null;
  }>;
  const backfill = db.prepare('UPDATE schema_version SET checksum = ? WHERE id = ?');
  for (const row of rows) {
    const migration = byId.get(row.id);
    if (migration === undefined) {
      // Applied by a build that knew more migrations than this one; content
      // unknown here, so there is nothing to verify it against.
      continue;
    }
    const current = migrationChecksum(migration);
    if (row.checksum === null) {
      // Trust-on-first-verify backfill: rows written before checksum
      // recording cannot prove what content actually ran (the H-1 edit
      // itself is invisible here - migration 11 repairs that data instead).
      // Recording the current content once makes every FUTURE edit loud.
      backfill.run(current, row.id);
      continue;
    }
    if (row.checksum !== current) {
      throw new Error(
        `Migration ${String(row.id)} (${migration.name}) was edited after being applied: ` +
          'its current content no longer matches the checksum recorded at apply time. ' +
          'An applied migration is immutable - restore its original content and ship the ' +
          'change as a NEW migration instead.',
      );
    }
  }
}

/** Highest applied migration id, or 0 for a virgin database. */
export function currentSchemaVersion(db: SqliteDatabase): number {
  const table = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'schema_version'")
    .get();
  if (table === undefined) {
    return 0;
  }
  const row = db.prepare('SELECT MAX(id) AS version FROM schema_version').get() as {
    version: number | null;
  };
  return row.version ?? 0;
}

function assertOrdered(list: readonly Migration[]): void {
  let previousId = 0;
  for (const migration of list) {
    if (migration.id <= previousId) {
      throw new Error(
        `Migration ids must be strictly increasing: ${migration.id} follows ${previousId}.`,
      );
    }
    previousId = migration.id;
  }
}
