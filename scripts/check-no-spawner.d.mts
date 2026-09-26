/**
 * Hand-written declarations for `check-no-spawner.mjs`, so the TypeScript test
 * suite (apps/server/test/scripts-gates.test.ts) can import the gate's pure core
 * and run it against a fixture tree instead of running the gate as a subprocess.
 *
 * DRIFT RISK, accepted deliberately: nothing checks this file against the
 * implementation. `allowJs` is off repo-wide, so a `.mjs` module can only be
 * typed by a sibling declaration written by hand, and these declarations can go
 * stale without any gate noticing - the same accepted cost as `hooks/install.d.mts`.
 * What limits the blast radius is that the test calls the real functions, so a
 * SHAPE that stops existing shows up as a failing assertion even when this file
 * still claims it. Keep in sync with check-no-spawner.mjs by hand.
 */

export interface GateReport {
  stdout: string[];
  stderr: string[];
  exitCode: 0 | 1;
}

export interface SpawnerFindings {
  /**
   * How far the walk got. `missing-roots` and `unregistered-top-level` are
   * coverage failures that stop the run before any file is read, so the
   * per-file fields below are still at their initial values in those two cases.
   */
  stage: 'missing-roots' | 'unregistered-top-level' | 'scanned';
  /** SCAN_ROOTS entries that are not directories in this tree (G-1). */
  missingRoots: string[];
  /** `[directory name, source-file count]` for unaccounted top-level dirs (C-1). */
  unregisteredTopLevel: Array<[string, number]>;
  exemptedTopLevel: string[];
  /** UNSCANNED_TOP_LEVEL entries absent from this tree. */
  absentExemptions: string[];
  skippedAllowlisted: string[];
  /** ALLOWLIST entries that matched no file - reported, never fatal (C-2). */
  deadAllowlistEntries: string[];
  /** `path:line  [rules it suppressed]`, in scan order (L-6). */
  inlineAllowSites: string[];
  /** `path:line` for markers that suppressed nothing - reported, never fatal (L-6). */
  deadInlineAllowSites: string[];
  /** Entries that are neither a regular file nor a directory, relative to the scan root (G-2 / L-1). */
  unreadableEntries: string[];
  offenders: string[];
  scannedFiles: number;
  scanRoots: number;
  scannedManifests: number;
  /** Server-process files (apps/server/src, packages/NAME/src) also checked for outbound network calls (WP-F5 no-SSRF). */
  outboundScannedFiles: number;
}

export declare const INLINE_ALLOW: string;
export declare function scanTree(rootDir: string): SpawnerFindings;
export declare function formatReport(findings: SpawnerFindings): GateReport;
/** True when `argv1` resolves to the same file as `moduleUrl` (II1: symlink-safe). */
export declare function isMainModule(argv1: string | undefined, moduleUrl: string): boolean;
