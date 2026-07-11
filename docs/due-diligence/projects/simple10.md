# simple10/agents-observe — **A−**

**Panel:** B+ (v1) / **4.1, highest** (v2) · **Independent:** **A−** ▲ · **Role:
recommended base.**

Metrics (2026-07-03): **607★ / 58 forks**, pushed **29 Jun**, **MIT + real LICENSE**
(© 2025 Joe Johnston). The report's "rate-limited / stale 5 Jun / no true DAG" read
was wrong on all three counts.

## Why it wins

### It has the subagent graph the report said it lacked
- `constellation/agent-tree.ts → buildAgentTree()` builds a real parent→child subagent
  tree: orphan-reparenting, root synthesis, drawn edges.
- A bespoke dependency-free N-body **live force-directed graph** renders it.
- Edges are **derived from the event stream**, session-scoped (not persisted as
  first-class rows) — the one real extension point for a global/historical DAG.

**This single fact refutes the panel's tie-break** (see
[../report-meta-audit.md](../report-meta-audit.md) §1).

### Tests are real
- **78 test files, 1,985 `expect()` calls.** `agent-tree.test.ts` asserts nesting and
  reparenting behaviour directly.
- Caveats: **no test-on-PR CI** (tests run only via `just check`), and the report's
  "semantic-release CI" claim is **false** — releases are a hand-rolled `release.sh`.

### Docker is avoidable (the decisive operational trade-off)
- The plugin happy-path is hard-Docker, **but** `AGENTS_OBSERVE_RUNTIME=local` /
  `just start-local` runs pure Node + native `better-sqlite3`, no daemon.
- Fits the Mac Mini constraint (no always-on Docker next to Ollama/Telegram) → run
  under `launchd`.

### Clean, forkable architecture
- Ports/adapters storage; **strategy-pattern agent classes** (Claude Code + Codex +
  a `hermes` variant) → extensible to new agent runtimes.
- 5-table schema: `projects`, `sessions`, `agents`, `events`, `filters`. Hierarchy is
  derived from the event stream rather than stored — clean, but persist it if a global
  DAG is wanted.
- arm64 multi-arch image; runs natively on M4.
- Highest overall forkability for an OPCⁿ product of the whole set.

## Must-fix before exposure

- Binds **0.0.0.0**, **wildcard CORS**, **no auth** — LAN-exposed as shipped.
- Stores **full tool payloads** (redact).
- **First patch:** bind `127.0.0.1`, add a `DASHBOARD_TOKEN`, same-origin WS check.
  See [../security.md](../security.md).

## What's missing (build backlog)

- No Telegram sink → graft `hoangsonww`'s `formatTelegram`.
- No dollar-cost / delegation-savings → graft `cast`'s metric.
- Session-scoped, non-persisted edges → persist + add a global historical DAG view.
- Single-host → cross-machine aggregation is future work.

## Verdict

The disciplined option the panel under-rated: real graph, real tests, clean license,
Docker-optional, most forkable. **A−**, held back from A only by the 0.0.0.0/no-auth
posture and the non-persisted, session-scoped edges. **Recommended base** — see
[../recommendation.md](../recommendation.md).
