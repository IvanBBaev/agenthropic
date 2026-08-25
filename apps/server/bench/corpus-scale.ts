/**
 * Corpus-scale benchmark - does the ingest loop survive a real-size corpus?
 *
 * Every performance claim about this project so far is an extrapolation from a
 * six-session fixture set. The Phase-0 spike counted ~1855 sessions in the real
 * `~/.claude/projects`, and the product's whole value proposition ("open the
 * dashboard, understand a session") dies if the startup replay over that corpus
 * takes minutes. This harness measures it instead of assuming it.
 *
 * What it measures, in the order the server actually does them:
 *   1. cold replay      - the first `watcher.tick()` on an empty database, i.e.
 *                         exactly what `start()` blocks on before it listens.
 *   2. warm tick        - a second tick over an UNCHANGED corpus. This is the
 *                         steady-state poll cost paid every `pollIntervalMs`,
 *                         so it is the number that decides whether the daemon
 *                         is a background process or a space heater.
 *   3. incremental tick - one session grows by one record, then a tick. This is
 *                         the live-use path: the cost of noticing real work.
 *   4. API reads        - the read paths a human hits after the data lands.
 *   5. event-loop delay - how long a tick actually BLOCKS the loop, sampled
 *                         with `monitorEventLoopDelay` around the cold replay
 *                         and around the warm tick separately (review L-26).
 *                         The old "duty cycle" line is a derived proxy: it
 *                         divides wall time by the poll interval and says
 *                         nothing about whether anything was waiting.
 *   6. read contention  - the same read paths driven CONCURRENTLY while ticks
 *                         run on the real poll interval, against an identical
 *                         quiescent window, so the latency a human actually
 *                         pays during a poll is measured and not inferred
 *                         (review L-26). Phase 4 runs after every tick has
 *                         finished, i.e. on a server that is doing nothing.
 *
 * SAFETY: the corpus is synthesised into a throwaway `mkdtemp` directory and
 * the real `~/.claude/projects` is asserted to be somewhere else before a
 * single byte is written. This harness never reads the real corpus - not even
 * read-only, because a benchmark that mutates nothing can still leak content
 * into stdout.
 *
 * FIDELITY, stated honestly:
 *   - Structural shape (agents, tool_use blocks, sidechains, edges) is drawn
 *     from the six synthetic fixtures. VOLUME is not: each main transcript is
 *     inflated to the record count and byte size measured on the WP-S1 spike
 *     corpus, because at fixture size (~10 records of ~300 B) this harness
 *     would report a parse throughput the real corpus never sees.
 *   - The inflated records are structurally inert - plain user/assistant turns
 *     with real usage buckets and no tool_use - so they add parse and cost
 *     volume without inventing graph structure the fixtures did not assert.
 *   - Every identifier is re-salted per clone, so the N sessions are genuinely
 *     distinct rows rather than N idempotent replays of one session.
 *   - Models are remapped onto the REAL seeded price ids, so the cost engine
 *     runs its real exact-match lookup rather than a synthetic bypass.
 *   - The default run measures a SLICE and projects linearly to full corpus
 *     scale under an explicit heading. The projection is a floor, not a
 *     measurement; `--sessions=1855` measures the whole thing for real.
 *
 * Usage:  pnpm --filter @agenthropic/server bench [-- --sessions=1855]
 *         [--contention-ms=24000] [--concurrency=4] [--tick-every-ms=3000]
 */
import { createHash } from 'node:crypto';
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statfsSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { monitorEventLoopDelay, performance, type IntervalHistogram } from 'node:perf_hooks';
import { setTimeout as sleep } from 'node:timers/promises';
import { getFixture, listFixtures, type Fixture } from '@agenthropic/test-fixtures';
import { createSubstrateProvider } from '../src/api/substrate-provider';
import { DEFAULT_POLL_INTERVAL_MS } from '../src/config';
import { openDatabase, type SqliteDatabase } from '../src/db/connection';
import { currentSchemaVersion, runMigrations } from '../src/db/migrations';
import { loadPricing } from '../src/db/pricing';
import { createCorpusWatcher, tickSummary } from '../src/ingest/corpus-watcher';
import { RealtimeHub } from '../src/realtime/hub';
import { buildServer } from '../src/server';

/** Phase-0 counted this many sessions in the real corpus; it is the target scale. */
const REAL_CORPUS_SESSIONS = 1855;
/**
 * Default session count. Deliberately NOT {@link REAL_CORPUS_SESSIONS}: at the
 * realistic per-session shape below, 1855 sessions is ~13 GB of synthetic
 * transcript, which is a disk-filling operation, not a benchmark. The run
 * measures a real slice at real per-session size and prints an explicitly
 * labelled linear projection to full corpus scale; `--sessions=1855` measures
 * it for real when the disk can take it.
 */
const DEFAULT_SESSIONS = 200;
/** Real corpora fan out across many project directories; enumeration walks each. */
const DEFAULT_PROJECTS = 24;
/**
 * Per-session shape, calibrated against the WP-S1 spike corpus (five REAL
 * sessions, copied read-only): 559-5911 records each at 3.5-5.4 KB per record.
 * The defaults sit near that median rather than at the fixtures' ~10 records of
 * ~300 B, because the fixture shape understates parse volume by two orders of
 * magnitude and would turn this benchmark into a reassuring lie.
 */
const DEFAULT_RECORDS = 1800;
const DEFAULT_RECORD_BYTES = 4100;

/**
 * Ceiling on how much of the filesystem's free space a run may consume. The
 * corpus is written in full before the first tick, so an over-ambitious
 * `--sessions` would not fail fast - it would fill the disk of the machine this
 * project runs on and then report a meaningless number from a half-planted
 * corpus. A quarter of free space is enough headroom for the largest run worth
 * doing and leaves the machine usable.
 */
const DISK_SAFETY_FRACTION = 0.25;

const BENCH_TOKEN = 'bench-token-0123456789abcdef';

/**
 * Sampling period of the `monitorEventLoopDelay` histogram, in ms (review
 * L-26). PROVISIONAL: 10 ms is Node's own default and is two orders of
 * magnitude below the tick durations this harness expects to see, so it
 * resolves a stall without turning the sampler itself into load. It is a
 * FLOOR on what can be observed: a stall shorter than one sampling period may
 * never be sampled, which is the right bias here - this benchmark exists to
 * catch stalls that a human would notice, not to count microseconds.
 */
