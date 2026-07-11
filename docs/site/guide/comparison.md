# Comparison vs the field

This page lines up agenthropic's committed design against the honest market baseline —
`davila7/claude-code-templates` (28.4k★, MIT) — and the five dashboards independently
audited alongside it, across the axes that matter for a subagent-heavy Claude Code
workflow: a persisted subagent DAG, dollar-cost attribution, data that survives a
restart, a Telegram alert sink, cross-machine reach, and security posture (bind
address, auth, and whether the tool can spawn a `claude` subprocess). **The key
takeaway: no audited project — including the 28.4k-star baseline — combines more than
two or three of these, and the ones that come closest each carry something not worth
inheriting** (an insecure-by-default bind, a live remote-code-execution spawner, or a
schema welded to a vendor's own product). That gap, not a feature wish-list, is why
agenthropic exists; see [the moat](the-moat.md) for the full evidence trail behind each
missing capability.

Every fact below is drawn from the project's own source-level due-diligence audit,
cross-checked against the GitHub API on 2026-07-03 — not from each project's own
README claims. Letter grades are cited for context only; they are not the point of
this page (full grading rationale: [the moat §3](the-moat.md)).

## The baseline: `davila7/claude-code-templates`

Before comparing against five niche rivals, agenthropic has to clear the bar set by the
tool the vendor due-diligence panel missed entirely: a real, popular, actively
maintained product, not a strawman. `npx claude-code-templates --analytics` is a live
Express dashboard on port `:3333` that reads `~/.claude` JSONL directly, watched live
with `chokidar` — zero-install, no Docker, MIT-licensed with a real `LICENSE` file, and
28.4k★.

**What it nails:**

- **Self-hosted.** Runs entirely on your machine, no account, no cloud tier.
- **Zero-install developer experience.** One `npx` command, nothing to build or
  containerize — the DX bar the whole category should be measured against.
- **Live token attribution.** Reads Claude Code's own JSONL transcripts directly, so
  the numbers it shows are ground truth, not an estimate.

**The four things it lacks** (the market gap agenthropic is built to close — two of
them, the persisted DAG and dollar-cost attribution, are the moat proper; see
[the moat](the-moat.md)):

1. **No subagent DAG.** The subagent view is a flat leaderboard/timeline
   (`AgentAnalyzer.js`) — there is no parent→child graph at all, nested or otherwise.
2. **No persistence.** It holds state in an in-memory TTL cache; restart the process
   and history is gone — no historical or time-series analysis is possible.
3. **No dollar-cost attribution.** Token counts are shown, but nothing prices them or
   quantifies what a cheaper-model routing choice saved.
4. **No Telegram / alerting.** There is no outbound notification path at all.

On top of the four feature gaps, it also **binds `0.0.0.0` with no authentication** —
covered in the security table below, not counted among the four, since that is a
posture problem shared by nearly the whole field, not something unique to this
baseline.

## Feature comparison

Legend: **✅** shipped and confirmed · **⚠️** partial or caveated · **❌** absent ·
**—** not evidenced in the audit.

| Project | Subagent DAG | Dollar-cost attribution | Persistence | Telegram sink | Cross-machine |
|---|---|---|---|---|---|
| **agenthropic** *(design target, pre-code)* | ⚠️ **planned** — persisted, per-instance `orchestration_edges`, built two independent ways (Phase 3) | ⚠️ **planned** — delegation-savings off ground-truth `token_usage` (Phase 3) | ⚠️ **planned** — append-only `events_raw` + SQLite WAL (Phase 1) | ⚠️ **planned** — Telegram delivery adapter (Phase 5) | ⚠️ **not scheduled** — `instance`/`host` key reserved on every row, aggregation itself not yet a work package |
| `davila7/claude-code-templates` (28.4k★, MIT) | ❌ flat leaderboard/timeline only | ❌ | ❌ in-memory TTL cache | ❌ | ❌ |
| `simple10/agents-observe` (607★, MIT) | ⚠️ real `buildAgentTree()` parent→child tree + force-directed graph, but edges are event-derived at render time, session-scoped, never persisted as first-class rows | ❌ | ✅ SQLite (`projects`/`sessions`/`agents`/`events`/`filters`) | ❌ | ❌ single-host |
| `hoangsonww/Claude-Code-Agent-Monitor` (92,163 LOC, MIT) | ⚠️ real nested tree via a persisted `agents.parent_agent_id` column, recursively rendered — but the flagship `OrchestrationDAG.tsx` is a **type-aggregated**, 3–4-layer diagram of agent *categories*, not a per-instance graph | — no cost/pricing schema or live delegation-savings metric documented in the audit | ✅ 12-table schema, dual SQLite driver | ✅ first-class `formatTelegram` webhook provider + `alert_rules`/`webhook_targets`/`webhook_deliveries` schema | ❌ single-host |
| `ek33450505/claude-code-dashboard` ("CAST", 3★) | — no hierarchy feature documented | ✅ delegation-savings metric (`analytics.ts:233-310`); pricing table hardcoded, re-verify | ✅ persisted, but **welded to a separate CAST host product** — 37/51 route files import `getCastDb` | ❌ | ❌ single-host |
| `disler/claude-code-hooks-multi-agent-observability` (1,475★) | ❌ server **drops** `agent_id`/`agent_type` on ingest (`db.ts:127`); single flat `events` table, no parent column, no graph library anywhere | ❌ | ✅ SQLite `events` table, but flat — no hierarchy to persist | ❌ | ❌ single-host |
| `NirDiamant/claude-watch` | ❌ no parent→child nesting, no `SubagentStop` handling at all | ❌ | ✅ SQLite via `/api/events` | ❌ | ❌ single-host |

The pattern across every rival's "DAG" column is the same shape: **no rival persists
a per-instance orchestration DAG with long-horizon, cross-session history and dollar
attribution — at best a session-scoped tree whose edges are derived at render time.**
`simple10` gets closest with a genuine tree-building algorithm, but never persists
the edges; `hoangsonww` genuinely persists parent/child as a column, yet the tree
stays session-scoped and it oversells a separate, type-aggregated visualization as if
it were that same per-instance graph. Nobody
ships a **global, cross-session, instance-keyed** orchestration graph — that is
exactly moat item #1 (see [the DAG moat](../architecture/dag-moat.md), open page).

## Security posture

The feature gaps above are only half the picture — the security posture across the
audited field is worse than the "loopback by default" framing a vendor report gave it.
Every viable candidate binds `0.0.0.0` and/or ships auth that is a no-op in practice.

| Project | Bind | Auth | Spawner / RCE |
|---|---|---|---|
| **agenthropic** *(committed, non-negotiable)* | `127.0.0.1` loopback only, always | mandatory `DASHBOARD_TOKEN`, `timingSafeEqual` compare | **none, ever** — never spawns `claude` or any subprocess driven by request input |
| `davila7/claude-code-templates` | `0.0.0.0` | none | not evidenced |
| `simple10/agents-observe` | `0.0.0.0` | none, wildcard CORS | not evidenced |
| `hoangsonww/Claude-Code-Agent-Monitor` | configurable | `DASHBOARD_TOKEN` — **no-op when unset** | **RCE** — `/api/run` accepts a `permission-mode` from the browser request body; `ALLOWED_PERMISSION_MODES` includes `bypassPermissions` (`run.js:96`), so a browser request spawns `claude --permission-mode bypassPermissions` in an attacker-chosen directory |
| CAST (`ek33450505/claude-code-dashboard`) | `0.0.0.0` | writes gated well (`controlGate.ts`: non-safe verbs 404 unless `CAST_DASHBOARD_CONTROL=1` **and** a token, `timingSafeEqual`) — but **unauthenticated GET reads dump every table** | not evidenced |
| `disler/…observability` | not documented in the audit | none, CORS `*` | **SSRF** — dials an arbitrary `responseWebSocketUrl` taken from the request body (`index.ts:198-201`); unauthenticated `POST /events`; the `.env`/key guard is commented out (`pre_tool_use.py:324-327`) |
| `NirDiamant/claude-watch` | not documented in the audit | none | **command injection** in the snapshot name via a double-quoted `execSync $(...)` |

Two takeaways worth calling out explicitly, since they define agenthropic's own
non-negotiable posture (in full on [the security model](../security/model.md), open
page):

- **Worst in class:** `hoangsonww`. On `0.0.0.0` with no token set, `/api/run` is a
  remote-code-execution box — a browser request runs `claude` as the host user in a
  directory the request chooses. The concurrency cap a vendor report flagged is a red
  herring; the permission mode is the actual lever. The spawner is cleanly excisable
  (~6 files, one mount line, one table) if that codebase were ever touched — but
  agenthropic never builds this surface at all.
- **Best pattern worth stealing:** CAST's `controlGate.ts` — read-only by default,
  non-safe verbs 404 unless a control flag **and** a token are both set,
  `timingSafeEqual` compare, mounted before the router. ~73 dependency-free lines.
  Adopted regardless of what else is grafted (see [the moat §5](the-moat.md)).

## The persisted-DAG gap, visualized

The reason "has a tree" and "has a moat" are different claims:

```
Every audited rival, at best:                    agenthropic (Phase 3, planned):

events (flat log)                                events_raw (append-only, immutable)
   │                                                    │
   ▼                                                    ▼
in-memory tree, rebuilt on every render           deterministic projection
(session-scoped; discarded on restart                   │
 or when the next session starts)                       ▼
                                                   agents.parent_agent_id
                                                   + orchestration_edges
                                                   (persisted rows, instance/host-keyed,
                                                    built two independent ways)
                                                          │
                                                          ▼
                                                   queried, not reconstructed —
                                                   survives a restart, spans sessions,
                                                   ready for cross-machine rollup
```

The persisted side of that diagram starts from the self-referential column
`agenthropic` grafts from `hoangsonww`'s schema onto `simple10`'s clean base:

```sql
CREATE TABLE agents (
  id              TEXT PRIMARY KEY,
  session_id      TEXT NOT NULL,
  type            TEXT CHECK(type IN ('main','subagent')),
  subagent_type   TEXT,
  status          TEXT CHECK(status IN ('working','waiting','completed','error')),
  parent_agent_id TEXT,          -- self-ref: builds the subagent tree
  FOREIGN KEY (parent_agent_id) REFERENCES agents(id) ON DELETE SET NULL
);
```

The full `orchestration_edges` design (dual derivation paths, `instance`/`host` keys,
rebuild-from-JSONL) is covered in depth on
[the DAG moat](../architecture/dag-moat.md) and
[the data model](../architecture/data-model.md) (both open pages at the time of
writing).

## Field notes on the six audited rivals

- **`simple10/agents-observe`** (independent grade: **A−**) is the strongest
  engineering base in the set: a real `buildAgentTree()` parent→child tree with
  orphan-reparenting and root synthesis, a dependency-free live force-directed graph,
  78 test files with 1,985 `expect()` calls, MIT plus a real `LICENSE` file, and a
  Docker-optional `AGENTS_OBSERVE_RUNTIME=local` path. It ships as `0.0.0.0` with
  wildcard CORS and zero auth, and its subagent edges are event-derived and
  session-scoped rather than persisted.
- **`hoangsonww/Claude-Code-Agent-Monitor`** (**B−**) is the most feature-complete
  out of the box — 65 test files, a 12-table schema, a dual SQLite driver, and the
  best Telegram provider in the whole survey (`formatTelegram`,
  `webhook-providers.js:177`). It also carries a live RCE (`/api/run`) and is
  maintained by a single author across 92,163 lines of code.
- **CAST** (`ek33450505/claude-code-dashboard`, **C**) has two genuinely worth-stealing
  ideas — the `controlGate.ts` auth shape and the delegation-savings formula — welded
  to a companion agent OS: 37 of 51 route files import `getCastDb`, so it can't be
  lifted out cleanly, and "MIT" is a README badge only (no `license` field, no
  `LICENSE` file).
- **`disler/claude-code-hooks-multi-agent-observability`** (**C−**) is the
  most-starred candidate (1,475★) and the biggest gap between reputation and
  substance: the server drops the subagent identifiers it receives, there are zero
  tests, no license, an SSRF bug, and the project has been stalled since 2026-02-08.
  Its one enduring value is `send_event.py` as a ~180-line teaching example of the
  hook → HTTP → SQLite → WebSocket ingest loop.
- **`NirDiamant/claude-watch`** (**C+**) ingests live tool-calls correctly but renders
  them as a flat chronological feed with no parent→child nesting at all — the opposite
  shape of what agenthropic needs. Its non-destructive git `stash`+tag
  run-checkpoint pattern is the one idea worth carrying forward.
- **`davila7/claude-code-templates`** (**C**, for this specific need) is not a
  competitor to fork or a base to adopt — it is the reference UX bar (see above).

## Why "fork simple10" became "build greenfield"

An earlier pass of this due-diligence, corrected for a factual scoring error in the
vendor panel's own weighted model, recommended forking `simple10` as the fastest path
to a working subagent tree — flipping the vendor panel's original pick of
`hoangsonww`. That recommendation was explicitly marked **"recommendation only, no
action taken"** pending a decision.

The decision that was actually made is greenfield: even the corrected #1 fork
candidate, `simple10`, ships **none** of the five capabilities in the table above, and
forking it would mean ripping out its `0.0.0.0`/no-auth posture and non-persisted
edges before anything else could run. `hoangsonww`, the uncorrected pick, carries a
live RCE that is the exact anti-pattern agenthropic's design forbids outright. So the
call was to build clean, ports-and-adapters, and **steal the specific proven pieces**
— `simple10`'s tree algorithm and Docker-optional runtime, `hoangsonww`'s Telegram
provider, CAST's auth gate and delegation-savings formula, `nirdiamant`'s
run-checkpoint pattern — rather than inherit any one project's baggage. The full
per-project reasoning, the corrected ranking table, and the licensing rule that
governs what is copied-with-attribution versus clean-room reimplemented all live on
[the moat](the-moat.md).

## Where agenthropic stands today

As of this writing, every "planned" row above is exactly that — planned, not shipped.
agenthropic is in its **bootstrap phase**: the design basis (architecture, data model,
hook set, security model, roadmap) is settled and treated as the source of truth, but
no application code is scaffolded yet, and a Phase 0 feasibility spike gates the first
line of production code. See [the roadmap](roadmap.md) for the phase-by-phase build
sequence, and the [FAQ](faq.md) for the questions this comparison doesn't answer on
its own (cost to run, data location, why not just fork one of the six rivals).

## See also

- [What is agenthropic](what-is-agenthropic.md) — the one-paragraph pitch and current
  status.
- [The moat — why build](the-moat.md) — the full evidence trail behind each of the
  five absent capabilities, the corrected ranking, and the licensing rule for what
  gets grafted from where.
- [Roadmap](roadmap.md) — the phase-by-phase plan, including which phase lands each
  row in the tables above.
- [FAQ](faq.md) — self-hosting, cost, privacy, and "why not just fork X".
- [The DAG moat](../architecture/dag-moat.md) — the persisted `orchestration_edges`
  design in depth.
- [Cost model](../architecture/cost-model.md) — `token_usage` buckets and the
  delegation-savings formula.
- [Security model](../security/model.md) — the loopback, mandatory-token, no-spawner,
  no-SSRF posture in full.
