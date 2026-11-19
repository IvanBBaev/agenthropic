/**
 * QA-7 smoke server: the REAL server, booted through its public `start()`, on
 * the synthetic fixture corpus and the built SPA. Playwright's `webServer`
 * runs this file under tsx (the executor `pnpm start` uses - see the note on
 * migration checksums in apps/server/package.json) and waits for the port.
 *
 * Everything lives under `E2E_ROOT`, a throwaway directory the Playwright
 * config creates: the corpus (`projects/`), the database and its backups. The
 * real `~/.claude/projects` is never read - `CLAUDE_PROJECTS_DIR` pins the
 * corpus root, and the boot refuses to run without `E2E_ROOT`.
 *
 * All fixture content is synthetic (packages/test-fixtures). The two synthetic
 * models are priced at 1 USD/Mtok so the views have dollar figures to render.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase, runMigrations, start } from '@agenthropic/server';
import { getFixture, listFixtures, type Fixture } from '@agenthropic/test-fixtures';
import { E2E_SLUG, corpusRoot as e2eCorpusRoot, requireEnv } from './env';

const SYNTHETIC_MODELS = ['synthetic-model-a', 'synthetic-model-b'] as const;
const BUCKETS = ['input', 'output', 'cache_read', 'cache_write_5m', 'cache_write_1h'] as const;

/** The session id of a fixture: its bare `<uuid>.jsonl` main, else the first record's sessionId. */
function sessionIdOf(fixture: Fixture): string {
  const main = fixture.files.find((f) => !f.relativePath.includes('/'));
  if (main !== undefined) return main.relativePath.slice(0, -'.jsonl'.length);
  const first = fixture.files.find((f) => f.relativePath.endsWith('.jsonl'))?.lines[0];
  const id =
    first === undefined ? undefined : (JSON.parse(first) as { sessionId?: unknown }).sessionId;
  if (typeof id !== 'string') throw new Error(`fixture ${fixture.name} has no session id`);
  return id;
}

/** Lay one fixture out the way Claude Code does (main at `<slug>/<uuid>.jsonl`, nested under `<slug>/<uuid>/`). */
function materialize(corpusRoot: string, fixture: Fixture): void {
  const sessionId = sessionIdOf(fixture);
  const files = fixture.files.some((f) => !f.relativePath.includes('/'))
    ? fixture.files
    : [{ relativePath: `${sessionId}.jsonl`, lines: [] }, ...fixture.files];
  for (const f of files) {
    const rel = f.relativePath.includes('/')
      ? join(sessionId, ...f.relativePath.split('/'))
      : f.relativePath;
    const abs = join(corpusRoot, E2E_SLUG, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, f.lines.length === 0 ? '' : f.lines.join('\n') + '\n');
  }
}

const corpusRoot = e2eCorpusRoot();
const dbPath = join(requireEnv('E2E_ROOT'), 'agenthropic.db');
for (const name of listFixtures()) materialize(corpusRoot, getFixture(name));

const seed = openDatabase(dbPath);
runMigrations(seed);
const insert = seed.prepare(
  'INSERT INTO model_pricing (model, bucket, usd_per_mtok, effective_from) VALUES (?, ?, ?, ?)',
);
for (const model of SYNTHETIC_MODELS) {
  for (const bucket of BUCKETS) insert.run(model, bucket, 1, '2020-01-01');
}
seed.close();

await start({
  DASHBOARD_TOKEN: requireEnv('E2E_TOKEN'),
  DASHBOARD_PORT: requireEnv('E2E_PORT'),
  DASHBOARD_DB_PATH: dbPath,
  CLAUDE_PROJECTS_DIR: corpusRoot,
  DASHBOARD_WEB_ROOT: fileURLToPath(new URL('../dist', import.meta.url)),
  DASHBOARD_POLL_INTERVAL_MS: '250',
  DASHBOARD_LOG_LEVEL: 'warn',
});
