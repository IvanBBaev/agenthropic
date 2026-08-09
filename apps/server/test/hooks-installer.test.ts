/**
 * WP-X8 - installer pure functions (command/config generation, merge,
 * removal) plus the file workflow (backup, dry-run, refuse-invalid-JSON) on
 * a throwaway temp directory - never the real ~/.claude.
 */
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_PORT,
  DEFAULT_TOKEN_ENV,
  DELIVERY_ID_HEADER,
  HOOK_EVENTS,
  buildHookCommand,
  buildHooksConfig,
  formatSettings,
  isAgenthropicHookCommand,
  mergeHooksIntoSettings,
  parseArgs,
  removeAgenthropicHooks,
  runInstall,
  type SettingsObject,
} from '../../../hooks/install.mjs';

interface HookEntry {
  hooks: Array<{ type: string; command: string; timeout: number }>;
}

function eventEntries(settings: SettingsObject, event: string): HookEntry[] {
  const hooks = settings['hooks'] as Record<string, HookEntry[]>;
  return hooks[event] ?? [];
}

describe('buildHookCommand (WP-X8)', () => {
  it('targets loopback with the configured port and references the env var, not a token', () => {
    const command = buildHookCommand({ port: 5555 });
    expect(command).toContain("'http://127.0.0.1:5555/api/hooks/event'");
    // The token appears ONLY as a fire-time shell expansion.
    expect(command).toContain(`Bearer \${${DEFAULT_TOKEN_ENV}}`);
    expect(command).toContain('--data-binary @-');
    // Fail-silent: never blocks the Claude Code session.
    expect(command).toContain('--max-time 3');
    expect(command).toMatch(/\|\| true$/);
  });

  it('stamps every firing with a fire-time delivery id (recurrence vs redelivery)', () => {
    const command = buildHookCommand();
    // A `Stop` payload is byte-identical every turn, so the SENDER must say
    // which firing this is. The value is shell-expanded at fire time (one id
    // per hook invocation, reused by that invocation's own retries) - the
    // installer never computes or embeds a value itself.
    expect(command).toContain(`--header "${DELIVERY_ID_HEADER}: `);
    expect(command).toContain('$$');
    expect(command).toContain('$(date +%s)');
    expect(command).toContain('$RANDOM');
    // Still recognized as ours, so re-install replaces rather than duplicates.
    expect(isAgenthropicHookCommand(command)).toBe(true);
  });

  it('supports a custom token env var and validates its name', () => {
    expect(buildHookCommand({ tokenEnv: 'MY_TOKEN_VAR' })).toContain('${MY_TOKEN_VAR}');
    expect(() => buildHookCommand({ tokenEnv: 'bad-name' })).toThrow(/UPPER_SNAKE_CASE/);
    expect(() => buildHookCommand({ tokenEnv: '$(evil)' })).toThrow(/UPPER_SNAKE_CASE/);
  });

  it('validates the port', () => {
    expect(() => buildHookCommand({ port: 0 })).toThrow(/Invalid port/);
    expect(() => buildHookCommand({ port: 70000 })).toThrow(/Invalid port/);
    expect(() => buildHookCommand({ port: 1.5 })).toThrow(/Invalid port/);
  });
});

describe('buildHooksConfig (WP-X8)', () => {
  it('wires exactly the four real lifecycle hooks', () => {
    expect([...HOOK_EVENTS]).toEqual(['UserPromptSubmit', 'Stop', 'SubagentStop', 'PreCompact']);
    const config = buildHooksConfig();
    expect(Object.keys(config)).toEqual([...HOOK_EVENTS]);
    for (const event of HOOK_EVENTS) {
      const entries = config[event] as HookEntry[];
      expect(entries).toHaveLength(1);
      expect(entries[0]?.hooks).toHaveLength(1);
      expect(entries[0]?.hooks[0]).toMatchObject({ type: 'command', timeout: 5 });
      expect(isAgenthropicHookCommand(entries[0]?.hooks[0]?.command)).toBe(true);
    }
  });
});

