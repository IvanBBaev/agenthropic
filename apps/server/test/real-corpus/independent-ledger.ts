/**
 * R17 / QA-2 — the independent expected side of the real-corpus P0-1
 * reconciliation.
 *
 * A live `~/.claude/projects` keeps growing while a multi-minute ingest runs, so
 * re-reading the files after the ingest would compare the database against
 * DIFFERENT bytes. Instead a tapping {@link CorpusFs} wraps the production port
 * and runs this module's own reader over EXACTLY the content each
 * `readFileConfined` call handed to the ingest. The reader is still independent
 * of the production parser: its own line split, its own path rules and the
 * spec-normative usage rules of `../p0/raw-usage.ts`.
 *
 * Nothing but counts and message ids is kept: the file content is dropped as
 * soon as its usage partials are extracted.
 */
import { relative, sep } from 'node:path';
import type { CorpusFs } from '../../src/index';
import {
  asRecord,
  mergeUsagePartial,
  usageOfRawRecord,
  type RawUsagePartial,
} from '../p0/raw-usage';

/** Strict Claude Code session id (the `<uuid>.jsonl` stem). */
const SESSION_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** Parser-spec section 2: a subagent transcript is `agent-<hex>.jsonl`, at any depth. */
const AGENT_TRANSCRIPT_RE = /^agent-([0-9a-f]+)\.jsonl$/;

/** The usage one transcript file carried, already deduped within the file. */
export interface TappedTranscript {
  readonly sessionId: string;
  /** The agent the file belongs to: the session id for a main, the hex for a subagent. */
  readonly owner: string;
  readonly messages: Map<string, RawUsagePartial>;
  /** Raw usage lines before dedup — proves the dedup rule is load-bearing. */
  readonly usageLines: number;
}

/** One message of one session after the session-wide dedup. */
export interface ExpectedMessage {
  readonly usage: RawUsagePartial;
  /** Every transcript of the session that carried the message id. */
  readonly owners: Set<string>;
}

/**
 * Where a transcript sits in the Claude Code projects layout, or null for a
 * file that is not a transcript (`journal.jsonl`, `*.meta.json`, anything else).
 */
function transcriptIdentity(
  corpusRoot: string,
  absPath: string,
): { sessionId: string; owner: string } | null {
  const parts = relative(corpusRoot, absPath).split(sep);
  const basename = parts[parts.length - 1] ?? '';
  if (parts.length === 2 && basename.endsWith('.jsonl')) {
    const sessionId = basename.slice(0, -'.jsonl'.length);
    return SESSION_UUID_RE.test(sessionId) ? { sessionId, owner: sessionId } : null;
  }
  const hex = AGENT_TRANSCRIPT_RE.exec(basename)?.[1];
  const sessionId = parts[1];
  if (parts.length > 2 && hex !== undefined && sessionId !== undefined) {
    return SESSION_UUID_RE.test(sessionId) ? { sessionId, owner: hex } : null;
  }
  return null;
}

/** Reads one transcript's content the way the spec defines it, independently of the adapter. */
function readTranscript(content: string): {
  messages: Map<string, RawUsagePartial>;
  usageLines: number;
} {
  const messages = new Map<string, RawUsagePartial>();
  let usageLines = 0;
  const lines = content.split('\n');
  // The segment after the last newline is an unterminated live append (or the
  // empty string after a final newline): never a complete record.
  lines.pop();
  for (const line of lines) {
    // A cheap prefilter: a usage row always spells the key out literally.
    if (!line.includes('"usage"')) {
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue; // a malformed line is skipped, never fatal (parser-spec section 3)
    }
    const usage = usageOfRawRecord(asRecord(parsed));
    if (usage === null) {
      continue;
    }
    usageLines += 1;
    const existing = messages.get(usage.messageId);
    if (existing === undefined) {
      messages.set(usage.messageId, usage.partial);
    } else {
      mergeUsagePartial(existing, usage.partial);
    }
  }
  return { messages, usageLines };
}

/**
 * Wraps `inner` so every transcript the ingest reads is also read by the
 * independent reader. Keyed by absolute path: a file read twice keeps its last
 * read, which is the content the ingest acted on.
 */
export function tappingCorpusFs(
  inner: CorpusFs,
  corpusRoot: string,
  sink: Map<string, TappedTranscript>,
): CorpusFs {
  return {
    readDirNames: (absDir) => inner.readDirNames(absDir),
    lstat: (absPath) => inner.lstat(absPath),
    realpath: (absPath) => inner.realpath(absPath),
    readFileTailConfined: (absPath, fromByte, maxBytes) =>
      inner.readFileTailConfined(absPath, fromByte, maxBytes),
    readFileConfined: (absPath, maxBytes) => {
      const content = inner.readFileConfined(absPath, maxBytes);
      const identity = transcriptIdentity(corpusRoot, absPath);
      if (identity !== null) {
        sink.set(absPath, { ...identity, ...readTranscript(content) });
      }
      return content;
    },
  };
}

/**
 * Session-wide dedup of the tapped transcripts of the sessions in `admitted`
 * (the ones the ingest actually committed): sessionId -> messageId -> message.
 */
export function expectedLedger(
  tapped: Iterable<TappedTranscript>,
  admitted: ReadonlySet<string>,
): Map<string, Map<string, ExpectedMessage>> {
  const ledger = new Map<string, Map<string, ExpectedMessage>>();
  for (const transcript of tapped) {
    if (!admitted.has(transcript.sessionId)) {
      continue;
    }
    const session = ledger.get(transcript.sessionId) ?? new Map<string, ExpectedMessage>();
    ledger.set(transcript.sessionId, session);
    for (const [messageId, partial] of transcript.messages) {
      const existing = session.get(messageId);
      if (existing === undefined) {
        session.set(messageId, {
          usage: { ...partial, buckets: { ...partial.buckets } },
          owners: new Set([transcript.owner]),
        });
      } else {
        mergeUsagePartial(existing.usage, partial);
        existing.owners.add(transcript.owner);
      }
    }
  }
  return ledger;
}
