/**
 * Hand-written declarations for `check-node-version.mjs`, so the TypeScript test
 * suite (apps/server/test/scripts-gates.test.ts) can import the gate's pure core
 * and decide verdicts about Node versions the test process is not running under.
 *
 * DRIFT RISK, accepted deliberately: nothing checks this file against the
 * implementation. `allowJs` is off repo-wide, so a `.mjs` module can only be
 * typed by a sibling declaration written by hand, and these declarations can go
 * stale without any gate noticing - the same accepted cost as `hooks/install.d.mts`.
 * The test calls the real functions, so a shape that stops existing surfaces as
 * a failing assertion. Keep in sync with check-node-version.mjs by hand.
 */

export interface GateReport {
  stdout: string[];
  stderr: string[];
  exitCode: 0 | 1;
}

/** `.nvmrc` could not be read at all - "missing is loud", never a pass. */
export interface NodeVersionUnreadable {
  status: 'unreadable';
  nvmrcPath: string;
  detail: string;
}

/** `.nvmrc` holds something that is not a Node version (`lts/hydrogen`). */
export interface NodeVersionUnparsable {
  status: 'unparsable';
  wanted: string;
}

export interface NodeVersionMismatch {
  status: 'mismatch';
  wantedMajor: number;
  nodeVersion: string;
  execPath: string;
}

export interface NodeVersionOk {
  status: 'ok';
  wantedMajor: number;
  nodeVersion: string;
}

export type NodeVersionFindings =
  NodeVersionUnreadable | NodeVersionUnparsable | NodeVersionMismatch | NodeVersionOk;

export interface EvaluateNodeVersionOptions {
  nvmrcPath: string;
  nodeVersion: string;
  execPath: string;
}

export declare function evaluateNodeVersion(
  options: EvaluateNodeVersionOptions,
): NodeVersionFindings;
export declare function formatReport(findings: NodeVersionFindings): GateReport;
/** True when `argv1` resolves to the same file as `moduleUrl` (II1: symlink-safe). */
export declare function isMainModule(argv1: string | undefined, moduleUrl: string): boolean;
