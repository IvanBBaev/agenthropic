/**
 * Hand-written declarations for `check-licenses.mjs`, so the TypeScript test
 * suite (apps/server/test/scripts-gates.test.ts) can import the gate's pure core
 * and feed it synthetic `pnpm licenses list --json` payloads.
 *
 * DRIFT RISK, accepted deliberately: nothing checks this file against the
 * implementation. `allowJs` is off repo-wide, so a `.mjs` module can only be
 * typed by a sibling declaration written by hand, and these declarations can go
 * stale without any gate noticing - the same accepted cost as `hooks/install.d.mts`.
 * The test calls the real functions, so a shape that stops existing surfaces as
 * a failing assertion. Keep in sync with check-licenses.mjs by hand.
 */

export interface GateReport {
  stdout: string[];
  stderr: string[];
  exitCode: 0 | 1;
}

/** The output was not JSON at all (L-3: pnpm may prefix a warning line). */
export interface LicensesUnparseable {
  status: 'unparseable';
  detail: string;
  raw: string;
}

/** Valid JSON, but not an object keyed by license expression (C-3). */
export interface LicensesWrongShape {
  status: 'wrong-shape';
  received: string;
}

export interface LicensesInspected {
  status: 'inspected';
  /** `name@versions  [license]` for every package no rule cleared. */
  offenders: string[];
  /** Packages cleared by a documented exception, counted apart from the allowlist (L-4). */
  appliedExceptions: string[];
  /** Exceptions that matched nothing - reported, never fatal (L-2). */
  unusedExceptions: string[];
  /** Distinct package names inspected, excluding workspace-local `@agenthropic/*`. */
  checkedNames: number;
  /** Installed versions inspected: one name present twice counts twice (L-1). */
  checkedVersions: number;
  /**
   * Distinct names with at least one entry cleared by the allowlist (II4). A name
   * cleared partly by the allowlist and partly by an exception counts in both.
   */
  allowlistedNames: number;
  /** Distinct names cleared by a documented exception (II4). */
  exceptionNames: number;
}

export type LicenseFindings = LicensesUnparseable | LicensesWrongShape | LicensesInspected;

export declare function evaluateLicenses(raw: string): LicenseFindings;
export declare function formatReport(findings: LicenseFindings): GateReport;
/** True when `argv1` resolves to the same file as `moduleUrl` (II1: symlink-safe). */
export declare function isMainModule(argv1: string | undefined, moduleUrl: string): boolean;
