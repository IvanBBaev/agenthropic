/**
 * `budgetExhausted` is true only when expired rows really remain beyond the
 * window.
 *
 * It used to be `rowsMatched >= limit`. When exactly `limit` rows had expired,
 * the run deleted all of them, reported "more may remain", and the run line
 * printed "N+". The next run then found nothing. The window query now probes
 * for one more expired row past the budget.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { findExpiredWindow } from '../src/db/retention-queries';
import { NO_RETENTION, type RetentionPolicy } from '../src/retention/policy';
import { prune } from '../src/retention/prune';
import {
  countRows,
  createMigratedTempDb,
  insertAgent,
  insertProjectionEvent,
  insertSession,
  insertTokenUsage,
  type TempDb,
} from './helpers';

const NOW = new Date('2026-08-07T00:00:00.000Z');
const OLD = '2026-01-01T00:00:00.000Z';
const FRESH = '2026-08-06T00:00:00.000Z';
const CUTOFF = '2026-07-01T00:00:00.000Z';

describe('budgetExhausted means expired rows remain', () => {
  let temp: TempDb;

  beforeEach(() => {
    temp = createMigratedTempDb();
    insertSession(temp.db, 's1');
    insertAgent(temp.db, 'a1', 's1');
  });

  afterEach(() => {
    temp.cleanup();
  });

  function events(n: number, occurredAt: string, prefix = 'k'): void {
    for (let i = 0; i < n; i += 1) {
      insertProjectionEvent(temp.db, `${prefix}-${String(i)}`, occurredAt);
    }
  }

  it('is false when exactly the budget has expired', () => {
    events(2, OLD);

    expect(findExpiredWindow(temp.db, 'events', CUTOFF, 2)).toMatchObject({
      rowsMatched: 2,
      budgetExhausted: false,
    });
  });

  it('is true when one more expired row lies past the budget', () => {
    events(3, OLD);

    expect(findExpiredWindow(temp.db, 'events', CUTOFF, 2)).toMatchObject({
      rowsMatched: 2,
      budgetExhausted: true,
    });
  });

  it('ignores unexpired rows past the budget', () => {
    events(2, OLD);
    events(3, FRESH, 'f');

    expect(findExpiredWindow(temp.db, 'events', CUTOFF, 2).budgetExhausted).toBe(false);
  });

  it('keeps rowsMatched and maxId clamped to the budget', () => {
    events(5, OLD);
    const window = findExpiredWindow(temp.db, 'events', CUTOFF, 2);
    const ids = temp.db.prepare('SELECT id FROM events ORDER BY id').all() as Array<{
      id: number;
    }>;

    expect(window.rowsMatched).toBe(2);
    expect(window.maxId).toBe(ids[1]?.id);
  });

  it('is false for an empty window', () => {
    expect(findExpiredWindow(temp.db, 'events', CUTOFF, 2)).toEqual({
      rowsMatched: 0,
      maxId: null,
      budgetExhausted: false,
    });
  });

  it('applies the same rule to token_usage', () => {
    insertTokenUsage(temp.db, 'm-0', OLD);
    insertTokenUsage(temp.db, 'm-1', OLD);

    expect(findExpiredWindow(temp.db, 'token_usage', CUTOFF, 2).budgetExhausted).toBe(false);

    insertTokenUsage(temp.db, 'm-2', OLD);

    expect(findExpiredWindow(temp.db, 'token_usage', CUTOFF, 2).budgetExhausted).toBe(true);
  });

  it('reports a finished drain on the run that empties an exact multiple', () => {
    events(4, OLD);
    const policy: RetentionPolicy = {
      ...NO_RETENTION,
      events: { maxAgeDays: 30 },
      maxRowsPerRun: 2,
    };

    expect(prune(temp.db, policy, { now: NOW }).tables[0]?.budgetExhausted).toBe(true);
    expect(prune(temp.db, policy, { now: NOW }).tables[0]).toMatchObject({
      rowsDeleted: 2,
      budgetExhausted: false,
    });
    expect(countRows(temp.db, 'events')).toBe(0);
  });
});
