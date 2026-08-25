/**
 * SessionCostAnalysis (WP-C4 + WP-C5 in the UI).
 *
 * The suite exists to pin the two honesty contracts the panel carries, because
 * both are invisible to a type check and both fail silently if someone
 * "simplifies" the markup:
 *
 *  1. Delegation savings must never read like a measured amount. The `~`
 *     prefixes, the estimate badge and the named hypothetical model are the
 *     visible half of `isEstimate: Type.Literal(true)`; a test that only
 *     asserted the dollar figures would pass on a panel that quietly dropped
 *     all three.
 *  2. `deltaUsd` is a mispricing signal, not a saving. A materially nonzero
 *     delta must be called out; a sub-cent one is rounding and must not cry
 *     wolf. Both directions are asserted.
 *
 * The four transport failures (503 / 404 / 422 / everything else) are asserted
 * as four DISTINCT sentences - the whole reason `ApiResult` carries a status.
 * fetch is mocked: nothing here touches a server or the real ~/.claude tree.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { analysisErrorText, SessionCostAnalysis } from '../src/views/SessionCostAnalysis';
import { agentSavings, compactionSegment, costAnalysis, deferred, jsonResponse } from './fixtures';

const fetchMock = vi.fn();
const onAuthRejected = vi.fn();

const SESSION_ID = 'aaaaaaaa-1111-2222-3333-444444444444';

beforeEach(() => {
  fetchMock.mockReset();
  onAuthRejected.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function renderPanel(sessionId = SESSION_ID) {
  return render(
    <SessionCostAnalysis
      token="secret-token"
      sessionId={sessionId}
      onAuthRejected={onAuthRejected}
    />,
  );
}

/** A session that was compacted twice and delegated to two subagents. */
function richAnalysis() {
  return costAnalysis({
    compaction: {
      naiveUsd: 3.0,
      repricedUsd: 2.75,
      deltaUsd: -0.25,
      compactionCount: 2,
      segments: [
        compactionSegment({ index: 0, usd: 1.0, messageCount: 30 }),
        compactionSegment({
          index: 1,
          usd: 1.25,
          messageCount: 18,
          boundary: {
            agentId: null,
            timestamp: '2026-07-29T10:30:00.000Z',
            trigger: 'auto',
            preTokens: 150000,
          },
        }),
        compactionSegment({
          agentId: 'cafebabe-0000-1111-2222-333333333333',
          index: 2,
          usd: 0.5,
          messageCount: 6,
          boundary: {
            agentId: 'cafebabe-0000-1111-2222-333333333333',
            timestamp: '2026-07-29T10:45:00.000Z',
            trigger: null,
            preTokens: null,
          },
        }),
      ],
    },
    delegationSavings: {
      actualUsd: 0.5,
      hypotheticalUsd: 2.1,
      savingsUsd: 1.6,
      perAgent: [
        agentSavings(),
        agentSavings({
          agentId: 'deadbeef-9999-8888-7777-666666666666',
          actualUsd: 0.3,
          hypotheticalUsd: 1.2,
          savingsUsd: 0.9,
          hypotheticalModel: 'claude-opus-4',
        }),
      ],
      skippedAgentIds: ['feedface-1111-1111-1111-111111111111'],
      isEstimate: true,
    },
  });
}

