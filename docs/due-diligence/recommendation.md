# Recommendation

> **⚠️ SUPERSEDED (2026-07-04, banner added 2026-07-06).** The evidence and grades in
> this dossier remain valid and citable. The *recommendation* below (fork simple10;
> graft cast `analytics.ts`) is superseded: the project is a **greenfield clean build**
> per [`../analysis/best-path-decision.md`](../analysis/best-path-decision.md), and
> cast/disler/nirdiamant code is clean-room-only per CD-9. Current entry point:
> [`../analysis/PROJECT-STATE-2026-07-06.md`](../analysis/PROJECT-STATE-2026-07-06.md).

> **Status: recommendation only. No action taken.** The direction is Ivan's to pick.

## Decision

**Fork `simple10/agents-observe` as the base for `agenthropic`.** This *flips* the
vendor panel's primary pick (hoangsonww → simple10).

### Why simple10

- **Highest independent grade (A−)** and it also wins the panel's *own* weighted model
  (4.1) once the refuted "no DAG" claim is corrected.
- **Genuine subagent hierarchy graph** — `buildAgentTree()` + live force-directed
  graph — the exact core capability `agenthropic` exists to provide.
- **Real tests** (78 files, 1,985 `expect()`), clean ports/adapters architecture,
  strategy-pattern agent classes → the most forkable base for an eventual OPCⁿ product.
- **MIT + a real LICENSE file** (© 2025 Joe Johnston) → no legal blocker, unlike disler
  (no license) or cast (license-by-badge).
- **Docker is avoidable** — `AGENTS_OBSERVE_RUNTIME=local` / `just start-local` runs
  pure Node + native `better-sqlite3`, so it lives under `launchd` next to Ollama and
  the Telegram bot with no always-on daemon (the trade-off the panel overweighted).

See [projects/simple10.md](projects/simple10.md) for the full evidence.

## Step plan (once approved — not started)

1. **Harden first, before running anything networked.**
   - Bind `127.0.0.1`; add a `DASHBOARD_TOKEN` + same-origin WS check.
   - Run via `AGENTS_OBSERVE_RUNTIME=local` under `launchd` — no Docker daemon.
   - Redact stored tool payloads.
2. **Validate the graph on a real session.** Run one genuinely subagent-heavy
   orchestration and confirm `buildAgentTree` renders the nesting the way expected.
   *This gate comes before any grafting* — if the graph doesn't hold up, reconsider.
3. **Graft the two best rival ideas:**
   - `hoangsonww`'s `formatTelegram` webhook provider (`webhook-providers.js:177`) →
     alerts to **@baev_bot_bot**.
   - `cast`'s delegation-savings metric (`analytics.ts:233-310`, ~50 LOC; re-verify
     the hardcoded pricing table).
4. **Extend toward the gap** (the OPCⁿ moat): persist the subagent edges as
   first-class rows (today they're event-derived at render time); add a global,
   historical DAG view (ELK/Graphviz over the persisted tree); plan cross-machine
   aggregation.
5. **Keep `hoangsonww` cloned as reference only** — for its D3 Sankey / aggregate-DAG
   polish and its webhook schema.

## Alternatives (documented, not recommended)

- **If out-of-box richness *today* matters more than clean ownership:** adopt
  `hoangsonww` loopback-only, **delete `run.js`/`run-spawner.js` first** (RCE), and
  accept the bus-factor-1 support burden on 92k LOC by a single author.
- **Do not** base anything commercial on `disler` (no license, no tests, no hierarchy)
  or `cast` (CAST-OS lock-in — 37/51 routes welded to `getCastDb` — + license-by-badge).
- **Build-from-scratch** stays on the table as a later option, but forking simple10 is
  strictly faster to a working DAG and inherits its test suite; a clean rebuild is only
  justified if the graft/extend work reveals simple10's model is a poor fit.

## What to steal, regardless of base

| From | What | Where | Size |
|---|---|---|---|
| cast | `controlGate.ts` read-only-by-default security shape | `controlGate.ts` | ~73 LOC |
| cast | delegation-savings (Haiku re-priced at Sonnet) | `analytics.ts:233-310` | ~50 LOC |
| hoangsonww | Telegram/webhook provider + alert schema | `webhook-providers.js:177` | small |
| disler | the clean hook→HTTP→SQLite→WS ingest loop (as a *teaching* reference) | `send_event.py` | ~180 LOC |
| nirdiamant | non-destructive git-`stash`+tag run-checkpoint pattern | snapshot handler | small |
| claude-code-templates | chokidar watch over `~/.claude` JSONL; zero-install DX bar | `AgentAnalyzer.js` | pattern |

## Open questions for Ivan

1. **Session-scoped vs global DAG** — is a per-session tree enough at first, or is the
   global cross-session/cross-machine orchestration graph a v1 requirement?
2. **Commercial intent (OPCⁿ)** — does "may commercialize later" harden into a v1
   constraint now (affects license hygiene, multi-tenant data model)?
3. **Fork vs build** — approve the simple10 fork, or want a scratch build evaluated
   first?
