# Phase-0 feasibility spike — verdict (WP-S7, Lane S7)

> **Deliverable status:** this is the **WP-S7 verdict record**, the first KC-1 clause
> (roadmap §4, `roadmap-v1-v2-2026-07-06.md`). Written **2026-07-10**, ahead of the
> KC-1 due date **2026-07-27**. It synthesises the six completed spike lanes (WP-S1…S6)
> and issues the go/no-go call for the technical feasibility spike.
>
> **Central caveat, stated once, up front:** every lane result below is **PROVISIONAL /
> self-check**. The machine-derived trees are scored against each session's
> `capture-manifest.json` inventory and against each other across redundant durable join
> paths — **not** against Ivan's human ground truth. The five `LABEL-ME.md` files (224
> per-edge blanks) are **still blank**. "100%" everywhere means *the reconstruction
> agrees with the machine inventory and with itself*, not *proven against what actually
> happened*. That gap is closed only by WP-S5 human sign-off, and it is exactly what the
> verdict below is made conditional on.

> **Status of the condition, checked 2026-08-15: still unmet.** The five
> `spike/corpus/sessions/<short>/LABEL-ME.md` files still hold their per-edge blanks —
> the machine-derived rows are there, the human column beside each hex id is still
> `__________`. Every number in this document therefore remains **PROVISIONAL / self-check**
> five weeks after it was written, and the ≥95% hierarchy-accuracy gate reports
> **NOT CERTIFIED**. What did happen in the meantime is that **implementation began on
> 2026-07-11 by explicit owner override of CD-8**. The override released dispatching; it did
> not discharge this condition, and nothing about a shipped parser converts a self-check into
> a human-verified one. The one substantive technical change since: the parser now implements
> **all fourteen** gate items rather than thirteen — §3's "#7 (legacy 2.1.70) absent" was
> closed by a defensive fallback carrying its own `legacy_explore` provenance — but that shape
> is still **unwitnessed in the real corpus** and its scope is itself PROVISIONAL. See
> [parser-spec.md](parser-spec.md) §3, which separates implemented from measured for exactly
> this reason.

---

## 1. Verdict — CONDITIONAL GO

**CONDITIONAL GO. Confidence: high (~90%) on technical feasibility** — up from the
2026-07-04 desktop probe's CONDITIONAL-GO at confidence 85 (`phase0-probe.md`).

**One-paragraph reason.** The spike attacked the single load-bearing risk of the whole
project — *can the subagent tree and its dollar cost be reconstructed from the durable
`~/.claude/projects/*.jsonl` substrate alone, with no dependence on live hooks?* — and
answered **yes, mechanically, with zero inference**, on a five-session / 224-agent corpus
deliberately loaded with the four hostile pathologies (post-compaction eviction, live
crash/no-Stop snapshot, genuine same-slug concurrency, dual-layout depth-2). Edge
reconstruction is **100% on all five sessions**; token→agent attribution is a **hard
field-read (6654/6654)**, not a heuristic join; parent-rollup double-counting is
**provably 0.00%**; and the reconstruction reads **0 of 463 inputs from a hook** — so the
durable outbox stays deferred and CD-1 lands on **JSONL-PRIMARY**. Hooks are confirmed a
latency optimisation, not a data source (`SubagentStart` is not even a real Claude Code
hook). The technical moat is real and derivable.

**The precise condition.** This is a **self-check** verdict, not a human-verified one.
The GO is conditional on **WP-S5 human sign-off**: Ivan filling the per-edge ground truth
in the five `spike/corpus/sessions/<short>/LABEL-ME.md` files (and the top-level
`IVAN-SIGNOFF.md` tick-boxes) and confirming that the machine-derived trees match what
actually happened. Until then `edge_accuracy` is *self-check 100%*, not *human-verified
100%*. The pathology coverage and the agreement of multiple redundant durable join paths
make a mislabel unlikely — which is why the confidence is high and the expected outcome
of sign-off is ratification — but the machine cannot close this gap for itself, and the
verdict is honest about it. **If Ivan re-parents any edge, these numbers move.**

**Scope of the confidence.** The 90% is on *technical* feasibility only. The spike
**de-risks the build; it does not satisfy the governance checkpoints** — those remain
Ivan's acts (see §7). Two honest limits also bound the technical claim: **depth is capped
at 2 corpus-wide** (11 depth-2 edges across 2 sessions, no depth-3 anywhere in 1,352
metas — deeper/wider trees are unmeasured because the data does not exist), and the
**"crash" pathology is a live-snapshot proxy**, not a recovered historical crash (a
deliberate kill-mid-run test is still unrun).

---

## 2. Evidence table — one row per lane