describe('analysisErrorText', () => {
  // Four statuses, four different actions by the reader: take it up with the
  // server, accept there is no transcript, look at the data, or read the raw
  // message. Collapsing any pair into one sentence is the failure this pins.
  it('names each failure instead of collapsing them into "could not load"', () => {
    const sentences = [503, 404, 422, 500, null].map((status) =>
      analysisErrorText('raw detail', status),
    );
    // Four distinct sentences from five statuses: 500 and null (no HTTP
    // response at all) both fall through to the raw message, which is the one
    // pair that legitimately reads the same.
    expect(new Set(sentences).size).toBe(4);
    expect(sentences[0]).toContain('unavailable on this server');
    expect(sentences[1]).toContain('no transcript');
    expect(sentences[2]).toContain('cannot be analysed');
    expect(sentences[3]).toBe('raw detail');
    expect(sentences[4]).toBe('raw detail');
  });

  // 503 and 422 each cover MORE THAN ONE server cause, so neither may hard-code
  // one: the reader must still be told which. Carrying the server's own
  // sentence through is what keeps "no provider wired" distinguishable from "no
  // corpus root here", and an unparseable transcript from an empty one.
  it.each([
    [503, 'corpus access is not configured'],
    [503, 'no corpus root is present on this machine, so nothing can be analysed'],
    [503, 'the corpus root exists but could not be read; retry shortly'],
    [422, 'Session transcripts could not be parsed.'],
    [422, 'the session transcript holds no analysable records'],
  ])('passes the %i server sentence through instead of guessing a cause', (status, serverText) => {
    expect(analysisErrorText(serverText, status)).toContain(serverText);
  });

  it('never claims a cause the server did not report', () => {
    // The two sentences the old hard-coded version produced. Each was FALSE for
    // one of the two causes its status now covers.
    const empty = analysisErrorText('the session transcript holds no analysable records', 422);
    expect(empty).not.toContain('could not be parsed');
    const noRoot = analysisErrorText(
      'no corpus root is present on this machine, so nothing can be analysed',
      503,
    );
    expect(noRoot).not.toContain('switched off');
  });
});

