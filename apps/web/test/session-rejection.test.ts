/**
 * The one sentence both per-session views use for a 409 "ingest rejected this
 * session" answer (owner decision 2026-10-01). The session EXISTS in the corpus,
 * so neither view may say "not found"; and a quarantined session is not retried
 * by ingest until its transcript or the pricing table changes, so a Retry button
 * beside it would promise something a click cannot deliver.
 */
import { describe, expect, it } from 'vitest';
import { sessionRejectionText } from '../src/views/session-rejection';

describe('sessionRejectionText', () => {
  it('names a quarantined session and offers no retry', () => {
    expect(
      sessionRejectionText({ reason: 'quarantined', rejectionReason: 'line 3 is not JSON' }),
    ).toEqual({ text: 'ingest quarantined this session: line 3 is not JSON', retryable: false });
  });

  it('names a session ingest is still retrying and allows a retry', () => {
    expect(
      sessionRejectionText({ reason: 'ingest-failing', rejectionReason: 'read failed' }),
    ).toEqual({ text: 'ingest is retrying this session: read failed', retryable: true });
  });

  it('says so when the reason is missing rather than ending the sentence on a colon', () => {
    expect(sessionRejectionText({ reason: 'quarantined' })?.text).toBe(
      'ingest quarantined this session: no reason given',
    );
  });

  it.each([{}, { reason: 'malformed-body' as const }])(
    'is undefined for a failure that is not an ingest rejection (%o)',
    (error) => {
      expect(sessionRejectionText(error)).toBeUndefined();
    },
  );
});
