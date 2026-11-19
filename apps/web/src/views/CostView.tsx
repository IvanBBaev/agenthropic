/**
 * (d) Cost view (WP-U9): totals, per-model and per-day breakdowns, top
 * sessions, and a sankey of dollar flows (model -> all cost -> session).
 * Every dollar figure is server-side ground truth (tokens x dated price);
 * `unpricedTokens` is an honest gap and is surfaced EVERYWHERE it appears -
 * as its own headline tile, as a column in every table, and as a note on
 * flow nodes - never hidden, never rendered as $0.
 *
 * Four additions, three from the 2026-08-09 implementation review and one
 * from 2026-09-01:
 *   - M-9: today / last-7-days KPIs, computed client-side from the served
 *     `perDay` rows with an explicitly UTC day basis (see cost-windows.ts) -
 *     the labels name the boundary instead of assuming the local timezone;
 *   - M-8: a "top agent burners" table ranking the served DAG nodes by token
 *     burn, so the biggest agent/subagent burner is readable without hovering
 *     SVG <title> tooltips (which keyboard and AT users cannot reach at all);
 *   - M-10: those windows are cut against the app's shared clock (clock.ts)
 *     rather than a per-render `Date.now()`, so a tab left open across UTC
 *     midnight rolls over instead of presenting yesterday's totals under a
 *     label that says today.
 *   - F-1 (2026-09-01): rolling the window over is only half the problem. The
 *     rows do NOT roll over with it - they are fetched once - so past midnight
 *     the today tile summed a day the snapshot could not contain and printed
 *     the result as $0.00. The summary now carries the moment it was read, and
 *     the tile prints "not measured" rather than a zero it never measured.
 *
 * AMENDED 2026-11-14 (R21, UX-8): the page now LEADS with a local-time strip -
 * today, last 7 days and saved by delegation - read from `/api/changes` with
 * local midnight as the window start (see LocalWindows.tsx). The UTC tiles
 * remain, below the totals, as the day basis of the per-day table.
 *
 * AMENDED 2026-11-19 (UX-16): this file is now the orchestrator - the three
 * reads, their state and the page order. Each section renders from its own
 * module under ./cost/ (KpiStrip, SavingsPanel, FlowPanel, Tables,
 * BurnersPanel); the shared constants live in ./cost/shared.tsx.
 */
import { useEffect, useState } from 'react';
import { fetchAggregateSavings, fetchCostSummary, fetchGlobalDag } from '../api';
import { readNowMs, useNowMs } from '../clock';
import type { CostSummaryDto } from '../dto';
import { BurnersSection, type BurnersState } from './cost/BurnersPanel';
import { FlowPanel } from './cost/FlowPanel';
import { TotalsKpis, WindowKpis } from './cost/KpiStrip';
import { SavingsSection, type SavingsState } from './cost/SavingsPanel';
import { COST_HONESTY_ID, COST_TOP_N, REFRESH_LABEL, TOP_BURNERS_NODE_LIMIT } from './cost/shared';
import { PerDayTable, PerModelTable, TopSessionsTable } from './cost/Tables';
import { SessionCostAnalysis } from './SessionCostAnalysis';
import { snapshotAge } from './snapshot';
import { LocalWindowsStrip } from './LocalWindows';
import type { ViewProps } from './types';

export { COST_TOP_N, TOP_BURNERS_N, TOP_BURNERS_NODE_LIMIT } from './cost/shared';

type CostState =
  | { readonly kind: 'loading' }
  | { readonly kind: 'error'; readonly message: string }
  // `observedAtMs` is not decoration: without it the view cannot tell a day
  // with no spend from a day the snapshot predates. See the F-1 note in
  // cost/KpiStrip.tsx (WindowKpis).
  | { readonly kind: 'ready'; readonly summary: CostSummaryDto; readonly observedAtMs: number };

