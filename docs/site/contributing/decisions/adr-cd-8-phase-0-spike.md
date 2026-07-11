# ADR-0010: CD-8 — Phase 0 is a throwaway GO/NO-GO feasibility spike

- **Status:** accepted
- **Date:** 2026-07-03
- **Deciders:** Ivan Baev (project owner), via the six-lens concept-analysis-v2 workflow
- **Source:** [`concept-analysis-v2.md` §3, row CD-8](../../../analysis/concept-analysis-v2.md#3-canonical-decision-register-v2)
  (consolidates AD-Phase0, G-D2, H-SEQ); §7 ("Open questions → Phase-0 inputs")

## Empirical update — 2026-07-04 desktop probe

A read-only 8-agent probe of the real `~/.claude/projects/` corpus
([`phase0-probe.md`](../../../analysis/phase0-probe.md)) **pre-answers CD-1 as
`CONDITIONAL-GO` → build (confidence 85/100)**. This de-risks — but does **not** replace —
this spike: the formal Phase-0 / `WP-S1`…`WP-S7` still confirm it on the paired-capture
corpus with Ivan's tree sign-off, and the **`WP-S7` GO gate below still stands (no
production code before it)**. Three corrections apply to the acceptance criteria as written:

- **Spawn tool is `Agent`/`Workflow`, not `Task`** (C1). The real corpus has **0** `Task`
  blocks (`Agent` = 142, `Workflow` = 29); a `Task`-keyed parser rebuilds an empty DAG.
  G0.1's linkage probe keys on the `Agent` tool (flat `subagents/agent-<hex>.jsonl`) and the
  `Workflow` tool (nested `subagents/workflows/wf_<id>/`) — corrected inline below.
- **The durable outbox (`WP-IN11`) is deferrable, not load-bearing** (C3). JSONL
  self-reconciles by backfill and the corpus shows ≈0 historical crashes, so the outbox is
  pulled **off the v1 critical path** (add only on a real trigger: a sub-second
  live-freshness need, or hooks becoming a data source absent from JSONL). The proven
  load-bearing hedges are instead **dual-layout parsing** (85% nested) and
  **child-transcript token summation** (parent rollup ≈0%).
- Layout is **spawn-mechanism-driven, not version-driven** (C2): flat and nested coexist
  within the same CC version; the parser branches on **directory shape**, not `version`.

## Context

Two load-bearing assumptions are unverified on paper: whether JSONL carries the subagent
linkage well enough to rebuild the DAG (ADR-0001, LB1), and whether the "twelve" Claude Code
lifecycle hooks assumed by both external reports actually all fire — in particular whether
`SubagentStart` exists at all (`concept-analysis-v2.md` §4.2: "`SubagentStart` is probably not a
real hook"). EXPANDED's own version of a Phase 0 degrades this into paperwork, validating the
linkage only at a Phase-4 UI walkthrough — by which point the normalizer and schema are already
built around the unverified premise.

## Decision

**Phase 0 is a throwaway GO/NO-GO feasibility spike with a hard ❌ stop:**

- **G0.1** — ingest-primacy probe (feeds ADR-0001/LB1, ADR-0003/CD-1).
- **G0.2** — hook-catalog enumeration (don't assume "the twelve"; confirm/deny `SubagentStart`).
- **G0.3** — tree smoke gate.
- **G0.4** — token-reconciliation probe.

**No production code until green.**

## Acceptance criteria

From `concept-analysis-v2.md` §7 ("Open questions → Phase-0 inputs") and
`development-plan.md` Track S:

- **G0.1:** does `~/.claude/projects/*.jsonl` carry the subagent parent→child linkage
  (`Agent`/`Workflow`-tool spawn → child `sessionId` → parent ref) so the DAG rebuilds from JSONL alone after
  a full outage? Per `WP-S2`: **JSONL-alone edge accuracy ≥95%** survives a simulated outage →
  JSONL-primary; else hooks-primary+outbox; else NO-GO.
- **G0.1b:** the exact join key from a JSONL token row to a specific `agent_id` — hard key or
  confidence-scored heuristic (feeds ADR-0005, CD-3's backfill design).
- **G0.2:** which of the assumed "twelve" hooks actually fire, specifically `SubagentStart`.
- **G0.2b:** whether the log carries pre/post-compaction markers for a repriceable baseline, or
  whether it must be snapshotted at hook time (feeds ADR-0006, CD-4).
- Per `development-plan.md` `WP-S7`: a **single GO / CONDITIONAL-GO / NO-GO verdict**, with the
  CD-1 rule applied and the driving evidence attached, **gates all of Phase 1** (`WP-F1`).

## Consequences

- **Positive:** de-risks the entire architecture before any of it is poured into schema or
  normalizer code; forces the hook-catalog assumption to be verified rather than silently
  inherited from the external reports.
- **Negative / costs:** Phase 1 cannot start until `WP-S7` reads GO — `development-plan.md` §7
  names this "the single chokepoint": "On NO-GO, no scaffold proceeds — the moat feasibility is
  reconsidered, not worked around."
- **Follow-ups:** `development-plan.md` Track S (`WP-S1`…`WP-S7`, `WP-X10`); see
  [the roadmap](../../guide/roadmap.md) for the current phase and gate status.

## Alternatives considered

- **Skip the spike; build against the assumed "twelve" hooks and a hooks-primary design** —
  EXPANDED's approach. Rejected: flagged in `concept-analysis-v2.md` §1 and §4.5 (Gap #2) as one
  of EXPANDED's own "generation defects" — "Phase-0 reduced to paperwork" — and explicitly
  quarantined, not inherited, in v2.
- **Validate the hook catalog and linkage assumption only at the UI-review stage (Phase 4)** —
  rejected for the same reason: by then the schema and normalizer are already committed.
