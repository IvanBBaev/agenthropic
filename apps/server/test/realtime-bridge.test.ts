import { describe, expect, it } from 'vitest';
import { Value } from '@sinclair/typebox/value';
import {
  AgentStatusChangedEventSchema,
  GenericRealtimeEventSchema,
  SessionIngestedEventSchema,
} from '@agenthropic/shared';
import type { AgentStatusChangedEvent, SessionIngestedEvent } from '../src/ingest/ingest-events';
import type { IngestFailureReport } from '../src/ingest/corpus-watcher';
import { toIngestFailureEvent, toRealtimeEvent } from '../src/realtime/bridge';

const STAMP = '2026-07-20T10:00:00.000Z';

/**
 * Which arms of the shared realtime union actually accept this event - named,
 * in a fixed order, and including the ones that must REJECT it.
 *
 * WHY THIS REPLACED `Value.Check(RealtimeEventSchema, event)` (WP-U14). That
 * assertion was very nearly a tautology on anything that lands on the generic
 * arm, because `GenericRealtimeEventSchema` accepts ANY `{type: string,
 * payload: object}`: it could not see one thing about the payload it was
 * nominally validating, and it sat inside the suite meant to catch exactly
 * this. Worse, it was applied ONLY to the event that lands on the catch-all -
 * the two events with real typed arms, where a union check has genuine bite
 * (`additionalProperties: false`, a literal `type`, integer minimums), were
 * asserted with `toEqual` alone and never met the shared schema at all. The
 * check had teeth everywhere it was not used.
 *
 * Naming the arm turns "some arm accepted it" into "exactly this arm accepted
 * it and the other two refused", which is a claim that can fail: loosen any
 * arm, or let a typed event decay onto the catch-all, and this goes red.
 */
function acceptingArms(event: unknown): string[] {
  return (
    [
      ['session-ingested', SessionIngestedEventSchema],
      ['agent-status-changed', AgentStatusChangedEventSchema],
      ['generic', GenericRealtimeEventSchema],
    ] as const
  )
    .filter(([, schema]) => Value.Check(schema, event))
    .map(([name]) => name);
}

describe('toRealtimeEvent (ingest -> shared realtime seam)', () => {
  it('maps session-ingested, renaming agentsUpserted -> agentCount and stamping occurredAt', () => {
    const ingest: SessionIngestedEvent = {
      type: 'session-ingested',
      sessionId: 'aaaaaaaa-1111-4111-8111-111111111111',
      projectSlug: '-Users-synthetic-project',
      agentsUpserted: 3,
      edgesInserted: 2,
      usageRowsInserted: 7,
      costUsd: 0.42,
    };
    expect(toRealtimeEvent(ingest, STAMP)).toEqual({
      type: 'session-ingested',
      sessionId: ingest.sessionId,
      projectSlug: ingest.projectSlug,
      agentCount: 3,
      edgesInserted: 2,
      usageRowsInserted: 7,
      costUsd: 0.42,
      occurredAt: STAMP,
    });
    // Typed arm, exclusively: a session-ingested event must NOT be able to
    // decay onto the generic catch-all, or the union stops discriminating.
    expect(acceptingArms(toRealtimeEvent(ingest, STAMP))).toEqual(['session-ingested']);
  });

  it('preserves a null costUsd (unpriced session) instead of coercing it', () => {
    const ingest: SessionIngestedEvent = {
      type: 'session-ingested',
      sessionId: 'bbbbbbbb-2222-4222-8222-222222222222',
      projectSlug: '-Users-synthetic-project',
      agentsUpserted: 1,
      edgesInserted: 0,
      usageRowsInserted: 0,
      costUsd: null,
    };
    expect(toRealtimeEvent(ingest, STAMP)).toMatchObject({ costUsd: null });
  });

  it('maps agent-status-changed, renaming old/new to previousStatus/status', () => {
    const ingest: AgentStatusChangedEvent = {
      type: 'agent-status-changed',
      agentId: 'agent-1',
      sessionId: 'cccccccc-3333-4333-8333-333333333333',
      oldStatus: 'working',
      newStatus: 'unknown',
    };
    expect(toRealtimeEvent(ingest, STAMP)).toEqual({
      type: 'agent-status-changed',
      sessionId: ingest.sessionId,
      agentId: 'agent-1',
      status: 'unknown',
      previousStatus: 'working',
      occurredAt: STAMP,
    });
    expect(acceptingArms(toRealtimeEvent(ingest, STAMP))).toEqual(['agent-status-changed']);
  });

  it('maps a NULL previous status (first observation) through unchanged', () => {
    const ingest: AgentStatusChangedEvent = {
      type: 'agent-status-changed',
      agentId: 'agent-2',
      sessionId: 'cccccccc-3333-4333-8333-333333333333',
      oldStatus: null,
      newStatus: 'unknown',
    };
    expect(toRealtimeEvent(ingest, STAMP)).toMatchObject({ previousStatus: null });
    // The mapping test above passes just as well against a schema that forbids
    // the null - `toMatchObject` never consults the schema. The arm assertion
    // is what pins `previousStatus` as genuinely nullable on the wire, which is
    // the whole point of a first observation having no previous status.
    expect(acceptingArms(toRealtimeEvent(ingest, STAMP))).toEqual(['agent-status-changed']);
  });
});

/**
 * WP-IN5 failure visibility. A session that fails to ingest used to be
 * discarded, so the dashboard silently showed nothing. The failure now travels
 * the same SSE transport as every other truth (CD-5), on the shared union's
 * generic arm - no shared-schema change, and the dashboard can render it.
 */
describe('toIngestFailureEvent (ingest failure -> SSE)', () => {
  const report: IngestFailureReport = {
    sessionId: 'dddddddd-4444-4444-8444-444444444444',
    reason: 'refusing to price at $0: unknown model id "unpriced-model-z"',
    attempt: 2,
    willRetry: true,
  };

  it('maps a failure report onto the generic arm, stamp inside the payload', () => {
    const event = toIngestFailureEvent(report, STAMP);
    expect(event).toEqual({
      type: 'ingest-failed',
      payload: {
        sessionId: report.sessionId,
        reason: report.reason,
        attempt: 2,
        willRetry: true,
        occurredAt: STAMP,
      },
    });
    // This event has no typed arm, so it must land on the catch-all and ONLY
    // there. That much is nearly free, which is why it is not asserted alone:
    expect(acceptingArms(event)).toEqual(['generic']);
    // ...the negative control is what gives the line above any weight. The one
    // thing the generic arm genuinely enforces is `additionalProperties: false`,
    // so hoisting `occurredAt` out of the payload must be refused by all three
    // arms. If any arm is ever loosened, this is the assertion that goes red.
    expect(acceptingArms({ ...event, occurredAt: STAMP })).toEqual([]);
  });

  it('carries the quarantine verdict and nothing about the substrate', () => {
    const event = toIngestFailureEvent({ ...report, attempt: 3, willRetry: false }, STAMP);
    expect(event.payload).toMatchObject({ attempt: 3, willRetry: false });
    expect(Object.keys(event.payload).sort()).toEqual([
      'attempt',
      'occurredAt',
      'reason',
      'sessionId',
      'willRetry',
    ]);
  });
});