export function CostView({ token, onAuthRejected, replayEpoch }: ViewProps) {
  const [state, setState] = useState<CostState>({ kind: 'loading' });
  const [burners, setBurners] = useState<BurnersState>({ kind: 'loading' });
  const [savings, setSavings] = useState<SavingsState>({ kind: 'loading' });
  // Per-session analysis (WP-C4/C5) reads transcripts off disk, so it is opt-in
  // per session rather than fetched for every row of the summary.
  const [analysedSessionId, setAnalysedSessionId] = useState<string | null>(null);
  // M-10: the reading that cuts the UTC windows below. It has to be read here,
  // above the early returns, because it is a hook - and it ticks, so this view
  // re-renders when the day boundary moves under a long-open tab.
  const nowMs = useNowMs();
  // KK3 (2026-09-25): the explicit re-read, DagView's pattern. Every fetch
  // effect below depends on it, so one bump re-reads all three endpoints and
  // each effect's cleanup aborts the read it supersedes. Deliberately not
  // driven by SSE - whether the fetch-once views go live is an owner call.
  // `replayEpoch` rides beside it in all three: figures read during the
  // startup replay are re-read when the replay ends (see ViewProps).
  const [reload, setReload] = useState(0);
  const refresh = () => setReload((value) => value + 1);

  useEffect(() => {
    const controller = new AbortController();
    void fetchCostSummary(token, COST_TOP_N, controller.signal).then((result) => {
      if (controller.signal.aborted) return;
      if (result.kind === 'unauthorized') {
        onAuthRejected();
      } else if (result.kind === 'error') {
        setState({ kind: 'error', message: result.message });
      } else {
        // Stamped here, at the moment the rows arrive - not at render, where
        // it would drift, and not from the ticking store, whose reading can be
        // half a minute old and so can name the wrong UTC day near midnight.
        setState({ kind: 'ready', summary: result.data, observedAtMs: readNowMs() });
      }
    });
    return () => controller.abort();
  }, [token, reload, onAuthRejected, replayEpoch]);

  useEffect(() => {
    const controller = new AbortController();
    void fetchGlobalDag(token, TOP_BURNERS_NODE_LIMIT, controller.signal).then((result) => {
      if (controller.signal.aborted) return;
      if (result.kind === 'unauthorized') {
        onAuthRejected();
      } else if (result.kind === 'error') {
        setBurners({ kind: 'error', message: result.message });
      } else {
        setBurners({ kind: 'ready', dag: result.data });
      }
    });
    return () => controller.abort();
  }, [token, reload, onAuthRejected, replayEpoch]);

  useEffect(() => {
    const controller = new AbortController();
    void fetchAggregateSavings(token, controller.signal).then((result) => {
      if (controller.signal.aborted) return;
      if (result.kind === 'unauthorized') {
        onAuthRejected();
      } else if (result.kind === 'error') {
        setSavings({ kind: 'error', message: result.message });
      } else {
        setSavings({ kind: 'ready', aggregate: result.data });
      }
    });
    return () => controller.abort();
  }, [token, reload, onAuthRejected, replayEpoch]);

  if (state.kind === 'loading') {
    return (
      <section aria-label="cost summary">
        <p className="muted">Loading cost summary…</p>
      </section>
    );
  }
  if (state.kind === 'error') {
    return (
      <section aria-label="cost summary">
        <p className="empty-state">
          <span className="status-error">✕</span> Could not load cost summary: {state.message}
        </p>
        <button type="button" onClick={refresh}>
          Retry
        </button>
      </section>
    );
  }

  const { summary } = state;
  // KK3: the same snapshot disclosure as the DAG and sessions views. The three
  // reads are issued together, so the summary's stamp dates the page; the
  // caveat is quiet inside the app's "just now" window and a banner outside it.
  const age = snapshotAge(state.observedAtMs, nowMs);
  // Owner decisions 1 and 2. Derived once: the note and every description
  // that names it have to agree about whether it is on the page, because an
  // idref to a paragraph that was not rendered is a caveat that vanishes.
  const hasMalformedLines =
    summary.sessionsWithMalformedLines !== 0 || summary.malformedLinesSkipped !== 0;
  const hasCostHonesty =
    summary.partialSessions !== 0 || summary.usageRecordsDropped !== 0 || hasMalformedLines;
  const costHonestyDescribedBy = hasCostHonesty ? COST_HONESTY_ID : undefined;

  return (
    <section aria-label="cost summary">
      <p
        className={age.aged ? 'truncation-banner' : 'muted card-provenance'}
        data-testid="cost-provenance"
      >
        Read {age.label}
        {age.aged
          ? ' - every figure on this page is as of that read, and usage recorded since is in none of them.'
          : '.'}{' '}
        <button type="button" onClick={refresh}>
          {REFRESH_LABEL}
        </button>
      </p>
      {/* R21 (UX-8): the page leads with today / this week / saved, in the
          reader's own timezone. The UTC tiles below stay as they were. */}
      <LocalWindowsStrip
        token={token}
        onAuthRejected={onAuthRejected}
        reload={reload}
        replayEpoch={replayEpoch}
        nowMs={nowMs}
        savings={savings}
        describedBy={costHonestyDescribedBy}
      />
      <TotalsKpis
        summary={summary}
        hasCostHonesty={hasCostHonesty}
        costHonestyDescribedBy={costHonestyDescribedBy}
      />
      <WindowKpis
        summary={summary}
        observedAtMs={state.observedAtMs}
        nowMs={nowMs}
        costHonestyDescribedBy={costHonestyDescribedBy}
      />
      <SavingsSection savings={savings} />
      <FlowPanel summary={summary} hasCostHonesty={hasCostHonesty} />
      <PerModelTable summary={summary} costHonestyDescribedBy={costHonestyDescribedBy} />
      <PerDayTable summary={summary} costHonestyDescribedBy={costHonestyDescribedBy} />
      <BurnersSection burners={burners} />
      <TopSessionsTable
        summary={summary}
        costHonestyDescribedBy={costHonestyDescribedBy}
        analysedSessionId={analysedSessionId}
        onAnalyse={setAnalysedSessionId}
      />

      <h2>Session analysis</h2>
      {analysedSessionId === null ? (
        <p className="empty-state" data-testid="analysis-prompt">
          Pick a session above to reprice it across its compaction boundaries and estimate what it
          would have cost without delegation.
        </p>
      ) : (
        <SessionCostAnalysis
          token={token}
          sessionId={analysedSessionId}
          onAuthRejected={onAuthRejected}
        />
      )}
    </section>
  );
}
