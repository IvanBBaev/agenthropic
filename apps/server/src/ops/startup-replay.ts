/**
 * Startup corpus replay: the bounded, yielding first pass and its boot log lines.
 *
 * Moved out of the composition root `index.ts` (ARC-4, 2026-11-19), which
 * re-exports it; `index.ts` keeps only the wiring in `start()`.
 */
import type { CorpusIngestSummary } from '../corpus/ingest-corpus';
import type { CorpusWatcher, TickOutcome } from '../ingest/corpus-watcher';

function logReplaySummary(replay: CorpusIngestSummary): void {
  console.log(
    `corpus replay: ${String(replay.sessionsOk)}/${String(replay.sessionsDiscovered)} sessions ok, ` +
      `${String(replay.sessionsFailed)} failed, ${String(replay.sessionsSkipped)} skipped, ` +
      `${String(replay.agentsUpserted)} agents, ${String(replay.edgesInserted)} edges, ` +
      `${String(replay.usageRowsInserted)} usage rows, ` +
      `${String(replay.filesSkipped)} files skipped`,
  );
  if (replay.totalUnpricedTokens > 0) {
    console.warn(
      `corpus replay: ${String(replay.totalUnpricedTokens)} tokens have no price row in force; ` +
        'they are stored and shown as unpriced, never as $0 - seed model_pricing to price them',
    );
  }
  for (const failure of replay.failures) {
    console.error(
      `corpus replay failure: session ${failure.sessionId} (${failure.projectSlug}): ${failure.error}`,
    );
  }
}

/** Two pass summaries as one: counts add up, failures concatenate in order. */
export function mergeReplaySummaries(
  a: CorpusIngestSummary,
  b: CorpusIngestSummary,
): CorpusIngestSummary {
  return {
    sessionsDiscovered: a.sessionsDiscovered + b.sessionsDiscovered,
    sessionsOk: a.sessionsOk + b.sessionsOk,
    sessionsFailed: a.sessionsFailed + b.sessionsFailed,
    sessionsSkipped: a.sessionsSkipped + b.sessionsSkipped,
    agentsUpserted: a.agentsUpserted + b.agentsUpserted,
    edgesInserted: a.edgesInserted + b.edgesInserted,
    usageRowsInserted: a.usageRowsInserted + b.usageRowsInserted,
    filesSkipped: a.filesSkipped + b.filesSkipped,
    totalCostUsd: a.totalCostUsd + b.totalCostUsd,
    totalUnpricedTokens: a.totalUnpricedTokens + b.totalUnpricedTokens,
    failures: [...a.failures, ...b.failures],
  };
}

export interface StartupReplayOptions {
  /** The per-pass session cap handed to every replay tick. */
  readonly maxSessionsPerPass: number;
  /**
   * The per-pass byte budget handed to every replay tick (OPS-8): what keeps
   * one pass - and with it the wait of a hook delivery that lands during the
   * replay - well inside the hook's `curl --max-time 3`. Absent, passes are
   * bounded by the session cap alone.
   */
  readonly maxBytesPerPass?: number;
  /**
   * Resolves after one event-loop turn; awaited before EVERY pass, the first
   * included, so connections accepted during the bind - and every request that
   * arrives while the replay runs - are answered between passes. Defaults to
   * a `REPLAY_YIELD_MS` timer window; a test seam.
   */
  readonly yieldTurn?: () => Promise<void>;
}

/**
 * The pause before every replay pass (OPS-8). A single `setImmediate` turn is
 * not enough to serve a hook POST that queued up while the previous pass held
 * the loop: accepting the socket, reading the body and writing the reply span
 * two to three turns, so the delivery would wait several passes. A short timer
 * window lets the loop drain that pending I/O before the next pass starts; at
 * about 0.7 s per 32 MiB pass the window costs ~1.5 % of the replay.
 */
export const REPLAY_YIELD_MS = 10;

function nextTurn(): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, REPLAY_YIELD_MS);
  });
}

