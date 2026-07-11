# Cost model

This page covers how agenthropic turns raw token counts into trustworthy dollar figures:
the `token_usage` buckets that each carry their own per-token rate, the dated
`model_pricing` table those buckets are priced against, the compaction-baseline
repricing that keeps historical totals correct after a context rewrite, the
delegation-savings metric that re-prices Haiku/Sonnet routing at top-tier rates to
quantify what routing actually saved, and the CI rule that turns pricing staleness into
a build failure instead of a silent wrong number. The key takeaway: **every dollar this
system ever displays traces to a single, auditable equation — ground-truth tokens ×
a dated, versioned price** — never a runtime estimate, never a hardcoded constant nobody
re-verified (the "cost-trust chain," concept-analysis-v2 §3, `H-COST`). Cost correctness
is treated as one of the four real testable units of this project, alongside ingest,
tree, and live-flow correctness (concept-analysis-v2 §4.3).

## In one picture

```
~/.claude/projects/*.jsonl                 model_pricing (dated, versioned)
  (ground-truth token counts)                effective_from / verified_on
        │                                           │
        ▼                                           ▼
   token_usage                              PricingProvider
   bucketed by:                             (timestamp-aware
   speed / inference_geo /                   dated-price resolver)
   service_tier,                                    │
   compaction baseline preserved,                    │
   agent_id nullable → backfilled                    │
        │                                            │
        └──────────────────┬─────────────────────────┘
                            ▼
                        CostEngine
              cost = Σ (tokens_in_bucket × dated_rate_for_bucket)
                            │
              ┌─────────────┴─────────────┐
              ▼                           ▼
    per-session / per-agent      delegation-savings
      dollar cost                (actual model vs.
                                  top-tier re-price)
              │                           │
              └─────────────┬─────────────┘
                             ▼
                  Cost query API → cost/Sankey view
```

This is the same `hook-ingest → SQLite (WAL) → read API` shape described in the
[architecture overview](../architecture/overview.md); the cost model is the pricing
layer bolted onto the `token_usage` projection, not a separate pipeline.

## 1. Ground truth in, dollars out

Every figure on this page starts from the same non-negotiable invariant that governs
the rest of the system: **token counts are read from `~/.claude/projects/*.jsonl`,
never inferred** (DESIGN §3; concept-analysis-v2 CD-3). The cost model does not
introduce a second, cheaper source of token counts — it consumes the exact same
ground-truth numbers the subagent tree and the live status view consume, and adds
exactly one thing on top: a price.

concept-analysis-v2 states this as a named crosscut, the **cost-trust chain**
(§3, `H-COST`, CD-3 + CD-4):

> every displayed dollar traces to *(ground-truth tokens × a dated, priced model)*; a
> model observed in fixtures with **no price** row **FAILS CI** — silent staleness is a
> red build, not a runtime "estimated" label. This extends the byte-exact-tokens
> guarantee to the priced output.

The risk this guards against is named explicitly in the source analysis: the
`token_usage`/compaction-baseline graft is **"the most subtle piece of the entire
costing model"** — getting it wrong "means silently wrong dollar figures — which
undermines the moat's credibility" (concept-analysis.md §3.3). The negative-test
catalogue backs this with a dedicated regression: "compaction-mid-session and
PreCompact re-pricing" is one of the two v1-only cases added on top of the ten
EXPANDED §7.1 negative scenarios (concept-analysis-v2 §6, Tree correctness). The rest
of this page is the mechanism that closes that gap: buckets that track what actually
changes the rate, a pricing table that is dated rather than a single constant, and a
compaction baseline so a context rewrite mid-session doesn't corrupt history.

## 2. `token_usage`: bucketed by whatever changes the rate

The base schema (`simple10`-derived: `projects`/`sessions`/`agents`/`events`/`filters`)
does not model cost at fine grain. `token_usage` is a graft from `hoangsonww`, adopted
specifically because its bucketing is production-grade (DESIGN §4):

> **`token_usage`** bucketed by `speed` / `inference_geo` / `service_tier` (each
> changes the per-token rate), preserving **compaction baselines** so historical
> totals still price correctly after a context rewrite. Production-grade costing.

| Bucket dimension | Why it exists |
|---|---|
| `speed` | Throughput/latency characteristic of the request — carries its own rate. |
| `inference_geo` | Regional routing of the inference call — carries its own rate. |
| `service_tier` | The API service tier the call was served under — carries its own rate. |

