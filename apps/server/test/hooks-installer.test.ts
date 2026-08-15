/**
 * WP-X8 - installer pure functions (command/config generation, merge,
 * removal) plus the file workflow (backup, dry-run, refuse-invalid-JSON) on
 * a throwaway temp directory - never the real ~/.claude.
 */
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_PORT,
  DEFAULT_TOKEN_ENV,
  DELIVERY_ID_HEADER,
  HOOK_EVENTS,
  MIN_CURL_VERSION,
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

/**
 * POSIX-shell expansion for the fragments a hook command exposes to the
 * shell: `${NAME}`/`$NAME` from the given env, plus fakes for the three
 * fire-time delivery-id pieces (`$$`, `$(date +%s)`, `$RANDOM`). Order
 * matters: command substitution first, or its `%s` would survive into the
 * generic-variable pass.
 */
function expandShellText(text: string, env: Record<string, string>): string {
  return text
    .replace(/\$\(date \+%s\)/g, '1234567890')
    .replace(/\$\$/g, '4242')
    .replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, name: string) => env[name] ?? '')
    .replace(/\$([A-Za-z_][A-Za-z0-9_]*)/g, (_, name: string) => env[name] ?? '');
}

/**
 * Minimal shell word-splitter for the ONE command shape the installer
 * generates (single quotes, double quotes, bare text - no backslashes, no
 * nesting). It simulates what `sh -c <command>` hands each child process:
 * single-quoted segments stay literal, double-quoted and bare segments are
 * expanded. The M-11 assertions below are made against these argv words, so
 * this must mirror the shell's quoting rules - the sanity test guards that.
 */
