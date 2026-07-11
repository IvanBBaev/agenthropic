# NirDiamant/claude-watch — **C+**

**Panel:** C+ (v1) / 2.6 (v2) · **Independent:** **C+** = · **Role: complement at
best; one pattern worth stealing.**

The one project where the panel's grade holds. It ingests live tool-calls correctly
but renders them in the wrong shape for `agenthropic`.

## What it does

- Real live ingest: hook → `/api/events` → SQLite → WebSocket.
- Renders as a **flat chronological feed**, fronted by a gimmicky static-config
  **"brain-scanner"** — which is just a regex keyword classifier, not real analysis.

## Why it's the wrong shape

- **No parent→child nesting; no `SubagentStop` handling.** There is no subagent
  hierarchy at all — the opposite of what `agenthropic` needs.
- Its only "AI" feature requires `ANTHROPIC_API_KEY` and **ships your files to
  Anthropic** to classify them.

## Quality & security

- **Zero tests.**
- **Command injection** in the snapshot name via a double-quoted `execSync` `$(...)`.
- **No LICENSE file**, though MIT is declared.

## The one pattern worth stealing

- Its **non-destructive run-checkpoint**: git `stash` + tag to snapshot working state
  around a run, without a destructive reset. A clean idea, portable to `agenthropic`'s
  session model.

## Verdict

Correct ingest, wrong visualisation, privacy-leaky AI feature, injectable. A possible
complement, never a base. **C+.**
