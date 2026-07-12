/**
 * WP-D1 - storage port contract for the append-only raw event substrate.
 * Ports compile with no DB imports; adapters (SQLite, in-memory fake) live
 * elsewhere. Methods are synchronous because the production adapter is
 * better-sqlite3, which is synchronous by design.
 */
import type { RawEventSource } from '../types/rows';

/** A raw event as handed to the store, before normalization. */
export interface RawEventEnvelope {
  /** Idempotency key: appending the same key twice inserts once. */
  idempotencyKey: string;
  source: RawEventSource;
  eventType: string;
  /** Raw payload as received; the store persists it verbatim (JSON-encoded). */
  payload: unknown;
  /** ISO-8601 UTC timestamp of receipt. */
  receivedAt: string;
}

export interface AppendResult {
  /** False when the idempotency key was already present (no-op append). */
  inserted: boolean;
}

export interface EventStorePort {
  /** Append an envelope; idempotent by `idempotencyKey`. */
  append(envelope: RawEventEnvelope): AppendResult;
  /** Read all stored envelopes in append order. */
  readAll(): readonly RawEventEnvelope[];
}