describe('mergeHooksIntoSettings (WP-X8)', () => {
  it('adds hooks to empty settings', () => {
    const merged = mergeHooksIntoSettings({}, buildHooksConfig());
    expect(eventEntries(merged, 'Stop')).toHaveLength(1);
  });

  it('preserves unrelated top-level keys and unrelated hook events', () => {
    const existing = {
      permissions: { allow: ['Bash(ls:*)'] },
      hooks: {
        PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo hi' }] }],
      },
    };
    const merged = mergeHooksIntoSettings(existing, buildHooksConfig());
    expect(merged['permissions']).toEqual({ allow: ['Bash(ls:*)'] });
    expect(eventEntries(merged, 'PreToolUse')).toHaveLength(1);
    expect(eventEntries(merged, 'Stop')).toHaveLength(1);
    // Input not mutated.
    expect(existing.hooks).not.toHaveProperty('Stop');
  });

  it('replaces stale agenthropic entries instead of duplicating them', () => {
    const stale = mergeHooksIntoSettings({}, buildHooksConfig({ port: 1111 }));
    const remerged = mergeHooksIntoSettings(stale, buildHooksConfig({ port: 2222 }));
    const entries = eventEntries(remerged, 'UserPromptSubmit');
    expect(entries).toHaveLength(1);
    expect(entries[0]?.hooks[0]?.command).toContain(':2222/');
  });

  it('keeps foreign commands that share an entry with ours', () => {
    const mixed = {
      hooks: {
        Stop: [
          {
            hooks: [
              { type: 'command', command: 'echo foreign' },
              { type: 'command', command: buildHookCommand() },
            ],
          },
        ],
      },
    };
    const merged = mergeHooksIntoSettings(mixed, buildHooksConfig());
    const entries = eventEntries(merged, 'Stop');
    expect(entries).toHaveLength(2);
    expect(entries[0]?.hooks).toEqual([{ type: 'command', command: 'echo foreign' }]);
    expect(isAgenthropicHookCommand(entries[1]?.hooks[0]?.command)).toBe(true);
  });

  it('refuses to merge into a malformed event entry list', () => {
    const malformed = { hooks: { Stop: 'not-an-array' } };
    expect(() => mergeHooksIntoSettings(malformed, buildHooksConfig())).toThrow(/not an array/);
    expect(() => mergeHooksIntoSettings('nonsense', buildHooksConfig())).toThrow(/JSON object/);
  });
});

describe('removeAgenthropicHooks (WP-X8)', () => {
  it('removes only our entries and drops emptied events', () => {
    const settings = mergeHooksIntoSettings(
      {
        theme: 'dark',
        hooks: {
          PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo hi' }] }],
        },
      },
      buildHooksConfig(),
    );
    const cleaned = removeAgenthropicHooks(settings);
    expect(cleaned['theme']).toBe('dark');
    expect(eventEntries(cleaned, 'PreToolUse')).toHaveLength(1);
    const hooks = cleaned['hooks'] as Record<string, unknown>;
    for (const event of HOOK_EVENTS) {
      expect(hooks).not.toHaveProperty(event);
    }
  });

  it('drops the hooks object entirely when nothing is left', () => {
    const onlyOurs = mergeHooksIntoSettings({}, buildHooksConfig());
    expect(removeAgenthropicHooks(onlyOurs)).toEqual({});
  });

  it('leaves settings without hooks untouched', () => {
    expect(removeAgenthropicHooks({ theme: 'dark' })).toEqual({ theme: 'dark' });
  });
});

