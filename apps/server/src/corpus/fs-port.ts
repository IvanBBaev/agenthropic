/**
 * WP-IN5 read-only filesystem port — the single seam between the corpus
 * adapter and `node:fs`. Every corpus module depends on THIS interface, never
 * on `node:fs` directly (only {@link ./node-corpus-fs} does), so the whole
 * adapter is driven in tests by an in-memory fake and reaches the coverage gate
 * without ever touching the real `~/.claude/projects`.
 *
 * The port is READ-ONLY by construction: it exposes no write / rename / unlink
 * / chmod / open-for-write operation. That is a security invariant — the live
 * corpus is actively appended to by Claude Code and MUST never be perturbed by
 * the dashboard (DESIGN.md: the ingest side reads the transcripts, it never
 * writes them). Every threshold here is PROVISIONAL (LABEL-ME) pending Ivan's
 * ratification.
 */
import type { SessionSubstrate } from '@agenthropic/core';

/**
 * `lstat` projection WITHOUT following symlinks — the three bits the walk needs
 * to decide keep / recurse / skip, plus the size/mtime pair the tail-follow
 * watcher fingerprints change detection on. `lstat` (not `stat`) is mandatory:
 * a symlink must be observable AS a symlink so it can be skipped rather than
 * silently followed out of the corpus root.
 */
export interface LstatInfo {
  readonly isFile: boolean;
  readonly isDirectory: boolean;
  readonly isSymbolicLink: boolean;
  /** Byte size of the entry itself (the link, not its target). */
  readonly sizeBytes: number;
  /** Modification time in epoch milliseconds (WP-IN5 change fingerprinting). */
  readonly mtimeMs: number;
}

/** The product of {@link CorpusFs.readFileTailConfined}: a byte range plus the file's total size. */
export interface TailRead {
  /** The bytes `[min(fromByte, size), EOF)` — empty when `fromByte` is at or past EOF. */
  readonly data: Uint8Array;
  /** Total size of the file at read time (what the oversize cap was checked against). */
  readonly sizeBytes: number;
}

/**
 * The read-only capability set the corpus adapter is allowed to use. A fake
 * implementation backs every unit test; {@link ./node-corpus-fs} is the sole
 * production binding to `node:fs`.
 */
export interface CorpusFs {
  /** Entry basenames of a directory (never Dirent objects — kind is re-checked via {@link lstat}). */
  readDirNames(absDir: string): string[];
  /** `lstat` (no symlink follow). Throws the underlying fs error on failure. */
  lstat(absPath: string): LstatInfo;
  /** Canonicalize an absolute path (resolves symlinks in the path itself). */
  realpath(absPath: string): string;
  /**
   * Read a regular file as UTF-8, opened `O_RDONLY | O_NOFOLLOW` and size-capped
   * at `maxBytes`. Throws {@link OversizeError} when the file exceeds the cap,
   * or the underlying fs error (ENOENT / EACCES / EISDIR / ELOOP / …) otherwise.
   */
  readFileConfined(absPath: string, maxBytes: number): string;
  /**
   * Read the byte range `[min(fromByte, size), EOF)` of a regular file, with
   * the same `O_NOFOLLOW` open and fstat re-check as {@link readFileConfined}.
   * The `maxBytes` cap applies to the WHOLE file regardless of `fromByte` — a
   * tail read is a cost optimization (review M-15), never a way around the
   * read cap. Throws exactly like {@link readFileConfined}.
   */
  readFileTailConfined(absPath: string, fromByte: number, maxBytes: number): TailRead;
}

/** A file exceeded the per-file read cap and was deliberately NOT read. */
export class OversizeError extends Error {
  override readonly name = 'OversizeError';
  constructor(
    readonly path: string,
    readonly sizeBytes: number,
    readonly maxBytes: number,
  ) {
    super(`file "${path}" is ${sizeBytes} bytes, over the ${maxBytes}-byte read cap`);
  }
}

/**
 * A candidate path resolved OUTSIDE the canonical corpus root — a traversal or
 * symlink-escape attempt. Unlike a per-file I/O hazard (which is swallowed into
 * a {@link SkippedFile}), this is the ONE hard stop the adapter never swallows:
 * it signals a crafted / compromised corpus and aborts the whole run.
 */
export class ContainmentError extends Error {
  override readonly name = 'ContainmentError';
  constructor(
    readonly candidate: string,
    readonly root: string,
  ) {
    super(`path "${candidate}" escapes the corpus root "${root}"`);
  }
}

