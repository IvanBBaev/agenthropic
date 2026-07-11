# Data model

This page is the annotated SQLite schema reference for agenthropic: the append-only
`events_raw` substrate that every hook payload and every JSONL line lands in, the
deterministic `events` → `sessions`/`agents`/`orchestration_edges`/`token_usage`
projection built on top of it, `model_pricing`, and the Phase 5 alert/webhook tables
grafted from `hoangsonww`. The key takeaway: **the schema is a one-way pipeline, not a
two-store merge** — both ingestion sources write into one immutable, idempotency-keyed
log, and everything queryable (the subagent tree, the DAG, cost) is a pure, replayable
projection over that log, computed once at projection time rather than reconciled ad hoc
on every read (`concept-analysis-v2` CD-2). Only one table's DDL is fixed verbatim by the
design basis today — `agents` (DESIGN §4). Every other table below is a **reference
schema synthesized from the documented column-level decisions** in CD-4 and
[`development-plan.md`](../../analysis/development-plan.md) Track D/C/A; the literal
migrations land in `WP-D4`…`WP-D10`, `WP-C1`, and `WP-A2`, none of which are written yet —
the project is still in its pre-code bootstrap phase. Column names for raw token counts
and price rates are illustrative pending those migrations; every bucket dimension,
constraint, and invariant named in the tables is sourced.

## Table inventory

| Table | Layer | Status | Purpose | Primary source |
|---|---|---|---|---|
| `events_raw` | Substrate | Designed, not built | Immutable, idempotency-keyed landing zone for every hook and JSONL fact | CD-2, CD-4, `WP-D4` |
| `events` | Normalized | Designed, not built | Deterministic, queryable normalization of `events_raw`, FK-linked back to it | CD-4, `WP-D5`, `WP-IN6` |
| `sessions` | Projection | Designed, not built | One row per Claude Code session | `WP-D6` |
| `agents` | Projection | **DDL fixed** (DESIGN §4) | Self-referential subagent tree — a data fact, not a UI reconstruction | DESIGN §4, `WP-D6` |
| `orchestration_edges` | Projection (moat) | Designed, not built | Persisted, per-instance, dual-derived parent→child edges; the source every tree/DAG view queries | DESIGN §4/§6, CD-4, `WP-D7`, `WP-IN8` |
| `token_usage` | Projection | Designed, not built | Fine-grained cost buckets with compaction baselines | DESIGN §4, CD-3/CD-4, `WP-D8` |
| `model_pricing` | Reference | Designed, not built | Versioned per-token rates, dated | CD-4, `WP-C1` |
| `alert_rules` | Alerting (Phase 5 — post-1.0 per best-path §6.1) | Designed, not built | Operator-defined trigger conditions | DESIGN §4/§7, `WP-A2` |
| `alert_events` | Alerting (Phase 5 — post-1.0 per best-path §6.1) | Designed, not built | Fired-alert log | DESIGN §4/§7, `WP-A2` |
| `webhook_targets` | Alerting (Phase 5 — post-1.0 per best-path §6.1) | Designed, not built | Outbound delivery targets (Telegram, etc.), secret held by reference only | DESIGN §4/§7, `WP-A2`, `WP-A3` |
| `webhook_deliveries` | Alerting (Phase 5 — post-1.0 per best-path §6.1) | Designed, not built | Delivery attempts with retry/backoff | DESIGN §4/§7, `WP-A2`, `WP-A7` |

**Not in this inventory: `projects` and `filters`.** DESIGN §4 names them as part of the
`simple10`-derived base schema alongside `sessions`/`agents`/`events`: *"Start from
`simple10`'s clean normalised base (`projects`, `sessions`, `agents`, `events`, `filters` +
disciplined migration tables)..."* No source document — not DESIGN.md, not
`development-plan.md`'s Track D catalog — gives either table a column-level shape, a
purpose beyond that one-line mention, or an owning work package, so neither is modeled here.
Tracked as an open gap in the table below, not invented.

"Phase 5" follows the canonical, adversarially-verified phase table in
[`development-plan.md`](../../analysis/development-plan.md) §3 (Track A, Phase
5–6). Note: DESIGN.md's own, earlier roadmap sketch (§9) labels the same Telegram/alert
work "Phase 2" — the development plan supersedes it as the reconciled schedule; this page
follows the development plan.

