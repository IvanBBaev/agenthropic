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
 *
 *   AMENDED 2026-09-07 (H-2, H-3): "its only side effect is writing the ONE
 *   settings file" was two claims short of the truth. First, it also creates
 *   the file's whole PARENT TREE (`mkdirSync(..., { recursive: true })`), so a
 *   mistyped `--out` silently succeeded into a directory that did not exist a
 *   moment earlier; the tree is still created, and the created path is now
 *   named in the result and printed by the CLI. Second, "writing" happened on
 *   every run, including runs that computed byte-for-byte what the file already
 *   held - one accumulated backup per re-run, a settings file reformatted into
 *   this installer's own shape, and `Wrote <path>` printed over a change that
 *   was not made. A run whose output equals the current file now returns the
 *   `unchanged` action and writes nothing at all.
 *
 *   AMENDED 2026-09-24 (GG7): the write itself goes through a transient temp
 *   sibling (`<file>.tmp-<pid>`) renamed over the target, so the file is never
 *   left half-written; the temp file never outlives the run.
 * - The POST target is hard-pinned to loopback (127.0.0.1); the port is the
 *   only variable part.
 * - The user's curl environment cannot redirect or log the POST: the command
 *   starts `curl --disable` (no ~/.curlrc) and passes `--noproxy '*'` (no
 *   proxy env var applies). See buildHookCommand (GG1/GG2).
 * - Hook failures never block Claude Code: the command is fail-silent
 *   (`--silent --fail`, a hard `--max-time`, and a trailing `|| true`).
 *
 *   AMENDED 2026-09-02: the "never block" half of that bullet was wrong.
 *   What was believed: exiting 0 and printing nothing was read as "invisible
 *   to the session". What is true: exit code and elapsed time are different
 *   things. Every entry this installer generated was a SYNCHRONOUS hook, so
 *   Claude Code waited for curl to finish before the turn could continue -
 *   up to `--max-time 3` of dead wait on every prompt, every turn end, every
 *   subagent finish and every compaction, precisely when the dashboard was
 *   unreachable or wedged. The entries now carry `async: true`, which is
 *   what actually buys the property this bullet claimed: Claude Code writes
 *   the hook JSON to the command's stdin, backgrounds the process and
 *   continues immediately. `--max-time 3` stays because a Claude Code too
 *   old to know the field silently ignores it and keeps waiting.
 * - Delivery failures are visible, but only just: `--show-error` prints one
 *   line of curl's own error text (see buildHookCommand). Nothing retries,
 *   nothing spools, nothing counts them - a dashboard that has received
 *   zero events still looks exactly like a healthy one from this side.
 * - The command stamps each firing with a delivery id expanded by the shell at
 *   fire time (see DELIVERY_ID_HEADER). It carries no user data - a pid, an
 *   epoch second and `$RANDOM` - and the server uses it as idempotency-key
 *   material only; it is never stored or echoed.
 *
 * MERGE / ROLLBACK:
 * - Updates are non-destructive: unrelated settings keys and unrelated hook
 *   entries are preserved verbatim; previously installed agenthropic entries
 *   (a command byte-identical to a shape this installer generated) are replaced,
 *   never duplicated; one that targets `/api/hooks/event` but matches no known
 *   shape is refused, never rewritten (see classifyHookCommand).
 * - Before modifying an existing file, a backup copy is written next to it
 *   (`<file>.backup-<timestamp>`). Rollback = copy the backup over the file.
 * - `--remove` strips the agenthropic entries again, preserving everything
 *   else. `--dry-run` prints what would be written without writing.
 *
 * Usage: node hooks/install.mjs [--out <path>] [--port <n>]
 *                               [--token-env <NAME>] [--dry-run] [--remove]
 */
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, resolve } from 'node:path';
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

