/**
 * WP-U0 - server configuration.
 *
 * The bind host is intentionally NOT configurable: it is the exported
 * constant {@link HOST}. Adding a host option would reopen the all-interfaces
 * exposure this project exists to close (DESIGN.md section 8).
 *
 * The auth token is mandatory: `loadConfig` throws when `DASHBOARD_TOKEN` is
 * unset, so the server can never start without auth.
 */
import { fileURLToPath } from 'node:url';
import { requireDashboardToken } from '@agenthropic/shared';

/** The one and only bind host. Loopback, constant, no configuration path. */
export const HOST = '127.0.0.1';

export const DEFAULT_PORT = 4317;
export const DEFAULT_DB_PATH = 'data/agenthropic.db';
/**
 * Built SPA directory served by the single-port server (`DASHBOARD_WEB_ROOT`).
 *
 * Resolved from `import.meta.url`, NOT from `process.cwd()`. The dashboard is
 * started from wherever the operator happens to stand - a cwd-relative default
 * would serve the UI only when the server was launched from the repository
 * root, and would silently answer "not built" everywhere else. Anchoring on the
 * module's own URL makes the default a property of the installation, not of the
 * shell. This file lives at `apps/server/src/`, so `../../web/dist` is
 * `apps/web/dist`; the server runs straight from TypeScript source under tsx
 * (there is deliberately no JS emit step for `apps/server`), so that relative
 * hop is the same at every start.
 */
export const DEFAULT_WEB_ROOT = fileURLToPath(new URL('../../web/dist', import.meta.url));
/** Tail-follow poll cadence (WP-IN5). PROVISIONAL (LABEL-ME) — not yet ratified. */
export const DEFAULT_POLL_INTERVAL_MS = 3000;
/** Missing-Stop watchdog inactivity window (WP-IN12). PROVISIONAL (LABEL-ME). */
export const DEFAULT_WATCHDOG_MINUTES = 10;

export interface ServerConfig {
  /** Mandatory dashboard auth token. Never logged, never persisted. */
  readonly token: string;
  readonly port: number;
  readonly dbPath: string;
  /**
   * Corpus ingest master switch (`DASHBOARD_INGEST`). ON by default; tests
   * boot with `DASHBOARD_INGEST=0` so they never touch the real corpus.
   */
  readonly ingestEnabled: boolean;
  /**
   * Corpus root override (`CLAUDE_PROJECTS_DIR`); `null` means the canonical
   * `~/.claude/projects` (resolved later by the corpus adapter).
   */
  readonly corpusRoot: string | null;
  /** Tail-follow poll interval (`DASHBOARD_POLL_INTERVAL_MS`). */
  readonly pollIntervalMs: number;
  /** Watchdog inactivity window in minutes (`DASHBOARD_WATCHDOG_MINUTES`). */
  readonly watchdogMinutes: number;
  /**
   * Directory holding the built SPA (`DASHBOARD_WEB_ROOT`), served from the
   * same loopback origin as /api. Never `null`: a missing directory is a
   * runtime condition the static handler reports as "not built yet", not a
   * reason to have no value here.
   */
  readonly webRoot: string;
}

/**
 * Load configuration from an environment map. Throws when `DASHBOARD_TOKEN`
 * is missing/too short (via `requireDashboardToken`) or when any numeric /
 * boolean variable carries an unparseable value.
 */
export function loadConfig(env: Record<string, string | undefined>): ServerConfig {
  const token = requireDashboardToken(env);
  const port = parsePort(env['DASHBOARD_PORT']);
  const dbPath = env['DASHBOARD_DB_PATH'] ?? DEFAULT_DB_PATH;
  const ingestEnabled = parseIngestEnabled(env['DASHBOARD_INGEST']);
  const corpusRoot = parseCorpusRoot(env['CLAUDE_PROJECTS_DIR']);
  const pollIntervalMs = parsePositiveInt(
    'DASHBOARD_POLL_INTERVAL_MS',
    env['DASHBOARD_POLL_INTERVAL_MS'],
    DEFAULT_POLL_INTERVAL_MS,
  );
  const watchdogMinutes = parsePositiveInt(
    'DASHBOARD_WATCHDOG_MINUTES',
    env['DASHBOARD_WATCHDOG_MINUTES'],
    DEFAULT_WATCHDOG_MINUTES,
  );
  const webRoot = parseWebRoot(env['DASHBOARD_WEB_ROOT']);
  return {
    token,
    port,
    dbPath,
    ingestEnabled,
    corpusRoot,
    pollIntervalMs,
    watchdogMinutes,
    webRoot,
  };
}

function parsePort(raw: string | undefined): number {
  if (raw === undefined || raw === '') {
    return DEFAULT_PORT;
  }
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`Invalid DASHBOARD_PORT "${raw}": expected an integer between 0 and 65535.`);
  }
  return port;
}

/** Unset/empty/'1'/'true' → on; '0'/'false' → off; anything else is a config error. */
function parseIngestEnabled(raw: string | undefined): boolean {
  if (raw === undefined || raw === '' || raw === '1' || raw === 'true') {
    return true;
  }
  if (raw === '0' || raw === 'false') {
    return false;
  }
  throw new Error(`Invalid DASHBOARD_INGEST "${raw}": expected 1/true/0/false.`);
}

/** Empty string counts as unset — an accidental `CLAUDE_PROJECTS_DIR=` must not mean cwd. */
function parseCorpusRoot(raw: string | undefined): string | null {
  return raw === undefined || raw === '' ? null : raw;
}

/**
 * Same house rule: empty counts as unset. An accidental `DASHBOARD_WEB_ROOT=`
 * must fall back to the built-in default, never to `''` — which `path.resolve`
 * would turn into the current working directory, i.e. serving whatever
 * directory the operator happened to start the process from.
 */
function parseWebRoot(raw: string | undefined): string {
  return raw === undefined || raw === '' ? DEFAULT_WEB_ROOT : raw;
}

function parsePositiveInt(name: string, raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw === '') {
    return fallback;
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`Invalid ${name} "${raw}": expected a positive integer.`);
  }
  return value;
}
