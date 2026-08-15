# ADR-0003: CD-1 — Ingest source of truth, decided by the Phase-0 diff

- **Status:** accepted — JSONL-primary branch **built and holding** (see the as-built update below); ~~formal Phase-0 spike pending~~ *(the `WP-S7` gate this ADR depends on was overridden by the owner on 2026-07-11, not passed — see [ADR-0010](adr-cd-8-phase-0-spike.md))*; **amended 2026-08-15** — the P0 proof cited below is CI-failing, not merge-blocking (`main` is not branch-protected)
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

## As-built update — 2026-07-30

**Verdict: holds, strengthened.** The Decision's JSONL-primary branch is what was
built, and the split is sharper in code than on paper.

- **JSONL is the sole structural source.** `sessions`, `agents`,
  `orchestration_edges` and `token_usage` are written only from parsed JSONL, via a
  read-only corpus port. Nothing about the shape of the tree, and no token count,
  ever originates in a hook.
- **Hooks are liveness only, never structure.** A hook delivery appends its raw
  envelope to `events_raw` and writes one identifier-only normalized row to `events`
  (session / agent identifiers and a type — never payload content). It is a "something
  happened just now" signal for the live view; it cannot create an agent, an edge, or
  a token row.
- **Four hooks exist, not twelve.** The shipped installer wires `UserPromptSubmit`,
  `Stop`, `SubagentStop` and `PreCompact`. Design-era prose across this corpus that
  counts "the twelve lifecycle hook events" describes the event *catalogue* that was
  surveyed, not what agenthropic subscribes to. In particular **`SubagentStart` does
  not exist** — subagent birth is therefore observable only in JSONL, which is one
  concrete reason the JSONL-primary branch had to win.
- **The separation is proven, not asserted.** The P0 DAG-rebuild proof
  (`apps/server/test/p0/p0-dag-rebuild.test.ts`) rebuilds the full DAG from JSONL
  alone after a simulated outage, then appends hook events and asserts the DAG dump is
  **unchanged**. That test is merge-blocking.

One honest caveat on the *procedural* half of this ADR: the criterion below —
"no ingest/normalizer production code until `WP-S7` reports GO" — was **not**
satisfied. Ingest was built under an owner override of that gate; see
[ADR-0010](adr-cd-8-phase-0-spike.md)'s as-built update. The technical branch this
ADR selects was independently borne out by the P0 proofs; the gate that was supposed
to select it was bypassed.

## As-built update — 2026-08-15

**Verdict: unchanged; one claim narrowed.** The P0 DAG-rebuild proof
(`apps/server/test/p0/p0-dag-rebuild.test.ts`) is described above as **merge-blocking**.
The half of that which is true is the important half: the test runs in CI on every push and
pull request, and it fails the run if appending hook events changes the DAG dump — so a
regression that let hooks write structure could not pass quietly. The half that is not true
is the enforcement: `main` is not branch-protected (`404 Branch not protected`, verified
2026-08-15), so a red run is a signal rather than a withheld merge. See
[the standing correction](README.md#a-standing-correction-merge-blocking).

Neither the four-hooks finding nor the absence of `SubagentStart` has changed, and neither
has the procedural caveat: `WP-S7` never ran, and nothing since has retroactively satisfied
the gate this ADR's own criterion names.

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
