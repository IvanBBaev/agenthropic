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

> **AMENDED 2026-09-02.** The parenthesis is out of date. It was written when
> `SubagentStart` genuinely was not in the hook list, and it is now false:
> Claude Code 2.1.251 declares `SubagentStart` (among others, including
> `SessionEnd` and `PostCompact`) in its own settings schema and fires it with
> `agent_id` and `agent_type`. What has **not** changed is which hooks this
> installer wires, and why. The four above are the ones that carry a signal
> the transcripts cannot supply — an *ending*. A start signal adds nothing:
> ingest already writes `working` for an agent the moment its transcript
> appears, and under CD-1 a hook may never create or re-parent an agent, so a
> `SubagentStart` delivery would be a row that changes no row. Wiring it is a
> data-model decision, not a wiring convenience; it stays out until someone
> argues for it on the merits.

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

> **AMENDED 2026-09-02.** The first sentence is **false**, and it is the load-
> bearing sentence of this section, so it needs correcting rather than
> softening.
>
> *What was believed:* the fields a `Stop` hook receives are the documented
> common ones — `session_id`, `transcript_path`, `cwd`, `hook_event_name`,
> `stop_hook_active` — every one of them constant for the life of a session.
> On that reading a `Stop` body really would be the same bytes every turn.
>
> *Why it was believed:* it was never measured. It cannot be measured from the
> corpus this project reads — `~/.claude/projects/*.jsonl` records the
> conversation, not the hook deliveries, so no transcript anywhere contains a
> `Stop` payload to compare against another.
>
> *What is actually true:* read off the payload builder in Claude Code 2.1.251,
> a `Stop` body also carries `prompt_id`, `permission_mode`, `agent_type`,
> `effort`, `last_assistant_message`, `background_tasks` and `session_crons`.
> Two of those — `prompt_id` and `last_assistant_message` — differ from turn to
> turn in the ordinary case. So consecutive `Stop` bodies are usually *not*
> byte-identical. (`stop_hook_active` is real; that part of the list stands.
> `SubagentStop` additionally carries `agent_id` and `agent_transcript_path`.)
>
> *Why the delivery id survives the correction unchanged:* the argument only
> ever needed the second sentence. Content equality cannot distinguish
> recurrence from redelivery **in general** — two firings are permitted to
> carry identical bytes, nothing in the hook contract promises a turn-varying
> field, and which fields a given Claude Code version includes is not something
> this project controls or gets notified about. The sender is the only party
> that knows which firing this is. A design resting on "the payload happens to
> vary" would have been the fragile one; this one never rested on it, it just
> described itself with an unverified claim.

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

AMENDED 2026-09-07 (finding H-1). Every flag that takes a value now refuses a
value that begins with a dash. Previously a dropped value was swallowed by the
flag behind it: `--out --dry-run` set the output path to the literal string
`--dry-run`, ran no dry run at all, and wrote a real settings file under that
name in the current directory — the operator's belief and what happened were
opposites, and nothing said so. If you genuinely want a path that starts with a
dash, write it as `./-name`.

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
- **A run that changes nothing writes nothing.** If the computed settings are
  byte-for-byte what the file already holds, the installer takes no backup, does
  not rewrite the file, and says so (`... already matches this installer's
  output - nothing written, no backup taken.`).
- **A created parent directory is reported.** Installing to a path whose parent
  does not exist still creates the whole tree, and now prints
  `Created directory <path>`.

AMENDED 2026-09-07 (findings H-2, H-3). The two bullets above are new, and both
correct something this section used to imply rather than say. On the first: the
installer backed up and rewrote on EVERY run, so re-running it to check whether
it was installed — the most ordinary thing anyone does with an installer —
printed `Backed up existing file to ...` and `Wrote ...` about a change that was
not made, left one more backup file in `.claude/` each time, and reformatted a
hand-indented settings file into the installer's own two-space shape. On the
second: `--out` creates its parent tree recursively, so a typo such as
`--out .clade/settings.json` succeeded silently and left the operator believing
the hooks were live in `.claude/`. The directory is still created — refusing
would break the documented first-run path — but it is no longer invisible.

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

> **AMENDED 2026-09-02.** Two corrections and one addition.
>
> *The first paragraph is now half wrong, in the good direction.* The generated
> command carries `--show-error` alongside `--silent`, so a **failed** firing
> does print exactly one line of curl's own error text (a success still prints
> nothing). Where that line goes depends on your setup: Claude Code runs hooks
> with piped stdio and captures their output, so it lands in Claude Code's hook
> output rather than in your terminal — it cannot corrupt the TUI, and it can
> also be easy to miss. The line never contains the token: it names the URL and
> the status, and the token exists only inside curl's own variable space.
>
> *`/api/health` cannot answer the question this section asks it to.* It tells
> you the server is up and authenticating you; it carries **no** field for hook
> deliveries — not a count, not a last-seen timestamp — so a server that has
> received zero hook events in its life reports exactly what a busy one
> reports. Use it to rule the server out, never to rule the wiring in.
>
> *What does answer it* is sending the same request the hook sends, by hand,
> with the flags that make the outcome visible. This is the generated command
> with `--fail` swapped for `--write-out` and the delivery-id header dropped:
>
> ```sh
> printf '{"hook_event_name":"Stop","session_id":"install-probe"}' | \
>   curl --silent --show-error --max-time 3 --output /dev/null \
>     --request POST --header 'Content-Type: application/json' \
>     --variable '%DASHBOARD_TOKEN' \
>     --expand-header 'Authorization: Bearer {{DASHBOARD_TOKEN}}' \
>     --write-out 'HTTP %{http_code}\n' --data-binary @- \
>     'http://127.0.0.1:4317/api/hooks/event'
> ```
>
> `HTTP 202` means the whole path works and the event was stored — it is a real
> event, so expect a `Stop` liveness row for session `install-probe`. `HTTP 401`
> is the token, `HTTP 000` with `curl: (7)` is nothing listening on that port,
> `curl: (28)` is a server that accepted the connection and then hung, and an
> `unknown option` error is a curl older than 8.3.0.