## The one-way pipeline: raw → normalized → projected

CD-2 (`concept-analysis-v2.md` §3) states the design in one sentence: *"Both sources
write into append-only, idempotency-keyed `events_raw`; `sessions`/`agents`/
`orchestration_edges`/`token_usage` are a pure replayable projection over it."*
Concretely, three stages, each owned by a distinct work package:

```
┌────────────────────────────┐        ┌──────────────────────────────┐
│   Claude Code hooks (HTTP)  │        │  ~/.claude/projects/*.jsonl  │
│   via HookSource port       │        │  via TokenReader/TokenSource │
└──────────────┬──────────────┘        └───────────────┬──────────────┘
               │                                        │
               └───────────────────┬────────────────────┘
                                    ▼
                     ┌──────────────────────────┐
                     │        events_raw        │   append-only, idempotency-keyed
                     │        (immutable)        │   WP-D4
                     └─────────────┬─────────────┘
                                    │  Normalizer — pure, deterministic (WP-IN6)
                                    ▼
                     ┌──────────────────────────┐
                     │          events           │   normalized, queryable
                     │   raw_event_id FK (WP-D5) │
                     └─────────────┬─────────────┘
                                    │  Projection — precedence-aware (WP-IN7)
                                    ▼
        ┌───────────┬────────────────────┬───────────────────────┬───────────────┐
        │ sessions  │       agents        │  orchestration_edges   │  token_usage  │
        │  (WP-D6)  │  self-ref (WP-D6)   │   the moat (WP-D7)     │   (WP-D8)     │
        └───────────┴────────────────────┴───────────────────────┴───────────────┘
```

Two consequences follow directly from this shape:

1. **Reconciliation happens once, at projection time, per field — never at query
   time.** CD-2's own rule: *"Reconciliation is per-field precedence at projection time,
   not a two-store merge at query time."* A read path (the API, the realtime hub, the
   webhook sink) never has to decide "hook value or JSONL value?" — the projection already
   decided, deterministically, and wrote one row. Full precedence rules (which source wins
   per field, and why) are the subject of
   [ingest & reconciliation](../architecture/ingest-reconciliation.md), not this page.
2. **Replay is the correctness contract, not an optimization.** Because `events →
   sessions/agents/orchestration_edges/token_usage` is a pure function of the immutable
   log, `WP-IN10`'s acceptance test is that double-replay produces a **byte-identical**
   projected database, and a kill-and-restart mid-session must reconstruct identical
   state with zero loss (`concept-analysis-v2` §6). This is also why the schema below
   never lets a projection table's write path be the row of record — `events_raw` is.

## `events_raw` — the append-only substrate

