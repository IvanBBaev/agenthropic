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

> **Update — 2026-07 (as built).** The paragraph above described the pre-code state.
> Implementation began 2026-07-11, and the schema is now **real**: seven ordered, idempotent,
> in-code migrations in `apps/server/src/db/migrations.ts`, applied inside transactions and
> recorded in a `schema_version` table (running the runner twice applies nothing). The SQL
> blocks on this page have been replaced with the **actual migration DDL**; the original
> synthesized sketches are kept only where they document design rationale, clearly marked.
> Two structural differences from the design narrative matter throughout:
>
> - **`events_raw` receives hook events only.** JSONL is parsed by the pure parser
>   (`packages/core/src/parser`) and projected **directly** into
>   `sessions`/`agents`/`orchestration_edges`/`token_usage` in one transaction per session
>   (`apps/server/src/ingest/ingest-session.ts`) — the separate Normalizer/Projection stages
>   were never built. Hooks contribute **liveness only, never structure**.
> - **The alert/webhook tables do not exist.** Alerts are post-1.0, entered only via the
>   KC-5 gate (earned by real daily use) — no `alert_rules`, `alert_events`,
>   `webhook_targets`, or `webhook_deliveries` migration exists in the repository.

## Table inventory

| Table | Layer | Status | Purpose | Primary source |
|---|---|---|---|---|
| `events_raw` | Substrate | **Built** (migration 1) | Immutable, idempotency-keyed landing zone — as built, for **hook deliveries only** (JSONL never lands here) | CD-2, CD-4, `WP-D4` |
| `events` | Normalized | **Built** (migration 3) | As built: the **hook liveness timeline** — identifiers only, FK-linked to `events_raw`, written in the same transaction | CD-4, `WP-D5` |
| `sessions` | Projection | **Built** (migration 2) | One row per Claude Code session | `WP-D6` |
| `agents` | Projection | **Built** (migration 4) | Self-referential subagent tree — a data fact, not a UI reconstruction; as built the `status` CHECK carries **five** values incl. `'unknown'` | DESIGN §4, `WP-D6` |
| `orchestration_edges` | Projection (moat) | **Built** (migration 5) | Persisted, per-instance parent→child edges; the source every tree/DAG view queries; as built derived from JSONL via four join paths | DESIGN §4/§6, CD-4, `WP-D7`, `WP-IN8` |
| `token_usage` | Projection | **Built** (migration 6) | Ground-truth token rows — as built one row per `(message_id, bucket)` over five priced buckets, with compaction baselines | DESIGN §4, CD-3/CD-4, `WP-D8` |
| `model_pricing` | Reference | **Built** (migration 7, `PROVISIONAL` seed) | Versioned per-token rates, dated, per `(model, bucket)` | CD-4, `WP-C1` |
| `alert_rules` | Alerting (post-1.0, KC-5 gated) | Designed, **not built** | Operator-defined trigger conditions | DESIGN §4/§7, `WP-A2` |
| `alert_events` | Alerting (post-1.0, KC-5 gated) | Designed, **not built** | Fired-alert log | DESIGN §4/§7, `WP-A2` |
| `webhook_targets` | Alerting (post-1.0, KC-5 gated) | Designed, **not built** | Outbound delivery targets (Telegram, etc.), secret held by reference only | DESIGN §4/§7, `WP-A2`, `WP-A3` |
| `webhook_deliveries` | Alerting (post-1.0, KC-5 gated) | Designed, **not built** | Delivery attempts with retry/backoff | DESIGN §4/§7, `WP-A2`, `WP-A7` |

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

> **As built:** the diagram above is the design record. In the running system the JSONL leg
> **bypasses `events_raw` entirely**: the pure parser reconstructs the whole session from the
> transcript, cost is computed as a halt-gate, and one transaction writes
> `sessions`/`agents`/`orchestration_edges`/`token_usage` directly. `events_raw` → `events`
> exists exactly as drawn — but only for the **hook** leg, as a liveness timeline. Both
> consequences survive in different clothes: reconciliation is still decided at write time,
> never at query time (hooks simply never write structure at all), and replay is still the
> correctness contract — re-ingesting an unchanged corpus is provably a no-op because the
> parse is pure and every write is an upsert/`INSERT OR IGNORE` (the double-replay P0 test).
> For JSONL, the transcript file itself is the immutable row of record — Claude Code owns it,
> and the projections can always be rebuilt from it alone.

