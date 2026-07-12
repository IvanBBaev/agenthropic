# hooks/ — Claude Code hook scripts (placeholder, WP-X8)

**Status: placeholder — no executable code lives here yet.** The installable hook
scripts land in Phase 2 with work package `WP-X8` (which absorbed `WP-IN4`).

## What will live here

Installable Claude Code hook scripts plus install/uninstall documentation:

- Small scripts wired into the user's Claude Code hook configuration
  (e.g. `SessionStart`, `UserPromptSubmit`, `Stop`) that POST lifecycle events to
  the dashboard's **loopback** ingest endpoint (`http://127.0.0.1:<port>`).
- Each POST authenticates with the token read from the `DASHBOARD_TOKEN`
  environment variable.
- An installer that adds the hook entries to the Claude Code settings and an
  uninstaller that removes them cleanly.
- Hook-sourced events are **liveness signals only**; token counts and the
  subagent DAG remain ground truth from the `~/.claude/projects/*.jsonl`
  transcripts (see `docs/analysis/parser-spec.md`).

## Security note

- Hooks talk **only** to the loopback address and **only** with the mandatory
  token — never to any non-loopback host, never unauthenticated.
- The token is read from the environment at send time; it is **never logged,
  never written to disk, and never embedded in the scripts**.
- Hooks **never spawn processes on behalf of the dashboard**. They are
  one-directional fire-and-forget POSTs; the dashboard cannot instruct a hook
  to execute anything. (The browser-driven subprocess spawner is the exact RCE
  class this project deliberately walks away from.)
- A failed or unreachable dashboard must never block or break the user's
  Claude Code session: hooks time out fast and fail silently.
