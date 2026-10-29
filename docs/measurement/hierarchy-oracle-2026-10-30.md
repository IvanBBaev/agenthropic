# Hierarchy cross-check — agent evidence, 2026-10-30

> ## ⚠ AGENT WORK — not the human LABEL-ME gate
>
> This is an **independent agent cross-check** of the 60 claims in
> `packages/test-fixtures/annotations/templates/{b24be30c,f28af3fd}.hierarchy.md`. It was
> taken on owner delegation (decision D8,
> [`10-synthesis.md`](../analysis/role-reviews-2026-10-29/10-synthesis.md) §6.1). It is **not**
> a human label. Nothing here was written to `annotations/human/`, and nothing here
> certifies the ≥95% hierarchy gate, which stays **NOT CERTIFIED** until Ivan labels the
> trees ([`RELEASE.md`](https://github.com/IvanBBaev/agenthropic/blob/main/RELEASE.md) §0, §3).
> Its value is narrower: where Ivan does label, any disagreement with this record points
> at a claim worth a second look.

## Method

- **Isolation.** The checking agent did not read the parser or projection source and did
  not run the app. It derived each parent edge from the raw transcripts only.
- **Substrate.** Both sessions have rotated out of `~/.claude/projects`, so the check read
  the byte copies in `spike/corpus/sessions/{b24be30c,f28af3fd}/data/`. Both main-file
  sha256 values match `SOURCE.txt`; the subagent files were not hash-checked. The
  `spike/` copy is therefore the only remaining way to check these labels.
- **Evidence read per agent:**
  - the `Agent` tool_use block and its id;
  - the tool_result `toolUseResult.agentId`;
  - the subagent sidecar `toolUseId` and `spawnDepth`;
  - the first record of each `agent-*.jsonl`;
  - queue-operation and task-notification records;
  - `Workflow` tool results (`runId`) and the workflow `journal.jsonl`.
- **Certain** means three things hold together:
  - the spawning `Agent` block was found;
  - its id equals the child's sidecar `toolUseId`;
  - the `agentId` and the timing are consistent.

## Result

| Session | Claims | Certain | Likely | Cannot determine | ROOT | Child of a subagent |
|---|---|---|---|---|---|---|
| `b24be30c` | 42 | 42 | 0 | 0 | 36 | 6 (2 each under `a42e4476…`, `a564bcdb…`, `a4610dae…`) |
| `f28af3fd` | 18 | 15 | 3 | 0 | 13 | 5 (all under `a2fe9181…`) |
| **Total** | **60** | **57** | **3** | **0** | **49** | **11** |

No ORPHAN was found, and the maximum nesting depth in both sessions is 2.

- **Workflow agents.** 22 of the `b24be30c` ROOT rows are children of two `Workflow` runs,
  `wf_f5e9f783-c3e` (6 agents) and `wf_bf657132-cf5` (16 agents). The main agent launched
  both runs, and each run's journal lists the same agentIds.
- **The three "likely" rows.** They are `a0b519a6…`, `a1542d1d…` and `a7aaa65e…` in
  `f28af3fd`, all ROOT. Their spawning `Agent` blocks do not exist anywhere:
  - the agents started at 18:02–18:03, inside a main-session turn that was retracted by a
    `model_refusal_fallback` record (main L422, 8 `retractedMessageUuids`, none persisted);
  - the only remaining evidence is the sidecar (`spawnDepth: 1`) and a task-notification
    in the main file;
  - no other subagent was alive at that time, so the main agent is the only possible
    spawner.

  A strict human labeller could defensibly write UNKNOWN for these three rows.

## Findings for the parser and the templates

1. **Retracted spawns.** A refusal-fallback retraction can remove the `Agent` tool_use
   block while the subagent still runs. A parser that derives edges only from tool_use
   blocks gives such an agent no edge. The surviving evidence is the sidecar `toolUseId`
   and `spawnDepth` plus the task-notification. A real-corpus case is in
   `f28af3fd` (above). This is worth a fixture under R17 (real-corpus contract suite).
2. **Workflow runs are a hidden node.** The template defines ROOT as "spawned by the main
   session agent". Workflow children are spawned by the workflow runtime, which the main
   agent started. ROOT is the only one of the four tokens that fits, and the label scheme
   cannot express the run in between.
3. **Template wording.** The `f28af3fd` "where to look" text assumes the `Agent` block
   exists, which fails for three claims. The `b24be30c` template calls that session the
   "deepest observed nesting", but both sessions reach depth 2.
