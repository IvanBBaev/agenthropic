/**
 * Hand-written declarations for `service-install.mjs`, so the TypeScript test
 * suite (apps/server/test/service-install.test.ts) can import its pure core.
 * Same accepted drift risk as `check-node-version.d.mts`: keep in sync by hand.
 */

export declare const DEFAULT_LABEL: string;
export declare const REQUIRED_NODE_MAJOR: number;
export declare const MIN_TOKEN_LENGTH: number;
export declare const TOKEN_MASK: string;
export declare const DEFAULT_PORT_FOR_STEPS: number;

export interface ServiceOptions {
  write: boolean;
  help: boolean;
  node?: string;
  db?: string;
  port?: number;
  label?: string;
}

export interface ServicePaths {
  plist: string;
  serverDir: string;
  tsxCli: string;
  db: string;
  webIndex: string;
  logDir: string;
  stdoutLog: string;
  stderrLog: string;
}

export interface RunIo {
  argv: readonly string[];
  env: Record<string, string | undefined>;
  home: string;
  repoRoot: string;
  platform: string;
  execPath: string;
  nodeVersion: string;
  exists: (path: string) => boolean;
  writePlist: (paths: ServicePaths, body: string) => void;
}

export interface RunResult {
  stdout: string[];
  stderr: string[];
  exitCode: 0 | 1;
}

export declare function parseArgs(argv: readonly string[]): ServiceOptions;
export declare function checkToken(token: string | undefined): string | null;
export declare function nodeMajor(version: string): number | null;
export declare function xmlEscape(value: string): string;
export declare function servicePaths(input: {
  home: string;
  repoRoot: string;
  label: string;
  db?: string;
}): ServicePaths;
export declare function buildPlist(input: {
  label: string;
  node: string;
  paths: ServicePaths;
  home: string;
  token: string;
  port?: number;
}): string;
export declare function launchctlSteps(input: {
  label: string;
  plist: string;
  port: number;
}): string[];
export declare function preflight(input: {
  node: string;
  nodeVersion: string;
  token: string | undefined;
  paths: ServicePaths;
  platform: string;
  exists: (path: string) => boolean;
}): { errors: string[]; warnings: string[] };
export declare function run(io: RunIo): RunResult;
export declare function writePlistToDisk(paths: ServicePaths, body: string): void;
export declare function isMainModule(argv1: string | undefined, moduleUrl: string): boolean;
