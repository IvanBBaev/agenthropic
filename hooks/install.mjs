/**
 * WP-X8 - agenthropic hooks installer.
 *
 * Generates (or updates) a Claude Code hooks configuration that wires
 * UserPromptSubmit / Stop / SubagentStop / PreCompact to POST the hook's
 * stdin JSON to the dashboard's loopback ingest endpoint:
 *
 *   http://127.0.0.1:<port>/api/hooks/event
 *
 * SECURITY PROPERTIES (non-negotiable):
 * - The token value appears in NO process's argv - not the hook shell's and
 *   not curl's own. The generated command names the env var to curl via
 *   `--variable '%NAME'` and references it in a single-quoted
 *   `--expand-header` template (`{{NAME}}`), so curl reads the environment
 *   ITSELF at fire time and the shell never expands the value into an
 *   argument. The first shipped shape (`--header "... Bearer ${NAME}"`) let
 *   any process able to read curl's argv harvest the token during the
 *   up-to-3s POST window (review item M-11) - exactly the local multi-user
 *   attacker the token exists to stop. Requires curl >= 8.3.0
 *   (MIN_CURL_VERSION); on an older curl the command errors out at option
 *   parse and delivers nothing - it degrades to zero telemetry, never to a
 *   leaked token, and `|| true` keeps it non-blocking either way.
 * - Reading the env at fire time (rather than baking a header file at install
 *   time) keeps the env var the single runtime source of truth: rotating the
 *   token is export-and-done, with no stale file to regenerate.
 * - This script NEVER reads, embeds, prints or otherwise touches the actual
 *   token value.
 * - This script never spawns processes and never talks to the network. Its
 *   only side effect is writing the ONE settings file the user explicitly
 *   points it at via `--out` (plus a timestamped backup of that same file).
 *   Without `--out` it only prints to stdout. It never touches `~/.claude`
 *   unless the user explicitly passes an `--out` path there.
 * - The POST target is hard-pinned to loopback (127.0.0.1); the port is the
 *   only variable part.
 * - Hook failures never block Claude Code: the command is fail-silent
 *   (`--silent --fail`, a hard `--max-time`, and a trailing `|| true`).
 * - The command stamps each firing with a delivery id expanded by the shell at
 *   fire time (see DELIVERY_ID_HEADER). It carries no user data - a pid, an
 *   epoch second and `$RANDOM` - and the server uses it as idempotency-key
 *   material only; it is never stored or echoed.
 *
 * MERGE / ROLLBACK:
 * - Updates are non-destructive: unrelated settings keys and unrelated hook
 *   entries are preserved verbatim; previously installed agenthropic entries
 *   (recognized by the loopback `/api/hooks/event` target in the command)
 *   are replaced, never duplicated.
 * - Before modifying an existing file, a backup copy is written next to it
 *   (`<file>.backup-<timestamp>`). Rollback = copy the backup over the file.
 * - `--remove` strips the agenthropic entries again, preserving everything
 *   else. `--dry-run` prints what would be written without writing.
 *
 * Usage: node hooks/install.mjs [--out <path>] [--port <n>]
 *                               [--token-env <NAME>] [--dry-run] [--remove]
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { pathToFileURL } from 'node:url';

/** The four real Claude Code lifecycle hooks this project consumes. */
export const HOOK_EVENTS = Object.freeze([
  'UserPromptSubmit',
  'Stop',
  'SubagentStop',
  'PreCompact',
]);

/** Must match the server's DEFAULT_PORT (apps/server/src/config.ts). */
export const DEFAULT_PORT = 4317;

/** Env var the generated command reads the token from - at fire time. */
export const DEFAULT_TOKEN_ENV = 'DASHBOARD_TOKEN';

/**
 * Oldest curl whose argv-free token mechanism the generated command relies on:
 * `--variable`/`--expand-header` shipped in curl 8.3.0 (2023-09). This is a
 * release fact, not a tunable. Older curls reject the unknown option at parse
 * time and deliver nothing - fail-closed (no request, no token anywhere),
 * never fail-open into the argv-leaking shape.
 */