const LOOP_DELAY_RESOLUTION_MS = 10;

/**
 * How long to let the event loop turn on EACH side of a measured phase, in ms.
 * PROVISIONAL, and load-bearing in both directions - the first version of this
 * phase reported an 11 ms stall for a cold replay that blocked the loop for
 * 22.5 s, because it did neither:
 *
 *  - BEFORE the phase (seed): the sampler records the gap between consecutive
 *    firings, so its FIRST firing after `enable()` only stores a timestamp and
 *    records nothing. Enable immediately before a synchronous block and that
 *    first firing is the one that happens after the block - the whole stall is
 *    swallowed as the seed. One turn of the loop before the phase starts costs
 *    the seed firing against idle time instead.
 *  - AFTER the phase (settle): while `watcher.tick()` blocks, the sampler (a
 *    libuv timer) cannot fire at all, so the stall is only RECORDED once the
 *    loop turns again. Disabling without yielding throws it away.
 *
 * 50 ms is five sampling periods on each side - enough for the seed firing and
 * for the overdue one that carries the stall, short enough not to pad the run.
 */
const LOOP_DELAY_SETTLE_MS = 50;

/**
 * Default length of each read-load window, in ms. PROVISIONAL: eight poll
 * intervals, so a window contains seven to eight real ticks. Fewer than that
 * and the "under tick load" tail rests on three or four stalls, which is too
 * thin to carry a recommendation; eight keeps the two windows (quiescent +
 * contended) to under a minute of the run. The printed tick count is the
 * honest denominator either way - read it before trusting the tail.
 */
const DEFAULT_CONTENTION_MS = 8 * DEFAULT_POLL_INTERVAL_MS;

/**
 * Default number of concurrent inject drivers. PROVISIONAL: this dashboard is
 * a single-human, single-browser tool, and one open view fires a handful of
 * requests at once (list + detail + tree + health chip). Four keeps requests
 * genuinely in flight across a tick without turning the phase into a load test
 * of Fastify's own throughput, which is not the question L-26 asks.
 */
const DEFAULT_CONCURRENCY = 4;

/**
 * The exact `message.model` byte-strings the pricing seed knows, weighted by
 * the counts observed in the real corpus (opus 4819 / sonnet 3286 / fable 1849).
 * Using real ids keeps the benchmark on the cost engine's real lookup path -
 * `computeCostUsd` halts loudly on an unknown id, so a synthetic model name
 * would either need a fake price row or would never exercise pricing at all.
 */
const MODEL_POOL: readonly string[] = [
  ...Array<string>(48).fill('claude-opus-4-8'),
  ...Array<string>(33).fill('claude-sonnet-5'),
  ...Array<string>(19).fill('claude-fable-5'),
];

/**
 * Identifier shapes that must be re-salted per clone so N cloned sessions are N
 * distinct rows. Ordered longest-first: the UUID alternative consumes its own
 * leading 8 hex digits before the bare-hex alternative can see them.
 */
const ID_RE =
  /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|(?:toolu|msg|wf|prompt)_[A-Za-z0-9_]+|\b[0-9a-f]{8}\b/g;

function digest(input: string, length: number): string {
  return createHash('sha256').update(input).digest('hex').slice(0, length);
}

/**
 * A shape-preserving, deterministic, per-session identifier rewriter. Shape
 * matters: the parser validates UUID form and the parser-spec requires
 * `agent_id` to be byte-equal to the `agent-<hex>` filename, so a rewrite that
 * changed length or alphabet would be measuring a different program. One memo
 * per session keeps every cross-file reference (tool_use -> agent, parentUuid
 * -> uuid) internally consistent.
 */
function makeSalter(salt: string): (text: string) => string {
  const memo = new Map<string, string>();
  const rename = (token: string): string => {
    const cached = memo.get(token);
    if (cached !== undefined) {
      return cached;
    }
    let replacement: string;
    if (token.length === 36 && token.includes('-')) {
      const h = digest(`${salt}:${token}`, 32);
      // Version nibble pinned to 4 and variant to 8, as in the fixtures.
      replacement = `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(12, 15)}-8${h.slice(15, 18)}-${h.slice(18, 30)}`;
    } else if (token.includes('_')) {
      const prefix = token.slice(0, token.indexOf('_') + 1);
      replacement = prefix + digest(`${salt}:${token}`, token.length - prefix.length);
    } else {
      replacement = digest(`${salt}:${token}`, token.length);
    }
    memo.set(token, replacement);
    return replacement;
  };
  return (text) => text.replace(ID_RE, rename);
}

interface PlantedSession {
  readonly sessionId: string;
  readonly slug: string;
  /**
   * Absolute path of the main `<uuid>.jsonl` transcript, or null when the
   * fixture models a session that has ONLY sidechain files - `usage-dedup` is
   * exactly that case, and it is a real corpus shape, not a fixture defect.
   */
  readonly mainPath: string | null;
}

/**
 * The fixture's own session id: the stem of its root-level `<uuid>.jsonl` when
 * it has one, otherwise the `sessionId` its records carry. Deriving it rather
 * than assuming `files[0]` is the main transcript is what keeps `usage-dedup`
 * (subagent file only) in the mix instead of silently dropped - dropping it
 * would quietly shrink the benchmark to five of six shapes.
 */
function fixtureSessionId(fixture: Fixture): string {
  const root = fixture.files.find((file) => !file.relativePath.includes('/'));
  if (root !== undefined) {
    return root.relativePath.replace(/\.jsonl$/, '');
  }
  const first = fixture.files[0]?.lines[0];
  if (first === undefined) {
    throw new Error(`fixture ${fixture.name}: no files to derive a session id from`);
  }
  const record = JSON.parse(first) as { sessionId?: unknown };
  if (typeof record.sessionId !== 'string') {
    throw new Error(
      `fixture ${fixture.name}: no root transcript and no sessionId on its first record`,
    );
  }
  return record.sessionId;
}

/**
 * Filler records that inflate a fixture transcript to real-corpus volume.
 *
 * The shapes are copied verbatim from the fixtures' own `user` and `assistant`
 * records minus the `tool_use` block, so they are structurally inert: they add
 * parse volume and usage rows (an assistant record carries usage, exactly as in
 * a real transcript) without inventing joins the parser would have to reconcile.
 * Inventing a novel record shape would be worse than useless - the parser might
 * skip it and the benchmark would time a no-op.
 *
 * Sizing matters as much as counting. The WP-S1 spike corpus measures
 * 3.5-5.4 KB per record across five real sessions, roughly an order of
 * magnitude above a fixture line; a benchmark at fixture line-length would
 * report throughput the real corpus never sees.
 */
