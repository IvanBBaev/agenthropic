# The DAG moat

This page explains the single hardest, most defensible piece of agenthropic's design:
the **global, persisted, per-instance orchestration DAG**, why it is unclaimed ground
across every audited rival, how it is actually built (dual-path edge derivation, `WP-IN8`),
and how its correctness is proven even after a total outage (rebuild-from-JSONL-alone,
one of Phase 3's three release-blocking tests). The key takeaway: every other project
in the audit renders a subagent tree by walking an event log **at render time, scoped
to one session**; agenthropic instead **writes `orchestration_edges` rows once, at
ingest/projection time**, keyed **per agent instance** (not per subagent type), tagged
with a host/instance key from day one, and queries that table for both the session tree
and the cross-session global DAG — never reconstructing it in the browser
(`DESIGN.md` §2, §4, §6). This is deliberately the hardest thing on the roadmap to get
right, which is exactly why it is the moat and not a nice-to-have.

> **Update — 2026-07 (as built).** The moat artifact exists. `orchestration_edges` is a
> real table (migration 5, `apps/server/src/db/migrations.ts`), written at ingest time
> in the same transaction as sessions/agents/token rows, and served by real endpoints
> (`GET /api/sessions/:id/tree` and `GET /api/dag/global` — a query over persisted rows,
> never a render-time reconstruction). Three things landed differently than this page
> sketches:
>
> - **The edges are JSONL-only, not dual-path.** No hook ever asserts an edge —
>   `SubagentStart` does not exist, and even `SubagentStop` contributes only a liveness
>   timestamp. The parser derives every edge from the transcripts via **four join
>   paths**, recorded per row in a `source` column:
>   `'tool_use'`, `'directory'`, `'task_notification'`, `'queue_operation'`.
>   "Rebuild from JSONL alone" is therefore not a fallback proof but the only branch
>   the system has.
> - **The real DDL differs from the CD-4 sketch**: the `UNIQUE` logical key is
>   session-scoped (`session_id, parent_agent_id, child_agent_id`), there is **no
>   `derived_from_event_id`** (edges never derive from normalized events — provenance
>   is the `source` join-path column), and `instance`/`host_id` are both `NOT NULL` as
>   promised. See the DDL section below.
> - **The P0 proofs are built and green** in the server test suite: Σ`token_usage`
>   equals the JSONL sum exactly, double-replay is idempotent, and the DAG rebuilds
>   from JSONL alone. On the hand-labeled corpus the hard join produced **0.000%
>   orphaned agents** (G0.1b) — orphans, when they occur in the wild, get **no edge**
>   rather than a guessed one.

## Why this is "the moat" and not just a feature

`DESIGN.md` §2 lists five capabilities "confirmed absent across all six audited
projects" as the reason to build rather than adopt one of them; item one is this DAG:

> "Global, persistent, per-instance orchestration DAG. Everyone has at most a
> *session-scoped* tree with **event-derived, non-persisted** edges. A real, queryable,
> cross-session per-instance graph is unclaimed ground." (`DESIGN.md` §2, item 1)

Three words in that sentence carry the entire design decision, and each maps to a
concrete, checkable property of the schema and the build plan below:

| Word | What it rules out | What agenthropic does instead |
|---|---|---|
| **persisted** | Deriving edges from the event/JSONL stream at render time, every time the UI opens | Writing `orchestration_edges` rows once, at ingest/projection time (`DESIGN.md` §4) |
| **per-instance** | Collapsing many concrete subagent runs into a handful of "type" nodes in the diagram | One row/node per actual agent instance — no aggregation by `subagent_type` |
| **cross-session** | A tree that only makes sense inside the one session that produced it | A graph a query can span across sessions, keyed by a host/instance column, for a global view |

The rest of this page is the mechanics behind each of those three words.

## Persisted, not event-derived at render time

`DESIGN.md` §4 states the requirement directly, immediately after grafting the
`agents` self-referential hierarchy from `hoangsonww`:

> "For the moat (§2.1), extend beyond any existing schema: edges must be **persisted**
> (not event-derived at render time) and **per-instance** (not type-aggregated), and
> carry an `instance`/`host` key for future fleet aggregation (§2.4)." (`DESIGN.md` §4)

Concretely, this means `orchestration_edges` is a real table with real rows, written
during ingestion/projection — not a data structure the frontend builds by walking
`events` (or a JSONL transcript) every time a page loads. The development plan encodes
this as its own persisted-data work package:

> **`WP-D7`** — data, size M, deps `D6, D4`: "**`orchestration_edges` persisted table**
> (the moat artifact). Duplicate logical edge → exactly one row (**UNIQUE + INSERT OR
> IGNORE**). Non-null `instance`/`host_id`." (`development-plan.md`, Track D)

Two properties fall directly out of that Done-when clause:

- **Idempotent writes.** The same logical parent→child edge can be derived more than
  once (from a replayed hook, from a JSONL re-read, from both paths at once — see
  below) without producing duplicate rows. A `UNIQUE` constraint on the logical edge
  plus `INSERT OR IGNORE` is the mechanism named in `WP-D7`'s Done-when.
- **The host/instance key is mandatory, not optional**, from the very first migration —
  `WP-D7` requires it **non-null**. This is the schema-level hedge for fleet
  aggregation (`DESIGN.md` §4, §2 item 4) discussed below.

By the time the read side needs to serve a tree or a global graph, the answer is
already sitting in a table — it is **queried**, never rebuilt in the request path. That
is exactly the property `WP-U3` (session/agent/subagent-tree endpoints) and `WP-U8`
(the global DAG view) are built to prove:

> `WP-U3`: "`GET /sessions/:id/tree` built from a **query over `orchestration_edges`**
> (proven, not reconstruction)." (`development-plan.md`, Track U)
>
> `WP-U8`: "**Global persistent per-instance orchestration DAG view** (the moat). Spans
> multiple sessions, sourced from a query over persisted edges." (`development-plan.md`,
> Track U)