function shellArgv(command: string, env: Record<string, string>): string[] {
  const argv: string[] = [];
  let word = '';
  let inWord = false;
  let index = 0;
  while (index < command.length) {
    const ch = command.charAt(index);
    if (ch === "'" || ch === '"') {
      const close = command.indexOf(ch, index + 1);
      if (close === -1) {
        throw new Error(`unterminated ${ch} quote in generated command`);
      }
      const inner = command.slice(index + 1, close);
      word += ch === "'" ? inner : expandShellText(inner, env);
      inWord = true;
      index = close + 1;
    } else if (ch === ' ') {
      if (inWord) {
        argv.push(word);
        word = '';
        inWord = false;
      }
      index += 1;
    } else {
      const next = /[ '"]/.exec(command.slice(index));
      const end = next === null ? command.length : index + next.index;
      word += expandShellText(command.slice(index, end), env);
      inWord = true;
      index = end;
    }
  }
  if (inWord) {
    argv.push(word);
  }
  return argv;
}

describe('buildHookCommand (WP-X8)', () => {
  it('targets loopback with the configured port and references the env var, not a token', () => {
    const command = buildHookCommand({ port: 5555 });
    expect(command).toContain("'http://127.0.0.1:5555/api/hooks/event'");
    // The token is imported by CURL from the environment at fire time
    // (M-11): the command names the variable and single-quotes the header
    // template, so neither the shell nor curl ever holds the value in argv.
    expect(command).toContain(`--variable '%${DEFAULT_TOKEN_ENV}'`);
    expect(command).toContain(`--expand-header 'Authorization: Bearer {{${DEFAULT_TOKEN_ENV}}}'`);
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
    const command = buildHookCommand({ tokenEnv: 'MY_TOKEN_VAR' });
    expect(command).toContain("--variable '%MY_TOKEN_VAR'");
    expect(command).toContain('{{MY_TOKEN_VAR}}');
    expect(() => buildHookCommand({ tokenEnv: 'bad-name' })).toThrow(/UPPER_SNAKE_CASE/);
    expect(() => buildHookCommand({ tokenEnv: '$(evil)' })).toThrow(/UPPER_SNAKE_CASE/);
  });

  it('validates the port', () => {
    expect(() => buildHookCommand({ port: 0 })).toThrow(/Invalid port/);
    expect(() => buildHookCommand({ port: 70000 })).toThrow(/Invalid port/);
    expect(() => buildHookCommand({ port: 1.5 })).toThrow(/Invalid port/);
  });
});

describe('token argv hygiene (M-11)', () => {
  // A value no legitimate argv word could contain by coincidence.
  const CANARY = 'canary-token-value-0123456789abcdef';

  it('sanity: the argv simulator expands exactly what a shell would', () => {
    // Guards the guard: if the simulator stopped expanding double-quoted or
    // bare text, every "token absent from argv" assertion below would pass
    // vacuously against unexpanded templates.
    expect(shellArgv('cmd "${T}" \'${T}\' $T pre-"$T"-post', { T: 'v' })).toEqual([
      'cmd',
      'v',
      '${T}',
      'v',
      'pre-v-post',
    ]);
    expect(shellArgv('id "$$-$(date +%s)-$RANDOM"', {})).toEqual(['id', '4242-1234567890-']);
  });

  it('the token value appears in NO argv position, even with the env var set', () => {
    // The threat (M-11): any process able to read another process's argv
    // (`ps`, /proc) during the up-to-3s POST window. The hook shell's own
    // argv is the command string - assert it carries no shell expansion of
    // the token at all - and every child argv word must survive expansion
    // with the canary in the environment without absorbing it.
    const command = buildHookCommand();
    expect(command).not.toContain('${');
    const argv = shellArgv(command, { [DEFAULT_TOKEN_ENV]: CANARY });
    for (const word of argv) {
      expect(word).not.toContain(CANARY);
    }
    // What curl DOES receive: the variable name and the literal template it
    // expands internally, after argv parsing.
    expect(argv).toContain(`%${DEFAULT_TOKEN_ENV}`);
    expect(argv).toContain(`Authorization: Bearer {{${DEFAULT_TOKEN_ENV}}}`);
  });

  it('holds for a custom token env var too', () => {
    const argv = shellArgv(buildHookCommand({ tokenEnv: 'MY_TOKEN_VAR' }), {
      MY_TOKEN_VAR: CANARY,
      [DEFAULT_TOKEN_ENV]: CANARY,
    });
    for (const word of argv) {
      expect(word).not.toContain(CANARY);
    }
    expect(argv).toContain('%MY_TOKEN_VAR');
  });

  it('still shell-expands the delivery id - per-firing, non-secret', () => {
    // The quoting split is load-bearing: the delivery id MUST be expanded by
    // the shell at fire time (that is what makes it per-firing), while the
    // token template must NOT be. A regression that single-quotes the id
    // header would silently collapse every firing into one delivery.
    const argv = shellArgv(buildHookCommand(), { [DEFAULT_TOKEN_ENV]: CANARY });
    expect(argv).toContain(`${DELIVERY_ID_HEADER}: 4242-1234567890-`);
  });

  it('declares --variable before --expand-header (curl resolves in argv order)', () => {
    // Reversed order would not leak - it would send the LITERAL template as
    // the header value, failing auth on every delivery. Pin the order so the
    // failure mode stays theoretical.
    const command = buildHookCommand();
    expect(command.indexOf('--variable')).toBeGreaterThan(-1);
    expect(command.indexOf('--variable')).toBeLessThan(command.indexOf('--expand-header'));
  });

  it('re-install replaces a pre-M-11 argv-leaking entry (the upgrade path)', () => {
    // Entries are recognized by the loopback endpoint marker, not the command
    // text, so a settings file installed before the M-11 fix is upgraded in
    // place by re-running the installer - no manual cleanup step to forget.
    const legacy =
      `curl --silent --fail --max-time 3 --output /dev/null ` +
      `--request POST --header 'Content-Type: application/json' ` +
      `--header "Authorization: Bearer \${${DEFAULT_TOKEN_ENV}}" --data-binary @- ` +
      `'http://127.0.0.1:4317/api/hooks/event' || true`;
    expect(isAgenthropicHookCommand(legacy)).toBe(true);
    const stale = {
      hooks: { Stop: [{ hooks: [{ type: 'command', command: legacy, timeout: 5 }] }] },
    };
    const merged = mergeHooksIntoSettings(stale, buildHooksConfig());
    const entries = eventEntries(merged, 'Stop');
    expect(entries).toHaveLength(1);
    expect(entries[0]?.hooks[0]?.command).toContain('--expand-header');
    expect(entries[0]?.hooks[0]?.command).not.toContain('${');
  });

  it('documents the minimum curl version where operators will read it', () => {
    // MIN_CURL_VERSION is a release fact (--variable/--expand-header shipped
    // in curl 8.3.0). An older curl fails closed - unknown option, nothing
    // sent - so the runbook must say which version the mechanism needs.
    expect(MIN_CURL_VERSION).toBe('8.3.0');
    const readme = readFileSync(
      fileURLToPath(new URL('../../../hooks/README.md', import.meta.url)),
      'utf8',
    );
    expect(readme).toContain(MIN_CURL_VERSION);
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
    // The written file carries the variable NAME (curl's --variable import
    // and its {{...}} header template), never a value and never a shell
    // expansion the hook shell would put into an argv.
    expect(result.settingsText).toContain(`%${DEFAULT_TOKEN_ENV}`);
    expect(result.settingsText).toContain(`{{${DEFAULT_TOKEN_ENV}}}`);
    expect(result.settingsText).not.toContain('${');
    expect(result.settingsText).toContain(`127.0.0.1:${DEFAULT_PORT}`);
  });
});
