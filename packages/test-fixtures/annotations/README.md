# Hierarchy annotations — hand-labeled ground truth

This directory holds the ground truth the parser is scored against: for a given
session transcript, which agent spawned which. It exists because two `TODO.md`
items are blocked on the same human act:

- **WP-X2** — labeled annotations + loader.
- **Phase-3 exit gate** — "hierarchy ≥ 95% without `SubagentStart`". The ≥ 95%
  is measured against a *hand-labeled* corpus. Machine-vs-machine cannot sign
  it, so the tooling refuses to.

The format, the loader, the scorer and the report are built. What is not built —
and cannot be, by anyone but a human — is the labels.

---

## The ask, in full

**Open the two files in `templates/`, replace every `__________`, save them into
`human/`, and run one command.** That is the whole task. Details below.

### 1. Copy the templates

```sh
cp packages/test-fixtures/annotations/templates/*.hierarchy.md \
   packages/test-fixtures/annotations/human/
```

Two files, 42 + 18 = **60 agents** to label. Why exactly these two is in
"How big must the sample be" below.

### 2. Fill in each `__________`

Every line under `## edges` looks like this:

```
a0b519a612c3e4562 <- __________   # general-purpose: Security red-team analysis
```

The hex on the left is a subagent. Replace `__________` with **one** of:

| token    | means                                                                            |
| -------- | -------------------------------------------------------------------------------- |
| `ROOT`   | spawned by the main session agent (the top-level conversation)                    |
| `<hex>`  | spawned by *another subagent* — type that subagent's hex, exactly as it appears   |
| `ORPHAN` | you are sure this transcript records no spawn at all                              |
| `UNKNOWN`| you cannot tell from the transcript                                               |

Also replace the `__________` after `labeled-on:` with the date (`YYYY-MM-DD`).

**`UNKNOWN` is not a failure, and it is not a wrong answer.** It is scored in its
own bucket: excluded from the accuracy fraction, never counted as agreement,
always reported. A guess that turns out wrong is strictly worse than an
abstention, because the exit gate would then be signed against a label that is
not true. If a case is genuinely ambiguous, type `UNKNOWN` and move on.

`ORPHAN` is different from `UNKNOWN`. `ORPHAN` is a positive claim — "there is no
parent to find here, and a parser that invents one is wrong". It is scored, and
the parser can get it right or wrong.

### 3. Where to look

Each template names the transcript to read. Search it for `Task` tool_use
blocks; each carries the `description` that is echoed as the comment on the line.

- A `Task` block found in the **main** transcript → that subagent's parent is `ROOT`.
- A `Task` block found inside **another agent's** transcript
  (`<session-id>/subagents/agent-<hex>.jsonl`) → that agent is the parent; type
  its hex. This is the depth-2 case (`parser-spec.md` gate item 4) and it is the
  single most valuable thing in the corpus, because it is exactly what a naive
  parser gets wrong.

The templates deliberately do **not** show the parser's answer, the spawn depth,
or the `toolUseId`. Seeing the machine's answer before writing yours would
contaminate the label and the resulting number would mean nothing.

Everything outside the `## meta` and `## edges` sections is prose and is ignored
by the loader — annotate freely, leave notes to yourself, reorder the edge lines.

### 4. Run the gate

```sh
pnpm --filter @agenthropic/core exec vitest run test/hierarchy-gate.test.ts
```

It prints the measured accuracy, the sample size, the 95% lower bound, a line per
disagreement, and a CERTIFIED / NOT CERTIFIED verdict with reasons.

If a file is malformed, the loader fails immediately with `file:line: message`
for **every** problem at once — a typo does not cost a round trip.

---

## How big must the sample be

A percentage from three sessions is not a signature. For the measured figure to
support the claim "hierarchy accuracy ≥ 95%" at 95% confidence, the one-sided
Wilson lower bound must clear 0.95. Even for a **flawless** run (zero errors),
that requires

```
n ≥ threshold · z² / (1 − threshold) = 0.95 · 1.6449² / 0.05 = 51.4  →  n ≥ 52
```

so **52 labeled agents is the floor**, and only if every single one is correct.
One error at n = 52 fails; the run needs roughly n ≥ 90 to survive a single
error. `minimumClaimsForThreshold()` computes this, and `certifyExitGate()`
refuses to certify below it — no matter how good the percentage looks.

The two templates give **60**, which buys a little headroom over the floor and,
more importantly, covers structurally distinct ground:

| session    | agents | why this one                                                        |
| ---------- | ------ | ------------------------------------------------------------------- |
| `b24be30c` | 42     | dual on-disk layout (flat + nested `wf_*`), deepest observed nesting |
| `f28af3fd` | 18     | an independent depth-2 population, flat layout, 5 compactions        |

Labeling only one of the two leaves n below 52 and the gate will say so.

`UNKNOWN` answers do not count toward n. If a large share of the corpus comes
back `UNKNOWN`, that is a real and reportable finding — the report prints "label
coverage" and a "worst case" figure (every abstention assumed wrong) next to the
headline number, so an under-labeled corpus cannot masquerade as a passing one.

---

## Layout

```
annotations/
  synthetic/   6 fixture annotations — true by construction, NOT admissible
  templates/   the two files to fill in
  human/       ← put the filled-in files here
```

The tooling itself is in `../src/annotations/`:
`types.ts` (vocabulary) · `parse.ts` (loader + validator) · `score.ts` (scorer +
Wilson bound + gate verdict) · `report.ts` (human-readable output) ·
`read.ts` (read-only filesystem adapters). The runner that wires the real parser
to it is `packages/core/test/hierarchy-gate.test.ts`.

## Why `synthetic/` cannot sign the gate

The six fixture annotations state the hierarchy that the fixtures were built to
have. They are genuinely useful — they prove the loader, the scorer, the report
and all four join paths work end to end, and they regression-guard the depth-2
case. They are also written by the same side as the parser, so agreement between
them proves only internal consistency.

That distinction is structural, not a convention:

- every annotation must declare `provenance:` (`human` or
  `synthetic-by-construction`);
- `scoreCorpus()` throws if a corpus mixes provenances, so a blended figure
  cannot be computed by accident;
- `certifyExitGate()` hard-refuses any non-`human` corpus and says why;
- the report prints an `ADMISSIBILITY` banner above the numbers.

---

## The format, for reference

```
# free prose, ignored

## meta

session: <uuid of the session>
provenance: human | synthetic-by-construction
substrate: fixture:<name> | session-tree:<dir containing <session>.jsonl>
labeled-by: <who>
labeled-on: YYYY-MM-DD
note: <optional, repeatable>

## edges

<child hex> <- ROOT|ORPHAN|UNKNOWN|<parent hex>   # optional comment
```

Hand-writable with no tooling, diffable, and every claim carries a line number so
errors and disagreements both point at a place in a file.