## `events_raw` — the append-only substrate

The design intent (DESIGN §3; CD-2) was that both ingestion sources write every fact they
see into this one table before anything is interpreted. **As built, only the hook receiver
does** — JSONL is projected directly (see the pipeline note above) — but the table's own
contract shipped intact. It accepts **any** `event_type`, including ones the system has
never seen, so a new or unrecognized Claude Code hook is preserved rather than dropped or
crashing the ingest path (`WP-IN3`: *"accept-any-event... Never-seen `event_type` → 202 + a
row lands (audit-preserving)"*).

The real DDL (migration 1, `events-raw-append-only`; WAL mode and FK enforcement are
asserted on every connection open by the WP-D2 connection module):

```sql
CREATE TABLE events_raw (
  id              INTEGER PRIMARY KEY,
  idempotency_key TEXT NOT NULL UNIQUE,
  source          TEXT NOT NULL CHECK (source IN ('hook','jsonl')),
  event_type      TEXT NOT NULL,
  payload         TEXT NOT NULL,
  received_at     TEXT NOT NULL
);
CREATE TRIGGER events_raw_no_update
BEFORE UPDATE ON events_raw
BEGIN
  SELECT RAISE(ABORT, 'events_raw is append-only');
END;
CREATE TRIGGER events_raw_no_delete
BEFORE DELETE ON events_raw
BEGIN
  SELECT RAISE(ABORT, 'events_raw is append-only');
END;
```

Rationale, per column/constraint — updated to the as-built facts:

- **`idempotency_key UNIQUE`** — as built this is a **hook-only** key: a deterministic
  `hook:`-prefixed SHA-256 over the canonicalized envelope (excluding `received_at`,
  computed after redaction). The append is `INSERT OR IGNORE`, so a duplicate or retried
  hook delivery lands exactly one row. The designed **cross-source** contract (`WP-IN1` —
  a hook and a JSONL line for the same fact hashing identically) was **never built**,
  because JSONL never writes here and there is no dual write to collapse.
- **`source` + `event_type` unconstrained beyond the two-value source check** — the table
  is deliberately schema-loose on `event_type` so an unverified or future hook is still
  captured as evidence, never silently discarded. The schema admits `'jsonl'` as a source
  value, but the running system never writes it.
- **No `seq` column** — the design sketch carried one for `readSince()` resumption; as
  built the store exposes `readAll()` only (ordered by rowid) and the SSE stream has no
  resume protocol, so no sequence column exists.
- **No UPDATE/DELETE path, enforced by triggers, not just convention** — shipped exactly
  as specified and test-proven, satisfying the concept-analysis-v2 §6 acceptance
  criterion: *"`events_raw` exposes no UPDATE/DELETE path (enforced by test)."*
- **Redaction happens at the ingest boundary, before the row exists** — built (`WP-IN14`):
  key-name matching plus credential-shape masking runs on the payload *before* the
  idempotency key is computed and before the row is written, so redaction never mutates an
  already written row and the append-only invariant is never violated.

> **Open tension in the sources, not resolved here.** `WP-D10` also names a "retention TTL
> sweeper," and CD-10 requires "retention TTL... from Phase 1." Neither DESIGN.md nor
> `development-plan.md` states how a TTL sweeper's eventual row removal is reconciled with
> the same table's "no UPDATE/DELETE path (enforced by test)" acceptance criterion — e.g.
> whether the sweeper targets only the normalized/projected layer, uses an archive-and-
> truncate strategy, or is a documented, narrowly-scoped exception to the trigger above.
> Tracked as an open issue. *(As built: still open — the retention TTL sweeper (`WP-D10`)
> has not been built, so the tension has not yet had to be resolved.)*

## `events` — the hook liveness timeline

The design called this the output of a pure `Normalizer` stage (`WP-IN6`). As built there
is no separate Normalizer — `events` is the **hook liveness projection** (`WP-D5`): when
(and only when) a hook envelope actually lands in `events_raw`, one normalized row is
written here **in the same transaction**, pointing back at the raw row. A duplicate
delivery inserts zero rows in *both* tables. Only identifiers are projected — never the
payload body — so no secrets and no free text leave `events_raw`.

The real DDL (migration 3, `events`):

```sql
CREATE TABLE events (
  id           INTEGER PRIMARY KEY,
  raw_event_id INTEGER NOT NULL REFERENCES events_raw(id),
  session_id   TEXT,
  agent_id     TEXT,
  event_type   TEXT,
  occurred_at  TEXT
);
CREATE INDEX idx_events_session_id ON events(session_id);
```

- **`raw_event_id` FK, explicitly required** — `WP-D5`'s done-when is literally
  *"`events.raw_event_id` FK enforced."* Every normalized row traces back to the exact raw
  fact it was derived from; there is no normalized row without a raw one.
- **`session_id` / `agent_id` nullable** — extraction is total and defensive: only a
  non-empty string id in the payload counts (`session_id`/`agent_id` win over the
  camelCase variants; numbers, booleans, and `''` are never coerced). An unextractable id
  honestly projects as `NULL` — the row belongs to no session timeline — while the raw
  payload stays queryable in `events_raw`.
- **`occurred_at` is receipt time.** Claude Code hook stdin carries no event-originated
  timestamp, so receipt time is the only honest time available; the read DTO surfaces
  this as `occurredAtSource: 'receipt'` so no consumer mistakes it for event time.
- **No `schema_version` column** — the design sketch carried one for the Normalizer's
  keying rule; with no Normalizer stage, none exists.
- **These rows are liveness signals only.** They are not the DAG, they never influence
  `agents`/`orchestration_edges`/`token_usage`, and the *absence* of events means nothing
  about whether an agent ran — hooks are a secondary best-effort channel; JSONL
  transcripts are ground truth. `GET /api/sessions/:id/events` serves this timeline (a
  known session with zero hook events is a `200` with an empty list, never a `404`).

## `sessions`

`WP-D6` groups `sessions` and `agents` as the two self-contained "projection tables" of
the hierarchy layer. The column-level shape was an open issue when this page was written;
it is now fixed by the real migration (migration 2, `sessions`):

```sql
CREATE TABLE sessions (
  id               TEXT PRIMARY KEY,
  project_slug     TEXT,
  started_at       TEXT,
  last_activity_at TEXT,
  status           TEXT
);
```

The primary key is the **session UUID, never the project slug** — the parser spec (§6.2)
requires that two concurrent sessions in the same project directory stay two distinct
roots. Rows are upserted whole by the per-session ingest transaction.

## `agents` — the self-referential subagent tree

The design basis fixed this table's DDL verbatim (DESIGN §4):

```sql
-- DESIGN §4 (the design-basis sketch, kept for the record):
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

The **real DDL** (migration 4, `agents-self-referential`) keeps that shape and extends it
in exactly the ways the later acceptance criteria demanded:

```sql
CREATE TABLE agents (
  id              TEXT PRIMARY KEY,
  session_id      TEXT NOT NULL REFERENCES sessions(id),
  type            TEXT CHECK (type IN ('main','subagent')),
  subagent_type   TEXT,
  status          TEXT CHECK (status IN ('working','waiting','completed','error','unknown')),
  parent_agent_id TEXT REFERENCES agents(id) ON DELETE SET NULL,
  first_seen_at   TEXT,
  last_seen_at    TEXT
);
CREATE INDEX idx_agents_parent_agent_id ON agents(parent_agent_id);
CREATE INDEX idx_agents_session_id ON agents(session_id);
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

> **Resolved as built:** exactly as predicted — migration 4 adds `'unknown'` to the
> `status` CHECK (five values), and the `WP-IN12` watchdog assigns it: a non-terminal agent
> not seen within the watchdog window flips to `unknown`, a visible real state, never a
> permanent `working`. The added `first_seen_at`/`last_seen_at` columns are the watchdog's
> staleness anchor. A later re-ingest upserts whatever status the JSONL evidence supports,
> so a stale `unknown` yields to the durable record.

## `orchestration_edges` — the persisted DAG (the moat artifact)

This table is the concrete artifact behind the project's central differentiator (DESIGN
§2.1): *"Global, persistent, per-instance orchestration DAG... A real, queryable,
cross-session per-instance graph is unclaimed ground."* DESIGN §4 states the extension
requirement precisely: edges "must be persisted (not event-derived at render time) and
per-instance (not type-aggregated), and carry an instance/host key for future fleet
aggregation." CD-4 pins the column set: *"self-ref `parent_agent_id`, `instance`/
`host_id`, `derived_from_event_id`, idempotent."*

