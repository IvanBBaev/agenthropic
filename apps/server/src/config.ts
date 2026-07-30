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
import { requireDashboardToken } from '@agenthropic/shared';

/** The one and only bind host. Loopback, constant, no configuration path. */
export const HOST = '127.0.0.1';

export const DEFAULT_PORT = 4317;
export const DEFAULT_DB_PATH = 'data/agenthropic.db';
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
  return { token, port, dbPath, ingestEnabled, corpusRoot, pollIntervalMs, watchdogMinutes };
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
