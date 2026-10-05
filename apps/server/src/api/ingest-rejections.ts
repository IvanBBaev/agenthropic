/**
 * The HTTP side of an ingest rejection: a per-session read of a session the
 * corpus holds but ingest refused answers 409, not 404 - owner decision,
 * 2026-10-01.
 *
 * WHICH sessions are rejected is not tracked here: the watcher answers that
 * itself (`CorpusWatcher.rejectionOf`), straight off its retry budget, so the
 * verdict follows every transition the budget makes - success, a pricing
 * change re-admitting every session, a pruned file or root - with nothing to
 * keep in step. This module only turns a rejection into a response body:
 * sanitized again at the boundary, errno codes moved to the log.
 */
import { constants } from 'node:os';
import type { SessionRejectedErrorDto } from '@agenthropic/shared';
import { sanitizeFailureReason, type IngestRejection } from '../ingest/corpus-watcher';

export type { IngestRejection } from '../ingest/corpus-watcher';

/**
 * Every errno name this platform knows (`EACCES`, `ENOENT`, ...) - a closed
 * list, so an ordinary upper-case word such as `ERROR` or `EOF` is never
 * mistaken for one.
 */
const ERRNO_PATTERN = new RegExp(`\\b(${Object.keys(constants.errno).join('|')})\\b:?\\s*`, 'g');

/**
 * Split a failure reason into the part a response body may carry and the
 * errno codes that belong in the server log only - the same division the 503
 * `session-unreadable` arm of the cost-analysis route makes.
 */
export function splitErrno(reason: string): { text: string; errno: string[] } {
  const errno: string[] = [];
  const text = reason
    .replace(ERRNO_PATTERN, (_match, code: string) => {
      errno.push(code);
      return '';
    })
    .trim();
  return { text: text === '' ? 'I/O failure (see the server log)' : text, errno };
}

/** The 409 body for one rejected session. `reason` must already be errno-free. */
export function rejectionBody(rejection: IngestRejection): SessionRejectedErrorDto {
  const error =
    rejection.code === 'quarantined'
      ? 'The corpus holds this session, but ingest rejected it and has stopped retrying ' +
        '(quarantined): it is re-read when its transcript changes, or at once when the ' +
        `pricing table does. Reason: ${rejection.reason}`
      : 'The corpus holds this session, but its latest ingest failed; it will be retried on ' +
        `the next pass. Reason: ${rejection.reason}`;
  return { error, code: rejection.code, reason: rejection.reason };
}

/**
 * The 409 body for `rejection` plus the errno codes its reason carried, which
 * belong in the server log only. The watcher already sanitized the reason; it
 * is sanitized again here because this string is about to cross the HTTP
 * boundary, and the function is idempotent.
 */
export function rejectionResponse(rejection: IngestRejection): {
  body: SessionRejectedErrorDto;
  errno: string[];
} {
  const { text, errno } = splitErrno(sanitizeFailureReason(rejection.reason));
  return { body: rejectionBody({ code: rejection.code, reason: text }), errno };
}