Both ingestion sources — the hook receiver and the JSONL tail-follower — write every
fact they see into this one table before anything is interpreted (DESIGN §3; CD-2). It
must accept **any** `event_type`, including ones the system has never seen, so a new or
unrecognized Claude Code hook is preserved rather than dropped or crashing the ingest
path (`WP-IN3`: *"accept-any-event... Never-seen `event_type` → 202 + a row lands
(audit-preserving)"*).

```sql
-- WAL mode + FK enforcement asserted on every connection open (WP-D2; DESIGN §8)
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE events_raw (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  idempotency_key TEXT NOT NULL UNIQUE,   -- byte-identical for the same fact seen twice
                                           -- (once via hook, once via JSONL) — WP-IN1
  source          TEXT NOT NULL CHECK(source IN ('hook','jsonl')),
  event_type      TEXT NOT NULL,          -- unconstrained: accept-any-event, WP-IN3
  seq             INTEGER NOT NULL,       -- monotonic sequence for readSince() — WP-IN2
  payload         TEXT NOT NULL,          -- raw JSON, verbatim, pre-redaction boundary
  received_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- Append-only enforcement: WP-D4 explicitly owns "the table, triggers and
-- append/getRaw repository" (development-plan.md §2, merge #2).
CREATE TRIGGER events_raw_no_update
BEFORE UPDATE ON events_raw
BEGIN
  SELECT RAISE(ABORT, 'events_raw is append-only: UPDATE forbidden');
END;

CREATE TRIGGER events_raw_no_delete
BEFORE DELETE ON events_raw
BEGIN
  SELECT RAISE(ABORT, 'events_raw is append-only: DELETE forbidden');
END;
```

Rationale, per column/constraint:

- **`idempotency_key UNIQUE`** — the cross-source contract from `WP-IN1`: a hook payload
  and the JSONL line describing the *same* underlying fact must hash to the same key, so
  `EventStore.append` (`WP-IN2`) collapses a duplicate to exactly one row instead of
  double-counting.
- **`source` + `event_type` unconstrained beyond the two-value source check** — the table
  is deliberately schema-loose on `event_type` so an unverified or future hook (the hook
  catalog itself is only confirmed/denied by the Phase-0 probe, `WP-S4`) is still captured
  as evidence, never silently discarded.
- **`seq`** — gives `EventStore`'s `readSince` a stable resumption point for the realtime
  hub and for replay-on-startup (`WP-IN2`, `WP-IN10`).
- **No UPDATE/DELETE path, enforced by triggers, not just convention** — this is a
  concept-analysis-v2 §6 acceptance criterion in its own right: *"`events_raw` exposes no
  UPDATE/DELETE path (enforced by test)."*
- **Redaction happens at the ingest boundary, before the row exists** (`WP-D10` owns the
  redactor; `WP-IN14` invokes it at write time), not as a later mutation of an already
  written row — that is how payload redaction (CD-10) coexists with the append-only
  invariant above without ever violating it.

> **Open tension in the sources, not resolved here.** `WP-D10` also names a "retention TTL
> sweeper," and CD-10 requires "retention TTL... from Phase 1." Neither DESIGN.md nor
> `development-plan.md` states how a TTL sweeper's eventual row removal is reconciled with
> the same table's "no UPDATE/DELETE path (enforced by test)" acceptance criterion — e.g.
> whether the sweeper targets only the normalized/projected layer, uses an archive-and-
> truncate strategy, or is a documented, narrowly-scoped exception to the trigger above.
> Tracked as an open issue.

## `events` — normalized, queryable

The pure `Normalizer` (`WP-IN6`) turns each `events_raw` row into a typed, queryable
`events` row. Determinism is the acceptance bar: *"Identical input → identical output"*
(`WP-IN6`).

```sql
CREATE TABLE events (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  raw_event_id  INTEGER NOT NULL REFERENCES events_raw(id),  -- FK enforced, WP-D5
  event_type    TEXT NOT NULL,
  session_id    TEXT,
  agent_id      TEXT,
  occurred_at   TEXT NOT NULL,
  schema_version TEXT NOT NULL   -- normalizer keys off event type + schema_version only
);
```

- **`raw_event_id` FK, explicitly required** — `WP-D5`'s done-when is literally
  *"`events.raw_event_id` FK enforced."* Every normalized row traces back to the exact raw
  fact it was derived from; there is no normalized row without a raw one.
  `orchestration_edges` reuses this same provenance idea via its own
  `derived_from_event_id` (below).
- **`session_id` / `agent_id` nullable** — normalization is a per-event operation; not
  every raw event resolves to a known agent immediately (see `token_usage.agent_id`,
  which is nullable for the identical reason under CD-3).

## `sessions`

`WP-D6` groups `sessions` and `agents` as the two self-contained "projection tables" of
the hierarchy layer, but only `agents`' DDL is fixed by the design basis (below). The
column-level shape of `sessions` beyond "one row per Claude Code session, with a lifecycle
bounded by `SessionStart`/`SessionEnd`" (DESIGN §5) is not yet specified in the source
documents — tracked as an open issue for `WP-D6`.

## `agents` — the self-referential subagent tree

This is the one table whose DDL is fixed by the design basis and must be reproduced
verbatim (DESIGN §4):

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

This is the invariant the whole project is built to protect: *"Agents & subagents are
first-class, queryable, persisted entities — the subagent tree is a data fact, not a
client-side UI reconstruction from a flat event log"* (DESIGN §3). `ON DELETE SET NULL` on
the self-reference is what `WP-D6` calls "orphan-safe": removing a parent row never
cascades into deleting its subtree, it just detaches it.

> **Schema/roadmap mismatch, flagged not silently resolved.** The `status` `CHECK`
> constraint above allows only `working`, `waiting`, `completed`, `error` — it has no
> `unknown` value. But the missing-`SubagentStop` watchdog rule that `WP-IN12` implements
> and `concept-analysis-v2` §6 requires as an acceptance criterion states: *"A missing
> `SubagentStop` → explicit 'unknown' state within the watchdog window, never a permanent
> 'working'."* As written, the verbatim DESIGN §4 DDL cannot represent that state. This
> table's `CHECK` constraint will need `'unknown'` added before `WP-D6`/`WP-IN12` land;
> until then this is a genuine open gap between the fixed DDL and the later, more detailed
> acceptance criteria — not something this page invents a fix for. See
> [troubleshooting](../operations/troubleshooting.md) for the watchdog itself.

## `orchestration_edges` — the persisted DAG (the moat artifact)

This table is the concrete artifact behind the project's central differentiator (DESIGN
§2.1): *"Global, persistent, per-instance orchestration DAG... A real, queryable,
cross-session per-instance graph is unclaimed ground."* DESIGN §4 states the extension
requirement precisely: edges "must be persisted (not event-derived at render time) and
per-instance (not type-aggregated), and carry an instance/host key for future fleet
aggregation." CD-4 pins the column set: *"self-ref `parent_agent_id`, `instance`/
`host_id`, `derived_from_event_id`, idempotent."*

