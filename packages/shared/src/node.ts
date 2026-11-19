/**
 * `@agenthropic/shared/node` (ARC-12): the security primitives, which use
 * `node:crypto` and therefore stay out of the browser-safe root entry.
 */
export {
  MIN_TOKEN_DISTINCT_CHARACTERS,
  MIN_TOKEN_LENGTH,
  generateDashboardToken,
  requireDashboardToken,
  timingSafeTokenEqual,
  assertLoopbackHost,
  isAllowedHost,
  isAllowedOrigin,
  redactTokenInUrl,
} from './security/index';
