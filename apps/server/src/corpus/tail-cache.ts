/**
 * Review M-15 — incremental transcript reads. Live `*.jsonl` transcripts are
 * append-only in practice, yet every watcher pass re-read each changed file in
 * full, making a poll cost O(total corpus bytes) instead of O(new bytes). This
 * decorator wraps a {@link CorpusFs} and serves `readFileConfined` for `.jsonl`
 * paths from a byte-offset cache: only the bytes past the last cached
 * complete-line boundary are fetched (via {@link CorpusFs.readFileTailConfined},
 * which keeps the `O_NOFOLLOW` + fstat confinement), and an overlap window of
 * the previously-seen bytes is re-read and compared so an in-place rewrite that
 * happens to grow the file is detected, not silently mis-served.
 *
 * Correctness anchors (each is load-bearing for "cached read ≡ full read"):
 *
 *  - Only COMPLETE lines (ending 0x0A) are cached. `0x0A` never appears inside
 *    a multi-byte UTF-8 sequence, so decoding chunks split at newline
 *    boundaries is byte-for-byte equivalent to decoding the whole file. The
 *    torn remainder after the last newline — including a partial multi-byte
 *    character — is decoded fresh every call and NEVER cached, so it re-decodes
 *    together with its completion once the writer finishes the line.
 *  - Any divergence signal (file shrank, overlap bytes differ) drops the entry
 *    and falls back to a full read — the cache can cost speed, never answers.
 *  - Any error from the inner fs drops the entry and propagates untouched, so
 *    the decorator is invisible to every error-handling arm above it.
 */
import type { CorpusFs, TailRead } from './fs-port';

/** Overlap window re-read and compared on every incremental read. PROVISIONAL (LABEL-ME). */
export const OVERLAP_BYTES = 4096;
/** Total cache budget across all files — bounds watcher RAM. PROVISIONAL (LABEL-ME). */
export const MAX_CACHE_BYTES = 128 * 1024 * 1024;
/** Entry-count cap — bounds bookkeeping regardless of file sizes. PROVISIONAL (LABEL-ME). */
export const MAX_CACHE_ENTRIES = 512;

export interface TailCacheOptions {
  readonly overlapBytes?: number;
  readonly maxTotalBytes?: number;
  readonly maxEntries?: number;
}

interface CacheEntry {
  /** Decoded content of the cached complete-line region `[0, offsetBytes)`. */
  contentComplete: string;
  /** Byte offset just past the last cached newline. */
  offsetBytes: number;
  /**
   * The last `min(overlapBytes, offsetBytes)` bytes of the cached region —
   * re-read and compared on the next call to detect in-place rewrites.
   */
  tailBytes: Uint8Array;
}

/** Index-wise comparison of two equal-length views (lengths are equal by construction at both call sites). */
function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  for (let i = 0; i < b.length; i++) {
    if (a[i] !== b[i]) {
      return false;
    }
  }
  return true;
}

/**
 * Wrap `inner` so `.jsonl` full reads are served incrementally. All other
 * operations (and all non-`.jsonl` reads, e.g. `meta.json`) pass through.
 */