```sql
CREATE TABLE orchestration_edges (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  parent_agent_id    TEXT NOT NULL REFERENCES agents(id),
  child_agent_id     TEXT NOT NULL REFERENCES agents(id),
  instance           TEXT NOT NULL,   -- which Claude Code process/instance produced this
  host_id            TEXT NOT NULL,   -- which machine — the fleet-aggregation hedge
  derived_from_event_id INTEGER NOT NULL REFERENCES events(id),
  created_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE(parent_agent_id, child_agent_id, instance)   -- idempotent: dup edge -> 1 row
);
```

Rationale:

- **`UNIQUE(parent_agent_id, child_agent_id, instance)` + `INSERT OR IGNORE`** — the exact
  acceptance test from `WP-D7`: *"Duplicate logical edge → exactly one row (UNIQUE +
  INSERT OR IGNORE)."* This is what lets dual-path derivation (below) write the same
  logical edge twice without corrupting the count.
- **`instance` / `host_id`, both `NOT NULL`** — `WP-D7`'s own done-when: *"Non-null
  `instance`/`host_id`."* This is the near-zero-cost hedge for cross-machine fleet
  aggregation (DESIGN §2.4, §9 Phase 5+) — the column exists today even though fleet
  aggregation itself is out of MVP scope (CD-10).
- **`derived_from_event_id`** — traceability back to the normalized event that produced
  the edge, mirroring `events.raw_event_id`'s provenance chain one layer up.
- **Dual-path derivation** (`WP-IN8`): the edge can be derived either from a
  `SubagentStart`/`SubagentStop` hook pair *or* from the JSONL `Agent`/`Workflow`
  spawn-tool chain — the general-purpose `Agent` tool (flat
  `subagents/agent-<hex>.jsonl`) and the `Workflow` tool (nested
  `subagents/workflows/wf_<id>/`), **not** a `Task` tool — and must produce the
  **correct** parent→child edge from the JSONL path alone *even if `SubagentStart` never
  fires* (the hook's presence in the actual twelve-event catalog is itself unverified
  pending the Phase-0 probe, `WP-S4`). The JSONL path therefore branches on directory
  shape, joining flat edges by `meta.toolUseId == the Agent tool_use.id` (and
  `filename hex == toolUseResult.agentId`) and nested edges by `wf_<id>/` containment.
  Because both paths write into the same idempotent table, whichever path fires first
  (or both) yields one row, not two.
- **Why this table exists separately from `agents.parent_agent_id`.** The self-reference
  on `agents` already records an agent's own immediate parent, but `orchestration_edges`
  is what every tree and DAG *view* actually queries — including the **session-scoped**
  tree, not only the global one: `WP-U3`'s done-when for `GET /sessions/:id/tree` is
  *"built from a query over `orchestration_edges` (proven, not reconstruction)."*
  `orchestration_edges` is the single source of truth for all tree/DAG rendering because
  it, and not the bare self-reference, carries the provenance (`derived_from_event_id`),
  the per-instance/host key, and the idempotent dedupe across two derivation paths that a
  plain parent pointer cannot.