> **As built:** both endpoints exist in `apps/server/src/api/routes.ts` —
> `GET /api/sessions/:id/tree` and `GET /api/dag/global` — and both answer from a query
> over the persisted `orchestration_edges` rows. Idempotent writes shipped exactly as
> named: `INSERT OR IGNORE` against `UNIQUE (session_id, parent_agent_id, child_agent_id)`,
> so whole-session re-ingest (the replay mechanism) collapses duplicate derivations to
> one row. `instance` and `host_id` are `NOT NULL` from migration 5.

## Per-instance, not type-aggregated

The second word matters because at least one audited rival built something that *looks*
like a DAG but collapses individual agent runs into categories. `DESIGN.md` §6 is
explicit that this is not the same thing, and names it directly:

> "`hoangsonww`'s 'DAG cockpit' is **oversold** — `OrchestrationDAG.tsx` is a
> *type-aggregated* 3–4 layer diagram; its true nesting is a collapsible indented tree
> reconstructed post-hoc on `SubagentStop`. Study its D3 Sankey / aggregate polish, but
> know that the *global, persistent, per-instance* DAG (§2.1) is the thing we still have
> to build." (`DESIGN.md` §6)

The distinction: a *type-aggregated* diagram draws one node per `subagent_type` (say,
one node for "code-reviewer" no matter how many times it ran) and shows a handful of
layers of category flow. A *per-instance* graph draws one node per actual agent row —
every individual invocation, with its own id, its own parent, its own status — the way
`agents.parent_agent_id` already models the hierarchy (`DESIGN.md` §4). agenthropic's
DAG is explicitly the second kind; the first kind is useful for aggregate visual polish
(hence "study its D3 Sankey"), but it is not a substitute for the per-instance graph
this project still has to build.

## The host/instance key: built for a fleet that doesn't exist yet

`DESIGN.md` §2 names cross-machine/fleet aggregation as a separate absent capability
(item 4) — "All six [audited projects] are single-host." The DAG schema is designed so
that adding fleet support later is a query change, not a migration:

