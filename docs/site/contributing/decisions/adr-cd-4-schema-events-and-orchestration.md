# ADR-0006: CD-4 — Schema: events_raw/events, orchestration_edges, token_usage, model_pricing

- **Status:** accepted (exact DDL is a Track D implementation deliverable, not yet written —
  see Consequences → Follow-ups)
- **Date:** 2026-07-03
- **Deciders:** Ivan Baev (project owner), via the six-lens concept-analysis-v2 workflow
- **Source:** [`concept-analysis-v2.md` §3, row CD-4](../../../analysis/concept-analysis-v2.md#3-canonical-decision-register-v2)
  (consolidates AD4, G-D6, SD5); [`docs/ai/DESIGN.md` §4](../../../ai/DESIGN.md)

## Context

CD-2 (ADR-0004) establishes *that* there is a single immutable substrate with a projection over
it; CD-4 is the schema-shape decision for what that substrate and projection actually contain.
It grafts the two genuinely superior schema pieces the audit found in the rival projects onto
`simple10`'s clean normalized base (`docs/ai/DESIGN.md` §4): `hoangsonww`'s fine-grained,
bucketed `token_usage` with a compaction baseline, and EXPANDED's `events_raw`/`events` split
(the one schema improvement concept-analysis-v2 explicitly adopts from that external report).

## Decision

- **`events_raw`** (immutable) + **`events`** (normalized) — the reconciliation substrate both
  ingest sources write into (ADR-0004, CD-2).
- Persisted **`orchestration_edges`** — self-referential `parent_agent_id`, an `instance`/
  `host_id` key, `derived_from_event_id`, and idempotent (duplicate logical edge → one row).
- Fine-grained **`token_usage`** — bucketed by `service_tier` / `speed` / `inference_geo`, and
  preserving a **compaction baseline** so historical totals still price correctly after a
  context rewrite.
- **Versioned `model_pricing`** — `effective_from` / `verified_on` columns, so a priced model
  has a dated, auditable rate rather than a single hard-coded number.

The already-specified self-referential agent hierarchy, verbatim from `docs/ai/DESIGN.md` §4:

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

The remaining tables are **not yet fully specified as DDL** anywhere in the source material —
only their required columns and invariants are decided. The sketch below names only the
columns the sources actually commit to; the full column set is deliberately left to the Track D
work packages named in Follow-ups:

```sql
-- events_raw: append-only substrate (CD-2). No UPDATE/DELETE path (CD-7, enforced by test).
CREATE TABLE events_raw (
  id          TEXT PRIMARY KEY,   -- stable event id / idempotency key (CD-1, CD-2)
  source      TEXT NOT NULL,      -- 'hook' | 'jsonl' — input to CD-3 precedence
  received_at TEXT NOT NULL,
  payload     TEXT NOT NULL       -- raw JSON, redacted at ingest (CD-10)
  -- full column set: development-plan.md WP-D4
);

-- events: normalized/queryable projection input (CD-2).
CREATE TABLE events (
  id             TEXT PRIMARY KEY,
  raw_event_id   TEXT NOT NULL REFERENCES events_raw(id),
  event_type     TEXT NOT NULL,   -- accept-any-event; unknown types are stored, never crash
  schema_version TEXT NOT NULL
  -- full column set: development-plan.md WP-D5
);

-- orchestration_edges: the persisted moat artifact (CD-4; docs/ai/DESIGN.md §4).
CREATE TABLE orchestration_edges (
  id                    TEXT PRIMARY KEY,
  parent_agent_id       TEXT NOT NULL,  -- self-ref: builds the subagent tree
  child_agent_id        TEXT NOT NULL,
  instance              TEXT NOT NULL,  -- non-null on every row (§6 acceptance)
  host_id               TEXT NOT NULL,  -- non-null on every row (§6 acceptance)
  derived_from_event_id TEXT NOT NULL,  -- idempotent: duplicate logical edge -> one row
  UNIQUE (parent_agent_id, child_agent_id, instance)
  -- full column set: development-plan.md WP-D7
);

-- token_usage: fine-grained, ground-truth costing (CD-3, CD-4).
CREATE TABLE token_usage (
  id                  TEXT PRIMARY KEY,
  agent_id            TEXT,          -- nullable at first write, backfilled (CD-3)
  service_tier        TEXT NOT NULL,
  speed               TEXT NOT NULL,
  inference_geo       TEXT NOT NULL,
  compaction_baseline TEXT           -- preserves repriceability across PreCompact
  -- full column set: development-plan.md WP-D8
);

-- model_pricing: versioned, dated (CD-4; the cost-trust chain, H-COST).
CREATE TABLE model_pricing (
  model          TEXT NOT NULL,
  effective_from TEXT NOT NULL,
  verified_on    TEXT NOT NULL,
  PRIMARY KEY (model, effective_from)
  -- full column set: development-plan.md WP-C1
);
```

## Acceptance criteria

From `concept-analysis-v2.md` §6 ("Data foundation & reconciliation" and "Cost") and the CD-3/CD-4
crosscut ("Cost-trust chain"):

- `orchestration_edges` is persisted; the global/cross-session DAG is served **by querying the
  table**, never render-time reconstruction. Every row carries a non-null `instance`/`host_id`.
- `events_raw` exposes **no UPDATE/DELETE path** (enforced by test).
- A session that hit PreCompact still reprices correctly against its preserved
  `compaction_baseline`.
- A fixture model with **no price** row **FAILS CI**; `model_pricing` is versioned
  (`effective_from`/`verified_on`).
- **Cost-trust chain:** every displayed dollar traces to *(ground-truth tokens × a dated,
  priced model)* — a model observed in fixtures with no price row is a **red build**, not a
  runtime "estimated" label.

## Consequences

- **Positive:** one schema simultaneously serves reconciliation (ADR-0004/0005), the persistent
  DAG moat, and the cost-trust chain — there is no separate "reporting schema" bolted on later.
- **Negative / costs:** the substrate now carries two logs (`events_raw` + `events`) plus three
  projection tables (`sessions`/`agents` are implied by `docs/ai/DESIGN.md` §4,
  `orchestration_edges`, `token_usage`) plus `model_pricing` — more migration surface for a solo
  owner to keep in a single, always-forward-only migration chain.
- **Follow-ups:** `development-plan.md` Track D (`WP-D4`…`WP-D8`) implements the exact DDL;
  `WP-C1` seeds `model_pricing`; `WP-C6` is the staleness-fails-CI gate. See
  [the data model](../../architecture/data-model.md) and
  [the DAG moat](../../architecture/dag-moat.md).

## Alternatives considered

- **A single flat `events` table** (v1's implicit design) — rejected; this was the exact
  reconciliation gap v1 left open (`concept-analysis-v2.md` §8).
- **Type-aggregated edges** (`hoangsonww`'s `OrchestrationDAG.tsx` pattern) — rejected: that
  design is a 3–4 layer type-aggregated diagram, not a true per-instance persisted graph
  (`docs/ai/DESIGN.md` §6); it does not satisfy the "queried from the table, never render-time
  reconstructed" requirement.