/**
 * WP-IN10 replay-on-startup, in chunks. The first sweep IS the replay: without
 * a persisted checkpoint every discovered session is admitted; with one, only
 * the sessions whose bytes moved while the process was down. A single
 * synchronous pass over a large corpus would hold the event loop for its whole
 * duration - /api/health could not even say 'replaying' - so the sweep runs as
 * capped passes with an event-loop turn before each, until the watcher reports
 * nothing pending. The watcher counts the passes of one sweep as ONE pass for
 * the retry budget (see corpus-watcher.ts), so the chunking changes when the
 * event loop breathes, never which sessions fail or are quarantined.
 *
 * The boot log gets ONE summary for the whole sweep. A pass that ingested
 * nothing is not silent either: `tick()` names which reason ended it, and
 * {@link replayOutcomeLine} says so - except an 'unchanged' or 'stopped'
 * ending AFTER passes that did ingest, which only means the remainder vanished
 * from disk or the server is shutting down, and would otherwise read as
 * "nothing was replayed" under a summary that says otherwise.
 *
 * Returns the last pass's outcome, which seeds the tick-trouble state.
 */
export async function runStartupReplay(
  watcher: Pick<CorpusWatcher, 'tick'>,
  options: StartupReplayOptions,
): Promise<TickOutcome> {
  const yieldTurn = options.yieldTurn ?? nextTurn;
  let total: CorpusIngestSummary | null = null;
  let outcome: TickOutcome;
  for (;;) {
    await yieldTurn();
    outcome = watcher.tick({
      maxSessions: options.maxSessionsPerPass,
      ...(options.maxBytesPerPass === undefined ? {} : { maxBytes: options.maxBytesPerPass }),
    });
    if (outcome.kind !== 'ingested') {
      break;
    }
    total = total === null ? outcome.summary : mergeReplaySummaries(total, outcome.summary);
    if (!outcome.pending) {
      break;
    }
  }
  if (total !== null) {
    logReplaySummary(total);
  }
  if (
    outcome.kind !== 'ingested' &&
    !(total !== null && (outcome.kind === 'unchanged' || outcome.kind === 'stopped'))
  ) {
    const line = replayOutcomeLine(outcome);
    (line.level === 'error' ? console.error : console.log)(line.text);
  }
  return outcome;
}

/**
 * The boot line for a replay pass that ingested nothing, one distinct sentence
 * per reason. This call site used to print NOTHING in that case, on the honest
 * grounds that `tick()` returned a bare `null` it could not interpret — so a
 * fully-checkpointed boot ("nothing changed, all good") looked exactly like a
 * missing corpus root and like an unreadable one, and a silent dashboard had no
 * matching line anywhere. {@link TickOutcome} removed the ambiguity, so the
 * silence is no longer warranted.
 *
 * TOTAL on purpose: every non-ingesting outcome gets a line. An earlier draft
 * returned `null` for the three that "cannot happen on a fresh watcher's first
 * tick", which handed the composition root a branch nothing could ever take —
 * dead code that a coverage number would have to be taught to ignore. Those
 * three are impossible only if the wiring is right; if one ever does surface,
 * an operator reading the boot log deserves to be told, and 'error' is the
 * honest level for a line that means the watcher is not doing its job.
 */
export function replayOutcomeLine(outcome: Exclude<TickOutcome, { kind: 'ingested' }>): {
  readonly level: 'log' | 'error';
  readonly text: string;
} {
  switch (outcome.kind) {
    case 'unchanged':
      return {
        level: 'log',
        text: 'corpus replay: no session changed since the last checkpoint - nothing re-read.',
      };
    case 'no-corpus-root':
      return {
        level: 'log',
        text: 'corpus replay: no corpus root resolved - nothing to replay.',
      };
    case 'read-error':
      return {
        level: 'error',
        text:
          `corpus replay: the corpus could not be read this pass (${outcome.reason}) - ` +
          'retrying on the next poll.',
      };
    case 'db-unavailable':
      return {
        level: 'error',
        text:
          `corpus replay: the database could not be written (${outcome.code}: ${outcome.reason}) - ` +
          'no session was charged a retry; retrying on the next poll.',
      };
    case 'containment-halt':
      // Points at the FATAL line rather than restating it: one containment
      // violation must never read as two separate incidents.
      return {
        level: 'error',
        text: 'corpus replay: halted by a containment violation - see the FATAL line above.',
      };
    case 'stopped':
      return {
        level: 'error',
        text: 'corpus replay: the watcher was already stopped - nothing was replayed.',
      };
    case 'overlapped':
      return {
        level: 'error',
        text: 'corpus replay: a pass was already in flight - nothing was replayed.',
      };
  }
}

