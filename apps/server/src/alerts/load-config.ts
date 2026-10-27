/**
 * AD-2 - read and validate the alerts config file named by
 * `DASHBOARD_ALERTS_CONFIG`. Every failure throws with a message that names
 * the file and what is wrong, so a broken config stops the server at startup
 * instead of silently running without the alerts the operator asked for.
 *
 * The file holds no secret (targets carry a `tokenRef`, never a token), so
 * quoting schema errors - paths and messages, never values - is safe.
 *
 * It does decide where alerts go and which secret is sent with them: whoever
 * can rewrite it can point `chatId` at their own chat or `tokenRef` at another
 * of the server user's secrets. So, like a `file:` token, it is refused unless
 * it is owned by the server user (or root) and grants no group/other WRITE bit.
 * Read bits stay allowed - the file is not secret. The check is stat-then-read
 * (the same accepted limit as `token-ref.ts`): it catches an operator mistake,
 * not an attacker who already holds the server user's uid.
 */
import { readFileSync, statSync } from 'node:fs';
import { Value } from '@sinclair/typebox/value';
import { AlertsConfigSchema, alertsConfigProblems, type AlertsConfig } from '@agenthropic/shared';

/** Schema errors quoted in the startup failure; the rest are counted. */
const MAX_REPORTED_ERRORS = 5;

/** Group-write and other-write: anyone but the owner could rewrite the file. */
const WRITABLE_BY_OTHERS = 0o022;

/** The slice of `fs.Stats` the ownership check reads - a test seam. */
export interface AlertsConfigFileStat {
  uid: number;
  mode: number;
}

export function loadAlertsConfig(
  path: string,
  readFile: (path: string) => string = (p) => readFileSync(p, 'utf8'),
  statFile: (path: string) => AlertsConfigFileStat = (p) => statSync(p),
  serverUid: number | null = currentUid(),
): AlertsConfig {
  const fail = (what: string): never => {
    throw new Error(`Invalid alerts config ${path}: ${what}`);
  };
  const unreadable = (error: unknown): never =>
    fail(`cannot be read (${(error as NodeJS.ErrnoException).code ?? 'unknown error'}).`);

  let stat: AlertsConfigFileStat = { uid: 0, mode: 0 };
  try {
    stat = statFile(path);
  } catch (error) {
    unreadable(error);
  }
  if (serverUid !== null && stat.uid !== serverUid && stat.uid !== 0) {
    fail('is not owned by the server user or root.');
  }
  if ((stat.mode & WRITABLE_BY_OTHERS) !== 0) {
    const mode = (stat.mode & 0o777).toString(8).padStart(3, '0');
    fail(`mode ${mode} lets group/other rewrite it (use chmod 644 or 600).`);
  }

  let text = '';
  try {
    text = readFile(path);
  } catch (error) {
    unreadable(error);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    fail('not valid JSON.');
  }
  if (!Value.Check(AlertsConfigSchema, parsed)) {
    const errors = [...Value.Errors(AlertsConfigSchema, parsed)];
    const shown = errors
      .slice(0, MAX_REPORTED_ERRORS)
      .map((e) => `${e.path === '' ? '/' : e.path} ${e.message}`);
    const more =
      errors.length > MAX_REPORTED_ERRORS
        ? `; and ${errors.length - MAX_REPORTED_ERRORS} more`
        : '';
    fail(`${shown.join('; ')}${more}.`);
  }
  const config = parsed as AlertsConfig;
  const problems = alertsConfigProblems(config);
  if (problems.length > 0) fail(`${problems.join('; ')}.`);
  return config;
}

/** The server user's uid, or null where the platform has none (not POSIX). */
function currentUid(): number | null {
  return process.getuid === undefined ? null : process.getuid();
}
