# f28af3fd — hand-labeled hierarchy (TEMPLATE — fill me in)

Ground truth for session `f28af3fd-d80b-4bb0-a48e-89625d2aa3e3`, captured from a real Claude Code run.
A second, INDEPENDENT depth-2 population — flat layout only, 5 compactions.
18 subagents.

**What to do:** for every line under `## edges`, replace `__________` with one of

| token | means |
|---|---|
| `ROOT` | this agent was spawned by the main session agent (the top-level conversation) |
| `<hex>` | this agent was spawned by *another subagent* — type that subagent's hex |
| `ORPHAN` | you are sure this transcript records no spawn at all |
| `UNKNOWN` | you cannot tell from the transcript — say this rather than guessing |

`UNKNOWN` is not a failure. A guess that turns out wrong makes the measurement
worse than an honest abstention, because the gate would then be signed against a
label that is not true. Abstentions are reported separately and never counted as
agreement.

**Where to look:** open the main transcript
`spike/corpus/sessions/f28af3fd/data/f28af3fd-d80b-4bb0-a48e-89625d2aa3e3.jsonl`
and search for `Task` tool_use blocks — each carries the subagent's
`description`, which is echoed as a comment on each line below. A block found in
the *main* transcript means `ROOT`. A block found inside another agent's
transcript (`f28af3fd-d80b-4bb0-a48e-89625d2aa3e3/subagents/agent-<hex>.jsonl`) means that agent is the parent
— type its hex. Also fill in `labeled-on` with the date you did this.

Everything outside the `## meta` and `## edges` sections is prose and is ignored,
so add notes to yourself freely.

## meta

session: f28af3fd-d80b-4bb0-a48e-89625d2aa3e3
provenance: human
substrate: session-tree:spike/corpus/sessions/f28af3fd/data
labeled-by: Ivan Baev
labeled-on: __________
note: labeled by hand from the transcript, independently of the parser output

## edges

a0b519a612c3e4562 <- __________   # general-purpose: Security red-team analysis
a0be3ffc20ec84861 <- __________   # general-purpose: Research browser AI agents
a1542d1de9690ccbf <- __________   # general-purpose: Feasibility merciless analysis
a1b042b03ddd1bd5b <- __________   # general-purpose: Research active CU frameworks
a1d41166ead1243a1 <- __________   # general-purpose: Research legacy CU frameworks
a2fe9181107dae8a9 <- __________   # general-purpose: Research desktop computer-use agents
a78d4a17856e5055e <- __________   # general-purpose: Competitive moat analyst
a7aaa65ee39e62359 <- __________   # general-purpose: Architecture merciless review
a7f1042b88605ac23 <- __________   # general-purpose: Feasibility analyst
a7f28277b0e7a38d8 <- __________   # general-purpose: Architecture reviewer
a93e13cc5cd181d92 <- __________   # general-purpose: Legal & compliance analyst
a9727c1e114c9a744 <- __________   # general-purpose: Research CU model APIs
aa652ef8432758919 <- __________   # general-purpose: Product & DX analyst
aa7250df396160b09 <- __________   # general-purpose: Market viability analyst
ac3727bfab3a18291 <- __________   # general-purpose: Pre-mortem devils advocate
acc0b5c2529bc6cca <- __________   # general-purpose: Research open-weight GUI models
acdc0e7c16813957b <- __________   # general-purpose: Research new entrants + hard problems
af678b35a0ee55719 <- __________   # general-purpose: Security red team