- `orchestration_edges` carries an `instance`/`host` key from the design basis (`DESIGN.md`
  §4), and `WP-D7`'s Done-when makes that column **non-null** in the actual table from
  the first migration.
- Fleet aggregation itself is **not** scheduled in the current six-phase build — `DESIGN.md`
  §9's roadmap places it at **Phase 5+**, bundled with the DAG's own layout extension:
  "**Moat extensions** — Global persistent per-instance DAG (ELK/Graphviz);
  cross-machine fleet aggregation."

So today the key exists and is populated (single Mac Mini, one `instance`/`host_id`
value), but there is no fleet UI or cross-host rollup yet — the column is a hedge
against a future migration, not a shipped feature. Until Phase 5+ lands, treat any
"fleet" framing as **schema-ready, not built**.

## Dual-path edge construction (`WP-IN8`)

> **As built, the "dual-path" collapsed to one path — deeper than designed.** The hook
> leg was never built: `SubagentStart` does not exist, and no hook (not even
> `SubagentStop`) asserts an edge. What shipped instead is the parser's **four JSONL
> join paths** — `tool_use` (the `Agent`/`Workflow` spawn's `tool_use.id` matched to
> the child's `meta.toolUseId`), `directory` (nested `workflows/wf_*/` containment),
> `task_notification`, and `queue_operation` — each recorded in the row's `source`
> column, so an edge's provenance stays queryable. An agent none of the four paths can
> join gets **no edge** (visible as an orphan), never a guessed one. The section below
> is the design record of why the hedge existed.

This is the core mechanism, and the single largest execution-risk item on the moat. The
development plan's work package is explicit that the persisted edge must be derivable
two independent ways:

> **`WP-IN8`** — backend, size L, deps `IN7, S1, S2, S3`: "**Dual-path edge derivation
> → persisted `orchestration_edges`** (moat core). Correct parent→child tree via the
> **JSONL `Agent`/`Workflow` spawn-chain** even if `SubagentStart` never fires."
> (`development-plan.md`, Track IN)

Read literally, this names two paths that both feed the same table:

1. **The hook path.** Live lifecycle events — `SubagentStart`/`SubagentStop` — arrive at
   ingest and (once projected through `WP-IN7`) can directly assert a parent→child
   edge as it happens.
2. **The JSONL `Agent`/`Workflow` spawn-chain path.** Independently of any hook firing,
   the `~/.claude/projects/*.jsonl` transcript records the `Agent` and `Workflow` tool
   invocations that spawn subagents — a general-purpose `Agent` spawn writes a flat
   `subagents/agent-<hex>.jsonl` (+ `.meta.json`), a `Workflow` spawn writes a nested
   `subagents/workflows/wf_<id>/` subtree — and the parser branches on that directory
   shape, not on CC version. Walking that chain in the transcript lets the same
   parent→child edge be derived **even if `SubagentStart` never fires for that session**
   — the exact contingency `WP-IN8`'s Done-when calls out by name.

> **Empirically grounded — 2026-07-04 corpus probe.** The full-corpus read-only probe
> found **zero `Task` tool blocks** in the real corpus; every spawn is an `Agent` (142)
> or `Workflow` (29) tool call, so the JSONL path keys on those two tools and branches
> on **directory shape** (flat `agent-<hex>.jsonl` vs nested `workflows/wf_<id>/` —
> 85% of agent files are nested), never on CC version. A `Task`-keyed parser would
> rebuild an **empty** DAG. This also pre-answers CD-1 as `CONDITIONAL-GO` → build
> (confidence 85), de-risking but **not replacing** the formal Phase-0 spike (`S1`–`S3`)
> or the production-code gate below. Full evidence:
> [Phase-0 corpus probe](../../analysis/phase0-probe.md).

```
 live hook events                  ~/.claude/projects/*.jsonl
 (SubagentStart/Stop,               (Agent/Workflow spawn chain,
  when they fire)                    always present)
        │                                    │
        ▼                                    ▼
   ┌─────────────────────────────────────────────┐
   │        WP-IN8 — dual-path edge derivation     │
   │   (consumes WP-IN7's projected sessions/      │
   │    agents; either path can assert an edge)    │
   └─────────────────────────────────────────────┘
                        │
                        ▼
        orchestration_edges  (UNIQUE + INSERT OR IGNORE,
                              non-null instance/host_id — WP-D7)
```

Both paths write into the same `UNIQUE`-constrained table (`WP-D7`), so if a hook event
and a JSONL-derived inference describe the same logical edge, the second write is a
no-op (`INSERT OR IGNORE`) rather than a duplicate row or a conflict. This is what makes
the two paths genuinely redundant rather than merely "two features that both sort of
build a tree" — either one, alone, is sufficient to populate the table correctly for a
given edge.

`WP-IN8` depends on `WP-IN7` (the projection that turns raw events into
sessions/agents/`token_usage` — see [ingest & reconciliation](../architecture/ingest-reconciliation.md)
for the projection in full) and on the Phase-0 spike outputs `S1`–`S3`, i.e. this
mechanism is not designed in a vacuum — it is built against the labeled real-session
corpus captured before any production code exists.

Downstream of `WP-IN8`, two more work packages close the loop that dual-path derivation
opens:

- **`WP-IN9`** — reconciliation precedence + deterministic `token_usage.agent_id`
  backfill: "After backfill every row attributed to exactly one agent; session-sum
  invariant holds." (deps `IN7, IN8`)
- **`WP-IN12`** — missing-Stop watchdog: "A missing `SubagentStop` → **'unknown'**
  within the window, never a permanent 'working'." (deps `IN7, S5`) A node whose
  `SubagentStop` never arrives is not left dangling as falsely "working" in the
  persisted graph forever — it flips to a distinct `unknown` state within a bounded
  window instead.

> **As built:** `WP-IN12` shipped as written — stale non-terminal agents flip to
> `'unknown'` after a bounded window (`DASHBOARD_WATCHDOG_MINUTES`, default 10,
> PROVISIONAL), and a later re-ingest lets JSONL evidence win the status back.
> `WP-IN9`'s backfill pass was **never needed**: `token_usage.agent_id` is attributed
> inside the parser, before any write, in the same transaction — a `NULL` there means
> genuinely unattributable, not "awaiting backfill".

## Rebuild-from-JSONL-alone: the test that proves the moat is real

A dual-path design is only as good as its proof that the fallback path actually works
under a real outage, not just in the happy path where both signals agree. Phase 3's
exit gate names three release-blocking correctness tests, and the third one is
specifically about this DAG:

> "**Three P0 tests green & merge-blocking** (Σ`token_usage`==JSONL exact;
> double-replay byte-identical DB; **DAG rebuild from JSONL alone** after a simulated
> outage); hierarchy **≥95%** vs the labeled corpus even without `SubagentStart`;
> missing-Stop→unknown; PreCompact reprices vs baseline; no priceless model;
> 12-scenario negative catalogue green." (`development-plan.md` §3, Phase 3 row)

