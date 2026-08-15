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

> **Update — 2026-07 (as built).** The cost engine is real: pure functions in
> `packages/core/src/cost` (`compute-cost.ts`, `compaction-repricing.ts`,
> `delegation-savings.ts`), the pricing table in migration 7, and a served read surface
> (`GET /api/sessions/:id/cost-analysis`, `GET /api/cost/summary`). The equation held —
> every dollar is tokens × a dated price — but four details landed differently than
> this page sketches:
>
> - **The buckets are token buckets, not routing dimensions.** Real JSONL does not
>   carry `speed`/`inference_geo`/`service_tier`; `token_usage` buckets by what the
>   transcripts actually record — `input`, `output`, `cache_read`, `cache_write_5m`,
>   `cache_write_1h` — one row per `(message_id, bucket)`.
> - **`model_pricing` is dated but has no `verified_on` column**: primary key
>   `(model, bucket, effective_from)`, rates in USD per Mtok. The seed is
>   **PROVISIONAL** — approximate list prices, floor-dated — not a verified feed.
> - **Staleness is a runtime halt, not (yet) a CI gate.** A model or bucket with
>   nonzero tokens and no resolvable price raises `PricingError`: at ingest this halts
>   **before any row is written**, and at the API it surfaces as a `422` — never a
>   silent `$0`. Read-side aggregates additionally surface tokens that resolve to no
>   dated rate as `unpricedTokens` (contributing `$0`, visibly). Whether the `WP-C6`
>   staleness-fails-CI gate is wired as a merge-blocking CI job has **not been
>   verified** — treat the CI-gate claims below as design intent.
> - **Compaction (G0.2b) resolved toward JSONL**: boundaries are parsed from the
>   transcript substrate itself; the `PreCompact` hook contributes liveness only.
>   Delegation savings shipped with its honesty labels: a literal `isEstimate: true`
>   and `skippedAgentIds` for agents it refuses to guess a model for.

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

*(As built, the picture's shape holds with two label changes: the bucketing column
reads `input / output / cache_read / cache_write_5m / cache_write_1h` rather than
speed/geo/tier, and `model_pricing` carries `effective_from` only — no `verified_on`.
`agent_id` is attributed in the parser before the write, not backfilled.)*

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

