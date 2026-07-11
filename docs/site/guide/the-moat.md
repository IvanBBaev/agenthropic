# The moat — why build

`agenthropic` is a greenfield build, not a fork, because a source-level audit of five
real rivals — plus the honest market baseline, `davila7/claude-code-templates`
(28.4k★) — turned up **five features that no single project delivers**: a global
persistent per-instance orchestration DAG, live dollar-cost + delegation-savings, a
Telegram alert sink, cross-machine fleet aggregation, and persistence the owner
controls. Those five are the market gap; the **moat proper is narrower — two
features**: the persistent cross-session DAG and dollar-cost attribution. Telegram
alerting is a planned post-1.0 convenience, and fleet aggregation is deferred until a
second host physically exists. The audit's own scoring model, corrected for a factual error, ranks
`simple10` first as a fork candidate — not `hoangsonww`, the vendor panel's original
pick — but even the corrected #1 candidate doesn't ship the moat, and both leading
candidates carry baggage (an insecure-by-default bind, or a live RCE) not worth
inheriting. So the decision (recorded in [`DESIGN.md` §0](../../ai/DESIGN.md)) is to
build clean, ports-and-adapters, in the spirit of `kiko`, and **steal the specific
proven pieces** — under a per-artifact licensing rule — rather than adopt any one
project's codebase wholesale.

This page is the evidence trail for that decision: what the five absent features are,
which project's due-diligence proves nobody else has them, exactly which file/pattern
gets stolen from where, how the ranking got corrected, and why the correction still
doesn't change the "build" verdict.

## 1. The baseline everyone must clear first

Before talking about the moat, position against the real market leader, not a vacuum.
`davila7/claude-code-templates` is **28.4k★, MIT-licensed, actively maintained**, ships
a real `npx claude-code-templates --analytics` live dashboard, reads
`~/.claude` JSONL directly with a `chokidar` watch, and needs no Docker — the best
zero-install developer-experience bar in the whole survey (due-diligence
[`projects/claude-code-templates.md`](../../due-diligence/projects/claude-code-templates.md)).
It already nails **self-hosted + zero-install + live token attribution**.

It is also a flat leaderboard: **no DAG, no dollar cost, no persistence, no Telegram**
(binds `0.0.0.0`, no auth) — see [`DESIGN.md` §1](../../ai/DESIGN.md). Our moat is
defined as exactly what this baseline lacks, refined against the other five audited
projects (due-diligence [`market-landscape.md`](../../due-diligence/market-landscape.md)).

## 2. The five features no existing tool delivers

[`DESIGN.md` §2](../../ai/DESIGN.md) names five capabilities "confirmed absent across
all six audited projects" — the build backlog that justifies building rather than
adopting:

| # | Feature | Steal the proven piece from | Where it lands |
|---|---|---|---|
| 1 | Global, persistent, per-instance orchestration DAG | `simple10` — tree algorithm (not its storage model) | Phase 3, [architecture: the DAG moat](../architecture/dag-moat.md) |
| 2 | Live dollar-cost attribution + delegation-savings | `cast` — the ~50-LOC formula (clean-room reimplemented) | Phase 3 (cost engine) / Phase 4 (dashboard tile), [architecture: cost model](../architecture/cost-model.md) |
| 3 | Telegram alert sink → `@baev_bot_bot` | `hoangsonww` — `formatTelegram` webhook provider | Phase 5 — post-1.0 (a planned convenience, not part of the moat) |
| 4 | Cross-machine / fleet aggregation | nobody — genuinely unclaimed; hedge only (`instance`/`host_id` column) | Deferred until a second host physically exists ([ADR-0002](../contributing/decisions/adr-lb-2-personal-first-commercial-clean.md)/[ADR-0012](../contributing/decisions/adr-cd-10-scope-secrets-retention.md)); not scheduled |
| 5 | Persistence the owner controls | nobody, cleanly — closest gap is `claude-code-templates`'s in-memory-only cache | Phase 1 baseline (SQLite WAL) |

Phase numbers above follow [the roadmap page](roadmap.md)'s dependency-derived
renumbering, which supersedes [`DESIGN.md` §9](../../ai/DESIGN.md)'s original sketch on
exactly these points — see §6 below for why the two disagree.

Each is detailed below with the due-diligence evidence for its absence and the exact
artifact being grafted.

### 2.1 Global, persistent, per-instance orchestration DAG

**Nobody has this.** No audited project persists a **global, per-instance**
orchestration DAG with long-horizon, cross-session history and dollar attribution —
at best a *session-scoped* tree whose edges are derived at render time, or a
per-session parent column with no cross-session graph:

- `simple10` ships the closest thing to a real subagent graph — `constellation/agent-tree.ts
  → buildAgentTree()` does real parent→child tree-building with orphan-reparenting and
  root synthesis, rendered by a dependency-free N-body force graph. But the edges are
  **derived from the event stream at render time, session-scoped**, never persisted as
  first-class rows (due-diligence [`projects/simple10.md`](../../due-diligence/projects/simple10.md)).
- `hoangsonww`'s much-advertised "DAG cockpit" (`OrchestrationDAG.tsx`) is **oversold**:
  it is a *type-aggregated*, 3–4-layer diagram of agent categories, not a per-instance
  orchestration graph. Its true nesting is a collapsible indented tree — genuinely
  backed by a persisted `agents.parent_agent_id` column, but session-scoped and
  **reconstructed post-hoc on `SubagentStop`**, not a global cross-session graph
  (due-diligence
  [`projects/hoangsonww.md`](../../due-diligence/projects/hoangsonww.md);
  [`DESIGN.md` §6](../../ai/DESIGN.md)).
- `disler`'s server **drops** `agent_id`/`agent_type` on ingest (`db.ts:127`) — the
  hierarchy is a dead path; no parent column, no graph library anywhere in the
  dependency tree (due-diligence [`projects/disler.md`](../../due-diligence/projects/disler.md)).
  It survives on this page only as the clearest teaching example of the hook→HTTP→SQLite→WS
  ingest loop (`send_event.py`, ~180 lines).
- `nirdiamant` has no parent→child nesting and no `SubagentStop` handling at all
  (due-diligence [`projects/nirdiamant.md`](../../due-diligence/projects/nirdiamant.md)).
- `claude-code-templates`'s subagent view is a flat leaderboard/timeline
  (`AgentAnalyzer.js`) — no graph (due-diligence
  [`projects/claude-code-templates.md`](../../due-diligence/projects/claude-code-templates.md)).

