/**
 * Corpus-scale benchmark - does the ingest loop survive a real-size corpus?
 *
 * Every performance claim about this project so far is an extrapolation from a
 * seven-fixture set of ~10-record transcripts. The product's whole value
 * proposition ("open the dashboard, understand a session") dies if the startup
 * replay over a real-size corpus takes minutes. This harness measures it
 * instead of assuming it.
 *
 * NO NUMBER THIS FILE PRINTS IS BAKED IN. There is no stored baseline here and
 * there deliberately is not one: a checked-in reference run rots the moment the
 * machine, the load or the source changes, and two earlier drafts of this file
 * carried figures that were re-measured and found wrong on every value. What
 * the file does instead is print, on every run, the provenance a figure needs
 * to be reproducible - Node version, platform, core count, the load average
 * sampled around each phase, the corpus's origin, and a digest of the query
 * source the cost phase went through. Compare two RUNS; never compare a run
 * against a sentence in a comment.
 *
 * The only measured numbers stated in these comments are the ones taken from
 * `spike/corpus/` (five real sessions, committed to this repo, read as files by
 * the author of this comment and not by the harness) and from the census of
 * record in `docs/analysis/parser-spec.md` §4.2. Both are cited where used.
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
 *   7. cost summary     - `GET /api/cost/summary` on its own, repeatedly, with
 *                         warm-ups discarded and the spread reported, because
 *                         it is the most expensive read this server serves and
 *                         a single number for it would be a claim, not a
 *                         measurement (review L-26 / M-19). Its scale is
 *                         reported in BOTH units that decide the answer -
 *                         `token_usage` rows and distinct
 *                         (session x model x day) groups - since a
 *                         row-scanning read and a group-reading read sit on
 *                         opposite sides of that ratio, and quoting one of
 *                         them would flatter or damn the wrong implementation.
 *   8. tick vs read     - what an IN-FLIGHT cost-summary read does to a poll
 *                         tick whose deadline falls inside it. A tick is
 *                         scheduled a short lead ahead, the read is issued in
 *                         the same turn, and the tick's LATENESS is measured
 *                         against a baseline arm with an empty loop under it.
 *                         This is the phase that separates "a slow endpoint"
 *                         from "a stalled server": the same lateness is paid
 *                         by every other timer on this loop, the SSE
 *                         heartbeat included.
 *
 * SAFETY: the corpus is synthesised into a throwaway `mkdtemp` directory and
 * the real `~/.claude/projects` is asserted to be somewhere else before a
 * single byte is written. This harness never reads the real corpus - not even
 * read-only, because a benchmark that mutates nothing can still leak content
 * into stdout.
 *
 * CORPUS PROVENANCE - the single most important line in this file:
 *
 *   The corpus is SYNTHETIC and it is INGESTED, not inserted. Those are two
 *   separate claims and both matter.
 *
 *   SYNTHETIC: every byte is generated by {@link plantSession} from the seven
 *   in-repo test fixtures, re-salted per clone and padded to real-corpus
 *   volume. It is NOT a copy of anyone's transcripts, and it is NOT the real
 *   `~/.claude/projects` - which this harness refuses to point at
 *   ({@link assertSynthetic}) and never reads at all, not even read-only,
 *   because a benchmark that mutates nothing can still leak content to stdout.
 *   What follows is that the DISTRIBUTION is invented: record shapes repeat
 *   with a period of seven, so anything in the ingest or query path that is
 *   sensitive to real-world variety (branchiness, tool mix, message-id
 *   collision rate, day spread) is being fed a friendlier input than reality.
 *   Numbers from this harness are therefore a LOWER BOUND on real cost.
 *
 *   INGESTED: nothing is written to the database directly. The bytes are
 *   written to disk as `.jsonl` in the real on-disk layout and then read back
 *   through the real `createCorpusWatcher` -> parser -> projection path, so
 *   what is timed is the product's own ingest, not a fixture loader. This is
 *   the difference between this harness and a seeded-rows benchmark, and a
 *   seeded-rows benchmark would answer none of the questions above.
 *
 * FIDELITY, stated honestly:
 *   - Structural shape (agents, tool_use blocks, sidechains, edges) is drawn
 *     from the seven synthetic fixtures. VOLUME is not: each main transcript is
 *     inflated toward the record count and byte size measured on the in-repo
 *     `spike/corpus/` sessions, because at fixture size - 4-8 records of
 *     361-571 B, measured across the seven fixtures in the registry - this
 *     harness would report a parse throughput no real corpus ever sees.
 *   - The inflated records are structurally inert - plain user/assistant turns
 *     with real usage buckets and no tool_use - so they add parse and cost
 *     volume without inventing graph structure the fixtures did not assert.
 *   - Every identifier is re-salted per clone, so the N sessions are genuinely
 *     distinct rows rather than N idempotent replays of one session.
 *   - Models are remapped onto the REAL seeded price ids, so the cost engine
 *     runs its real exact-match lookup rather than a synthetic bypass.
 *   - The default run is sized to reach the documented real session count for
 *     real (see {@link REAL_CORPUS_SESSIONS} - it is 141, not 1855), so the
 *     projection heading has nothing left to extrapolate. Ask for FEWER
 *     sessions and it reappears, labelled LINEAR, NOT MEASURED, because that
 *     is what it is: a floor, not a measurement.
 *   - `--sessions` counts CLONES, not sessions: one fixture in the registry
 *     plants sidechain files only, so a few clones are legitimately never
 *     enumerated as sessions. The run prints both counts.
 *
 * Usage:  pnpm --filter @agenthropic/server bench [-- --sessions=N]
 *         [--contention-ms=24000] [--concurrency=4] [--tick-every-ms=3000]
 *         [--cost-iterations=5] [--cost-warmups=1] [--keep]
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
import { availableParallelism, homedir, loadavg, tmpdir } from 'node:os';
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

/**
 * Sessions in the real corpus, and the scale every projection here targets.
 *
 * IT IS 141, NOT 1855. Two earlier drafts of this file used 1855 and called it
 * a session count; it is not one, and `docs/analysis/parser-spec.md` §4.2 - the
 * census of record - says so in as many words: "1855 counts subagent
 * TRANSCRIPTS, one per `agent-<hex>.jsonl` file - the session count is 141, of
 * which 54 have any subagent at all. Conflating the two turns a per-file rate
 * into a per-session claim roughly thirteen times larger than reality."
 *
 * The projection at the end of this run multiplies measured per-session costs
 * by (target / discovered), so the wrong constant here inflated every projected
 * figure by ~13x. That is the entire reason this constant is documented at this
 * length rather than being a bare number.
 */
const REAL_CORPUS_SESSIONS = 141;
/**
 * Subagent transcripts in the same corpus - carried ONLY so the number that
 * caused the confusion above has a correctly-labelled home, and so the printed
 * output can name both units. Nothing scales by it.
 */