The relevant work packages that assemble and run this test:

| WP | Role |
|---|---|
| `WP-IN10` | "Replay-on-startup + deterministic full projection rebuild. Double-replay → **byte-identical** `events_raw` and projected DB." (deps `IN2, IN6, IN7, IN8, IN9`) |
| `WP-IN13` | "Reconciliation / idempotency / DAG-rebuild suite (P0 blockers). All three P0 tests green in CI and **blocking**." (deps `IN10, IN9, X1`) |
| `WP-X3` | "**Three P0 reconciliation release-blocker tests.** Σ`token_usage`==JSONL exact; double-replay byte-identical; **DAG-rebuild-from-JSONL-alone**." (deps `X2, IN10, IN7, D1`) |

What "rebuild from JSONL alone" means concretely: simulate the outage of the live hook
stream entirely — the first path in the dual-path diagram above goes dark — and confirm
that replaying only the `~/.claude/projects/*.jsonl` transcript through the projection
and `WP-IN8`'s JSONL `Agent`/`Workflow` spawn-chain path still reconstructs the same persisted
`orchestration_edges` rows. This is the release-blocking proof that the fallback path
in `WP-IN8` is not a paper guarantee. It sits on the development plan's own **"moat
spine"** — the sub-chain called out as the schedule-critical thread independent of
alerting:

> "The moat spine (independent of alerts) is the sub-chain `…D4 → IN1 → IN6 → IN7 →
> IN8 → IN9 → IN10`, landing the three P0 reconciliation tests at wave 16 — protect
> *that* on schedule." (`development-plan.md` §4)

The Phase 3 exit gate also requires the reconstructed hierarchy to hit **≥95% accuracy**
against a hand-labeled real session **even without `SubagentStart` firing at all** —
i.e. the JSONL-only path has to carry the tree on its own, not just contribute
alongside a healthy hook stream, to clear the gate.

> **As built:** the three P0 tests exist as real test files in the server suite and are
> green — token-sum exactness, double-replay idempotence (re-ingesting an unchanged
> session writes nothing new), and DAG-rebuild-from-JSONL-alone. The last one is no
> longer a *fallback* proof: since hooks never feed edges, JSONL-alone is the only
> branch, and the test asserts the system's normal operation, not an outage mode. The
> ≥95% bar was passed with margin — the hard join (G0.1b) produced **0.000% orphaned
> agents and 100% usage attribution** on the hand-labeled corpus. Replay-on-startup is
> the ingest watcher's first tick over the whole corpus; idempotent whole-session
> re-ingest replaces the byte-identical-substrate formulation (JSONL never lands in
> `events_raw` — see [ingest & reconciliation](../architecture/ingest-reconciliation.md)).

## Contrast with rivals

`DESIGN.md` §6 gives an "honest read of the state of the art" that draws the line
between table-stakes and the moat precisely:

| | Scope | Edge origin | Aggregation | Verdict (`DESIGN.md` §6) |
|---|---|---|---|---|
| **`simple10`** | Session-scoped | Event-derived, computed at render time via `buildAgentTree()`/`layoutTree()` (parent→child, orphan-reparenting, root synthesis) plus a dependency-free N-body force graph (`physics.ts`) | Per-instance | "Table-stakes... the model to match" for the *session-scoped* tree — validate against one real subagent-heavy session before committing |
| **`hoangsonww`** | Multi-session-looking, but really a post-hoc reconstruction | Reconstructed post-hoc on `SubagentStop`; not a persisted edge table | **Type-aggregated** (`OrchestrationDAG.tsx` is a 3–4 layer diagram of categories) | "Oversold" — worth studying for its D3 Sankey/aggregate polish, not as a DAG implementation to copy |
| **agenthropic** | **Cross-session, global** | **Persisted** at ingest/projection time (`orchestration_edges`, dual-path via `WP-IN8`) | **Per-instance** | The moat — "unclaimed ground" (`DESIGN.md` §2 item 1) |

Two things worth being precise about, since it is easy to blur them:

- `simple10`'s tree is genuinely good — `DESIGN.md` §6 calls it "table-stakes" to
  *match*, not to dismiss, and names its algorithm explicitly as the model for
  agenthropic's own **session-scoped** tree view. The moat is not "have a better tree
  algorithm than `simple10`" — it is "persist the tree as first-class rows so it can be
  queried across sessions," which `simple10` does not attempt.
- `hoangsonww`'s cockpit is the one most likely to be mistaken for solving this problem
  at a glance, precisely because it is visually the most developed DAG-shaped UI in the
  audited set. `DESIGN.md` §6 is deliberate about naming exactly what it actually is
  (a type-aggregated diagram over a post-hoc reconstruction) so that distinction is not
  lost in a demo screenshot.

## Confirmed shape of `orchestration_edges` (as built: migration 5 is the authority)

Beyond `WP-D7`'s Done-when and `DESIGN.md` §4, the canonical decision **CD-4**
(`concept-analysis-v2.md`) pins the column set explicitly:

> "persisted `orchestration_edges` (self-ref `parent_agent_id`, `instance`/`host_id`,
> `derived_from_event_id`, idempotent)" (`concept-analysis-v2.md`, CD-4)

So the confirmed constraints on the table are:

- a self-referential parent→child edge, in the same spirit as `agents.parent_agent_id`
  (`DESIGN.md` §4);
- a `UNIQUE` constraint on the logical edge, enforced with `INSERT OR IGNORE` so a
  duplicate derivation (hook and JSONL agreeing, or a replay) collapses to one row
  (`WP-D7`);
- a non-null `instance`/`host_id` column (`WP-D7`, CD-4); and
- a `derived_from_event_id` column tracing the edge back to the normalized event that
  produced it (CD-4) — the same provenance pattern as `events.raw_event_id`.

The migration is now written, so the synthesis era is over. The real DDL (migration 5,
`apps/server/src/db/migrations.ts`):

```sql
CREATE TABLE orchestration_edges (
  id              INTEGER PRIMARY KEY,
  session_id      TEXT NOT NULL,
  parent_agent_id TEXT NOT NULL,
  child_agent_id  TEXT NOT NULL,
  source          TEXT NOT NULL CHECK (source IN ('tool_use','directory','task_notification','queue_operation')),
  instance        TEXT NOT NULL,
  host_id         TEXT NOT NULL,
  created_at      TEXT,
  UNIQUE (session_id, parent_agent_id, child_agent_id)
);
CREATE INDEX idx_orchestration_edges_session_id ON orchestration_edges(session_id);
```

Where the built table departs from the CD-4 sketch, and why:

- **`derived_from_event_id` was not built.** CD-4 assumed edges would derive from
  normalized events; as built they derive from the JSONL parser directly (there is no
  Normalizer stage), so per-event provenance would point at nothing. The `source`
  column carries the provenance instead — which of the four join paths produced the
  edge.
- **The `UNIQUE` logical key is session-scoped** (`session_id, parent_agent_id,
  child_agent_id`) rather than instance-scoped — agent ids are unique per session, and
  whole-session re-ingest needs replays to collapse within the session boundary.
- **No FK to `agents`** — rows are written with `INSERT OR IGNORE` inside the same
  transaction that upserts agents in topological order; the join is by id, not
  enforced by the engine.
- `instance` and `host_id` **non-null**: shipped exactly as `WP-D7` demanded.

## Roadmap placement

The DAG moat is not a Phase 1 deliverable. `DESIGN.md` §9 places the moat extensions
(ELK/Graphviz layout, fleet aggregation) at **Phase 5+**, but the moat's *core*
artifact — the persisted `orchestration_edges` table itself, dual-path derivation, and
the rebuild-from-JSONL-alone proof — lands earlier, in **Phase 3**:

> "**3 — Projection, the DAG moat, reconciliation, cost** _(P0 blockers)_ | Pure
> normalizer + projection; dual-path `orchestration_edges`; reconciliation + backfill;
> replay-on-startup; watchdog 'unknown'; CostEngine with compaction repricing +
> delegation-savings." (`development-plan.md` §3)

Reading the two roadmap layers together:

- **Phase 3** builds and proves the table and its dual-path population — this is what
  makes the moat *real* rather than aspirational.
- **Phase 4** (`WP-U3`, `WP-U8`) exposes it through the read API and the SPA — the
  session tree and the global DAG views, both sourced from a query over
  `orchestration_edges`, never a render-time reconstruction.
- **Phase 5+** (`DESIGN.md` §9, roadmap row "Moat extensions") is where the DAG grows a
  real layout engine and, separately, where the host/instance key gets an actual fleet
  UI built on top of it.

> **As built:** the Phase 3 core (persisted table, JSONL edge derivation, P0 proofs)
> and the Phase 4 read side (tree + global-DAG endpoints and the SPA views over them)
> both landed in the 2026-07 implementation wave. The Phase 5+ extensions remain
> unbuilt: no ELK/Graphviz layout, no fleet UI — the `instance`/`host_id` columns stay
> schema-ready, not shipped features.

## First layout extension: ELK/Graphviz

Once the persisted graph exists and is queryable, its rendering can still improve
independently of its correctness. `DESIGN.md` §6 names the specific next step, framed
explicitly as future work, not something scoped into the current build:

> "First extension when needed: ELK/Graphviz layout over the persisted tree."
> (`DESIGN.md` §6)

The framing matters: this is a **layout** improvement (how the already-correct,
already-persisted graph is laid out on screen — automatic layered/hierarchical
positioning, the kind ELK or Graphviz specialize in) rather than a data-model change.
It is explicitly deferred ("when needed"), with no work package or phase assignment yet
in `development-plan.md` — there is nothing further to source about scope, timing, or
which library wins until that decision is made.

## What's undecided

*(What was open when this page was written; the as-built resolutions follow each item.)*

- **The literal `orchestration_edges` migration DDL.** The column set itself is decided
  (`WP-D7`'s Done-when plus CD-4: self-referential edge, `UNIQUE` + `INSERT OR IGNORE`,
  non-null `instance`/`host_id`, `derived_from_event_id`) — but per
  [the data model](../architecture/data-model.md) page's own status table, the exact
  FK/child-column naming remains a reference synthesis pending the actual migration
  (`WP-D4`…`WP-D10`), none of which are written yet.
  *Resolved:* migration 5 is written and quoted above — `derived_from_event_id` became
  the `source` join-path column; the logical key is session-scoped.
- **Fleet aggregation itself.** The host/instance key is populated from the first
  migration, but the cross-machine rollup UI/queries are Phase 5+ and not decomposed
  into work packages yet (`DESIGN.md` §9). *Still open — unchanged as built.*
- **The ELK/Graphviz layout extension.** Named as "the first extension when needed"
  (`DESIGN.md` §6) with no committed timing or library choice.
  *Still open — unchanged as built.*
- **Whether `SubagentStart` reliably fires at all.** `WP-IN8`'s Done-when is written to
  tolerate `SubagentStart` never firing for a given session — the dual-path design is
  explicit insurance against exactly that uncertainty. Full hook-catalog verification
  status: [hook ingestion](../architecture/hooks.md).
  *Resolved:* `SubagentStart` does not exist; edges never needed any hook at all.

## See also

- [Architecture overview](../architecture/overview.md) — the full ingest loop and the
  two invariants (ground-truth tokens, persisted agent hierarchy) this page assumes.
- [Data model](../architecture/data-model.md) — the annotated schema reference for
  `agents`, `orchestration_edges`, `sessions`, `events_raw`/`events`, `token_usage`
  (now carrying the real migration DDL for all seven built tables).
- [Ingest & reconciliation](../architecture/ingest-reconciliation.md) — the as-built
  ingest pipeline, and the CD-1 ingest-primacy decision the edge derivation rests on.
- [Phase-0 corpus probe](../../analysis/phase0-probe.md) — the empirical CD-1 verdict
  (`Agent`/`Workflow` ≠ `Task`; dual-layout; child-transcript token summation) that the
  dual-path mechanism on this page keys on.
- [Hook ingestion](../architecture/hooks.md) — the lifecycle-event catalog, including
  the `SubagentStart`/`SubagentStop` verification status (open page).
- [The moat](../guide/the-moat.md) — why this is one of five capabilities no audited
  rival ships, and how it fits the other four.
- [Roadmap](../guide/roadmap.md) — Phase 3's exit gate and the "moat spine" critical
  path in full, public-friendly framing.
- [Security model](../security/model.md) — the loopback/token/no-spawner posture that
  applies to every endpoint that serves this graph (open page).
