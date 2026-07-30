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

> **Update — 2026-07 (as built).** Two corrections to how this page should be read.
>
> **1. agenthropic's own row is no longer "planned."** Implementation began 2026-07-11,
> and of the five feature columns, three now ship: the persisted per-instance subagent DAG
> (`agents` + `orchestration_edges`), dollar-cost attribution with delegation savings, and
> SQLite/WAL persistence. **Telegram remains ❌ not built** — it is v2.0, entered only via
> KC-5, may never start, and its operator-alerts API and UI were cut outright.
> **Cross-machine remains ❌ not built** — only the `instance`/`host_id` key on
> `orchestration_edges` exists, and no second host does. The security row was implemented
> exactly as committed: loopback-only bind, mandatory `DASHBOARD_TOKEN` compared with
> `timingSafeEqual`, no spawner, no SSRF (the server makes no outbound network request at
> all). **72 test files / 879 tests pass**, coverage gated >90% in every shipped package.
> Three P0 correctness proofs are green and merge-blocking — Σ tokens against an
> independently written reader, a byte-identical double replay, and the DAG rebuilt from
> JSONL alone after a simulated outage. That is the whole of what is proven; nothing here
> should be read as a broader guarantee.
>
> **2. No rival was ever installed.** Every claim about the six audited projects and the
> baseline rests on **reading their source and documentation** during due diligence in
> 2026-07 — none was run head-to-head against agenthropic, no benchmark was executed, and
> the project's friction log was never opened. Nothing on this page is grounded in lived
> comparative use, and the rival columns have not been re-checked since 2026-07-03; those
> projects may have changed. Read the comparison as documented analysis with a date on it,
> not as a bake-off result.

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
| **agenthropic** *(as built, 2026-07)* | ✅ **built** — persisted, per-instance `orchestration_edges` over four structural join paths; proven rebuildable from JSONL alone *(was: ⚠️ planned, Phase 3)* | ✅ **built** — delegation-savings + compaction repricing off ground-truth `token_usage`; Σ verified against the JSONL by an independent reader *(was: ⚠️ planned, Phase 3)* | ✅ **built** — SQLite WAL + migrations; `events_raw` is append-only but holds **hook events only** *(was: ⚠️ planned, Phase 1)* | ❌ **not built** — v2.0, entered only via KC-5; may never start; alerts API + UI cut *(was: ⚠️ planned, Phase 5)* | ❌ **not built** — `instance`/`host_id` key exists on `orchestration_edges` only (not on every row); the rollup is not a work package |
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
exactly moat item #1 (see [the DAG moat](../architecture/dag-moat.md)).
*(As built: agenthropic's side of that claim is now shipped and proven — the edges are
rows, not a render-time reconstruction, and a merge-blocking test rebuilds the whole DAG
from JSONL alone after a simulated outage. The rival side of the claim is still
2026-07-03 reading, not a re-test.)*

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
non-negotiable posture (in full on [the security model](../security/model.md)):

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
  *(As built: adopted in shape, not in code — clean-room per CD-9, in
  `packages/shared/src/security/`. The compare hashes both sides to SHA-256 **before**
  `timingSafeEqual`, so unequal input lengths cannot leak through timing or trip
  `timingSafeEqual`'s equal-length precondition. There is no read-only/control-flag split
  to make: the API is read-only apart from the hook receiver, and the token is mandatory
  on every route — the server refuses to start without one.)*

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

> **As built, the right-hand column is real but its top two boxes are wrong.** The
> persisted DAG, the queryability, and the restart/cross-session survival all shipped. But
> `events_raw` is **not** what feeds it — that table holds **hook events only**, and hooks
> are liveness-only, never structure. There is also no separate "deterministic projection"
> stage: the JSONL transcripts are parsed **straight into** `agents` and
> `orchestration_edges`, one transaction per session. Read the right-hand column as
> `~/.claude/projects/*.jsonl → agents + orchestration_edges → queried`. Likewise, "built
> two independent ways" did not survive: edges are derived from **JSONL alone**, over four
> structural join paths (`tool_use`, `directory`, `queue_operation`, `task_notification`).
> That is stronger than it sounds — it is why a merge-blocking test can rebuild the entire
> DAG after a simulated hook outage and get a byte-identical dump.

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

> **As built, this DDL is close but not exact** (`apps/server/src/db/migrations.ts`,
> migration 4): `status` gained a fifth value, `'unknown'`, and the table carries
> `first_seen_at` / `last_seen_at`. It does not carry `instance`/`host_id` — that key is on
> `orchestration_edges` only.

The full `orchestration_edges` design (dual derivation paths, `instance`/`host` keys,
rebuild-from-JSONL) is covered in depth on
[the DAG moat](../architecture/dag-moat.md) and
[the data model](../architecture/data-model.md) (both pages have since been written).
*(As built: "dual derivation paths" is not what shipped — see the note above the DDL.
Edges come from JSONL alone.)*

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
run-checkpoint pattern — rather than inherit any one project's baggage.
*(As built: two of those five grafts never happened. **Nothing was taken from
`hoangsonww`** — its Telegram provider was the only scheduled artifact and alerting was
never built — and the `nirdiamant` run-checkpoint pattern was not implemented either. The
CAST auth-gate shape and delegation-savings formula were clean-room reimplemented per
CD-9, and the tree work was written against the JSONL parser spec rather than ported from
`simple10`.)*
The full
per-project reasoning, the corrected ranking table, and the licensing rule that
governs what is copied-with-attribution versus clean-room reimplemented all live on
[the moat](the-moat.md).

## Where agenthropic stands today

> **Update — 2026-07 (as built).** The paragraph below is superseded; it is kept because
> other pages link to this section. **The bootstrap phase is over.** Implementation began
> **2026-07-11**, by explicit owner override of the CD-8 no-code-before-spike gate — not
> because the gate was cleared. What runs: the loopback-bound, token-gated server; the
> SQLite/WAL substrate and migrations; JSONL ingest with replay-on-startup; the persisted
> subagent DAG; the cost engine; the hook receiver; the SSE hub; the read API; and all four
> dashboard views. **72 test files / 879 tests pass**, coverage gated >90% in every shipped
> package (`packages/test-fixtures` is a deliberate, documented exclusion).
>
> Three things are still honestly open, and matter more than the feature list:
> the Phase-0 spike numbers remain **PROVISIONAL** until ratified against a hand-labeled
> corpus; the v1.0 usability target ("<30s to understand a session") is **unmeasured**, so
> nothing on this page claims agenthropic is *faster to read* than a rival; and the
> roadmap's kill checkpoints **KC-0 and KC-1 both passed unmet** — see
> [the roadmap](roadmap.md) for that record in full.

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