const REAL_CORPUS_SUBAGENT_TRANSCRIPTS = 1855;
/**
 * A fixture that plants no root-level `<uuid>.jsonl` and therefore contributes
 * files the watcher correctly never enumerates as a session. `usage-dedup` is
 * that case on purpose - a session whose only transcript is a sidechain is a
 * real corpus shape - so a clone of it inflates the corpus without adding a
 * session, and every count in this harness has to know which of the two it is
 * talking about.
 */
function isSidechainOnly(fixture: Fixture): boolean {
  return !fixture.files.some((file) => !file.relativePath.includes('/'));
}

/**
 * How many of `clones` round-robin clones carry a root transcript, i.e. how
 * many sessions the watcher should discover. Counted by walking the same
 * assignment the planting loop uses rather than by arithmetic on a ratio, so
 * it stays exact when the fixture registry changes.
 */
function sessionCarryingClones(fixtures: readonly Fixture[], clones: number): number {
  let count = 0;
  for (let i = 0; i < clones; i += 1) {
    const fixture = fixtures[i % fixtures.length];
    if (fixture !== undefined && !isSidechainOnly(fixture)) {
      count += 1;
    }
  }
  return count;
}

/** The fewest clones whose session-carrying subset reaches `target` sessions. */
function clonesForSessions(target: number): number {
  const fixtures = listFixtures().map((name) => getFixture(name));
  if (fixtures.length === 0 || fixtures.every(isSidechainOnly)) {
    throw new Error('no fixture plants a root transcript: no clone could become a session');
  }
  let clones = 0;
  while (sessionCarryingClones(fixtures, clones) < target) {
    clones += 1;
  }
  return clones;
}

/**
 * Default clone count: the fewest clones that put the run AT the census scale
 * of {@link REAL_CORPUS_SESSIONS} discovered sessions, rather than at some
 * round number the projection then has to extrapolate from. A measured figure
 * at the target scale is worth more than a linear guess toward it, and the
 * projection section prints a projection only while the run falls short.
 *
 * It is also sized to COMPLETE, which is the property that makes a benchmark
 * worth more than a bigger one that never ran: at the per-session shape below
 * this is a corpus of roughly a gigabyte on disk, written and replayed in a
 * couple of minutes on a machine that is also doing other work. Lower it with
 * `--sessions` on a small disk; the run prints the load average it measured
 * under either way.
 */
const DEFAULT_SESSIONS = clonesForSessions(REAL_CORPUS_SESSIONS);
/** Real corpora fan out across many project directories; enumeration walks each. */
const DEFAULT_PROJECTS = 24;
/**
 * Per-session shape, calibrated against the five REAL sessions committed to
 * this repo under `spike/corpus/sessions/` (WP-S1). Counting every `.jsonl`
 * under each session directory - main transcript plus its subagents - those
 * five measure:
 *
 *     records   559 | 1805 | 3368 | 4318 | 5911     (median 3368)
 *     B/record 3537 | 3591 | 4320 | 4808 | 5399     (median 4320)
 *
 * Each row is sorted on its own, so a column is NOT a session: the two axes do
 * not correlate in this sample (the 559-record session is the second-heaviest
 * per record, the 5911-record one the lightest). Read each row as a range.
 *
 * Stated plainly, because it is a choice and not a fit: the defaults below sit
 * INSIDE that range but BELOW its median, on both axes. That is deliberate -
 * the median session times a session count worth benchmarking is a corpus this
 * harness could not replay in a sitting - and it means the per-session figures
 * this run prints are LIGHTER than a median real session, not heavier. What the
 * defaults do buy is the distance from the fixtures' own 4-8 records of
 * 361-571 B - roughly three orders of magnitude of per-transcript volume, and
 * the gap in which every reassuring fixture-scale timing has been hiding.
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
 * PROVISIONAL, and load-bearing in both directions. Omit either side and the
 * phase reports roughly the sampler's own period for a cold replay that in
 * fact blocked the loop for tens of seconds - a number that looks like a
 * measurement and is the instrument describing itself. No figures for that
 * failure are quoted here, because the two earlier drafts that quoted them
 * were both re-measured and found wrong; run the harness and compare the cold
 * replay's sampled max against its wall time to see the working instrument.
 * Both sides are needed:
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
 * Sampling period the COST phase gives its histogram, in ms (review L-26).
 *
 * {@link LOOP_DELAY_RESOLUTION_MS} is 10 ms because it was chosen against a
 * read that blocked the loop for whole seconds, where a 10 ms period is three
 * orders of magnitude finer than the thing being measured. That is no longer
 * the case: on the rollup-backed read this phase measures single-digit
 * milliseconds, and a 10 ms sampler cannot resolve a 2 ms stall at all - it
 * reports its own period back and the number looks like a measurement. So this
 * phase samples at 1 ms, the finest period that is still a whole timer tick,
 * and the printed output names the resolution it used so two runs are never
 * compared across two different instruments.
 *
 * The other phases keep the coarser constant deliberately: they are unchanged
 * by this lane, and re-sampling them finer would move their numbers for a
 * reason that has nothing to do with the server.
 */
const COST_LOOP_DELAY_RESOLUTION_MS = 1;

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
 * Measured `GET /api/cost/summary` iterations, and how many leading ones are
 * thrown away first (review L-26). PROVISIONAL, and chosen against the cost of
 * being wrong in each direction: at real corpus scale one iteration of the
 * cost phase costs an ingest tick plus a read, so five measured plus one
 * discarded is about a minute - cheap enough that nobody is tempted to quote a
 * single shot, large enough that min/p50/max says something about the spread.
 * It is NOT enough for a percentile: this harness prints the raw per-iteration
 * numbers underneath the summary so the denominator is never hidden behind a
 * statistic it cannot support.
 *
 * One warm-up is discarded because the FIRST read on a fresh connection pays
 * costs no later read pays - SQLite page cache cold, statements unprepared,
 * V8 unwarmed - and a run that reported it as one of five would report a
 * distribution with a shape the server never has after its first click.
 */
const DEFAULT_COST_ITERATIONS = 5;
const DEFAULT_COST_WARMUPS = 1;

/**
 * How far ahead the poll tick is scheduled in the tick-vs-read phase, in ms
 * (review L-26). PROVISIONAL. The deadline has to fall INSIDE the read for the
 * phase to measure anything at all, so the lead must be SHORTER than the read -
 * and the read's length is exactly what changes when the implementation
 * changes, which is the case this benchmark has to survive. A fixed lead would
 * therefore silently stop measuring the moment the read got fast: schedule the
 * deadline past the end of the read and both arms measure an idle loop, so
 * they come out indistinguishable for a reason that has nothing to do with
 * contention. (No before-and-after figures are quoted for that; earlier drafts
 * of this file quoted such numbers and every one of them was later re-measured
 * and found wrong.)
 *
 * So the lead is DERIVED, per run, from the median read the phase before
 * actually measured: a quarter of it, floored at 1 ms (a timer cannot usefully
 * be scheduled closer) and capped here (past a few sampling periods a longer
 * lead only adds idle waiting). A quarter puts the deadline early enough in the
 * read that the tick is blocked for most of it, while leaving room for the read
 * to come in shorter than its median without the deadline escaping.
 *
 * Both arms use the SAME lead, so the lead cancels out of the comparison; it
 * decides only whether the experiment's premise holds, never its result. If the
 * read is so short that even a 1 ms lead lands outside it, the arms overlap and
 * the printed verdict refuses the comparison rather than reporting jitter as a
 * finding.
 */
