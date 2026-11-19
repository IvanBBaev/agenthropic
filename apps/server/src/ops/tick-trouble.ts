/**
 * The corpus-tick trouble state machine: when a failing tick is logged, and when recovery is.
 *
 * Moved out of the composition root `index.ts` (ARC-4, 2026-11-19), which
 * re-exports it; `index.ts` keeps only the wiring in `start()`.
 */
import type { TickOutcome } from '../ingest/corpus-watcher';

/** The three {@link TickOutcome} kinds that mean the corpus loop is in trouble. */
export type TickTroubleKind = 'read-error' | 'no-corpus-root' | 'db-unavailable';

/**
 * Fold one scheduled tick outcome into the watcher's trouble state, emitting a
 * log line ONLY on a state transition. Every post-boot tick used to discard its
 * outcome entirely, so a corpus that became unreadable mid-flight froze the
 * dashboard with zero operator-visible evidence; but a poll loop also must not
 * repeat the same line every interval, so the rule is: entering trouble logs
 * once (with the carried reason), recovering logs once, and a steady state -
 * healthy or troubled - is silent. 'stopped' / 'overlapped' /
 * 'containment-halt' neither log (the halt already has its FATAL line) nor
 * move the state: none of them says anything about whether the corpus reads.
 */
export function tickTroubleTransition(
  previous: TickTroubleKind | null,
  outcome: TickOutcome,
): {
  readonly next: TickTroubleKind | null;
  readonly line: { readonly level: 'log' | 'error'; readonly text: string } | null;
} {
  switch (outcome.kind) {
    case 'stopped':
    case 'overlapped':
    case 'containment-halt':
      return { next: previous, line: null };
    case 'read-error':
      return {
        next: 'read-error',
        line:
          previous === 'read-error'
            ? null
            : {
                level: 'error',
                text:
                  `corpus watcher: the corpus could not be read (${outcome.reason}) - ` +
                  'the dashboard is stale until this clears.',
              },
      };
    case 'db-unavailable':
      // OPS-13: logged once on entry like the others, with the SQLite code -
      // a full disk and a locked file want different fixes.
      return {
        next: 'db-unavailable',
        line:
          previous === 'db-unavailable'
            ? null
            : {
                level: 'error',
                text:
                  `corpus watcher: the database could not be written (${outcome.code}: ` +
                  `${outcome.reason}) - ingest is paused and no session is charged a retry ` +
                  'until this clears.',
              },
      };
    case 'no-corpus-root':
      return {
        next: 'no-corpus-root',
        line:
          previous === 'no-corpus-root'
            ? null
            : {
                level: 'log',
                text: 'corpus watcher: no corpus root resolved - nothing to ingest until one appears.',
              },
      };
    case 'ingested':
    case 'unchanged':
      return {
        next: null,
        line:
          previous === null
            ? null
            : {
                level: 'log',
                text:
                  previous === 'db-unavailable'
                    ? 'corpus watcher: the database takes writes again - resuming normal ingest.'
                    : 'corpus watcher: the corpus is readable again - resuming normal ingest.',
              },
      };
  }
}
