/**
 * WP-U1 - RealtimeHub: a typed in-process pub/sub that fans published events
 * out to every subscribed SSE connection as ready-to-write frames.
 *
 * The hub knows nothing about Fastify or sockets - a subscriber is just a
 * frame-writer callback, which keeps the hub unit-testable and lets the
 * /api/stream route (and tests) plug in trivially. Transport stays SSE per
 * CD-5; this hub is the only fan-out point.
 */
import { randomBytes } from 'node:crypto';
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
 *   id: <bootId>-<n>\nevent: <type>\ndata: <one-line json>\n\n
 *
 * The id is the hub's boot id and the frame's sequence number (ARC-7, see
 * {@link formatFrameId}).
 *
 * `JSON.stringify` never emits raw newlines (they are escaped as \n inside
 * strings), so `data:` is always a single line. The `event:` field is the
 * event's `type`. The union is closed - three literal types, no generic arm
 * since 2026-09-09 - so a well-typed publisher can never hand over a CR/LF
 * here; the collapse to a space stays as defence in depth, so that even a
 * hostile string could not inject extra SSE fields.
 */
export function serializeSseFrame(event: RealtimeEvent, id: string): string {
  const eventName = event.type.replace(/[\r\n]+/g, ' ');
  return `id: ${id}\nevent: ${eventName}\ndata: ${JSON.stringify(event)}\n\n`;
}

/**
 * ARC-7 (2026-11-19). A boot id: lowercase letters and digits, at most 16.
 * Nothing else may appear in one, so it can never carry a CR/LF into the
 * `id:` line, and the `-` that separates it from the sequence is unambiguous.
 */
const BOOT_ID_PATTERN = /^[0-9a-z]{1,16}$/;

/**
 * The frame id the hub writes: `<bootId>-<seq>`. The sequence restarts at 1
 * with every process; the boot id is what tells one process's numbering from
 * the next one's.
 */
export function formatFrameId(bootId: string, seq: number): string {
  return `${bootId}-${String(seq)}`;
}

/**
 * Where a reconnecting client says it stopped: the boot id and sequence of the
 * last frame it received. `bootId` is null for a bare decimal id, which is
 * what a server before ARC-7 issued - a client holding one is resuming across
 * an upgrade, so it is always a different process.
 */
export interface ResumePoint {
  readonly bootId: string | null;
  readonly seq: number;
}

/**
 * The `Last-Event-ID` request header as a resume point, or undefined when it
 * is absent, repeated, or not an id any version of the hub could have issued.
 * An unreadable header replays nothing: it is not evidence of a reconnect.
 */
export function parseLastEventId(header: string | string[] | undefined): ResumePoint | undefined {
  if (typeof header !== 'string') return undefined;
  if (/^\d{1,15}$/.test(header)) return { bootId: null, seq: Number(header) };
  const match = /^([0-9a-z]{1,16})-(\d{1,15})$/.exec(header);
  if (match === null) return undefined;
  return { bootId: match[1] as string, seq: Number(match[2]) };
}

/** A fresh boot id: 48 random bits as 12 hex digits. */
export function newBootId(): string {
  return randomBytes(6).toString('hex');
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
  /**
   * This process's boot id (ARC-7); a fresh random one when omitted. Tests pin
   * it so frame ids are predictable.
   */
  readonly bootId?: string;
}

export class RealtimeHub {
  private readonly subscribers = new Set<SseFrameWriter>();
  private nextSeq = 1;
  private dropped = 0;
  private readonly replayCapacity: number;
  /** Identifies this process's frame numbering (ARC-7). */
  readonly bootId: string;
  /** The most recent frames, oldest first; never longer than `replayCapacity`. */
  private readonly recent: Array<{ readonly seq: number; readonly frame: string }> = [];

  constructor(options: RealtimeHubOptions = {}) {
    const capacity = options.replayCapacity ?? DEFAULT_REPLAY_CAPACITY;
    if (!Number.isInteger(capacity) || capacity < 0) {
      throw new RangeError(
        `replayCapacity must be a non-negative integer (got ${String(capacity)})`,
      );
    }
    this.replayCapacity = capacity;
    const bootId = options.bootId ?? newBootId();
    if (!BOOT_ID_PATTERN.test(bootId)) {
      throw new RangeError(
        `bootId must be 1-16 lowercase letters or digits (got ${JSON.stringify(bootId)})`,
      );
    }
    this.bootId = bootId;
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
   * `resume` is the client's `Last-Event-ID` (WP-U1 resumption): buffered
   * frames are written to the new subscriber first, in order, before it joins
   * live fan-out. Both happen in this one synchronous call, so no publish can
   * land between the replay and the join - nothing is sent twice and nothing
   * falls in between.
   *
   * Which frames are replayed depends on whose id it is (ARC-7, 2026-11-19).
   * An id of THIS process replays the frames after it. An id of another
   * process - an earlier boot, or a bare number from a server before ARC-7 -
   * means the client has seen none of this process's frames, so the whole
   * buffer is replayed. Ids used to restart at 1 with nothing to say which
   * process issued them, so an old id that fell inside this process's range
   * silently skipped the frames before it.
   */
  subscribe(writer: SseFrameWriter, resume?: ResumePoint): () => void {
    if (resume !== undefined) {
      const after = resume.bootId === this.bootId ? resume.seq : 0;
      try {
        for (const { seq, frame } of this.recent) {
          if (seq > after) writer(frame);
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
   * Publish one event to every subscriber and return the sequence number it
   * was sent with (the frame id is `formatFrameId(bootId, seq)`). A writer that throws is dropped - one dead connection must never
   * break fan-out to the healthy ones - and counted in
   * {@link RealtimeHub.droppedSubscribers}.
   */
  publish(event: RealtimeEvent): number {
    const seq = this.nextSeq;
    this.nextSeq += 1;
    const frame = serializeSseFrame(event, formatFrameId(this.bootId, seq));
    if (this.replayCapacity > 0) {
      this.recent.push({ seq, frame });
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
    return seq;
  }
}
