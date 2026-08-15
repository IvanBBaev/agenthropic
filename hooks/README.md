# hooks/ — Claude Code hook wiring (WP-X8)

This directory ships the **installer** that wires the user's Claude Code hooks to
the dashboard's loopback ingest endpoint. There are no long-lived scripts here:
each hook is a single fail-silent `curl` POST generated into the Claude Code
settings file by `install.mjs`.

Hook-sourced events are **liveness signals only** (a secondary data source).
Token counts and the subagent DAG remain ground truth from the
`~/.claude/projects/*.jsonl` transcripts — the Phase-0 probe found 0 of 463
spawn edges came from hooks (see `docs/analysis/parser-spec.md`).

## What gets wired

The four **real** Claude Code lifecycle hooks (`SubagentStart` does not exist):

- `UserPromptSubmit`
- `Stop`
- `SubagentStop`
- `PreCompact`

Each one POSTs the hook's stdin JSON, unmodified, to:

```
http://127.0.0.1:<port>/api/hooks/event
```

authenticating with an `Authorization: Bearer <token>` header that **curl
itself** builds at fire time: the command imports the env var with
`--variable '%DASHBOARD_TOKEN'` and expands it inside a single-quoted
`--expand-header 'Authorization: Bearer {{DASHBOARD_TOKEN}}'` template, so the
token value never passes through any process's argv (see
[Security model](#security-model) — this needs curl ≥ 8.3.0). The server
accepts any JSON event
(unknown hook names and extra fields are stored, never rejected), redacts
secret-shaped material at the ingest boundary, and appends idempotently to the
append-only `events_raw` substrate.

### Why installing these matters: they are the ONLY terminal signal

Reading a transcript proves that activity *happened*; it never proves that it
*stopped* (a file that stopped growing is indistinguishable from one whose next
line has not been flushed). So ingest only ever writes `working`, and the two
stop hooks carry the entire ending signal the dashboard has:

| Hook | Status it applies | To which agent |
|---|---|---|
| `SubagentStop` | `completed` | the subagent named by `agent_id`, else the one derived from an `agent-<hex>.jsonl` `transcript_path` |
| `Stop` | `waiting` | the session's main agent — **not** `completed`, because `Stop` fires at the end of every *turn* (see below), so it means "idle right now" |

**If you do not install these hooks, nothing in the dashboard will ever say
`completed`.** Agents go `working` → `unknown` once the watchdog window
(`DASHBOARD_WATCHDOG_MINUTES`, default 10) elapses. That is intentional: the
dashboard declines to claim an ending nobody observed.

Applying a status is still **liveness, never structure** (CD-1). The applier is
UPDATE-only by construction: it can move the `status` column of an agent the
JSONL parser already created, and nothing else — it cannot create, delete or
re-parent an agent. A hook naming an agent this server has never parsed is
stored as raw liveness and changes no row.

### Recurrence vs redelivery (`X-Agenthropic-Delivery-Id`)

A `Stop` body is **byte-identical on every turn** of a session (`session_id`,
`transcript_path`, `cwd`, `hook_event_name`, `stop_hook_active` — nothing
turn-specific), so hashing content alone cannot tell *"this happened again"*
from *"this was delivered twice"*. Only the sender knows. The generated command
therefore stamps each firing with a delivery id that the **shell expands at fire
time** (`$$-$(date +%s)-$RANDOM`) and sends as `X-Agenthropic-Delivery-Id`; the
server folds it into the idempotency key.

Consequences:

- Two genuine firings of an identical body → two rows (the liveness timeline
  shows every turn).
- A retry of the *same* firing reuses its id → zero new rows, `stored: false`.
- A client that sends **no** id keeps the older, conservative behaviour: a
  genuine recurrence collapses into the first delivery. Absent ids are omitted
  from the key material, so keys already in `events_raw` stay valid.
- A client that mints a *new* id per network attempt would double-count that
  retry — mint the id once per firing, not once per attempt.

The header is **key material only**: never persisted, never logged, never echoed
back, and it never influences the agent/edge topology (CD-1 — hooks are liveness,
never structure). Values longer than 200 characters are rejected with a 400 that
does not echo the value.

## Usage

Print the generated configuration (writes nothing):

```sh
node hooks/install.mjs
```

Install into a project's Claude Code settings (creates or updates the file,
merging non-destructively):

```sh
node hooks/install.mjs --out /path/to/project/.claude/settings.json
```

Options:

| Flag | Meaning |
| --- | --- |
| `--out <path>` | Settings file to create/update. Without it, print to stdout. |
| `--port <n>` | Dashboard port (default `4317`, matching the server default). |
| `--token-env <NAME>` | Env var name the command reads the token from (default `DASHBOARD_TOKEN`). |
| `--dry-run` | Show what would be written; write nothing. |
| `--remove` | Strip previously installed agenthropic entries, keep everything else. |

The installer never touches `~/.claude` unless you explicitly pass an `--out`
path there.

## Merge behavior and rollback

- **Non-destructive merge:** unrelated settings keys and unrelated hook entries
  are preserved verbatim. Agenthropic entries (recognized by the loopback
  `/api/hooks/event` target in the command string) are replaced in place —
  re-running the installer never duplicates them.