export function createTailCachingFs(inner: CorpusFs, options: TailCacheOptions = {}): CorpusFs {
  const overlapBytes = options.overlapBytes ?? OVERLAP_BYTES;
  const maxTotalBytes = options.maxTotalBytes ?? MAX_CACHE_BYTES;
  const maxEntries = options.maxEntries ?? MAX_CACHE_ENTRIES;
  // Map preserves insertion order; re-inserting on every hit makes it an LRU.
  const cache = new Map<string, CacheEntry>();
  let totalBytes = 0;
  const decoder = new TextDecoder();

  function dropEntry(absPath: string): void {
    const entry = cache.get(absPath);
    if (entry !== undefined) {
      // JS strings are UTF-16 code units — 2 bytes each is the honest estimate.
      totalBytes -= entry.contentComplete.length * 2 + entry.tailBytes.length;
      cache.delete(absPath);
    }
  }

  function storeEntry(absPath: string, entry: CacheEntry): void {
    dropEntry(absPath); // re-insertion = LRU refresh + accounting reset
    cache.set(absPath, entry);
    totalBytes += entry.contentComplete.length * 2 + entry.tailBytes.length;
    // Evict oldest-first until within both caps. This may evict the entry just
    // inserted (a single file over the byte budget) — correct: such a file is
    // simply never cached rather than blowing the budget.
    for (const oldest of cache.keys()) {
      if (cache.size <= maxEntries && totalBytes <= maxTotalBytes) {
        break;
      }
      dropEntry(oldest);
    }
  }

  /** Index of the last 0x0A in `data`, or -1. (No lastIndexOf on Uint8Array.) */
  function lastNewline(data: Uint8Array): number {
    for (let i = data.length - 1; i >= 0; i--) {
      if (data[i] === 0x0a) {
        return i;
      }
    }
    return -1;
  }

  function fullRead(absPath: string, maxBytes: number): string {
    const { data } = inner.readFileTailConfined(absPath, 0, maxBytes);
    const completeEnd = lastNewline(data) + 1; // -1 → 0: nothing cacheable
    const contentComplete = decoder.decode(data.subarray(0, completeEnd));
    const remainder = decoder.decode(data.subarray(completeEnd));
    storeEntry(absPath, {
      contentComplete,
      offsetBytes: completeEnd,
      // slice, not subarray: a subarray view would pin the WHOLE file buffer
      // in memory for the lifetime of the cache entry.
      tailBytes: data.slice(Math.max(0, completeEnd - overlapBytes), completeEnd),
    });
    return contentComplete + remainder;
  }

  function readJsonl(absPath: string, maxBytes: number): string {
    const entry = cache.get(absPath);
    if (entry === undefined) {
      return fullRead(absPath, maxBytes);
    }
    // Re-read from the start of the overlap window so the cached bytes can be
    // verified before any new byte is trusted.
    const start = entry.offsetBytes - entry.tailBytes.length;
    const { data, sizeBytes } = inner.readFileTailConfined(absPath, start, maxBytes);
    if (sizeBytes < entry.offsetBytes) {
      // The file SHRANK below the cached region — a rewrite, not an append.
      dropEntry(absPath);
      return fullRead(absPath, maxBytes);
    }
    if (!sameBytes(data.subarray(0, entry.tailBytes.length), entry.tailBytes)) {
      // Same-or-larger size but different bytes where the cache expects its
      // own tail: an in-place rewrite. Distrust everything and start over.
      dropEntry(absPath);
      return fullRead(absPath, maxBytes);
    }
    const fresh = data.subarray(entry.tailBytes.length);
    const lastNl = lastNewline(fresh);
    let contentComplete = entry.contentComplete;
    let offsetBytes = entry.offsetBytes;
    if (lastNl >= 0) {
      contentComplete += decoder.decode(fresh.subarray(0, lastNl + 1));
      offsetBytes += lastNl + 1;
    }
    // lastNl === -1 → every fresh byte is torn remainder; nothing advances.
    const remainder = decoder.decode(fresh.subarray(lastNl + 1));
    storeEntry(absPath, {
      contentComplete,
      offsetBytes,
      // Window indices are relative to `start`; `offsetBytes - overlapBytes`
      // can only dip below `start` when overlapBytes shrank the window to the
      // whole cached region already, so the Math.max clamps to 0 safely.
      tailBytes: data.slice(Math.max(offsetBytes - overlapBytes, 0) - start, offsetBytes - start),
    });
    return contentComplete + remainder;
  }

  return {
    readDirNames(absDir: string): string[] {
      return inner.readDirNames(absDir);
    },
    lstat(absPath) {
      return inner.lstat(absPath);
    },
    realpath(absPath: string): string {
      return inner.realpath(absPath);
    },
    readFileConfined(absPath: string, maxBytes: number): string {
      if (!absPath.endsWith('.jsonl')) {
        return inner.readFileConfined(absPath, maxBytes);
      }
      try {
        return readJsonl(absPath, maxBytes);
      } catch (err) {
        // Oversize, EACCES, vanished file... — forget what we knew and let the
        // caller's error arms see exactly what the inner fs threw.
        dropEntry(absPath);
        throw err;
      }
    },
    readFileTailConfined(absPath: string, fromByte: number, maxBytes: number): TailRead {
      return inner.readFileTailConfined(absPath, fromByte, maxBytes);
    },
  };
}