| Lane | What it tested | Measured result (self-check) | vs pre-spike assumption |
|---|---|---|---|
| **S1** — corpus | Assemble a paired-capture corpus exercising the 4 required pathologies + the 11-item parser gate. | **5 sessions, 224 agents, 3 projects.** 10 of 11 gate items exercisable; only #7 (legacy 2.1.70) absent. Depth capped at 2 corpus-wide (metas: `{1: 1339, 2: 11, none: 2}`). "Crash" is a live in-flight snapshot proxy, not a historical crash. | **Confirms & strengthens** the probe: depth-2 now witnessed by 2 independent sessions (11 edges) not 1; crashes still ~nonexistent historically. |
| **S2** — ingest primacy (CD-1, LB1) | Reconstruct the tree from JSONL alone (no hook, no outbox); survive a simulated outage. | **edge_accuracy = 100% on all 5 sessions.** Outage-survival: **0 / 463 reconstruction inputs hook-sourced**; every pathology loses a different signal and the union still resolves 100%. Discovered `<task-notification>` as a 3rd durable flat join path (compaction backfill). | **Confirms → CD-1 = JSONL-PRIMARY.** Durable outbox stays **deferred** (CD-2/CD-3 kept, WP-IN11 freed). Ratifies the 07-04 probe's CONDITIONAL-GO on a real corpus. |
| **S3** — join key (CD-3, G0.1b) | Is token→agent_id a hard key or an inference? Is the spawn edge a hard join? | **Layer A: token-usage row → agentId = 6654 / 6654 = 100% HARD KEY, 0 heuristic** (inline `agentId` == filename hex). **Layer B: spawn edge = 224 / 224 HARD** across 3 structural schemas (`parser-spec.md` §4 resolves the full taxonomy into four ordered join paths by counting the `<task-notification>` recovery separately — "3 schemas" here and "4 join paths" there describe the same closure). Discovered `queue-operation` needed for `run_in_background` spawns. Substring-join proven unsafe (concrete false-link case). | **Confirms → CD-3 is a HARD JOIN, not confidence-scored inference.** Token attribution is not even a join — it is a direct field-read cross-checked against the filename. |
| **S4** — hook liveness | Do the hooks the design once eyed actually fire? Are they gating? | **NON-GATING.** Only `UserPromptSubmit` leaves a footprint (37 structural firings). **`SubagentStart` is not a real CC hook — never fires.** Compaction is read from JSONL-native `compact_boundary`+`compactMetadata` (30, all `trigger=auto`), never a PreCompact hook. | **Confirms & reinforces CD-1.** Hooks buy latency, not correctness. Any live-freshness feature on an unobserved hook degrades to a JSONL re-scan — a design fact, not a risk. |
| **S5** — tree smoke gate + EMP-1 | Independently re-validate S2's trees; resolve intra-workflow sibling ordering (#11). | **Smoke gate PASS 5/5**: zero determinism drift (byte-identical re-emit), 100% internal consistency on every check, concurrency-independence proven (`69ac12d0` vs `a362e15d` = two roots, **empty hex intersection, 0 cross-edge**). **EMP-1 = PARTIALLY RECOVERABLE** (see §3, item #11). | **Confirms** S2 independently; **amends** the #11 assumption — sibling order is wave-partial, not total. |
| **S6** — token→cost | Is dollar-accurate cost attribution over the DAG derivable with zero inference? Does the parent double-count children (#6)? | **YES, zero inference.** Item #6 **parent-rollup = 0.00%** in all 5 sessions (disjoint `message.id` sets; `sum(per-agent)+ROOT == session` to <1e-6 USD). Corpus **≈ $345.91 / 206,001,429 tokens / 3,339 deduped messages**. Discovered the dedup-by-`message.id` gate. | **Confirms** tokens-as-ground-truth (design invariant). **Amends** the naive parser: raw row-sum over-counts ~2.4–2.7× ($346 vs ~$900). |

---

## 3. The 11-item parser-requirements gate — final status

Against the CD-1 acceptance gate defined in `phase0-probe.md` §6. **9 of 11 green, #7
absent from the corpus, #11 amended to partial.**

| # | Requirement | Status | Proven by |
|---|---|---|---|
| 1 | Spawn tools `{Agent, Workflow}`, never `Task` | **GREEN** | S2 (0 Task blocks; 39 Agent + 12 Workflow spawn blocks), S5 (`no_task_blocks` 0/5). |
| 2 | Dual-layout directory walker (flat + nested `wf_`) | **GREEN** | S2 (`b24be30c` carries both layouts in one dir; branch on directory shape). |
| 3 | Multiple join schemas (flat `toolUseId`; nested `wf`-dir + `sessionId` anchor) | **GREEN (+2 discovered)** | S2 (+`<task-notification>`) and S3 (+`queue-operation`). See §4. |
| 4 | Self-referential parent index (depth-2) | **GREEN (thin)** | S2 / S5 (`b24be30c` 6/6, `f28af3fd` 5/5, parents are agent-hex not ROOT). Thin: 11 edges / 2 sessions, **no depth-3**. |
| 5 | Structural block-id equality only (no substring grep) | **GREEN** | S2 (cross-file id collisions quantified) and S3 (`substring_check.py` shows a concrete false link a grep-join would mint). |
| 6 | Token summation from child transcripts, no parent rollup | **GREEN** | S6 (parent-rollup 0.00% in all 5; disjoint `message.id` sets). |
| 7 | Legacy `2.1.70` bare-`Explore` fallback | **ABSENT from corpus** | Not in these 5 (versions are 197/199/201/205). S1 pointer: `site/08871133-82a3-4ae2-8303-781a8761e92a` (2 bare-Explore metas) — capture separately if #7 must be closed. |
| 8 | Compaction handling (context resets) | **GREEN** | S2 (`f28af3fd`: PreCompact evicted 3 spawn blocks, recovered via `<task-notification>`), S4 (`compact_boundary` is JSONL-native). |
| 9 | Concurrency-safe ingest (key on `session-uuid`, not one-per-slug) | **GREEN** | S2 / S5 (`69ac12d0` vs `a362e15d`: two roots, empty hex intersection, 0 cross-edge; a slug-keyed ingester would fuse 160 agents). |
| 10 | CC-version detection, but branch on directory shape | **GREEN** | S1 / S2 (4 versions; layout orthogonal to version — `b24be30c` runs both layouts on one version). |
| 11 | Intra-workflow edges via `journal.jsonl` + `promptId` (EMP-1) | **AMENDED → PARTIAL** | S5 (see below). |

**#11 / EMP-1 — the amendment.** The original gate assumed `journal.jsonl` + `promptId`
would yield a **total order** of siblings inside a workflow. **That assumption is
amended.** S5 measured it and found sibling order is deterministically recoverable **only
to dispatch-wave granularity**, not to a per-agent ordinal:

- `promptId` is a **whole-batch key, not an ordinal** — every member of a workflow shares
  one `promptId` (it identifies which prompt turn fired the batch, not the position
  within it). `parentUuid` is `None` for every nested agent; journal `key` is a content
  hash. **No explicit sequence field exists in the substrate.**
- The two temporal signals (transcript first-record `timestamp`, journal `started`
  line-order) **agree except among near-simultaneous starts**: across 10 workflows the
  **max Δt of any inverted pair is 0.003 s** — genuine parallel-dispatch races.
- **Dashboard rule (S5):** order siblings by first-record `timestamp`, and **collapse
  same-wave siblings (Δt below a small epsilon) into an explicitly UNORDERED concurrent
  group** — render a wave, never a false 1-2-3. Do not manufacture a total order; below
  wave granularity there is no fact to recover. Flat layout remains a clean total order
  (parent spawn-block stream order is strictly monotonic).

This is **not a failure** — it is the honest, DAG-correct granularity (`agent → workflow
→ ROOT`, siblings time-ordered into waves), and it matches the probe's §7 fallback.

---

## 4. Three NEW production-parser requirements the spike discovered

None of these three were in the original 11-item gate. Each is load-bearing; each is a
**MUST** for the production parser spec.

1. **`<task-notification>` as a first-class flat join path (S2).** When a PreCompact
   evicts a parent-side spawn `tool_use` block, the flat edge is backfilled from the
   durable child-side async-completion message
   (`<task-id>…</task-id><tool-use-id>toolu_…</tool-use-id>`) still in the top
   transcript. In `f28af3fd`, `tool_use`-only recovers 15/18; the 3 evicted edges come
   back **only** via `<task-notification>`. **This is what makes compaction survivable —
   the production reconstructor MUST treat it as a first-class flat join alongside
   `tool_use.id`.**

2. **`queue-operation` as a 3rd hard join schema for `run_in_background` spawns (S3).**
   Background/queued `Agent` spawns are not resolved by the flat `tool_use.id` path nor
   the nested `wf`-dir path; their edge is carried by the `queue-operation` record's
   `<tool-use-id>` + `<task-id>` tags (task-id == the child hex). **Without this third
   structural schema, spawn-edge resolution does not reach 224/224. The production parser
   MUST implement it as a hard tagged-id join.**

3. **Usage dedup by `message.id` + bucket-and-model-aware pricing (S6).** Claude Code
   writes one JSONL line per content block, and **every line sharing a `message.id`
   carries the identical `usage` block**. Naive row-summation over-counts **~2.4–2.7×**
   (corpus: 8,540 raw usage rows collapse to 3,339 messages — the difference between
   ≈$346 and ≈$900 of phantom spend). Pricing must be **per-model and per-bucket**
   (≈88% of corpus tokens are cheap cache reads at 0.1× input; a flat per-token rate
   would be wildly wrong). **The production token parser MUST dedupe usage by
   `message.id` and price by (model, bucket) — this is a hard correctness gate, not an
   optimisation.**

---

## 5. First velocity data point (KC-1 requirement)

The roadmap has carried **"no data — unmeasurable, nothing has ever been built"**
(§3) as the velocity placeholder. This spike produces the **first real data point**.

- **6 work-packages (WP-S1 … WP-S6 — the full Phase-0 technical spike) completed in a
  single session/day (2026-07-10), run as parallel lanes**, with WP-S7 (this verdict)
  closing the same day.

**Record it plainly, and read it as an optimistic upper bound.** These are **throwaway
spike probes** (`spike/` is git-excluded, no tests, no scaffold, no review, no >90%
coverage bar) — **not production work-packages**. Production WPs carry the full quality
tax (tests, coverage, review, security spine), so real WPs/week will be **materially
lower** than this figure implies. **Do not re-baseline KC-4 off this number directly** —
it is the first calibration point, and a deliberately generous one. The disciplined use
at KC-1 (roadmap §3) is to treat it as the *ceiling*, not the *estimate*.

---

## 6. What still needs Ivan (nothing here is machine-closable)

1. **Fill the five `LABEL-ME.md` (224 per-edge blanks).** This is the **only** thing that
   converts `edge_accuracy` from *self-check 100%* to *human-verified 100%* and satisfies
   the condition on the §1 verdict. Fast path: `spike/tree-gate/IVAN-SIGNOFF.md` is a
   minutes-long top-level confirm; the authoritative per-edge record is each
   `spike/corpus/sessions/<short>/LABEL-ME.md`.
2. **The two physical Step-0 acts for KC-0** (governance, not code): open the friction log
   (best-path §9 start/end dates) **and** install at least one rival dashboard for the
   14-day trial. Neither is something the harness can do.
3. **Adjudicate the EMP-1 intra-wave question:** confirm that a wave-partial ordering
   (siblings time-ordered into waves; same-wave siblings shown as an unordered concurrent
   set) is acceptable for the dashboard — or state the intended strict order, understanding
   the substrate cannot reconstruct it and you would be supplying it from memory.

**Re-checked 2026-08-15: all three are still open.** The `LABEL-ME.md` blanks are unfilled
and every box in `spike/tree-gate/IVAN-SIGNOFF.md` still reads `AWAITING-IVAN`; no friction
log exists anywhere in the repository (if one is being kept outside it, that is invisible
from here and should be linked); and no EMP-1 adjudication has been recorded. This list has
not shrunk in five weeks — which matters more now than it did in July, because the code these
items were supposed to gate has since been written. The items did not become less necessary
by being outrun.

---

## 7. KC dates in scope — what this verdict does and does not satisfy

- **This document is the WP-S7 verdict, the first KC-1 clause, due 2026-07-27.** It is
  written 2026-07-10, ahead of the date. The **second KC-1 clause — the throwaway
  DAG-with-dollars render — also exists** (`spike/token-recon/renders/dag.html`, plus
  per-session `renders/<short>.dag.md`). The **third KC-1 clause** (the 14-day friction
  log not showing a rival answering ≥4 of the 5 daily questions) is **Ivan's, not
  machine-closable** — the log has to run.
- **This verdict does NOT satisfy KC-0 (2026-07-13).** KC-0 requires three governance
  acts — Gate A signed (CD-1…CD-10 + LB1/LB2 dated in `TODO.md`), the friction log
  opened, and a rival dashboard installed. The spike de-risks the *technical* feasibility
  those gates presuppose; it does **not** discharge them. Per roadmap §4, a deferral of
  KC-0 *is* the failure, and every week Gate A slips past 07-13 eats KC-4 buffer
  one-for-one. **KC-0 remains entirely Ivan's to sign.**
- **Honest framing:** the spike moved the *technical* risk from "unproven on paper" to
  "proven on a real corpus, pending human ratification of the trees." The *governance*
  checkpoints (KC-0 acts, the friction-log rival test, Gate A signature) are unchanged
  and are Ivan's alone. This verdict feeds the KC-1 decision; it does not pre-empt it.

---

### Bottom line

**CONDITIONAL GO, confidence ~90% on technical feasibility, conditional on WP-S5 human
sign-off of the machine-derived trees.** CD-1 = JSONL-PRIMARY and CD-3 = HARD JOIN are
both confirmed on the corpus; cost attribution is inference-free with parent-rollup
provably 0%; hooks are non-gating. Three new production-parser MUSTs
(`<task-notification>`, `queue-operation`, dedup-by-`message.id`) and one amended
assumption (EMP-1: wave-partial, not total order) are folded into the parser spec. First
velocity point: 6 spike WPs in one day — an optimistic ceiling, not a production
estimate. The build is de-risked; the governance checkpoints remain Ivan's.
