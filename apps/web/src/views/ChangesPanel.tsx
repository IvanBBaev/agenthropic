/**
 * D11(a) (2026-09-30): the "changed since" list on the Sessions view - the
 * dashboard reader of `GET /api/changes` (WP-U11, daily question Q5). Text
 * only, no new view and no new colour, in the same restraint as the D4
 * observed-outcomes list in the session tree.
 *
 * Four rules, each the panel-sized version of one the server already states:
 *
 * - NO DEFAULT REQUEST. The server has no default `since`, because a delta
 *   endpoint that invents its own lower bound answers a different question than
 *   the one asked. So nothing is fetched until the reader submits a day. The
 *   field is pre-filled with yesterday (UTC) as a convenience, but it is the
 *   reader's submit - not the mount - that asks the question.
 * - THE WINDOW IS SAID, AS SERVED. `interval`, `since`, `until` and `basis` are
 *   printed verbatim, including the event-time limitation, so the answer can
 *   never read as "everything since X" when it is "everything the database can
 *   date inside (since, until]".
 * - TOTALS ARE NOT THE PAGE. `totals` span the whole window and `sessions` is a
 *   capped page of it, so the slice is disclosed whenever `total` exceeds the
 *   rows served, and a count that contradicts the rows is named as such.
 * - WHAT NO WINDOW CAN SEE IS COUNTED. The residue of tokens outside any changed
 *   session and the undated rows in `coverage` are disclosed when non-zero, so
 *   neither a per-row sum that falls short nor an absent session reads as a
 *   complete answer.
 */
import { useEffect, useState, type FormEvent } from 'react';
import { fetchChanges } from '../api';
import { readNowMs } from '../clock';
import type { ChangesDto } from '../dto';
import {
  formatTokens,
  formatUsd,
  impossibleCountText,
  isImpossibleCount,
  nameOrBlank,
  projectLabel,
  quoteRawValue,
  shortId,
} from '../format';
import { snapshotAge } from './snapshot';
import { UNRECOGNISED_STATUS_LABEL } from './status';
import { UnpricedNote } from './unpriced';

/** Page size requested from `/api/changes` (the server's own default, made explicit). */
export const CHANGES_LIMIT = 50;

const DAY_MS = 86_400_000;

/** Parenthetical naming a row that carried no `change` field at all. */
export const ABSENT_CHANGE_REASON = 'no change word sent';

/**
 * WEB-5 (2026-10-10): the clock the window is over, or the fact that none was
 * named. `basis` was interpolated bare and the DTO guard does not require it
 * (it checks containers and load-bearing numbers, not labels), so an answer
 * without it read "over : the end is ...".
 *
 * W-2 (2026-10-12): a present-but-blank basis (`''`, whitespace) passed the
 * typeof check and was interpolated bare - the same "over : the end is" the
 * paragraph above was written to remove. `nameOrBlank` quotes the blank the
 * way every other served name on these pages is quoted.
 */
export const ABSENT_BASIS_REASON = 'no basis sent';
export function basisText(basis: unknown): string {
  if (typeof basis !== 'string') return `an unstated clock (${ABSENT_BASIS_REASON})`;
  return nameOrBlank(basis, 'basis');
}

const CHANGE_KINDS: readonly string[] = ['new', 'updated', 'unknown'];

/**
 * How a session's `change` renders. A known kind is printed VERBATIM - `unknown`
 * included, which the schema makes a first-class answer (the session's start
 * could not be read) and which must not be folded into `updated`. An
 * unrecognised word is quoted back; a value that is not a word at all says the
 * field did not arrive. Same funnel as `outcomeCauseText` in SessionsView.
 */
export function changeKindText(change: unknown): string {
  if (typeof change !== 'string') return `${UNRECOGNISED_STATUS_LABEL} (${ABSENT_CHANGE_REASON})`;
  return CHANGE_KINDS.includes(change)
    ? change
    : `${UNRECOGNISED_STATUS_LABEL} (${quoteRawValue(change)})`;
}