### What failure looks like, and what it does not look like

Stated plainly, because the section above used to imply better than this: a
delivery that fails is **lost**. Nothing retries it, nothing spools it to disk,
nothing counts it. The single `--show-error` line is the entire record, and it
exists only until the surrounding output scrolls away. A dashboard that has
silently dropped every event since Tuesday is, from the hook side, still
indistinguishable from a healthy one unless somebody was reading that output at
the moment it happened.

Known ways a firing is lost:

- **Dashboard down, wedged, or on another port** — `curl: (7)` / `curl: (28)`.
- **Wrong or missing token** — HTTP 401. `--fail` suppresses the body, so the
  visible trace is `curl: (22) The requested URL returned error: 401`.
- **Payload over 1 MiB** — HTTP 413 (`curl: (22) … error: 413`). The server
  inherits Fastify's default 1 MiB body limit; it is not a chosen number, and
  nothing truncates or splits an oversized body. This is not hypothetical: a
  `Stop` body carries `last_assistant_message`, so one very long final answer
  can put a turn over the line. The event is rejected whole.
- **curl older than 8.3.0** — rejected at option-parse time, nothing sent.

Whether that should stay this way is an open policy question (a spool, a retry,
or a delivery counter on `/api/health` are all buildable and all trade something
away); it is recorded under [Pending decisions](#pending-decisions-defaults-awaiting-sign-off)
rather than decided here.

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

  > **AMENDED 2026-09-02.** As written, that bullet was false — and the flags
  > it cites are not what would have made it true. *What was believed:*
  > "fail-silent, exits 0" was treated as "the session never notices". *What is
  > true:* the exit code is not the cost; the **wait** is. Every entry this
  > installer generated was a synchronous hook, so Claude Code waited for curl
  > to return before the turn could continue — up to the full `--max-time 3` on
  > every prompt, every turn end, every subagent finish and every compaction,
  > precisely when the dashboard was unreachable or wedged. Four hook events
  > times a busy session is a real, measurable tax paid for a *broken*
  > dashboard.
  >
  > The generated entries now set **`async: true`**, which is the field that
  > actually buys the claim: Claude Code writes the hook JSON to the command's
  > stdin, closes it, backgrounds the process and continues immediately. The
  > `timeout` stays (it becomes the background process's bound), and
  > `--max-time 3` stays because a Claude Code too old to know the field
  > ignores it and keeps waiting — on such a version the original wording is
  > still wrong, and three seconds is the worst case.
  >
  > Re-run the installer to upgrade a settings file written before this change;
  > the merge replaces the old entries in place.

## Pending decisions (defaults, awaiting sign-off)

- **Auth mechanism (OPEN-5):** shared Bearer token over loopback — matches the
  server's existing global auth gate. Unix-socket peer credentials remain the
  catalogued alternative.
- **Delivery durability (raised 2026-09-02, undecided):** a failed firing is
  dropped and unrecorded — see [What failure looks like](#what-failure-looks-like-and-what-it-does-not-look-like).
  `--show-error` makes a failure *visible* to whoever is watching, which is the
  smallest honest fix and the only one taken so far. Making it *durable* means
  choosing one of: a spool file (buys replay, costs a retention policy and puts
  possibly-secret-shaped payloads on disk **outside** the ingest redaction
  boundary — a real privacy regression), an in-command retry (buys nothing
  against a dashboard that is simply down, costs session time and risks
  double-counting if the id is re-minted per attempt), or a delivery counter on
  `/api/health` (buys "is it arriving?" at a glance, costs a server-side change
  and still records nothing about *what* was lost). None is obviously right;
  none should be picked by an installer.
- **Payload size cap (raised 2026-09-02, undecided):** the 1 MiB limit is
  Fastify's default rather than a decision, and an oversized body is rejected
  whole (413). Options are to raise the cap, or to have the server store a
  truncated marker row so the loss is at least recorded. Untouched pending
  sign-off.
- **Redaction phase (OPEN-3):** payloads are redacted at the ingest boundary
  from Phase 1 (the audit-recommended resolution, implemented as the default in
  `apps/server/src/hooks/redact.ts`). The fuller retention side (WP-D10) still
  awaits the OPEN-1/2/3 sign-off in `docs/analysis/open-decisions.md`: the
  sweeper mechanism is built and tested, but its policy is deliberately blank
  and its runner is called from tests only, so **nothing currently deletes a
  stored hook event**. Redaction, not expiry, is what keeps `events_raw` free of
  secret-shaped material today.
