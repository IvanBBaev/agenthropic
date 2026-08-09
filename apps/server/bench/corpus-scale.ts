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
import { performance } from 'node:perf_hooks';
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

  const cold = time(() => watcher.tick());
  const warm = time(() => watcher.tick());

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
      note: `${perSession(warm.ms)} - ${dutyCycle}% of a ${String(DEFAULT_POLL_INTERVAL_MS)} ms poll`,
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

  console.log('\n## api reads');
  for (const row of reads) {
    console.log(`  ${row.label.padEnd(30)} ${fmtMs(row.ms).padStart(10)}   ${row.note}`);
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