The **real DDL** (migration 5, `orchestration-edges`):

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

Rationale — updated to the as-built facts:

- **`UNIQUE(session_id, parent_agent_id, child_agent_id)` + `INSERT OR IGNORE`** — the
  acceptance test from `WP-D7`: *"Duplicate logical edge → exactly one row."* The as-built
  logical key is session-scoped rather than instance-scoped (the design sketch had
  `UNIQUE(parent, child, instance)`); a re-ingested session rewrites the same edges as
  no-ops.
- **`instance` / `host_id`, both `NOT NULL`** — shipped exactly as designed: the
  near-zero-cost hedge for cross-machine fleet aggregation (DESIGN §2.4) exists on every
  row even though fleet aggregation itself is post-1.0.
- **`source` replaces `derived_from_event_id`.** The design sketch traced each edge to a
  normalized event; as built there is no JSONL `events` row to point at (JSONL bypasses
  `events_raw`), so provenance is carried by the `source` CHECK instead — it names which
  of the parser's **four structural join paths** produced the edge: `tool_use` (the
  `Agent`/`Workflow` `tool_use` id join), `directory` (nested `wf_<id>/` containment),
  `task_notification`, and `queue_operation`. Inferred and observed edges stay
  distinguishable in every consumer.
- **Derivation is JSONL-only** (`WP-IN8` as built): the designed second path — a
  `SubagentStart`/`SubagentStop` hook pair — was never built, and never could be:
  `SubagentStart` does not exist (Phase-0 `WP-S4` verified the real catalog), and hooks
  contribute liveness only, never structure. The parser keys on the `Agent`/`Workflow`
  spawn tools (**not** `Task`), branches on directory shape, and an orphan that no join
  path can place gets **no** edge — never a guessed one.
