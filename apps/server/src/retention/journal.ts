/**
 * WP-D10 - the retention journal: a durable, append-only receipt for every
 * prune that actually removed rows.
 *
 * WHY IT EXISTS. The project's central honesty rule is that no surface may
 * quietly under-report spend. Deleting `token_usage` rows lowers every dollar
 * total for the pruned window - permanently, and invisibly, because the rows
 * that used to justify the number are gone. The journal is what makes the
 * difference EXPLAINABLE rather than silent: it records, per prune, the exact
 * dollars, tokens and sessions removed, so a reconciliation can always answer
 * "why is the total lower than it was". A prune that cannot write its receipt
 * does not happen (see `prune.ts`).
 *
 * FORMAT. One JSON object per line (JSONL), appended and `fsync`ed. Never
 * rewritten, never truncated by this module - the same append-only discipline
 * the raw substrate has, at file level.
 *
 * FAILURE DIRECTION. `prune.ts` appends the entry INSIDE the delete
 * transaction, immediately before commit. A failed journal write therefore
 * rolls the deletion back and the database is exactly as it was. The one
 * residual window is a journal entry written and then a failed COMMIT, which
 * makes the journal claim slightly MORE was deleted than really was. That is
 * the safe direction: the journal may over-report a prune, never under-report
 * it, so reconciling from it can never hide spend.
 *
 * POLICY STATUS: mechanism only; the retention policy itself is unset and
 * awaits Ivan's OPEN-1/2/3 ratification (docs/analysis/open-decisions.md).
 */
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  writeSync,
} from 'node:fs';
import { dirname } from 'node:path';
import { RetentionPolicyError } from './policy';

/** Schema tag carried by every entry, so a reader can never misread an old file. */
export const RETENTION_JOURNAL_SCHEMA = 'agenthropic.retention-journal/1';

/** Suffix appended to the database path when no journal path is configured. */
export const RETENTION_JOURNAL_SUFFIX = '.retention-journal.jsonl';

/**
 * Default journal path: alongside the database file it describes.
 *
 * Throws for a database that has no file (`:memory:`, or an anonymous
 * temporary database): a prune with nowhere durable to write its receipt must
 * fail loudly, not scatter a journal into the working directory.
 */
export function defaultJournalPath(databasePath: string): string {
  if (databasePath === '' || databasePath === ':memory:') {
    throw new RetentionPolicyError(
      `Cannot derive a retention journal path from database "${databasePath}": ` +
        'pass an explicit journalPath. A prune without a durable receipt is refused.',
    );
  }
  return `${databasePath}${RETENTION_JOURNAL_SUFFIX}`;
}

/**
 * Append one entry and flush it to stable storage before returning. Throws on
 * any I/O failure - the caller treats that as "the prune did not happen".
 */
export function appendJournalEntry(path: string, entry: Record<string, unknown>): void {
  mkdirSync(dirname(path), { recursive: true });
  const line = `${JSON.stringify({ schema: RETENTION_JOURNAL_SCHEMA, ...entry })}\n`;
  const fd = openSync(path, 'a');
  try {
    writeSync(fd, line);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/**
 * Read every entry back. A missing file is an empty journal (nothing has ever
 * been pruned), not an error. Blank lines are skipped; a malformed line throws
 * rather than being dropped - a receipt file that cannot be read in full must
 * not be summarized as if it could.
 */
export function readJournalEntries(path: string): readonly Record<string, unknown>[] {
  if (!existsSync(path)) {
    return [];
  }
  const entries: Record<string, unknown>[] = [];
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (line.trim() === '') {
      continue;
    }
    entries.push(JSON.parse(line) as Record<string, unknown>);
  }
  return entries;
}
