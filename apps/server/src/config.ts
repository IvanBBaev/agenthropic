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

export interface ServerConfig {
  /** Mandatory dashboard auth token. Never logged, never persisted. */
  readonly token: string;
  readonly port: number;
  readonly dbPath: string;
}

/**
 * Load configuration from an environment map. Throws when `DASHBOARD_TOKEN`
 * is missing/too short (via `requireDashboardToken`) or when `DASHBOARD_PORT`
 * is not a valid port number.
 */
export function loadConfig(env: Record<string, string | undefined>): ServerConfig {
  const token = requireDashboardToken(env);
  const port = parsePort(env['DASHBOARD_PORT']);
  const dbPath = env['DASHBOARD_DB_PATH'] ?? DEFAULT_DB_PATH;
  return { token, port, dbPath };
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
