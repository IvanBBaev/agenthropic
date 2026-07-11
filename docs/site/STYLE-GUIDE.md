# Docs style guide (DOC-P3)

Conventions every docs page follows so parallel authors converge. Applies to all pages
under `docs/site/`.

## Voice & structure
- **English only.** Audience: senior engineers self-hosting Claude Code observability.
- **Front-load the answer.** The first paragraph states what the page covers and the key
  takeaway; detail follows. No throat-clearing.
- **Detailed and precise.** Use headings, tables, code/SQL blocks, and ASCII/mermaid
  diagrams where they clarify. Each page is a thorough reference, not a stub.
- **Evidence, not marketing.** Every non-obvious claim traces to a source (a
  `DESIGN.md §`, an analysis file, or a due-diligence file). Never invent facts, numbers,
  APIs, or file paths. If something is undecided or not yet built, say so and link the
  roadmap/decision.

## Hard invariants (never contradict these in prose or samples)
- The app binds **`127.0.0.1` loopback only** — never `0.0.0.0`.
- It **never** spawns `claude`/subprocesses driven by request input (the hoangsonww
  `/api/run` RCE is the anti-pattern).
- The auth token is **mandatory** (`timingSafeEqual`), not opt-in / not a no-op-when-unset.
- **No SSRF** — never dial a URL taken from an event payload.
- Remote access is via **SSH port-forward or Tailscale tunnel only** — never a reverse
  proxy to the open port.
- Tokens are **ground truth read from `~/.claude/projects/*.jsonl`**, never inferred.

## Mechanics
- **Placeholder secrets** in samples: `DASHBOARD_TOKEN=<token>`, `--host <tailscale-host>`.
  Never a real value.
- **Terminology:** `subagent` (one word), `Claude Code`, `DAG`, `SQLite WAL`,
  `orchestration_edges`, `token_usage`, `events_raw`, ground-truth tokens.
- **Cross-links:** relative Markdown links to sibling pages by slug — e.g. a page under
  `security/` links the data model as `../architecture/data-model.md`; a page under
  `architecture/` links a sibling as `data-model.md`.
- **No generator-specific frontmatter** in content pages — added at assembly.
- **ADRs** use [`contributing/decisions/_adr-template.md`](contributing/decisions/_adr-template.md).

## Definition of Done (per page)
See [`../DOCS-PLAN.md`](../DOCS-PLAN.md) §6.