/** The UTC calendar day before `nowMs`, as `YYYY-MM-DD` - the field's initial value only. */
export function previousUtcDay(nowMs: number): string {
  return new Date(nowMs - DAY_MS).toISOString().slice(0, 10);
}

function plural(count: number, noun: string): string {
  return `${String(count)} ${noun}${count === 1 ? '' : 's'}`;
}

type ChangesState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'loading' }
  | { readonly kind: 'error'; readonly message: string; readonly since: string }
  | { readonly kind: 'ready'; readonly data: ChangesDto; readonly fetchedAtMs: number };

/** A submitted question; `attempt` lets the same `since` be asked again. */
interface ChangesQuery {
  readonly since: string;
  readonly attempt: number;
}

function ChangesResult({
  data,
  fetchedAtMs,
  nowMs,
}: {
  readonly data: ChangesDto;
  readonly fetchedAtMs: number;
  readonly nowMs: number;
}) {
  const { totals, coverage, sessions, total } = data;
  const age = snapshotAge(fetchedAtMs, nowMs);
  const undated = coverage.undatedSessions + coverage.undatedAgents + coverage.undatedUsageRows;
  return (
    <div data-testid="changes-result">
      <p className="muted card-provenance" data-testid="changes-window">
        Changes read {age.label}. Window {data.interval} = ({data.since}, {data.until}] over{' '}
        {basisText(data.basis)}: the end is the newest instant the database can date, not the moment
        of this read. A session whose activity predates the start but that was ingested afterwards
        is not in it.
      </p>
      <p className="muted" data-testid="changes-totals">
        {plural(total, 'session')} changed in the whole window: {totals.sessionsNew} new,{' '}
        {totals.sessionsUpdated} updated, {totals.sessionsUnknownStart} unknown (start unreadable,
        so whether it is new cannot be said). {plural(totals.agentsAppeared, 'agent')} appeared;{' '}
        {formatTokens(totals.tokensAdded)} tokens · {formatUsd(totals.costAddedUsd)} added
        <UnpricedNote tokens={totals.unpricedTokensAdded} lead=" · " />.
      </p>
      {/* WEB-5 (2026-10-10): both `> 0` gates below are false of NaN and of a
          negative exactly as of a measured zero, so an unreadable residue read
          as "the rows add up" and an unreadable undated count as "every row is
          dated". Each impossible count is now its own arm with its own words. */}
      {isImpossibleCount(totals.tokensAddedOutsideChangedSessions) ? (
        <p className="muted" data-testid="changes-residue">
          The count of tokens used outside every changed session came back as{' '}
          {impossibleCountText(totals.tokensAddedOutsideChangedSessions)}, so whether the rows below
          add up to the total cannot be said.
        </p>
      ) : totals.tokensAddedOutsideChangedSessions > 0 ? (
        <p className="muted" data-testid="changes-residue">
          {formatTokens(totals.tokensAddedOutsideChangedSessions)} of those tokens were used in
          sessions whose own last activity falls outside this window, so the rows below do not add
          up to the total.
        </p>
      ) : null}
      {[coverage.undatedSessions, coverage.undatedAgents, coverage.undatedUsageRows].some(
        isImpossibleCount,
      ) ? (
        <p className="muted" data-testid="changes-coverage">
          Outside every window: {plural(coverage.undatedSessions, 'session')},{' '}
          {plural(coverage.undatedAgents, 'agent')} and{' '}
          {plural(coverage.undatedUsageRows, 'usage row')} - at least one of these counts came back
          unreadable or below zero, so how much of the corpus no &quot;changed since&quot; answer
          can include is unknown.
        </p>
      ) : undated > 0 ? (
        <p className="muted" data-testid="changes-coverage">
          Outside every window: {plural(coverage.undatedSessions, 'session')},{' '}
          {plural(coverage.undatedAgents, 'agent')} and{' '}
          {plural(coverage.undatedUsageRows, 'usage row')} carry no usable timestamp, so no
          &quot;changed since&quot; answer can include them.
        </p>
      ) : null}
      {!Number.isFinite(total) ? (
        <p className="muted" data-testid="changes-truncation-unknown">
          The changed-session count served with this list came back unreadable, so whether these
          rows are the whole window or its newest slice is unknown.
        </p>
      ) : total > sessions.length ? (
        <p className="muted" data-testid="changes-truncation">
          Showing {sessions.length} of {total} changed sessions - most recent change first, so the
          rest changed earlier in the window. The totals above cover all {total}.
        </p>
      ) : total < sessions.length ? (
        <p className="muted" data-testid="changes-count-disagreement">
          These {sessions.length} rows outnumber the {total} changed sessions the same read counts,
          so the served rows and the served count disagree - neither figure describes this list on
          its own.
        </p>
      ) : null}
      {sessions.length === 0 ? (
        <p className="empty-state" data-testid="changes-empty">
          No session this database can date changed in this window.
        </p>
      ) : (
        <ul className="muted" aria-label="changed sessions">
          {sessions.map((session) => (
            <li key={session.id}>
              <code>{shortId(session.id)}</code> {projectLabel(session.projectSlug)} -{' '}
              {changeKindText(session.change)} at {session.changedAt} ·{' '}
              {plural(session.agentsAppeared, 'agent')} appeared ·{' '}
              {formatTokens(session.tokensAdded)} tokens · {formatUsd(session.costAddedUsd)} added
              <UnpricedNote tokens={session.unpricedTokensAdded} lead=" · " />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function ChangesPanel({
  token,
  nowMs,
  onAuthRejected,
}: {
  readonly token: string;
  readonly nowMs: number;
  readonly onAuthRejected: () => void;
}) {
  const [draft, setDraft] = useState(() => previousUtcDay(readNowMs()));
  const [query, setQuery] = useState<ChangesQuery | null>(null);
  const [state, setState] = useState<ChangesState>({ kind: 'idle' });

  useEffect(() => {
    if (query === null) return;
    const controller = new AbortController();
    setState({ kind: 'loading' });
    void fetchChanges(token, query.since, { limit: CHANGES_LIMIT }, controller.signal).then(
      (result) => {
        if (controller.signal.aborted) return;
        if (result.kind === 'unauthorized') {
          onAuthRejected();
        } else if (result.kind === 'error') {
          setState({ kind: 'error', message: result.message, since: query.since });
        } else {
          setState({ kind: 'ready', data: result.data, fetchedAtMs: readNowMs() });
        }
      },
    );
    return () => controller.abort();
  }, [token, query, onAuthRejected]);

  const ask = (since: string) =>
    setQuery((previous) => ({ since, attempt: (previous?.attempt ?? 0) + 1 }));
  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    ask(draft);
  };

  return (
    <div data-testid="changes-panel">
      <form onSubmit={onSubmit} aria-label="changed since">
        <label>
          Changed since (UTC day){' '}
          <input
            type="date"
            required
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
          />
        </label>{' '}
        <button type="submit" disabled={draft === ''}>
          Show changes
        </button>
      </form>
      {state.kind === 'idle' && (
        <p className="empty-state" data-testid="changes-prompt">
          Pick a day and choose “Show changes” to list the sessions that changed after its start.
          Nothing is read until you do.
        </p>
      )}
      {state.kind === 'loading' && <p className="muted">Loading changes…</p>}
      {state.kind === 'error' && (
        <>
          <p className="empty-state">
            <span className="status-error">✕</span> Could not load changes: {state.message}
          </p>
          <button type="button" onClick={() => ask(state.since)}>
            Retry changes
          </button>
        </>
      )}
      {state.kind === 'ready' && (
        <ChangesResult data={state.data} fetchedAtMs={state.fetchedAtMs} nowMs={nowMs} />
      )}
    </div>
  );
}