describe('SessionCostAnalysis', () => {
  it('requests the session analysis with the Bearer header and shows a loading state first', async () => {
    const pending = deferred<Response>();
    fetchMock.mockReturnValue(pending.promise);
    renderPanel();

    expect(screen.getByTestId('analysis-loading').textContent).toContain('aaaaaaaa…');

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`/api/sessions/${SESSION_ID}/cost-analysis`);
    expect(init.headers).toEqual({ Authorization: 'Bearer secret-token' });

    pending.resolve(jsonResponse(200, costAnalysis()));
    await screen.findByTestId('session-analysis');
  });

  it('renders the compaction KPIs with a signed difference and one row per segment', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, richAnalysis()));
    renderPanel();
    await screen.findByTestId('session-analysis');

    const kpis = screen.getByLabelText('compaction repricing');
    expect(kpis.textContent).toContain('$3.00');
    expect(kpis.textContent).toContain('$2.75');
    // Each figure names its own method - neither claims to be "the" cost.
    expect(kpis.textContent).toContain('one pass, boundaries ignored');
    expect(kpis.textContent).toContain('summed per compaction segment');
    // Signed, so an over-count never looks like an under-count.
    expect(screen.getByTestId('compaction-delta').textContent).toContain('-$0.25');
    expect(screen.getByTestId('compaction-delta').textContent).toContain('across 2 compactions');

    const rows = [
      ...screen.getByRole('table', { name: 'compaction segments' }).querySelectorAll('tbody tr'),
    ];
    expect(rows).toHaveLength(3);
    // The opening segment is opened by nothing - stated, not left blank.
    expect(rows[0]?.textContent).toContain('session start');
    expect(rows[0]?.textContent).toContain('main');
    expect(rows[1]?.textContent).toContain('auto');
    // A boundary with no recorded trigger still says a compaction opened it.
    expect(rows[2]?.textContent).toContain('compaction');
    expect(rows[2]?.textContent).toContain('cafebabe…');
    // 100 + 200 + 300 + 40 + 5, summed across the five priced buckets.
    expect(rows[0]?.textContent).toContain('645');
    expect(rows[0]?.textContent).toContain('$1.00');
  });

  it('calls a materially nonzero delta a mispricing signal, not a saving', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, richAnalysis()));
    renderPanel();
    const signal = await screen.findByTestId('delta-signal');
    expect(signal.textContent).toContain('mispricing signal, not a');
    expect(signal.textContent).not.toContain('saved');
  });

  it('stays quiet about a sub-cent delta, which is rounding rather than signal', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(
        200,
        costAnalysis({
          compaction: {
            naiveUsd: 1.0,
            repricedUsd: 1.0,
            deltaUsd: 0.0009,
            compactionCount: 1,
            segments: [compactionSegment()],
          },
        }),
      ),
    );
    renderPanel();
    await screen.findByTestId('session-analysis');

    expect(screen.queryByTestId('delta-signal')).toBeNull();
    // A positive delta is still rendered with its sign.
    expect(screen.getByTestId('compaction-delta').textContent).toContain('+$0.0009');
    expect(screen.getByTestId('compaction-delta').textContent).toContain('across 1 compaction');
  });

  it('says a session was never compacted instead of showing a $0 repricing', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, costAnalysis()));
    renderPanel();
    await screen.findByTestId('session-analysis');

    expect(screen.getByTestId('no-compaction').textContent).toContain('never compacted');
    expect(screen.queryByRole('table', { name: 'compaction segments' })).toBeNull();
    expect(screen.queryByLabelText('compaction repricing')).toBeNull();
  });

  it('marks every delegation figure as an estimate and names the hypothetical model', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, richAnalysis()));
    renderPanel();
    await screen.findByTestId('session-analysis');

    expect(screen.getByTestId('estimate-badge').textContent).toBe('estimate');

    const kpis = screen.getByLabelText('delegation savings');
    // The measured half carries no tilde; both modelled halves do.
    expect(kpis.textContent).toContain('$0.50');
    expect(kpis.textContent).toContain('~ $2.10');
    expect(screen.getByTestId('savings-kpi').textContent).toContain('~ $1.60');

    const rows = [
      ...screen
        .getByRole('table', { name: 'delegation savings per agent' })
        .querySelectorAll('tbody tr'),
    ];
    expect(rows).toHaveLength(2);
    expect(rows[0]?.textContent).toContain('claude-opus-5');
    expect(rows[0]?.textContent).toContain('$0.20'); // actual: measured
    expect(rows[0]?.textContent).toContain('~ $0.90'); // hypothetical: modelled
    expect(rows[0]?.textContent).toContain('~ $0.70');
    expect(rows[1]?.textContent).toContain('claude-opus-4');
  });

  it('labels the two levels for the slice they measure, not as session dollars', async () => {
    // Both sums run over subagents only. Labelled "Actual" / "Without
    // delegation" they read as session totals, and a reader comparing $0.50
    // against the session cost shown elsewhere concludes money went missing.
    // The saving is unaffected either way - the main agent's spend is equal in
    // both worlds and cancels - so the fix is the label, never the arithmetic.
    fetchMock.mockResolvedValue(jsonResponse(200, richAnalysis()));
    renderPanel();
    await screen.findByTestId('session-analysis');

    const kpis = screen.getByLabelText('delegation savings');
    expect(kpis.textContent).toContain('Delegated work, actual');
    expect(kpis.textContent).toContain('Same work, no delegation');
    expect(kpis.textContent).toContain('subagents only');

    const scope = screen.getByTestId('delegation-scope').textContent ?? '';
    expect(scope).toContain('delegated turns only');
    expect(scope).toContain('same with or without delegation');
  });

  it('reports the subagents excluded from the estimate rather than guessing at them', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, richAnalysis()));
    renderPanel();
    const skipped = await screen.findByTestId('skipped-agents');
    expect(skipped.textContent).toContain('1 subagent is');
    expect(skipped.textContent).toContain('a guess would be worse than a gap');
  });

  it('pluralises the excluded-subagent note and hides it when nothing was skipped', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(
        200,
        costAnalysis({
          delegationSavings: {
            actualUsd: 0.1,
            hypotheticalUsd: 0.4,
            savingsUsd: 0.3,
            perAgent: [agentSavings()],
            skippedAgentIds: ['a-1', 'a-2'],
            isEstimate: true,
          },
        }),
      ),
    );
    const { unmount } = renderPanel();
    const skipped = await screen.findByTestId('skipped-agents');
    expect(skipped.textContent).toContain('2 subagents are');
    expect(skipped.textContent).toContain('worse than a gap');
    unmount();

    fetchMock.mockResolvedValue(jsonResponse(200, costAnalysis()));
    renderPanel();
    await screen.findByTestId('session-analysis');
    expect(screen.queryByTestId('skipped-agents')).toBeNull();
  });

  it('says no subagent ran instead of drawing an empty per-agent table', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, costAnalysis()));
    renderPanel();
    await screen.findByTestId('no-delegation');
    expect(screen.queryByRole('table', { name: 'delegation savings per agent' })).toBeNull();
  });

  it('withholds the figures when every subagent was skipped, instead of showing $0.00', async () => {
    // The state that reads as a measurement but is a total gap: subagents DID
    // run, none of them could be priced, so all three sums are 0. Rendered like
    // any other session that would claim delegation saved nothing - and the
    // empty state below would claim no subagent ran at all. Both are false.
    fetchMock.mockResolvedValue(
      jsonResponse(
        200,
        costAnalysis({
          delegationSavings: {
            actualUsd: 0,
            hypotheticalUsd: 0,
            savingsUsd: 0,
            perAgent: [],
            skippedAgentIds: ['a-1', 'a-2'],
            isEstimate: true,
          },
        }),
      ),
    );
    renderPanel();

    const gap = await screen.findByTestId('delegation-unpriceable');
    expect(gap.textContent).toContain('delegated to 2 subagents');
    expect(gap.textContent).toContain('cannot be estimated at all');
    // The three $0.00 KPIs and the "no subagent ran" line must both be gone,
    // and the footnote about exclusions has no estimate left to footnote.
    expect(screen.queryByLabelText('delegation savings')).toBeNull();
    expect(screen.queryByTestId('savings-kpi')).toBeNull();
    expect(screen.queryByTestId('delegation-scope')).toBeNull();
    expect(screen.queryByTestId('no-delegation')).toBeNull();
    expect(screen.queryByTestId('skipped-agents')).toBeNull();
  });

  it('speaks of a single unpriceable subagent in the singular', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(
        200,
        costAnalysis({
          delegationSavings: {
            actualUsd: 0,
            hypotheticalUsd: 0,
            savingsUsd: 0,
            perAgent: [],
            skippedAgentIds: ['a-1'],
            isEstimate: true,
          },
        }),
      ),
    );
    renderPanel();

    const gap = await screen.findByTestId('delegation-unpriceable');
    expect(gap.textContent).toContain('delegated to 1 subagent,');
    expect(gap.textContent).toContain('resolved for it,');
  });

  it.each([
    [503, 'unavailable on this server'],
    [404, 'no transcript'],
    [422, 'cannot be analysed'],
    [500, 'Internal server error.'],
  ])('renders the %i failure as its own sentence', async (status, expected) => {
    fetchMock.mockResolvedValue(jsonResponse(status, { error: 'Internal server error.' }));
    renderPanel();
    const error = await screen.findByTestId('analysis-error');
    expect(error.textContent).toContain(expected);
    expect(screen.queryByTestId('session-analysis')).toBeNull();
  });

  it('calls onAuthRejected on 401 without rendering an error sentence', async () => {
    fetchMock.mockResolvedValue(jsonResponse(401, { error: 'Unauthorized.' }));
    renderPanel();
    await waitFor(() => {
      expect(onAuthRejected).toHaveBeenCalledTimes(1);
    });
    expect(screen.queryByTestId('analysis-error')).toBeNull();
  });

  it('restarts at loading when the selected session changes, so stale numbers never persist', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, richAnalysis()));
    const { rerender } = renderPanel();
    await screen.findByTestId('session-analysis');

    const second = deferred<Response>();
    fetchMock.mockReturnValue(second.promise);
    rerender(
      <SessionCostAnalysis
        token="secret-token"
        sessionId="bbbbbbbb-5555-6666-7777-888888888888"
        onAuthRejected={onAuthRejected}
      />,
    );

    // The previous session's dollars are gone the instant the id changes.
    expect(screen.queryByTestId('session-analysis')).toBeNull();
    expect(screen.getByTestId('analysis-loading').textContent).toContain('bbbbbbbb…');

    second.resolve(jsonResponse(200, costAnalysis()));
    await screen.findByTestId('session-analysis');
  });

  it('encodes the session id into the path', () => {
    fetchMock.mockReturnValue(deferred<Response>().promise);
    renderPanel('a/b?c');
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/sessions/a%2Fb%3Fc/cost-analysis');
  });

  it('aborts the in-flight request on unmount and never sets state afterwards', async () => {
    const pending = deferred<Response>();
    fetchMock.mockReturnValue(pending.promise);
    const { unmount } = renderPanel();

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const signal = init.signal as AbortSignal;
    expect(signal.aborted).toBe(false);

    unmount();
    expect(signal.aborted).toBe(true);

    // Resolving after the unmount must be a no-op, not a React state update on
    // a dead component (which would surface as an act() warning, not a failure).
    pending.resolve(jsonResponse(200, richAnalysis()));
    await pending.promise;
    expect(onAuthRejected).not.toHaveBeenCalled();
  });
});
