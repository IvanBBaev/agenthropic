# Phase-0 Corpus Probe — the empirical CD-1 verdict

**The evidence behind CD-1.** The [best-path memo](best-path-decision.md) named one
`do-this-now` action: _run the full-corpus read-only probe and write the CD-1 verdict with real
numbers._ This is that probe, executed against the real `~/.claude/projects/` corpus on this
Mac Mini on **2026-07-04**. It was run as an 8-agent read-only workflow (census → reconstruct →
reconcile → **independent re-verification** → judge; Opus / high effort; 0 errors; ~326k agent
tokens), and its two load-bearing claims were then **re-verified by hand**.

> **CD-1 = `CONDITIONAL-GO` → BUILD.** Confidence **85/100**. JSONL _is_ a trustworthy,
> outage-surviving single source of truth for the persisted subagent DAG and the per-agent
> token ledger — **but only** for a parser that keys on the `Agent`/`Workflow` spawn tools
> (**not** `Task`), walks **both** on-disk layouts, indexes subagents as **parents**, and sums
> tokens **from child transcripts** (parent rollups are effectively absent). Those four are the
> CD-1 acceptance gate, not nice-to-haves.

This probe **corrects three things** the earlier docs asserted — see §4. Every integer below was
computed from disk, not inferred.

> **The census below is a 2026-07-04 snapshot and is no longer the census of record
> (note added 2026-08-15).** The corpus has grown by roughly six weeks of daily use since,
> and the numbers in §1 have moved with it — [parser-spec.md](parser-spec.md) §4.2 holds the
> current figures and is what to quote. Nothing here is retracted: the probe's *verdict* rests
> on structural facts (which spawn tools carry the join key, which layouts exist, where the
> tokens live), and those have held. It is the **magnitudes** that expired, so treat §1 as
> dated evidence rather than as a description of the corpus today. One counting subtlety
> survives the move and is worth carrying across: a subagent-transcript count is not a session
> count, and the two have been confused before — §4.2 states both explicitly.

---

## 1. The corpus (census)

| Metric | Value |
|---|---|
| Project slugs | **17** |
| Top-level session transcripts | **117** |
| Sessions with a `subagents/` dir | **33** (23 flat-only · 7 nested-only · 3 both) |
| Sessions with **zero** subagents | **84 / 117** (72%) — the DAG is **sparse**; optimize for the empty case |
| Subagent transcripts (`agent-*.jsonl`) | **~976–997** (live-growing) — **148 flat + ~849 nested** |
| Nested share | **85.2%** (verified by hand) |
| `*.meta.json` sidecars | **1:1** with agent files (0 missing) |
| Spawn-depth histogram | depth-1 = **968** · depth-2 = **6** · depth-3+ = **0** |
| `agentType` split | workflow-subagent **828** · general-purpose **121** · Explore **27** |
| CC versions (agent lines / all transcripts) | **7 / 13** (`2.1.70` … `2.1.200`; `2.1.197` dominant = 593) |

The corpus **grew while being probed** (this very session spawns workflow-subagents), so
meta-denominator percentages are moving snapshots, not fixed constants — noted wherever it
matters.

## 2. The four CD-1 questions, answered with numbers

### Q1 — Is the depth-1 parent→child edge a HARD key? → **YES, 0% orphan.**
The probe first measured 0.893% orphans (10/1120); the **independent verifier could not
reproduce it and got 0.000%** (0 / 146). Trusting the verifier (safe direction, and stronger):
**all 146 flat `toolUseId`s resolve to a real spawn `tool_use` block** — 140 in the owning
session, 6 inside a _parent-agent_ transcript. Two exact structural keys:
`meta.toolUseId == parent Agent tool_use.id` **and** `filename agent-<hex> == toolUseResult.agentId`.
JSONL is the authoritative substrate; the depth-1 edge is a data fact.

### Q2 — Are depth-2 / nested edges recoverable? → **YES, 100% for the proven populations.**
Two distinct populations were conflated in earlier notes:
- **Genuine depth-2** = only **6** flat Explore grandchildren in a single session (`b24be30c`),
  recovered **6/6** via the _same_ `toolUseId` key — but the key lives **inside a depth-1 agent
  transcript**, so the parent index must be **self-referential** (a session→child-only index
  silently drops them).
- The **~828 "nested" workflow-subagents are all spawnDepth-1**, not depth-2. They carry **no
  `toolUseId`** (0/828) and `parentUuid=null`; they attach to their owning session **844/844
  (100%)** via `sessionId == session-uuid` + `wf_<id>/` directory containment + the parent's
  `Workflow` tool_use.
- **Residual (open gap):** intra-workflow "who spawned whom" _inside_ a `wf_` dir is **not**
  `toolUseId`-keyed and was **not** proven to 100% — it needs a `journal.jsonl` (started/result
  rows) + `promptId` reconstruction. This is the one edge family CD-1 leaves unproven.

