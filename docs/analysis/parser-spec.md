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
| `agent-<hex>.meta.json` | per-agent sidecar, a **single-line JSON object**, one beside each subagent transcript. **Flat** subagents: `{agentType, description, toolUseId, spawnDepth}` — its **`toolUseId` is the primary child→parent join anchor** (§4). **Workflow** subagents: `{agentType, spawnDepth}` (and, in worktree-isolation mode, `worktreePath`) — **no `toolUseId`**, so they join by directory instead. Measured on real data (1855 sidecars): `spawnDepth` ∈ {1: 1842, 2: 11}; `toolUseId` present on 282, absent on 1573; `worktreePath` on 19. *(The earlier "`promptId`, layout, model" description was wrong — those keys do not exist; retracted.)* |
| `journal.jsonl` (`subagents/workflows/wf_*` dirs) | per-workflow dispatch journal; `started` line-order + content-hash `key` |

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
| 3 | Support the structural join schemas (see §4) | ✅ green — **sidecar-anchored**, branched on layout; real-data **1855/1855 = 100%** (§4.2, PROVISIONAL) | S2, S3 + real-data | `WP-IN8` |
| 4 | Index subagents as **self-referential candidate parents** (depth-2 parents live inside depth-1 agent transcripts, not ROOT) | ✅ green | S2, S5 | `WP-IN8`, data-model |
| 5 | Match block ids by **structural equality**, never substring (a `toolu_`/hex id also appears in prose — substring join forges false edges) | ✅ green | S3 | `WP-IN8` |
| 6 | Sum tokens from **child transcripts**; parent rollup is ≈0% (measured **0.00%**, disjoint `message.id` sets) | ✅ green | S6 | `WP-IN7`, `WP-IN9` |
| 7 | Legacy 2.1.70 bare-`Explore` fallback | ⚠️ **absent from corpus** — not exercisable; pointer session `site/08871133-82a3-4ae2-8303-781a8761e92a` | S1 | `WP-IN8` (defensive) |
| 8 | Handle compaction resets (`compact_boundary` + `compactMetadata`, JSONL-native) | ✅ green | S2, S4 | `WP-IN8`, cost |
| 9 | Concurrency-safe: key on **`session-uuid`**, never slug (two same-slug concurrent sessions must stay two roots) | ✅ green | S2, S5 | `WP-IN8` |
| 10 | Version-detect / branch-on-shape (not on a version string) | ✅ green | S2 | `WP-IN8` |
| 11 | Intra-workflow sibling ordering (EMP-1) | ✅ **amended** — see §6.3; original "total order via journal+promptId" is **false**, order is wave-partial only | S5 | dag-moat, UX |
| **N1** | **`<task-notification>` as a flat join path** — a legacy child-side re-anchor when the parent-side `tool_use` block was evicted | ⚠️ **absent on real data** — **0/1855** edges; retained as a defensive legacy fallback only (its spike "load-bearing" role was fixture-only) | S2; real-data | `WP-IN8` (defensive) |
| **N2** | **`queue-operation` as a hard join schema** for `run_in_background` (queued) `Agent` spawns whose parent `tool_use` block is never materialized | ✅ green — but **marginal: 3/1855** on real data | S3; real-data | `WP-IN8` |
| **N3** | **Dedup `usage` rows by `message.id`** before summing, and price **per-bucket/per-model** | ✅ **green (reconciled, PROVISIONAL)** — the §5.2 byte-identical premise was false (lines sharing a `message.id` are streaming partials whose `output` grows **and** whose first row may carry a transient fast-mode `model` label), so dedup collapses to the **per-bucket maximum** and settles the `model` to the greatest-`output` row; `UsageConflictError` is reserved for a genuine collision — two distinct models tied at the same max `output`, or any `agentId` clash (§5.2, §8) | S6; real-data | `WP-IN7`, cost |

