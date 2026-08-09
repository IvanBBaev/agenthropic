/**
 * Hand-written declarations for `install.mjs` so the TypeScript test suite
 * (apps/server/test/hooks-installer.test.ts) can import and unit-test the
 * pure config-generation/merge functions. Keep in sync with install.mjs.
 */

export declare const HOOK_EVENTS: readonly string[];
export declare const DEFAULT_PORT: number;
export declare const DEFAULT_TOKEN_ENV: string;
export declare const DELIVERY_ID_HEADER: string;

export interface HookCommandOptions {
  port?: number;
  tokenEnv?: string;
}

export interface HooksConfigOptions extends HookCommandOptions {
  events?: readonly string[];
}

export type SettingsObject = Record<string, unknown>;

export declare function buildHookCommand(options?: HookCommandOptions): string;
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
  action: 'printed' | 'written' | 'dry-run';
  outPath?: string;
  backupPath?: string;
  settingsText: string;
}

export declare function runInstall(options?: RunInstallOptions): RunInstallResult;
