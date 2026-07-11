# ADR-0001: LB1 — Ingest primacy (the data-foundation seam)

- **Status:** accepted — decision procedure locked; the specific branch (JSONL-primary vs
  hooks-primary+outbox) is **pre-answered by the 2026-07-04 desktop probe (CONDITIONAL-GO,
  conf 85); formal spike pending** (see Empirical update below, and Consequences → Follow-ups)
- **Date:** 2026-07-03
- **Deciders:** Ivan Baev (project owner), via the six-lens concept-analysis-v2 workflow
  (Architect · Developer · QA · Business Analyst · Gap · Holistic)
- **Source:** [`concept-analysis-v2.md` §2 "LB1 — Ingest primacy"](../../../analysis/concept-analysis-v2.md#2-the-two-load-bearing-decisions),
  §7 "Open questions → Phase-0 inputs" (G0.1, G0.1b)

## Empirical update — 2026-07-04 desktop probe

An 8-agent read-only probe of the real `~/.claude/projects` corpus
([`phase0-probe.md`](../../../analysis/phase0-probe.md)) empirically **pre-answers CD-1 as
`CONDITIONAL-GO` → build (confidence 85/100)**. It de-risks this ADR's open branch but does
**not** replace the formal Phase-0 spike: `WP-S1`/`WP-S5` still need the paired-capture corpus
and Ivan's tree sign-off, and the `WP-S7` GO gate below **still stands** (no production ingest
code before it). Three points the probe forces on the prose that follows:

- **Spawn mechanism (C1):** the reconstructor keys on the `Agent` and `Workflow` spawn tools,
  **not** `Task` — the real corpus has **zero** `Task` blocks (`Agent` = 142, `Workflow` = 29),
  so a `Task`-keyed parser rebuilds an empty DAG. A general-purpose `Agent` spawn writes a flat
  `subagents/agent-<hex>.jsonl` (join `meta.toolUseId == the Agent tool_use.id`); a `Workflow`
  spawn writes a nested `subagents/workflows/wf_<id>/agent-<hex>.jsonl`. Any "Task-tool spawn" /
  "JSONL Task-chain" phrasing the earlier draft used below has been corrected inline.
- **Primacy pre-answered (V):** JSONL held as an outage-surviving single source of truth, so the
  branch resolves **JSONL-primary** — contingent on the formal spike confirming it on the
  paired-capture corpus.
- **Durable outbox (C3):** JSONL self-reconciles by backfill and the corpus shows ≈0 historical
  crashes, so `WP-IN11` (durable outbox/spool) is **pulled off the v1 critical path** — a
  deferrable, contingent fallback added only on a real trigger (a sub-second live-freshness need,
  or hooks becoming a data source not also present in JSONL). The proven load-bearing hedges are
  instead dual-layout parsing (85% nested) and child-transcript token summation (parent rollup
  ≈0%).

## Context

agenthropic ingests from two sources: Claude Code lifecycle **hooks** (sub-second, live) and
the durable **`~/.claude/projects/*.jsonl`** transcript log (ground-truth tokens, replayable).
The single biggest architectural unknown is whether the JSONL log carries the subagent
parent→child linkage (`Agent`/`Workflow` spawn tool → child `sessionId` → parent ref) well enough to rebuild
the whole orchestration DAG from the durable log alone, after an outage, with no hook input.

This is not a preference — it is **make-or-break for the persistent-DAG moat** (`docs/ai/DESIGN.md`
§2.1) and for the ground-truth-tokens invariant. Both externally-produced parallel reports
(**BASE**, **EXPANDED**) silently default to hooks-primary ingest with **no durability
contract**, which concept-analysis-v2 identifies as their shared blind spot. It cannot be
settled on paper: a **Phase-0 empirical spike** (see ADR-0010, CD-8) must answer it before any
production ingest code is written.

## Decision

Ingest is **JSONL-primary + replay-on-startup**, with hooks providing sub-second liveness only,
and **every write is an idempotent upsert on a stable event id** — **contingent on the Phase-0
spike proving JSONL carries the subagent parent→child linkage**. If it does not, fall back to
**hooks-primary + a durable local outbox/spool** (at-least-once, idempotent upsert), and only
then.

