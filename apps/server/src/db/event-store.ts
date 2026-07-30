/**
 * WP-D4/WP-IN2 - SQLite adapter for the append-only EventStorePort.
 *
 * Idempotency lives in the storage engine: `INSERT OR IGNORE` against the
 * UNIQUE `idempotency_key`, so appending the same envelope twice yields
 * exactly one row - no read-then-write race.
 *
 * WP-D5 - the `events` projection. When (and only when) a HOOK envelope
 * actually lands in `events_raw` (`changes === 1`), one normalized row is
 * written to `events` in the SAME transaction, pointing back at the raw row.
 * A duplicate delivery therefore inserts zero rows in BOTH tables.
 *
 * The projection is a LIVENESS timeline and nothing else - hooks contribute
 * liveness only, NEVER structure. Nothing here writes to or joins into the
 * DAG (`agents`, `orchestration_edges`) or `token_usage`; tokens stay ground
 * truth from JSONL. Only the identifiers below are projected - never the
 * payload body, so no secrets and no free text leave `events_raw`.
 *
 * `occurred_at` rule: the WP-IN1 envelope contract (hooks/envelope.ts)
 * exposes no event-originated timestamp - Claude Code hook stdin JSON
 * carries none and redaction (hooks/redact.ts) adds none - so receipt time
 * (`envelope.receivedAt`) is the only honest time available and is what the
 * projection stores. The read DTO surfaces this as
 * `occurredAtSource: 'receipt'` so no consumer mistakes it for event time.
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

/** The identifiers the WP-D5 projection lifts out of a hook payload. */
export interface LivenessIds {
  readonly sessionId: string | null;
  readonly agentId: string | null;
}

function readIdField(record: Record<string, unknown>, keys: readonly string[]): string | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.length > 0) {
      return value;
    }
  }
  return null;
}

/**
 * Total, defensive extraction of the liveness identifiers from an arbitrary
 * hook payload. The receiver deliberately accepts ANY body shape (WP-IN3
 * accept-any-event), so this never throws. Rules:
 *
 *  - only a plain object payload can carry ids; `null`, arrays and
 *    primitives yield NULLs - an unrecognized shape honestly projects as
 *    "no id" while the raw payload stays queryable in `events_raw`;
 *  - `session_id` / `agent_id` (Claude Code hook stdin naming) win over the
 *    camelCase courtesy variants `sessionId` / `agentId` - the same
 *    precedence buildHookEnvelope uses;
 *  - only NON-EMPTY STRING values count. Numbers, booleans, objects, arrays
 *    and '' yield NULL - ids are never silently coerced to strings.
 */
export function extractLivenessIds(payload: unknown): LivenessIds {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    return { sessionId: null, agentId: null };
  }
  const record = payload as Record<string, unknown>;
  return {
    sessionId: readIdField(record, ['session_id', 'sessionId']),
    agentId: readIdField(record, ['agent_id', 'agentId']),
  };
}

export class SqliteEventStore implements EventStorePort {
  private readonly insertStatement: Statement;
  private readonly insertEventStatement: Statement;
  private readonly readAllStatement: Statement;
  private readonly appendInTransaction: (envelope: RawEventEnvelope) => AppendResult;

  constructor(db: SqliteDatabase) {
    this.insertStatement = db.prepare(
      `INSERT OR IGNORE INTO events_raw (idempotency_key, source, event_type, payload, received_at)
       VALUES (@idempotency_key, @source, @event_type, @payload, @received_at)`,
    );
    this.insertEventStatement = db.prepare(
      `INSERT INTO events (raw_event_id, session_id, agent_id, event_type, occurred_at)
       VALUES (@raw_event_id, @session_id, @agent_id, @event_type, @occurred_at)`,
    );
    this.readAllStatement = db.prepare(
      `SELECT idempotency_key, source, event_type, payload, received_at
       FROM events_raw ORDER BY id`,
    );
    // One transaction for raw append + projection: either both rows land or
    // neither does - `events` can never disagree with `events_raw`.
    this.appendInTransaction = db.transaction((envelope: RawEventEnvelope): AppendResult => {
      const info = this.insertStatement.run({
        idempotency_key: envelope.idempotencyKey,
        source: envelope.source,
        event_type: envelope.eventType,
        payload: JSON.stringify(envelope.payload),
        received_at: envelope.receivedAt,
      });
      if (info.changes !== 1) {
        // Duplicate idempotency key: zero new rows in BOTH tables.
        return { inserted: false };
      }
      if (envelope.source === 'hook') {
        // `events` is the HOOK liveness timeline only; a non-hook envelope
        // (the schema also admits 'jsonl') is stored raw but never projected
        // here - JSONL is ingested through its own pipeline, not this one.
        const ids = extractLivenessIds(envelope.payload);
        this.insertEventStatement.run({
          raw_event_id: info.lastInsertRowid,
          session_id: ids.sessionId,
          agent_id: ids.agentId,
          event_type: envelope.eventType,
          occurred_at: envelope.receivedAt,
        });
      }
      return { inserted: true };
    });
  }

  append(envelope: RawEventEnvelope): AppendResult {
    return this.appendInTransaction(envelope);
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
