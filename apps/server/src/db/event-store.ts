/**
 * WP-D4/WP-IN2 - SQLite adapter for the append-only EventStorePort.
 *
 * Idempotency lives in the storage engine: `INSERT OR IGNORE` against the
 * UNIQUE `idempotency_key`, so appending the same envelope twice yields
 * exactly one row - no read-then-write race.
 */
import type {
  AppendResult,
  EventStorePort,
  RawEventEnvelope,
  RawEventSource,
} from '@agenthropic/shared';
import type { Statement } from 'better-sqlite3';
import type { SqliteDatabase } from './connection';

interface EventRawDbRow {
  idempotency_key: string;
  source: RawEventSource;
  event_type: string;
  payload: string;
  received_at: string;
}

export class SqliteEventStore implements EventStorePort {
  private readonly insertStatement: Statement;
  private readonly readAllStatement: Statement;

  constructor(db: SqliteDatabase) {
    this.insertStatement = db.prepare(
      `INSERT OR IGNORE INTO events_raw (idempotency_key, source, event_type, payload, received_at)
       VALUES (@idempotency_key, @source, @event_type, @payload, @received_at)`,
    );
    this.readAllStatement = db.prepare(
      `SELECT idempotency_key, source, event_type, payload, received_at
       FROM events_raw ORDER BY id`,
    );
  }

  append(envelope: RawEventEnvelope): AppendResult {
    const info = this.insertStatement.run({
      idempotency_key: envelope.idempotencyKey,
      source: envelope.source,
      event_type: envelope.eventType,
      payload: JSON.stringify(envelope.payload),
      received_at: envelope.receivedAt,
    });
    return { inserted: info.changes === 1 };
  }

  readAll(): readonly RawEventEnvelope[] {
    const rows = this.readAllStatement.all() as EventRawDbRow[];
    return rows.map((row) => ({
      idempotencyKey: row.idempotency_key,
      source: row.source,
      eventType: row.event_type,
      payload: JSON.parse(row.payload) as unknown,
      receivedAt: row.received_at,
    }));
  }
}