### Q3 — Version / layout drift? → **SIGNIFICANT — one parser, two join code paths.**
**7** CC versions across agent lines, **13** across session transcripts; **both** layouts
present. **The key correction:** layout is **not** a version boundary — flat and nested coexist
_within the same versions_. It is driven by the **spawn mechanism**: the `Workflow` tool writes a
nested `workflows/wf_*/` subtree; the `Agent` tool writes flat `agent-*.jsonl`. **A parser must
branch on directory shape, not on `version`.** The `message.usage` token schema is identical
across both, but the **edge join needs two paths** (toolUseId for flat; workflow-journal +
directory for nested).

### Q4 — Token attribution & reconciliation? → **100% attributable; sum from children; parent rollup ≈ 0%.**
Every one of the **~18,213** assistant `message.usage` lines carries an `agentId` → **100%
attributable** (filename hex == internal agentId; 0 unattributable — the 251 zero-token files are
`<synthetic>` stubs, nothing to attribute). **The parent side records nothing to reconcile
against:** async `Agent` spawn tool_results are `async_launched` with **no** token rollup
(0/142); only the 24 synchronously-completed results carry one (**14.5% overall, 0% for the async
majority**). **Σ over child transcripts is the sole exact method** — verdict `NEEDS_SUMMATION`.
Summed totals (internally exact — the model histogram sums to every usage line):

| Tier | Tokens |
|---|---|
| input (non-cache) | **≈ 7.75 M** |
| output | **≈ 5.53 M** |
| cache_creation | **≈ 83.3 M** |
| cache_read | **≈ 584 M** |
| **grand total incl. cache** | **≈ 678 M** |

Models seen: `claude-opus-4-8`, `claude-fable-5`, `claude-sonnet-5`, `claude-haiku-4-5`,
`<synthetic>`.

## 3. Ingest invariants surfaced (not CD-1 blockers, but correctness-critical)

| Invariant | Evidence | Consequence for the ingester |
|---|---|---|
| **Compaction is a context reset** | **63 / 117** sessions carry a compaction/`PreCompact`/summary boundary | Treat `isCompactSummary`/`compactMetadata` lines as resets, not normal turns. |
| **Session wall-clock is NOT an isolation boundary** | **92 / 117** sessions overlap a same-slug sibling; some span up to ~190 h resumed | Key strictly on `session-uuid` + timestamps; never assume one live session per project-slug. |
| **The DAG is sparse** | **84 / 117** sessions never spawn a subagent | Optimize the reader for the empty case; the graph is the exception, not the rule. |
| **Crashes are ~nonexistent historically** | **1** crash-proxy hit — and it is _this live probe session itself_ | The durable-outbox correctness argument has ~no empirical support (see §4c). |

## 4. Three corrections to the earlier docs

**a) The spawn tool is `Agent` / `Workflow`, not `Task`** _(highest-impact — verified by hand:
`Task` blocks = **0**, `Agent` = **142**, `Workflow` = **29**)._ The design digest
(`DESIGN.md`) and prior analysis say "Task tool". **A parser hard-keyed to `name=='Task'`
reconstructs an empty DAG.** This must be encoded in `DESIGN.md`, the reconstructor spec, and a
regression test.

**b) Layout drift is spawn-mechanism-driven, not version-driven.** The best-path memo said the
layout "churns on patch bumps (`2.1.198 → 2.1.199`)." **Wrong** — both layouts coexist within the
same versions; the driver is `Agent`-tool (flat) vs `Workflow`-tool (nested). The parser branches
on **directory shape**. (Version detection is still worth keeping for provenance/telemetry.)

**c) The durable outbox is `YAGNI-leaning`, _not_ load-bearing.** The best-path memo insisted
"do **not** demote `WP-IN11` (durable outbox)." **The evidence downgrades it.** JSONL is an
already-durable, complete, self-reconciling source that Claude writes independently, so state can
always be re-derived by re-reading the tree (backfill). Historical crash rate ≈ 0. The outbox
buys **latency, not correctness**. **Trigger to add it:** a sub-second live-freshness requirement,
_or_ hooks becoming a data source not also present in JSONL. Until then, a periodic / notify-driven
JSONL re-scan suffices and is simpler.
_The memo's other hedges survive intact_ — see §5.

## 5. The load-bearing split (what the evidence proves you must build vs may defer)

| Hedge | Verdict | Why |
|---|---|---|
| **Dual-layout parsing** | 🔒 **LOAD-BEARING (hard)** | **85%** of agents are nested workflow-subagents with **no** `toolUseId`; a single toolUseId-keyed reader recovers only ~15% and drops the entire `Workflow` family. |
| **Child-transcript token summation** _(CD-3 backfill)_ | 🔒 **LOAD-BEARING (hard)** | Parent rollup is 0% for the async majority; tokens live in exactly one place — `message.usage` inside each child transcript. **The summation _is_ the ledger.** |
| **Self-referential parent index** | 🔒 **LOAD-BEARING** | The 6 depth-2 edges resolve only against a depth-1 agent transcript; a session→child-only index drops them. |
| **Durable outbox** _(WP-IN11)_ | 🟡 **DEFERRABLE** (was "keep") | JSONL self-reconciles by backfill; ~0 historical crashes; buys latency not correctness. Add on the trigger in §4c. |

