# Parser specification — implementation-ready, derived from the Phase-0 spike (WP-S1…S7)

> **Status.** This is the normative parser contract, distilled from the completed Phase-0
> feasibility spike (WP-S1…S7, verdict `phase0-verdict.md`, 2026-07-10). It turns the
> spike's *empirical* findings into the *specification* the production parser and its
> golden-fixture tests are written against — one place, so the parser is not reconstructed
> from six scattered `spike/*/README.md` files when the build starts.
>
> **This is a design document, not code.** It scaffolds nothing. **CD-8 still binds:** no
> `package.json` / `src/` is written until Gate A is signed *and* `WP-S7` GO is **ratified
> by Ivan's human `LABEL-ME.md` sign-off** (the verdict is CONDITIONAL GO, self-check only).
> Every number below is `PROVISIONAL / self-check` — scored against machine inventories,
> not human ground truth — until that sign-off lands.
>
> **Authority.** Where this document and the pre-spike architecture pages disagree, the
> spike evidence wins *for the parser mechanics it measured* — but this file does **not**
> silently rewrite the site docs; §7 lists the exact edits to apply to
> `ingest-reconciliation.md`, `hooks.md`, `cost-model.md`, `dag-moat.md`, and `data-model.md`
> **at scaffold time**. Until then those pages keep their "confidence 85 / desktop probe"
> framing and this file is the newer truth.

---

## 1. Scope

This spec covers the **read side** only — the pure function
`on-disk JSONL substrate → (agents, orchestration_edges, token_usage)`. It does **not**
cover the substrate contract (`events_raw`, idempotency keys, replay-on-startup, the
Normalizer/Projection split) — that is fixed by CD-2/CD-3 and documented in
`../site/architecture/ingest-reconciliation.md`, unchanged by the spike. The spike
confirmed CD-2/CD-3 hold; it sharpened *what the reconstruction step inside them must do*.

The corpus it was proven against: **5 sessions, 224 agents, 3 projects**, deliberately
loaded with the four hostile pathologies (post-compaction block eviction, live-crash /
no-`Stop` snapshot, same-slug concurrency, dual-layout depth-2).

---

## 2. Input substrate — what the parser reads

Per session, from `~/.claude/projects/<slug>/` (**read-only, always**):

| Artifact | Role |
|---|---|
| top-level `<session-uuid>.jsonl` | the main-agent transcript; carries parent-side `Agent`/`Workflow` `tool_use` spawn blocks, `usage` rows for the main agent's own turns, and `compact_boundary` records |
| `subagents/.../agent-<hex>.jsonl` | one per subagent; carries that agent's `usage` rows (inline `agentId == <hex>`) and, for nested layouts, its child spawns |
| `*.meta.json` | per-agent metadata (`promptId`, layout, model) |
| `journal.jsonl` (workflow/`wf_*` dirs) | per-workflow dispatch journal; `started` line-order + content-hash `key` |