/**
 * The line that ends the replay phase a read error left open (2026-10-08).
 * A boot replay that a read error cuts short stays 'replaying' into the
 * scheduled polls, and the first poll that does not continue the sweep ends
 * the phase - health then says 'ok' for the life of the process (owner
 * decision, 2026-10-01). That end used to be silent: the boot log said the
 * corpus could not be read, health later said 'ok', and nothing in between
 * said which poll ended the phase or on how much of the corpus. Returns
 * `null` for the one outcome that does NOT end the phase - a capped pass with
 * more to drain - and a line for every other outcome, so the composition root
 * never has to decide on its own which outcomes are an ending. Total on
 * purpose, like {@link replayOutcomeLine}: the three "cannot happen on a poll"
 * arms get an 'error' line rather than a branch nothing can take.
 */
export function replayPhaseEndLine(outcome: TickOutcome): {
  readonly level: 'log' | 'error';
  readonly text: string;
} | null {
  switch (outcome.kind) {
    case 'ingested':
      return outcome.pending
        ? null
        : {
            level: 'log',
            text:
              'corpus replay: the scheduled poll finished the sweep a read error cut short - ' +
              "health now says 'ok'.",
          };
    case 'unchanged':
      return {
        level: 'log',
        text:
          'corpus replay: the corpus reads again and no session changed since the last ' +
          "checkpoint - health now says 'ok'.",
      };
    case 'read-error':
      // The honest ending, not a recovery: the sessions the sweep did not reach
      // are still owed. The watcher keeps the sweep and its cap on a read
      // error, so they land through the scheduled poll in capped passes once
      // the corpus reads again - under a health answer that already says 'ok'.
      return {
        level: 'error',
        text:
          `corpus replay: the corpus still could not be read on the next poll (${outcome.reason}) - ` +
          "the phase ends here and health says 'ok' on what landed; the sessions the sweep " +
          'did not reach land through the scheduled poll in capped passes once the corpus ' +
          'reads again.',
      };
    case 'db-unavailable':
      // Same ending as a read error, for the same reason: the watcher kept the
      // sweep and its cap, and nothing is about to drain while the database
      // refuses writes. The token screen waits on this phase with no timeout.
      return {
        level: 'error',
        text:
          `corpus replay: the database still could not be written on the next poll ` +
          `(${outcome.code}: ${outcome.reason}) - the phase ends here and health says 'ok' ` +
          'on what landed; the sessions the sweep did not reach land through the scheduled ' +
          'poll once the database takes writes again.',
      };
    case 'no-corpus-root':
      return {
        level: 'log',
        text:
          "corpus replay: the corpus root is gone - the phase ends here and health says 'ok' " +
          'on what landed; a root that reappears is picked up by the scheduled poll.',
      };
    case 'containment-halt':
      return {
        level: 'error',
        text:
          'corpus replay: halted by a containment violation on the poll that was finishing ' +
          "the replay - see the FATAL line above; health says 'ok' on what landed.",
      };
    case 'stopped':
      return {
        level: 'error',
        text:
          'corpus replay: the watcher was stopped before the poll could finish the replay - ' +
          "health says 'ok' on what landed.",
      };
    case 'overlapped':
      return {
        level: 'error',
        text:
          'corpus replay: a pass was already in flight when the poll that was finishing the ' +
          "replay started - the phase ends here and health says 'ok' on what landed.",
      };
  }
}
