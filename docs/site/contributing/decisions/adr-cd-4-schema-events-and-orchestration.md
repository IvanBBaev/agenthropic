# ADR-0006: CD-4 — Schema: events_raw/events, orchestration_edges, token_usage, model_pricing

- **Status:** accepted — ~~exact DDL is a Track D implementation deliverable, not yet written~~
  *(DDL written and shipped 2026-07; `apps/server/src/db/migrations.ts`)*; **amended in detail
  2026-07-30** — all tables exist and are written, with named column-level divergences from the
  sketch below (see the as-built update); **amended again 2026-08-15** — the chain has grown from
  seven migrations to thirteen and the `orchestration_edges.source` domain has a fifth value
- **Date:** 2026-07-03
- **Deciders:** Ivan Baev (project owner), via the six-lens concept-analysis-v2 workflow
- **Source:** [`concept-analysis-v2.md` §3, row CD-4](../../../analysis/concept-analysis-v2.md#3-canonical-decision-register-v2)
  (consolidates AD4, G-D6, SD5); `docs/ai/DESIGN.md` §4

## As-built update — 2026-07-30

**Verdict: holds in substance, amended in detail.** Every table this ADR names
exists and is written to, and every acceptance criterion below that could be tested
is tested. The sketched DDL was explicitly labelled "not yet fully specified"; the
real DDL (`apps/server/src/db/migrations.ts`, seven forward-only migrations) differs
from the sketch in ways worth recording, because two of the differences change what
a column *means*.

**`events` is now genuinely written, not just created.** This is worth stating
because for a period it was not: the table was created by its migration and nothing
ever inserted into it — a lie by omission in a shipped schema. As built, a hook
delivery writes **both** rows in one transaction: the raw envelope into `events_raw`,
and an **identifier-only** normalized row into `events` (`raw_event_id`,
`session_id`, `agent_id`, `event_type`, `occurred_at`). No payload content is ever
projected into `events` — the normalized row carries identifiers and a type, nothing
else. There is no `schema_version` column on `events`; schema versioning lives in the
migration runner's own `schema_version` table instead.

**`occurred_at` is receipt time, not event time.** The dashboard records when the
hook was *received*, because a hook payload does not carry a trustworthy occurrence
timestamp. Rather than let that ambiguity ride, every timeline DTO row declares
`occurredAtSource: 'receipt'` explicitly, so no consumer can mistake one for the
other. This is a deliberate honesty affordance, not a placeholder.

**Where the as-built DDL differs from the sketch below:**

| Sketch | As built | Why it matters |
|---|---|---|
| `token_usage.service_tier` / `speed` / `inference_geo` | a single `bucket` column, `CHECK (bucket IN ('input','output','cache_read','cache_write_5m','cache_write_1h'))`, with `UNIQUE (message_id, bucket)` | The five priced buckets are what the corpus actually distinguishes (parser-spec §5.4). The UNIQUE key is load-bearing: naive row summation over-counts by ≈2.4× (parser-spec §5.2). |
| `token_usage.compaction_baseline TEXT` | `is_compaction_baseline INTEGER NOT NULL DEFAULT 0` | Same guarantee (a compacted session still reprices), expressed as a flag on the row rather than a separate reference. |
| `model_pricing (model, effective_from, verified_on)` | `model_pricing (model, bucket, usd_per_mtok, effective_from)`, PK `(model, bucket, effective_from)` | **There is no `verified_on` column.** Pricing is versioned by `effective_from` only, and is bucket-aware (a cache-read token is not priced like an input token). The auditability the sketch wanted from `verified_on` is not in the schema. |
| `orchestration_edges.derived_from_event_id NOT NULL`, `UNIQUE (parent, child, instance)` | `source TEXT CHECK (source IN ('tool_use','directory','task_notification','queue_operation'))`, `UNIQUE (session_id, parent_agent_id, child_agent_id)` | Edges derive from parsed JSONL, not from an `events_raw` row (see [ADR-0004](adr-cd-2-immutable-substrate-projection.md)'s as-built update), so `derived_from_event_id` had nothing to point at. `source` records *which of the four detection mechanisms* found the edge — strictly more useful for auditing the DAG than a raw-row pointer would have been. `instance` and `host_id` are still `NOT NULL` on every row, as §6 requires. |
| `agents.status IN ('working','waiting','completed','error')` | the same four plus `'unknown'` | The corpus contains agents whose terminal state is genuinely not determinable. `'unknown'` is preferred over silently defaulting one of the other four. |

**On "a fixture model with no price row FAILS CI":** the mechanism shipped as a
*hard runtime halt* rather than a separate CI gate — `computeCostUsd` throws
`PricingError` on an unknown model id or a missing bucket price, refusing to price
at $0, and that halt is exercised by tests that run in CI. The cost-trust chain
holds; the enforcement point moved from a dedicated staleness gate (`WP-C6`, not
built) into the pricing function itself.

**The seeded prices are PROVISIONAL.** `model_pricing` is seeded with approximate
list prices, labelled in the migration as "a mechanism proof for the cost engine,
NOT a billing source," awaiting ratification. The *mechanism* is verified; the
*numbers* are not.

## As-built update — 2026-08-15

**Verdict: holds; the detail above needs two corrections.** Nothing in the decision
has been contradicted since 2026-07-30, but two of the facts recorded in that
section are now out of date, and one of the six new migrations records a process
failure that this ADR's Consequences section explicitly worried about.

**The chain is thirteen migrations, not seven.** The six added since are
`token-usage-main-agent-attribution` (8), `ingest-checkpoints` (9),
`retention-scan-indexes` (10), `model-pricing-seed-convergence` (11),
`orchestration-edge-endpoint-indexes` (12) and
`orchestration-edges-legacy-explore-source` (13). Three of them (10, 12, and the
index half of 13) are pure read-path accelerators whose own comments state the
contract plainly — "a dropped index costs speed, never truth" — and change no
result. Migration 9 adds the replay-checkpoint table, which is likewise declared a
cache rather than a source of dashboard truth: dropping it costs one full replay and
changes no output. That distinction between tables that hold truth and tables that
hold work-already-done is worth preserving as the schema grows.

**`orchestration_edges.source` now admits five values, not four.** Migration 13
rebuilds the table (SQLite cannot `ALTER` a `CHECK`) to add `'legacy_explore'`
alongside the four structural detection paths. The divergence table above says
`source` records "which of the four detection mechanisms found the edge"; read that
as five. The reason the fifth value exists rather than being folded into `'tool_use'`
is the same provenance-honesty rule the column was created to serve: pre-2.1.71
bare-`Explore` sidecars are joined by a **name-based heuristic**, not by a structural
identifier, and an edge found that way is marked as such rather than disguised as one
that was. That heuristic remains **PROVISIONAL** — no real pre-2.1.71 transcript has
yet ratified it — and the distinct `source` value is precisely what makes it possible
to find and re-examine every edge that depended on it.

**Migration 11 is a corrective migration for a forward-only chain that was not
honoured.** Migration 7's pricing seed was edited **in place after it had already been
applied** to the operator's database. Because the runner skips by recorded id, that
database kept the original rows, and under the current code every real-model message
then failed the `PricingError` halt gate — the cost-trust chain worked exactly as
designed and turned a silent wrong number into a loud stop. Migration 11 converges
both histories to the same rows and leaves operator-authored pricing untouched. The
ADR's Consequences section named "a single, always-forward-only migration chain" as
the cost of this schema; this is the record of that cost being paid once, in the one
way it can be — by an additional forward migration, never by editing history.

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
