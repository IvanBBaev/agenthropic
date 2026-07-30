# ADR-0010: CD-8 — Phase 0 is a throwaway GO/NO-GO feasibility spike

- **Status:** accepted, then **OVERRIDDEN by the owner on 2026-07-11** — the hard ❌-stop gate ("no production code until green") was bypassed, **not** satisfied; spike numbers remain PROVISIONAL (LABEL-ME) pending ratification. See the as-built update below.
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

## As-built update — 2026-07-30

**Verdict: overridden. Not passed.**

This is the one ADR in this directory whose gate was bypassed rather than cleared,
and it must be read that way. The `WP-S7` verdict was **CONDITIONAL-GO**, meaning
conditions attached. Implementation began on **2026-07-11**, while those conditions
were still open, by an **explicit instruction from the project owner (Ivan Baev) in
chat**, given after he was told that the outstanding CD-8 conditions were precisely
what was blocking the work. Two further dispatch overrides followed (2026-07-18,
2026-07-29).

The distinction matters more here than anywhere else in this corpus. This ADR exists
because both external reports reached their conclusions **by default, without running
the experiment**. An override that gets recorded as a pass would reproduce exactly
that failure mode one level up: a gate that was skipped, remembered as a gate that
was met. So, stated without softening:

- **The hard ❌ stop below was not honoured.** "No production code until green" was
  overridden by the owner, not satisfied.
- **The override did not relax anything else.** It did not touch the security
  invariants ([ADR-0009](adr-cd-7-security-and-coverage-boundary.md)), the coverage
  gate, the kill-checkpoint calendar, the LABEL-ME ratification requirement, or the
  no-commit-without-an-explicit-ask rule. It authorized starting, and nothing more.
- **The spike numbers remain PROVISIONAL (LABEL-ME).** Every threshold derived from
  the desktop probe — read limits, layout heuristics, edge-detection confidence — is
  marked provisional in the source and **awaits ratification against a hand-labelled
  corpus**. They have not been ratified. Working code that passes tests built on
  those numbers is not the same thing as those numbers being right.
- **`WP-S3` / G0.1b was never run as a formal probe** — see
  [ADR-0005](adr-cd-3-reconciliation-precedence.md)'s as-built update.

**What the built system does independently evidence.** Three merge-blocking P0
proofs now assert, against fixture corpora, what G0.1 and G0.4 set out to measure:
the DAG rebuilds from JSONL alone after a simulated outage; a double replay is
byte-identical; Σ `token_usage` matches an independently written in-test reader.
G0.2 is answered by construction — the shipped installer wires **four** hooks
(`UserPromptSubmit`, `Stop`, `SubagentStop`, `PreCompact`), and **`SubagentStart`
does not exist**, confirming the §4.2 suspicion this ADR was written to test.

That is real evidence and it points the same way the probe did. It is still not the
thing this ADR asked for. The spike was meant to produce a **ratified verdict on a
paired-capture corpus with the owner's tree sign-off, before the schema was poured**.
The schema is poured. The sign-off is outstanding. The honest summary is: the
architecture was validated *after* being committed to, by tests the same author
wrote, on fixtures rather than a hand-labelled corpus — which is better than
EXPANDED's "validate at the Phase-4 UI walkthrough," and worse than what CD-8
specified.

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