**Two on-disk layouts exist and the parser branches on directory shape, not version
string** (gate item #2, #10):
- **flat** — agent files sit directly under the session; parent edges come from the
  main transcript's `tool_use` blocks.
- **nested** — agents live under `workflows/wf_*/…`; parent edges come from directory
  anchoring. In the corpus ~85% of agent files are nested (69ac12d0: 103/103 nested;
  a362e15d: 57/57 nested).

A single session may be **mixed** (b24be30c: 20 flat / 22 nested). Branch per-agent-file,
not per-session.

---

## 3. The parser-requirements gate — final status (14 items)

The original probe defined an 11-item gate. The spike exercised it and **discovered three
additional load-bearing requirements** (N1–N3) the original list did not have. All 14 are
normative MUSTs for the production parser.

| # | Requirement | Status | Proved by | Affects |
|---|---|---|---|---|
| 1 | Spawn edges key on `Agent`/`Workflow` tools, **never** `Task` (0 `Task` blocks corpus-wide) | ✅ green | S2 | `WP-IN8` |
| 2 | Walk **both** layouts (flat + nested `wf_*`); branch on directory shape | ✅ green | S2 | `WP-IN8` |
| 3 | Support the structural join schemas (see §4) | ✅ green (now **4 paths**) | S2, S3 | `WP-IN8` |
| 4 | Index subagents as **self-referential candidate parents** (depth-2 parents live inside depth-1 agent transcripts, not ROOT) | ✅ green | S2, S5 | `WP-IN8`, data-model |
| 5 | Match block ids by **structural equality**, never substring (a `toolu_`/hex id also appears in prose — substring join forges false edges) | ✅ green | S3 | `WP-IN8` |
| 6 | Sum tokens from **child transcripts**; parent rollup is ≈0% (measured **0.00%**, disjoint `message.id` sets) | ✅ green | S6 | `WP-IN7`, `WP-IN9` |
| 7 | Legacy 2.1.70 bare-`Explore` fallback | ⚠️ **absent from corpus** — not exercisable; pointer session `site/08871133-82a3-4ae2-8303-781a8761e92a` | S1 | `WP-IN8` (defensive) |
| 8 | Handle compaction resets (`compact_boundary` + `compactMetadata`, JSONL-native) | ✅ green | S2, S4 | `WP-IN8`, cost |
| 9 | Concurrency-safe: key on **`session-uuid`**, never slug (two same-slug concurrent sessions must stay two roots) | ✅ green | S2, S5 | `WP-IN8` |
| 10 | Version-detect / branch-on-shape (not on a version string) | ✅ green | S2 | `WP-IN8` |
| 11 | Intra-workflow sibling ordering (EMP-1) | ✅ **amended** — see §6.3; original "total order via journal+promptId" is **false**, order is wave-partial only | S5 | dag-moat, UX |
| **N1** | **`<task-notification>` as a first-class flat join path** — recovers a spawn edge when a `PreCompact` evicted the parent-side `tool_use` block | ✅ **new MUST** | S2 | `WP-IN8` |
| **N2** | **`queue-operation` as a hard join schema** for `run_in_background` (queued) `Agent` spawns whose parent `tool_use` block is never materialized | ✅ **new MUST** | S3 | `WP-IN8` |
| **N3** | **Dedup `usage` rows by `message.id`** before summing, and price **per-bucket/per-model** | ✅ **new MUST** | S6 | `WP-IN7`, cost |

Corpus-wide, gate coverage is **12 green, 1 amended (#11), 1 absent (#7)**.

---

## 4. Join schemas — the four structural edge sources

Spawn-edge resolution reached **224/224 (100%)** only with all four paths below. With just
the two base paths it was 221/224 (98.66%); the three misses were all `run_in_background`
spawns in f28af3fd, closed by N2. **Substring matching is never a fifth path** — item #5.

**Base paths (both layouts):**
1. **Parent `tool_use` block** (flat) — the main transcript's `Agent`/`Workflow`
   `tool_use` block; its `id` is the structural anchor. Strictly monotonic in timestamp
   (a clean total order for flat siblings — see §6.3).
2. **Nested-directory anchor** (nested) — the `workflows/wf_*/…` path locates the parent;
   no `tool_use` block is needed.

**Recovery paths the spike added (both are hard, structural, not heuristic):**
3. **`<task-notification>`** (N1) — child-side. When compaction evicted the parent-side
   `tool_use` block, the child's `<task-notification>` message carries `<task-id>` /
   `<tool-use-id>` that re-anchor the edge. This is what makes compaction survivable
   (f28af3fd: 3 edges recovered; tool_use-only alone gets 15/18, this backfills to 18/18).
4. **`queue-operation`** (N2) — a `type:"queue-operation"` record carrying `<task-id>` and
   `<tool-use-id>` tags, joined to the child's inline `agentId` and `meta.toolUseId`.
   Required for `run_in_background` `Agent` spawns; without it every backgrounded subagent
   silently vanishes from the DAG.

The join key is **intentionally cross-file** (a `tool_use.id` in the parent file matches an
inline id in a child file) — which is exactly why matching must be on structural id
*position*, never a substring grep (the same id also appears in prose in 7/7/31/0/0 places
per session).

---

## 5. Token → cost

### 5.1 Attribution is a hard field-read, not a join
`token_usage` row → `agent_id` is **6654/6654 = 100% hard key, 0 heuristic**: the `agentId`
field on the row is byte-equal to the hex in the enclosing `agent-<hex>.jsonl` filename.
This makes CD-3's backfill a **hard join, not a confidence-scored inference** — no
UI-surfaced uncertainty is required for attribution.

### 5.2 Dedup by `message.id` is a correctness gate (N3)
Claude Code writes **one JSONL line per content block**, and every line sharing a
`message.id` carries the **identical** `usage` block. Naive row-summation over-counts by
**~2.4–2.7×** (this corpus: 8,540 raw usage rows → **3,339 deduped messages**). Summing
without dedup produces ~$900 of phantom spend where the true figure is ~$346. **The parser
MUST dedup `usage` by `message.id` before summing.** This is correctness, not optimization.

### 5.3 Parent-rollup is 0.00% (gate #6)
Parent `usage` rows are the main agent's own turns (`agentId=null`, `isSidechain=false`);
child usage lives only in `agent-<hex>.jsonl`. A subagent's result returns to the parent as
a `tool_result` (`user` row, **no `usage` block**), so it is never re-counted. Parent and
child `message.id` sets are **disjoint** → provably no double-count. Partition identity
`sum(per-agent) + ROOT == session total` holds to <1e-6 USD in all 5 sessions.

### 5.4 Pricing must be bucket-and-model-aware (N3)
88% of corpus tokens are cheap **cache reads** — a flat per-token rate would be wildly
wrong. Price each of the four buckets (fresh input, output, cache-write-5m, cache-write-1h,
cache-read) at the model's rate. The spike's **approximate** table (list prices, for a
mechanism proof — *not* a billing source): opus-4-8 $5/$25, sonnet-5 $3/$15 (list; the
intro $2/$10 through 2026-08-31 would cut Sonnet ~⅓), fable-5 $10/$50, haiku-4-5 $1/$5 per
MTok; cache-read ×0.1 of input, cache-write ×1.25 (5m) / ×2.0 (1h). `<synthetic>` = $0. The
parser MUST **halt loudly on an unknown model id** — never silently price it at $0.

Corpus total (approximate): **≈ $345.91 over 206,001,429 tokens / 3,339 messages**.

---

## 6. Tree construction

### 6.1 Self-referential parent index (gate #4)
Depth-2 parents live **inside** depth-1 agent transcripts, so the parent index must admit
**agents as candidate parents**, not only ROOT. Witnessed by two independent sessions
(b24be30c 6/6, f28af3fd 5/5). **Depth is capped at 2 corpus-wide** — metas `{1: 1339, 2: 11,
none: 2}`, **no depth-3 anywhere**. Deeper trees are therefore *unmeasured*, not *proven
absent*: the parser must handle depth-N by construction (recursive index), but the ≥95%
hierarchy bar has only been demonstrated to depth 2.

### 6.2 Concurrency independence — key on `session-uuid` (gate #9)
`69ac12d0` (103 agents) and `a362e15d` (57) share slug `-Users-ivanbaev-Development-
agenthropic` and overlap ~2.5 days of wall-clock, yet are **two independent roots**: empty
hex intersection, distinct roots, zero cross-session edges. Keying on slug would fuse 160
agents into one phantom tree; keying on `session-uuid` keeps them apart. **This is the one
tree fact Ivan most needs to confirm by hand** (`LABEL-ME.md`).

### 6.3 Sibling ordering — EMP-1, amended (gate #11)
The original gate assumed `journal.jsonl` + `promptId` yields a total sibling order. **The
spike disproves that:**
- `promptId` is a **batch key, not an ordinal** — every member of a workflow shares one
  `promptId` (8/8, 50/50 observed).
- `parentUuid` is `None` for each nested agent's first record; journal `key` is a content
  hash, not a sequence number.
- The two temporal signals (first-record `timestamp`; journal `started` line-order) agree
  on every sibling pair started >~3 ms apart and **disagree only inside a genuinely
  parallel dispatch wave** — max Δt of any inverted pair corpus-wide = **0.003 s**.
- Flat layout **is** a clean total order (parent `tool_use` blocks are strictly monotonic).

**Normative rule:** order siblings by first-record `timestamp`; collapse same-wave siblings
(Δt below ~10 ms) into an **explicitly UNORDERED** concurrent group ("N started together");
use journal `started` order only as corroboration, never for flat layout (no `journal.jsonl`
exists there); **do not manufacture a total order the substrate does not carry.** Ship
`agent → workflow → ROOT` with time-ordered waves. (This is "honest uncertainty over
confident nonsense" made concrete — see `ux0-design.md`.)

---

## 7. Edits to apply to the site docs — at scaffold time, not before

When CD-8 releases and the build starts, fold these spike results into the published
architecture pages (this file is the source for each edit):

- **`ingest-reconciliation.md` §"What's undecided"** — move CD-1 (JSONL-primary),
  join-key G0.1b (hard key), and hook catalog G0.2 (`SubagentStart` not a real hook) from
  *undecided* to *decided*; upgrade the "confidence 85 / desktop probe" framing to the
  WP-S7 corpus result (100% edge accuracy, 0/463 hook-sourced). Add N1/N2 to the §4 join
  story and N3 to §8.
- **`hooks.md`** — record `SubagentStart` as **confirmed not a real Claude Code hook**
  (never fires); only `UserPromptSubmit` leaves a footprint (37 firings); compaction is
  read from `compact_boundary`, never a `PreCompact` hook (30 boundaries, all `trigger=auto`).
- **`cost-model.md`** — add the **`message.id` dedup** correctness gate (N3) and the
  bucket/model-aware pricing rule; confirm parent-rollup 0.00%.
- **`dag-moat.md`** — add the two recovery join paths (N1 `<task-notification>`, N2
  `queue-operation`) to the dual-path derivation; record the EMP-1 wave-partial ordering
  rule (§6.3).
- **`data-model.md`** — confirm the self-referential `parent_agent_id` index admits agents
  as parents (depth-2 proven, depth-N by construction); note the depth-2 measurement cap.

Do **not** apply these now — they are published-target edits that belong with the code that
implements them, and the verdict they rest on is still `CONDITIONAL` pending human sign-off.

---

## 8. What still gates production code

1. **CD-8** — no `package.json`/`src/` until Gate A signed *and* WP-S7 GO **ratified**.
2. **WP-S7 is CONDITIONAL GO** — every number here is self-check. The five
   `spike/corpus/sessions/*/LABEL-ME.md` (224 per-edge blanks) must be filled by Ivan to
   upgrade `edge_accuracy` from *self-check 100%* to *human-verified 100%*. **If Ivan
   re-parents any edge, these numbers — and possibly the join schemas — move.**
3. **KC-0 (2026-07-13)** — Gate A's two physical Step-0 acts (friction log; rival-dashboard
   trial) are Ivan's, not machine-closable, and are unrelated to the technical evidence
   above. The spike de-risks the *build*; it does not satisfy the *governance* checkpoint.

## See also

- `phase0-verdict.md` — the WP-S7 GO/NO-GO verdict this spec is derived from.
- `phase0-probe.md` — the original 2026-07-04 desktop probe and 11-item gate.
- `../site/architecture/ingest-reconciliation.md` — the CD-1/CD-2/CD-3 contract (unchanged).
- `../site/architecture/dag-moat.md` — dual-path edge derivation and the outage-rebuild story.
- `roadmap-v1-v2-2026-07-06.md` — the KC schedule this all funnels through.