> **Real-data note (PROVISIONAL — LABEL-ME).** The "green" marks above were originally
> self-scored against 5 synthetic spike fixtures. Re-measured read-only over all
> `~/.claude/projects/*` (141 sessions), edge reconstruction is **1855/1855 = 100%** (§4.2),
> but two premises did **not** survive contact with real data: N1 `<task-notification>`
> fires **0** times, and N3's identical-`usage`-per-`message.id` assumption is false on **two**
> axes — `output` grows **and** the first partial can carry a transient fast-mode `model` label
> (§8) — N3 is now **reconciled** to per-bucket-max collapse **plus** greatest-`output` model
> settle (§5.2). With both reconciled, a full read-only re-measurement with `usage` **intact**
> parses **all 141 sessions** end-to-end (**0** `UsageConflictError`, **0** `SubstrateError`,
> **0** orphan subagents). Corpus-wide gate coverage is now: **11 green (N3 reconciled), 1
> amended (#11), 2 absent (#7, N1)**.

---

## 4. Join schemas — sidecar-anchored resolution, branched on layout

> **RETRACTED — "224/224 (100%)".** The prior version of this section claimed spawn-edge
> resolution reached 224/224 across four co-equal paths, with `<task-notification>` (N1) as
> the load-bearing compaction-recovery path and a fictional `meta.toolUseId`↔`queue`
> handshake. **That number was self-scored against 5 synthetic spike fixtures that encoded
> anchors which do not match real on-disk shapes; it is withdrawn.** Measured against real
> data (§4.2) the distribution is entirely different: the flat anchor is the **sidecar
> `toolUseId`**, `<task-notification>` **never fires (0/1855)**, and `queue-operation` is
> marginal (3/1855). The real numbers below are **PROVISIONAL — pending owner (Ivan)
> ratification (LABEL-ME)**.

### 4.1 The resolution model (as implemented)
Resolution **branches on layout** (gate #2), keying edges on structural id *position*,
never a substring (item #5):

- **Workflow subagent** (`subagents/workflows/wf_<id>/agent-<hex>.jsonl`) — joined by
  **directory** alone. Parent is the `Workflow` dispatcher when a `workflow_id` links the
  `wf_<id>` dir to a spawning block, else the **main session id**. On real data **no real
  `Workflow` `tool_use` block carries `workflow_id` in its `input`**, so the dispatcher map
  is empty and every workflow subagent joins to main by directory. Edge `source =
  'directory'`.

- **Flat subagent** (`subagents/agent-<hex>.jsonl`) — anchor the child hex to a parent
  spawn-block id from the strongest available source, in priority order:
  1. the **`agent-<hex>.meta.json` sidecar's `toolUseId`** — the primary anchor, present on
     essentially every flat subagent (§2);
  2. else a **parent-side async `type:'user'` record** whose `toolUseResult.agentId ==
     childHex`, taking that record's sibling `tool_result.tool_use_id` as the anchor;
  3. else a **`queue-operation` record** whose `<task-id> == childHex`, taking its
     `<tool-use-id>` as the anchor (`run_in_background` spawns).

  The resolved anchor is then classified by what it names:
  - a **materialized `Agent`/`Workflow` `tool_use` block** → `source = 'tool_use'`; parent
    is that block's owning transcript (a depth-2 parent block lives **inside a depth-1 agent
    transcript**, not ROOT — gate #4);
  - a **`queue-operation` record** → `source = 'queue_operation'`; parent is that record's
    owning transcript;
  - an anchor whose block is gone (compaction-evicted) → re-anchored to main, `source =
    'task_notification'`.

  A **legacy child-side `<task-notification>`** in the child's first record is a final
  fallback (also → main, `source = 'task_notification'`). No path → **orphan, no edge**
  (a parent is never fabricated).

### 4.2 Real-data measurement (PROVISIONAL — LABEL-ME)
Measured read-only over **all `~/.claude/projects/*` (20 slugs, 141 sessions, 54 with
subagents, 1855 subagent transcripts)** — *not* the 5-session spike corpus. Because the
end-to-end parser currently **throws `UsageConflictError` on every subagent-bearing session**
(§8, real-data violation of the §5.2 identical-usage assumption), the edge pipeline was
exercised with `usage` blocks neutralized to isolate reconstruction from the unrelated usage
gate; edge resolution reads no `usage` field, so this does not perturb it.

| Metric | Value |
|---|---|
| Edge reconstruction rate | **1855 / 1855 = 100.00%**, 0 orphans |
| `directory` (workflow subagents) | 1571 (84.7%) |
| `tool_use` (flat, via sidecar `toolUseId`) | 281 (15.1%) |
| `queue_operation` (`run_in_background` flat) | 3 (0.16%) |
| `task_notification` | **0 (0.00%)** |
| parent = main / parent = another agent (depth-2) | 1844 / 11 |

Flat total 284 = 281 `tool_use` + 3 `queue_operation` + 0 `task_notification` + 0 orphan;
nested total 1571 = all `directory`. The join key is **intentionally cross-file** (a
`tool_use.id` / sidecar `toolUseId` matching an inline hex in a child file) — which is
exactly why matching must be on structural id *position*, never a substring grep.

---

## 5. Token → cost

### 5.1 Attribution is a hard field-read, not a join
`token_usage` row → `agent_id` is **6654/6654 = 100% hard key, 0 heuristic**: the `agentId`
field on the row is byte-equal to the hex in the enclosing `agent-<hex>.jsonl` filename.
This makes CD-3's backfill a **hard join, not a confidence-scored inference** — no
UI-surfaced uncertainty is required for attribution.

### 5.2 Dedup by `message.id` is a correctness gate (N3)
Claude Code writes **one JSONL line per content block**, and lines sharing a `message.id`
are **streamed partials of one message**: the `input` and cache buckets are **constant**
across them while `output_tokens` **grows** toward the final total (verified raw, e.g.
`output_tokens` 7→7→309 on one message). Dedup therefore collapses each `message.id` to its
**per-bucket maximum** — equivalently the final streamed state — **never a sum**. Naive
row-summation over-counts by **~2.4–2.7×** (this corpus: 8,540 raw usage rows → **3,339
deduped messages**); summing without dedup produces ~$900 of phantom spend where the true
figure is ~$346. **The parser MUST collapse `usage` to the per-`message.id` per-bucket
maximum before summing.** This is correctness, not optimization.

> **PROVISIONAL (LABEL-ME).** This supersedes the original §5.2/N3 premise that the partials
> were **byte-identical** and that ANY `usage`, `model`, or `agentId` divergence was a loud
> `UsageConflictError`. Real transcripts (the full `~/.claude/projects` corpus, 141 sessions)
> disprove the premise on **two** axes, both reconciled by the same rule — *the final streamed
> row is ground truth*:
>
> 1. **Usage** — only `output` grows across the partials, so `usage` collapses to the
>    **per-bucket maximum** (the final total) instead of asserting equality.
> 2. **Model** — the **first** partial can carry a **transient fast-mode routing label**
>    (observed: `claude-fable-5` on the first row, then `claude-opus-4-8` on every later row
>    and the final row, sharing one `message.id` **and** one `requestId`; `output` 2→…→6747 /
>    9→…→360). Fast mode *runs Opus* (it does not downgrade), so the settled label is the true
>    model. The parser therefore settles the model to the **greatest-`output` row**. This is
>    pricing-relevant, not cosmetic: naively taking the first partial's `fable-5` would price
>    the message at the fable rate (`$10/$50` per MTok) instead of the true opus rate
>    (`$5/$25`) — a ~2× over-charge. Measured impact: **2 of 141 sessions** (both in
>    `servicenow-preflight`) previously threw here; with the settle, **0/141 throw** and the
>    edge rate holds at **100%**.
>
> What stays loud (genuine corruption streaming cannot produce): two **distinct** models tied
> at the **same maximum** `output`, or any **`agentId`** disagreement on a shared `message.id`
> (§5.3 makes message ids per-agent-disjoint). Selecting the final-row model/usage is
> *choosing* ground truth, not inferring it, so it is defensible under the ground-truth
> invariant — but both loud-failure relaxations (usage-max **and** model-settle) are flagged
> for Ivan's ratification and the corpus numbers stay PROVISIONAL. The §5.4 "**halt loudly on
> an unknown model id**" pricing MUST is **unchanged** — the settle only chooses *between two
> known models*, and a genuinely unknown settled id still halts.

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
   *(Code exists as of 2026-07-11 by explicit owner override of CD-8; this spec remains the
   contract, and its numbers are still PROVISIONAL pending the LABEL-ME sign-off below.)*
2. **The "224/224 (100%)" self-score is WITHDRAWN.** It was scored against 5 synthetic spike
   fixtures encoding anchors that do not match real on-disk shapes; it never measured real
   data. It is replaced by a **real, read-only measurement over all `~/.claude/projects/*`
   (141 sessions, 54 with subagents, 1855 subagent transcripts): edge reconstruction =
   1855/1855 = 100%, 0 orphans** — breakdown `directory` 1571 / `tool_use` 281 /
   `queue_operation` 3 / `task_notification` 0 (§4.2). **This number is PROVISIONAL — pending
   owner (Ivan) ratification (LABEL-ME).** If Ivan re-parents any edge by hand, it moves.
3. **Two real-data caveats the edge number rests on (do not overstate).**
   - The end-to-end parser **previously threw `UsageConflictError` on real subagent-bearing
     sessions** on **two** streaming axes, both now **RECONCILED** by "the final streamed row
     is ground truth" (§5.2): **(a) usage** — lines sharing one `message.id` carry **growing**
     `output` (e.g. 7→309), which the old identical-usage assertion rejected; dedup now
     collapses each `message.id` to its per-bucket maximum. **(b) model** — the first partial
     can carry a transient fast-mode label (`claude-fable-5`) that settles to the real model
     (`claude-opus-4-8`) on the same `message.id`/`requestId`; dedup now settles the model to
     the greatest-`output` row (2 of 141 sessions, both `servicenow-preflight`, threw here).
     A genuine collision still throws (two distinct models tied at the same max `output`, or an
     `agentId` clash). A read-only re-measurement with `usage` **intact** now parses **all 141
     sessions** (0 `UsageConflictError`, 0 `SubstrateError`, edge rate 100%, 0 orphans). **Both
     reconciliations and the corpus cost numbers stay PROVISIONAL pending Ivan's ratification
     (LABEL-ME).**
   - The pure parser correctly **throws `SubstrateError` on any non-JSONL file**, so the
     WP-IN5 disk adapter **MUST** feed only the four §2 artifact types; handing it the whole
     session directory (`tool-results/*.txt`, `workflows/scripts/*.js`, `*.pdf`) throws on 32
     sessions.
4. **KC-0** — Gate A's two physical Step-0 acts (friction log; rival-dashboard
   trial) are Ivan's, not machine-closable, and are unrelated to the technical evidence
   above. The spike de-risks the *build*; it does not satisfy the *governance* checkpoint.

## See also

- `phase0-verdict.md` — the WP-S7 GO/NO-GO verdict this spec is derived from.
- `phase0-probe.md` — the original 2026-07-04 desktop probe and 11-item gate.
- `../site/architecture/ingest-reconciliation.md` — the CD-1/CD-2/CD-3 contract (unchanged).
- `../site/architecture/dag-moat.md` — dual-path edge derivation and the outage-rebuild story.
- `roadmap-v1-v2-2026-07-06.md` — the KC schedule this all funnels through.
