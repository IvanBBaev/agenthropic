/**
 * WP-U1 - RealtimeHub: a typed in-process pub/sub that fans published events
 * out to every subscribed SSE connection as ready-to-write frames.
 *
 * The hub knows nothing about Fastify or sockets - a subscriber is just a
 * frame-writer callback, which keeps the hub unit-testable and lets the
 * /api/stream route (and tests) plug in trivially. Transport stays SSE per
 * CD-5; this hub is the only fan-out point.
 */
import type { RealtimeEvent } from '@agenthropic/shared';

export type {
  RealtimeEvent,
  SessionIngestedEvent,
  AgentStatusChangedEvent,
  IngestFailedEvent,
} from '@agenthropic/shared';

/** A subscriber: receives one fully serialized SSE frame per published event. */
export type SseFrameWriter = (frame: string) => void;

/**
 * Serialize one event into an SSE frame:
 *
 *   id: <n>\nevent: <type>\ndata: <one-line json>\n\n
 *
 * `JSON.stringify` never emits raw newlines (they are escaped as \n inside
 * strings), so `data:` is always a single line. The `event:` field is the
 * event's `type`. The union is closed - three literal types, no generic arm
 * since 2026-09-09 - so a well-typed publisher can never hand over a CR/LF
 * here; the collapse to a space stays as defence in depth, so that even a
 * hostile string could not inject extra SSE fields.
 */
export function serializeSseFrame(event: RealtimeEvent, id: number): string {
  const eventName = event.type.replace(/[\r\n]+/g, ' ');
  return `id: ${String(id)}\nevent: ${eventName}\ndata: ${JSON.stringify(event)}\n\n`;
}

/**
 * How many recent frames the hub keeps for resumption (WP-U1 "resumable",
 * added 2026-09-26). Frames are small - one agent-status change or ingest
 * notice each - so this bounds memory at a few hundred KiB while covering any
 * ordinary reconnect gap (EventSource retries within seconds). A client that
 * was gone for longer than the buffer reaches is replayed what is left and sees
 * the rest as an id gap, which the dashboard already counts and discloses.
 */
export const DEFAULT_REPLAY_CAPACITY = 256;

export interface RealtimeHubOptions {
  /** Frames kept for `Last-Event-ID` replay; 0 disables replay. */
  readonly replayCapacity?: number;
}

export class RealtimeHub {
  private readonly subscribers = new Set<SseFrameWriter>();
  private nextId = 1;
  private dropped = 0;
  private readonly replayCapacity: number;
  /** The most recent frames, oldest first; never longer than `replayCapacity`. */
  private readonly recent: Array<{ readonly id: number; readonly frame: string }> = [];

  constructor(options: RealtimeHubOptions = {}) {
    const capacity = options.replayCapacity ?? DEFAULT_REPLAY_CAPACITY;
    if (!Number.isInteger(capacity) || capacity < 0) {
      throw new RangeError(
        `replayCapacity must be a non-negative integer (got ${String(capacity)})`,
      );
    }
    this.replayCapacity = capacity;
  }

  /** Number of currently subscribed writers (observability + tests). */
  get subscriberCount(): number {
    return this.subscribers.size;
  }

  /**
   * Cumulative number of writers dropped because they threw during a publish
   * (an ordinary unsubscribe is not a drop). Keeps the drop observable instead
   * of silent; it is not part of any served payload.
   */
  get droppedSubscribers(): number {
    return this.dropped;
  }

  /**
   * Register a writer; returns an idempotent unsubscribe function. The stream
   * route calls it from its close handler.
   *
   * `afterId` is the client's `Last-Event-ID` (WP-U1 resumption): every buffered
   * frame with a larger id is written to the new subscriber first, in order,
   * before it joins live fan-out. Both happen in this one synchronous call, so
   * no publish can land between the replay and the join - nothing is sent twice
   * and nothing falls in between.
   *
   * Known limit, stated rather than hidden: ids restart at 1 with the process,
   * and nothing in an id says which process issued it. An id from before a
   * restart that is beyond this hub's newest replays nothing (no buffered frame
   * is larger), which is right. One that falls INSIDE this process's range
   * cannot be told apart from a genuine one, so the client is replayed the
   * frames after it and silently misses the earlier ones of this process - the
   * same loss a reconnect across a restart always had, and one the dashboard's
   * reload-on-reconnect refetch repairs.
   */
  subscribe(writer: SseFrameWriter, afterId?: number): () => void {
    if (afterId !== undefined) {
      try {
        for (const { id, frame } of this.recent) {
          if (id > afterId) writer(frame);
        }
      } catch {
        // Same rule as publish: a writer that throws is dropped and counted.
        // It never joins, so there is nothing for the caller to unsubscribe.
        this.dropped += 1;
        return () => {};
      }
    }
    this.subscribers.add(writer);
    return () => {
      this.subscribers.delete(writer);
    };
  }

  /**
   * Publish one event to every subscriber and return the frame id it was sent
   * with. A writer that throws is dropped - one dead connection must never
   * break fan-out to the healthy ones - and counted in
   * {@link RealtimeHub.droppedSubscribers}.
   */
  publish(event: RealtimeEvent): number {
    const id = this.nextId;
    this.nextId += 1;
    const frame = serializeSseFrame(event, id);
    if (this.replayCapacity > 0) {
      this.recent.push({ id, frame });
      if (this.recent.length > this.replayCapacity) this.recent.shift();
    }
    for (const writer of [...this.subscribers]) {
      try {
        writer(frame);
      } catch {
        this.subscribers.delete(writer);
        this.dropped += 1;
      }
    }
    return id;
  }
}
