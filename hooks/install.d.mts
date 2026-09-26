/**
 * Hand-written declarations for `install.mjs` so the TypeScript test suite
 * (apps/server/test/hooks-installer.test.ts) can import and unit-test the
 * pure config-generation/merge functions. Keep in sync with install.mjs.
 */

export declare const HOOK_EVENTS: readonly string[];
export declare const DEFAULT_PORT: number;
export declare const DEFAULT_TOKEN_ENV: string;
export declare const MIN_CURL_VERSION: string;
export declare const DELIVERY_ID_HEADER: string;

export interface HookCommandOptions {
  port?: number;
  tokenEnv?: string;
}

export interface HooksConfigOptions extends HookCommandOptions {
  events?: readonly string[];
}

export type SettingsObject = Record<string, unknown>;

/**
 * How an existing hook command in a settings file relates to this installer.
 * `ambiguous` means "aims at our ingest endpoint but matches no shape we have
 * ever generated" - callers must refuse to rewrite or delete it.
 */
export type HookCommandKind = 'ours' | 'ambiguous' | 'foreign';

export declare function buildHookCommand(options?: HookCommandOptions): string;
export declare function classifyHookCommand(command: unknown): HookCommandKind;
export declare function isAgenthropicHookCommand(command: unknown): boolean;
export declare function buildHooksConfig(options?: HooksConfigOptions): SettingsObject;
export declare function mergeHooksIntoSettings(
  settings: unknown,
  hooksConfig: SettingsObject,
): SettingsObject;
export declare function removeAgenthropicHooks(settings: unknown): SettingsObject;
export declare function formatSettings(settings: unknown): string;

export interface InstallerCliOptions {
  out?: string;
  port?: number;
  tokenEnv?: string;
  dryRun: boolean;
  remove: boolean;
  help: boolean;
}

export declare function parseArgs(argv: readonly string[]): InstallerCliOptions;

export interface RunInstallOptions {
  out?: string;
  port?: number;
  tokenEnv?: string;
  dryRun?: boolean;
  remove?: boolean;
  now?: () => Date;
}

export interface RunInstallResult {
  /**
   * `unchanged` (added 2026-09-07, finding H-2) means the computed settings text
   * equals the file's current bytes, so no backup was taken and nothing was
   * written. It is a distinct outcome from `written` on purpose: reporting a
   * no-op as a write is the thing that made re-running the installer look like
   * it had done something.
   *
   * `absent` (added 2026-09-23, finding C-7) means `--remove` was asked of a
   * path that does not exist: there was nothing to remove, so no directory was
   * created and no file was written. It is distinct from `unchanged` because
   * `unchanged` asserts the file exists and already matches.
   *
   * `nothing-to-remove` (added 2026-09-23, finding L-3) means `--remove` was
   * asked of a file that exists but holds none of our hooks. Nothing was
   * written and no backup was taken. It is distinct from `unchanged`, which
   * compares BYTES and so misses this case for any file whose formatting is
   * not already this installer's, and from `absent`, which asserts the file is
   * not there at all.
   */
  action: 'printed' | 'written' | 'dry-run' | 'unchanged' | 'absent' | 'nothing-to-remove';
  outPath?: string;
  backupPath?: string;
  /**
   * Set only when the write had to create the output file's parent tree
   * (finding H-3). Present so a mistyped `--out` is visible in the result and
   * on stdout rather than being an invisible success.
   */
  createdDirectory?: string;
  /**
   * Only meaningful on a `dry-run`: whether the run would have written anything.
   */
  unchanged?: boolean;
  settingsText: string;
}

export declare function runInstall(options?: RunInstallOptions): RunInstallResult;
