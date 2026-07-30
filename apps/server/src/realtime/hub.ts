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
  GenericRealtimeEvent,
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
 * event's `type`; any CR/LF in a (generic) type is collapsed to a space so a
 * hostile type string cannot inject extra SSE fields.
 */
export function serializeSseFrame(event: RealtimeEvent, id: number): string {
  const eventName = event.type.replace(/[\r\n]+/g, ' ');
  return `id: ${String(id)}\nevent: ${eventName}\ndata: ${JSON.stringify(event)}\n\n`;
}

export class RealtimeHub {
  private readonly subscribers = new Set<SseFrameWriter>();
  private nextId = 1;

  /** Number of currently subscribed writers (observability + tests). */
  get subscriberCount(): number {
    return this.subscribers.size;
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
   * break fan-out to the healthy ones.
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
      }
    }
    return id;
  }
}