- **Backup:** before modifying an existing file the installer copies it to
  `<file>.backup-<timestamp>` next to the original.
- **Rollback:** copy the backup over the settings file, or run with `--remove`
  to strip only the agenthropic entries.
- The installer refuses to touch a file it cannot parse as JSON.

## Verifying the wiring

Nothing in the generated command reports success anywhere you can see it — it is
`--silent --fail` with a trailing `|| true`, deliberately, so that a broken
dashboard cannot break a Claude Code session. Confirmation therefore has to come
from the server side:

```sh
curl -s -H "Authorization: Bearer $DASHBOARD_TOKEN" http://127.0.0.1:4317/api/health
```

A dashboard that is up but silent is almost always one of three things: the token
in your environment is not the one the server started with, `curl` is older than
8.3.0 (see the security notes below), or the hooks were installed into a settings
file that this project does not use. The health response and the server's ingest
log are how you tell those apart — the fields it reports, the ones it deliberately
omits rather than faking, and the skip/quarantine lines are all documented in
[troubleshooting](../docs/site/operations/troubleshooting.md).

## Security model

- Hooks talk **only** to the loopback address (`127.0.0.1`, hard-pinned in the
  generated command) and **only** with the mandatory Bearer token.
- **The token has a minimum length, enforced at startup.** The server refuses to
  boot unless `DASHBOARD_TOKEN` is at least 16 characters
  (`MIN_TOKEN_LENGTH` in `packages/shared/src/security/index.ts`), because
  "mandatory" alone would be satisfied by `DASHBOARD_TOKEN=x` — a token that is
  present and useless, which is the failure mode the rule was written against.
  Sixteen is a chosen floor rather than a measured one; its practical effect is
  that the value has to come from a generator (`openssl rand -hex 32` or
  equivalent) instead of from typing. The installer never sees the value either
  way, so this constrains what you export, not what you install.
- **The token value appears in no process's argv** — not the hook shell's and
  not curl's own. The generated command hands curl the env var **name**
  (`--variable '%DASHBOARD_TOKEN'`) and a single-quoted header template
  (`--expand-header 'Authorization: Bearer {{DASHBOARD_TOKEN}}'`); curl reads
  the environment itself, after argv parsing. This matters because argv is
  readable by other processes (`ps`, `/proc/<pid>/cmdline` on Linux), and the
  first shipped command shape (`--header "… Bearer ${DASHBOARD_TOKEN}"`, fixed
  2026-08, review item M-11) let another OS account harvest the token from the
  process table during the up-to-3-second POST window — exactly the
  local-multi-user attacker the token exists to stop.
- **Rotation stays trivial** because the environment remains the only runtime
  source of truth: no token-bearing file is written at install time, so
  rotating the token is "export the new value" — nothing to regenerate and no
  stale copy on disk.
- **Requires curl ≥ 8.3.0** (`--variable`/`--expand-header`; macOS ≥ 14.4 and
  current Linux distributions ship newer). An older curl rejects the unknown
  option at parse time and sends **nothing** — the hook still exits 0 (a short,
  token-free error goes to stderr), so it degrades to zero telemetry, never to
  a leaked token and never to a blocked session. If your dashboard receives no
  hook events, check `curl --version` first. A settings file installed before
  this fix is upgraded in place by re-running the installer.
- **Residual exposure, stated honestly:** processes of the **same** OS account
  (and root) can always read the token — from the process environment, from
  the shell profile or `launchd` plist that exports it, or by asking the same
  APIs the hook uses. The argv fix closes the cross-account `ps` window; it
  does not (and cannot) defend against an attacker already running as you or
  as root.
- The installer never reads, embeds, prints, or otherwise touches the token
  value, and the server never logs, persists, or echoes it.
- The installer itself **never spawns processes and never talks to the
  network**; its only side effect is writing the one file you point it at
  (plus that file's backup). The generated `curl` command runs on the Claude
  Code side, never inside the dashboard server (which contains no subprocess
  surface at all — enforced by `pnpm gate:spawner`).
- A failed or unreachable dashboard never blocks the Claude Code session: the
  command is `--silent --fail` with `--max-time 3` and a trailing `|| true`,
  and Claude Code additionally applies its own hook timeout.

## Pending decisions (defaults, awaiting sign-off)

- **Auth mechanism (OPEN-5):** shared Bearer token over loopback — matches the
  server's existing global auth gate. Unix-socket peer credentials remain the
  catalogued alternative.
- **Redaction phase (OPEN-3):** payloads are redacted at the ingest boundary
  from Phase 1 (the audit-recommended resolution, implemented as the default in
  `apps/server/src/hooks/redact.ts`). The fuller retention side (WP-D10) still
  awaits the OPEN-1/2/3 sign-off in `docs/analysis/open-decisions.md`: the
  sweeper mechanism is built and tested, but its policy is deliberately blank
  and its runner is called from tests only, so **nothing currently deletes a
  stored hook event**. Redaction, not expiry, is what keeps `events_raw` free of
  secret-shaped material today.