const TICK_LEAD_MAX_MS = 20;
const TICK_LEAD_FRACTION = 4;

/**
 * Smallest lateness gap between the two arms that this phase will call a
 * result, in ms (review L-26). PROVISIONAL. A libuv timer is not accurate to
 * better than roughly a millisecond even on an idle loop - the timers phase is
 * entered when the loop gets there, not when the deadline passes - so a gap
 * below this is arithmetic on two numbers that were never that precise. The
 * printed verdict takes the LARGER of this floor and the baseline arm's own
 * observed spread, so on a noisy machine the run's measured jitter raises the
 * bar rather than this constant lowering it.
 */
const TICK_JITTER_FLOOR_MS = 1;

/**
 * What else the machine was doing while a phase ran (review L-26).
 *
 * This is not decoration. Every number the cost and tick phases produce is a
 * wall-clock or event-loop-delay figure, and BOTH of those count time this
 * process spent descheduled by the OS exactly as if SQLite had been holding the
 * stack - they cannot tell the two apart. On a machine running one benchmark
 * that distinction does not arise; on a machine also running three test suites
 * and an editor it dominates, and a read time reported without the load average
 * it was taken under describes the machine at least as much as it describes the
 * read.
 *
 * So the load average is sampled around the measured phases and printed with
 * them, and the run says out loud when the one-minute figure is above the core
 * count - the point past which runnable work is definitely waiting for a core.
 * A reader can then discard a contaminated run instead of quoting it.
 */
interface MachineLoad {
  readonly oneMinute: number;
  readonly cores: number;
}

function machineLoad(): MachineLoad {
  const [oneMinute = 0] = loadavg();
  return { oneMinute, cores: availableParallelism() };
}

function fmtLoad(load: MachineLoad): string {
  return `${load.oneMinute.toFixed(2)} on ${String(load.cores)} cores`;
}

/** True while runnable work is definitely queued for a core somewhere. */
function isContended(load: MachineLoad): boolean {
  return load.oneMinute > load.cores;
}

/**
 * A load average sampled at a named point in the run, kept in order.
 *
 * Every phase gets one, not just the cost phase. A wall-clock or event-loop
 * figure counts time this process spent descheduled by the OS exactly as if
 * SQLite had been holding the stack, and the two cannot be told apart after the
 * fact - so a run that reported a cold replay without saying what else the
 * machine was doing would be reporting the machine. The marks are printed in
 * the provenance section AND inline next to the phase they bracket, so a reader
 * who quotes one table never has to go looking for the conditions it was taken
 * under.
 */
interface LoadMark {
  readonly label: string;
  readonly load: MachineLoad;
}

function markLoad(marks: LoadMark[], label: string): MachineLoad {
  const load = machineLoad();
  marks.push({ label, load });
  return load;
}

/**
 * What this process was, in the terms that decide whether another run is
 * comparable to this one. A timing without its runtime is not reproducible: V8
 * and libuv both change between Node minors, and `process.version` is the
 * cheapest possible way to stop two runs from being compared across them.
 */
function runEnvironment(): ReadonlyArray<readonly [string, string]> {
  return [
    ['node', process.version],
    ['platform', `${process.platform} ${process.arch}`],
    ['cores (availableParallelism)', String(availableParallelism())],
    ['pid', String(process.pid)],
    ['started', new Date().toISOString()],
  ];
}

/** The exact URL the cost phase measures - the route's own default `topN`. */
const COST_SUMMARY_URL = '/api/cost/summary';

/**
 * Provenance of the read this benchmark measures. NOT used to decide anything:
 * nothing in this harness branches on it, and no phase knows what the query
 * layer does inside. It is printed so a number from this run can be pinned to
 * the source that produced it - a cost figure whose implementation is unknown
 * is worse than no figure, because it invites a before/after comparison
 * between two runs that may have measured the same code twice or two different
 * programs once each.
 */
const QUERIES_SOURCE = new URL('../src/api/queries.ts', import.meta.url);

/**
 * The exact `message.model` byte-strings the pricing seed knows, weighted by
 * the counts recorded for the real corpus in
 * `docs/site/architecture/data-model.md` (`claude-opus-4-8` x4819,
 * `claude-sonnet-5` x3286, `claude-fable-5` x1849). That census is quoted, not
 * re-measured here: this harness never reads the real corpus.
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
 * would quietly shrink the benchmark to six of seven shapes.
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
 * Sizing matters as much as counting. `spike/corpus/sessions/` measures
 * 3537-5399 B per record across its five real sessions, roughly an order of
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
 *
 * `nonce` is what makes the call REPEATABLE. The uuid is derived from it, so
 * two calls with different nonces append two distinct records; two calls with
 * the same nonce would append the same uuid twice and the parser would be
 * right to collapse them - which would silently turn a phase that grows the
 * corpus once per iteration into a phase that grows it once.
 */