export const MIN_CURL_VERSION = '8.3.0';

/** Hard timeout (seconds) Claude Code applies to the hook command. */
const HOOK_TIMEOUT_SECONDS = 5;

/**
 * Header carrying a per-FIRING delivery id (WP-IN1). A `Stop` hook body is
 * byte-identical on every turn of a session, so the server cannot tell "this
 * happened again" from "this was delivered twice" by content alone - only the
 * sender can. Must match apps/server/src/hooks/routes.ts.
 */
export const DELIVERY_ID_HEADER = 'X-Agenthropic-Delivery-Id';

/**
 * Shell expression that mints the delivery id AT FIRE TIME - one value per
 * hook invocation, and one value for that invocation's own curl retries.
 * `$$` (the hook shell's pid) plus the epoch second plus `$RANDOM`; on a shell
 * without `$RANDOM` (dash) the expression degrades to pid+second, which is
 * still per-invocation because each firing runs in its own shell. The
 * installer never computes a value itself, so no id is ever baked into the
 * settings file.
 */
const DELIVERY_ID_EXPRESSION = '$$-$(date +%s)-$RANDOM';

/** Loopback marker + path marker that identify a command as ours. */
const LOOPBACK_MARKER = '127.0.0.1';
const ENDPOINT_MARKER = '/api/hooks/event';

const USAGE = `Usage: node hooks/install.mjs [options]

Options:
  --out <path>        Settings file to create/update (e.g. .claude/settings.json).
                      Omit to print the generated configuration to stdout.
  --port <n>          Dashboard port (default ${String(DEFAULT_PORT)}).
  --token-env <NAME>  Env var the hook command reads the token from at fire
                      time (default ${DEFAULT_TOKEN_ENV}). The token VALUE is
                      never read or embedded by this script.
  --dry-run           Compute and print the result; write nothing.
  --remove            Remove previously installed agenthropic hook entries.
  --help              Show this help.`;

