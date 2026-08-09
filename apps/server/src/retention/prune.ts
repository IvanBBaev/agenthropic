/**
 * WP-D10 - the retention prune: bounded, transactional, dry-runnable deletion
 * of EXPIRED PROJECTION rows, with a durable receipt for every dollar removed.
 *
 * POLICY STATUS. The mechanism is implemented; the POLICY is not set and is
 * not an agent's to set. Retention numbers await Ivan's ratification of OPEN-1
 * (retention TTL vs `events_raw` immutability) and the surrounding OPEN-2 /
 * OPEN-3 reads - `docs/analysis/open-decisions.md`. WP-D10 is NOT done: with
 * the default {@link NO_RETENTION} policy this module deletes nothing and the
 * database is byte-identical to a build without it.
 *
 * SAFETY PROPERTIES, in the order they matter:
 *
 *  1. NOTHING BY DEFAULT. No configured rule means no statement is prepared,
 *     no transaction is opened and no file is written.
 *  2. THE SUBSTRATE AND THE DAG ARE OFF LIMITS. Only `events` (hook liveness)
 *     and `token_usage` (priced usage) are reachable. `events_raw` is
 *     append-only - enforced by triggers and proven in
 *     `test/events-raw.test.ts` - and this module issues no DML against it
 *     at all, so the proof is untouched rather than worked around. Deleting
 *     `agents` would additionally fire `parent_agent_id ON DELETE SET NULL`
 *     and silently re-parent a subtree; the DAG is therefore protected too.
 *  3. NO SILENT DOLLARS. `token_usage` is ground truth for every reported
 *     dollar. Its window is PRICED BEFORE IT IS DELETED, with the same dated
 *     rate resolution the read API uses, and the resulting amount is written
 *     to the append-only journal inside the same transaction. If the journal
 *     cannot be written, the transaction rolls back and nothing is deleted -
 *     priced rows only ever leave the database with a receipt.
 *  4. ALL-OR-NOTHING. One run is one transaction. A failure at any point -
 *     including the journal write - leaves the database exactly as it was.
 *  5. BOUNDED. Each table deletes at most `policy.maxRowsPerRun` rows per run,
 *     so the write lock is held for a bounded time even on a multi-gigabyte
 *     database. A run that fills its budget reports `budgetExhausted`; running
 *     again continues from where it stopped.
 *  6. DRY RUN. `{ dryRun: true }` performs every measurement, including the
 *     dollar impact, and deletes nothing.
 *
 * KNOWN, DELIBERATE RESIDUE (not a bug - a fact the operator must know).
 * `token_usage` is re-derived from the JSONL corpus on every ingest pass, and
 * the first watcher tick after a restart replays the whole corpus. Pruning
 * usage rows whose transcript is still on disk therefore frees space only
 * until the next replay puts them back. That direction is the safe one - the
 * totals heal rather than staying quietly low - but it means row-level TTL on
 * `token_usage` reclaims space durably only for sessions whose transcripts are
 * gone. This is one of the things OPEN-1 has to settle.
 */
import type { SqliteDatabase } from '../db/connection';
import {
  deleteExpiredWindow,
  findExpiredWindow,
  measureWindowCost,
  ZERO_COST_IMPACT,
  type CostImpact,
  type ExpiredWindow,
  type PrunableTable,
} from '../db/retention-queries';
import { appendJournalEntry, defaultJournalPath } from './journal';
import {
  assertRetentionPolicy,
  RETENTION_PROTECTED_TABLES,
  type AgeRule,
  type RetentionPolicy,
} from './policy';

const MS_PER_DAY = 86_400_000;

/** What one run did (or, in a dry run, would do) to one table. */
export interface PruneTableOutcome {
  readonly table: PrunableTable;
  /** Rows strictly older than this ISO timestamp were eligible. */
  readonly cutoff: string;
  /** Eligible rows inside this run's budget. */
  readonly rowsMatched: number;
  /** Rows actually removed. Always 0 in a dry run. */
  readonly rowsDeleted: number;
  /** The budget was filled - more expired rows may remain for the next run. */
  readonly budgetExhausted: boolean;
}

export interface PruneOptions {
  /** Clock injection point; defaults to now. */
  readonly now?: Date;
  /** Measure and report without deleting anything. */
  readonly dryRun?: boolean;
  /** Journal file; defaults to `<database path>.retention-journal.jsonl`. */
  readonly journalPath?: string;
}

export interface PruneReport {
  readonly ranAt: string;
  readonly dryRun: boolean;
  /** True only when rows were really removed. */
  readonly applied: boolean;
  readonly tables: readonly PruneTableOutcome[];
  /** Dollars/tokens the `token_usage` window takes off the books. */
  readonly costImpact: CostImpact;
  /** Where the receipt went (or would go); null when no rule is configured. */
  readonly journalPath: string | null;
  /** Tables this mechanism can never delete from. */
  readonly protectedTables: readonly string[];
}

