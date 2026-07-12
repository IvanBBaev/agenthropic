/**
 * WP-D1 - in-memory fake of {@link EventStorePort} for tests. Mirrors the
 * production adapter's idempotency semantics without touching a database.
 */
import type { AppendResult, EventStorePort, RawEventEnvelope } from '../ports/event-store';

export class InMemoryEventStore implements EventStorePort {
  private readonly envelopesByKey = new Map<string, RawEventEnvelope>();

  append(envelope: RawEventEnvelope): AppendResult {
    if (this.envelopesByKey.has(envelope.idempotencyKey)) {
      return { inserted: false };
    }
    this.envelopesByKey.set(envelope.idempotencyKey, envelope);
    return { inserted: true };
  }

  readAll(): readonly RawEventEnvelope[] {
    return [...this.envelopesByKey.values()];
  }
}