function fillerRecords(opts: {
  readonly sessionId: string;
  readonly count: number;
  readonly bytesPerRecord: number;
  readonly model: string;
  readonly firstParentUuid: string | null;
}): string[] {
  const lines: string[] = [];
  // JSON overhead of the envelope around the padded text; the remainder is
  // padding, floored at a token's worth so tiny --record-bytes stays legal.
  const padding = 'x'.repeat(Math.max(16, opts.bytesPerRecord - 420));
  let parentUuid = opts.firstParentUuid;
  const base = Date.parse('2026-02-01T00:00:00.000Z');
  for (let i = 0; i < opts.count; i += 1) {
    const h = digest(`filler:${opts.sessionId}:${String(i)}`, 32);
    const uuid = `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(12, 15)}-8${h.slice(15, 18)}-${h.slice(18, 30)}`;
    const timestamp = new Date(base + i * 1000).toISOString();
    const record =
      i % 2 === 0
        ? {
            parentUuid,
            isSidechain: false,
            userType: 'external',
            cwd: '/home/synthetic/project',
            sessionId: opts.sessionId,
            version: '2.0.0',
            type: 'user',
            message: { role: 'user', content: `Synthetic filler prompt ${String(i)}. ${padding}` },
            uuid,
            timestamp,
          }
        : {
            parentUuid,
            isSidechain: false,
            sessionId: opts.sessionId,
            type: 'assistant',
            message: {
              id: `msg_${digest(`fillermsg:${opts.sessionId}:${String(i)}`, 24)}`,
              type: 'message',
              role: 'assistant',
              model: opts.model,
              content: [{ type: 'text', text: `Synthetic filler reply ${String(i)}. ${padding}` }],
              usage: {
                input_tokens: 40 + (i % 17),
                cache_creation_input_tokens: 0,
                cache_read_input_tokens: 1000 + (i % 401),
                output_tokens: 60 + (i % 29),
              },
            },
            uuid,
            timestamp,
          };
    lines.push(JSON.stringify(record));
    parentUuid = uuid;
  }
  return lines;
}

/**
 * Lay one cloned fixture out the way Claude Code does: a bare `<uuid>.jsonl`
 * at the project-slug root plus everything else under `<uuid>/`.
 */
function plantSession(
  corpusRoot: string,
  fixture: Fixture,
  slug: string,
  index: number,
  inflate: { readonly records: number; readonly bytesPerRecord: number },
): PlantedSession {
  const salt = `bench-${String(index)}`;
  const saltIds = makeSalter(salt);
  const sessionId = saltIds(fixtureSessionId(fixture));
  const modelA = MODEL_POOL[index % MODEL_POOL.length] ?? 'claude-opus-4-8';
  const modelB = MODEL_POOL[(index * 7 + 3) % MODEL_POOL.length] ?? 'claude-sonnet-5';
  const mapText = (text: string): string =>
    saltIds(text).replaceAll('synthetic-model-a', modelA).replaceAll('synthetic-model-b', modelB);

  let mainPath: string | null = null;
  for (const file of fixture.files) {
    const isMain = !file.relativePath.includes('/');
    const salted = saltIds(file.relativePath);
    const rel = isMain ? salted : join(sessionId, ...salted.split('/'));
    const abs = join(corpusRoot, slug, rel);
    const lines = file.lines.map(mapText);
    if (isMain && inflate.records > lines.length) {
      // Filler goes AFTER the fixture's own records so the structural join the
      // fixture exists to exercise is still the first thing the parser meets.
      const lastUuid = (JSON.parse(lines[lines.length - 1] ?? '{}') as { uuid?: unknown }).uuid;
      lines.push(
        ...fillerRecords({
          sessionId,
          count: inflate.records - lines.length,
          bytesPerRecord: inflate.bytesPerRecord,
          model: modelA,
          firstParentUuid: typeof lastUuid === 'string' ? lastUuid : null,
        }),
      );
    }
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, lines.join('\n') + '\n');
    if (isMain) {
      mainPath = abs;
    }
  }
  return { sessionId, slug, mainPath };
}

/**
 * Append one plausible record to a planted session's main transcript: a copy of
 * its last line with a fresh uuid, chained to the previous one and stamped
 * later. This is what "the user said one more thing" looks like on disk, and it
 * is what the incremental tick has to notice.
 */
function growSession(session: PlantedSession, mainPath: string): void {
  const lines = readFileSync(mainPath, 'utf8').trimEnd().split('\n');
  const last = lines[lines.length - 1];
  if (last === undefined) {
    throw new Error(`empty transcript: ${mainPath}`);
  }
  const record = JSON.parse(last) as Record<string, unknown>;
  const previousUuid = record['uuid'];
  const fresh = digest(`grow:${session.sessionId}`, 32);
  record['uuid'] =
    `${fresh.slice(0, 8)}-${fresh.slice(8, 12)}-4${fresh.slice(12, 15)}-8${fresh.slice(15, 18)}-${fresh.slice(18, 30)}`;
  record['parentUuid'] = typeof previousUuid === 'string' ? previousUuid : null;
  record['timestamp'] = '2026-12-31T23:59:59.000Z';
  writeFileSync(mainPath, [...lines, JSON.stringify(record)].join('\n') + '\n');
}

/** Refuse to point any part of this harness at the real corpus. */
function assertSynthetic(corpusRoot: string): void {
  const real = resolve(homedir(), '.claude', 'projects');
  const candidate = resolve(corpusRoot);
  if (candidate === real || candidate.startsWith(real + sep)) {
    throw new Error(
      `refusing to benchmark against the real corpus (${candidate}); the corpus is read-only`,
    );
  }
}

/**
 * Refuse to start a run whose corpus would not fit. The estimate is the raw
 * product with no discount for filesystem compression, so it errs toward
 * refusing a run that would have just fit rather than toward starting one that
 * will not - the wrong side of that trade is a full disk on someone's daily
 * machine.
 */