**What we steal:** `simple10`'s tree algorithm — `buildAgentTree()` / `layoutTree()`
(parent→child, orphan-reparenting, root synthesis) — as the model to validate against a
real subagent-heavy session before committing ([`DESIGN.md` §6](../../ai/DESIGN.md)).
What we do **not** copy is its storage model. `DESIGN.md` §4 is explicit that the moat
extends beyond every existing schema: edges must be **persisted** (not event-derived at
render time), **per-instance** (not type-aggregated like `hoangsonww`'s), and carry an
`instance`/`host` key for future fleet aggregation:

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

The persisted `orchestration_edges` table (self-referential `parent_agent_id`,
`derived_from_event_id`, `instance`/`host_id`) is the moat's core artefact — queried
from the table, never reconstructed at render time — per concept-analysis-v2's CD-4/CD-2
(see [architecture: the DAG moat](../architecture/dag-moat.md), an open page at the time
of writing).

This item is also the single biggest execution risk: whether the DAG can be **rebuilt
from `~/.claude/projects/*.jsonl` alone** after an outage is LB1, the #1 architectural
unknown. It is now empirically **pre-answered `CONDITIONAL-GO` → build (confidence
85/100)** by the 2026-07-04 desktop corpus probe — the formal Phase-0 spike *confirms*
it on the paired-capture corpus rather than deciding it from scratch
(concept-analysis-v2 [§2](../../analysis/concept-analysis-v2.md)). See
[architecture: ingest & reconciliation](../architecture/ingest-reconciliation.md) (open
page) for the CD-1 decision this gates.

> **Empirical basis (2026-07-04).** The read-only
> [Phase-0 corpus probe](../../analysis/phase0-probe.md) — 17 projects · 117 sessions ·
> 85.2% of agent files nested — already answers CD-1 as `CONDITIONAL-GO` → build: JSONL
> *is* a trustworthy, outage-surviving source for a parser that keys on the
> `Agent`/`Workflow` spawn tools (not `Task`), walks **both** on-disk layouts, and sums
> tokens **from child transcripts**. This **de-risks** but does **not** replace the
> formal Phase-0 spike: the GO gate still stands, and no production code ships before it.

### 2.2 Live dollar-cost attribution + delegation-savings

No audited project surfaces a live, session-scoped **delegation-savings** number — the
dollar value of routing work to Haiku/Sonnet instead of a top-tier model. The closest
proven piece is `cast`'s `analytics.ts:233-310` (~50 LOC): it re-prices Haiku sessions
at Sonnet rates and reports the conservative `max(0, sonnetEquiv − actualHaiku)` saving,
run off `~/.claude` JSONL (due-diligence
[`projects/cast.md`](../../due-diligence/projects/cast.md);
[`DESIGN.md` §2](../../ai/DESIGN.md) item 2: "Borrow `cast`'s ~50-LOC formula").

Two caveats carried forward from the due-diligence:

- `cast`'s pricing table is **hardcoded and likely stale** — re-verify model rates
  before trusting dollar figures ([`DESIGN.md` §7](../../ai/DESIGN.md)).
- `cast` has **no LICENSE file** (`private:true`, "MIT" is a README badge only, no
  `license` field) — so per concept-analysis-v2's CD-9, this formula is **clean-room
  reimplemented** (the idea is reproduced from the written description, not by reading
  `cast`'s source while writing ours), not copied verbatim. See §5 below.

This is combined with `hoangsonww`'s genuinely superior costing grafts: `token_usage`
bucketed by `speed` / `inference_geo` / `service_tier` (each changes the per-token
rate), preserving **compaction baselines** so historical totals still price correctly
after a context rewrite, plus a `model_pricing` table to drive the tile
([`DESIGN.md` §4](../../ai/DESIGN.md)). Land on
[architecture: cost model](../architecture/cost-model.md) (open page) once written; the
tile itself is Phase 4 in the roadmap (§6 below).

### 2.3 Telegram alert sink → `@baev_bot_bot`

No audited project has a Telegram integration ready to graft except one:
`hoangsonww` ships a first-class `formatTelegram` webhook provider
(`webhook-providers.js:177`) plus a full `alert_rules` / `webhook_targets` /
`webhook_deliveries` schema — "the easiest Telegram bridge in the whole set" (due-diligence
[`projects/hoangsonww.md`](../../due-diligence/projects/hoangsonww.md);
[`DESIGN.md` §2](../../ai/DESIGN.md) item 3, §7).

`hoangsonww` is MIT-licensed with a real LICENSE file, so this webhook provider and
schema are grafted **with attribution**, not clean-room reimplemented — the one part of
that codebase worth taking wholesale, isolated from its RCE spawner and its
type-aggregated DAG (see [`projects/hoangsonww.md`](../../due-diligence/projects/hoangsonww.md)).

Security note that must never regress when this lands: `webhook_targets` are
**operator-configured**, never dialed from a URL taken out of an event payload — that
is precisely `disler`'s SSRF bug (`index.ts:198-201`, dials an arbitrary
`responseWebSocketUrl` from the request body), and concept-analysis-v2's CD-7 makes an
SSRF test a build-blocking gate. Roadmap placement: Phase 5, "Alerting core" —
**post-1.0**: the best-path decision
([`best-path-decision.md` §6.1](../../analysis/best-path-decision.md)) pulls alerting
off the v1.0 critical path, so it ships as a post-1.0 convenience, not as part of the
moat (§6 below; [the roadmap page](roadmap.md) sequences Telegram after the
ingest/DAG/cost work, later than [`DESIGN.md` §9](../../ai/DESIGN.md)'s original
sketch).

### 2.4 Cross-machine / fleet aggregation

**All six audited projects are single-host** ([`DESIGN.md` §2](../../ai/DESIGN.md) item
4; [`market-landscape.md`](../../due-diligence/market-landscape.md)). There is no
project to steal a fleet-aggregation pattern from — this is genuinely unclaimed ground,
not a graft.

The cheap hedge taken *now*, per concept-analysis-v2's LB2 ("personal-first /
commercial-clean"): put an `instance`/`host_id` column on every row from the very first
migration, so the schema never *blocks* a later multi-host rollup, without building the
fleet UI itself yet (concept-analysis-v2
[CD-4](../../analysis/concept-analysis-v2.md), gap #7 in the same document: "Missing
`instance`/`host_id` → future forced migration"). Full fleet aggregation is **not** one
of the 75 work packages in the current build plan — [the roadmap page](roadmap.md) is
explicit that it "remains a future decision, not a scheduled deliverable": it is
**deferred until a second host physically exists**
([ADR-0002](../contributing/decisions/adr-lb-2-personal-first-commercial-clean.md)/[ADR-0012](../contributing/decisions/adr-cd-10-scope-secrets-retention.md)),
not scheduled.

### 2.5 Persistence the owner controls

The sharpest evidence here is the market baseline itself: `claude-code-templates` keeps
an **in-memory TTL cache only** — nothing survives a restart, so no historical /
time-series analysis is possible (due-diligence
[`projects/claude-code-templates.md`](../../due-diligence/projects/claude-code-templates.md)).
Several of the six audited rivals *do* have some SQLite-backed persistence — but the
Business Analyst lens in concept-analysis-v2 is explicit that persistence, dollar cost,
alerting, and a session-scoped "DAG-lite" are each **individually retrofittable** by a
well-resourced incumbent; they are not, on their own, a defensible moat (see §4 below).
What makes ours worth owning is combining full SQLite WAL persistence with the harder,
non-retrofittable pieces (the persisted per-instance DAG and the security posture) under
one roof, with retention/redaction policy from day one (concept-analysis-v2 CD-10). See
[operations: backup & restore](../operations/backup-restore.md) (open page).

## 3. The corrected ranking: `simple10` #1, not `hoangsonww`

The vendor due-diligence panel's headline recommendation was to "adopt
`hoangsonww/Claude-Code-Agent-Monitor` as your primary cockpit." Its **own** weighted
scoring model disagrees with its own conclusion
([`report-meta-audit.md`](../../due-diligence/report-meta-audit.md) §1):

| Project | Weighted score /5 |
|---|---|
| **`simple10`** | **4.1 — highest** |
| `hoangsonww` | 4.0 |
| `cast` | 3.8 |
| `disler` | 2.7 |
| `nirdiamant` | 2.6 |

The panel bridged the gap with a discretionary tie-break on "Visualisation depth" — the
single **heaviest-weighted axis at 20%** — scoring `hoangsonww` a 5 and `simple10` a 3.
That tie-break rests on a factual error: it justified `simple10`'s low score by
asserting it has "no true DAG / subagent tree." It does —
`constellation/agent-tree.ts → buildAgentTree()` builds a real parent→child tree with
drawn edges, plus a live force-directed graph (§2.1 above). **Re-score that axis
correctly and the panel's own model puts `simple10` first**
([`report-meta-audit.md`](../../due-diligence/report-meta-audit.md) §1–§3).

A second structural bias compounds the error: **Security (16% weight) was scored too
generously across the board.** The model treats "loopback by default" as a passing
posture, when every viable option in the survey actually binds `0.0.0.0` and/or ships
no-op auth. A stricter security column pulls `hoangsonww` down further — its `/api/run`
route is a live RCE (see §4) — which *widens* `simple10`'s lead rather than narrowing it
([`report-meta-audit.md`](../../due-diligence/report-meta-audit.md) §2).

Per-project grades from the independent, source-level audit (re-scored, not the
panel's):

| Project | Independent grade | Role |
|---|---|---|
| `simple10` | **A−** | Corrected #1 fork candidate |
| `hoangsonww` | B− | Study & harvest (Telegram provider only), don't adopt blind |
| `cast` | C | Harvest two ideas (control gate, delegation-savings), then walk away |
| `nirdiamant` | C+ | One pattern worth stealing (run-checkpoint) |
| `disler` | C− | Teaching example only |
| `claude-code-templates` | C *(for this need)* | The baseline to differentiate against |

The corrected recommendation — recorded before the greenfield decision was finalized —
is [`due-diligence/recommendation.md`](../../due-diligence/recommendation.md): "Fork
`simple10/agents-observe` as the base for `agenthropic`. This *flips* the vendor
panel's primary pick (hoangsonww → simple10)."

## 4. Why we still build, even with a corrected fork target

The ranking correction changes *which* project would make the better fork base — it
does not change the "build vs fork" verdict, because of what the corrected #1 candidate
still doesn't have, and what it would drag in if adopted:

- **`simple10` (A−) still ships none of the five absent features** (§2 above) —
  including either of the two that make up the moat proper. Its edges
  are event-derived and session-scoped, not persisted or per-instance; it has no
  Telegram sink, no dollar-cost tile, no fleet hedge. Forking it buys a head start on
  the *tree algorithm*, not the moat itself — the hard part is still 100% greenfield
  work either way.
- **`simple10` as shipped binds `0.0.0.0`, ships wildcard CORS, and has zero auth** —
  "LAN-exposed as shipped" (due-diligence
  [`projects/simple10.md`](../../due-diligence/projects/simple10.md)). That is a direct
  contradiction of this project's non-negotiable security posture (loopback-only,
  mandatory token) — forking it means ripping this out before anything else runs.
- **`hoangsonww` (B−), the *un*corrected pick, carries a live RCE**: `/api/run` accepts
  a `permission-mode` from the browser request body whose allow-list includes
  `bypassPermissions`, so a browser request can spawn `claude --permission-mode
  bypassPermissions` in an attacker-chosen directory — code execution as the host user
  (due-diligence [`projects/hoangsonww.md`](../../due-diligence/projects/hoangsonww.md)).
  This is the exact anti-pattern this project's design forbids outright
  ([`DESIGN.md` §8](../../ai/DESIGN.md)) — we never add a browser-driven `claude`
  spawner, full stop.
- **`hoangsonww` is bus-factor-1 across 92k LOC**, with "enterprise cosplay over a solo
  project" red flags (70 badges, a 207 KB `ARCHITECTURE.md`) — adopting it wholesale is
  a real, ongoing support burden for a single owner
  ([`projects/hoangsonww.md`](../../due-diligence/projects/hoangsonww.md); echoed as a
  named risk in concept-analysis-v2's Holistic lens, §4.6: "a solo owner out-building a
  28.4k★ incumbent on five axes... is the exact hoangsonww
  enterprise-cosplay-over-solo-project trap").

[`DESIGN.md` §0](../../ai/DESIGN.md) states the resolution directly: "the audit's §6
shows the genuine product surface is *what none of the six delivers*... a real
greenfield moat — so we build, and *steal the best proven pieces* from each project
rather than inherit any one's baggage." concept-analysis-v2's bottom line agrees: "Build.
The concept is unusually coherent because it descends from a source-level audit of six
real rivals, not a blank page" ([§1](../../analysis/concept-analysis-v2.md)), and its
Business Analyst lens sharpens exactly which pieces of the moat are durable versus
retrofittable — see next.

### Which pieces of the moat are actually hard to copy

Not all five market-gap features are equally defensible against a well-resourced incumbent
adding them later. concept-analysis-v2's Business Analyst lens draws this line
explicitly ([§4.4](../../analysis/concept-analysis-v2.md)):

> "Durable moat = only what is hard to retrofit: persistent per-instance DAG + security
> posture + fleet. The other four (persistence, cost, alerts, DAG-lite) the incumbent
> *could* add — positioning must lead with the architecturally-hard differentiators."

In other words: `claude-code-templates` (or anyone) could bolt on a SQLite table, a
cost formula, or a webhook call without much engineering effort. What it cannot
cheaply bolt on is a **persisted, per-instance** orchestration graph (as opposed to a
session-scoped "DAG-lite," which
`simple10` and `hoangsonww` already prove is easy), the security-by-default posture that
is this project's spine, and fleet aggregation. The ruling best-path decision
([`best-path-decision.md` §6](../../analysis/best-path-decision.md)) sharpens this
line one step further: the moat proper is **two features — the persistent
cross-session DAG and dollar-cost attribution** — with the security posture as the
spine underneath them. Telegram alerting is a post-1.0 convenience, not a moat item,
and fleet aggregation stays deferred until a second host physically exists.
Positioning and engineering priority lead with those two, not the full list of five.

## 5. What we steal, and the licensing line that governs it

[`DESIGN.md` §7](../../ai/DESIGN.md) names the source-level patterns worth taking;
concept-analysis-v2's **CD-9** turns that into an enforceable rule, because licensing is
a hard commercial/legal gate, not a vibe (concept-analysis-v2
[§4.4](../../analysis/concept-analysis-v2.md), [§3](../../analysis/concept-analysis-v2.md)):

| From | Pattern | Mode | Why |
|---|---|---|---|
| `simple10` | ports/adapters storage; strategy-pattern agent classes; `buildAgentTree()`/`layoutTree()`; `AGENTS_OBSERVE_RUNTIME=local` under `launchd` (no Docker daemon) | **COPY, with attribution** (MIT + real LICENSE) | Cleanest, most portable base architecture |
| `hoangsonww` | `formatTelegram` webhook provider; `alert_rules`/`webhook_targets` schema ~~; dual SQLite driver (`better-sqlite3` + `node:sqlite` fallback)~~ *(dual-driver item dropped per best-path §6.3, applied 2026-07-06 — single `better-sqlite3` driver)* | **COPY, with attribution** (MIT + real LICENSE) | Easiest Telegram bridge |
| `cast` | `controlGate.ts` (~73 LOC: read-only by default, non-safe verbs 404 unless token, `timingSafeEqual`, mounted before router); delegation-savings formula (~50 LOC) | **CLEAN-ROOM** (no `license` field, `private:true`, "MIT" is a badge only) | Drop-in auth-gate shape; the cost-moat formula — reimplemented from the pattern description, re-verifying the pricing table, never by reading `cast`'s source while writing ours |
| `disler` | `send_event.py` (~180-LOC) ingest loop | **CLEAN-ROOM, teaching reference only** (no license, `private:true`) | Clearest example of the hook→HTTP→SQLite→WS loop; never built on directly |
| `nirdiamant` | git `stash` + tag run-checkpoint | **CLEAN-ROOM** (no LICENSE file despite declared MIT) | Non-destructive session snapshots |

The line is Berne-default copyright, applied literally: `cast`, `disler`, and
`nirdiamant` are **all-rights-reserved by default**, not "ambiguous," absent a real
LICENSE file — concept-analysis-v2's Gap lens calls this out as gap #4, a licensing
legal blocker under commercial intent (concept-analysis-v2
[§4.5](../../analysis/concept-analysis-v2.md)). Only `simple10` and `hoangsonww` carry
an MIT LICENSE that permits copying source with attribution. This per-artifact rule is
enforced by a CI provenance/license scan (CD-9) — see
[contributing: licensing](../contributing/licensing.md) (open page).

## 6. Where the moat lands in the roadmap

The moat is not built in one phase. [`DESIGN.md` §9](../../ai/DESIGN.md) sketches a
shorter, higher-level phase sequence; [the roadmap page](roadmap.md) later decomposed
that sketch into 75 dependency-checked units of work and **re-derived the phase
boundaries from that graph rather than from the original guess** — which moved Telegram
alerting and the delegation-savings metric *later* than DESIGN.md first sketched, and
moved the persisted DAG *earlier*. The roadmap page is explicit that its numbering is
"the canonical, dependency-checked version," so this table follows it, not the original
DESIGN.md sketch. One later refinement applies on top: the best-path decision
([`best-path-decision.md` §6.1](../../analysis/best-path-decision.md)) draws the v1.0
line after the dashboard — the alerting work in Phases 5–6 ships **post-1.0**:

| Phase | Deliverable | Moat item |
|---|---|---|
| 0 | Feasibility spike — reconstruct the subagent tree from `~/.claude/projects/*.jsonl` alone, confirm token reconciliation is exact | Prerequisite for #2.1 (LB1) |
| 1 | Foundation, security spine, storage — loopback + mandatory token, append-only `events_raw`, WAL + backup | #2.5 (persistence baseline) |
| 1.5 | Animated-room view (optional, cosmetic, deferred — no earlier than Phase 5) | — |
| 2 | Ingest substrate — hook receiver + transcript tailer collapse into one deduplicated event log | Prerequisite for #2.1–#2.3 |
| 3 | Projection, the DAG moat, reconciliation, cost — persisted `orchestration_edges`; the cost engine, including delegation-savings | #2.1, #2.2 (engine) |
| 4 | Read API, the dashboard — subagent tree, global DAG, cost/Sankey tile | #2.2 (dashboard tile) |
| 5 *(post-1.0)* | Alerting core — Telegram delivery adapter, `alert_rules`, SSRF-hardened dispatcher | #2.3 |
| 6 *(alerts UI post-1.0)* | Operator alerts UI + release hardening | — |
| Deferred | Cross-machine fleet aggregation — schema hedge (`instance`/`host_id`) ships early; the rollup itself is deferred until a second host physically exists, not scheduled | #2.4 |

Full phase detail, including the context-layer feed (kept as a strictly experimental,
off-critical-path track rather than a numbered phase), lives on
[the roadmap page](roadmap.md) (open page at the time of writing).

## See also

- [What is agenthropic](what-is-agenthropic.md) — the one-paragraph pitch (open page)
- [Comparison vs the field](comparison.md) — full baseline + six-rival comparison table (open page)
- [Roadmap](roadmap.md) — phases 0–6, public-friendly (open page)
- [FAQ](faq.md) — "why not just fork simple10 or hoangsonww?" (open page)
- [Architecture overview](../architecture/overview.md) — the ingest loop + ports & adapters (open page)
- [The DAG moat](../architecture/dag-moat.md) — persisted `orchestration_edges` in depth (open page)
- [Cost model](../architecture/cost-model.md) — `token_usage` buckets + delegation-savings (open page)
- [Security model](../security/model.md) — the posture that rules out forking `hoangsonww` or `simple10` as-is (open page)
- [Contributing: licensing](../contributing/licensing.md) — the CD-9 clean-room/attribution rule enforced in CI (open page)