> **Empirically confirmed by the desktop probe.** The 2026-07-04 read-only corpus probe
> ([`phase0-probe.md`](../../analysis/phase0-probe.md)) found **zero** `Task` tool blocks
> across the real `~/.claude/projects/` tree (`Agent` = 142, `Workflow` = 29) — a
> `Task`-keyed reader would reconstruct an **empty** DAG. It also confirmed the two
> layouts coexist within the same Claude Code versions and are driven by the spawn
> mechanism (`Agent` → flat, `Workflow` → nested), so the derivation must branch on
> directory shape, not version. This pre-answers CD-1 as `CONDITIONAL-GO` → build
> (confidence 85); the formal Phase-0 spike (`WP-S1`/`WP-S5`, `WP-S7` GO gate) still
> confirms it on the paired-capture corpus before any production code.

Full derivation and rebuild-from-JSONL-alone guarantees belong to
[the DAG moat](../architecture/dag-moat.md); this page stops at the schema and its
constraints.

## `token_usage` — fine-grained cost buckets

DESIGN §4 (the `hoangsonww` graft) states the bucketing directly: *"`token_usage` bucketed
by `speed` / `inference_geo` / `service_tier` (each changes the per-token rate), preserving
compaction baselines so historical totals still price correctly after a context
rewrite."* CD-3 adds the nullability/backfill rule: *"`token_usage.agent_id` is nullable
at first write, deterministically backfilled once the agent is known."*

```sql
CREATE TABLE token_usage (
  id                       INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id               TEXT NOT NULL,
  agent_id                 TEXT REFERENCES agents(id),   -- nullable at first write (CD-3)
  source_event_id          INTEGER NOT NULL REFERENCES events(id),
  model                    TEXT NOT NULL,
  service_tier             TEXT NOT NULL,   -- bucket dimension, DESIGN §4
  speed                    TEXT NOT NULL,   -- bucket dimension, DESIGN §4
  inference_geo            TEXT NOT NULL,   -- bucket dimension, DESIGN §4
  is_precompact_baseline   INTEGER NOT NULL DEFAULT 0,  -- see rationale below
  input_tokens             INTEGER NOT NULL,   -- ground truth, verbatim from JSONL
  output_tokens            INTEGER NOT NULL,
  cache_creation_tokens    INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens        INTEGER NOT NULL DEFAULT 0,
  recorded_at              TEXT NOT NULL
);
```

Rationale:

- **Three bucket columns, each `NOT NULL`** — `service_tier`, `speed`, `inference_geo` are
  named explicitly in DESIGN §4 and repeated in CD-4 as the fine-grained dimensions that
  each independently change the per-token rate; they must all be present on every row so
  `PricingProvider` (`WP-C2`) can resolve the correct dated rate.
- **`agent_id` nullable, `WP-D8`'s explicit done-when**: *"Backfill deterministic, no
  double-count/misattribution."* A token-usage record can be written before its owning
  agent is projected, then attributed later — the reconciliation test proves that backfill
  never double-counts or misattributes.
- **Token count columns (`input_tokens`, etc.) are illustrative naming**, not literal
  source text — the sources establish that raw usage counts are copied verbatim from the
  JSONL (ground-truth tokens, never inferred) and that `WP-S6`'s reconciliation probe
  proves "Σ per-record token usage == the session's JSONL ground-truth total exactly," but
  they do not fix a column-name list. Flagged as an open issue.
- **`is_precompact_baseline`** — represents the "preserving compaction baselines" language
  in DESIGN §4 and the `WP-C4` acceptance test: *"A `PreCompact` session reprices to
  baseline + post-compaction spend, matching the oracle."* The exact mechanism (a boolean
  marker row vs. a separate baseline table vs. a `baseline_of` self-reference) is not
  specified in the sources; the column here is a representative placeholder for that
  requirement, not a literal name from any source document. `WP-S6` additionally requires
  the Phase-0 corpus to "capture the PreCompact baseline" as empirical validation before
  this lands.