/** Best-effort extraction of a Node fs error code (`ENOENT`, `EACCES`, …). */
export function errnoCodeOf(err: unknown): string | undefined {
  if (err instanceof Error) {
    const code = (err as { code?: unknown }).code;
    if (typeof code === 'string') {
      return code;
    }
  }
  return undefined;
}

/** Why a discovered file was recorded as skipped rather than fed to the parser. */
export type SkipReason =
  | 'oversize'
  | 'symlink'
  | 'not-regular-file'
  | 'unreadable'
  | 'empty-agent'
  | 'empty-main'
  | 'non-artifact'
  | 'duplicate-session';

/** One discovered-but-not-ingested file, with the reason (and fs code, if any). */
export interface SkippedFile {
  readonly relativePath: string;
  readonly reason: SkipReason;
  readonly code?: string;
}

/**
 * A discovered session: its `<uuid>.jsonl` main transcript at the project-root,
 * the `projectSlug` (the slug directory basename, VERBATIM) and the `<uuid>/`
 * directory that holds its subagent artifacts (if any).
 */
export interface SessionRef {
  readonly sessionId: string;
  readonly projectSlug: string;
  readonly mainAbsPath: string;
  readonly sessionDirAbs: string;
}

/** A readable corpus root and every session discovered under it. */
export interface EnumeratedSessions {
  readonly kind: 'sessions';
  readonly refs: readonly SessionRef[];
  /**
   * Files discovered but excluded AT ENUMERATION — today only
   * `duplicate-session` (review M-14): a session uuid found under more than one
   * slug directory keeps exactly one deterministic ref, and every other copy is
   * recorded here. Per-file build hazards are NOT this list — they surface from
   * {@link ./disk-substrate.buildSessionSubstrate}.
   */
  readonly skipped: readonly SkippedFile[];
}

/**
 * The corpus root exists but its directory listing failed (EACCES, EIO, …).
 * A DIFFERENT fact from "no sessions": an unreadable root says nothing about
 * what it holds, so no caller may treat it as an empty corpus — pruning
 * fingerprints, answering "session not found" or reporting a quiet pass on
 * this arm would all be the confident-lie collapse the dashboard forbids.
 * ENOENT is NOT this arm: a root that vanished genuinely holds no sessions
 * (the next root resolution will see it gone and reset).
 */
export interface UnreadableRoot {
  readonly kind: 'unreadable-root';
  /** The fs error code, when one was surfaced (`EACCES`, `EIO`, …). */
  readonly code?: string;
}

/** The product of {@link ./disk-substrate.enumerateSessions}. */
export type SessionEnumeration = EnumeratedSessions | UnreadableRoot;

/** Per-file read bounds. PROVISIONAL (LABEL-ME) — not yet ratified. */
export interface ReadLimits {
  readonly maxFileBytes: number;
  readonly maxDepth: number;
}

/** 64 MiB — comfortably above any observed transcript, small enough to bound RAM. PROVISIONAL. */
export const DEFAULT_MAX_FILE_BYTES = 64 * 1024 * 1024;
/** Real artifacts reach depth 3 under a session dir (subagents/workflows/wf_<id>/agent); 4 is slack. PROVISIONAL. */
export const DEFAULT_MAX_DEPTH = 4;

export const DEFAULT_READ_LIMITS: ReadLimits = {
  maxFileBytes: DEFAULT_MAX_FILE_BYTES,
  maxDepth: DEFAULT_MAX_DEPTH,
};

/** A session that yielded something parseable: a main transcript, an agent, or both. */
export interface BuiltSubstrate {
  readonly kind: 'built';
  readonly substrate: SessionSubstrate;
  readonly projectSlug: string;
  readonly skipped: readonly SkippedFile[];
}

/**
 * A session that yielded NOTHING parseable — a meta/journal-only remnant, or one
 * whose every transcript was skipped.
 *
 * It still carries `skipped`, and that is the whole point of this arm. The
 * builder always knew WHY each file was dropped (errno and all); the previous
 * `BuiltSubstrate | null` return threw that list away on exactly this path, so
 * an EACCES main got reported as a warning when a subagent happened to survive
 * alongside it and vanished into a bare "1 session skipped" when it did not.
 * The worse the failure, the less the operator was told - precisely inverted.
 */
export interface NoSubstrate {
  readonly kind: 'no-substrate';
  readonly projectSlug: string;
  readonly skipped: readonly SkippedFile[];
}

/** The product of {@link ./disk-substrate.buildSessionSubstrate} for one session. */
export type SubstrateBuild = BuiltSubstrate | NoSubstrate;