- **Why this table exists separately from `agents.parent_agent_id`.** The self-reference
  on `agents` already records an agent's own immediate parent, but `orchestration_edges`
  is what every tree and DAG *view* actually queries — including the **session-scoped**
  tree, not only the global one: `WP-U3`'s done-when for `GET /sessions/:id/tree` is
  *"built from a query over `orchestration_edges` (proven, not reconstruction)."*
  `orchestration_edges` is the single source of truth for all tree/DAG rendering because
  it, and not the bare self-reference, carries the provenance (the `source` join-path
  column), the per-instance/host key, and the idempotent dedupe that a plain parent
  pointer cannot. As built this holds: both the session tree and the global DAG endpoints
  query persisted edges, never a render-time reconstruction.

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

The **real DDL** (migration 6, `token-usage`) reshaped the bucketing after contact with
the real JSONL — the `speed`/`inference_geo`/`service_tier` dimensions do not appear in
Claude Code transcripts; what does is per-message `usage` with five priced token kinds:

```sql
CREATE TABLE token_usage (
  id                      INTEGER PRIMARY KEY,
  session_id              TEXT NOT NULL,
  agent_id                TEXT,
  message_id              TEXT NOT NULL,
  model                   TEXT NOT NULL,
  bucket                  TEXT NOT NULL CHECK (bucket IN ('input','output','cache_read','cache_write_5m','cache_write_1h')),
  tokens                  INTEGER NOT NULL,
  is_compaction_baseline  INTEGER NOT NULL DEFAULT 0,
  occurred_at             TEXT,
  UNIQUE (message_id, bucket)
);
CREATE INDEX idx_token_usage_session_id ON token_usage(session_id);
CREATE INDEX idx_token_usage_agent_id ON token_usage(agent_id);
```

Rationale — updated to the as-built facts:

- **Long format: one row per `(message_id, bucket)`** over the five priced buckets
  (`input`, `output`, `cache_read`, `cache_write_5m`, `cache_write_1h` — parser-spec
  §5.4). The `UNIQUE(message_id, bucket)` constraint is the storage-level dedup
  guarantee: the parser spec (§5.2) measured that naive row summation over-counts by
  roughly 2.4×, because the same `message_id` recurs across transcript lines — the
  constraint makes double-counting structurally impossible, not merely tested against.
- **The designed bucket dimensions were dropped, not renamed** — `service_tier`, `speed`,
  and `inference_geo` are simply not present in the real JSONL `usage` records, so
  carrying them `NOT NULL` was impossible without inventing values. Pricing resolves per
  `(model, bucket, effective_from)` instead (below).
