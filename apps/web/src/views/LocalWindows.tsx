/**
 * R21 (UX-8): the cost page's leading answer to "what did today and this week
 * cost, and what did delegation save?" - in the reader's own timezone.
 *
 * The UTC tiles further down are cut client-side from the summary's `perDay`
 * rows, and those rows are UTC days, so no arithmetic on them can produce a
 * local day: for a reader at UTC+2 the "today" boundary falls at 02:00. These
 * tiles therefore ask the server instead. `/api/changes` sums the usage rows
 * whose EVENT time falls in `(since, until]`, so passing local midnight as
 * `since` gives a true local-day total. The page asks for one session row
 * (`limit: 1`) because only the window totals are read - they cover the whole
 * window, not the page of sessions.
 *
 * What these tiles do not claim:
 *   - completeness past the read. The window ends at `until`, the newest event
 *     the database holds, and the basis note prints it;
 *   - a windowed delegation saving. The savings endpoint is corpus-wide only,
 *     so the Saved tile says "all time" rather than sitting beside two windowed
 *     figures as if it were one of them;
 *   - anything about rows with no timestamp. They fall in no window, so when
 *     the server counts any, the note says how many.
 *
 * A local midnight passing under an open tab moves `since`, which re-reads the
 * window. Until the new answer lands the tile shows loading, never the old
 * day's figure under the new day's label.
 */
import { useEffect, useState } from 'react';
import { fetchChanges } from '../api';
import type { AggregateDelegationSavingsDto, ChangesDto } from '../dto';
import {
  formatLocalClock,
  formatTokens,
  formatUsd,
  localDayLabel,
  localMidnightMs,
} from '../format';

/** Days in the local week window, today included. */
export const LOCAL_WEEK_DAYS = 7;

type WindowRead =
  | { readonly kind: 'loading' }
  | { readonly kind: 'error'; readonly message: string }
  | { readonly kind: 'ready'; readonly changes: ChangesDto };

/** The aggregate-savings read as CostView holds it. */
export type SavingsRead =
  | { readonly kind: 'loading' }
  | { readonly kind: 'error'; readonly message: string }
  | { readonly kind: 'ready'; readonly aggregate: AggregateDelegationSavingsDto };

function useWindowRead(
  token: string,
  sinceMs: number,
  reload: number,
  replayEpoch: number | undefined,
  onAuthRejected: () => void,
): WindowRead {
  // Keyed by the window it answers, so a moved boundary cannot show the
  // previous window's figure while the new read is in flight.
  const [read, setRead] = useState<{ readonly sinceMs: number; readonly state: WindowRead }>({
    sinceMs,
    state: { kind: 'loading' },
  });
  useEffect(() => {
    const controller = new AbortController();
    const since = new Date(sinceMs).toISOString();
    void fetchChanges(token, since, { limit: 1 }, controller.signal).then((result) => {
      if (controller.signal.aborted) return;
      if (result.kind === 'unauthorized') {
        onAuthRejected();
      } else if (result.kind === 'error') {
        setRead({ sinceMs, state: { kind: 'error', message: result.message } });
      } else {
        setRead({ sinceMs, state: { kind: 'ready', changes: result.data } });
      }
    });
    return () => controller.abort();
  }, [token, sinceMs, reload, replayEpoch, onAuthRejected]);
  return read.sinceMs === sinceMs ? read.state : { kind: 'loading' };
}

function WindowTile({
  label,
  sinceText,
  read,
  testId,
}: {
  readonly label: string;
  readonly sinceText: string;
  readonly read: WindowRead;
  readonly testId: string;
}) {
  return (
    <div className="kpi" data-testid={testId}>
      <span className="kpi-label">{label}</span>
      {read.kind === 'loading' ? (
        <span className="kpi-value muted">…</span>
      ) : read.kind === 'error' ? (
        <>
          <span className="kpi-value unpriced">not measured</span>
          <span className="muted kpi-note">could not read this window: {read.message}</span>
        </>
      ) : (
        <>
          <span className="kpi-value">{formatUsd(read.changes.totals.costAddedUsd)}</span>
          <span className="muted kpi-note">
            {sinceText} · {formatTokens(read.changes.totals.tokensAdded)} tokens
          </span>
          {read.changes.totals.unpricedTokensAdded > 0 && (
            <span className="kpi-note unpriced" data-testid={`${testId}-unpriced`}>
              {formatTokens(read.changes.totals.unpricedTokensAdded)} tokens unpriced - not counted
              in $
            </span>
          )}
        </>
      )}
    </div>
  );
}

function localTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

export function LocalWindowsStrip({
  token,
  onAuthRejected,
  reload,
  replayEpoch,
  nowMs,
  savings,
  describedBy,
}: {
  readonly token: string;
  readonly onAuthRejected: () => void;
  readonly reload: number;
  readonly replayEpoch: number | undefined;
  readonly nowMs: number;
  readonly savings: SavingsRead;
  readonly describedBy: string | undefined;
}) {
  const todaySinceMs = localMidnightMs(nowMs);
  const weekSinceMs = localMidnightMs(nowMs, LOCAL_WEEK_DAYS - 1);
  const today = useWindowRead(token, todaySinceMs, reload, replayEpoch, onAuthRejected);
  const week = useWindowRead(token, weekSinceMs, reload, replayEpoch, onAuthRejected);
  const readUntil = today.kind === 'ready' ? Date.parse(today.changes.until) : Number.NaN;
  const undatedRows = Math.max(
    today.kind === 'ready' ? today.changes.coverage.undatedUsageRows : 0,
    week.kind === 'ready' ? week.changes.coverage.undatedUsageRows : 0,
  );

  return (
    <>
      <div
        className="kpis"
        role="group"
        aria-label="local time windows"
        aria-describedby={describedBy}
      >
        <WindowTile
          label="Today (local time)"
          sinceText="since 00:00"
          read={today}
          testId="kpi-local-today"
        />
        <WindowTile
          label="Last 7 days (local time)"
          sinceText={`since ${localDayLabel(weekSinceMs, nowMs)} 00:00`}
          read={week}
          testId="kpi-local-week"
        />
        <div className="kpi" data-testid="kpi-local-saved">
          <span className="kpi-label">Saved by delegation</span>
          {savings.kind === 'loading' ? (
            <span className="kpi-value muted">…</span>
          ) : savings.kind === 'error' ? (
            <span className="kpi-value unpriced">not measured</span>
          ) : (
            <>
              <span className="kpi-value">~ {formatUsd(savings.aggregate.savingsUsd)}</span>
              <span className="muted kpi-note">
                all time, estimated - no daily or weekly saving is served yet
              </span>
            </>
          )}
        </div>
      </div>
      <p className="muted windows-note" data-testid="local-windows-basis">
        Local time ({localTimeZone()}), by when the work happened
        {Number.isFinite(readUntil)
          ? `, up to the newest recorded event at ${formatLocalClock(readUntil)} (${localDayLabel(readUntil, nowMs)})`
          : ''}
        .
        {undatedRows > 0 &&
          ` ${String(undatedRows)} usage ${undatedRows === 1 ? 'row carries' : 'rows carry'} no timestamp and ${undatedRows === 1 ? 'is' : 'are'} in no window.`}
      </p>
    </>
  );
}
