# Glossary & reference

This page is the terminology anchor for the architecture docs: precise, single-source
definitions for the fifteen terms used across [data model](../architecture/data-model.md),
[hook ingestion](../architecture/hooks.md), [ingest & reconciliation](../architecture/ingest-reconciliation.md),
[the DAG moat](../architecture/dag-moat.md), and [cost model](../architecture/cost-model.md),
plus two reference tables: the twelve Claude Code lifecycle events DESIGN §5 lists for
ingestion, and the four-value agent status enum DESIGN §4 defines in the schema. The key
takeaway: every term here traces to one authoritative source — the DESIGN.md schema/event
lists, or the deeper architecture page that expands it — so that "ground truth",
"projection", and "reconciliation" mean exactly the same thing wherever they recur across
this docs site. Where a term names something not yet built (the watchdog, delegation
savings), the definition says so and links the roadmap.

## How the terms relate

Two shapes underlie almost every term below. The first is the persisted entity hierarchy —
project → session → agent tree — that the design basis insists is **data, not a UI
reconstruction** (DESIGN §3):

```
project                                  (DESIGN §4: simple10-derived base schema)
  └─ session                             (agents.session_id NOT NULL — DESIGN §4)
       └─ agent  type='main'             (CHECK(type IN ('main','subagent')) — DESIGN §4)
            ├─ agent  type='subagent' ───┐
            │    └─ agent  type='subagent'│   parent_agent_id self-reference
            └─ agent  type='subagent' ───┘   (the persisted subagent tree — DESIGN §3, §4)

Each parent→child agent pair also emits one row in `orchestration_edges`
(parent_agent_id, child_agent_id, instance/host, derived_from_event_id) — DESIGN §4, §2.1.
```

The second is the ingest pipeline that produces every row above, from two inbound sources
into one immutable substrate, through one deterministic transform:

```
hook event  ──┐
              ├──►  events_raw (immutable)  ──►  projection  ──►  sessions / agents /
JSONL line  ──┘                                                   orchestration_edges /
                                                                   token_usage
```

(DESIGN §3–§4; the `events_raw`(immutable) + `events`(normalized) split and the
"projection" step are named this way consistently across
[architecture overview](../architecture/overview.md).)

## Core entities

**Agent** — a row in the `agents` table: a persisted, queryable participant in a session,
either the main agent or a subagent, carrying `id`, `session_id`, `type`, `subagent_type`,
`status`, and a self-referential `parent_agent_id` that builds the subagent tree as a data
fact rather than something the UI reconstructs from a flat event log (DESIGN §3, §4):

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

Full DDL and migration story: [data model](../architecture/data-model.md).

**Main agent** — an `agents` row with `type = 'main'`: the top-level agent for a session,
i.e. the direct Claude Code conversation the operator is driving, as opposed to any work it
delegates out (DESIGN §4 `CHECK` constraint above).

