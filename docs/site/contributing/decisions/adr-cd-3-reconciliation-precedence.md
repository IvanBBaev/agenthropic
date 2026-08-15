# ADR-0005: CD-3 — Reconciliation precedence

- **Status:** accepted, **partly moot as built 2026-07-30** — JSONL-authoritative tokens hold and are P0-proven; the cross-source precedence and the two-phase `agent_id` backfill were never needed; **amended 2026-08-15** — the token-reconciliation proof is CI-failing rather than merge-blocking, and the parser thresholds it runs against are still PROVISIONAL (see the as-built updates below)
- **Date:** 2026-07-03
- **Deciders:** Ivan Baev (project owner), via the six-lens concept-analysis-v2 workflow
- **Source:** [`concept-analysis-v2.md` §3, row CD-3](../../../analysis/concept-analysis-v2.md#3-canonical-decision-register-v2)
  (consolidates AD2, SD4); §7 point 2 (G0.1b join-key)

## Empirical update — 2026-07-04 desktop probe

The read-only full-corpus probe ([`phase0-probe.md`](../../../analysis/phase0-probe.md)) empirically
**pre-answers CD-1 as `CONDITIONAL-GO` → build (confidence 85/100)** on the real
`~/.claude/projects/` corpus. This de-risks — but does **not** replace — the formal Phase-0 spike;
the `WP-S7` GO gate still stands, and **no production code starts before it** is codified as tests.
The spike confirms these numbers on the paired-capture corpus.

Directly bearing on this decision, the probe resolves the **G0.1b join-key open question** the
Decision below leaves open (§7 point 2 / `WP-S3`): the JSONL→`agent_id` join is a **HARD key**, not a
confidence-scored inference. Depth-1 parent→child edges resolve at **0.000% orphan** (two exact
structural keys: `meta.toolUseId == parent Agent tool_use.id` and `agent-<hex> filename ==
toolUseResult.agentId`), and **100% of `message.usage` lines attribute to an `agentId`**. So the
`token_usage.agent_id` backfill is a deterministic hard join — the UI does not need to surface
match uncertainty. Backfill remains load-bearing because the tokens themselves must be **summed
from child transcripts** (parent-side rollup is ≈ 0% for the async spawn majority). Formal
confirmation still flows through `WP-S3` / the Phase-0 spike before the open question is closed.

## As-built update — 2026-07-30

**Verdict: the load-bearing half holds; the reconciliation half became unnecessary.**

**Tokens are JSONL-authoritative, and it is proven.** No token row can originate
from a hook: `token_usage` is written only on the JSONL ingest path, from parsed
ground truth. The P0 token-reconciliation proof asserts Σ `token_usage` per session
against an **independently written in-test reader** — a second implementation, not a
re-run of the same code — and it is merge-blocking. The `UNIQUE (message_id, bucket)`
key is what makes the sum exact rather than approximately right; naive row summation
over-counts by ≈2.4× (parser-spec §5.2).

**The two-phase attribution did not happen, and did not need to.** The Decision
below allows `token_usage.agent_id` to be NULL at first write and backfilled later.
As built, an entire session is parsed *before* any write, and the whole projection
lands in **one transaction** — so the agent is already known when the usage row is
inserted. The column is still nullable in the schema, but there is no backfill pass,
and therefore no window in which a row is misattributed. The Consequences section
below anticipates "a consistency concern that needs its own dedicated reconciliation
test"; that concern was designed out rather than tested around.

**Cross-source idempotent upsert has nothing to reconcile.** This decision's premise
is that a fact might be seen by both a hook and JSONL. As built that cannot happen:
hooks carry liveness only and never write structure or tokens
([ADR-0003](adr-cd-1-ingest-source-of-truth.md)'s as-built update), so the two
sources describe disjoint facts. Per-field precedence was never exercised because no
field has two claimants. Idempotency is still real, but it is per-source and enforced
in the schema (`events_raw.idempotency_key UNIQUE`,
`token_usage UNIQUE (message_id, bucket)`), not by a precedence rule at projection
time.

**The open question below is still open.** The `WP-S3` probe of whether the
JSONL→`agent_id` join is a hard key or needs confidence scoring was not run as a
formal spike. In practice the parser resolves the join structurally and the P0 proofs
pass on the real corpus shape, which is evidence that it behaves as a hard key — but
that is an observation from working code, not a ratified answer, and the parser's
thresholds remain PROVISIONAL (LABEL-ME) pending ratification against a hand-labelled
corpus.

## As-built update — 2026-08-15

**Verdict: unchanged; "and it is merge-blocking" overstates the enforcement.** The P0
token-reconciliation proof is exactly as described — Σ `token_usage` per session checked
against an independently written in-test reader, so a shared bug in the production summing
path cannot make both sides agree — and it runs in CI on every push, failing the run on a
mismatch. It does not withhold a merge: `main` is not branch-protected (`404 Branch not
protected`, verified 2026-08-15); see
[the standing correction](README.md#a-standing-correction-merge-blocking).

Nothing else here has moved. The `UNIQUE (message_id, bucket)` key still does the work that
keeps the sum exact rather than approximately right, naive row summation still over-counts
by ≈2.4×, the two-phase backfill is still unnecessary because a session is parsed before
anything is written, and the parser thresholds are still **PROVISIONAL (LABEL-ME)**.

## Context

Once both hooks and JSONL write into the single `events_raw` substrate (ADR-0004, CD-2), a rule
is still needed for **which source wins** when both describe the same fact, and for **when** a
token-usage row can be attributed to a specific agent. Hooks arrive first and cheaply (liveness),
but the ground-truth-tokens invariant (`docs/ai/DESIGN.md` §3) requires that dollar-relevant
numbers never originate from a hook-side inference. A further complication: a token row may need
to be recorded *before* the agent it belongs to is fully known (the JSONL join key from a token
record to a specific `agent_id` is itself an open Phase-0 question, §7 point 2).

## Decision

**Tokens are JSONL-authoritative** (never inferred); interim liveness/state comes from hooks;
final session/agent state and cost come from JSONL. **`token_usage.agent_id` is nullable at
first write, deterministically backfilled** once the agent is known. Cross-source idempotent
upsert: a fact seen by *both* a hook and JSONL lands **once**.

## Acceptance criteria

From `concept-analysis-v2.md` §6 ("Data foundation & reconciliation"):

- **Σ `token_usage` per session == JSONL ground truth exactly**; a static check proves no token
  row can originate from inference.
- `token_usage.agent_id` may be **NULL at first write**, backfilled deterministically; a
  reconciliation test asserts **no double-count or misattribution** after backfill.

Open and feeding this decision (§7 point 2, `WP-S3` / G0.1b): whether the JSONL→`agent_id` join
is a **hard key** or requires a **confidence-scored inference** — if the latter, the UI must
surface that uncertainty rather than presenting a heuristic match as certain (this is a
documented open question, not yet resolved; see Consequences → Follow-ups).

## Consequences

- **Positive:** hooks still deliver the sub-second liveness UX the dashboard needs (the
  "<30s time-to-understand" daily-question metric, ADR-0012/CD-10) without ever compromising the
  cost-trust chain — every displayed dollar still traces to *(ground-truth tokens × a dated,
  priced model)*.
- **Negative / costs:** two-phase attribution (write with a null `agent_id`, backfill later)
  adds a consistency concern that needs its own dedicated reconciliation test, and the backfill
  logic must be deterministic and idempotent under replay (ADR-0004, CD-2).
- **Follow-ups:** `development-plan.md` `WP-S3` (G0.1b join-key probe — determines whether
  backfill is a hard join or confidence-scored), `WP-D8` (`token_usage` table with nullable
  `agent_id`), `WP-IN9` (reconciliation precedence + deterministic backfill). See
  [the cost model](../../architecture/cost-model.md) and
  [ingest & reconciliation](../../architecture/ingest-reconciliation.md).

## Alternatives considered

- **Hooks-authoritative tokens** — rejected outright: violates the ground-truth-tokens
  invariant (`docs/ai/DESIGN.md` §3, §8); a hook-derived token count is not a durable, provably
  exact source.
- **Block `token_usage` insert until `agent_id` is fully known** — rejected: would delay the
  live cost/liveness signal the hook path exists to provide, defeating the purpose of having a
  hooks-primary liveness channel at all.