Full cost mechanics — dated-price resolution, delegation-savings, and PreCompact
repricing — belong to [the cost model](../architecture/cost-model.md).

## `model_pricing` — versioned rates

CD-4: *"versioned `model_pricing` (`effective_from`, `verified_on`)."* `WP-C1` adds the
concurrency shape: *"Multiple `effective_from` rows per bucket without conflict."*

```sql
CREATE TABLE model_pricing (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  model           TEXT NOT NULL,
  service_tier    TEXT NOT NULL,
  speed           TEXT NOT NULL,
  inference_geo   TEXT NOT NULL,
  -- one rate per token kind; exact column names/units are illustrative, pending WP-C1
  price_input_per_mtok        REAL NOT NULL,
  price_output_per_mtok       REAL NOT NULL,
  price_cache_write_per_mtok  REAL NOT NULL,
  price_cache_read_per_mtok   REAL NOT NULL,
  effective_from  TEXT NOT NULL,   -- CD-4, literal field name
  verified_on     TEXT NOT NULL,   -- CD-4, literal field name
  UNIQUE(model, service_tier, speed, inference_geo, effective_from)
);
```

- **`effective_from` / `verified_on`** are literal field names from CD-4 — the only two
  column names in this table sourced verbatim. `effective_from` is what lets a
  dated-price resolver (`WP-C2`) pick the rate that was live at a given event's timestamp
  ("the OLD rate before a change, the new rate at/after"); the `UNIQUE` constraint allows
  a second row with a later `effective_from` for the same bucket without conflicting,
  satisfying `WP-C1`'s done-when.
- **The staleness gate** (`WP-C6`): a model+bucket combination observed in the golden
  fixture corpus with no matching priced row **fails CI** — silent staleness is a red
  build, not a runtime "estimated" label (`concept-analysis-v2` §3, cost-trust chain).
- Rate columns (`price_input_per_mtok`, etc.) are a representative shape only — DESIGN §4
  and CD-4 establish *that* pricing is per-bucket and dated, not the literal per-token-kind
  column list. Flagged as an open issue.

## Alert & webhook tables (Phase 5, not yet built)

DESIGN §4 names these four tables as a graft from `hoangsonww`, already fully modeled
there: *"`alert_rules` + `alert_events` + `webhook_targets` + `webhook_deliveries` —
outbound HTTP delivery already modelled; the natural Telegram integration point."*
`WP-A2` owns their migration: *"Alert & webhook schema migration (clean-room-safe,
hoangsonww-attributed). Forward-only, idempotent."*

```sql
CREATE TABLE alert_rules (
  id          TEXT PRIMARY KEY,
  kind        TEXT NOT NULL CHECK(kind IN ('cost_threshold','stuck_agent','error')),
  config      TEXT NOT NULL,   -- JSON: e.g. {"threshold_usd": 5.00}
  enabled     INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT NOT NULL
);

CREATE TABLE alert_events (
  id           TEXT PRIMARY KEY,
  rule_id      TEXT NOT NULL REFERENCES alert_rules(id),
  session_id   TEXT,
  agent_id     TEXT,
  fired_at     TEXT NOT NULL,
  dedupe_key   TEXT NOT NULL   -- rate-limit/dedupe boundary, WP-A7
);

CREATE TABLE webhook_targets (
  id          TEXT PRIMARY KEY,
  kind        TEXT NOT NULL CHECK(kind IN ('telegram')),
  token_ref   TEXT NOT NULL,   -- NEVER the secret itself — see below
  enabled     INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE webhook_deliveries (
  id               TEXT PRIMARY KEY,
  target_id        TEXT NOT NULL REFERENCES webhook_targets(id),
  alert_event_id   TEXT NOT NULL REFERENCES alert_events(id),
  status           TEXT NOT NULL CHECK(status IN ('pending','sent','failed')),
  attempt_count    INTEGER NOT NULL DEFAULT 0,
  next_retry_at    TEXT,
  delivered_at     TEXT
);
```

Rationale:

- **`alert_rules.kind`** covers the three rule kinds `WP-A5` implements: *"cost threshold,
  stuck agent, error"*; the `cost_threshold` boundary is tested to fire "exactly at the
  operator limit."
