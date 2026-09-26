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

export class RealtimeHub {
  private readonly subscribers = new Set<SseFrameWriter>();
  private nextId = 1;
  private dropped = 0;

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
   */
  subscribe(writer: SseFrameWriter): () => void {
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
