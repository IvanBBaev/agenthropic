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

authenticating with `Authorization: Bearer ${DASHBOARD_TOKEN}` — the env var is
expanded **by the shell at fire time**. The server accepts any JSON event
(unknown hook names and extra fields are stored, never rejected), redacts
secret-shaped material at the ingest boundary, and appends idempotently to the
append-only `events_raw` substrate — a duplicate delivery inserts zero rows.

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

## Security model

- Hooks talk **only** to the loopback address (`127.0.0.1`, hard-pinned in the
  generated command) and **only** with the mandatory Bearer token.
- The token is read from the environment **at fire time**; the installer never
  reads, embeds, prints, or otherwise touches the token value, and the server
  never logs, persists, or echoes it.
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
  `apps/server/src/hooks/redact.ts`). The fuller retention/redaction policy
  (WP-D10) awaits the OPEN-1/2/3 sign-off in `docs/analysis/open-decisions.md`.