function assertDiskSpace(root: string, estimatedBytes: number): void {
  const stat = statfsSync(root);
  const available = stat.bavail * stat.bsize;
  const budget = available * DISK_SAFETY_FRACTION;
  if (estimatedBytes > budget) {
    throw new Error(
      `refusing to write ~${fmtBytes(estimatedBytes)} of synthetic corpus: ` +
        `${fmtBytes(available)} is free and this harness caps itself at ` +
        `${String(Math.round(DISK_SAFETY_FRACTION * 100))}% of that ` +
        `(${fmtBytes(budget)}). Lower --sessions, --records or --record-bytes.`,
    );
  }
}

function intArg(argv: readonly string[], name: string, fallback: number): number {
  const hit = argv.find((arg) => arg.startsWith(`--${name}=`));
  if (hit === undefined) {
    return fallback;
  }
  const value = Number.parseInt(hit.slice(name.length + 3), 10);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`--${name} must be a positive integer, got: ${hit}`);
  }
  return value;
}

interface Timing {
  readonly label: string;
  readonly ms: number;
  readonly note: string;
}

function time<T>(fn: () => T): { readonly ms: number; readonly value: T } {
  const started = performance.now();
  const value = fn();
  return { ms: performance.now() - started, value };
}

async function timeAsync<T>(
  fn: () => Promise<T>,
): Promise<{ readonly ms: number; readonly value: T }> {
  const started = performance.now();
  const value = await fn();
  return { ms: performance.now() - started, value };
}

/**
 * One reading of an event-loop-delay histogram, in ms (review L-26). `samples`
 * travels with the numbers on purpose: a synchronous phase blocks the sampler
 * for its whole duration, so the histogram behind a multi-second stall may hold
 * a handful of values - `max` is then the measurement and `mean` is close to
 * meaningless. A mean over four samples must not be read as a mean over four
 * hundred, so the count is printed next to it every time.
 */
interface LoopDelay {
  readonly samples: number;
  readonly meanMs: number;
  readonly p99Ms: number;
  readonly maxMs: number;
}

/** Histogram values are nanoseconds; every field is converted, none is invented. */
function readLoopDelay(histogram: IntervalHistogram): LoopDelay {
  return {
    samples: histogram.count,
    meanMs: histogram.mean / 1e6,
    p99Ms: histogram.percentile(99) / 1e6,
    maxMs: histogram.max / 1e6,
  };
}

function fmtLoopDelay(loop: LoopDelay): string {
  if (loop.samples === 0) {
    // Not a zero. A histogram with no samples measured nothing, and printing
    // "0.0 ms" for it would be the exact fabrication this project refuses.
    return 'not measured (no samples)';
  }
  return (
    `${String(loop.samples).padStart(6)} samples   ` +
    `mean ${fmtMs(loop.meanMs).padStart(9)}   ` +
    `p99 ${fmtMs(loop.p99Ms).padStart(9)}   ` +
    `max ${fmtMs(loop.maxMs).padStart(9)}`
  );
}

/**
 * Run a synchronous phase with an event-loop-delay histogram around it (L-26).
 * Neither await is optional and neither is counted in `ms` - see
 * {@link LOOP_DELAY_SETTLE_MS} for what each one is for and for the wrong
 * number this reported without them.
 */
async function timeWithLoopDelay<T>(
  fn: () => T,
): Promise<{ readonly ms: number; readonly value: T; readonly loop: LoopDelay }> {
  const histogram = monitorEventLoopDelay({ resolution: LOOP_DELAY_RESOLUTION_MS });
  histogram.enable();
  await sleep(LOOP_DELAY_SETTLE_MS); // seed the sampler; see the constant's doc
  const started = performance.now();
  const value = fn();
  const ms = performance.now() - started;
  await sleep(LOOP_DELAY_SETTLE_MS); // let the overdue sample record the stall
  histogram.disable();
  return { ms, value, loop: readLoopDelay(histogram) };
}

/** Latency distribution of one set of requests, in ms. */
interface LatencyStats {
  readonly count: number;
  readonly p50Ms: number;
  readonly p95Ms: number;
  readonly p99Ms: number;
  readonly maxMs: number;
}

/**
 * Nearest-rank percentiles over the raw samples. No interpolation: with a few
 * hundred samples an interpolated p99 invents a value that no request actually
 * observed, and every number this harness prints has to be one that happened.
 */
function latencyStats(samples: readonly number[]): LatencyStats | null {
  if (samples.length === 0) {
    return null; // nothing ran; the caller prints "not measured", never zeros
  }
  const sorted = [...samples].sort((a, b) => a - b);
  const at = (p: number): number => {
    const rank = Math.ceil((p / 100) * sorted.length) - 1;
    const index = Math.min(sorted.length - 1, Math.max(0, rank));
    return sorted[index] ?? Number.NaN;
  };
  return {
    count: sorted.length,
    p50Ms: at(50),
    p95Ms: at(95),
    p99Ms: at(99),
    maxMs: sorted[sorted.length - 1] ?? Number.NaN,
  };
}

function fmtStats(stats: LatencyStats | null): string {
  if (stats === null) {
    return 'not measured (no requests)';
  }
  return (
    `${fmtMs(stats.p50Ms).padStart(10)} ${fmtMs(stats.p95Ms).padStart(10)} ` +
    `${fmtMs(stats.p99Ms).padStart(10)} ${fmtMs(stats.maxMs).padStart(10)}`
  );
}

/** One read-load window: the same driver, with ticks running or without them. */
interface LoadWindow {
  readonly label: string;
  readonly wallMs: number;
  readonly requests: number;
  readonly nonOk: number;
  /** Cadence the window ASKED for, or null if it was quiescent by design. */
  readonly tickEveryMs: number | null;
  readonly ticks: number;
  readonly tickDurationsMs: readonly number[];
  readonly loop: LoopDelay;
  readonly samples: readonly number[];
  readonly overall: LatencyStats | null;
  readonly perRoute: ReadonlyArray<readonly [string, LatencyStats | null]>;
}

type BenchServer = ReturnType<typeof buildServer>;
type BenchWatcher = ReturnType<typeof createCorpusWatcher>;
type Route = readonly [label: string, url: string];