The source docs name these three dimensions as rate-changing without enumerating their
literal values or exact column types — that detail is schema work not yet written
(owned by `WP-D8` in the development plan, Track D, wave 10). Two further properties
are load-bearing and *are* specified:

- **`token_usage.agent_id` may be `NULL` at first write.** A token row can land before
  the owning agent is resolved; it is **deterministically backfilled** once the agent
  is known — never left as a guess, never double-counted after backfill
  (concept-analysis-v2 CD-3; acceptance criteria §6: "a reconciliation test asserts no
  double-count or misattribution after backfill").
- **A compaction baseline is preserved**, not overwritten, when a session hits
  `PreCompact` (DESIGN §4) — see [§6](#6-compaction-baseline-repricing) below.

An illustrative sketch of the shape these constraints imply (this is **not** an
authoritative DDL — the concrete table is `WP-D8`'s deliverable, not yet built):

```sql
-- Illustrative only — exact columns/types are undecided (WP-D8).
CREATE TABLE token_usage (
  id                TEXT PRIMARY KEY,
  session_id        TEXT NOT NULL,
  agent_id          TEXT,              -- nullable at first write, backfilled (CD-3)
  model_id          TEXT NOT NULL,
  speed             TEXT NOT NULL,
  inference_geo     TEXT NOT NULL,
  service_tier      TEXT NOT NULL,
  input_tokens      INTEGER NOT NULL,  -- copied verbatim from JSONL, never inferred
  output_tokens     INTEGER NOT NULL,  -- copied verbatim from JSONL, never inferred
  compaction_baseline_id TEXT,         -- preserves the pre-PreCompact totals
  recorded_at       TEXT NOT NULL,
  FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE SET NULL
);
```

The Phase-2/3 ingest work that populates this table is `WP-IN5` (JSONL tail-follow,
"tokens copied **verbatim** — no inference") feeding `WP-IN7` (`events` → sessions/
agents/`token_usage` projection, precedence-aware; "Σ `token_usage` per session ==
JSONL exact" is one of the three P0 release-blocker tests, development-plan Phase 3
exit gate).

## 3. `model_pricing`: a dated table, not a hardcoded constant

The pricing side of the equation is the second `hoangsonww` graft (DESIGN §4):
`model_pricing` "to drive the dollar-cost + delegation-savings tile." The design
decision that governs it (`D6` in the implementation plan) is explicit about *why* it
must be dated rather than a single constant:

> **Decision.** A single `model_pricing` seed (dated, with model IDs) is the source of
> truth; a test asserts every model seen in fixtures has a price, and the constant
> carries a "verified on \<date\>" stamp. Re-verify rates on each cost-feature change.
> **Why.** Turns a silent staleness liability into a failing test.

This directly answers the anti-pattern this system deliberately avoids. `cast`'s
delegation-savings formula is worth stealing (§7 below), but its pricing table is, in
the source, **hardcoded and stale** (concept-analysis.md §6.4). The concept review
names the concrete threat: the model lineup is **actively churning**
(named examples as of the source analysis: *Opus 4.8, Sonnet 5, Haiku 4.5, Fable 5* —
concept-analysis-v2 §5, Weaknesses) and "there is no stated source-of-truth for prices,
no update process, and no test that fails when a rate goes stale. A wrong dollar figure
quietly discredits the whole cost moat" (concept-analysis.md §6.4).

CD-4's canonical schema rule is the fix:

> **versioned** `model_pricing` (`effective_from`, `verified_on`).

An illustrative sketch (again, not an authoritative DDL — `WP-C1` owns the real one):

```sql
-- Illustrative only — exact columns/rate values are undecided (WP-C1).
CREATE TABLE model_pricing (
  id                TEXT PRIMARY KEY,
  model_id          TEXT NOT NULL,
  speed             TEXT NOT NULL,
  inference_geo     TEXT NOT NULL,
  service_tier      TEXT NOT NULL,
  price_per_input_token  REAL NOT NULL,   -- placeholder — real rates from WP-C1's seed
  price_per_output_token REAL NOT NULL,   -- placeholder — real rates from WP-C1's seed
  effective_from    TEXT NOT NULL,        -- ISO timestamp: rate applies at/after this
  verified_on       TEXT NOT NULL         -- last human re-verification date
);
```

Multiple `effective_from` rows can exist for the same `(model_id, speed,
inference_geo, service_tier)` bucket without conflict — that is the whole point of
dating the table (development-plan `WP-C1` Done-when).

**What is genuinely undecided:** the *authoritative dated source* for these rates and
the *refresh cadence* that keeps the staleness-fails-CI test honest as the model lineup
churns is an open Phase-0 input, not yet answered (concept-analysis-v2 §7, question 7:
"the authoritative dated source for `model_pricing` and the refresh cadence that keeps
the staleness-fails-CI test honest"). This page does not assert real dollar figures for
that reason — the rate columns above are placeholders, not published prices.

## 4. `PricingProvider`: a dated lookup, not "the current price"

Pricing a historical event correctly requires resolving the rate **that was in effect
when the tokens were spent**, not the rate in effect right now. This is the
`PricingProvider` port named in the canonical adapter set (CD-6; see the
[ports & adapters table](../architecture/overview.md#ports--adapters) on the overview
page). Its contract, from the development plan (`WP-C2`):

> **`PricingProvider` port + timestamp-aware dated-price resolver.** An event resolves
> to the OLD rate before a change, the new rate at/after.

Conceptually, the resolver is a "latest row at or before this timestamp" lookup per
bucket:

```sql
SELECT price_per_input_token, price_per_output_token
FROM model_pricing
WHERE model_id = :model_id
  AND speed = :speed AND inference_geo = :inference_geo AND service_tier = :service_tier
  AND effective_from <= :event_timestamp
ORDER BY effective_from DESC
LIMIT 1;
```

This is why a rate change (a new `model_pricing` row with a later `effective_from`)
never rewrites the cost of events that already happened — the dated resolver picks the
row that was live at the time, per bucket.

## 5. `CostEngine`: every dollar = tokens × dated price

`CostEngine` (CD-6) is the pure computation that combines `token_usage` with
`PricingProvider` lookups (development plan `WP-C3`, Track C, Phase 3):

> **CostEngine** — ground-truth tokens × dated bucketed price. Cost matches a
> hand-computed value from JSONL tokens × seed.

In formula form, for a session or agent:

```
cost = Σ over each token_usage row r:
         PricingProvider.rateFor(r.model_id, r.speed, r.inference_geo,
                                  r.service_tier, r.recorded_at)
         × r.tokens
```

Nothing in this equation infers, estimates, or rounds a token count — the only
computed quantity is the price lookup, and that lookup is itself a deterministic,
dated function of data already in `model_pricing`. The Phase-4 read-API exit gate
restates the same guarantee from the consumer side: "every displayed dollar traces to
ground-truth tokens × dated price" (development plan §3, Phase 4 exit gate), and
`WP-U4`'s Done-when is explicit that this must hold with **no API-side inference**.

## 6. Compaction-baseline repricing

`PreCompact` is one of the twelve (nine confirmed, per the hook-catalog caveat — see
[hook ingestion](../architecture/hooks.md)) Claude Code lifecycle events this system
ingests (DESIGN §5). When a session's context is compacted, a naive costing scheme that
only tracks a running total risks silently corrupting history — this is exactly the
"compaction sleeper" the source analysis flags: getting the compaction-baseline graft
wrong "means silently wrong dollar figures" (concept-analysis.md §3.3), which is why
"compaction-mid-session and PreCompact re-pricing" was added as a dedicated regression
case on top of the ten EXPANDED §7.1 negative scenarios (concept-analysis-v2 §6, Tree
correctness).

The fix is structural, not a patch: `token_usage` **preserves the pre-compaction
baseline** rather than discarding it (DESIGN §4), and the CostEngine reprices against
that preserved baseline plus the post-compaction spend:

> **Compaction-baseline preservation + RE-pricing across PreCompact.** A PreCompact
> session reprices to baseline + post-compaction spend, matching the oracle.
> (development plan `WP-C4`)

The MVP acceptance criterion states the outcome directly: **"a session that hit
PreCompact still reprices correctly against its preserved baseline"**
(concept-analysis-v2 §6, Cost). This is also called out as one of the two v1-only test
cases added on top of the negative-test catalogue (compaction-mid-session and
PreCompact re-pricing — concept-analysis-v2 §4.3).

**What is genuinely undecided:** whether the JSONL transcript itself carries
pre/post-compaction markers precise enough to reconstruct the baseline after the fact,
or whether the baseline must be **snapshotted at hook time** instead, is an open
Phase-0 question (`G0.2b`, concept-analysis-v2 §7, question 4). Until that probe runs,
treat "compaction reprices correctly" as the target contract, not a confirmed
implementation mechanism.

## 7. Delegation-savings: quantifying Haiku/Sonnet routing

The moat backlog names this explicitly as a build target, not a nice-to-have (DESIGN
§2, item 2):

> **Live dollar-cost attribution + delegation-savings** (Haiku/Sonnet routing vs
> top-tier). Borrow `cast`'s ~50-LOC formula.

The pattern being borrowed — the *idea*, re-priced clean-room, never the source code
(see [§8](#8-licensing-clean-room-not-copy-paste) below) — is scoped explicitly in the
implementation plan's Phase-3 delegation-savings tile, which names `cast`'s `analytics.ts`
as the (never-copied) source of the idea:

> Delegation-savings metric — reimplemented clean-room from cast's idea (all-rights-
> reserved; do **not** copy `analytics.ts`): conservative `max(0, sonnetEquiv −
> actualHaiku)` off ground-truth JSONL tokens.
>
> — implementation-plan.md, Phase 3 — Delegation-savings tile

agenthropic's version generalizes the two-model comparison into a top-tier re-price
across whatever model actually ran (development plan `WP-C5`, Track C):

> **Delegation-savings metric** (clean-room, tied to the model-routing decision).
> Savings = **Σ max(0, top-tier-equiv − actual)**, matching a hand check.

In formula form, per session or agent:

```
delegation_savings = Σ over each token_usage row r where r.model_id != top_tier_model:
                        max(0,
                            PricingProvider.rateFor(top_tier_model, r.bucket…, r.recorded_at) × r.tokens
                            − PricingProvider.rateFor(r.model_id,    r.bucket…, r.recorded_at) × r.tokens
                        )
```

This is the direct dual-price extension the roadmap names for the delegation-savings
tile — "**Dual-price `token_usage` (actual vs top-tier)** → quantify Haiku/Sonnet
routing savings" (DESIGN §9). Note that the development plan's reconciled Phase
sequencing lands the whole cost engine — including delegation-savings (`WP-C5`) —
in **Phase 3** (Track C, development-plan §3), which supersedes DESIGN §9's earlier
draft placement of "delegation-savings tile" as a standalone Phase 4 item; treat
`development-plan.md` as the canonical phase numbering per its own provenance note.

**A named risk, and its mitigation.** concept-analysis-v2 flags this metric directly as
a vanity-metric risk: "delegation-savings risks being a vanity metric unless the
decision it informs is named" (§5, Weaknesses). The mitigation on record is to tie the
figure to a concrete routing decision rather than display it as a standalone number —
"tie delegation-savings to the named routing decision (`WP-C5`) so it isn't vanity"
(best-path-decision.md §6, item 6) — i.e., the metric must inform *whether* to route a
given workload to a cheaper model, not merely decorate a dashboard tile.

## 8. Licensing: clean-room, not copy-paste

`cast`'s delegation-savings formula is a pattern worth stealing; its **source code is
not**. `cast` carries no `license` field and no LICENSE file — "MIT" appears only as a
README badge, which under Berne convention makes it **all-rights-reserved by default**
(concept-analysis.md §6.2; concept-analysis-v2 CD-9). The canonical rule:

> CLEAN-ROOM reimplement `cast` `controlGate` + delegation-savings and `nirdiamant`
> checkpoint (never view their source while writing). Enforced by a CI
> provenance/license scan. (concept-analysis-v2 CD-9)

This is enforced structurally, not by policy alone — a CI license/provenance scan is a
build-failing gate (development plan `WP-F6`; Phase 1 exit gate: "no-spawner/no-SSRF/
license gates green"). Full rule and enforcement detail: [licensing &
provenance](../contributing/licensing.md).

## 9. The no-priceless-model-fails-CI rule

This is the rule the task scope names directly, and it is the load-bearing test that
makes every other guarantee on this page trustworthy rather than aspirational. Two
equivalent statements of it appear across the source material:

- CD-4's acceptance criterion: **"a fixture model with no price row FAILS CI;
  `model_pricing` is versioned (`effective_from`/`verified_on`)"** (concept-analysis-v2
  §6, Cost).
- The development-plan work package that implements it (`WP-C6`, Track C, owner `qa`):

  > **Staleness-fails-CI gate.** A model+bucket in the golden corpus with no priced
  > row → **red build**.

The design intent is explicit that this must be a **build failure**, not a runtime
degradation: "silent staleness is a red build, not a runtime 'estimated' label"
(concept-analysis-v2 §3, `H-COST`). Concretely, `WP-C6` depends on `WP-C1`/`WP-C2`
(the pricing table + resolver) and `WP-X1`/`WP-X5` (the golden fixture corpus and the
CI coverage gate) — every model+bucket combination that appears in the golden fixture
corpus must resolve to a priced row, or the merge is blocked (Phase 3 exit gate,
development-plan §3: "no priceless model" is one of the named, merge-blocking release
criteria alongside the three P0 reconciliation tests).

## 10. Read surface (roadmap, not yet built)

The cost figures this page describes are computed server-side; nothing here is a
client-side estimate. The planned read surface (all Phase 3–4, not yet built):

| Work package | Track | What it exposes |
|---|---|---|
| `WP-C7` | cost (backend) | Cost query API — TypeBox-validated, loopback+token-gated cost/savings endpoints; "figures match direct engine calls (no drift)." |
| `WP-U4` | backend | Cost, delegation & global-DAG read endpoints (daily question 2/4); "cost matches JSONL × versioned pricing; no API-side inference." |
| `WP-U9` | frontend | Cost / Sankey / delegation-savings view; "every displayed dollar traces to ground-truth tokens × dated price." |

These endpoints inherit the same security posture as every other write/read surface in
the system — loopback bind, mandatory `timingSafeEqual` token, same-origin SSE (see
[security model](../security/model.md)) — there is no cost-specific exemption.

## 11. Why this needs no `ANTHROPIC_API_KEY`

The cost model is a pure computation over data already resident in SQLite —
ground-truth token counts from `token_usage` and dated rates from `model_pricing`. It
makes no live API calls to price anything, so it does not need the Anthropic API key in
the dashboard's environment at all. This aligns with the standing security rule: "don't
hold `ANTHROPIC_API_KEY` in the dashboard's env unless a feature truly requires it"
(DESIGN §8), reaffirmed by CD-10 ("`ANTHROPIC_API_KEY` stays out of the dashboard env
entirely" — the only feature that would need it is the labeled-experimental vector-DB
track, which is off the critical path per the roadmap).

## What's undecided

This is a design-basis page, not a shipped-system page. Stated explicitly rather than
glossed over:

- **The authoritative pricing source and refresh cadence** are unresolved
  (concept-analysis-v2 §7, question 7) — `WP-C1` owns the dated seed, but where those
  dated rates come from and how often they are re-verified is not yet decided.
- **The compaction-baseline mechanism** (whether JSONL carries usable pre/post markers,
  or the baseline must be snapshotted at hook time) is a Phase-0 probe
  (`G0.2b`), not yet answered — see [§6](#6-compaction-baseline-repricing).
- **The exact `token_usage` and `model_pricing` DDL** (column names, types, indices) is
  not written anywhere in the source docs yet; the sketches in [§2](#2-token_usage-bucketed-by-whatever-changes-the-rate)
  and [§3](#3-model_pricing-a-dated-table-not-a-hardcoded-constant) are illustrative,
  not authoritative — that is `WP-D8` and `WP-C1`'s deliverable.
- **The decision delegation-savings is meant to inform** is named as a risk
  ("vanity metric unless the decision it informs is named," concept-analysis-v2 §5) with
  a stated mitigation (tie it to `WP-C5`'s routing decision, best-path-decision.md §6)
  but not yet a concrete, shipped decision rule.
- **Phase numbering has drifted between documents.** DESIGN §9's original roadmap table
  places the delegation-savings tile at a standalone Phase 4; the reconciled
  `development-plan.md` folds the entire cost engine into Phase 3. Treat the
  development plan as canonical (its own provenance note records it as the
  adversarially-verified, post-reconciliation source).

## See also

- [Architecture overview](../architecture/overview.md) — the full ingest loop and the
  two governing invariants (ground-truth tokens; persisted agent hierarchy).
- [Data model](../architecture/data-model.md) — full annotated DDL for `agents`,
  `sessions`, `events_raw`/`events`, `token_usage`, `orchestration_edges`.
- [Ingest & reconciliation](../architecture/ingest-reconciliation.md) — the
  reconciliation precedence (CD-3) that governs how `token_usage.agent_id` gets
  backfilled.
- [The DAG moat](../architecture/dag-moat.md) — the sibling persisted-data-fact
  artifact (`orchestration_edges`) built on the same `events_raw` substrate.
- [Security model](../security/model.md) — loopback bind, mandatory token, same-origin
  enforcement that also gates every cost read endpoint.
- [Licensing & provenance](../contributing/licensing.md) — the clean-room rule that
  governs the delegation-savings formula specifically.
- [Roadmap](../guide/roadmap.md) — phase sequencing for the cost-engine work packages.