## 6. Parser requirements — the CD-1 acceptance gate

The reconstructor is GREEN only when it satisfies **all** of these (each is forced by a measured
number above):

1. **Match spawn tools on `{Agent, Workflow}`, never `Task`** (input keys `description` /
   `prompt` / `subagent_type`). Zero `Task` blocks exist.
2. **Dual-layout directory walker** — flat `subagents/agent-<hex>.jsonl` **and** nested
   `subagents/workflows/wf_<id>/agent-<hex>.jsonl`, each with a `.meta.json`. Nested = 85%.
3. **Two join schemas** — (a) flat: `meta.toolUseId == parent Agent tool_use.id` (and
   `toolUseResult.agentId == filename hex`); (b) nested: parent `Workflow` result's transcript-dir
   path → `wf_` members, anchored by `agent.sessionId == enclosing session uuid`.
4. **Self-referential parent index** — index subagent transcripts as candidate parents (depth-2).
5. **Structural block-id equality only** — join on `tool_use.id` equality, **never** substring /
   text grep of `agent-<hex>` / `toolu_` ids (transcripts quote each other's ids → false links).
6. **Token summation from child transcripts** — group `message.usage` by `agentId`; sum all four
   tiers. Do **not** rely on parent rollups.
7. **Legacy fallback** for CC `2.1.70` bare `{agentType:'Explore'}` metas (no `toolUseId`/
   `spawnDepth`) — join via raw `agentId` in parent progress lines. Tiny (2 files) but present.
8. **Compaction handling** — treat compaction lines as context resets (63/117 sessions).
9. **Concurrency-safe ingest** — key on `session-uuid` + timestamps; never one-session-per-slug
   (92/117 overlap).
10. **CC-version detection** from the per-line `version` field for provenance — but branch
    parsing on **directory shape**, not version.
11. **Intra-workflow edge reconstruction** via `journal.jsonl` (started/result by `agentId`) +
    `promptId` — the one edge family not covered by `toolUseId`; **build and validate it**, or
    ship intra-workflow ordering as best-effort (see §7).

## 7. Open gaps (what this probe did NOT prove)

- **Intra-workflow parent→child ordering** inside a `wf_` dir is unproven to 100% — only
  agent→session (844/844) and flat depth-2 (6/6) are proven. **Trigger to downgrade the build:**
  if this can't be reconstructed at a high rate on a real workflow corpus, ship the DAG at
  `agent → session + Agent-tool` granularity and mark intra-workflow ordering _best-effort_, not
  a data fact.
- **Depth-2 sample is tiny and non-diverse** — 6 edges in one session; no depth-3 anywhere.
  Generalization to deeper/wider trees is unmeasured.
- **Outage survival is unstressed** — ~0 historical crashes means the outbox-vs-backfill call is a
  design inference, not a measured recovery test. A deliberate kill-mid-run test would harden the
  YAGNI claim.
- **The `0.893% → 0.000%` orphan discrepancy** was resolved in the safe direction but suggests the
  first probe used a restricted denominator — worth confirming the join harness on a **frozen**
  corpus snapshot (the live corpus polluted the run).

## 8. What this means for the plan

- **CD-1 is answered: `CONDITIONAL-GO` → build**, with the §6 list as the literal acceptance gate
  for Track S / the reconstructor. No production code before the gate is codified as tests.
- **Amend `DESIGN.md` + the reconstructor spec** for the `Agent`/`Workflow`-not-`Task` correction
  and the directory-shape branch (§4a/§4b).
- **Keep** CD-2/CD-3 (immutable substrate + token backfill) and multi-layout parsing — proven
  load-bearing. **Defer** the durable outbox to a triggered add (§4c) — this frees WP-IN11 from
  the v1 critical path, reinforcing the memo's "alerts + non-moat off the critical path" move.

---
_Read-only probe; no files under `~/.claude` modified. 8 agents, 0 errors, ~326k tokens,
~24 min. Full agent returns: the run's `journal.jsonl`. The two load-bearing facts
(`Agent`≠`Task`; 85% nested) independently re-verified by hand. Companion strategic memo:
[`best-path-decision.md`](best-path-decision.md). Decisions refined:
[`concept-analysis-v2.md`](concept-analysis-v2.md) CD-1…CD-3. Build items:
[`development-plan.md`](development-plan.md) Track S · Open work: [`../../TODO.md`](../../TODO.md)._