> **As built, the table above is design history.** The real corpus's `usage` blocks do
> not carry `speed`/`inference_geo`/`service_tier` at all — the dimensions that
> actually change the rate in the transcripts are the **token buckets** themselves:
> `input`, `output`, `cache_read`, `cache_write_5m`, `cache_write_1h`. Migration 6
> (`apps/server/src/db/migrations.ts`) stores one row per `(message_id, bucket)` —
> long format, `UNIQUE (message_id, bucket)`, because naive row summation over-counts
> roughly 2.4× (parser-spec §5.2):
>
> ```sql
> CREATE TABLE token_usage (
>   id                      INTEGER PRIMARY KEY,
>   session_id              TEXT NOT NULL,
>   agent_id                TEXT,
>   message_id              TEXT NOT NULL,
>   model                   TEXT NOT NULL,
>   bucket                  TEXT NOT NULL CHECK (bucket IN ('input','output','cache_read','cache_write_5m','cache_write_1h')),
>   tokens                  INTEGER NOT NULL,
>   is_compaction_baseline  INTEGER NOT NULL DEFAULT 0,
>   occurred_at             TEXT,
>   UNIQUE (message_id, bucket)
> );
> ```
>
> `tokens` is copied verbatim from JSONL — the never-inferred rule shipped intact.
> `agent_id` is nullable, but there is no post-write backfill pass: attribution happens
> **inside the parser** via the hard join (parser-spec §5.1), before any row is
> written, and a `NULL` means genuinely unattributable.
>
> One column in that DDL does nothing, and is documented rather than quietly implied to
> work: **`is_compaction_baseline` is dead** (implementation review 2026-08-09, finding
> L-7). The writer inserts a literal `0` into it and no read path anywhere consults it —
> compaction is handled entirely by the repricer over parsed boundaries ([§6](#6-compaction-baseline-repricing)),
> not by a flag on a row. It survives because dropping a column costs a full table
> rebuild for no behavioral gain; what it must not do is mislead a reader into thinking a
> baseline flag is what makes compaction repricing work.

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

The authoritative DDL is migration 6, quoted in the as-built note above — the
illustrative wide-format sketch this page originally carried (per-dimension columns,
`compaction_baseline_id`, an FK to `agents`) never became the real table.

The ingest work that populates this table shipped as the parser writing projections
directly (see [ingest & reconciliation](../architecture/ingest-reconciliation.md)):
tokens copied **verbatim** — no inference — and "Σ `token_usage` per session ==
JSONL exact" is one of the three P0 release-blocker tests, built and green in the
server suite.

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

The real table is migration 7 (`model-pricing-with-seed`):

```sql
CREATE TABLE model_pricing (
  model          TEXT NOT NULL,
  bucket         TEXT NOT NULL CHECK (bucket IN ('input','output','cache_read','cache_write_5m','cache_write_1h')),
  usd_per_mtok   REAL NOT NULL,
  effective_from TEXT NOT NULL,
  PRIMARY KEY (model, bucket, effective_from)
);
```

Multiple `effective_from` rows can exist for the same `(model, bucket)` without
conflict — that is the whole point of dating the table, and the composite primary key
enforces it. Two honest departures from the CD-4 sketch:

- **`verified_on` was not built.** The re-verification stamp lives in the seed's
  source comment and its PROVISIONAL label, not in a column.
- **The seed rates are approximate list prices, floor-dated** — a single
  `PRICING_SEED_EFFECTIVE_FROM` (`2026-01-01`) for every seeded row, deliberately earlier
  than the oldest transcript on disk so no historical message can fall off the front of
  the dated lookup — with cache buckets derived from the input rate (`cache_read` = 0.1×,
  `cache_write_5m` = 1.25×, `cache_write_1h` = 2.0×) and a `'<synthetic>'` model priced at
  zero so synthetic rows never halt pricing. The seed is **PROVISIONAL**: the model ids
  were checked against the real corpus (2026-07-13), the dollar figures were not
  independently verified.
- **A later migration converged the seed rather than editing it.** An applied migration is
  immutable — the runner records a content checksum per migration and refuses to start if
  one changed — so widening the seed's coverage required migration 11 to re-apply it
  idempotently, with the seed values duplicated inside that migration so its own checksum
  covers them. [The data model](../architecture/data-model.md) carries the full seed table,
  the coverage counts it was verified against, and the migration-checksum mechanism.

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

> **As built:** exactly this lookup shipped, twice. `resolveRate` in
> `packages/core/src/cost/compute-cost.ts` picks the latest `effective_from` at or
> before the usage row's `occurred_at` for the exact `(model, bucket)`; the read-side
> SQL in `apps/server/src/api/queries.ts` performs the same dated join. A bucket with
> **zero** tokens needs no price row; a bucket with nonzero tokens and no resolvable
> rate raises `PricingError` in the engine — and in the read aggregates is surfaced as
> `unpricedTokens` rather than silently priced.

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

> **As built:** `computeCostUsd` is a pure function (no DB imports) in
> `packages/core/src/cost/compute-cost.ts`, and it doubles as the ingest **halt gate**:
> `apps/server/src/ingest/ingest-session.ts` prices the parsed session *before* opening
> the write transaction, so a `PricingError` means **no row of any kind is written** —
> a session is never persisted with silently unpriceable tokens. The same error
> surfaces as a `422` from `GET /api/sessions/:id/cost-analysis`.

## 6. Compaction-baseline repricing

`PreCompact` is one of the twelve (nine confirmed, per the hook-catalog caveat — see
[hook ingestion](../architecture/hooks.md); as built it is one of the **four** hooks
the installer actually registers) Claude Code lifecycle events this system
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

> **Resolved as built: the JSONL branch won.** Compaction boundaries are detected in the
> parsed transcript substrate itself — no hook-time snapshot exists, and the `PreCompact`
> hook contributes a liveness timestamp only. Note that no row is *flagged* as a baseline:
> `token_usage.is_compaction_baseline` is a dead column ([§2](#2-token_usage-bucketed-by-whatever-changes-the-rate)),
> and the whole mechanism lives in the repricer
> (`packages/core/src/cost/compaction-repricing.ts`), which cuts each transcript's usage
> stream at its own boundaries and prices the segments.

Three segmentation rules are settled, and one of them was open when this page was first
written:

- **Boundaries are per-transcript.** A boundary with a `null` agent id cuts only the main
  agent's usage stream; a boundary carrying an agent hex cuts only that subagent's stream
  (compaction mid-agent).
- **A usage row timestamped exactly *at* a boundary belongs to the segment the boundary
  opens** — the boundary record precedes the usage that follows it. This is the sub-question
  the earlier text left open; it is now decided, in code and in test.
- **Every transcript that carries usage or boundaries emits all `boundaryCount + 1`
  segments, empty ones included**, so a reset that recorded no priced usage stays visible
  instead of vanishing from the breakdown.

The result deliberately exposes both figures — `naiveUsd` (the boundary-blind single-pass
sum, which is exactly `computeCostUsd`) and `repricedUsd` (the sum of per-segment costs) —
so that their difference is inspectable rather than assumed. **That difference is the exit
gate.** On a complete, correctly deduped substrate the per-message usage rows are ground
truth and cost is linear over them, so `deltaUsd` *must* be ~0 within floating-point
epsilon. A materially nonzero delta means rows were lost or double-assigned during
segmentation; it is a loud mispricing signal, never something to average away. What the
segmented view buys over the naive sum is not a different total but the breakdown: where
each context reset falls, the `preTokens` baseline it preserved, and how much spend belongs
to each cache lineage.

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

> **As built:** shipped in `packages/core/src/cost/delegation-savings.ts` with the
> conservative formula intact — savings = Σ `max(0, hypothetical − actual)` per agent —
> and served through `GET /api/sessions/:id/cost-analysis`. The honesty labels are
> structural, not cosmetic: the result carries a literal `isEstimate: true` type (it can
> never be reported as a measured number), agents whose model cannot be established are
> listed in `skippedAgentIds` rather than priced against a guess, and `'<synthetic>'`
> rows keep their own (zero-rate) model instead of being re-priced at top tier.

**Which model counts as "top tier" is answered per subagent, not globally.** The plan left
this free; the implementation resolves it in three steps. An explicit `topTierModel` wins —
the caller names the routing alternative being measured, and the API exposes it as an
optional query parameter on `GET /api/sessions/:id/cost-analysis`. Otherwise the model is
*derived* from the subagent's nearest ancestor that actually has usage: walk `parentAgentId`
upward (main-agent usage carries a `null` agent id) behind a defensive cycle guard, and take
that ancestor's settled model — the model of its greatest-`output` usage row, following the
message-id dedup convention. And if the ancestor chain yields no model at all — an orphan, a
dangling parent pointer, a cycle — that subagent has **no observable routing decision**, so
it is excluded from the sums and named in `skippedAgentIds`. That is the same refusal the
rest of the system makes: the number omitted is more useful than a number invented.

The estimate label is earned rather than decorative. The hypothetical carries the subagent's
actual cache-read/cache-write profile over unchanged, but had the work truly run inline the
parent's cache lineage would have differed in both directions — more cache reads over a
bigger prefix, no separate context warm-up, possibly earlier compaction — and no ground truth
for that counterfactual exists anywhere in the substrate.

> **Known arithmetic caveat (implementation review 2026-08-09, finding L-8).** The
> `max(0, …)` clamp is applied **per agent** before summing, so the reported total is the sum
> of non-negative per-agent terms, not `max(0, Σ hypothetical − Σ actual)`. The two differ
> whenever some delegation cost *more* than its top-tier equivalent would have: those agents
> contribute 0 instead of a negative offset, which makes the headline figure
> optimism-leaning by construction. This matches the plan's "conservative
> `max(0, sonnetEquiv − actualHaiku)`" wording read per-term, and it is recorded here rather
> than silently reconciled — the per-agent breakdown is served alongside the total precisely
> so a reader can do the other arithmetic.

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

> **As built — an honest status split.** The *runtime* half of this rule is built and
> test-proven: a priceless model with nonzero tokens raises `PricingError`, which halts
> ingest before any write and returns `422` from the cost API — strictly stronger than
> a runtime "estimated" label. The *CI* half — a dedicated staleness gate that turns a
> priceless fixture model into a red build (`WP-C6`) — has **not been verified as wired
> into CI** at the time of this update; until that is confirmed, treat "staleness fails
> CI" as design intent backed by the runtime halt, not as an observed CI behavior.

## 10. Read surface (as built: shipped)

The cost figures this page describes are computed server-side; nothing here is a
client-side estimate. The read surface is now real: `GET /api/cost/summary`
(per-model and per-session dollar totals, with `unpricedTokens` surfaced) and
`GET /api/sessions/:id/cost-analysis` (compaction-aware repricing plus
delegation savings, `isEstimate` visible), both in `apps/server/src/api/routes.ts`,
plus the SPA cost view built over them. The work packages as planned:

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

This was a design-basis page; the list below records what was open when it was
written, with the as-built resolution appended to each item:

- **The authoritative pricing source and refresh cadence** are unresolved
  (concept-analysis-v2 §7, question 7) — `WP-C1` owns the dated seed, but where those
  dated rates come from and how often they are re-verified is not yet decided.
  *Still open:* the shipped seed is approximate list prices, explicitly PROVISIONAL;
  no authoritative feed or cadence exists yet.
- **The compaction-baseline mechanism** (whether JSONL carries usable pre/post markers,
  or the baseline must be snapshotted at hook time) is a Phase-0 probe
  (`G0.2b`), not yet answered — see [§6](#6-compaction-baseline-repricing).
  *Resolved:* boundaries are parsed from the JSONL substrate; no hook-time snapshot. The
  once-open boundary tie-break is decided too — a row timestamped at a boundary belongs to
  the segment that boundary opens — and the `deltaUsd ≈ 0` reconciliation invariant is the
  gate that keeps the segmentation honest.
- **The exact `token_usage` and `model_pricing` DDL** (column names, types, indices) is
  not written anywhere in the source docs yet; the sketches in [§2](#2-token_usage-bucketed-by-whatever-changes-the-rate)
  and [§3](#3-model_pricing-a-dated-table-not-a-hardcoded-constant) are illustrative,
  not authoritative — that is `WP-D8` and `WP-C1`'s deliverable.
  *Resolved:* migrations 6 and 7 are written and quoted on this page.
- **The decision delegation-savings is meant to inform** is named as a risk
  ("vanity metric unless the decision it informs is named," concept-analysis-v2 §5) with
  a stated mitigation (tie it to `WP-C5`'s routing decision, best-path-decision.md §6)
  but not yet a concrete, shipped decision rule. *Still open:* the metric ships with
  `isEstimate`/`skippedAgentIds` honesty labels, but no automated routing decision
  consumes it yet.
- **Phase numbering has drifted between documents.** DESIGN §9's original roadmap table
  places the delegation-savings tile at a standalone Phase 4; the reconciled
  `development-plan.md` folds the entire cost engine into Phase 3. Treat the
  development plan as canonical (its own provenance note records it as the
  adversarially-verified, post-reconciliation source). *Moot as built:* the 2026-07
  implementation wave landed the cost engine and its read surface together.

## See also

- [Architecture overview](../architecture/overview.md) — the full ingest loop and the
  two governing invariants (ground-truth tokens; persisted agent hierarchy).
- [Data model](../architecture/data-model.md) — full annotated DDL for `agents`,
  `sessions`, `events_raw`/`events`, `token_usage`, `orchestration_edges`.
- [Ingest & reconciliation](../architecture/ingest-reconciliation.md) — the
  reconciliation precedence (CD-3) behind `token_usage.agent_id`, and the pipeline order
  that makes pricing a halt gate before any write.
- [The DAG moat](../architecture/dag-moat.md) — the sibling persisted-data-fact
  artifact (`orchestration_edges`) built on the same `events_raw` substrate.
- [Security model](../security/model.md) — loopback bind, mandatory token, same-origin
  enforcement that also gates every cost read endpoint.
- [Licensing & provenance](../contributing/licensing.md) — the clean-room rule that
  governs the delegation-savings formula specifically.
- [Roadmap](../guide/roadmap.md) — phase sequencing for the cost-engine work packages.
