# ADR-0003: CD-1 — Ingest source of truth, decided by the Phase-0 diff

- **Status:** accepted — decision procedure locked; outcome pre-answered `CONDITIONAL-GO` (conf 85) by the 2026-07-04 desktop probe, formal Phase-0 spike pending (see ADR-0001)
- **Date:** 2026-07-03
- **Deciders:** Ivan Baev (project owner), via the six-lens concept-analysis-v2 workflow
- **Source:** [`concept-analysis-v2.md` §3, row CD-1](../../../analysis/concept-analysis-v2.md#3-canonical-decision-register-v2)
  (consolidates LB1, AD3, SD3, G-D1)

## Empirical update — 2026-07-04 desktop probe

The [Phase-0 corpus probe](../../../analysis/phase0-probe.md) (8-agent read-only run over the
real `~/.claude/projects/` corpus, two load-bearing facts hand-verified) **pre-answers CD-1**:

- **CD-1 = `CONDITIONAL-GO` → build**, confidence **85/100**. JSONL is a trustworthy,
  outage-surviving source of truth for the persisted subagent DAG and the per-agent token ledger
  — the JSONL-primary branch of the Decision below is empirically favoured.
- The subagent parent→child linkage is carried by the **`Agent` / `Workflow` spawn tools, not
  `Task`** (real corpus: `Task` blocks = 0, `Agent` = 142, `Workflow` = 29); a parser must walk
  **both** on-disk layouts (85% nested, spawn-mechanism-driven — not version-driven) and sum
  tokens **from child transcripts** (parent rollup ≈ 0%).
- The **durable outbox** named in the Decision's `otherwise` branch is downgraded to
  **deferrable / YAGNI-leaning** — JSONL self-reconciles by backfill and historical crashes ≈ 0,
  so it is pulled off the v1 critical path (add only on a sub-second-liveness need or a hooks-only
  data source). The proven load-bearing hedges are instead dual-layout parsing and
  child-transcript token summation.

This **de-risks but does not replace** the formal spike: `WP-S1`/`WP-S5` still need the
paired-capture corpus and Ivan's tree sign-off, and the `WP-S7` **GO gate below still stands** —
no ingest/normalizer production code before it.

## Context

CD-1 is the canonical, build-facing formalization of ADR-0001 (LB1): it is the ten-item
canonical register's rule for *how* ingest primacy gets decided, not merely a restatement of
what the answer might be. The risk it forecloses is procedural: both external reports (BASE,
EXPANDED) reached a hooks-primary design **by default**, without ever running an experiment to
check it, and EXPANDED went further by deferring any check to a Phase-4 UI walkthrough — by
which point the schema and normalizer are already committed to an unverified premise.

## Decision

Ingest primacy is **decided by the Phase-0 diff** (tree-from-JSONL vs tree-from-hooks), **never
assumed**. Concretely: JSONL-primary + replay-on-startup if Phase-0 proves the JSONL log carries
the subagent parent→child linkage; otherwise hooks-primary + a durable outbox. No normalizer or
schema commitment is made ahead of that empirical result.

## Acceptance criteria

The full quantified acceptance criteria (byte-identical replay, DAG-rebuild-from-JSONL-alone,
hierarchy ≥95%) are shared with ADR-0001 (LB1) — see that ADR to avoid duplication. The
criterion specific to *this* decision's procedural nature:

- No ingest/normalizer production code is written until `development-plan.md` `WP-S7` reports a
  **GO** or **CONDITIONAL-GO** verdict (ADR-0010, CD-8's hard ❌-stop gate applies here directly).
- The verdict is captured **with the diff evidence attached** (`WP-S2`'s tree-from-JSONL vs
  tree-from-hooks comparison), not asserted from prior belief.

## Consequences

- **Positive:** removes the single largest inherited risk in both external reports — a
  hooks-primary design with no durability contract, discovered wrong only after the schema is
  poured. Evidence precedes commitment.
- **Negative / costs:** introduces a hard schedule chokepoint — per `development-plan.md` §7,
  `WP-S7` gates `WP-F1` (the entire monorepo scaffold), so nothing in Phase 1 proceeds until the
  spike reports.
- **Follow-ups:** `development-plan.md` Track S (`WP-S1`…`WP-S7`); on NO-GO, per the roadmap
  table, "the moat feasibility is reconsidered before build" rather than worked around silently.
  See [the roadmap](../../guide/roadmap.md) for the current phase.

## Alternatives considered

- **Assume hooks-primary and defer validation to the Phase-4 UI** — EXPANDED's approach.
  Rejected by CD-8 (ADR-0010) as "Phase-0-as-paperwork," a "generation defect" explicitly
  quarantined from v2.
- **Assume JSONL-primary outright without a spike** — rejected for the same reason in reverse:
  an assumption is not evidence, even a plausible one.