- **`agent_id` nullable — but there is no backfill phase.** Because ingest parses the
  whole session before writing, attribution happens inside the parser (the hard
  `tool_use`-id join, parser-spec §5.1) and rows are written already attributed in the
  same transaction. `NULL` means *genuinely unattributable*, is surfaced as
  `unattributed` in the API and UI, and is never guessed. The P0 token-reconciliation
  test proves Σ`token_usage` == JSONL exactly, with no double-count or misattribution.
- **Tokens are copied verbatim** from the JSONL `usage` counts — ground truth, never
  inferred — satisfying the invariant the illustrative column list was designed around.
- **`is_compaction_baseline`** — the designed placeholder landed as a boolean marker
  flag. `PreCompact` repricing itself is computed compaction-aware from the substrate
  (see [the cost model](../architecture/cost-model.md)), with the delta≈0 invariant as
  its exit gate.
- **No `source_event_id`** — the design sketch traced each row to a normalized event; as
  built token rows come from the parser, not from `events`, so the provenance column has
  nothing to reference. The transcript itself is the audit trail (`message_id` keys back
  into it).

Full cost mechanics — dated-price resolution, delegation-savings, and PreCompact
repricing — belong to [the cost model](../architecture/cost-model.md).

## `model_pricing` — versioned rates

CD-4: *"versioned `model_pricing` (`effective_from`, `verified_on`)."* `WP-C1` adds the
concurrency shape: *"Multiple `effective_from` rows per bucket without conflict."*

The **real DDL** (migration 7, `model-pricing-with-seed`) is long-format to match
`token_usage` — one rate row per `(model, bucket, effective_from)`:

```sql
CREATE TABLE model_pricing (
  model          TEXT NOT NULL,
  bucket         TEXT NOT NULL CHECK (bucket IN ('input','output','cache_read','cache_write_5m','cache_write_1h')),
  usd_per_mtok   REAL NOT NULL,
  effective_from TEXT NOT NULL,
  PRIMARY KEY (model, bucket, effective_from)
);
```

- **`effective_from`** shipped as designed: the resolver picks the latest rate with
  `effective_from <=` the usage row's timestamp, and the composite primary key lets
  multiple dated rows per `(model, bucket)` coexist without conflict — `WP-C1`'s
  done-when. **`verified_on` was not built** — the seed carries its provenance in code
  comments instead; a dedicated verification-date column remains a reasonable future
  addition once prices are ratified.
- **The seed is `PROVISIONAL`, and honestly so**: approximate list prices for the exact
  model-id byte-strings observed in the real corpus, floored at an `effective_from` early
  enough to cover all historical messages — a mechanism proof for the cost engine, not a
  billing source. `<synthetic>` is priced $0 by design.
- **No silent $0, enforced at runtime**: an unknown model id, or a missing rate for a
  bucket with nonzero tokens, raises `PricingError` and **halts ingest before any row is
  written** (or returns an explicit `422` on the analysis endpoint) — "refusing to price
  at $0" is a hard gate, not a label. Zero-token buckets need no price row.
- **The designed CI staleness gate** (`WP-C6` — an unpriced model+bucket in the fixture
  corpus fails the build) is not verified as wired in CI; the runtime halt above is the
  enforcement that provably exists.

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
in-repo migration. *(As built, this remains true: v1 ships without any of them, and the
alerting phase is entered only via the KC-5 gate — earned by real daily use, per the
roadmap of record.)*

## What's decided vs. open

> **Update — 2026-07 (as built).** The table below is the design-time record; here is
> where each open row landed:
>
> - **`sessions` column set** — resolved: migration 2 (id/slug/started/last-activity/status).
> - **`agents.status` missing `'unknown'`** — resolved: migration 4 adds it; the watchdog
>   assigns it.
> - **Retention TTL vs. no-DELETE** — **still open**: the sweeper (`WP-D10`) is not built.
> - **MVP schema scope** — resolved by shipping: the seven core tables exist; the four
>   alert/webhook tables do not (post-1.0, KC-5).
> - **`projects` / `filters`** — still not modeled anywhere; neither was created. The gap
>   closed itself in practice: `sessions.project_slug` carries the only project fact the
>   dashboard needs.
> - The "reference synthesis" rows are superseded by the real DDL shown above; the
>   decided invariants they encoded (append-only, idempotency, non-null instance/host,
>   dated pricing, compaction baselines, nullable-but-never-guessed `agent_id`) all
>   shipped.

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
- [Hook ingestion](../architecture/hooks.md) — the lifecycle-event catalog (four real
  hooks as built) that populates `events_raw`.
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
