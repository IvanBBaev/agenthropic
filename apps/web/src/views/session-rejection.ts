/**
 * The sentence both per-session views render for a session ingest rejected.
 *
 * Owner decision (2026-10-01): a per-session read of a session the corpus HOLDS
 * but ingest rejected answers 409 with `code: 'quarantined' | 'ingest-failing'`
 * and a token-redacted, path-free reason (see `rejectionOf` in ../api). Before
 * that the same read answered 404 and the views said "Session not found." -
 * false, because the transcript is right there on disk.
 *
 * One helper, so SessionsView's tree pane and SessionCostAnalysis cannot drift
 * into two different accounts of the same fact. `retryable` is false for a
 * quarantined session: ingest stops re-reading it until its transcript or the
 * pricing table changes, so a Retry button would re-fetch the same refusal and
 * imply the click could change the outcome. A session ingest is still retrying
 * keeps its Retry - the next pass may well succeed.
 */
import type { ApiErrorReason } from '../api';

/** The fields of an `ApiResult` error arm this helper reads. */
export interface RejectionFields {
  readonly reason?: ApiErrorReason;
  readonly rejectionReason?: string;
}

export interface SessionRejectionText {
  readonly text: string;
  readonly retryable: boolean;
}

/** `undefined` when the failure is not an ingest rejection. */
export function sessionRejectionText(error: RejectionFields): SessionRejectionText | undefined {
  const detail = error.rejectionReason ?? 'no reason given';
  if (error.reason === 'quarantined') {
    return { text: `ingest quarantined this session: ${detail}`, retryable: false };
  }
  if (error.reason === 'ingest-failing') {
    return { text: `ingest is retrying this session: ${detail}`, retryable: true };
  }
  return undefined;
}