**Subagent** (one word) — an `agents` row with `type = 'subagent'` and a non-null
`parent_agent_id`: a unit of delegated work spawned by a parent agent. The `SubagentStop`
event (and, if it exists as a real hook, `SubagentStart`) is what feeds this parent→child
linkage into the persisted tree — see the [hook-event reference](#hook-event-reference-the-twelve-lifecycle-events)
below and DESIGN §5. Whether `SubagentStart` actually fires is unverified pending the
Phase-0 hook-catalog gate; see [what's undecided](../architecture/overview.md#whats-undecided).

**Session** — the scope every `agents` row belongs to (`agents.session_id NOT NULL`,
DESIGN §4): one Claude Code conversation, corresponding to one transcript under
`~/.claude/projects/*.jsonl` (DESIGN §3). `sessions` is one of the base tables the schema
starts from, alongside `projects`, `agents`, `events`, and `filters` (DESIGN §4).

**Project** — the Claude Code project (working directory) that groups one or more
sessions, per the same base schema DESIGN §4 starts from (`projects`, `sessions`, `agents`,
`events`, `filters` + disciplined migration tables) and the `~/.claude/projects/*.jsonl`
directory convention the ingest loop reads from (DESIGN §3).

**Instance / host** — the `instance`/`host` (also written `host_id`) key carried on
`orchestration_edges` rows (and, per the schema hedge, intended for every row) from the
first migration, identifying which running Claude Code process on which machine produced a
fact. agenthropic is single-host today (one Mac Mini M4); the key exists purely so a later
cross-machine fleet rollup (DESIGN §2.4, roadmap Phase 5+) never forces a schema migration
(DESIGN §4). "Per-instance" is the qualifier that distinguishes a real orchestration edge
from a *type-aggregated* diagram like `hoangsonww`'s (DESIGN §6).

## Pipeline & cost concepts

**Event** — a single lifecycle occurrence: either one of the twelve Claude Code hook types
DESIGN §5 lists, POSTed to the loopback `hook-ingest` endpoint, or a line tailed from the
JSONL transcript. Every event lands first, unmodified, as a row in the immutable
`events_raw` substrate, then is turned into a normalized `events` row and folded into
projected state — the `events_raw`(immutable) + `events`(normalized) split (DESIGN §3–§4).
Full catalogue: [hook ingestion](../architecture/hooks.md).

**Orchestration edge** — a persisted row in `orchestration_edges` recording one
parent→child agent relationship. Unlike every audited rival's tree, which is
**event-derived and reconstructed at render time, session-scoped**, these edges are
**persisted** (written once, at ingest or projection time), **per-instance** (not
type-aggregated), and carry the `instance`/`host` key described above — the moat feature
DESIGN §2 item 1 names as unclaimed by any of the six audited projects (DESIGN §2.1, §4).
Full design and the rebuild-from-JSONL story: [the DAG moat](../architecture/dag-moat.md).

> **Empirically validated (2026-07-04 desktop probe).** The persisted, per-instance,
> rebuild-from-JSONL edge model is confirmed against the real corpus: the depth-1
> parent→child edge is a **0%-orphan** hard key, and the tree is reconstructed by keying on
> the `Agent`/`Workflow` spawn tools (**never** `Task`) across **both** on-disk layouts.
> See [Phase-0 corpus probe](../../analysis/phase0-probe.md).

**Token bucket** — the `(speed, inference_geo, service_tier)` partition a `token_usage`
row falls into; each dimension independently changes the per-token rate, so the same
nominal token count can price differently depending on which bucket produced it — the
`hoangsonww` graft DESIGN §4 adopts for production-grade costing. Detail:
[cost model](../architecture/cost-model.md).

**Compaction baseline** — the pre-`PreCompact` token totals a `token_usage` row preserves
so that historical totals still price correctly after Claude Code rewrites the context
window, instead of silently losing history at the rewrite boundary (DESIGN §4). At the
ingest boundary `PreCompact` is handled like most other events — generic, not one of the
two dedicated-handling hooks (see the hook-event reference below) — but its payload is
what feeds this baseline-preservation logic downstream, at projection time.

**Delegation savings** — the dollar amount saved by routing work to a cheaper model (e.g.
Haiku) instead of pricing every token at the top-tier model's rate; part of the moat
DESIGN §2 item 2 names ("live dollar-cost attribution + delegation-savings … Borrow
`cast`'s ~50-LOC formula") and the roadmap's Phase 4 dual-pricing tile (DESIGN §9). DESIGN's
original sketch places this in Phase 4; the verified build plan re-sequences it into Phase
3 alongside the rest of the cost engine — see [roadmap](../guide/roadmap.md) for the
reconciled phase numbering. Computed strictly from ground-truth tokens × the versioned
pricing table, never estimated. Detail: [cost model](../architecture/cost-model.md).

## System guarantees

**Ground truth** — the invariant that every token count agenthropic ever displays or
prices is **read** from `~/.claude/projects/*.jsonl`, never estimated from tool-call
counts, never model-guessed, and never backfilled by a cheaper heuristic when one is
available (DESIGN §3, §8; restated as a non-negotiable design invariant in the repo's
`CLAUDE.md`). "Ground-truth tokens" is this docs site's fixed term for the same
guarantee (see [style guide](../STYLE-GUIDE.md)).

**Projection** — the deterministic, pure function that turns the immutable `events_raw`
log into queryable state: `sessions`, `agents`, `orchestration_edges`, `token_usage`.
Replaying the same `events_raw` log twice must yield byte-identical projected state — this
is a release-blocking correctness property, not an aspiration (DESIGN §3–§4, as summarized
in [architecture overview](../architecture/overview.md)). Full treatment:
[data model](../architecture/data-model.md).

**Reconciliation** — the per-field precedence rule the projection applies when a hook
event and a JSONL fact describe the same thing, resolved **at projection time**, not as a
two-store merge at query time. The standing rule: tokens are always JSONL-authoritative;
hooks may supply interim liveness/state, but the final session/agent state and cost always
trace to the transcript (DESIGN §3, as summarized in
[architecture overview](../architecture/overview.md), Invariant 1). Full contract,
including the still-open ingest-primacy question: [ingest & reconciliation](../architecture/ingest-reconciliation.md).

> **CD-1 pre-answered (not replaced).** The trustworthiness of JSONL as the outage-surviving
> single source of truth behind this rule — decision **CD-1** — is empirically **pre-answered
> `CONDITIONAL-GO` (confidence 85)** by the 2026-07-04 desktop probe
> ([Phase-0 corpus probe](../../analysis/phase0-probe.md)). This **de-risks but does not
> replace** the formal Phase-0 spike: it still confirms CD-1 on the paired-capture corpus, and
> the still-open ingest-primacy question above is unaffected.

**Watchdog** — the mechanism that flags a stuck agent as an explicit state rather than
leaving it falsely "working" forever when its stop signal never arrives within a window.
The pattern source named in the design basis is `hoangsonww`'s stuck-session watchdog idea:
a ~15-second transcript-interrupt marker plus an idle-timeout fallback, implemented with
`fs.watch` and a polling safety net (DESIGN §6). Deployed behavior (not yet built) and the
exact target state name are covered by
[operations/troubleshooting](../operations/troubleshooting.md) and sequenced in the
[roadmap](../guide/roadmap.md); see also the note on the `unknown` status below.

## Hook-event reference (the twelve lifecycle events)

DESIGN §5 sets the ingestion policy as: ingest all twelve via a single hook-handler, and
give `SubagentStart`/`SubagentStop` dedicated handling to feed the hierarchy tables. Not
all twelve are confirmed real: the independent analysis this design basis synthesizes
separately names a **documented set of only nine** — `PreToolUse`, `PostToolUse`,
`UserPromptSubmit`, `Notification`, `Stop`, `SubagentStop`, `SessionStart`, `SessionEnd`,
`PreCompact` — flagging `SubagentStart` as "probably not a real hook" and leaving
`PermissionRequest`/`PostToolUseFailure` likewise unconfirmed against that documented set.
This is exactly the open question [architecture overview](../architecture/overview.md#whats-undecided)
carries forward as a Phase-0 gate (`G0.2`, per [roadmap](../guide/roadmap.md)) — until it
runs, treat the "confirmed" column below as **DESIGN §5's stated intent**, not verified
fact.

| Event | Confirmed in the documented nine? | Dedicated handling in agenthropic | Source |
|---|---|---|---|
| `PreToolUse` | Yes | Generic ingest → `events_raw` | DESIGN §5 |
| `PostToolUse` | Yes | Generic ingest → `events_raw` | DESIGN §5 |
| `UserPromptSubmit` | Yes | Generic ingest → `events_raw` | DESIGN §5 |
| `Notification` | Yes | Generic ingest → `events_raw` | DESIGN §5 |
| `Stop` | Yes | Generic ingest → `events_raw` | DESIGN §5 |
| `SubagentStop` | Yes | **Dedicated** — feeds `agents`/`orchestration_edges` hierarchy | DESIGN §5 |
| `SubagentStart` | **No** — unverified, pending Phase-0 gate `G0.2` | **Dedicated, if confirmed** — paired with `SubagentStop` for hierarchy linkage | DESIGN §5; [overview §What's undecided](../architecture/overview.md#whats-undecided) |
| `SessionStart` | Yes | Generic ingest → `events_raw`; session-boundary bookkeeping | DESIGN §5 |
| `SessionEnd` | Yes | Generic ingest → `events_raw`; session-boundary bookkeeping | DESIGN §5 |
| `PreCompact` | Yes | Generic ingest → `events_raw`; marks the compaction boundary so `token_usage` preserves a repriceable baseline | DESIGN §4, §5 |
| `PermissionRequest` | **No** — not in the documented nine | Generic ingest → `events_raw` | DESIGN §5; [overview §What's undecided](../architecture/overview.md#whats-undecided) |
| `PostToolUseFailure` | **No** — not in the documented nine | Generic ingest → `events_raw` | DESIGN §5; [overview §What's undecided](../architecture/overview.md#whats-undecided) |

Full lifecycle-event catalogue and normalizer behavior for unrecognized/new event types
(never fatal — DESIGN §3, concept-analysis-v2 §4.2 as summarized in the overview page):
[hook ingestion](../architecture/hooks.md).

## Status enum

The `agents.status` column is a four-value `CHECK` constraint — no fifth value exists in
the DESIGN §4 schema quoted above:

| Status | Meaning | Source |
|---|---|---|
| `working` | The agent is actively running (the default live state for main agents and subagents alike). | DESIGN §4 |
| `waiting` | The agent is blocked — e.g. awaiting a permission decision or a delegated subagent's result. | DESIGN §4 |
| `completed` | The agent finished normally. | DESIGN §4 |
| `error` | The agent terminated in an error state. | DESIGN §4 |

> **Open item — the `unknown` status.** The roadmap and the underlying build plan describe
> a fifth, watchdog-assigned state: when an agent's stop signal never arrives within the
> watchdog window, it should be marked **`unknown`** rather than staying falsely `working`
> forever (roadmap [Phase 3](../guide/roadmap.md)). This is a real, planned behavior, but it
> is **not yet reflected in the DESIGN §4 `CHECK` constraint** quoted above — reconciling
> the schema to add it (or mapping "unknown" onto an existing value) is open work for
> [data model](../architecture/data-model.md) and
> [operations/troubleshooting](../operations/troubleshooting.md), not a decision this page
> makes.

## See also

- [Architecture overview](../architecture/overview.md) — the full ingest loop and the two
  invariants (ground truth, persisted hierarchy) these terms protect.
- [Data model](../architecture/data-model.md) — full DDL for `agents`, `sessions`,
  `events_raw`/`events`, `token_usage`, `orchestration_edges`.
- [Hook ingestion](../architecture/hooks.md) — the lifecycle-event catalogue in depth,
  including `SubagentStart`/`SubagentStop` handling.
- [Ingest & reconciliation](../architecture/ingest-reconciliation.md) — the reconciliation
  contract, CD-1, and the Phase-0 ingest-primacy spike.
- [The DAG moat](../architecture/dag-moat.md) — persisted `orchestration_edges` and the
  rebuild-from-JSONL story.
- [Cost model](../architecture/cost-model.md) — token buckets, compaction baselines,
  dual-pricing, and delegation savings in depth.
- [Roadmap](../guide/roadmap.md) — phase sequencing for the watchdog, delegation savings,
  and every other item marked not-yet-built above.
- [Style guide](../STYLE-GUIDE.md) — the terminology and authoring conventions this page
  follows.