function assertValidPort(port) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid port ${String(port)}: expected an integer between 1 and 65535.`);
  }
}

function assertValidTokenEnv(tokenEnv) {
  if (typeof tokenEnv !== 'string' || !/^[A-Z_][A-Z0-9_]*$/.test(tokenEnv)) {
    throw new Error(
      `Invalid token env var name ${JSON.stringify(tokenEnv)}: expected UPPER_SNAKE_CASE.`,
    );
  }
}

/**
 * The generated hook command. It runs on the Claude Code side (NOT inside
 * the dashboard server): reads the hook JSON from stdin and POSTs it to the
 * loopback ingest endpoint. Fail-silent by construction.
 *
 * Token mechanics (M-11): the Authorization header is built by CURL, not by
 * the shell. `--variable '%NAME'` imports the env var into curl's own
 * variable space and the single-quoted `--expand-header` template
 * (`{{NAME}}`) is expanded inside curl after argv parsing - so every argv
 * position, in both the hook shell and curl, carries only the variable NAME.
 * The quoting split is deliberate and load-bearing: the two token arguments
 * are SINGLE-quoted (the shell must never expand them), while the delivery-id
 * header stays DOUBLE-quoted (the shell MUST expand `$$`/`$(date)`/`$RANDOM`
 * - it is per-firing and carries no secret). `--variable` must precede
 * `--expand-header`: curl resolves variables in command-line order, and the
 * reverse order would send the literal template as the header value.
 *
 * Failure modes, all non-blocking via `|| true` (verified on curl 8.7.1):
 * - env var unset -> curl errors at option parse ("variable expansion
 *   failure"), sends nothing. (The pre-M-11 shape sent an empty Bearer and
 *   collected a 401 - same net effect: no event stored, hook exits 0.)
 * - curl < MIN_CURL_VERSION -> unknown-option error at parse, sends nothing.
 * Both print a short, token-free line to stderr and exit 0.
 */
export function buildHookCommand({ port = DEFAULT_PORT, tokenEnv = DEFAULT_TOKEN_ENV } = {}) {
  assertValidPort(port);
  assertValidTokenEnv(tokenEnv);
  return (
    `curl --silent --fail --max-time 3 --output /dev/null ` +
    `--request POST --header 'Content-Type: application/json' ` +
    `--variable '%${tokenEnv}' ` +
    `--expand-header 'Authorization: Bearer {{${tokenEnv}}}' ` +
    `--header "${DELIVERY_ID_HEADER}: ${DELIVERY_ID_EXPRESSION}" --data-binary @- ` +
    `'http://${LOOPBACK_MARKER}:${String(port)}${ENDPOINT_MARKER}' || true`
  );
}

/** True when a hook command string is one of ours (loopback ingest POST). */
export function isAgenthropicHookCommand(command) {
  return (
    typeof command === 'string' &&
    command.includes(LOOPBACK_MARKER) &&
    command.includes(ENDPOINT_MARKER)
  );
}

/** The `hooks` object wiring every event to the generated command. */
export function buildHooksConfig({
  port = DEFAULT_PORT,
  tokenEnv = DEFAULT_TOKEN_ENV,
  events = HOOK_EVENTS,
} = {}) {
  const command = buildHookCommand({ port, tokenEnv });
  const config = {};
  for (const event of events) {
    config[event] = [{ hooks: [{ type: 'command', command, timeout: HOOK_TIMEOUT_SECONDS }] }];
  }
  return config;
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Deep-clone plain JSON data (settings files are JSON by definition). */
function cloneJson(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

/**
 * Remove agenthropic commands from one event's entry list, preserving every
 * foreign entry - including foreign commands sharing an entry with ours.
 */
function pruneEventEntries(entries, event) {
  if (!Array.isArray(entries)) {
    throw new Error(
      `Refusing to merge: existing hooks.${event} is not an array. Fix the file manually.`,
    );
  }
  const kept = [];
  for (const entry of entries) {
    if (!isRecord(entry) || !Array.isArray(entry.hooks)) {
      kept.push(cloneJson(entry));
      continue;
    }
    const foreignHooks = entry.hooks.filter(
      (hook) =>
        !(isRecord(hook) && hook.type === 'command' && isAgenthropicHookCommand(hook.command)),
    );
    if (foreignHooks.length === entry.hooks.length) {
      kept.push(cloneJson(entry));
    } else if (foreignHooks.length > 0) {
      kept.push({ ...cloneJson(entry), hooks: cloneJson(foreignHooks) });
    }
    // else: the entry contained only our hooks - drop it entirely.
  }
  return kept;
}

function normalizeSettings(settings) {
  if (settings === undefined || settings === null) {
    return {};
  }
  if (!isRecord(settings)) {
    throw new Error('Refusing to merge: existing settings are not a JSON object.');
  }
  return cloneJson(settings);
}

/**
 * Merge the generated hooks into an existing settings object,
 * non-destructively: unrelated top-level keys and unrelated hook entries are
 * preserved; stale agenthropic entries are replaced, never duplicated.
 */
export function mergeHooksIntoSettings(settings, hooksConfig) {
  const merged = normalizeSettings(settings);
  const hooks = isRecord(merged.hooks) ? merged.hooks : {};
  merged.hooks = hooks;
  for (const [event, entries] of Object.entries(hooksConfig)) {
    const existing = hooks[event] === undefined ? [] : hooks[event];
    hooks[event] = [...pruneEventEntries(existing, event), ...cloneJson(entries)];
  }
  return merged;
}

/**
 * Remove previously installed agenthropic entries from a settings object,
 * preserving everything else. Events left with no entries are dropped; a
 * `hooks` object left empty is dropped.
 */
export function removeAgenthropicHooks(settings) {
  const cleaned = normalizeSettings(settings);
  if (!isRecord(cleaned.hooks)) {
    return cleaned;
  }
  const hooks = cleaned.hooks;
  for (const [event, entries] of Object.entries(hooks)) {
    if (!Array.isArray(entries)) {
      continue; // never touch malformed foreign data on removal
    }
    const pruned = pruneEventEntries(entries, event);
    if (pruned.length === 0) {
      delete hooks[event];
    } else {
      hooks[event] = pruned;
    }
  }
  if (Object.keys(hooks).length === 0) {
    delete cleaned.hooks;
  }
  return cleaned;
}

/** Stable serialization for the written settings file. */
export function formatSettings(settings) {
  return `${JSON.stringify(settings, null, 2)}\n`;
}

/** Parse CLI arguments into a plain options object. Throws on unknown args. */
export function parseArgs(argv) {
  const options = { dryRun: false, remove: false, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const takeValue = () => {
      index += 1;
      const value = argv[index];
      if (value === undefined) {
        throw new Error(`Missing value for ${arg}.\n\n${USAGE}`);
      }
      return value;
    };
    switch (arg) {
      case '--out':
        options.out = takeValue();
        break;
      case '--port': {
        const port = Number(takeValue());
        assertValidPort(port);
        options.port = port;
        break;
      }
      case '--token-env':
        options.tokenEnv = takeValue();
        break;
      case '--dry-run':
        options.dryRun = true;
        break;
      case '--remove':
        options.remove = true;
        break;
      case '--help':
      case '-h':
        options.help = true;
        break;
      default:
        throw new Error(`Unknown argument: ${arg}\n\n${USAGE}`);
    }
  }
  return options;
}

function readExistingSettings(path) {
  if (!existsSync(path)) {
    return {};
  }
  const raw = readFileSync(path, 'utf8');
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error(
      `Refusing to touch ${path}: existing file is not valid JSON. ` +
        'Fix or move it first - this installer never overwrites what it cannot merge.',
    );
  }
}

function backupTimestamp(now) {
  return now.toISOString().replace(/[:.]/g, '-');
}

/**
 * Run the installer. Pure orchestration over the exported pure functions;
 * the ONLY file it ever writes are `out` and `out`'s backup. Returns a
 * structured result for testability.
 */
export function runInstall({
  out,
  port = DEFAULT_PORT,
  tokenEnv = DEFAULT_TOKEN_ENV,
  dryRun = false,
  remove = false,
  now = () => new Date(),
} = {}) {
  const transform = (settings) =>
    remove
      ? removeAgenthropicHooks(settings)
      : mergeHooksIntoSettings(settings, buildHooksConfig({ port, tokenEnv }));

  if (out === undefined) {
    const settingsText = formatSettings(transform({}));
    return { action: dryRun ? 'dry-run' : 'printed', settingsText };
  }

  const existing = readExistingSettings(out);
  const fileExisted = existsSync(out);
  const settingsText = formatSettings(transform(existing));

  if (dryRun) {
    return { action: 'dry-run', outPath: out, settingsText };
  }

  let backupPath;
  if (fileExisted) {
    backupPath = `${out}.backup-${backupTimestamp(now())}`;
    copyFileSync(out, backupPath);
  }
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, settingsText, 'utf8');
  return { action: 'written', outPath: out, backupPath, settingsText };
}

/* c8 ignore start - CLI entry, exercised only when run as a script */
const isMain =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) {
      console.log(USAGE);
    } else {
      const result = runInstall(options);
      if (result.action === 'written') {
        if (result.backupPath !== undefined) {
          console.log(`Backed up existing file to ${result.backupPath}`);
        }
        console.log(`Wrote ${result.outPath}`);
      } else {
        if (result.action === 'dry-run' && result.outPath !== undefined) {
          console.log(`[dry-run] Would write ${result.outPath}:`);
        }
        console.log(result.settingsText);
      }
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
/* c8 ignore stop */