/**
 * Hard timeout (seconds) Claude Code applies to the hook command. With
 * `async: true` (see buildHooksConfig) this is no longer time the session
 * waits: Claude Code carries the same number over as the timeout of the
 * BACKGROUNDED process, so it still bounds a wedged curl - it just no longer
 * bounds the turn.
 */
const HOOK_TIMEOUT_SECONDS = 5;

/**
 * Header carrying a per-FIRING delivery id (WP-IN1). A `Stop` hook body is
 * byte-identical on every turn of a session, so the server cannot tell "this
 * happened again" from "this was delivered twice" by content alone - only the
 * sender can. Must match apps/server/src/hooks/routes.ts.
 *
 * AMENDED 2026-09-02: "byte-identical on every turn" is FALSE. What was
 * believed: the documented common fields (`session_id`, `transcript_path`,
 * `cwd`, `hook_event_name`, `stop_hook_active`) are all session-scoped, so a
 * `Stop` body looked constant for a whole session. What is true, read off
 * the Claude Code 2.1.251 binary's own payload construction: a `Stop` body
 * also carries `prompt_id`, `last_assistant_message`, `background_tasks` and
 * `session_crons`, and the first two of those change from turn to turn.
 * (`stop_hook_active` is still there; that part of the sentence stands.)
 *
 * The header stays, and the reason it stays is the second sentence, not the
 * first: content equality can never distinguish recurrence from redelivery
 * in the general case - two firings ARE allowed to carry the same bytes, and
 * which fields a given Claude Code version includes is not a contract we
 * control. Only the sender knows which firing this is. What the correction
 * does change is the honesty of the argument: the premise was an observation
 * we never actually verified (`~/.claude/projects/*.jsonl` stores no hook
 * payloads at all, so the corpus cannot settle it), and it should not be
 * repeated as a fact about the wire format.
 */
export const DELIVERY_ID_HEADER = 'X-Agenthropic-Delivery-Id';

/**
 * Shell expression that mints the delivery id AT FIRE TIME - one value per
 * hook invocation (the generated command never retries, so there are no
 * retries to share it).
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

/**
 * The two validity rules live in non-throwing predicates because the command
 * classifier (classifyHookCommand) has to ask the same questions about values
 * it scraped out of a settings file someone else may have hand-edited, where
 * "not valid" is an ordinary answer and not an error worth unwinding for.
 */
function isValidPort(port) {
  return Number.isInteger(port) && port >= 1 && port <= 65535;
}

function isValidTokenEnv(tokenEnv) {
  return typeof tokenEnv === 'string' && /^[A-Z_][A-Z0-9_]*$/.test(tokenEnv);
}

function assertValidPort(port) {
  if (!isValidPort(port)) {
    throw new Error(`Invalid port ${String(port)}: expected an integer between 1 and 65535.`);
  }
}

