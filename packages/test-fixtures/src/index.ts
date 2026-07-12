/**
 * @agenthropic/test-fixtures - shared fixtures (synthetic JSONL transcripts,
 * hook payloads) for parser and ingest tests.
 *
 * The synthetic corpus under `src/fixtures/` covers the four structural join
 * paths of docs/analysis/parser-spec.md section 4 plus the N3 usage-dedup
 * case. All fixture content is invented; nothing is copied from real
 * transcripts.
 */
import type { RawEventEnvelope } from '@agenthropic/shared';

export {
  DUPLICATED_MESSAGE_ID,
  EVICTED_TOOL_USE_ID,
  FIXTURE_NAMES,
  QUEUED_TASK_ID,
  QUEUED_TOOL_USE_ID,
  TASK_ID,
  getFixture,
  listFixtures,
} from './fixtures/index.js';
export type { Fixture, FixtureFile, FixtureName } from './fixtures/index.js';

/** A minimal valid raw-event envelope for tests that just need one. */
export function makeRawEventEnvelope(overrides: Partial<RawEventEnvelope> = {}): RawEventEnvelope {
  return {
    idempotencyKey: 'fixture-key-1',
    source: 'hook',
    eventType: 'SessionStart',
    payload: { session_id: 'fixture-session-1' },
    receivedAt: '2026-07-11T00:00:00.000Z',
    ...overrides,
  };
}