- **`webhook_targets.token_ref`, never a raw secret column** — this is a hard security
  invariant, not a stylistic choice: CD-10 states the Telegram token is held *"via
  `token_ref` → launchd env / chmod-600 (never in SQLite, never to the browser)"*, and
  `WP-A3` owns the resolver plus a static gate ("a >0600 dotfile is rejected"). `WP-A9`'s
  alerts UI accordingly shows "`token_ref` name only, never the secret." No column in this
  schema ever holds the actual bot token.
- **`webhook_deliveries.attempt_count` / `next_retry_at`** — `WP-A7`'s retry/backoff +
  dedupe/rate-limit requirement: *"A real condition → exactly one throttled
  notification."*
- **No-SSRF invariant** — `WP-A4`'s dispatcher only ever sends to an operator-configured
  row in `webhook_targets`; no code path constructs a delivery target from an inbound
  event payload. See [security model](../security/model.md).

These four tables are **designed, not implemented** — Phase 5–6 in
[`development-plan.md`](../../analysis/development-plan.md) (Track A, `WP-A1`…`WP-A10`),
well behind Phase 1's storage/foundation work. Nothing above should be read as an
in-repo migration.

## What's decided vs. open

| Aspect | Status |
|---|---|
| `agents` DDL | **Fixed**, verbatim, DESIGN §4 |
| `events_raw` / `events` split, append-only enforcement, idempotency key | Decided (CD-2, CD-4); DDL here is a reference synthesis pending `WP-D4`/`WP-D5` |
| `orchestration_edges` column set (`parent_agent_id`, `instance`/`host_id`, `derived_from_event_id`, idempotent) | Decided (CD-4, `WP-D7`); exact FK/child-column naming is a synthesis |
| `token_usage` bucket dimensions + compaction baseline + nullable `agent_id` | Decided (DESIGN §4, CD-3/CD-4); raw token-count column names are illustrative |
| `model_pricing` versioning (`effective_from`, `verified_on`) | Decided (CD-4); rate-column shape is illustrative |
| Alert/webhook table set (`alert_rules`, `alert_events`, `webhook_targets`, `webhook_deliveries`) | Decided at the table level (DESIGN §4, `WP-A2`); column-level DDL is a synthesis; not scheduled before Phase 5 |
| `sessions` column set | **Open** — not specified beyond "one row per session" (`WP-D6`) |
| `agents.status` missing `'unknown'` vs. the watchdog requirement | **Open gap**, flagged above |
| Retention TTL sweeper vs. `events_raw`'s no-DELETE invariant | **Open tension**, flagged above |
| MVP schema scope (which tables land in the first cut) | **Open decision** — DESIGN §10 notes `agents`/`sessions`/`events` + `token_usage` as the core, alert/webhook following later; see [roadmap](../guide/roadmap.md) |
| `projects` / `filters` (named in DESIGN §4's `simple10` base schema) | **Open gap** — no owning work package, no column-level shape in any source; not modeled in this inventory, flagged above |

## See also

- [Architecture overview](../architecture/overview.md) — the end-to-end ingest loop this
  schema sits inside.
- [Hook ingestion](../architecture/hooks.md) — the twelve lifecycle events that populate
  `events_raw`.
- [Ingest & reconciliation](../architecture/ingest-reconciliation.md) — the CD-1
  JSONL-vs-hooks primacy decision and the per-field precedence rules at projection time.
- [The DAG moat](../architecture/dag-moat.md) — dual-path edge derivation and
  rebuild-from-JSONL-alone in depth.
- [Cost model](../architecture/cost-model.md) — dated pricing resolution, compaction
  repricing, and delegation-savings built on `token_usage` and `model_pricing`.
- [Glossary](../architecture/glossary.md) — term and status-value reference.
- [Security model](../security/model.md) — why `webhook_targets.token_ref` never holds a
  secret, and the no-SSRF dispatcher rule.
- [Backup & restore](../operations/backup-restore.md) — WAL mode and the tested-restore
  routine this schema runs under.
- [Roadmap](../guide/roadmap.md) — where each table lands, phase by phase.
- [Decisions (ADRs)](../contributing/decisions/README.md) — CD-2, CD-3, CD-4 as recorded
  decisions.