function assertValidTokenEnv(tokenEnv) {
  if (!isValidTokenEnv(tokenEnv)) {
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
 *
 * `--show-error` is there on purpose and is the one thing standing between an
 * operator and an undiagnosable dashboard. `--silent` alone silences curl's
 * ERRORS as well as its progress meter, so with the previous command shape a
 * refused connection, a three-second timeout and a rejected payload all
 * produced exactly what a perfectly healthy delivery produced: no output, exit
 * 0, nothing written anywhere. Total failure was byte-for-byte
 * indistinguishable from the documented healthy state. `--show-error` restores
 * one line per failed firing and nothing at all on success (measured on curl
 * 8.7.1: `curl: (7) Failed to connect to 127.0.0.1 port 4317` when the server
 * is down, `curl: (28) Operation timed out after 3009 milliseconds` when it is
 * wedged, `curl: (22) The requested URL returned error: 413` when the payload
 * exceeds the server's 1 MiB body cap; a stored 202 prints nothing). The line
 * cannot leak the token: it names the URL and the HTTP status, and the URL
 * carries no credential - the token only ever exists inside curl's own
 * variable space (see the M-11 note above). It cannot corrupt the terminal
 * either: Claude Code spawns hook commands with piped stdio and reads them,
 * so this goes to the hook's captured stderr rather than to the TUI.
 *
 * What it deliberately is NOT: a retry, a spool, or a counter. Nothing here
 * remembers a failure past the moment it is printed, so a dashboard that has
 * missed every event since Tuesday still looks healthy from this side unless
 * somebody was watching that output. Making the loss durable (a spool file, a
 * failure counter surfaced on /api/health) is an owner policy decision - it
 * buys retention, disk and privacy questions that a hook installer must not
 * settle on its own.
 *
 * GG1/GG2 (2026-09-24): the request carries the bearer token and the whole
 * prompt body, so the user's curl environment must not get a say in where it
 * goes or what gets logged about it.
 * - `--noproxy '*'`: curl honours `http_proxy` / `ALL_PROXY` for ANY host,
 *   127.0.0.1 included, unless `no_proxy` happens to cover it. With a proxy in
 *   the environment the "loopback" POST left the machine, token and prompt
 *   included. Single-quoted so the shell never globs it.
 * - `--disable`: skips `~/.curlrc`, which can set a proxy, `--verbose` or
 *   `--trace-ascii` (the last two dump request headers - the expanded token -
 *   to stderr or a file). curl only honours it as the FIRST argument, so it
 *   must stay there.
 */
export function buildHookCommand({ port = DEFAULT_PORT, tokenEnv = DEFAULT_TOKEN_ENV } = {}) {
  assertValidPort(port);
  assertValidTokenEnv(tokenEnv);
  return (
    `curl --disable --silent --show-error --fail --max-time 3 --noproxy '*' ` +
    `--output /dev/null ` +
    `--request POST --header 'Content-Type: application/json' ` +
    `--variable '%${tokenEnv}' ` +
    `--expand-header 'Authorization: Bearer {{${tokenEnv}}}' ` +
    `--header "${DELIVERY_ID_HEADER}: ${DELIVERY_ID_EXPRESSION}" --data-binary @- ` +
    `'http://${LOOPBACK_MARKER}:${String(port)}${ENDPOINT_MARKER}' || true`
  );
}

/**
 * Every command shape this installer has ever generated, newest retired shape
 * first. They exist so that `--remove` and the merge can still RECOGNIZE an
 * entry written by an older version of this file, which is the only reason a
 * substring test was tolerable before.
 *
 * These are frozen copies and must never be refactored to share code with
 * buildHookCommand or to reference the marker constants: the whole point is
 * that they keep saying what that generation said even after the current
 * generation changes. When buildHookCommand changes shape again, copy the OLD
 * body down here as the next generation and leave these alone. Only `port`
 * and `tokenEnv` are parameters, because those are the only two values the
 * installer has ever varied.
 */
function buildHookCommandGen1({ port, tokenEnv }) {
  // Shipped 2026-07..2026-08 (pre-M-11): token expanded by the SHELL, so the
  // value landed in curl's argv. Recognized here, never generated again.
  return (
    `curl --silent --fail --max-time 3 --output /dev/null ` +
    `--request POST --header 'Content-Type: application/json' ` +
    `--header "Authorization: Bearer \${${tokenEnv}}" --data-binary @- ` +
    `'http://127.0.0.1:${String(port)}/api/hooks/event' || true`
  );
}

function buildHookCommandGen2({ port, tokenEnv }) {
  // Gen 1 plus the per-firing delivery id (WP-IN1), still pre-M-11.
  return (
    `curl --silent --fail --max-time 3 --output /dev/null ` +
    `--request POST --header 'Content-Type: application/json' ` +
    `--header "Authorization: Bearer \${${tokenEnv}}" ` +
    `--header "X-Agenthropic-Delivery-Id: $$-$(date +%s)-$RANDOM" --data-binary @- ` +
    `'http://127.0.0.1:${String(port)}/api/hooks/event' || true`
  );
}

function buildHookCommandGen4({ port, tokenEnv }) {
  // Gen 3 plus `--show-error`. Shipped until 2026-09-24: no `--disable`, so
  // ~/.curlrc applied, and no `--noproxy`, so proxy env vars could route the
  // "loopback" POST - token and prompt - off the machine (GG1/GG2).
  return (
    `curl --silent --show-error --fail --max-time 3 --output /dev/null ` +
    `--request POST --header 'Content-Type: application/json' ` +
    `--variable '%${tokenEnv}' ` +
    `--expand-header 'Authorization: Bearer {{${tokenEnv}}}' ` +
    `--header "X-Agenthropic-Delivery-Id: $$-$(date +%s)-$RANDOM" --data-binary @- ` +
    `'http://127.0.0.1:${String(port)}/api/hooks/event' || true`
  );
}

function buildHookCommandGen3({ port, tokenEnv }) {
  // M-11 shape: argv-free token, delivery id, but still `--silent` alone, so
  // failures printed nothing (see buildHookCommand's --show-error note).
  return (
    `curl --silent --fail --max-time 3 --output /dev/null ` +
    `--request POST --header 'Content-Type: application/json' ` +
    `--variable '%${tokenEnv}' ` +
    `--expand-header 'Authorization: Bearer {{${tokenEnv}}}' ` +
    `--header "X-Agenthropic-Delivery-Id: $$-$(date +%s)-$RANDOM" --data-binary @- ` +
    `'http://127.0.0.1:${String(port)}/api/hooks/event' || true`
  );
}

const COMMAND_GENERATIONS = Object.freeze([
  buildHookCommand,
  buildHookCommandGen4,
  buildHookCommandGen3,
  buildHookCommandGen2,
  buildHookCommandGen1,
]);

/**
 * Loose extractors for the only two values a generation is parameterized by.
 * They are allowed to be wrong: whatever they pull out is fed back through a
 * generation builder and the result must match the command CHARACTER FOR
 * CHARACTER before anything is called ours. A bad guess therefore produces a
 * mismatch, never a false positive.
 */
const PORT_PATTERN = /:(\d{1,5})\/api\/hooks\/event/;
const TOKEN_ENV_PATTERNS = Object.freeze([
  /--variable '%([A-Z_][A-Z0-9_]*)'/,
  /Authorization: Bearer \$\{([A-Z_][A-Z0-9_]*)\}/,
]);

/**
 * Decide whether a hook command in someone's settings file is ours, and be
 * willing to answer "I cannot tell".
 *
 * This used to be two `includes()` calls - a command counted as ours if it
 * mentioned 127.0.0.1 and /api/hooks/event anywhere. That is an ownership
 * claim over a string this installer may never have written: a hand-rolled
 * curl to the same endpoint, a wrapper script, a `jq` pipeline, someone
 * else's dashboard on the same path - all of them matched, and `--remove`
 * would delete them without a word. Deleting a line out of a user's settings
 * file because it looks a bit like ours is not a defensible thing for an
 * installer to do.
 *
 * The rule is now exact equality against a shape we know we generated:
 * - 'ours'      - byte-identical to some generation. Safe to replace/remove.
 * - 'ambiguous' - aims at our endpoint but matches no generation. SOMETHING
 *                 wrote it; we do not know what, so callers must refuse
 *                 rather than guess.
 * - 'foreign'   - unrelated. Preserved verbatim, as always.
 */
export function classifyHookCommand(command) {
  if (
    typeof command !== 'string' ||
    !command.includes(LOOPBACK_MARKER) ||
    !command.includes(ENDPOINT_MARKER)
  ) {
    return 'foreign';
  }
  const port = Number(PORT_PATTERN.exec(command)?.[1]);
  if (isValidPort(port)) {
    for (const pattern of TOKEN_ENV_PATTERNS) {
      const tokenEnv = pattern.exec(command)?.[1];
      if (!isValidTokenEnv(tokenEnv)) {
        continue;
      }
      for (const generate of COMMAND_GENERATIONS) {
        if (generate({ port, tokenEnv }) === command) {
          return 'ours';
        }
      }
    }
  }
  return 'ambiguous';
}

/** True when a hook command string is one of ours (loopback ingest POST). */
export function isAgenthropicHookCommand(command) {
  return classifyHookCommand(command) === 'ours';
}

/**
 * The `hooks` object wiring every event to the generated command.
 *
 * `async: true` is what makes the delivery genuinely free for the session.
 * Without it Claude Code runs the hook synchronously and waits for curl to
 * exit before the turn continues, which costs up to `--max-time 3` on every
 * prompt, turn end, subagent finish and compaction whenever the dashboard is
 * down or slow - the exact situation in which the dashboard is worth the
 * least. With it, Claude Code writes the hook JSON to the command's stdin,
 * closes it, backgrounds the process and reports success immediately.
 *
 * Verified rather than assumed (Claude Code 2.1.251): `async` is declared on
 * the command-hook object in the shipped settings JSON schema, and its hook
 * runner branches on that field for every event type - the "force synchronous"
 * override exists but is only ever passed for MessageDisplay/SessionStart/
 * Setup, never for the four events wired here.
 *
 * `timeout` stays. On a Claude Code new enough to honour `async` it becomes
 * the background process's timeout instead of the turn's; on one too old to
 * know the field, the unknown key is ignored and `timeout` plus curl's own
 * `--max-time` are all that bound the wait. Dropping it would make the old
 * client strictly worse, so both belong there.
 */
export function buildHooksConfig({
  port = DEFAULT_PORT,
  tokenEnv = DEFAULT_TOKEN_ENV,
  events = HOOK_EVENTS,
} = {}) {
  const command = buildHookCommand({ port, tokenEnv });
  const config = {};
  for (const event of events) {
    config[event] = [
      { hooks: [{ type: 'command', command, timeout: HOOK_TIMEOUT_SECONDS, async: true }] },
    ];
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
 *
 * Throws on an AMBIGUOUS command (one aimed at our endpoint that matches no
 * shape we have ever generated - see classifyHookCommand). Refusing is the
 * conservative branch in both directions: on a merge it stops us from
 * silently replacing a line somebody wrote by hand, and on `--remove` it
 * stops us from deleting it. Both callers compute the whole new settings
 * object before anything is backed up or written, so a throw from here leaves
 * the file exactly as it was and the operator can decide - keep the line and
 * pass an explicit `--out` elsewhere, or delete it themselves and re-run.
 *
 * The message names the event and the position but deliberately does NOT
 * print the command: an unrecognized variant is by definition something we
 * did not write, and a hand-written one is exactly the kind that has a
 * literal token pasted into it. An installer that echoes user-authored hook
 * commands into stdout, and from there into a terminal scrollback or a CI
 * log, has invented a credential leak that did not exist before.
 */
function pruneEventEntries(entries, event) {
  if (!Array.isArray(entries)) {
    throw new Error(
      `Refusing to merge: existing hooks.${event} is not an array. Fix the file manually.`,
    );
  }
  const kept = [];
  for (const [entryIndex, entry] of entries.entries()) {
    if (!isRecord(entry) || !Array.isArray(entry.hooks)) {
      kept.push(cloneJson(entry));
      continue;
    }
    const foreignHooks = [];
    for (const [hookIndex, hook] of entry.hooks.entries()) {
      const kind =
        isRecord(hook) && hook.type === 'command' ? classifyHookCommand(hook.command) : 'foreign';
      if (kind === 'ambiguous') {
        throw new Error(
          `Refusing to touch hooks.${event}[${String(entryIndex)}].hooks[${String(hookIndex)}]: ` +
            `it posts to the dashboard ingest endpoint but does not match any command this ` +
            `installer has generated, so it was written by something else. Remove or move that ` +
            `entry by hand and re-run. (The command text is withheld on purpose: it may contain ` +
            `a literal token.)`,
        );
      }
      if (kind === 'foreign') {
        foreignHooks.push(hook);
      }
    }
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
  // GG6 (2026-09-24). A non-object `hooks` (an array, a string, null) used to
  // be replaced by `{}` without a word, discarding whatever the operator had
  // put there. Same rule as a malformed event list: refuse, do not guess.
  // Thrown while computing the new settings, i.e. before any backup or write.
  if (merged.hooks !== undefined && !isRecord(merged.hooks)) {
    throw new Error('Refusing to merge: existing "hooks" is not an object. Fix the file manually.');
  }
  const hooks = merged.hooks === undefined ? {} : merged.hooks;
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
      // H-1 (2026-09-07). A dropped value used to be swallowed by the flag that
      // followed it: `--out --dry-run` set the output path to the string
      // "--dry-run", performed no dry run, and wrote a real settings file to a
      // file of that name in the current directory. The operator's belief ("I
      // just did a dry run") and what happened ("I installed, somewhere odd")
      // were opposites, and nothing on the way out said so. A leading dash is
      // therefore refused as a value; a path that genuinely starts with one is
      // still reachable as ./-name.
      if (value.startsWith('-')) {
        throw new Error(
          `Missing value for ${arg}: the next argument is ${value}, which is a flag rather than ` +
            `a value. If you really mean a path beginning with a dash, write it as ./${value}.` +
            `\n\n${USAGE}`,
        );
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

/** Same bound the kernel uses for a symlink chain (Linux `MAXSYMLINKS`). */
const MAX_SYMLINK_HOPS = 40;

/**
 * Resolve the path the settings bytes must land on so that a symlinked `--out`
 * survives the rename.
 *
 * JJ2 (2026-09-24). Only an EXISTING target used to be resolved; a dangling link
 * (a dotfiles checkout whose file is not there yet) fell through to `out`
 * itself, and the rename replaced the link with a regular file. A dangling chain
 * is now followed hop by hop - relative link text against the link's own
 * directory - until it reaches a path that is not a link. That path's directory
 * must already exist: creating directories wherever a link happens to point is
 * not something an installer should do silently, so it refuses instead.
 */
function resolveWriteTarget(out, fileExisted) {
  if (fileExisted) {
    return realpathSync(out);
  }
  let target = out;
  for (let hops = 0; lstatSync(target, { throwIfNoEntry: false })?.isSymbolicLink(); hops += 1) {
    if (hops === MAX_SYMLINK_HOPS) {
      throw new Error(`Refusing to write ${out}: too many levels of symbolic links.`);
    }
    target = resolve(dirname(target), readlinkSync(target));
  }
  if (target !== out && !existsSync(dirname(target))) {
    throw new Error(
      `Refusing to write ${out}: it is a symlink to ${target}, whose directory ` +
        `${dirname(target)} does not exist. Nothing was written.`,
    );
  }
  return target;
}

/**
 * Create `tempPath` exclusively. JJ3 (2026-09-24): the temp name is predictable
 * (`<target>.tmp-<pid>`) and was opened without `O_EXCL`, so anything already
 * planted there - a symlink above all - was written THROUGH. `wx` refuses an
 * existing entry; a stale one (a crashed earlier run with a recycled pid) is
 * unlinked - the entry itself, never what it points at - and the create is
 * retried exactly once.
 */
function writeTempExclusively(tempPath, settingsText, mode) {
  const options = { encoding: 'utf8', mode, flag: 'wx' };
  try {
    writeFileSync(tempPath, settingsText, options);
  } catch (error) {
    if (
      !(error instanceof Error) ||
      /** @type {NodeJS.ErrnoException} */ (error).code !== 'EEXIST'
    ) {
      throw error;
    }
    unlinkSync(tempPath);
    writeFileSync(tempPath, settingsText, options);
  }
}

/**
 * GG7 (2026-09-24). The settings file used to be rewritten in place, so a
 * write that died part-way (disk full, quota, I/O error) left the operator's
 * Claude Code settings truncated. The new text now goes to a temp sibling that
 * is renamed over the target - rename is atomic on one filesystem, so the file
 * holds either the old bytes or the new ones, never a prefix.
 *
 * - A symlinked `--out` is resolved first - dangling or not, see JJ2 in
 *   `resolveWriteTarget` - so the rename replaces the file the link points at
 *   and the link itself survives (a dotfiles-managed `settings.json` is
 *   commonly a symlink).
 * - The temp file is created exclusively (JJ3, `writeTempExclusively`).
 * - The existing file's permission bits are carried over; a plain rename would
 *   otherwise reset a `chmod 600` settings file to the umask default.
 * - On failure the temp file is removed and the error names the backup, which
 *   is where the operator will want to look first - or, on a first install, the
 *   directory this run created (JJ4), since "nothing was written" alone would
 *   hide it.
 * - F3 (2026-09-26): that cleanup never masks the failure it follows. A
 *   directory planted at the temp name defeats the write (JJ3's unlink refuses
 *   it) and then `rmSync` without `recursive` refuses it as well, `force` or
 *   not - so the cleanup threw its own ERR_FS_EISDIR over the real error and
 *   the operator saw a bare Node error with no pointer to the backup. The
 *   cleanup failure is noted in the message instead; `recursive` is not an
 *   option, because the installer never recursively deletes a directory it
 *   did not create.
 */
function writeSettingsAtomically(out, fileExisted, settingsText, backupPath, createdDirectory) {
  const target = resolveWriteTarget(out, fileExisted);
  const mode = fileExisted ? statSync(target).mode & 0o777 : undefined;
  const tempPath = `${target}.tmp-${String(process.pid)}`;
  try {
    writeTempExclusively(tempPath, settingsText, mode);
    if (mode !== undefined) {
      chmodSync(tempPath, mode); // `mode` above is filtered by the umask
    }
    renameSync(tempPath, target);
  } catch (error) {
    let cleanup = '';
    try {
      rmSync(tempPath, { force: true });
    } catch {
      // F3: a cleanup that throws would replace the error being reported.
      cleanup = ` The temp entry ${tempPath} could not be removed and was left behind.`;
    }
    const reason = error instanceof Error ? error.message : String(error);
    let state;
    if (backupPath !== undefined) {
      state = `${out} was left unchanged; a backup was taken at ${backupPath}.`;
    } else if (createdDirectory !== undefined) {
      state = `Nothing was written, but the directory ${createdDirectory} was created.`;
    } else {
      state = 'Nothing was written.';
    }
    throw new Error(`Failed to write ${out}: ${reason}. ${state}${cleanup}`, { cause: error });
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
  // L-3 (2026-09-23). Serialised BEFORE `transform` runs, so the comparison
  // below is against what the file actually said rather than against whatever
  // the transform may have left behind.
  const existingText = formatSettings(existing);
  const settingsText = formatSettings(transform(existing));
  const currentText = fileExisted ? readFileSync(out, 'utf8') : undefined;
  const unchanged = currentText === settingsText;

  // C-7 (2026-09-23). `--remove` against a file that does not exist used to fall
  // through to the write path: it created the whole parent tree, wrote `{}`, and
  // reported `Created directory ...` + `Wrote ...`. Removing hooks from a file
  // that was never there brought a settings file into existence - the opposite
  // of what the operator asked for, announced as a success. There is nothing to
  // remove, so nothing is created and nothing is written.
  if (remove && !fileExisted) {
    return { action: 'absent', outPath: out, settingsText };
  }

  // L-3 (2026-09-23). `--remove` against an existing file that holds none of our
  // hooks used to fall through to the write path whenever the file's formatting
  // differed from this installer's - which, for any hand-maintained settings
  // file, it does. Measured against a four-space `settings.json` holding one
  // foreign `SessionStart` hook and nothing of ours: the run took a backup,
  // rewrote the operator's file into two-space shape and printed `Backed up
  // existing file to ...` + `Wrote ...`, reporting a removal that removed
  // nothing and accruing one backup per re-run. H-2 already named the same three
  // false statements; its byte-equality test simply cannot see a no-op through a
  // reformat. Removal is the one operation that has a truthful empty case, so it
  // gets compared on meaning, not on bytes. Placed ahead of the dry-run branch
  // for the reason C-7 established: the preview must not claim a write the real
  // run would not perform.
  if (remove && settingsText === existingText) {
    return { action: 'nothing-to-remove', outPath: out, settingsText };
  }

  if (dryRun) {
    return { action: 'dry-run', outPath: out, settingsText, unchanged };
  }

  // H-2 (2026-09-07). A run that computes exactly what the file already holds
  // now stops here. It used to back up and rewrite regardless, which made three
  // false statements at once: the CLI printed `Backed up existing file to ...`
  // and `Wrote ...` about a run that changed nothing, one backup file accrued in
  // the operator's `.claude/` per re-run forever, and the rewrite reformatted a
  // hand-maintained settings file into this installer's own two-space shape.
  // Re-running an installer to find out whether it is installed is the most
  // ordinary thing an operator does with one; it must be free.
  if (unchanged) {
    return { action: 'unchanged', outPath: out, settingsText };
  }

  let backupPath;
  if (fileExisted) {
    backupPath = `${out}.backup-${backupTimestamp(now())}`;
    copyFileSync(out, backupPath);
  }
  // H-3 (2026-09-07). `recursive: true` materialises the WHOLE parent tree, so a
  // typo (`--out .clade/settings.json`) succeeded, reported `Wrote ...`, and left
  // the operator believing the hooks were live in `.claude/`. The directory is
  // still created - refusing would break the documented first-run path - but it
  // is now reported, so a created tree is something the operator reads rather
  // than something they have to go looking for. `mkdirSync` returns the FIRST
  // directory it created (the top of the new tree), which is what the operator
  // has to remove after a typo, and what a failed write must still own up to (JJ4).
  const createdDirectory = mkdirSync(dirname(out), { recursive: true });
  writeSettingsAtomically(out, fileExisted, settingsText, backupPath, createdDirectory);
  return { action: 'written', outPath: out, backupPath, createdDirectory, settingsText };
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
        if (result.createdDirectory !== undefined) {
          console.log(`Created directory ${result.createdDirectory}`);
        }
        console.log(`Wrote ${result.outPath}`);
      } else if (result.action === 'unchanged') {
        console.log(
          `${result.outPath} already matches this installer's output - ` +
            'nothing written, no backup taken.',
        );
      } else if (result.action === 'absent') {
        console.log(
          `${result.outPath} does not exist, so there are no agenthropic hooks to ` +
            'remove. Nothing written, no directory created.',
        );
      } else if (result.action === 'nothing-to-remove') {
        // L-3 (2026-09-23) - see the note in `runInstall`.
        console.log(
          `${result.outPath} holds no agenthropic hooks, so there was nothing to ` +
            'remove. Nothing written, no backup taken, formatting left alone.',
        );
      } else {
        // C-6 (2026-09-23). `runInstall` already reports `unchanged` on a dry
        // run, and the real run says plainly that it wrote nothing - but the
        // dry run threw that away and announced `Would write ...` over a file
        // it would not have touched. A preview that overstates the next run is
        // worse than no preview.
        if (result.action === 'dry-run' && result.outPath !== undefined) {
          if (result.unchanged === true) {
            console.log(
              `[dry-run] ${result.outPath} already matches this installer's output - ` +
                'a real run would write nothing and take no backup. Its contents:',
            );
          } else {
            console.log(`[dry-run] Would write ${result.outPath}:`);
          }
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