describe('parseArgs (WP-X8)', () => {
  it('parses the full flag set', () => {
    const options = parseArgs([
      '--out',
      '/tmp/x/settings.json',
      '--port',
      '5000',
      '--token-env',
      'OTHER_TOKEN',
      '--dry-run',
      '--remove',
    ]);
    expect(options).toMatchObject({
      out: '/tmp/x/settings.json',
      port: 5000,
      tokenEnv: 'OTHER_TOKEN',
      dryRun: true,
      remove: true,
    });
  });

  it('rejects unknown arguments and missing values', () => {
    expect(() => parseArgs(['--nope'])).toThrow(/Unknown argument/);
    expect(() => parseArgs(['--out'])).toThrow(/Missing value/);
    expect(() => parseArgs(['--port', 'abc'])).toThrow(/Invalid port/);
  });

  it('recognizes --help', () => {
    expect(parseArgs(['--help']).help).toBe(true);
    expect(parseArgs(['-h']).help).toBe(true);
  });
});

describe('runInstall file workflow (WP-X8)', () => {
  let dir: string;
  let out: string;
  const fixedNow = (): Date => new Date('2026-07-18T10:00:00.000Z');

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'agenthropic-installer-test-'));
    out = join(dir, '.claude', 'settings.json');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('without --out only prints; nothing is written anywhere', () => {
    const result = runInstall({ now: fixedNow });
    expect(result.action).toBe('printed');
    expect(JSON.parse(result.settingsText)).toHaveProperty('hooks');
    expect(readdirSync(dir)).toEqual([]);
  });

  it('creates a new file (with parent dirs) and takes no backup', () => {
    const result = runInstall({ out, now: fixedNow });
    expect(result.action).toBe('written');
    expect(result.backupPath).toBeUndefined();
    const written = JSON.parse(readFileSync(out, 'utf8')) as SettingsObject;
    expect(eventEntries(written, 'PreCompact')).toHaveLength(1);
  });

  it('backs up an existing file before modifying and merges non-destructively', () => {
    const original = formatSettings({ theme: 'dark' });
    runInstall({ out, now: fixedNow }); // create first (also creates parent dirs)
    writeFileSync(out, original, 'utf8'); // overwrite with known content
    const result = runInstall({ out, now: fixedNow });
    expect(result.action).toBe('written');
    expect(result.backupPath).toBeDefined();
    expect(readFileSync(result.backupPath as string, 'utf8')).toBe(original);
    const written = JSON.parse(readFileSync(out, 'utf8')) as SettingsObject;
    expect(written['theme']).toBe('dark');
    expect(eventEntries(written, 'Stop')).toHaveLength(1);
  });

  it('--dry-run computes the result but writes nothing', () => {
    const result = runInstall({ out, dryRun: true, now: fixedNow });
    expect(result.action).toBe('dry-run');
    expect(result.outPath).toBe(out);
    expect(existsSync(out)).toBe(false);
  });

  it('--remove strips our entries and preserves the rest', () => {
    runInstall({ out, now: fixedNow });
    const withForeign = JSON.parse(readFileSync(out, 'utf8')) as SettingsObject;
    (withForeign['hooks'] as Record<string, unknown>)['PreToolUse'] = [
      { hooks: [{ type: 'command', command: 'echo hi' }] },
    ];
    writeFileSync(out, formatSettings(withForeign), 'utf8');

    const result = runInstall({ out, remove: true, now: fixedNow });
    expect(result.action).toBe('written');
    const cleaned = JSON.parse(readFileSync(out, 'utf8')) as SettingsObject;
    const hooks = cleaned['hooks'] as Record<string, unknown>;
    expect(Object.keys(hooks)).toEqual(['PreToolUse']);
  });

  it('refuses to touch a file that is not valid JSON', () => {
    runInstall({ out, now: fixedNow });
    writeFileSync(out, '{broken', 'utf8');
    expect(() => runInstall({ out, now: fixedNow })).toThrow(/not valid JSON/);
    expect(readFileSync(out, 'utf8')).toBe('{broken');
  });

  it('never embeds a token value even when the env var is set in this process', () => {
    const result = runInstall({ out, now: fixedNow });
    expect(result.settingsText).toContain(`\${${DEFAULT_TOKEN_ENV}}`);
    expect(result.settingsText).toContain(`127.0.0.1:${DEFAULT_PORT}`);
  });
});