interface TableAssessment {
  readonly table: PrunableTable;
  readonly cutoff: string;
  readonly window: ExpiredWindow;
}

interface Assessment {
  readonly tables: readonly TableAssessment[];
  readonly costImpact: CostImpact;
}

/** ISO cutoff: rows older than `maxAgeDays` before `now` are eligible. */
export function cutoffFor(now: Date, rule: AgeRule): string {
  return new Date(now.getTime() - rule.maxAgeDays * MS_PER_DAY).toISOString();
}

/**
 * Run one bounded retention pass over the projection tables.
 *
 * Returns a report describing exactly what happened (or, with `dryRun`, what
 * would happen). Throws {@link RetentionPolicyError} for an invalid policy and
 * propagates any I/O error from the journal - in which case nothing was
 * deleted.
 */
export function prune(
  db: SqliteDatabase,
  policy: RetentionPolicy,
  options: PruneOptions = {},
): PruneReport {
  assertRetentionPolicy(policy);
  const now = options.now ?? new Date();
  const ranAt = now.toISOString();
  const dryRun = options.dryRun ?? false;

  if (policy.events === null && policy.tokenUsage === null) {
    // No row rule configured: the no-op default. Nothing is read, nothing is
    // written, no journal path is even resolved.
    return {
      ranAt,
      dryRun,
      applied: false,
      tables: [],
      costImpact: ZERO_COST_IMPACT,
      journalPath: null,
      protectedTables: RETENTION_PROTECTED_TABLES,
    };
  }

  // Resolved BEFORE anything is deleted, so an unusable journal path fails the
  // run while the database is still untouched.
  const journalPath = options.journalPath ?? defaultJournalPath(db.name);

  if (dryRun) {
    const assessment = assess(db, policy, now);
    return {
      ranAt,
      dryRun: true,
      applied: false,
      tables: assessment.tables.map((entry) => toOutcome(entry, 0)),
      costImpact: assessment.costImpact,
      journalPath,
      protectedTables: RETENTION_PROTECTED_TABLES,
    };
  }

  // One transaction for the whole run: measurement, deletion and receipt.
  // Assessment happens INSIDE it so the window that is priced is exactly the
  // window that is deleted, and a journal failure rolls the deletion back.
  const execute = db.transaction((): { tables: PruneTableOutcome[]; costImpact: CostImpact } => {
    const assessment = assess(db, policy, now);
    const tables = assessment.tables.map((entry) =>
      toOutcome(
        entry,
        entry.window.maxId === null
          ? 0
          : deleteExpiredWindow(db, entry.table, entry.cutoff, entry.window.maxId),
      ),
    );
    if (tables.some((table) => table.rowsDeleted > 0)) {
      appendJournalEntry(journalPath, {
        ranAt,
        database: db.name,
        policy: {
          events: policy.events,
          tokenUsage: policy.tokenUsage,
          rawEvents: policy.rawEvents,
          maxRowsPerRun: policy.maxRowsPerRun,
        },
        tables,
        costImpact: assessment.costImpact,
        note:
          'These rows are gone from the database. costImpact.costUsd is the amount every ' +
          'reported dollar total covering this window is now LOWER by - add it back when ' +
          'reconciling historical spend. sessionsPartiallyPruned sessions still show data ' +
          'for a straddling window and now report a reduced total for it.',
      });
    }
    return { tables, costImpact: assessment.costImpact };
  });

  const result = execute();
  return {
    ranAt,
    dryRun: false,
    applied: result.tables.some((table) => table.rowsDeleted > 0),
    tables: result.tables,
    costImpact: result.costImpact,
    journalPath,
    protectedTables: RETENTION_PROTECTED_TABLES,
  };
}

/** Locate each configured table's bounded window and price the usage one. */
function assess(db: SqliteDatabase, policy: RetentionPolicy, now: Date): Assessment {
  const tables: TableAssessment[] = [];
  if (policy.events !== null) {
    tables.push(windowFor(db, 'events', cutoffFor(now, policy.events), policy.maxRowsPerRun));
  }
  let costImpact = ZERO_COST_IMPACT;
  if (policy.tokenUsage !== null) {
    const usage = windowFor(
      db,
      'token_usage',
      cutoffFor(now, policy.tokenUsage),
      policy.maxRowsPerRun,
    );
    tables.push(usage);
    if (usage.window.maxId !== null) {
      costImpact = measureWindowCost(db, usage.cutoff, usage.window.maxId);
    }
  }
  return { tables, costImpact };
}

function windowFor(
  db: SqliteDatabase,
  table: PrunableTable,
  cutoff: string,
  limit: number,
): TableAssessment {
  return { table, cutoff, window: findExpiredWindow(db, table, cutoff, limit) };
}

function toOutcome(entry: TableAssessment, rowsDeleted: number): PruneTableOutcome {
  return {
    table: entry.table,
    cutoff: entry.cutoff,
    rowsMatched: entry.window.rowsMatched,
    rowsDeleted,
    budgetExhausted: entry.window.budgetExhausted,
  };
}
