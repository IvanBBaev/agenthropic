# Architecture overview

This page walks the ingest loop end-to-end — from a Claude Code hook firing on the Mac
Mini to a Sankey diagram redrawing in a browser tab, plus the side branch that relays an
alert to Telegram — and explains the ports-&-adapters seams that keep each stage
independently testable. The key takeaway: agenthropic is a **single-writer pipeline**
(`events_raw` → deterministic projection → read-only fan-out), built so that two
invariants hold no matter which stage is under load or mid-crash — **token counts are
ground truth read from `~/.claude/projects/*.jsonl`, never inferred**, and **agents and
subagents are first-class, queryable, persisted rows**, not a tree the UI reconstructs
from an event log on the fly. Everything else in this document — the named ports, the
schema shape, the transport choice — exists to protect those two guarantees under
restart, partial failure, and an unverified hook catalog.

## The loop in one picture

The canonical shape of the pipeline (the design basis, §3):

```
Claude Code (subagents)
  │  hooks (lifecycle events)
  ▼
hook-ingest  ──►  SQLite (persisted, WAL)  ──►  SSE  ──►  browser SPA
  ▲                 │                                    (DAG + Sankey)
  │                 └──►  webhook sink  ──►  Telegram relay (@baev_bot_bot)
  └── reads ~/.claude/projects/*.jsonl (ground-truth token counts)
```

Two things to notice immediately:

1. **`hook-ingest` has two inbound edges, not one.** It receives live hook events *and*
   reads the JSONL transcript directly — the transcript is not a side archive, it is a
   primary input the ingest loop reconciles against. Which of the two is authoritative
   for which fact is exactly the question the ingest-reconciliation page answers in depth
   (see [ingest & reconciliation](../architecture/ingest-reconciliation.md)); this page
   only establishes that both feed the same pipeline.
2. **The webhook sink is a fan-out off persisted state, not off the live event stream.**
   It reads what `hook-ingest` already committed to SQLite — it never dials a URL taken
   from a hook payload (that is the SSRF pattern this system structurally avoids; see
   [security model](../security/model.md)).

The reference implementation the design basis names as the clearest teaching example of
this exact shape is `disler`'s ~180-line `send_event.py`: hook → HTTP → SQLite → WS
(DESIGN §3, §7). agenthropic learns the loop from it but does not build on it — no
license, no tests, and its server drops `agent_id`/`agent_type` on the floor, which is
precisely the fact this system exists to keep.

## End-to-end walkthrough

Reading the diagram left to right, one subagent turn produces (at minimum) this sequence:

1. **Claude Code fires a lifecycle hook** (`PreToolUse`, `PostToolUse`,
   `UserPromptSubmit`, `Notification`, `Stop`, `SubagentStop`, `SessionStart`/`SessionEnd`,
   `PreCompact`, `PermissionRequest`, `PostToolUseFailure`, and — unverified, see
   [What's undecided](#whats-undecided) below — `SubagentStart`) and POSTs it to the
   loopback `hook-ingest` endpoint (DESIGN §5).
2. **`hook-ingest` accepts and stores the raw event** regardless of type — an
   unrecognized or new hook must never crash the pipeline; the normalizer keys only off
   verified event types and a `schema_version` (concept-analysis-v2 §4.2, Developer lens).
   This raw write lands in an immutable, append-only substrate (`events_raw`) before
   anything is interpreted.
3. **In parallel, `hook-ingest` reads `~/.claude/projects/*.jsonl`** for the session —
   this is the only source ever consulted for token counts, and — per the 2026-07-04
   desktop probe, which pre-answers CD-1 `CONDITIONAL-GO` (confidence 85) — a **proven**
   primary source for the subagent parent→child linkage itself: the depth-1 parent→child
   edge is a hard key with a 0% orphan rate (concept-analysis-v2 §2, LB1/CD-1;
   [phase-0 probe](../../analysis/phase0-probe.md)).
4. **A deterministic projection turns `events_raw` into queryable state**: rows in
   `sessions`, `agents` (self-referential tree), `orchestration_edges`, and `token_usage`.
   This projection is a pure function of the immutable log — replaying the same log twice
   must yield byte-identical state (concept-analysis-v2 CD-2).
5. **SQLite (WAL mode) is the single persisted store** both the projection writes to and
   every read path — API, realtime hub, webhook sink — reads from. No component holds
   authoritative state only in memory.
6. **The realtime transport pushes the delta to the browser SPA**, which redraws the
   subagent DAG and the cost/token Sankey view.
7. **The webhook sink independently watches persisted state** for rule matches
   (`alert_rules`) and relays formatted payloads through the Telegram bot integration
   (`@baev_bot_bot`) — not yet built. DESIGN §9's original sketch places this at Phase 2;
   the canonical, dependency-checked [roadmap](../guide/roadmap.md) resequences it to
   **Phase 5** once its real dependencies are accounted for — DESIGN §9's "Phase 2" is
   superseded, not current — and per the best-path decision
   ([`best-path-decision.md` §6.1](../../analysis/best-path-decision.md)) the alerts
   track ships **post-1.0** ([data model](../architecture/data-model.md) and
   [cost model](../architecture/cost-model.md) record the same resolution).

## Component responsibilities

| Component | Responsibility | Reads | Writes | Source |
|---|---|---|---|---|
| Claude Code hooks | Emit lifecycle events for the twelve (unverified count, see below) hook types | — | HTTP POST to `hook-ingest` | DESIGN §5 |
| `~/.claude/projects/*.jsonl` | Durable per-session transcript; the **only** ground-truth source for token counts, and proven primary source for subagent linkage (CD-1 pre-answered by the desktop probe) | Claude Code's own session writer | — | DESIGN §3, §7; concept-analysis-v2 LB1 |
| `hook-ingest` | Accept-and-store any event type without crashing; read the JSONL transcript; reconcile hook liveness against JSONL truth | Hook POSTs, JSONL | `events_raw` | DESIGN §3; concept-analysis-v2 §4.2 |
| Normalizer / Projection | Pure, replayable function: `events_raw` → `sessions`/`agents`/`orchestration_edges`/`token_usage` | `events_raw` | Projected tables | concept-analysis-v2 CD-2/CD-3 |
| SQLite (WAL) | Single persisted substrate; source of truth for every downstream reader | Projection output | — | DESIGN §3, §8 |
| Realtime transport | Server→browser fan-out of state deltas, same-origin enforced | Projected tables | Push to SPA | DESIGN §3; concept-analysis-v2 CD-5 |
| Browser SPA | Render the subagent DAG and the token/cost Sankey view; read-only | Realtime feed + read API | — | DESIGN §3, §6 |
| Webhook sink | Match `alert_rules` against persisted state; format and deliver to configured targets only | Projected tables, `alert_rules` | `webhook_deliveries` | DESIGN §4 (hoangsonww graft); Phase 5, post-1.0, per the [roadmap](../guide/roadmap.md) (DESIGN §9's sketch says Phase 2 — superseded) |
| Telegram relay | Deliver formatted alerts to `@baev_bot_bot` | Webhook sink payload | Telegram API | DESIGN §2.3, §7 (`formatTelegram`) |

## Ports & adapters

The design basis names this pattern explicitly as the structural backbone (DESIGN §3,
§7: "ports/adapters storage + strategy-pattern agent classes" from `simple10`).
concept-analysis-v2's architect lens (CD-6) names the concrete seam set the core is built
around:

| Port | Purpose | Adapter today |
|---|---|---|
| `HookSource` | Accept Claude Code lifecycle events | Per-runtime strategy class (Claude Code now; the same seam is what would let a Codex adapter be added later without a core rewrite) |
| `TokenReader` / `TokenSource` | Read ground-truth token counts | `~/.claude/projects/*.jsonl` reader |
| `EventStore` | Append-only write/read of `events_raw` | SQLite table with no `UPDATE`/`DELETE` path |
| Normalizer / Projection | Pure function: raw events → normalized state | In-process projection, replayable from `events_raw` alone |
| `StoragePort` | Persisted read/write of projected tables | `better-sqlite3`, WAL mode — single driver *(the `node:sqlite` fallback was dropped per best-path §6.3, applied 2026-07-06)* |
| `RealtimeHub` | Push projected-state deltas to connected clients | SSE endpoint, same-origin enforced |
| `AlertSink` | Match rules against state, deliver outbound | Webhook target → Telegram formatter |
| `PricingProvider` | Versioned `model_pricing` lookup | SQLite table, `effective_from`/`verified_on` |
| `CostEngine` | Combine `token_usage` + `PricingProvider` into dollar cost and delegation-savings | Pure computation over persisted data |

*(Port names and the full rationale: concept-analysis-v2 §3, CD-6. This table is a
summary for the architecture-overview reader — treat concept-analysis-v2 as the source
of record if the two ever drift.)*

Why this shape, concretely:

- **Testability.** The Normalizer/Projection is a pure function over `events_raw` — it
  can be exercised entirely from recorded fixtures, with no live Claude Code session,
  no network, and no clock dependency. This is what makes replay-on-startup and the
  "double-replay → byte-identical state" test (concept-analysis-v2 §6) possible at all.
- **Multi-runtime readiness without a core rewrite.** `simple10`'s
  `hooks/scripts/lib/agents/<class>.mjs` cleanly separates the Claude-Code-specific
  ingestion shape from everything downstream (DESIGN §3, §7) — `HookSource` is the port
  that pattern maps onto.
- **A storage seam that survives a driver swap.** `hoangsonww`'s dual SQLite driver
  (`better-sqlite3` with a `node:sqlite` fallback) illustrates why the seam matters —
  a driver swap stays local to the adapter because `StoragePort` is a seam, not a
  direct dependency scattered through the codebase (DESIGN §7). agenthropic itself
  ships a **single `better-sqlite3` driver** — the dual-driver graft was dropped per
  best-path §6.3 (applied 2026-07-06); the seam argument stands on its own.

## The two invariants

### Invariant 1 — tokens are ground truth

Every token count the system ever displays or prices is **read** from
`~/.claude/projects/*.jsonl`, never estimated from tool-call counts, never
model-guessed, never backfilled by heuristic when a cheaper number is available. This is
stated as a design invariant (DESIGN §3) and reaffirmed by the architect lens as
"architecturally honest — tokens are read, never inferred" (concept-analysis-v2 §5,
Strengths). The reconciliation precedence that enforces this in the schema:

- **Tokens are JSONL-authoritative** — hooks may supply interim liveness/state, but the
  token figure a session or agent finally shows always traces to the transcript
  (concept-analysis-v2 CD-3).
- `token_usage.agent_id` **may be `NULL` at first write** (a token row can arrive before
  the owning agent is known) but is **deterministically backfilled** once the agent
  resolves — never left as a guess, never double-counted (concept-analysis-v2 CD-3, §6).
- A **compaction baseline is preserved** in `token_usage` (bucketed by `speed` /
  `inference_geo` / `service_tier`) so a session that hits `PreCompact` still reprices
  correctly against its pre-compaction figures rather than silently losing history
  (DESIGN §4; concept-analysis-v2 §6, Cost).

This is why the ingest loop reads the JSONL transcript directly rather than trusting hook
payloads for anything cost-bearing — see
[cost model](../architecture/cost-model.md) for the full pricing/bucket design.

### Invariant 2 — agents and subagents are first-class persisted entities

The subagent tree is **a data fact, not a client-side reconstruction from a flat event
log** (DESIGN §3). Concretely, `agents` is self-referential:

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

(DESIGN §4 — `hoangsonww` graft.) The moat this protects sits one layer up, in
`orchestration_edges`: those edges must be **persisted** (written once, at ingest or
projection time) and **per-instance** (not type-aggregated), carrying an
`instance`/`host` key from the first migration for future fleet aggregation
(DESIGN §4, §2.4; concept-analysis-v2 CD-4). The global/cross-session DAG the SPA renders
is served **by querying that table** — it is never rebuilt at render time
(concept-analysis-v2 §6). Full schema treatment:
[data model](../architecture/data-model.md); the moat-specific rebuild/outage story:
[the DAG moat](../architecture/dag-moat.md) — empirically de-risked by the
[phase-0 probe](../../analysis/phase0-probe.md), which rebuilt the depth-1 edges from
JSONL at a 0% orphan rate and recovered depth-2 edges 100% via a self-referential parent
index.

The architect lens confirms this framing directly: "the topology (hooks + JSONL →
ingest → SQLite/WAL → SSE → SPA), the ports-&-adapters backbone, and the 'hierarchy is
persisted data, not UI reconstruction' invariant are all correct and confirmed"
(concept-analysis-v2 §4.1).

## Transport: SSE, not WebSocket

The design basis's original loop diagram (§3) wrote the transport as
"WebSocket/SSE" — left open; the diagram reproduced above already shows the resolved
transport. concept-analysis-v2 resolves this: **transport is SSE, with
same-origin enforcement from Phase 1** (CD-5). The realtime hub is a server→browser-only
feed; the decision explicitly defers WebSocket unless a future feature needs bidirectional
control, which nothing on the current roadmap does (concept-analysis-v2 CD-5). Same-origin
checking and the mandatory auth token apply to this channel exactly as they apply to every
other endpoint — see [security model](../security/model.md) for the enforcement detail.
This SSE-vs-WebSocket resolution is one of the CD-1…CD-10 canonical decisions; the ADR
recording it in full lives under
[decisions](../contributing/decisions/README.md) once written.

## Visualization surface: DAG + Sankey

The browser SPA renders two coordinated views over the same persisted state:

- **The subagent DAG.** Session-scoped tree rendering (parent→child, orphan-reparenting,
  root synthesis) is table-stakes and should match `simple10`'s `buildAgentTree()` /
  `layoutTree()` plus its dependency-free N-body force graph (`physics.ts`) — validated
  against one real subagent-heavy session before committing (DESIGN §6). The **global,
  persistent, per-instance** DAG — queried from `orchestration_edges`, not reconstructed
  — is the moat feature none of the six audited projects deliver (DESIGN §2.1, §6); its
  first layout extension, when needed, is ELK/Graphviz over the persisted tree (DESIGN
  §6).
- **The cost/token Sankey.** `hoangsonww`'s D3 Sankey and aggregate polish are worth
  studying directly as rendering technique (DESIGN §6) — but its `OrchestrationDAG.tsx`
  is a type-aggregated 3–4 layer diagram, not true per-instance nesting; its real nesting
  is a collapsible indented tree reconstructed post-hoc on `SubagentStop` (DESIGN §6).
  agenthropic borrows the Sankey rendering idea, not the aggregation-instead-of-persistence
  shortcut.

## Patterns we steal, not the repos

None of the six audited projects is forked; agenthropic is greenfield (DESIGN §0). The
specific source-level patterns worth reusing (DESIGN §7):

| From | Pattern | Why |
|---|---|---|
| `simple10` | Ports/adapters storage + strategy-pattern agent classes; `buildAgentTree()`/`layoutTree()`; `AGENTS_OBSERVE_RUNTIME=local` under `launchd` (no Docker daemon) | Cleanest, most portable base |
| `hoangsonww` | `formatTelegram` webhook provider; `alert_rules`/`webhook_targets` schema ~~; dual SQLite driver (`better-sqlite3` + `node:sqlite` fallback)~~ *(dropped per best-path §6.3 — single `better-sqlite3` driver)* | Easiest Telegram bridge |
| `cast` | `controlGate.ts` (~73 LOC: read-only by default, non-safe verbs 404 unless token, `timingSafeEqual`, mounted before router); delegation-savings analytics (~50 LOC, re-prices Haiku at Sonnet rates off `~/.claude` JSONL) | Drop-in auth gate; the cost moat (re-verify the hardcoded pricing table before trusting it) |
| `disler` | ~180-LOC `send_event.py` ingest loop | Clearest teaching example of hook→HTTP→SQLite→WS |
| `nirdiamant` | git `stash`+tag run-checkpoint | Non-destructive session snapshots |

Per concept-analysis-v2 CD-9, `simple10` and `hoangsonww` are copied **with
attribution** (their licenses permit it); `cast`, `disler`, and `nirdiamant` patterns are
**clean-room reimplemented** — all three are all-rights-reserved by Berne default, not
merely "ambiguous" (concept-analysis-v2 §4.5, Gap #4; §6). Full rule and CI enforcement:
[licensing & provenance](../contributing/licensing.md).

## What's undecided

This is a design-basis page, not a shipped-system page — several load-bearing details
are explicitly open. Stating them here rather than glossing over them:

- **Ingest primacy (CD-1 / LB1).** The question — JSONL-primary with replay-on-startup,
  or hooks-primary with a durable local outbox/spool — is **empirically pre-answered
  `CONDITIONAL-GO` (confidence 85) by the 2026-07-04 desktop probe**: the JSONL transcript
  *does* carry the subagent parent→child linkage well enough to rebuild the DAG after a
  full outage (the depth-1 edge is a hard key, 0% orphan), so v1 is **JSONL-primary with
  backfill**, and the durable outbox/spool is **pulled off the v1 critical path** — a
  deferrable, YAGNI-leaning fallback added only on a real trigger (a sub-second
  live-freshness need, *or* hooks becoming a data source not also present in JSONL). The
  proven load-bearing hedges are instead dual-layout parsing (85% of agents are nested) and
  child-transcript token summation (parent rollup ≈ 0%). The formal Phase-0 spike
  (WP-S1/WP-S5) still confirms this on the paired-capture corpus, and the **WP-S7 GO gate
  stands — no production code before it** (concept-analysis-v2 §2, LB1; §7, G0.1;
  [phase-0 probe](../../analysis/phase0-probe.md)). Deep dive:
  [ingest & reconciliation](../architecture/ingest-reconciliation.md).
- **The hook catalog is assumed, not verified.** DESIGN §5 lists twelve lifecycle events
  including `SubagentStart`; concept-analysis-v2's developer lens flags that
  `SubagentStart` "is probably not a real hook" and that the documented set is actually
  `PreToolUse`/`PostToolUse`/`UserPromptSubmit`/`Notification`/`Stop`/`SubagentStop`/
  `SessionStart`/`SessionEnd`/`PreCompact` — nine, not twelve (concept-analysis-v2 §4.2).
  Phase-0 gate **G0.2** must enumerate the actual fired hooks before the normalizer is
  committed to a design that assumes `SubagentStart` exists (concept-analysis-v2 §3,
  CD-8; §7). Catalog detail: [hook ingestion](../architecture/hooks.md).
- **Hook-endpoint auth is an open question**, not yet answered: is the loopback
  `hook-ingest` endpoint itself authenticated, and how does the hook script obtain the
  token without leaking it into `~/.claude` scripts (concept-analysis-v2 §7, open
  question 8)? The mandatory-token invariant applies to the system as a whole; the
  specific mechanics for the hook-POST leg are not yet designed.
- **Stack and repo layout.** Backend framework (Fastify vs Express), frontend
  (React + Vite + D3 is the lean but unconfirmed), SQLite driver
  (single `better-sqlite3` — the `node:sqlite` fallback was dropped per best-path
  §6.3), and repo structure (pnpm monorepo —
  `apps/server` + `apps/web` + `packages/shared` + `packages/test-fixtures` — vs a single
  package) are named leanings, not locked decisions (DESIGN §10; concept-analysis-v2
  §4.2). See the [roadmap](../guide/roadmap.md) for phase sequencing once these land.

## Security boundary of this loop

This page is architecture, not the security reference — see
[security model](../security/model.md) for the full treatment — but three facts about
*this specific loop* are non-negotiable and shape the diagram above:

- `hook-ingest` and every read/write endpoint bind **`127.0.0.1` only**, never `0.0.0.0`
  (DESIGN §8).
- Nothing in this loop spawns `claude` or any subprocess driven by request input — there
  is no `/api/run`-shaped surface anywhere in the pipeline, which is precisely the RCE
  pattern `hoangsonww` ships and this design walks away from (DESIGN §8).
- The webhook sink's targets are **operator-configured only**; it never dials a URL taken
  from an event payload (no SSRF), and delivery credentials (e.g. the Telegram bot token)
  stay out of SQLite and out of the browser, referenced instead via `token_ref` into
  `launchd` env / chmod-600 storage (concept-analysis-v2 CD-10). Remote access to the
  browser SPA is via SSH port-forward or a Tailscale tunnel only — never a reverse proxy
  to the open port (DESIGN §8).

## See also

- [Data model](../architecture/data-model.md) — full DDL for `agents`, `sessions`,
  `events_raw`/`events`, `token_usage`, `orchestration_edges`.
- [Hook ingestion](../architecture/hooks.md) — the lifecycle-event catalog and
  `SubagentStart`/`SubagentStop` handling.
- [Ingest & reconciliation](../architecture/ingest-reconciliation.md) — CD-1, the
  Phase-0 primacy spike, and the reconciliation contract in depth.
- [The DAG moat](../architecture/dag-moat.md) — persisted `orchestration_edges`,
  rebuild-from-JSONL, the outage story.
- [Cost model](../architecture/cost-model.md) — `token_usage` buckets, compaction
  baselines, dual-pricing, delegation-savings.
- [Security model](../security/model.md) — loopback bind, mandatory token, no-spawner,
  no-SSRF, same-origin enforcement.
- [Roadmap](../guide/roadmap.md) — phase sequencing for everything marked undecided
  above.
