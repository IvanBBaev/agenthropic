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
  {
    id: 14,
    name: 'model-pricing-canonical-effective-from',
    up(db) {
      // Review M-21 (production half). Dated-price resolution exists twice:
      // core's `computeCostUsd` compares instants in epoch milliseconds, the
      // API's priced CTE compares `effective_from <= occurred_at` as
      // BINARY-collated TEXT and orders candidates by `effective_from DESC`,
      // also as text. Ingest approves dollars with the first resolver, the
      // dashboard presents dollars with the second - and they agree only while
      // the stored text sorts chronologically.
      //
      // It did not. Migration 7 seeds the bare-date form ('2026-01-01'), an
      // operator seeding rates through the sqlite3 CLI writes whatever they
      // type, and nothing rejected either. With mixed spellings of the same
      // instant in the table, the text comparison picks a DIFFERENT row than
      // core does: at a rate change whose new row reads '2026-06-01T00:00:00Z'
      // and whose usage timestamp reads '2026-06-01T00:00:00.000Z' (the form
      // Claude Code JSONL actually writes), 'Z' sorts above '.', the new rate
      // is rejected as not-yet-effective, and the API silently bills the OLD
      // rate - dollars the halt gate never approved, flagged by nothing.
      //
      // The fix is at the source: one canonical spelling,
      // `YYYY-MM-DDTHH:mm:ss.sssZ` (see db/pricing.ts for why that form and no
      // other), made true of every row already stored AND of every row written
      // from here on. The SQL string comparison then holds because the data
      // cannot spell an instant any other way - not because the seed happened
      // to pick a prefix-safe form.
      //
      // Step 1 - rewrite what is already there. Done in JS, not SQL, so an
      // unparseable value can HALT with the offending row named instead of
      // being coerced by SQLite's much laxer date parser (which would read a
      // zone-less '2026-03-01T00:00:00' as UTC where ECMAScript reads it as
      // local time, and a bare '2026' as a Julian day number). Guessing a
      // pricing date silently is the failure class this project refuses.
      interface StoredRate {
        readonly model: string;
        readonly bucket: string;
        readonly usd_per_mtok: number;
        readonly effective_from: string;
      }
      // Duplicated from db/pricing.ts on purpose: the checksum covers only this
      // function's own source, so a migration that leaned on a shared helper
      // would silently change meaning when the helper changed (the convention
      // migration 11 documents).
      const acceptedInput =
        /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])(T([01]\d|2[0-3]):[0-5]\d:[0-5]\d(\.\d{3})?(Z|[+-]([01]\d|2[0-3]):[0-5]\d))?$/;
      const stored = db
        .prepare('SELECT model, bucket, usd_per_mtok, effective_from FROM model_pricing')
        .all() as StoredRate[];
      const canonical = new Map<string, StoredRate>();
      for (const row of stored) {
        // The second test catches a day the pattern allows but the calendar
        // does not ('2026-02-30'), which both parsers would otherwise roll
        // silently into the next month.
        const datePart = row.effective_from.slice(0, 10);
        const dateRoundTrip = new Date(`${datePart}T00:00:00.000Z`);
        const isRealDate =
          !Number.isNaN(dateRoundTrip.getTime()) &&
          dateRoundTrip.toISOString().slice(0, 10) === datePart;
        const epochMs =
          acceptedInput.test(row.effective_from) && isRealDate
            ? Date.parse(row.effective_from)
            : Number.NaN;
        if (Number.isNaN(epochMs)) {
          throw new Error(
            `Migration 14: model_pricing row (model=${row.model}, bucket=${row.bucket}) ` +
              `carries effective_from ${JSON.stringify(row.effective_from)}, which is not an ` +
              'unambiguous instant. A pricing date is never guessed and never dropped - fix ' +
              'the row by hand (bare UTC date, or a zoned ISO-8601 timestamp) and re-run.',
          );
        }
        const effectiveFrom = new Date(epochMs).toISOString();
        const key = `${row.model}\u0000${row.bucket}\u0000${effectiveFrom}`;
        const existing = canonical.get(key);
        if (existing !== undefined && existing.usd_per_mtok !== row.usd_per_mtok) {
          // Two spellings of ONE instant carrying two different rates: which
          // one was ever in force is unknowable from here, and picking either
          // would invent dollars. Halt and let a human decide.
          throw new Error(
            `Migration 14: model_pricing holds conflicting rates for (model=${row.model}, ` +
              `bucket=${row.bucket}) at ${effectiveFrom} - ${String(existing.usd_per_mtok)} and ` +
              `${String(row.usd_per_mtok)} USD/Mtok written under different spellings of the same ` +
              'instant. Delete the wrong row by hand and re-run; this migration will not choose.',
          );
        }
        // Same instant, same rate, two spellings: collapsing them changes no
        // dollar, and the composite primary key cannot hold both afterwards.
        canonical.set(key, { ...row, effective_from: effectiveFrom });
      }
      db.exec('DELETE FROM model_pricing');
      const reinsert = db.prepare(
        'INSERT INTO model_pricing (model, bucket, usd_per_mtok, effective_from) VALUES (?, ?, ?, ?)',
      );
      for (const row of canonical.values()) {
        reinsert.run(row.model, row.bucket, row.usd_per_mtok, row.effective_from);
      }
      // Step 2 - make a non-canonical value unstorable from here on.
      //
      // Two guard triggers reject any spelling that does not denote one
      // unambiguous instant (the GLOB whitelist mirrors
      // ACCEPTED_EFFECTIVE_FROM_INPUT in db/pricing.ts). The three conditions
      // after it close the gaps SQLite's lenient date parser leaves in a
      // pure shape check: `strftime(...) IS NULL` rejects digits that are not
      // a date at all ('2026-13-45'); re-deriving the date part from itself
      // rejects a day the calendar does not have ('2026-02-30', which SQLite
      // would roll into March 2 and price from a day nobody wrote); and the
      // hour bound rejects 'T24:00:00', the one accepted-looking spelling on
      // which the two canonicalizers disagree (ECMAScript rolls it into the
      // next midnight, SQLite prints the hour back as '24'). Two canonicalizing
      // triggers then rewrite every accepted spelling into the canonical form,
      // so after any successful write the column holds the canonical form or
      // the write aborted - the same guarantee a CHECK constraint gives,
      // reached the one way SQLite allows it to coexist with write-time
      // normalization (a BEFORE trigger cannot modify NEW, and a CHECK is
      // evaluated before any AFTER trigger could normalize, so a CHECK could
      // only REJECT the operator's hand-typed '2026-09-01' - and this is the
      // one table with a documented cross-connection write path, the operator
      // seeding rates via the sqlite3 CLI while the server runs).
      //
      // The AFTER triggers are recursion-safe both ways: `recursive_triggers`
      // is off by default, and their WHEN clause is false for the canonical
      // value they write, so they cannot re-fire even if it is turned on.
      // A rewrite that collides with an existing row for the same instant
      // fails the primary key loudly - correct: that is a duplicate rate.
      db.exec(`
        CREATE TRIGGER model_pricing_effective_from_guard_insert
        BEFORE INSERT ON model_pricing
        WHEN NOT (
             NEW.effective_from GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
          OR NEW.effective_from GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]Z'
          OR NEW.effective_from GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'
          OR NEW.effective_from GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9][+-][0-9][0-9]:[0-9][0-9]'
          OR NEW.effective_from GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9][+-][0-9][0-9]:[0-9][0-9]'
        )
          OR strftime('%Y-%m-%dT%H:%M:%fZ', NEW.effective_from) IS NULL
          OR substr(NEW.effective_from, 1, 10)
             IS NOT strftime('%Y-%m-%d', substr(NEW.effective_from, 1, 10))
          OR substr(NEW.effective_from, 12, 2) > '23'
        BEGIN
          SELECT RAISE(ABORT, 'model_pricing.effective_from must be a bare UTC date or a zoned ISO-8601 instant');
        END;

        CREATE TRIGGER model_pricing_effective_from_guard_update
        BEFORE UPDATE OF effective_from ON model_pricing
        WHEN NOT (
             NEW.effective_from GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
          OR NEW.effective_from GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]Z'
          OR NEW.effective_from GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'
          OR NEW.effective_from GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9][+-][0-9][0-9]:[0-9][0-9]'
          OR NEW.effective_from GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9][+-][0-9][0-9]:[0-9][0-9]'
        )
          OR strftime('%Y-%m-%dT%H:%M:%fZ', NEW.effective_from) IS NULL
          OR substr(NEW.effective_from, 1, 10)
             IS NOT strftime('%Y-%m-%d', substr(NEW.effective_from, 1, 10))
          OR substr(NEW.effective_from, 12, 2) > '23'
        BEGIN
          SELECT RAISE(ABORT, 'model_pricing.effective_from must be a bare UTC date or a zoned ISO-8601 instant');
        END;

        CREATE TRIGGER model_pricing_effective_from_canonical_insert
        AFTER INSERT ON model_pricing
        WHEN NEW.effective_from <> strftime('%Y-%m-%dT%H:%M:%fZ', NEW.effective_from)
        BEGIN
          UPDATE model_pricing
             SET effective_from = strftime('%Y-%m-%dT%H:%M:%fZ', NEW.effective_from)
           WHERE model = NEW.model
             AND bucket = NEW.bucket
             AND effective_from = NEW.effective_from;
        END;

        CREATE TRIGGER model_pricing_effective_from_canonical_update
        AFTER UPDATE OF effective_from ON model_pricing
        WHEN NEW.effective_from <> strftime('%Y-%m-%dT%H:%M:%fZ', NEW.effective_from)
        BEGIN
          UPDATE model_pricing
             SET effective_from = strftime('%Y-%m-%dT%H:%M:%fZ', NEW.effective_from)
           WHERE model = NEW.model
             AND bucket = NEW.bucket
             AND effective_from = NEW.effective_from;
        END;
      `);
    },
  },
  {
    id: 15,
    name: 'token-usage-canonical-occurred-at',
    up(db) {
      // Review M-21 (surviving half). Migration 14 canonicalized ONE operand of
      // the dated-rate comparison. The comparison has two:
      //
      //   mp.effective_from <= tu.occurred_at        -- BINARY-collated TEXT
      //
      // Canonicalizing only the left-hand side fixes only the spellings the
      // OPERATOR types. `token_usage.occurred_at` was still written verbatim
      // from the JSONL, so a timestamp carrying a UTC offset sorted in a place
      // unrelated to its position on the clock: '2026-02-28T20:00:00-05:00' is
      // one hour AFTER '2026-03-01T00:00:00.000Z', but as text it sorts BELOW
      // it, so the CTE's `ORDER BY effective_from DESC LIMIT 1` found no
      // effective rate at all and reported the tokens as UNPRICED - while
      // core's epoch-millisecond resolver priced the very same row at the very
      // same rate the halt gate approved. test/rate-resolver-parity.test.ts
      // pinned that as `offset-form-occurred-at`; this migration is what
      // graduates it.
      //
      // Step 1 - rewrite what is already stored. In JS, not SQL, for the reason
      // migration 14 gives: an unparseable value HALTS naming the offending row
      // instead of being coerced by SQLite's much laxer date parser. A usage
      // timestamp is never guessed, and - unlike a pricing date - it is never
      // dropped to NULL either, because `occurred_at IS NULL` makes a row
      // permanently unpriceable AND invisible to retention's expiry window.
      //
      // Migration 14 also halts on a COLLISION (two spellings of one instant
      // carrying two different rates), because `effective_from` is part of
      // model_pricing's primary key. There is no counterpart here and none is
      // written: `occurred_at` participates in NO uniqueness constraint -
      // token_usage's only one is UNIQUE(message_id, bucket), which this
      // rewrite does not touch - so canonicalizing two rows onto the same
      // instant is simply two rows at the same instant, which the table has
      // always allowed. A collision branch would be unreachable code asserting
      // a constraint that does not exist.
      interface StoredOccurrence {
        readonly id: number;
        readonly occurred_at: string;
      }
      // Duplicated from db/token-usage.ts on purpose: the checksum covers only
      // this function's own source, so a migration that leaned on a shared
      // helper would silently change meaning when the helper changed (the
      // convention migration 11 documents and migration 14 follows).
      const acceptedInput =
        /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])(T([01]\d|2[0-3]):[0-5]\d:[0-5]\d(\.\d{3})?(Z|[+-]([01]\d|2[0-3]):[0-5]\d))?$/;
      const stored = db
        .prepare('SELECT id, occurred_at FROM token_usage WHERE occurred_at IS NOT NULL')
        .all() as StoredOccurrence[];
      const rewrite = db.prepare('UPDATE token_usage SET occurred_at = ? WHERE id = ?');
      for (const row of stored) {
        // The second test catches a day the pattern allows but the calendar
        // does not ('2026-02-30'), which both parsers would otherwise roll
        // silently into the next month - filing the spend under a day nothing
        // happened on and expiring it from retention on the wrong date.
        const datePart = row.occurred_at.slice(0, 10);
        const dateRoundTrip = new Date(`${datePart}T00:00:00.000Z`);
        const isRealDate =
          !Number.isNaN(dateRoundTrip.getTime()) &&
          dateRoundTrip.toISOString().slice(0, 10) === datePart;
        const epochMs =
          acceptedInput.test(row.occurred_at) && isRealDate
            ? Date.parse(row.occurred_at)
            : Number.NaN;
        if (Number.isNaN(epochMs)) {
          throw new Error(
            `Migration 15: token_usage row (id=${String(row.id)}) carries occurred_at ` +
              `${JSON.stringify(row.occurred_at)}, which is not an unambiguous instant. A usage ` +
              'timestamp is never guessed and never dropped - fix the row by hand (bare UTC ' +
              'date, or a zoned ISO-8601 timestamp) and re-run.',
          );
        }
        const canonical = new Date(epochMs).toISOString();
        if (canonical !== row.occurred_at) {
          rewrite.run(canonical, row.id);
        }
      }
      // Step 2 - make a non-canonical value unstorable from here on.
      //
      // WHY TRIGGERS ARE WARRANTED HERE, and not only the JS canonicalizer that
      // db/token-usage.ts now applies before binding:
      //
      //  - The JS path guards ONE writer. `token_usage` is also written by raw
      //    SQL from fixtures and benchmarks, and the operator has the same
      //    sqlite3-CLI access to it that motivated migration 14's triggers.
      //    Migration 14 established the invariant that the DATA cannot spell an
      //    instant two ways; an invariant enforced only in one module is not an
      //    invariant, it is a convention.
      //  - The parity test that pins this defect seeds `token_usage` through
      //    raw SQL precisely so that it tests STORAGE, not one writer. A
      //    JS-only fix would leave it failing and would deserve to.
      //  - The alternative - a reject-only guard with no rewrite - was
      //    considered and rejected: it would abort every existing raw-SQL
      //    writer that spells a timestamp at second precision ('...T10:00:05Z'),
      //    which is a legal, unambiguous instant. Rejecting an unambiguous
      //    value teaches nothing; normalizing it removes the failure mode.
      //
      // The shape is migration 14's, for migration 14's reason: a CHECK
      // constraint cannot express this, because a BEFORE trigger cannot modify
      // NEW and a CHECK is evaluated before any AFTER trigger could normalize -
      // so a CHECK could only REJECT. Hence a BEFORE guard that rejects what no
      // canonicalizer could resolve, plus an AFTER trigger that rewrites
      // everything that survives it. The one difference from migration 14 is
      // NULL: `occurred_at` is nullable by design (a JSONL line without a
      // timestamp is stored honestly rather than given an invented one), so
      // both pairs are explicitly NULL-tolerant.
      //
      // The AFTER triggers are recursion-safe both ways: `recursive_triggers`
      // is off by default, and their WHEN clause is false for the canonical
      // value they themselves write, so they cannot re-fire even if it is
      // turned on. The rewrite targets `id = NEW.id` - token_usage's INTEGER
      // PRIMARY KEY - so it can never touch a second row.
      const shapeGuard = (column: string): string => `
             ${column} GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
          OR ${column} GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]Z'
          OR ${column} GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'
          OR ${column} GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9][+-][0-9][0-9]:[0-9][0-9]'
          OR ${column} GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9][+-][0-9][0-9]:[0-9][0-9]'`;
      // `strftime(...) IS NULL` rejects digits that are not a date at all
      // ('2026-13-45'); re-deriving the date part from itself rejects a day the
      // calendar does not have; the hour bound rejects 'T24:00:00', the one
      // accepted-looking spelling on which the two canonicalizers disagree
      // (ECMAScript rolls it into the next midnight, SQLite prints '24' back).
      const rejects = (column: string): string => `
        NEW.occurred_at IS NOT NULL AND (
          NOT (${shapeGuard(column)}
          )
          OR strftime('%Y-%m-%dT%H:%M:%fZ', ${column}) IS NULL
          OR substr(${column}, 1, 10) IS NOT strftime('%Y-%m-%d', substr(${column}, 1, 10))
          OR substr(${column}, 12, 2) > '23'
        )`;
      const abort =
        "SELECT RAISE(ABORT, 'token_usage.occurred_at must be NULL, a bare UTC date, or a zoned ISO-8601 instant');";
      const canonicalize = `
        UPDATE token_usage
           SET occurred_at = strftime('%Y-%m-%dT%H:%M:%fZ', NEW.occurred_at)
         WHERE id = NEW.id;`;
      const notCanonical = `
        NEW.occurred_at IS NOT NULL
        AND NEW.occurred_at <> strftime('%Y-%m-%dT%H:%M:%fZ', NEW.occurred_at)`;
      db.exec(`
        CREATE TRIGGER token_usage_occurred_at_guard_insert
        BEFORE INSERT ON token_usage
        WHEN ${rejects('NEW.occurred_at')}
        BEGIN
          ${abort}
        END;

        CREATE TRIGGER token_usage_occurred_at_guard_update
        BEFORE UPDATE OF occurred_at ON token_usage
        WHEN ${rejects('NEW.occurred_at')}
        BEGIN
          ${abort}
        END;

        CREATE TRIGGER token_usage_occurred_at_canonical_insert
        AFTER INSERT ON token_usage
        WHEN ${notCanonical}
        BEGIN
          ${canonicalize}
        END;

        CREATE TRIGGER token_usage_occurred_at_canonical_update
        AFTER UPDATE OF occurred_at ON token_usage
        WHEN ${notCanonical}
        BEGIN
          ${canonicalize}
        END;
      `);
    },
  },
  {
    id: 16,
    name: 'token-usage-rollup',
    up(db) {
      // Review M-19 (write side). `getCostSummary` prices and groups ALL of
      // `token_usage` on every cold read, and `token_usage` is the one table
      // whose retention is deliberately refused - cost history IS the product -
      // so it grows with corpus age forever. The one-entry memo in
      // api/queries.ts widened the hit window; it did not bound the read, and
      // its own comment says so.
      //
      // This migration installs the persisted rollup that does bound it,
      // maintained incrementally by the write path. It is a SHADOW table: no
      // reader is switched onto it here. The cutover is a separate change, and
      // it must not happen until an equivalence suite exists and is green -
      // one that compares this table against a direct grouped scan of
      // `token_usage` after every mutation shape - because the whole value of
      // this table is that it equals that scan. No such suite exists yet:
      // `token_usage_rollup` is named nowhere outside this file, so today the
      // triggers below are asserted by nothing.
      //
      // THE GRAIN, and why the review's own wording is wrong.
      //
      // The review asks for (session, model, day). That grain is unsound, in
      // two independent ways:
      //
      //  1. The rate is keyed by (model, BUCKET). Input and output tokens of
      //     one model carry different prices, so a (session, model, day) row
      //     cannot be repriced from tokens at all.
      //  2. Even with the bucket carried, a `model_pricing.effective_from` that
      //     falls MID-DAY splits one (session, model, bucket, day) group across
      //     two rates. 1000 tokens at $1/Mtok plus 1000 tokens at $9/Mtok is
      //     not 2000 tokens at either rate, and no arithmetic on the stored
      //     total recovers the split. The rollup would be quietly wrong exactly
      //     on the days a price changed - the days an operator looks at.
      //
      // So the key pins the RESOLVED PRICING ROW, not merely the day:
      //
      //     (session_id, model, bucket, day, rate_effective_from)
      //
      // and what is stored is TOKENS, never dollars. A dollar figure would
      // outlive the rate that produced it: correcting a mistyped `usd_per_mtok`
      // in place would leave every rolled-up dollar stale with nothing able to
      // detect it. With tokens plus the resolved `effective_from`, the same
      // dated rate that prices a raw row prices a rollup row, and an in-place
      // rate correction needs no recompute at all - it changes the multiplier,
      // not the grouping.
      //
      // `row_count` is carried alongside `tokens` because a group of purely
      // ZERO-token rows is a real group: this writer fans every message out to
      // all five buckets, zero-token ones included, and a direct scan therefore
      // produces a row for them. A rollup row is deleted when its `row_count`
      // falls to 0 - NEVER when its `tokens` falls to 0, which would silently
      // drop those groups and make the equivalence proof fail.
      //
      // Both key columns that can be absent are given a total, non-NULL
      // encoding rather than NULL: `day` is 'unknown' when `occurred_at IS
      // NULL' (the same sentinel getCostSummary already uses), and
      // `rate_effective_from` is '' when no rate resolves. This is not
      // cosmetic - SQLite treats NULLs as DISTINCT in a uniqueness constraint,
      // so a NULL key column would make ON CONFLICT never match and the table
      // would accumulate one un-mergeable row per event. '' cannot collide with
      // a real value: migration 14's guard trigger makes '' unstorable in
      // `model_pricing.effective_from`.
      //
      // WITHOUT ROWID: the table IS its primary key, so there is no rowid to
      // record insertion order. That keeps the file byte-identical under the
      // double-replay proof regardless of the order in which groups first
      // appeared.
      db.exec(`
        CREATE TABLE token_usage_rollup (
          session_id          TEXT    NOT NULL,
          model               TEXT    NOT NULL,
          bucket              TEXT    NOT NULL,
          day                 TEXT    NOT NULL,
          rate_effective_from TEXT    NOT NULL,
          tokens              INTEGER NOT NULL,
          row_count           INTEGER NOT NULL,
          PRIMARY KEY (session_id, model, bucket, day, rate_effective_from)
        ) WITHOUT ROWID;

        CREATE INDEX idx_token_usage_rollup_model_bucket
          ON token_usage_rollup(model, bucket);
      `);

      // Every key expression below wraps BOTH timestamps in
      // strftime('%Y-%m-%dT%H:%M:%fZ', ...). Migrations 14 and 15 already
      // guarantee the stored text is canonical, so this looks redundant - it is
      // not, and it is what makes these triggers safe.
      //
      // SQLite does not define the firing order of several triggers on one
      // event, and migration 15's canonicalizing AFTER INSERT trigger sits on
      // the same event as the rollup's. If the rollup fired FIRST it would see
      // `NEW.occurred_at` still in its raw spelling. Deriving the key through
      // the canonicalizing function makes the key identical under either order,
      // so nothing here depends on an order SQLite never promised. (It also
      // survives the nested fire: migration 15's rewrite triggers the rollup's
      // AFTER UPDATE, whose OLD and NEW canonicalize to the SAME key, so the
      // subtract and the add cancel exactly.)
      const canon = (expr: string): string => `strftime('%Y-%m-%dT%H:%M:%fZ', ${expr})`;
      // The COALESCE fallback covers the one value canonicalization cannot
      // produce: a non-NULL timestamp that is not a date at all. Migration 15's
      // guard makes that unstorable through SQL, so it is unreachable in a live
      // database - but a rollup key expression that could evaluate to NULL
      // would violate this table's NOT NULL columns and turn unreachable
      // corruption into an abort, and falling back to the raw text is what
      // makes the rollup agree with a direct scan even there.
      const at = (ref: string): string =>
        `COALESCE(${canon(`${ref}.occurred_at`)}, ${ref}.occurred_at)`;
      const dayOf = (ref: string): string =>
        `CASE WHEN ${ref}.occurred_at IS NULL THEN 'unknown'
              ELSE substr(${at(ref)}, 1, 10) END`;
      // The same dated-rate resolution the priced CTE performs, reduced to the
      // winning row's `effective_from`. '' means "no rate was in force" - the
      // rollup's encoding of the CTE's NULL rate, i.e. unpriced tokens.
      const rateOf = (ref: string): string =>
        `COALESCE((
           SELECT ${canon('mp.effective_from')}
             FROM model_pricing mp
            WHERE mp.model = ${ref}.model
              AND mp.bucket = ${ref}.bucket
              AND ${ref}.occurred_at IS NOT NULL
              AND ${canon('mp.effective_from')} <= ${at(ref)}
            ORDER BY ${canon('mp.effective_from')} DESC
            LIMIT 1
         ), '')`;
      const KEY = 'session_id, model, bucket, day, rate_effective_from';
      // One signed upsert serves both directions. The subtract arm MUST be an
      // upsert too, not a bare `UPDATE ... SET tokens = tokens - OLD.tokens`:
      // the target row is not guaranteed to exist when the subtract runs (see
      // the nested-fire note above), and a plain UPDATE would silently no-op
      // and leave the add uncancelled - a double count that nothing would
      // report.
      const delta = (ref: string, sign: string): string => `
          INSERT INTO token_usage_rollup (${KEY}, tokens, row_count)
          VALUES (
            ${ref}.session_id, ${ref}.model, ${ref}.bucket,
            ${dayOf(ref)}, ${rateOf(ref)}, ${sign}${ref}.tokens, ${sign}1
          )
          ON CONFLICT (${KEY}) DO UPDATE SET
            tokens    = token_usage_rollup.tokens + excluded.tokens,
            row_count = token_usage_rollup.row_count + excluded.row_count;`;
      // Runs LAST in every body that subtracts, so a group that momentarily
      // reaches 0 between a subtract and its matching add is not dropped. Keyed
      // exactly, so it is a primary-key lookup and can never reach another
      // group.
      const prune = (ref: string): string => `
          DELETE FROM token_usage_rollup
           WHERE session_id = ${ref}.session_id
             AND model = ${ref}.model
             AND bucket = ${ref}.bucket
             AND day = ${dayOf(ref)}
             AND rate_effective_from = ${rateOf(ref)}
             AND row_count = 0;`;

      // Step 1 - seed the table from what is already stored. This is the same
      // expression set the triggers use, phrased as one grouped scan; that the
      // two agree is the property the cutover's equivalence suite will have to
      // assert after every mutation. It is not asserted anywhere today - see
      // the shadow-table note at the top of this migration.
      db.exec(`
        INSERT INTO token_usage_rollup (${KEY}, tokens, row_count)
        SELECT tu.session_id, tu.model, tu.bucket, ${dayOf('tu')}, ${rateOf('tu')},
               SUM(tu.tokens), COUNT(*)
          FROM token_usage tu
         GROUP BY 1, 2, 3, 4, 5;
      `);

      // Step 2 - keep it exact on every ledger mutation.
      //
      // DELETE matters as much as INSERT: retention/prune.ts deletes expired
      // `token_usage` rows, and an unmaintained rollup would keep reporting
      // spend that no longer exists. The AFTER DELETE trigger applies the exact
      // inverse of the delta the INSERT applied, so retention needs no change
      // and cannot forget. SQLite disables its truncate optimization on a table
      // that has DELETE triggers, so even an unqualified `DELETE FROM
      // token_usage` fires per row rather than skipping them.
      db.exec(`
        CREATE TRIGGER token_usage_rollup_usage_insert
        AFTER INSERT ON token_usage
        BEGIN
          ${delta('NEW', '')}
        END;

        CREATE TRIGGER token_usage_rollup_usage_update
        AFTER UPDATE ON token_usage
        BEGIN
          ${delta('OLD', '-')}
          ${delta('NEW', '')}
          ${prune('OLD')}
        END;

        CREATE TRIGGER token_usage_rollup_usage_delete
        AFTER DELETE ON token_usage
        BEGIN
          ${delta('OLD', '-')}
          ${prune('OLD')}
        END;
      `);

      // Step 3 - a pricing change RETROACTIVELY changes the correct answer.
      //
      // Inserting a rate whose `effective_from` falls in the middle of a day
      // that is already rolled up splits an existing group in two; deleting a
      // rate merges two back into one. The rollup key names the resolved
      // pricing row, so the affected rows are exactly the (model, bucket) slice
      // the changed pricing row belongs to.
      //
      // OF THE TWO OPTIONS - detect the change and recompute, or key the rollup
      // so a stale row is DETECTABLE at read time - this takes the first.
      // Detection-only was rejected because it moves the cost of correctness
      // onto every reader forever (each read must revalidate) and leaves a
      // window in which the table is knowingly wrong; the whole point of the
      // table is that a reader may trust it without checking.
      //
      // The recompute is a FULL REBUILD of the slice, not a delta, and that is
      // deliberate: a full rebuild is IDEMPOTENT, so it is immune to the same
      // unspecified trigger-order problem as above. Migration 14's
      // canonicalizing trigger lives on this very table, and these triggers may
      // fire before or after it - but a rebuild that reads current pricing
      // produces the same result whenever it runs, and migration 14's rewrite
      // fires this pair again on its way out.
      //
      // The UPDATE trigger is scoped `OF model, bucket, effective_from`: those
      // are the only columns that can move a rollup key. A `usd_per_mtok`
      // correction changes the multiplier applied at read time, not the
      // grouping, so `upsertPricingRate`'s in-place rate update costs nothing.
      //
      // Cost note: the rebuild scans `token_usage` filtered by (model, bucket),
      // which has no covering index. Adding one was considered and declined -
      // it would tax every ingest write to speed up an operation that happens
      // when a human changes a price. That trade is the right way round.
      const recompute = (ref: string): string => `
          DELETE FROM token_usage_rollup
           WHERE model = ${ref}.model AND bucket = ${ref}.bucket;
          INSERT INTO token_usage_rollup (${KEY}, tokens, row_count)
          SELECT tu.session_id, tu.model, tu.bucket, ${dayOf('tu')}, ${rateOf('tu')},
                 SUM(tu.tokens), COUNT(*)
            FROM token_usage tu
           WHERE tu.model = ${ref}.model AND tu.bucket = ${ref}.bucket
           GROUP BY 1, 2, 3, 4, 5;`;
      db.exec(`
        CREATE TRIGGER token_usage_rollup_pricing_insert
        AFTER INSERT ON model_pricing
        BEGIN
          ${recompute('NEW')}
        END;

        CREATE TRIGGER token_usage_rollup_pricing_update
        AFTER UPDATE OF model, bucket, effective_from ON model_pricing
        BEGIN
          ${recompute('OLD')}
          ${recompute('NEW')}
        END;

        CREATE TRIGGER token_usage_rollup_pricing_delete
        AFTER DELETE ON model_pricing
        BEGIN
          ${recompute('OLD')}
        END;
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
