/**
 * AD-2 - read and validate the alerts config file named by
 * `DASHBOARD_ALERTS_CONFIG`. Every failure throws with a message that names
 * the file and what is wrong, so a broken config stops the server at startup
 * instead of silently running without the alerts the operator asked for.
 *
 * The file holds no secret (targets carry a `tokenRef`, never a token), so
 * quoting schema errors - paths and messages, never values - is safe.
 */
import { readFileSync } from 'node:fs';
import { Value } from '@sinclair/typebox/value';
import { AlertsConfigSchema, alertsConfigProblems, type AlertsConfig } from '@agenthropic/shared';

/** Schema errors quoted in the startup failure; the rest are counted. */
const MAX_REPORTED_ERRORS = 5;

export function loadAlertsConfig(
  path: string,
  readFile: (path: string) => string = (p) => readFileSync(p, 'utf8'),
): AlertsConfig {
  const fail = (what: string): never => {
    throw new Error(`Invalid alerts config ${path}: ${what}`);
  };

  let text = '';
  try {
    text = readFile(path);
  } catch (error) {
    fail(`cannot be read (${(error as NodeJS.ErrnoException).code ?? 'unknown error'}).`);
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
