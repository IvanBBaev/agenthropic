# ADR-0004: CD-2 — Single immutable substrate + deterministic projection

- **Status:** accepted, **amended in practice 2026-07-30** — append-only immutability shipped and is trigger-enforced; the two-stage Normalizer → Projection pipeline was not built (see the as-built update below)
- **Date:** 2026-07-03
- **Deciders:** Ivan Baev (project owner), via the six-lens concept-analysis-v2 workflow
- **Source:** [`concept-analysis-v2.md` §3, row CD-2](../../../analysis/concept-analysis-v2.md#3-canonical-decision-register-v2)
  (consolidates AD1, SD2); §4.1 (Senior Architect)

## Empirical update — 2026-07-04 desktop probe

The [Phase-0 corpus probe](../../../analysis/phase0-probe.md) (8-agent read-only run over the real
`~/.claude/projects/` corpus) **pre-answers CD-1 as `CONDITIONAL-GO` → build, confidence 85/100**.
This de-risks but does **not** replace the formal Phase-0 spike — the WP-S7 GO gate still stands and
no production code precedes it. Two points bear on this ADR:

- **The immutable-substrate + deterministic-replay mechanism is confirmed load-bearing.** JSONL is a
  complete, self-reconciling source that Claude writes independently, so state re-derives by
  re-reading the tree (backfill); the corpus showed ≈ 0 historical crashes. This is exactly what
  makes the **durable outbox (`WP-IN11`) deferrable / YAGNI-leaning** and pulls it **off the v1
  critical path** — replay-on-startup over `events_raw`, not a spool, is the proven outage hedge
  (add the outbox only on a real trigger: a sub-second live-freshness need, or a hooks-only data
  source not also present in JSONL).
- The probe's proven load-bearing hedges are **dual-layout parsing** (85% of agent files are nested)
  and **child-transcript token summation** (parent rollups ≈ 0%) — not the outbox.

## As-built update — 2026-07-30

**Verdict: amended in practice.** This ADR has two halves. The immutability half
shipped and is enforced in the database engine. The pipeline-shape half — the
two-stage `Normalizer` → `Projection` pair drawn in the diagram below — was never
built.

**What holds:**

- `events_raw` is genuinely append-only, and not by convention: migration 1 creates
  SQLite `BEFORE UPDATE` and `BEFORE DELETE` triggers
  (`events_raw_no_update` / `events_raw_no_delete`) that `RAISE(ABORT, 'events_raw is
  append-only')`. There is no UPDATE/DELETE path to find, because the engine refuses
  one. A negative test asserts both aborts and is merge-blocking.
- Idempotency is a `UNIQUE` constraint on `idempotency_key`, so re-ingesting the same
  log is a no-op at the storage layer rather than a de-duplication pass in
  application code.
- Deterministic replay is proven: the P0 double-replay proof asserts a **byte-identical**
  result across two ingests of the same corpus, and the P0 DAG-rebuild proof
  reconstructs the projection after a simulated outage.

**What diverged:** there is no pure `Normalizer` stage and no separate `Projection`
stage. `WP-IN6`/`WP-IN7` as drawn were collapsed. As built, JSONL is parsed by
`packages/core` (a pure parser with no DB imports) and the result is written straight
into `sessions`, `agents`, `orchestration_edges` and `token_usage` — **one
transaction per session**, no intermediate normalized-event representation.
Consequently `events_raw` in practice holds **hook events only**: the JSONL path
does not round-trip through the substrate on its way to the projections.

**Why:** the substrate-then-project shape earns its keep when two drifting sources
must be reconciled at projection time. Once CD-1 settled into "JSONL is the only
structural source, hooks are liveness only" ([ADR-0003](adr-cd-1-ingest-source-of-truth.md)),
there was nothing to reconcile on the structural path, and the intermediate stage
became a rewrite of the same facts with no reader. The per-session transaction
preserves the property that actually mattered — a session is projected atomically or
not at all, and replay is deterministic — without the second table.

**What this costs, stated plainly:** the replay guarantee is now "re-read the JSONL
corpus and re-project," not "re-run a pure function over rows already in the
database." That is weaker in one specific way: it depends on the corpus still being
on disk. It is exactly as strong for the failure mode this project actually faces
(process crash, restart, backfill), because Claude Code writes that corpus
independently and does not truncate it — the property CD-1's probe measured. If a
hooks-only data source ever appears, this half of CD-2 has to be rebuilt as
originally drawn.

## Context

agenthropic ingests the same underlying facts from two independent sources — hooks and the
JSONL transcript log (ADR-0001, LB1). Left unresolved, this creates a classic reconciliation
problem: does a read path merge two separate stores at query time, or does one substrate absorb
both sources so reconciliation happens once, at write time? A two-store, merge-at-query design
pushes reconciliation logic into every read path and makes idempotent replay much harder to
reason about and test.

## Decision

Both sources write into a single **append-only, idempotency-keyed `events_raw`** substrate.
`sessions`/`agents`/`orchestration_edges`/`token_usage` are a **pure, replayable projection**
over it. Reconciliation is **per-field precedence at projection time** (see ADR-0005, CD-3),
never a two-store merge at query time.

```
   hook payload ──┐
                   ├──►  events_raw  (append-only, idempotency-keyed, CD-1/CD-2)
   JSONL line ────┘            │
                                ▼
                        pure Normalizer  ──►  events (normalized)
                                │
                                ▼
                        pure Projection  ──►  sessions / agents /
                                              orchestration_edges / token_usage
```

Replay-on-startup re-runs Normalizer + Projection over the same `events_raw` and must produce an
identical result — this is what makes CD-1's outage-recovery guarantee and the >90% coverage
gate (ADR-0009, CD-7) tractable: tests can replay fixtures deterministically instead of mocking
two independently-drifting stores.

## Acceptance criteria

From `concept-analysis-v2.md` §6 ("Data foundation & reconciliation") and the CD-4 crosscut:

- Both hooks and JSONL land in `events_raw` with a stable idempotency key; re-ingesting the
  same log yields **byte-identical** `events_raw` **and** an identical projected DB state.
- **Kill + restart mid-session** → replay-on-startup reconstructs identical
  sessions/agents/`orchestration_edges`/`token_usage`; zero data loss.
- `events_raw` exposes **no UPDATE/DELETE path**, enforced by a test (shared acceptance
  criterion with ADR-0006, CD-4, and ADR-0009, CD-7).

## Consequences

- **Positive:** collapses replay-on-startup, idempotency, and outage-backfill into **one**
  mechanism instead of three separate ones per source. Deterministic replay over fixtures is
  what makes the >90% coverage gate meaningful rather than coverage of synthetic happy paths.
- **Negative / costs:** every adapter must express its effect as an append to `events_raw` —
  no side-channel writes are permitted anywhere in the ingest path, which constrains adapter
  design (see ADR-0008, CD-6) and requires discipline to keep enforced structurally, not just by
  convention.
- **Follow-ups:** `development-plan.md` `WP-D4` (`events_raw` immutable substrate +
  append-only enforcement + `EventStore.append`), `WP-IN6` (pure Normalizer), `WP-IN7`
  (Projection), `WP-IN10` (replay-on-startup + deterministic full projection rebuild). See
  [the data model](../../architecture/data-model.md) and
  [ingest & reconciliation](../../architecture/ingest-reconciliation.md).

## Alternatives considered

- **Two independent stores (hook-store + JSONL-store), reconciled per query** — rejected: pushes
  reconciliation complexity into every read path instead of resolving it once at projection
  time, and makes deterministic replay/testing significantly harder.
- **A single flat `events` table with no immutable substrate** — v1's implicit design, and the
  reconciliation gap v1 left unresolved (`concept-analysis-v2.md` §8, "What changed vs v1").
  Rejected: without an immutable append-only layer underneath, there is no clean way to prove
  "no data lost, no data mutated" by test.