/**
 * Drive `concurrency` concurrent `app.inject` loops for `durationMs`, optionally
 * with `watcher.tick()` firing on the real poll interval underneath them (review
 * L-26). Run once WITHOUT ticks and once WITH them and the difference between
 * the two distributions is the latency a poll costs a human - which no phase of
 * this harness measured before, because every read it timed ran on a server
 * that had already finished ticking.
 *
 * Routes rotate round-robin across the drivers rather than being sharded per
 * driver, so both windows issue the same mix even if a slow route ends up with
 * fewer completions.
 *
 * The `setImmediate` yield between requests is NOT padding and must not be
 * removed. `app.inject` never touches a socket: it completes entirely on the
 * microtask/`process.nextTick` queues, which libuv drains without ever reaching
 * its timers phase. A tight inject loop therefore starves every timer in the
 * process - measured here at 53 649 injects in one second with a
 * `setInterval(…, 100)` firing ZERO times. The first version of this phase hit
 * exactly that and reported a "contended" window containing no ticks at all.
 * Yielding through the check phase lets the loop reach its timers each turn (the
 * same probe: 9 firings of the same interval), which is also what a real HTTP
 * request does - it arrives through the poll phase rather than skipping it.
 *
 * KNOWN CEILING on what these percentiles can show: the drivers live on the same
 * blocked loop as the server, so while a tick runs no new inject can be issued.
 * Only requests already in flight when the tick fires pay for it - at most
 * `concurrency` of them per tick. A real client's request arrives in the socket
 * buffer during the stall and waits the whole of it out, so the event-loop-delay
 * max, not this p99, is the honest figure for a request that arrives mid-tick.
 */
