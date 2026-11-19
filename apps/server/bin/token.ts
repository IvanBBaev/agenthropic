/**
 * SEC-6 entry point: `pnpm --filter @agenthropic/server token:generate`.
 *
 * Prints one fresh dashboard token (32 random bytes, base64url) on stdout and
 * nothing else, so it can be redirected straight into a 0600 file:
 *
 *   (umask 077 && pnpm --silent --filter @agenthropic/server token:generate > ~/.config/agenthropic/token)
 *
 * No Node-version preflight on purpose: its OK line goes to stdout and would
 * land in the token file. Use `--silent` so pnpm's own banner stays out too.
 *
 * The generator and its tests live in `@agenthropic/shared`
 * (`generateDashboardToken`); this wrapper is kept small enough to read
 * instead of being tested.
 */
import { generateDashboardToken } from '@agenthropic/shared/node';

process.stdout.write(`${generateDashboardToken()}\n`);