The primacy decision is an **output** of Phase-0, not an assumption baked in ahead of it — the
precise inversion of EXPANDED's error.

## Acceptance criteria

From `concept-analysis-v2.md` §6 ("Data foundation & reconciliation" and "Tree correctness"):

- Both hooks and JSONL land in `events_raw` with a stable idempotency key; re-ingesting the
  same log yields **byte-identical** `events_raw` **and** an identical projected DB state.
- **Kill + restart mid-session** → replay-on-startup reconstructs identical
  sessions/agents/`orchestration_edges`/`token_usage`; zero data loss.
- **DAG-rebuild:** after a simulated mid-session outage the tree reconstructs from JSONL alone
  (or, if Phase-0 forces hooks-primary, from the durable outbox with at-least-once + idempotent
  dedupe, no double-count).
- From one real subagent-heavy session, the correct parent→child tree reconstructs via the
  JSONL `Agent`/`Workflow` spawn chain **even if `SubagentStart` never fires**.
- Hierarchy correctness **≥95%** vs a labeled golden corpus of **≥3 real sessions** including
  crashed-no-Stop, deep nesting, mid-session PreCompact, two concurrent instances.

The Phase-0 verdict rule itself (`development-plan.md` `WP-S2`): **JSONL-alone edge accuracy
≥95% survives a simulated outage → JSONL-primary; else hooks-primary+outbox; else NO-GO.**

## Consequences

- **Positive:** if JSONL-primary holds, the ground-truth-tokens invariant is satisfied
  *naturally* (tokens read from the durable log, never inferred); history is crash-tolerant;
  replay-from-fixtures becomes deterministic, which is a precondition for the >90% coverage
  gate (ADR-0009, CD-7) being achievable at all rather than high-coverage tests of synthetic
  happy paths.
- **Negative / costs:** the normalizer must be a **dual-path** design — forward-link on
  `SubagentStart` *if it exists*, else post-hoc reconstruction on `SubagentStop` — adding
  branching complexity the externals did not have to plan for. Only a **NO-GO on the
  JSONL-alone path** — JSONL genuinely cannot self-reconcile — would force the contingent
  outbox/spool (at-least-once + idempotent dedupe) as required engineering. The 2026-07-04
  desktop probe ([`phase0-probe.md`](../../../analysis/phase0-probe.md)) pre-answers this branch
  **`CONDITIONAL-GO`**: JSONL self-reconciles by backfill (≈ 0 historical crashes), so the
  outbox is **YAGNI-leaning**, added only on a specific sub-second-liveness or hooks-only-data
  trigger — not by `CONDITIONAL-GO` itself.
- **Follow-ups:** `development-plan.md` Track S (`WP-S1`…`WP-S7`) is the throwaway spike that
  resolves this ADR's open branch; `WP-S7`'s GO/NO-GO verdict gates all of Phase 1
  (`WP-F1`). Only a hard **NO-GO** on JSONL-alone makes `WP-IN11` (durable outbox/spool)
  required; on `CONDITIONAL-GO` it stays deferrable (YAGNI-leaning per the probe). This ADR
  should be re-read once `WP-S7` reports — see [the roadmap](../../guide/roadmap.md) for phase
  status.

## Alternatives considered

- **Hooks-primary only, no durability contract** — what both BASE and EXPANDED silently
  default to. Rejected: unproven, and leaves the persistent-DAG moat's core promise
  (survives an outage) unverified.
- **Client-side tree reconstruction at render time** — rejected outright: it violates the
  design invariant that "the subagent tree is a data fact, not a UI reconstruction"
  (`docs/ai/DESIGN.md` §3).
- **EXPANDED's paperwork "decision lock"** — validating the linkage only at the Phase-4 UI,
  long after the normalizer and schema are already built around an assumption. Rejected by
  CD-8 (ADR-0010) as a "generation defect," not a genuine gate.
