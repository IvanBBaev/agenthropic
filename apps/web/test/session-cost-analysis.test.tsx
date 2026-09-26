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
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { UNREADABLE_TOKENS, UNREADABLE_USD } from '../src/format';
import { NO_FIGURE_META } from '../src/views/status';
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

  it('refuses to put a sign on a difference it cannot read', async () => {
    // Nothing on the client validates this DTO at runtime, so whatever `json()`
    // hands back is what gets rendered; a non-finite delta is not excluded by
    // anything this component controls.
    // AMENDED 2026-09-23 (K5, lane K): `dto-guards` now DOES validate the body
    // before it reaches this component, so the first sentence is no longer
    // literally true - but the case it describes is untouched. Rule 1 of
    // dto-guards is "shape, not sanity": a numeric leaf is tested with
    // `typeof x === 'number'`, which admits `NaN` on purpose, because JSON has
    // no literal for it and a guard that rejected it would turn one unreadable
    // figure into a blank panel. So a non-finite delta still arrives here, and
    // this test stays reachable.
    // It matters because `NaN >= 0` is false,
    // so the plain signing would have printed a MINUS in front of a figure that
    // has no direction at all - a fabricated claim that the repricing came in
    // under the naive sum.
    fetchMock.mockResolvedValue(
      jsonResponse(
        200,
        costAnalysis({
          compaction: {
            naiveUsd: 3.0,
            repricedUsd: Number.NaN,
            deltaUsd: Number.NaN,
            compactionCount: 1,
            segments: [compactionSegment()],
          },
        }),
      ),
    );
    renderPanel();
    await screen.findByTestId('session-analysis');

    const delta = screen.getByTestId('compaction-delta');
    expect(delta.textContent).toContain(UNREADABLE_USD);
    expect(delta.textContent).not.toContain('+');
    expect(delta.textContent).not.toContain('-');
    expect(delta.textContent).not.toContain('NaN');
    // The banner stays away on purpose. Its sentence is about "a difference
    // this size", and an unreadable delta has no size to be that size - the
    // tile already tells the reader the figure could not be read, which is the
    // louder and the truer of the two statements.
    expect(screen.queryByTestId('delta-signal')).toBeNull();
  });

  it('says whether a session is mispriced is unknown when the difference cannot be read', async () => {
    // KK6. `Math.abs(NaN) >= 0.01` is false, so the signal test alone went
    // silent exactly when the number could not be read: no banner, no
    // description on the table, and a tile saying "unreadable" with nothing
    // telling the reader what that means for the mispricing question.
    fetchMock.mockResolvedValue(
      jsonResponse(
        200,
        costAnalysis({
          compaction: {
            naiveUsd: 3.0,
            repricedUsd: Number.NaN,
            deltaUsd: Number.NaN,
            compactionCount: 1,
            segments: [compactionSegment()],
          },
        }),
      ),
    );
    renderPanel();
    await screen.findByTestId('session-analysis');

    const notice = screen.getByTestId('delta-unknown');
    expect(notice.textContent).toContain('could not be computed');
    expect(notice.textContent).toContain('mispriced is unknown');
    const table = screen.getByRole('table', { name: 'compaction segments' });
    const describedBy = table.getAttribute('aria-describedby') ?? '';
    expect(describedBy.length).toBeGreaterThan(0);
    expect(document.getElementById(describedBy)).toBe(notice);
  });

  it('shows no unknown-difference notice when the difference is readable', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, richAnalysis()));
    renderPanel();
    await screen.findByTestId('session-analysis');
    expect(screen.queryByTestId('delta-unknown')).toBeNull();
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

  // "Would have run on" is a column whose whole content is a model name, and
  // the three dollar figures beside it are derived FROM that model. A blank
  // name leaves the row asserting a counterfactual with no counterfactual in
  // it - the one cell that says what was assumed goes missing while the
  // arithmetic built on the assumption stays.
  it('names a blank hypothetical model rather than leaving the cell empty', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(
        200,
        costAnalysis({
          delegationSavings: {
            actualUsd: 0.2,
            hypotheticalUsd: 0.9,
            savingsUsd: 0.7,
            perAgent: [agentSavings({ hypotheticalModel: '' })],
            skippedAgentIds: [],
            isEstimate: true,
          },
        }),
      ),
    );
    renderPanel();
    await screen.findByTestId('session-analysis');

    const row = screen
      .getByRole('table', { name: 'delegation savings per agent' })
      .querySelector('tbody tr');
    expect(row?.textContent).toContain('blank model name ("")');
    expect(row?.textContent).toContain(NO_FIGURE_META.symbol);
  });

  it('names a whitespace-only hypothetical model, which renders as nothing', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(
        200,
        costAnalysis({
          delegationSavings: {
            actualUsd: 0.2,
            hypotheticalUsd: 0.9,
            savingsUsd: 0.7,
            perAgent: [agentSavings({ hypotheticalModel: ' ' })],
            skippedAgentIds: [],
            isEstimate: true,
          },
        }),
      ),
    );
    renderPanel();
    await screen.findByTestId('session-analysis');

    const row = screen
      .getByRole('table', { name: 'delegation savings per agent' })
      .querySelector('tbody tr');
    expect(row?.textContent).toContain('blank model name (" ")');
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

  it('marks both computation gaps with the gap glyph, not with a status glyph', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, richAnalysis()));
    const { unmount } = renderPanel();

    const skipped = await screen.findByTestId('skipped-agents');
    const marker = skipped.querySelector('[aria-hidden="true"]');
    expect(marker?.textContent?.trim()).toBe(NO_FIGURE_META.symbol);
    // Not `status-unknown`. That class is the watchdog's amber for an agent
    // whose STATE is not known; nothing here is in an unknown state - a number
    // could not be computed. Painting the two the same taught the reader that
    // amber means one thing and then used it for another.
    expect(marker?.getAttribute('class')).toBe(NO_FIGURE_META.className);
    expect(skipped.querySelector('.status-unknown')).toBeNull();
    unmount();

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
    const gapMarker = gap.querySelector('[aria-hidden="true"]');
    expect(gapMarker?.textContent?.trim()).toBe(NO_FIGURE_META.symbol);
    expect(gapMarker?.getAttribute('class')).toBe(NO_FIGURE_META.className);
    expect(gap.querySelector('.status-unknown')).toBeNull();
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

  /**
   * AMENDED 2026-09-03 (CA-1..CA-4). Everything below is new; nothing above it
   * was changed. The suite pinned the two honesty contracts named in the file
   * header and stopped there, so four claims went unexamined: that the counts
   * in the segment table are counts, that the delegation dollars cover the
   * subagents the labels name, that the three levels reconcile, and that a
   * reader who never sees the layout meets the same caveats a sighted reader
   * does.
   */
  it('refuses to print an unreadable segment count as if it were a count', async () => {
    // The F-5 vector, one component over: `api.ts` casts the body with
    // `body as T` and there is no runtime schema anywhere in this app, so a
    // renamed or absent field arrives as a non-number. `toLocaleString` does
    // not throw on those - it renders `NaN` and `∞`, right-aligned in the
    // numeric column next to figures that are real.
    fetchMock.mockResolvedValue(
      jsonResponse(
        200,
        costAnalysis({
          compaction: {
            naiveUsd: 1,
            repricedUsd: 1,
            deltaUsd: 0,
            compactionCount: 1,
            segments: [
              compactionSegment({
                index: 0,
                messageCount: undefined as unknown as number,
                tokens: {
                  input: 100,
                  output: undefined as unknown as number,
                  cacheRead: 300,
                  cacheWrite5m: 40,
                  cacheWrite1h: 5,
                },
              }),
              compactionSegment({
                index: 1,
                messageCount: Number.POSITIVE_INFINITY,
                tokens: {
                  input: Number.POSITIVE_INFINITY,
                  output: 200,
                  cacheRead: 300,
                  cacheWrite5m: 40,
                  cacheWrite1h: 5,
                },
              }),
            ],
          },
        }),
      ),
    );
    renderPanel();
    await screen.findByTestId('session-analysis');

    const rows = [
      ...screen.getByRole('table', { name: 'compaction segments' }).querySelectorAll('tbody tr'),
    ];
    for (const row of rows) {
      const text = row.textContent ?? '';
      expect(text).not.toContain('NaN');
      expect(text).not.toContain('∞');
      expect(text).toContain(UNREADABLE_TOKENS);
      expect(text).toContain('messages unreadable');
    }
  });

  it('says how many subagents the delegation dollars actually cover', async () => {
    // packages/core computes all three sums with `continue` on a skipped
    // subagent, so a skipped one is missing from the MEASURED level too - and
    // its dollars are real, merely unpriceable against a counterfactual. The
    // panel labelled that level "measured, subagents only" and printed the
    // exclusion as a bare count, so nothing on screen let the reader work out
    // that two thirds of the delegating subagents are in the figure.
    fetchMock.mockResolvedValue(jsonResponse(200, richAnalysis()));
    renderPanel();
    await screen.findByTestId('session-analysis');

    const kpis = screen.getByLabelText('delegation savings');
    expect(kpis.textContent).toContain('2 of 3');

    const skipped = screen.getByTestId('skipped-agents');
    expect(skipped.textContent).toContain('1 of 3');
    expect(skipped.textContent).toContain('the measured one included');
  });

  it('leaves the coverage note off when every subagent that ran is in the figures', async () => {
    // The counterpart: no exclusion, so no denominator to disclose. A caveat
    // printed when nothing is wrong is spent credibility.
    fetchMock.mockResolvedValue(
      jsonResponse(
        200,
        costAnalysis({
          delegationSavings: {
            actualUsd: 0.2,
            hypotheticalUsd: 0.9,
            savingsUsd: 0.7,
            perAgent: [agentSavings()],
            skippedAgentIds: [],
            isEstimate: true,
          },
        }),
      ),
    );
    renderPanel();
    await screen.findByTestId('session-analysis');
    const kpis = screen.getByLabelText('delegation savings');
    expect(kpis.textContent).toContain('measured, subagents only');
    expect(kpis.textContent).not.toContain(' of 1');
  });

  it('says that Saved is floored at zero when a subagent cost more than the alternative', async () => {
    // `savingsUsd` is Σ max(0, hypothetical - actual) per subagent, so the
    // three levels do NOT subtract: here 1.30 - 1.20 = 0.10, and the panel
    // shows ~$0.70. A subagent routed to a model dearer than its parent's is
    // exactly how that happens, and floored to $0.00 it reads as "delegation
    // was neutral for this one" rather than "it cost 0.60 more".
    fetchMock.mockResolvedValue(
      jsonResponse(
        200,
        costAnalysis({
          delegationSavings: {
            actualUsd: 1.2,
            hypotheticalUsd: 1.3,
            savingsUsd: 0.7,
            perAgent: [
              agentSavings({ actualUsd: 1.0, hypotheticalUsd: 0.4, savingsUsd: 0 }),
              agentSavings({
                agentId: 'deadbeef-9999-8888-7777-666666666666',
                actualUsd: 0.2,
                hypotheticalUsd: 0.9,
                savingsUsd: 0.7,
              }),
            ],
            skippedAgentIds: [],
            isEstimate: true,
          },
        }),
      ),
    );
    renderPanel();
    await screen.findByTestId('session-analysis');

    const floor = screen.getByTestId('delegation-floor');
    expect(floor.textContent).toContain('1 subagent');
    expect(floor.textContent).toContain('floor');
    expect(floor.textContent).toContain('does not equal');
  });

  it('keeps the floor notice grammatical when more than one subagent cost more', async () => {
    // The plural arm of the same sentence. Pinned for the same reason the
    // skipped-agent pair above is: a count rendered with the wrong noun reads
    // as a template that nobody checked, which is exactly the impression a
    // caveat cannot afford to give.
    fetchMock.mockResolvedValue(
      jsonResponse(
        200,
        costAnalysis({
          delegationSavings: {
            actualUsd: 2.0,
            hypotheticalUsd: 0.8,
            savingsUsd: 0,
            perAgent: [
              agentSavings({ actualUsd: 1.0, hypotheticalUsd: 0.4, savingsUsd: 0 }),
              agentSavings({
                agentId: 'deadbeef-9999-8888-7777-666666666666',
                actualUsd: 1.0,
                hypotheticalUsd: 0.4,
                savingsUsd: 0,
              }),
            ],
            skippedAgentIds: [],
            isEstimate: true,
          },
        }),
      ),
    );
    renderPanel();
    await screen.findByTestId('session-analysis');
    expect(screen.getByTestId('delegation-floor').textContent).toContain('2 subagents');
  });

  it('stays quiet about the floor when no subagent cost more than the alternative', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, richAnalysis()));
    renderPanel();
    await screen.findByTestId('session-analysis');
    expect(screen.queryByTestId('delegation-floor')).toBeNull();
  });

  /**
   * M1 (2026-09-23, lane-M). The floor notice counted dearer subagents with
   * `hypotheticalUsd < actualUsd`, and a comparison against a non-finite figure
   * is false rather than unknown. So a subagent whose estimate arrived as NaN -
   * `dto-guards.ts` promises `typeof === 'number'`, which NaN satisfies - was
   * counted as "not dearer", indistinguishable from one measured to be cheaper.
   * The panel then printed "Saved ~$X" with no notice at all, which is the page
   * asserting that every subagent it priced came out at or below the top-tier
   * alternative - a claim it did not make and could not have made.
   */
  it('reports a subagent it could not compare as unknown, not as not-dearer', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(
        200,
        costAnalysis({
          delegationSavings: {
            actualUsd: 0.4,
            hypotheticalUsd: 0.9,
            savingsUsd: 0.7,
            perAgent: [
              agentSavings({ actualUsd: 0.2, hypotheticalUsd: 0.9, savingsUsd: 0.7 }),
              // The defeating row: `NaN < 0.2` is false, so this subagent used
              // to be silently filed with the cheap ones.
              agentSavings({
                agentId: 'deadbeef-9999-8888-7777-666666666666',
                actualUsd: 0.2,
                hypotheticalUsd: Number.NaN,
                savingsUsd: 0,
              }),
            ],
            skippedAgentIds: [],
            isEstimate: true,
          },
        }),
      ),
    );
    renderPanel();
    await screen.findByTestId('session-analysis');

    const floor = screen.getByTestId('delegation-floor');
    expect(floor.textContent).toContain('1 of 2 subagents could not be compared');
    expect(floor.textContent).toContain('is unknown');
    // A caveat only a sighted reader meets is not a caveat (CA-4): the group
    // that holds the three figures must name this paragraph too.
    expect(
      screen.getByRole('group', { name: 'delegation savings' }).getAttribute('aria-describedby'),
    ).toContain('analysis-delegation-floor');
  });

  it('separates the dearer subagents from the ones it could not compare', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(
        200,
        costAnalysis({
          delegationSavings: {
            actualUsd: 2.2,
            hypotheticalUsd: 0.8,
            savingsUsd: 0,
            perAgent: [
              agentSavings({ actualUsd: 1.0, hypotheticalUsd: 0.4, savingsUsd: 0 }),
              // Unreadable on the measured side rather than the modelled one.
              agentSavings({
                agentId: 'deadbeef-9999-8888-7777-666666666666',
                actualUsd: Number.NaN,
                hypotheticalUsd: 0.4,
                savingsUsd: 0,
              }),
              agentSavings({
                agentId: 'deadbeef-9999-8888-7777-555555555555',
                actualUsd: 0.2,
                hypotheticalUsd: Number.POSITIVE_INFINITY,
                savingsUsd: 0,
              }),
            ],
            skippedAgentIds: [],
            isEstimate: true,
          },
        }),
      ),
    );
    renderPanel();
    await screen.findByTestId('session-analysis');

    const floor = screen.getByTestId('delegation-floor');
    // Both facts, in the same paragraph, neither standing in for the other:
    // one subagent is known to have cost more, two are not known either way.
    expect(floor.textContent).toContain('1 subagent cost MORE');
    expect(floor.textContent).toContain('2 of 3 subagents could not be compared');
    expect(floor.textContent).toContain('covers the other 1');
  });

  it('keeps the uncomparable notice grammatical for a single subagent', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(
        200,
        costAnalysis({
          delegationSavings: {
            actualUsd: 0.2,
            hypotheticalUsd: 0,
            savingsUsd: 0,
            perAgent: [
              agentSavings({ actualUsd: 0.2, hypotheticalUsd: Number.NaN, savingsUsd: 0 }),
            ],
            skippedAgentIds: [],
            isEstimate: true,
          },
        }),
      ),
    );
    renderPanel();
    await screen.findByTestId('session-analysis');

    const floor = screen.getByTestId('delegation-floor');
    expect(floor.textContent).toContain('1 of 1 subagent could not be compared');
    expect(floor.textContent).toContain('whether it cost more');
  });

  /**
   * CA-4, the F-18 defect one element over. A table is a navigable landmark:
   * a reader can jump straight into "delegation savings per agent" and hear
   * its accessible name and its cells. The caveats that make those cells
   * honest - the counterfactual basis, the scope, the exclusions - were prose
   * elsewhere on the page, reachable only by reading the page in visual order,
   * and the `~` that carries "estimate" visually is punctuation most screen
   * readers drop at default verbosity. So the reader with the least context
   * got the most confident numbers.
   */
  it('carries the delegation caveats into the table description, not just the layout', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, richAnalysis()));
    renderPanel();
    await screen.findByTestId('session-analysis');

    const table = screen.getByRole('table', { name: 'delegation savings per agent' });
    const described = (table.getAttribute('aria-describedby') ?? '')
      .split(' ')
      .filter((id) => id.length > 0)
      .map((id) => document.getElementById(id)?.textContent ?? '')
      .join(' ');
    expect(described).toContain('not a measurement');
    expect(described).toContain('delegated turns only');
    expect(described).toContain('worse than a gap');

    // The KPI group carries the same description, for the same reason.
    const kpis = screen.getByLabelText('delegation savings');
    expect(kpis.getAttribute('aria-describedby')).toBe(table.getAttribute('aria-describedby'));
  });

  it('ties the mispricing banner to the segment table it is about', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, richAnalysis()));
    renderPanel();
    await screen.findByTestId('session-analysis');

    const table = screen.getByRole('table', { name: 'compaction segments' });
    const describedBy = table.getAttribute('aria-describedby') ?? '';
    expect(describedBy.length).toBeGreaterThan(0);
    const described = describedBy
      .split(' ')
      .filter((id) => id.length > 0)
      .map((id) => document.getElementById(id)?.textContent ?? '')
      .join(' ');
    expect(described).toContain('mispricing signal');
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

  it('retries a failed analysis for the same session and renders the result', async () => {
    // KK6. Clicking "analyse" again for the same session changes no selection
    // state, so without a retry of its own the error was terminal.
    fetchMock.mockResolvedValueOnce(jsonResponse(500, { error: 'Internal server error.' }));
    renderPanel();
    await screen.findByTestId('analysis-error');
    expect(fetchMock).toHaveBeenCalledTimes(1);

    fetchMock.mockResolvedValueOnce(jsonResponse(200, richAnalysis()));
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(screen.getByTestId('analysis-loading')).toBeTruthy();
    await screen.findByTestId('session-analysis');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1]?.[0]).toBe(fetchMock.mock.calls[0]?.[0]);
    expect(screen.queryByTestId('analysis-error')).toBeNull();
  });

  it('aborts a retried request on unmount', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(500, { error: 'Internal server error.' }));
    const { unmount } = renderPanel();
    await screen.findByTestId('analysis-error');

    const pending = deferred<Response>();
    fetchMock.mockReturnValueOnce(pending.promise);
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    const [, init] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect((init.signal as AbortSignal).aborted).toBe(false);
    unmount();
    expect((init.signal as AbortSignal).aborted).toBe(true);
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