async function driveLoadWindow(opts: {
  readonly label: string;
  readonly app: BenchServer;
  readonly headers: Record<string, string>;
  readonly routes: readonly Route[];
  readonly durationMs: number;
  readonly concurrency: number;
  /** Poll cadence for the background ticker, or null for a quiescent window. */
  readonly tickEveryMs: number | null;
  readonly watcher: BenchWatcher;
}): Promise<LoadWindow> {
  const perRoute = new Map<string, number[]>();
  for (const [label] of opts.routes) {
    perRoute.set(label, []);
  }
  const samples: number[] = [];
  const tickDurationsMs: number[] = [];
  let nonOk = 0;
  let cursor = 0;

  const histogram = monitorEventLoopDelay({ resolution: LOOP_DELAY_RESOLUTION_MS });
  histogram.enable();
  await sleep(LOOP_DELAY_SETTLE_MS); // seed the sampler; see LOOP_DELAY_SETTLE_MS
  const startedAt = performance.now();
  const deadline = startedAt + opts.durationMs;

  // A tick is fully synchronous (better-sqlite3), so this interval callback
  // blocks the loop for exactly as long as a real poll does - which is the
  // whole point: the in-flight injects cannot be served while it runs.
  const ticker =
    opts.tickEveryMs === null
      ? null
      : setInterval(() => {
          const tickStarted = performance.now();
          opts.watcher.tick();
          tickDurationsMs.push(performance.now() - tickStarted);
        }, opts.tickEveryMs);

  const driver = async (): Promise<void> => {
    while (performance.now() < deadline) {
      const route = opts.routes[cursor % opts.routes.length];
      cursor += 1;
      if (route === undefined) {
        return; // no routes configured; nothing to measure
      }
      const [label, url] = route;
      const started = performance.now();
      const response = await opts.app.inject({ method: 'GET', url, headers: opts.headers });
      const elapsed = performance.now() - started;
      samples.push(elapsed);
      perRoute.get(label)?.push(elapsed);
      if (response.statusCode !== 200) {
        nonOk += 1;
      }
      // Outside the timed span: it is the harness handing the loop back, not
      // part of the request. See this function's doc for why it is mandatory.
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  };

  await Promise.all(Array.from({ length: opts.concurrency }, () => driver()));
  const wallMs = performance.now() - startedAt;
  if (ticker !== null) {
    clearInterval(ticker);
  }
  // Same reason as timeWithLoopDelay: the last tick's stall is only recorded
  // once the loop turns again.
  await sleep(LOOP_DELAY_SETTLE_MS);
  histogram.disable();

  return {
    label: opts.label,
    wallMs,
    requests: samples.length,
    nonOk,
    tickEveryMs: opts.tickEveryMs,
    ticks: tickDurationsMs.length,
    tickDurationsMs,
    loop: readLoopDelay(histogram),
    samples,
    overall: latencyStats(samples),
    perRoute: [...perRoute].map(([label, values]) => [label, latencyStats(values)] as const),
  };
}

function fmtMs(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(2)} s` : `${ms.toFixed(1)} ms`;
}

function fmtBytes(bytes: number): string {
  if (bytes >= 1024 ** 3) {
    return `${(bytes / 1024 ** 3).toFixed(2)} GiB`;
  }
  return bytes >= 1024 * 1024
    ? `${(bytes / 1024 / 1024).toFixed(1)} MiB`
    : `${(bytes / 1024).toFixed(1)} KiB`;
}

function tableSizes(db: SqliteDatabase): ReadonlyArray<readonly [string, number]> {
  const tables = db
    .prepare(
      `SELECT name FROM sqlite_master
        WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
        ORDER BY name`,
    )
    .all() as ReadonlyArray<{ name: string }>;
  return tables.map(
    (t) =>
      [
        t.name,
        (db.prepare(`SELECT COUNT(*) AS c FROM "${t.name}"`).get() as { c: number }).c,
      ] as const,
  );
}

function dbBytes(dbPath: string): number {
  let total = 0;
  for (const suffix of ['', '-wal', '-shm']) {
    try {
      total += statSync(dbPath + suffix).size;
    } catch {
      // -wal / -shm may be absent; nothing to add.
    }
  }
  return total;
}

/** Total bytes of every `.jsonl` under the synthetic corpus root. */
function corpusBytes(root: string): number {
  let total = 0;
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(abs);
      } else {
        total += statSync(abs).size;
      }
    }
  };
  walk(root);
  return total;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const sessionCount = intArg(argv, 'sessions', DEFAULT_SESSIONS);
  const projectCount = intArg(argv, 'projects', DEFAULT_PROJECTS);
  const records = intArg(argv, 'records', DEFAULT_RECORDS);
  const bytesPerRecord = intArg(argv, 'record-bytes', DEFAULT_RECORD_BYTES);
  const contentionMs = intArg(argv, 'contention-ms', DEFAULT_CONTENTION_MS);
  const concurrency = intArg(argv, 'concurrency', DEFAULT_CONCURRENCY);
  // Defaults to the product's real poll interval; overridable so the same
  // harness can answer "what if we polled faster" without editing the bench.
  const tickEveryMs = intArg(argv, 'tick-every-ms', DEFAULT_POLL_INTERVAL_MS);
  const keep = argv.includes('--keep');

  const workDir = mkdtempSync(join(tmpdir(), 'agenthropic-bench-'));
  const corpusRoot = join(workDir, 'projects');
  const dbPath = join(workDir, 'bench.db');
  assertSynthetic(corpusRoot);
  assertDiskSpace(workDir, sessionCount * records * bytesPerRecord);
  mkdirSync(corpusRoot, { recursive: true });

  const fixtureNames = listFixtures();
  const fixtures = fixtureNames.map((name) => getFixture(name));

  console.log(
    `corpus-scale benchmark: ${String(sessionCount)} sessions across ` +
      `${String(projectCount)} projects, cloned from ${String(fixtures.length)} fixtures`,
  );
  console.log(
    `  shape:  ${String(records)} records per main transcript at ~${String(bytesPerRecord)} B/record`,
  );
  console.log(`  corpus: ${corpusRoot}`);
  console.log(`  db:     ${dbPath}\n`);

  const planted: PlantedSession[] = [];
  const build = time(() => {
    for (let i = 0; i < sessionCount; i += 1) {
      const fixture = fixtures[i % fixtures.length];
      if (fixture === undefined) {
        throw new Error('no fixtures registered');
      }
      const slug = `-Users-synthetic-bench-project-${String(i % projectCount).padStart(3, '0')}`;
      planted.push(plantSession(corpusRoot, fixture, slug, i, { records, bytesPerRecord }));
    }
  });

  const db = openDatabase(dbPath);
  runMigrations(db);
  const hub = new RealtimeHub();
  let events = 0;
  let failures = 0;
  const firstFailures: string[] = [];

  const watcher = createCorpusWatcher({
    db,
    pricing: loadPricing(db),
    env: { CLAUDE_PROJECTS_DIR: corpusRoot, DASHBOARD_INSTANCE: 'bench' },
    intervalMs: DEFAULT_POLL_INTERVAL_MS,
    watchdogThresholdMs: 30 * 60_000,
    now: () => '2026-08-02T00:00:00.000Z',
    nowMs: () => Date.parse('2026-08-02T00:00:00.000Z'),
    onIngestEvent: () => {
      events += 1;
    },
    onIngestFailure: (report) => {
      failures += 1;
      if (firstFailures.length < 3) {
        firstFailures.push(`${report.sessionId}: ${report.reason}`);
      }
    },
  });

  // Each phase gets its OWN histogram (review L-26): a single histogram spanning
  // both would report one stall distribution for two phases whose costs differ
  // by an order of magnitude, and the cold replay's tail would bury the warm
  // tick's - which is the number the steady-state question actually turns on.
  const cold = await timeWithLoopDelay(() => watcher.tick());
  const warm = await timeWithLoopDelay(() => watcher.tick());

  // Grow a session near the middle of the corpus so the incremental tick pays
  // the full enumeration walk before it reaches the one changed file.
  const midpoint = Math.floor(planted.length / 2);
  const target =
    planted.slice(midpoint).find((s) => s.mainPath !== null) ??
    planted.find((s) => s.mainPath !== null);
  if (target?.mainPath == null) {
    throw new Error('no planted session has a main transcript to grow');
  }
  growSession(target, target.mainPath);
  const incremental = time(() => watcher.tick());

  const app = buildServer({
    token: BENCH_TOKEN,
    schemaVersion: currentSchemaVersion(db),
    db,
    hub,
    substrateProvider: createSubstrateProvider({ env: { CLAUDE_PROJECTS_DIR: corpusRoot } }),
  });
  const auth = { authorization: `Bearer ${BENCH_TOKEN}` };
  const reads: Timing[] = [];
  for (const [label, url] of [
    ['GET /api/sessions', '/api/sessions'],
    ['GET /api/sessions/:id', `/api/sessions/${target.sessionId}`],
    ['GET /api/sessions/:id/tree', `/api/sessions/${target.sessionId}/tree`],
    ['GET /api/cost/summary', '/api/cost/summary'],
    ['GET /api/dag/global', '/api/dag/global'],
  ] as ReadonlyArray<readonly [string, string]>) {
    const shot = await timeAsync(() => app.inject({ method: 'GET', url, headers: auth }));
    reads.push({ label, ms: shot.ms, note: `HTTP ${String(shot.value.statusCode)}` });
  }

  // L-26: the read paths under concurrent load, with and without ticks running.
  // The expensive whole-corpus routes (/api/sessions, /api/cost/summary,
  // /api/dag/global - 0.35 s, 1.2 s and 0.52 s respectively in the sequential
  // phase above) are deliberately NOT in this mix. Every route here is
  // synchronous SQL on one shared loop, so putting a 350 ms query in the
  // rotation makes every OTHER request in the window queue behind it: the first
  // version of this phase did exactly that and printed one identical
  // distribution for all four routes, in which a 12 ms tick was invisible. The
  // sequential phase already reports what those routes cost on their own; this
  // phase exists to isolate the tick, so it uses only routes whose own work is
  // smaller than a tick. /api/health is in it precisely because its handler does
  // almost nothing: any latency it shows is queueing, not work of its own.
  const loadRoutes: readonly Route[] = [
    ['GET /api/health', '/api/health'],
    ['GET /api/sessions/:id', `/api/sessions/${target.sessionId}`],
    ['GET /api/sessions/:id/tree', `/api/sessions/${target.sessionId}/tree`],
  ];
  const loadWindow = {
    app,
    headers: auth,
    routes: loadRoutes,
    durationMs: contentionMs,
    concurrency,
    watcher,
  };
  // Quiescent FIRST, so the contended window's baseline is a window this same
  // process just ran, not a single-shot number from a different phase.
  const quiescentLoad = await driveLoadWindow({
    ...loadWindow,
    label: 'quiescent (no ticks)',
    tickEveryMs: null,
  });
  const contendedLoad = await driveLoadWindow({
    ...loadWindow,
    label: `under ticks every ${String(tickEveryMs)} ms`,
    tickEveryMs,
  });

  const summary = tickSummary(cold.value);
  const rows = tableSizes(db);
  const bytes = dbBytes(dbPath);
  const onDisk = corpusBytes(corpusRoot);

  console.log('## ingest');
  // Denominator is DISCOVERED sessions, not planted ones. A session is
  // discovered by its root `<uuid>.jsonl`, so the sidechain-only fixture plants
  // files that are correctly never enumerated as a session - dividing by the
  // planted count would flatter every per-session figure by that fraction.
  const discovered = summary?.sessionsDiscovered ?? 0;
  const perSession = (ms: number): string =>
    discovered === 0 ? 'n/a' : `${(ms / discovered).toFixed(2)} ms/session`;
  // Throughput, not just wall time. The per-session figure is only comparable
  // between runs at the SAME record shape, whereas MB/s survives a change to
  // --records or --record-bytes - and it is the only figure an extrapolation to
  // a bigger corpus can honestly rest on. Quoted for cold replay alone: the
  // warm tick deliberately does not read the bytes it skips, so a MB/s for it
  // would describe work that never happened.
  const thru = (ms: number): string =>
    ms <= 0 ? 'n/a' : `${(onDisk / 1024 / 1024 / (ms / 1000)).toFixed(1)} MB/s`;
  const dutyCycle = ((warm.ms / DEFAULT_POLL_INTERVAL_MS) * 100).toFixed(2);
  const ingestRows: Timing[] = [
    {
      label: 'build synthetic corpus',
      ms: build.ms,
      note: `${perSession(build.ms)} (harness, not product)`,
    },
    {
      label: 'cold replay (startup)',
      ms: cold.ms,
      note: `${perSession(cold.ms)} - ${thru(cold.ms)}`,
    },
    {
      label: 'warm tick (unchanged)',
      ms: warm.ms,
      // The duty cycle is a PROXY, not an impact measurement (review L-26): it
      // says what fraction of the interval is spent working, not what that work
      // does to anything waiting. The measured answer is two sections below.
      note: `${perSession(warm.ms)} - ${dutyCycle}% of a ${String(DEFAULT_POLL_INTERVAL_MS)} ms poll (proxy)`,
    },
    {
      label: 'incremental tick (1 changed)',
      ms: incremental.ms,
      note: 'one session grew by one record',
    },
  ];
  for (const row of ingestRows) {
    console.log(`  ${row.label.padEnd(30)} ${fmtMs(row.ms).padStart(10)}   ${row.note}`);
  }

  console.log('\n## api reads (sequential, quiescent server - no tick in flight)');
  for (const row of reads) {
    console.log(`  ${row.label.padEnd(30)} ${fmtMs(row.ms).padStart(10)}   ${row.note}`);
  }

  // L-26. What a tick does to the event loop, measured rather than derived.
  console.log(
    `\n## event-loop delay (monitorEventLoopDelay, ${String(LOOP_DELAY_RESOLUTION_MS)} ms resolution)`,
  );
  console.log('  a tick is synchronous, so it blocks the sampler while it runs: max is the stall.');
  // Reading this table wrong is easy, so the table says how to read it. Node
  // records the whole gap between two firings of its sampling timer, the
  // sampler's own period included, so an idle loop never reads 0.
  console.log(
    `  every sample includes the sampler's own ${String(LOOP_DELAY_RESOLUTION_MS)} ms period, so an idle loop reads about` +
      ` ${String(LOOP_DELAY_RESOLUTION_MS)} ms:`,
  );
  console.log("  subtract the resolution before comparing a max against a phase's wall time.");
  console.log(
    `  mean sits near that floor whenever the phase is short next to the ${String(LOOP_DELAY_SETTLE_MS)} ms settle window.`,
  );
  for (const [label, loop] of [
    ['cold replay (startup)', cold.loop],
    ['warm tick (unchanged)', warm.loop],
    ['read window, no ticks', quiescentLoad.loop],
    ['read window, ticking', contendedLoad.loop],
  ] as ReadonlyArray<readonly [string, LoopDelay]>) {
    console.log(`  ${label.padEnd(24)} ${fmtLoopDelay(loop)}`);
  }

  // L-26. The contention phase: the same driver twice, ticks on and off.
  console.log('\n## api reads under tick load (concurrent)');
  console.log(
    `  shape: ${String(concurrency)} concurrent inject drivers x ${fmtMs(contentionMs)} per window, ` +
      'routes round-robin:',
  );
  console.log(`         ${loadRoutes.map(([label]) => label).join(', ')}`);
  // The ceiling on how far these percentiles can be trusted, printed next to
  // them so the two tables cannot be read against each other by mistake. A
  // blocked loop blocks the drivers too, so an inject cannot be ISSUED during a
  // stall - only a request already in flight when the tick fires pays for it,
  // and with `concurrency` drivers that is at most `concurrency` requests per
  // tick. A real HTTP request has no such courtesy: it lands in the kernel's
  // socket buffer mid-stall and waits the whole thing out.
  console.log('  these percentiles cover requests already IN FLIGHT when a tick fires;');
  console.log('  for what a request ARRIVING mid-tick would wait, read the event-loop max above.');
  for (const window of [quiescentLoad, contendedLoad]) {
    // A window that asked for ticks and got none is an instrumentation failure,
    // not a result, and must never read as one - the first version of this phase
    // silently printed "no ticks" for both windows and looked like a clean run.
    const tickNote =
      window.ticks === 0
        ? window.tickEveryMs === null
          ? 'no ticks (quiescent by design)'
          : '! 0 ticks fired - NOT a contended measurement'
        : `${String(window.ticks)} ticks, ` +
          `${fmtMs(Math.min(...window.tickDurationsMs))}-${fmtMs(Math.max(...window.tickDurationsMs))} each`;
    console.log(
      `  ${window.label.padEnd(30)} ${String(window.requests).padStart(6)} requests over ` +
        `${fmtMs(window.wallMs)}   ${tickNote}` +
        (window.nonOk === 0 ? '' : `   ! ${String(window.nonOk)} non-200`),
    );
    if (window.tickEveryMs !== null && window.ticks > 0) {
      // Expected count, so a ticker that fired but was throttled by the load is
      // visible as such rather than being read as a full-cadence window.
      const expected = Math.floor(window.wallMs / window.tickEveryMs);
      console.log(
        `  ${''.padEnd(30)} ${String(window.ticks)} of ~${String(expected)} ticks the cadence allows in that window`,
      );
    }
  }
  console.log(
    `  ${''.padEnd(30)} ${'p50'.padStart(10)} ${'p95'.padStart(10)} ` +
      `${'p99'.padStart(10)} ${'max'.padStart(10)}`,
  );
  console.log(`  ${'all routes, no ticks'.padEnd(30)} ${fmtStats(quiescentLoad.overall)}`);
  console.log(`  ${'all routes, ticking'.padEnd(30)} ${fmtStats(contendedLoad.overall)}`);
  const quiescentOverall = quiescentLoad.overall;
  if (quiescentOverall !== null) {
    // How many requests the tick actually hurt, counted rather than inferred
    // from a percentile: a request slower than everything the quiescent window
    // produced at p99 is one the poll plausibly delayed.
    const delayed = contendedLoad.samples.filter((ms) => ms > quiescentOverall.p99Ms).length;
    const share =
      contendedLoad.requests === 0
        ? 'n/a'
        : `${((delayed / contendedLoad.requests) * 100).toFixed(2)}%`;
    console.log(
      `  ${'requests past quiescent p99'.padEnd(30)} ${String(delayed).padStart(10)}   ` +
        `${share} of the ticking window (${fmtMs(quiescentOverall.p99Ms)} threshold)`,
    );
  }
  const perRouteQuiescent = new Map(quiescentLoad.perRoute);
  for (const [label, stats] of contendedLoad.perRoute) {
    console.log(
      `  ${`${label} (no ticks)`.padEnd(30)} ${fmtStats(perRouteQuiescent.get(label) ?? null)}`,
    );
    console.log(`  ${`${label} (ticking)`.padEnd(30)} ${fmtStats(stats)}`);
  }

  console.log('\n## storage');
  for (const [name, count] of rows) {
    console.log(`  ${name.padEnd(30)} ${String(count).padStart(10)} rows`);
  }
  console.log(`  ${'synthetic corpus on disk'.padEnd(30)} ${fmtBytes(onDisk).padStart(10)}`);
  console.log(`  ${'database on disk'.padEnd(30)} ${fmtBytes(bytes).padStart(10)}`);
  if (onDisk > 0) {
    // What the dashboard costs to keep, as a fraction of what it observes. A
    // local-first tool that stores a sizeable multiple of the transcripts it
    // reads is a disk-usage problem the user did not ask for.
    console.log(
      `  ${'db as % of corpus'.padEnd(30)} ${`${((bytes / onDisk) * 100).toFixed(1)} %`.padStart(10)}`,
    );
  }
  if (discovered > 0) {
    console.log(`  ${'bytes per session'.padEnd(30)} ${fmtBytes(bytes / discovered).padStart(10)}`);
  }
  console.log(`  ${'peak rss'.padEnd(30)} ${fmtBytes(process.memoryUsage().rss).padStart(10)}`);

  console.log('\n## projection to full corpus scale - LINEAR, NOT MEASURED');
  if (discovered === 0) {
    console.log('  no sessions were discovered; there is nothing to project from.');
  } else if (discovered >= REAL_CORPUS_SESSIONS) {
    console.log(
      `  ${String(discovered)} sessions discovered, at or past the ${String(REAL_CORPUS_SESSIONS)} ` +
        'Phase-0 counted in the real corpus - the figures above are measured, not projected.',
    );
  } else {
    // Stated as a projection in the heading and again here, because an
    // unlabelled extrapolation is exactly the kind of number this project
    // exists to refuse. Linear scaling assumes per-session cost is constant;
    // that holds only while nothing in the ingest path is superlinear in corpus
    // size, so these are a FLOOR on the real cost, not a prediction of it.
    const scale = REAL_CORPUS_SESSIONS / discovered;
    console.log(
      `  scaling ${String(discovered)} -> ${String(REAL_CORPUS_SESSIONS)} sessions ` +
        `(x${scale.toFixed(1)}) at constant per-session cost:`,
    );
    console.log(`  ${'corpus'.padEnd(30)} ${fmtBytes(onDisk * scale).padStart(10)}`);
    console.log(`  ${'cold replay (startup)'.padEnd(30)} ${fmtMs(cold.ms * scale).padStart(10)}`);
    console.log(`  ${'warm tick (per poll)'.padEnd(30)} ${fmtMs(warm.ms * scale).padStart(10)}`);
    // The measured stall is the tick's synchronous span, so it scales on the
    // same (linear, unproven) assumption as the tick itself - and it is the
    // figure that decides whether a poll is felt by anything waiting (L-26).
    console.log(
      `  ${'warm tick stall (loop delay)'.padEnd(30)} ${fmtMs(warm.loop.maxMs * scale).padStart(10)}` +
        (warm.loop.samples === 0 ? '   (nothing measured to project from)' : ''),
    );
    console.log(`  ${'database on disk'.padEnd(30)} ${fmtBytes(bytes * scale).padStart(10)}`);
    console.log(
      `  ${'warm duty cycle'.padEnd(30)} ` +
        `${`${(((warm.ms * scale) / DEFAULT_POLL_INTERVAL_MS) * 100).toFixed(1)} %`.padStart(10)}` +
        `   of a ${String(DEFAULT_POLL_INTERVAL_MS)} ms poll`,
    );
  }

  console.log('\n## correctness of the run');
  if (summary === null) {
    // The outcome kind is printed rather than a bare "null": a bench whose cold
    // replay ingested nothing is void either way, but WHY it was void ('no
    // corpus root' vs 'read-error') is the difference between a mis-pointed run
    // and a broken one.
    console.log(
      `  cold replay ingested nothing (${cold.value.kind}) - the numbers above are void.`,
    );
  } else {
    console.log(
      `  discovered ${String(summary.sessionsDiscovered)}, ok ${String(summary.sessionsOk)}, ` +
        `failed ${String(summary.sessionsFailed)}, skipped ${String(summary.sessionsSkipped)}`,
    );
    console.log(
      `  agents ${String(summary.agentsUpserted)}, edges ${String(summary.edgesInserted)}, ` +
        `usage rows ${String(summary.usageRowsInserted)}`,
    );
  }
  console.log(`  ingest events ${String(events)}, ingest failures ${String(failures)}`);
  for (const failure of firstFailures) {
    console.log(`    ! ${failure}`);
  }

  await app.close();
  watcher.stop();
  db.close();
  if (keep) {
    console.log(`\nkept: ${workDir}`);
  } else {
    rmSync(workDir, { recursive: true, force: true });
  }
}

await main();