function growSession(session: PlantedSession, mainPath: string, nonce: string): void {
  const lines = readFileSync(mainPath, 'utf8').trimEnd().split('\n');
  const last = lines[lines.length - 1];
  if (last === undefined) {
    throw new Error(`empty transcript: ${mainPath}`);
  }
  const record = JSON.parse(last) as Record<string, unknown>;
  const previousUuid = record['uuid'];
  const fresh = digest(`grow:${nonce}:${session.sessionId}`, 32);
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

/**
 * `minimum` defaults to 1 because almost every count here is a size that must
 * not be zero. It is 0 for exactly one flag - `--cost-warmups` - where "throw
 * nothing away" is a legitimate request and rejecting it would force the
 * caller to edit the harness to ask a question it already supports.
 */
function intArg(argv: readonly string[], name: string, fallback: number, minimum = 1): number {
  const hit = argv.find((arg) => arg.startsWith(`--${name}=`));
  if (hit === undefined) {
    return fallback;
  }
  const value = Number.parseInt(hit.slice(name.length + 3), 10);
  if (!Number.isFinite(value) || value < minimum) {
    throw new Error(`--${name} must be an integer >= ${String(minimum)}, got: ${hit}`);
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

/**
 * {@link timeWithLoopDelay} for a phase that has to be awaited - an
 * `app.inject`, i.e. a request served through the real route (review L-26).
 *
 * The seed and settle sleeps are there for the same two reasons and are just
 * as mandatory. One caveat this variant carries that the synchronous one does
 * not: an awaited phase MAY yield, and every turn it yields the sampler gets to
 * fire against an idle loop. So `mean` here is diluted by however much of the
 * phase was not blocking, and only `max` (and, with enough samples, `p99`) is
 * a statement about the stall. That is the honest reading for a Fastify route
 * whose handler is synchronous better-sqlite3 work sandwiched between two
 * awaits: the await boundaries are idle, the handler is not.
 */
async function timeAsyncWithLoopDelay<T>(
  fn: () => Promise<T>,
  resolutionMs: number = LOOP_DELAY_RESOLUTION_MS,
): Promise<{ readonly ms: number; readonly value: T; readonly loop: LoopDelay }> {
  const histogram = monitorEventLoopDelay({ resolution: resolutionMs });
  histogram.enable();
  await sleep(LOOP_DELAY_SETTLE_MS); // seed the sampler; see LOOP_DELAY_SETTLE_MS
  const started = performance.now();
  const value = await fn();
  const ms = performance.now() - started;
  await sleep(LOOP_DELAY_SETTLE_MS); // let the overdue sample record the stall
  histogram.disable();
  return { ms, value, loop: readLoopDelay(histogram) };
}

/**
 * Min / median / max over a handful of iterations, in ms (review L-26).
 *
 * Deliberately NOT {@link LatencyStats}: that type answers "what does the tail
 * look like" over hundreds of samples, and a p95 over five iterations is the
 * fifth iteration wearing a statistic's clothes. This type answers the only
 * question five iterations can answer - how far apart the runs were - and
 * `count` travels with it so the reader can see that for themselves.
 */
interface Spread {
  readonly count: number;
  readonly minMs: number;
  readonly medianMs: number;
  readonly maxMs: number;
}

function spreadOf(samples: readonly number[]): Spread | null {
  if (samples.length === 0) {
    return null; // nothing ran; the caller prints "not measured", never zeros
  }
  const sorted = [...samples].sort((a, b) => a - b);
  // Nearest-rank median, as everywhere else here: an interpolated middle over
  // an even count is a value no iteration produced.
  const median = sorted[Math.ceil(sorted.length / 2) - 1] ?? Number.NaN;
  return {
    count: sorted.length,
    minMs: sorted[0] ?? Number.NaN,
    medianMs: median,
    maxMs: sorted[sorted.length - 1] ?? Number.NaN,
  };
}

function fmtSpread(spread: Spread | null): string {
  if (spread === null) {
    return 'not measured (no iterations)';
  }
  return (
    `${fmtMs(spread.minMs).padStart(10)} ${fmtMs(spread.medianMs).padStart(10)} ` +
    `${fmtMs(spread.maxMs).padStart(10)}   n=${String(spread.count)}`
  );
}

/**
 * The scale a cost read has to cover, in the two units that decide its cost
 * (review L-26). Both are measured off `token_usage` itself with plain SQL, so
 * the numbers describe the DATA and not any particular read implementation -
 * which is the point: a read that scans rows and a read that reads a persisted
 * rollup pay wildly different prices over the same ledger, and a scale line
 * quoting only the row count would make the second look miraculous while a
 * scale line quoting only the group count would make the first look reasonable.
 *
 * The grains are named exactly. (session x model x day) is the grain the
 * summary's four sections are derivable from. The bucket grain is finer and is
 * reported too, because tokens of different buckets price at different rates,
 * so no correct rollup can be coarser than it.
 */
interface CostScale {
  readonly usageRows: number;
  readonly sessionModelDayGroups: number;
  readonly sessionModelBucketDayGroups: number;
  readonly sessions: number;
  readonly models: number;
  readonly days: number;
}

/** The `unknown` day sentinel, matching what the API reports for a null stamp. */
const DAY_EXPR = `CASE WHEN occurred_at IS NULL THEN 'unknown' ELSE substr(occurred_at, 1, 10) END`;

function costScale(db: SqliteDatabase): CostScale {
  const count = (sql: string): number => (db.prepare(sql).get() as { c: number }).c;
  return {
    usageRows: count('SELECT COUNT(*) AS c FROM token_usage'),
    sessionModelDayGroups: count(
      `SELECT COUNT(*) AS c FROM
        (SELECT 1 FROM token_usage GROUP BY session_id, model, ${DAY_EXPR})`,
    ),
    sessionModelBucketDayGroups: count(
      `SELECT COUNT(*) AS c FROM
        (SELECT 1 FROM token_usage GROUP BY session_id, model, bucket, ${DAY_EXPR})`,
    ),
    sessions: count('SELECT COUNT(DISTINCT session_id) AS c FROM token_usage'),
    models: count('SELECT COUNT(DISTINCT model) AS c FROM token_usage'),
    days: count(`SELECT COUNT(DISTINCT ${DAY_EXPR}) AS c FROM token_usage`),
  };
}

/** One `GET /api/cost/summary`, timed end to end through the real route. */
interface CostRead {
  readonly wallMs: number;
  readonly statusCode: number;
  readonly bytes: number;
  /** null when the read was timed WITHOUT a histogram around it - see below. */
  readonly loop: LoopDelay | null;
}

/**
 * Issue one cost summary and time it.
 *
 * `withLoopDelay` is not a convenience switch. The histogram wrapper sleeps on
 * both sides of the phase (it has to - see {@link LOOP_DELAY_SETTLE_MS}), and
 * those sleeps are turns of the event loop. Any timer already scheduled fires
 * during them. In the tick-vs-read phase a timer scheduled inside the read is
 * exactly what is being measured, so that phase must time the read WITHOUT the
 * wrapper or it would hand the tick a free window and measure nothing.
 */
async function readCostSummary(
  app: BenchServer,
  headers: Record<string, string>,
  opts: { readonly withLoopDelay: boolean },
): Promise<CostRead> {
  const request = (): Promise<{ statusCode: number; body: string }> =>
    app.inject({ method: 'GET', url: COST_SUMMARY_URL, headers });
  if (!opts.withLoopDelay) {
    const plain = await timeAsync(request);
    return {
      wallMs: plain.ms,
      statusCode: plain.value.statusCode,
      bytes: Buffer.byteLength(plain.value.body),
      loop: null,
    };
  }
  const shot = await timeAsyncWithLoopDelay(request, COST_LOOP_DELAY_RESOLUTION_MS);
  return {
    wallMs: shot.ms,
    statusCode: shot.value.statusCode,
    bytes: Buffer.byteLength(shot.value.body),
    loop: shot.loop,
  };
}

/** One poll tick that was scheduled, then observed - see {@link tickAfterLead}. */
interface ScheduledTick {
  /** Actual start minus the moment it was due. What every timer here pays. */
  readonly latenessMs: number;
  readonly durationMs: number;
  /** The tick's own outcome kind, so both arms can be shown to be comparable. */
  readonly outcome: string;
}

/**
 * Schedule a poll tick `leadMs` out, optionally run something in the same turn,
 * and report how late the tick actually started (review L-26).
 *
 * This is the whole tick-vs-read experiment. A `setTimeout` is a libuv timer,
 * the same kind the corpus watcher's poll and the SSE heartbeat ride on. If a
 * synchronous read is on the stack when the deadline passes, the timer cannot
 * fire until the read returns, and the gap is the lateness. Run it once with an
 * empty loop underneath and once with a cost read underneath and the difference
 * is what one click costs everything else in the process.
 *
 * The result lands in an ARRAY rather than a captured `let` on purpose: a
 * variable assigned only inside a timer callback is narrowed to its initial
 * type by the compiler, and the wait loop that follows would then be reading a
 * type the value no longer has.
 *
 * The wait is `sleep(1)` rather than a `setImmediate` spin because an immediate
 * resolves in the check phase and a sleep resolves in the timers phase - the
 * same phase the pending tick is waiting in, so the loop cannot outrun it.
 */
async function tickAfterLead(opts: {
  readonly watcher: BenchWatcher;
  readonly leadMs: number;
  readonly inFlight: (() => Promise<void>) | null;
}): Promise<ScheduledTick> {
  const fired: ScheduledTick[] = [];
  const dueAt = performance.now() + opts.leadMs;
  const timer = setTimeout(() => {
    const startedAt = performance.now();
    const outcome = opts.watcher.tick();
    fired.push({
      latenessMs: startedAt - dueAt,
      durationMs: performance.now() - startedAt,
      outcome: outcome.kind,
    });
  }, opts.leadMs);
  if (opts.inFlight !== null) {
    await opts.inFlight();
  }
  while (fired.length === 0) {
    await sleep(1);
  }
  clearTimeout(timer);
  const observed = fired[0];
  if (observed === undefined) {
    throw new Error('scheduled tick reported no result');
  }
  return observed;
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
 * process, and a "contended" window ends up containing no ticks at all.
 *
 * The mechanism was verified directly (Node v22.23.2, darwin arm64, 10 cores,
 * 1-minute load 15.1) with a stand-in for the inject - a `Promise.resolve()`
 * plus a `process.nextTick`, i.e. the two queues an inject actually resolves
 * on - looping for one second against a `setInterval(…, 100)`:
 *
 *     tight loop, no yield      5 787 063 iterations,  0 interval firings
 *     with a setImmediate yield    73 336 iterations, 10 interval firings
 *
 * Zero against ten out of the ten the cadence allows. The iteration counts are
 * the stand-in's, not an inject's, and are quoted only to show both arms ran;
 * the firing counts are the finding. Yielding through the check phase lets the
 * loop reach its timers each turn, which is also what a real HTTP request does -
 * it arrives through the poll phase rather than skipping it. The run guards
 * against a regression here at runtime too: a window that asked for ticks and
 * got none prints as an instrumentation failure, never as a result.
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
  const costIterations = intArg(argv, 'cost-iterations', DEFAULT_COST_ITERATIONS);
  // Minimum 0: discarding nothing is a legitimate thing to ask for here.
  const costWarmups = intArg(argv, 'cost-warmups', DEFAULT_COST_WARMUPS, 0);
  const keep = argv.includes('--keep');

  const workDir = mkdtempSync(join(tmpdir(), 'agenthropic-bench-'));
  const corpusRoot = join(workDir, 'projects');
  const dbPath = join(workDir, 'bench.db');
  assertSynthetic(corpusRoot);
  assertDiskSpace(workDir, sessionCount * records * bytesPerRecord);
  mkdirSync(corpusRoot, { recursive: true });

  const fixtureNames = listFixtures();
  const fixtures = fixtureNames.map((name) => getFixture(name));

  // `--sessions=N` plants N CLONES, and a clone is not always a session: see
  // {@link isSidechainOnly}. The shortfall is exact and predictable, so it is
  // computed and printed next to the request rather than left to surprise a
  // reader at the bottom of the run. Every per-session figure divides by the
  // DISCOVERED count, never by the planted one.
  const sessionClones = sessionCarryingClones(fixtures, sessionCount);

  const loadMarks: LoadMark[] = [];
  const loadAtStart = markLoad(loadMarks, 'before the corpus was built');

  console.log(
    `corpus-scale benchmark: ${String(sessionCount)} clones across ` +
      `${String(projectCount)} projects, from ${String(fixtures.length)} fixtures`,
  );
  console.log(
    `  clones: ${String(sessionCount)} planted, of which ${String(sessionClones)} carry a root ` +
      `transcript and should be discovered as sessions`,
  );
  console.log(
    `  shape:  ${String(records)} records per main transcript at ~${String(bytesPerRecord)} B/record`,
  );
  console.log(`  corpus: ${corpusRoot}`);
  console.log(`  db:     ${dbPath}`);

  // Provenance FIRST, before a single number, so it cannot be scrolled past on
  // the way to a figure. A performance number without its runtime and its
  // contention level is not reproducible, and this section is the whole of what
  // makes the tables below quotable.
  console.log('\n## run provenance');
  for (const [key, value] of runEnvironment()) {
    console.log(`  ${key.padEnd(30)} ${value}`);
  }
  console.log(`  ${'load average at start'.padEnd(30)} ${fmtLoad(loadAtStart)}`);
  console.log(
    `  ${'corpus origin'.padEnd(30)} SYNTHETIC - generated by this harness from ` +
      `${String(fixtures.length)} in-repo fixtures`,
  );
  console.log(`  ${''.padEnd(30)} into ${corpusRoot} and INGESTED from disk through the real`);
  console.log(
    `  ${''.padEnd(30)} watcher/parser/projection path. NOT the real ~/.claude/projects,`,
  );
  console.log(
    `  ${''.padEnd(30)} and NOT rows inserted straight into SQLite. Record shapes repeat`,
  );
  console.log(
    `  ${''.padEnd(30)} with a period of ${String(fixtures.length)}, so real-world variety is absent and`,
  );
  console.log(`  ${''.padEnd(30)} every figure below is a LOWER BOUND on real cost.`);
  if (isContended(loadAtStart)) {
    console.log(
      `  ! load already exceeds the core count before anything ran. Every timing in this run`,
    );
    console.log(
      `    is an UPPER BOUND that includes time the OS spent on other work; treat it as a`,
    );
    console.log(`    ceiling, not as a measurement of this server.`);
  }
  console.log('');

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
  const loadBeforeIngest = markLoad(loadMarks, 'before the ingest phases');
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
  const targetMainPath = target.mainPath;
  growSession(target, targetMainPath, 'incremental');
  const incremental = time(() => watcher.tick());

  const app = buildServer({
    token: BENCH_TOKEN,
    schemaVersion: currentSchemaVersion(db),
    db,
    hub,
    substrateProvider: createSubstrateProvider({ env: { CLAUDE_PROJECTS_DIR: corpusRoot } }),
  });
  const auth = { authorization: `Bearer ${BENCH_TOKEN}` };
  const loadBeforeReads = markLoad(loadMarks, 'before the sequential api reads');
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
  // /api/dag/global) are deliberately NOT in this mix - read the sequential
  // table printed above this one for what each of them costs on THIS run; no
  // figure for them is quoted here, because a benchmark comment is the last
  // place a performance number should live. Every route here is synchronous SQL
  // on one shared loop, so putting a whole-corpus query in the rotation makes
  // every OTHER request in the window queue behind it, and the window then
  // prints one near-identical distribution for all routes in which a tick is
  // invisible. This phase exists to isolate the tick, so it uses only routes
  // whose own work is smaller than a tick. /api/health is in it precisely
  // because its handler does almost nothing: any latency it shows is queueing,
  // not work of its own.
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
  const loadBeforeWindows = markLoad(loadMarks, 'before the concurrent read windows');
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

  // L-26 / M-19. The cost summary is the most expensive read this server
  // serves, and until now the harness timed it ONCE, in the sequential phase
  // above, on a connection that had never served it before. One shot is not a
  // measurement of anything that can regress or improve, which is the whole
  // reason this phase exists: whatever the query layer does today, the number
  // below is reproducible against it.
  //
  // Scale is read off `token_usage` with plain SQL BEFORE the iterations run.
  // Each iteration then appends one message's worth of rows, so the ledger the
  // last read covered is larger than this line by a handful of rows out of the
  // total - stated rather than hidden, and far below any figure printed here.
  const loadBefore = markLoad(loadMarks, 'before the cost + tick-vs-read phases');
  const scale = costScale(db);
  const queriesSource = readFileSync(QUERIES_SOURCE, 'utf8');
  const provenance = {
    sha: digest(queriesSource, 12),
    mentionsRollup: queriesSource.includes('token_usage_rollup'),
  };

  const costReads: CostRead[] = [];
  for (let i = 0; i < costWarmups + costIterations; i += 1) {
    // What makes each read a fresh answer instead of a repeat of the previous
    // one: the corpus GROWS and a tick ingests the growth, exactly as it does
    // on a live server between two dashboard refreshes. No cache is named,
    // cleared or assumed here - any implementation of this endpoint has to
    // produce a new answer once new usage has landed, so this invalidation
    // works against the read that exists today and against whatever replaces
    // it. The grow and the tick are OUTSIDE the timed span.
    growSession(target, targetMainPath, `cost-${String(i)}`);
    watcher.tick();
    const read = await readCostSummary(app, auth, { withLoopDelay: true });
    if (i >= costWarmups) {
      costReads.push(read);
    }
  }
  // The other half of the question, and the one that decides how much the
  // first half hurts in practice: what the SAME read costs when nothing has
  // been written since the last one. A memo can only help here, and comparing
  // the two lines says whether one exists and how wide its window is - without
  // this harness knowing anything about how it is keyed.
  const repeatReads: CostRead[] = [];
  for (let i = 0; i < costIterations; i += 1) {
    repeatReads.push(await readCostSummary(app, auth, { withLoopDelay: true }));
  }

  // L-26. "A slow endpoint" becomes "a stalled server" here: a poll tick is
  // scheduled a short lead ahead in both arms, and in the contended arm a cost
  // read is issued in the same turn so the deadline falls inside it. Both arms
  // measure an UNCHANGED tick - the ingest that makes the read cold happens
  // before the timer is scheduled - so the only difference between them is the
  // read, and the printed outcome kinds let that be checked rather than
  // trusted.
  //
  // The lead is derived from the reads just measured rather than fixed, so the
  // deadline keeps falling inside the read whatever the implementation costs -
  // see TICK_LEAD_MAX_MS. Both arms get the same number, so it cannot bias the
  // comparison; it only decides whether there is a comparison to make.
  const costWallSpread = spreadOf(costReads.map((r) => r.wallMs));
  const tickLeadMs =
    costWallSpread === null
      ? TICK_LEAD_MAX_MS
      : Math.max(
          1,
          Math.min(TICK_LEAD_MAX_MS, Math.round(costWallSpread.medianMs / TICK_LEAD_FRACTION)),
        );
  const baselineTicks: ScheduledTick[] = [];
  const contendedTicks: ScheduledTick[] = [];
  const contendedReads: CostRead[] = [];
  for (let i = 0; i < costWarmups + costIterations; i += 1) {
    const baseline = await tickAfterLead({ watcher, leadMs: tickLeadMs, inFlight: null });
    growSession(target, targetMainPath, `contend-${String(i)}`);
    watcher.tick();
    const readBox: CostRead[] = [];
    const contended = await tickAfterLead({
      watcher,
      leadMs: tickLeadMs,
      inFlight: async () => {
        // Timed without a histogram: the histogram's settle sleeps would give
        // the pending tick a free window to fire in. See readCostSummary.
        readBox.push(await readCostSummary(app, auth, { withLoopDelay: false }));
      },
    });
    const observedRead = readBox[0];
    if (i >= costWarmups) {
      baselineTicks.push(baseline);
      contendedTicks.push(contended);
      if (observedRead !== undefined) {
        contendedReads.push(observedRead);
      }
    }
  }

  const loadAfter = markLoad(loadMarks, 'after every measured phase');

  const summary = tickSummary(cold.value);
  const rows = tableSizes(db);
  const bytes = dbBytes(dbPath);
  const onDisk = corpusBytes(corpusRoot);

  console.log(`## ingest   [1-minute load ${fmtLoad(loadBeforeIngest)} entering this phase]`);
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

  console.log(
    `\n## api reads (sequential, quiescent server - no tick in flight)` +
      `   [1-minute load ${fmtLoad(loadBeforeReads)} entering this phase]`,
  );
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
  console.log(
    `\n## api reads under tick load (concurrent)` +
      `   [1-minute load ${fmtLoad(loadBeforeWindows)} entering this phase]`,
  );
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

  // L-26 / M-19. The cost summary, on its own, repeatedly, at a stated scale.
  console.log('\n## cost summary (GET /api/cost/summary), repeated - review L-26 / M-19');
  console.log(
    `  measured against src/api/queries.ts sha256:${provenance.sha} ` +
      `(contains the string "token_usage_rollup": ${provenance.mentionsRollup ? 'yes' : 'no'})`,
  );
  console.log(
    '  that line is PROVENANCE, not a verdict: it pins these numbers to a source file so',
  );
  console.log(
    '  two runs are never compared without knowing whether they measured the same program.',
  );
  console.log('  the request goes through the real route, so what is timed is whatever the query');
  console.log('  layer does today - this phase knows nothing about how the answer is produced.');
  console.log(
    '  whichever read path that source implements, THIS phase measured THAT path. It is not a',
  );
  console.log(
    '  statement about the product until the source it names is the source the product ships.',
  );
  console.log(
    `  machine load, 1-minute average: ${fmtLoad(loadBefore)} before these phases, ` +
      `${fmtLoad(loadAfter)} after.`,
  );
  if (isContended(loadBefore) || isContended(loadAfter)) {
    // Loud, because the alternative is a plausible-looking number that is
    // mostly other people's work. Wall time and event-loop delay both count
    // descheduled time; neither can distinguish it from a blocked loop.
    console.log(
      '  CONTAMINATED: load exceeded the core count, so this process was competing for CPU.',
    );
    console.log(
      '  Every figure below is an UPPER BOUND that includes time the OS spent running other',
    );
    console.log(
      '  work - wall time and event-loop delay both count descheduled time and cannot tell it',
    );
    console.log('  apart from a blocked loop. Re-run on an idle machine before quoting these.');
  }
  const groupRatio =
    scale.sessionModelDayGroups === 0
      ? 'n/a'
      : `${(scale.usageRows / scale.sessionModelDayGroups).toFixed(1)}x`;
  console.log('  scale of the ledger this read covers:');
  console.log(`    ${'token_usage rows'.padEnd(42)} ${String(scale.usageRows).padStart(12)}`);
  console.log(
    `    ${'distinct (session x model x day) groups'.padEnd(42)} ` +
      `${String(scale.sessionModelDayGroups).padStart(12)}   ${groupRatio} fewer than rows`,
  );
  console.log(
    `    ${'distinct (session x model x bucket x day)'.padEnd(42)} ` +
      `${String(scale.sessionModelBucketDayGroups).padStart(12)}   finest grain a rollup may use`,
  );
  console.log(
    `    ${'distinct sessions / models / days'.padEnd(42)} ` +
      `${`${String(scale.sessions)} / ${String(scale.models)} / ${String(scale.days)}`.padStart(12)}`,
  );
  console.log(
    '  BOTH scales are printed because they decide different implementations: a read that',
  );
  console.log(
    '  scans the ledger pays the row count, a read backed by a persisted rollup pays the',
  );
  console.log(
    '  group count. Quoting one of them alone would misrepresent the other implementation.',
  );
  console.log(
    `  discipline: ${String(costWarmups)} warm-up iteration(s) discarded, ` +
      `${String(costIterations)} measured. Before EACH measured read one session grows by`,
  );
  console.log(
    '  one record and one tick ingests it (both outside the timed span), so no read can be',
  );
  console.log('  served as a repeat of the one before it.');
  console.log(
    `  ${''.padEnd(38)} ${'min'.padStart(10)} ${'median'.padStart(10)} ${'max'.padStart(10)}`,
  );
  console.log(
    `  ${'wall time, after new ingest'.padEnd(38)} ` +
      `${fmtSpread(spreadOf(costReads.map((r) => r.wallMs)))}`,
  );
  console.log(
    `  ${'event-loop delay max, same reads'.padEnd(38)} ` +
      `${fmtSpread(spreadOf(costReads.flatMap((r) => (r.loop === null ? [] : [r.loop.maxMs]))))}`,
  );
  console.log(
    `  ${'event-loop delay p99, same reads'.padEnd(38)} ` +
      `${fmtSpread(spreadOf(costReads.flatMap((r) => (r.loop === null ? [] : [r.loop.p99Ms]))))}`,
  );
  console.log(
    `  ${'wall time, repeat (nothing written)'.padEnd(38)} ` +
      `${fmtSpread(spreadOf(repeatReads.map((r) => r.wallMs)))}`,
  );
  console.log(
    `  instrument: monitorEventLoopDelay at ${String(COST_LOOP_DELAY_RESOLUTION_MS)} ms resolution, one histogram per read;`,
  );
  console.log(
    `  every sample carries that ${String(COST_LOOP_DELAY_RESOLUTION_MS)} ms period, and the mean is diluted by the idle await`,
  );
  console.log('  boundaries around the handler - max is the number that describes the stall.');
  const loopMaxSpread = spreadOf(costReads.flatMap((r) => (r.loop === null ? [] : [r.loop.maxMs])));
  if (loopMaxSpread !== null && loopMaxSpread.maxMs < 2 * COST_LOOP_DELAY_RESOLUTION_MS) {
    // The instrument reporting its own period is not a measurement of the
    // server, and it is the easiest number in this whole file to quote by
    // mistake: it is small, stable across iterations, and looks like a result.
    console.log(
      `  AT THE INSTRUMENT'S FLOOR: every sample carries the sampler's own` +
        ` ${String(COST_LOOP_DELAY_RESOLUTION_MS)} ms period, and the`,
    );
    console.log(
      `  largest delay seen (${fmtMs(loopMaxSpread.maxMs)}) is within two of them. A stall shorter than the`,
    );
    console.log(
      '  sampling period cannot be resolved, so these two rows describe the INSTRUMENT, not the',
    );
    console.log(
      '  read - the wall-time row above is the honest one at this scale. This is the expected',
    );
    console.log(
      '  reading when the read is genuinely fast; it becomes a real measurement again once the',
    );
    console.log('  read is long enough to hold the loop for several sampling periods.');
  }
  // The raw iterations, printed underneath the summary. Five samples cannot
  // support a percentile, and a reader who can see the five values can tell
  // for themselves whether the median above means anything.
  console.log('  raw iterations (wall / loop-delay max / status / response bytes):');
  for (const [index, read] of costReads.entries()) {
    console.log(
      `    #${String(index + 1).padEnd(3)} ${fmtMs(read.wallMs).padStart(10)} ` +
        `${(read.loop === null ? 'n/a' : fmtMs(read.loop.maxMs)).padStart(10)}   ` +
        `HTTP ${String(read.statusCode)}   ${fmtBytes(read.bytes)}`,
    );
  }
  const costSpread = costWallSpread;
  if (costSpread !== null && costSpread.minMs > 0) {
    console.log(
      `  spread: max is ${(costSpread.maxMs / costSpread.minMs).toFixed(2)}x min across ` +
        `${String(costSpread.count)} iterations - read the raw lines above before quoting the median.`,
    );
  }
  const nonOkCostReads = [...costReads, ...repeatReads, ...contendedReads].filter(
    (read) => read.statusCode !== 200,
  ).length;
  if (nonOkCostReads > 0) {
    // A phase that timed error responses timed the error path, not the read.
    console.log(
      `  ! ${String(nonOkCostReads)} of the cost reads did not return HTTP 200 - these timings are VOID.`,
    );
  }
  if (discovered < REAL_CORPUS_SESSIONS) {
    console.log(
      `  NOT at real corpus scale: ${String(discovered)} sessions discovered against the ` +
        `${String(REAL_CORPUS_SESSIONS)} in the census of record.`,
    );
    console.log(
      '  Do NOT scale these figures up. The cost of this read depends on the rows:groups ratio',
    );
    console.log(
      '  above, and that ratio is a property of the corpus, not a constant - re-run with',
    );
    console.log(
      `  --sessions=${String(DEFAULT_SESSIONS)} (the default, which reaches ` +
        `${String(REAL_CORPUS_SESSIONS)} sessions) to get a real-scale figure, and quote that one instead.`,
    );
  }

  // L-26. The concurrent-injection phase: a poll tick's deadline inside a read.
  console.log('\n## ingest tick vs an in-flight cost read (concurrent) - review L-26');
  console.log(
    `  each iteration schedules a poll tick ${String(tickLeadMs)} ms out, twice: once with an empty loop`,
  );
  console.log(
    `  underneath it, once with a cost-summary read issued in the same turn. The lead is a` +
      ` quarter`,
  );
  console.log(
    `  of the median read above (capped at ${String(TICK_LEAD_MAX_MS)} ms) so the deadline falls INSIDE the read at` +
      ` any scale;`,
  );
  console.log('  both arms use it, so it cannot bias the comparison. Lateness is');
  console.log(
    '  when the tick actually started minus when it was due - the wait a libuv timer pays',
  );
  console.log(
    '  while a synchronous read holds the stack. The poll is not the only such timer: the',
  );
  console.log('  SSE heartbeat is one too, and it pays the same lateness on the same loop.');
  console.log(
    `  ${''.padEnd(38)} ${'min'.padStart(10)} ${'median'.padStart(10)} ${'max'.padStart(10)}`,
  );
  const baselineLateness = spreadOf(baselineTicks.map((t) => t.latenessMs));
  const contendedLateness = spreadOf(contendedTicks.map((t) => t.latenessMs));
  console.log(`  ${'tick lateness, nothing in flight'.padEnd(38)} ${fmtSpread(baselineLateness)}`);
  console.log(
    `  ${'tick lateness, cost read in flight'.padEnd(38)} ${fmtSpread(contendedLateness)}`,
  );
  console.log(
    `  ${'tick duration, nothing in flight'.padEnd(38)} ` +
      `${fmtSpread(spreadOf(baselineTicks.map((t) => t.durationMs)))}`,
  );
  console.log(
    `  ${'tick duration, cost read in flight'.padEnd(38)} ` +
      `${fmtSpread(spreadOf(contendedTicks.map((t) => t.durationMs)))}`,
  );
  console.log(
    `  ${'the in-flight read itself (wall)'.padEnd(38)} ` +
      `${fmtSpread(spreadOf(contendedReads.map((r) => r.wallMs)))}`,
  );
  // Both arms have to be the same KIND of tick or the comparison is between
  // two different amounts of work, not between two loop conditions.
  const kinds = (ticks: readonly ScheduledTick[]): string =>
    ticks.length === 0 ? 'none' : [...new Set(ticks.map((t) => t.outcome))].sort().join(', ');
  console.log(
    `  tick outcomes: baseline [${kinds(baselineTicks)}], contended [${kinds(contendedTicks)}]` +
      ' - the arms are only comparable while these match.',
  );
  if (baselineLateness === null || contendedLateness === null) {
    console.log('  no iterations ran; there is nothing to compare.');
  } else if (
    contendedLateness.minMs - baselineLateness.maxMs <
    Math.max(TICK_JITTER_FLOOR_MS, baselineLateness.maxMs - baselineLateness.minMs)
  ) {
    // The refusal is the result. A delta between two overlapping distributions
    // over a handful of iterations is noise wearing a finding's clothes - and
    // so is a delta that clears them by less than the run's own jitter. The
    // margin has to beat BOTH a fixed floor (a libuv timer is not accurate to
    // better than about a millisecond, so a smaller gap is not a measurement)
    // and the spread the baseline arm showed with nothing to contend with,
    // which is this machine's noise measured on this run rather than assumed.
    console.log('  NOT RESOLVED at this scale: the gap between the arms');
    console.log(
      `  (${fmtMs(contendedLateness.minMs - baselineLateness.maxMs)} between the fastest contended` +
        ` tick and the slowest baseline one) does not clear`,
    );
    console.log(
      `  this run's own jitter (baseline spread ${fmtMs(baselineLateness.maxMs - baselineLateness.minMs)},` +
        ` floor ${fmtMs(TICK_JITTER_FLOOR_MS)}). Do NOT quote a delta`,
    );
    console.log('  from this run - re-run at a larger --sessions, where the read is longer.');
  } else {
    console.log(
      `  separated: every contended tick was at least ` +
        `${fmtMs(contendedLateness.minMs - baselineLateness.maxMs)} later than the latest baseline`,
    );
    console.log(
      '  tick, i.e. one cost-summary click delays the next poll (and the heartbeat) by about the',
    );
    console.log("  read's own duration, minus the lead it was scheduled with.");
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
  console.log(
    `  target scale is ${String(REAL_CORPUS_SESSIONS)} SESSIONS - the census of record in`,
  );
  console.log(
    `  docs/analysis/parser-spec.md §4.2. The ${String(REAL_CORPUS_SUBAGENT_TRANSCRIPTS)} often quoted for this corpus counts`,
  );
  console.log(
    '  subagent TRANSCRIPTS, one per agent-<hex>.jsonl, and projecting per-session costs by it',
  );
  console.log('  overstates them roughly thirteenfold. Two earlier drafts of this file did that.');
  if (discovered === 0) {
    console.log('  no sessions were discovered; there is nothing to project from.');
  } else if (discovered >= REAL_CORPUS_SESSIONS) {
    console.log(
      `  ${String(discovered)} sessions discovered, at or past the ${String(REAL_CORPUS_SESSIONS)} ` +
        'in the census of record - the figures above are measured, not projected.',
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

  // The contention record for the WHOLE run, in one place. Repeated here rather
  // than only inline because this is the section a reader checks before quoting
  // anything above it, and because a run whose load climbed midway is a run
  // whose later phases are not comparable to its earlier ones.
  console.log('\n## contention record (1-minute load average, sampled per phase)');
  for (const mark of loadMarks) {
    console.log(
      `  ${mark.label.padEnd(42)} ${fmtLoad(mark.load).padStart(22)}` +
        (isContended(mark.load) ? '   ! over core count' : ''),
    );
  }
  const contendedMarks = loadMarks.filter((mark) => isContended(mark.load));
  if (contendedMarks.length > 0) {
    console.log(
      `  ${String(contendedMarks.length)} of ${String(loadMarks.length)} marks sat above the core count. Wall time and event-loop`,
    );
    console.log(
      '  delay both count time this process spent descheduled and cannot tell it apart from a',
    );
    console.log(
      '  blocked loop, so every figure in this run is an UPPER BOUND on what an idle machine',
    );
    console.log('  would show. Re-run idle before quoting any of it as the cost of this server.');
    // Said plainly because the flag above reads like an accusation against other
    // tenants and it is not one. A load average counts every runnable thread,
    // this process's included, and the concurrent read windows in this run put
    // `--concurrency` inject drivers plus the server on the CPU for a minute -
    // which is exactly the window a 1-minute average still remembers when the
    // next mark is taken. This record can say the CPU was oversubscribed; it
    // cannot say by whom, and it must not be read as if it could.
    console.log(
      '  Note: the average counts this process too. The concurrent windows above load the',
    );
    console.log(
      '  machine themselves, and a 1-minute average still carries them at the next mark, so',
    );
    console.log('  a flag here means the CPU was oversubscribed - not that something else did it.');
  } else {
    console.log(
      '  no mark exceeded the core count: nothing in this run is known to have been waiting for',
    );
    console.log('  a core. That is the condition under which these figures are quotable.');
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
