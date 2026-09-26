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
`human/`, and run one command.** That is the whole task. A rendering kit lays the
evidence out per claim so the judging does not mean reading raw JSONL by hand
(section 3). Details below.

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

### 3. Where to look — the labelling kit

Each template names the session tree to read. What decides a label is where the
spawning `Agent` (`Task`) tool_use block lives:

- in the **main** transcript → that subagent's parent is `ROOT`;
- inside **another agent's** transcript
  (`<session-id>/subagents/agent-<hex>.jsonl`) → that agent is the parent; type
  its hex. This is the depth-2 case (`parser-spec.md` gate item 4) and it is the
  single most valuable thing in the corpus, because it is exactly what a naive
  parser gets wrong.

Finding those blocks by hand in multi-megabyte JSONL is slow and error-prone, so
the package ships a **read-only renderer**. It reads one template plus the real
session tree under `spike/` and writes one markdown page per claim into
`annotations/.render/<template-id>/` (git-ignored — see "What gets committed").
Every page shows:

- the **child record** — the first line of `agent-<hex>.jsonl`, reduced to its
  identifying fields (`uuid`, `parentUuid`, `timestamp`, `type`, `agentId`,
  `isSidechain`, and a ~200-character content preview);
- the **sidecar** (`agent-<hex>.meta.json`), when one exists;
- the **parent record** — the transcript line the parser joined the child to,
  reduced the same way, plus the matched `tool_use` block;
- the **join path** — which fields matched, in the parser's own terms
  (`tool_use`, `queue_operation`, `task_notification`, `legacy_explore`,
  `directory`, or no edge at all), mirrored step by step from
  `packages/core/src/parser/parse-session.ts`;
- every **raw evidence line** as `file:line`, so each excerpt can be checked
  against the transcript itself.

The procedure, start to finish:

1. Make sure `spike/` is present on this machine. It is git-excluded; without it
   the renderer stops with `substrate unavailable` (exit code 1) and there is
   nothing to label.
2. Render one template:
   `pnpm --filter @agenthropic/test-fixtures render-claims -- b24be30c`
   (afterwards the same for `f28af3fd`).
3. Open `packages/test-fixtures/annotations/.render/b24be30c/index.md`: one row
   per claim with a `[ ]` verdict box, the parser's reading, whether both records
   were found, and a link to the claim's page.
4. For each claim open its page and read the child record, the parent record
   and the raw evidence lines; follow the `file:line` references into the
   transcript whenever the excerpt alone is not conclusive.
5. Decide `ROOT`, `<parent hex>`, `ORPHAN` or `UNKNOWN` from that evidence —
   **not** from the "Parser reading" line (see the note below).
6. Write the verdict into the matching edge line of
   `human/b24be30c.hierarchy.md` (the copy made in step 1 of "The ask"). Tick the
   box in the index if it helps you keep your place; the index is scratch.
7. Fill in `labeled-by:` and `labeled-on:`.
8. Repeat steps 2–7 for `f28af3fd`.
9. Run the gate (section 4). If the loader complains with `file:line`, fix the
   line it names and run again.
10. Commit the two `human/` files — and only them; `.render/` is git-ignored.

**On seeing the parser's answer.** The templates still show neither the
parser's answer, the spawn depth nor the `toolUseId`. The rendered pages do:
every page carries a "Parser reading" line and the join path the parser took,
because a page that hid them could not show *which fields matched* — and laying
that out is what the kit is for. This is a deliberate trade-off and it should be
said plainly: a label written with the kit is not a blind label, it is an audited
one. The safeguard is procedural, not mechanical. Judge the records and the raw
lines, treat the parser line as one more claim to check, and write `UNKNOWN`
whenever the evidence does not settle it. A claim whose child transcript cannot
be found says so on its page, gets no parser reading, and should be `UNKNOWN`
unless you can locate the transcript by hand.

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

**On CI, and on any machine without `spike/`:** the gate reports
`SUBSTRATE UNAVAILABLE` and the renderer exits 1 printing `substrate unavailable`.
Neither is made to pretend otherwise. The session trees are git-excluded, so a
green CI run says nothing about hierarchy accuracy; only a run on a machine that
holds `spike/` can produce a verdict, and the gate stays reported as unavailable
everywhere else.

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
  synthetic/   8 fixture annotations — true by construction, NOT admissible
  templates/   the two files to fill in
  human/       ← put the filled-in files here (committed — see below)
  tools/       render-claims.ts — the CLI entry of the labelling kit
  .render/     renderer output, git-ignored through annotations/.gitignore
  .gitignore
```

The tooling itself is in `../src/annotations/`:
`types.ts` (vocabulary) · `parse.ts` (loader + validator) · `score.ts` (scorer +
Wilson bound + gate verdict) · `report.ts` (human-readable output) ·
`read.ts` (read-only filesystem adapters) · `render-claims.ts` (the labelling
kit: template reader, mirrored join index, page and index renderers). The kit's
logic lives under `src/` so the package's 100% coverage gate covers it;
`tools/render-claims.ts` is the thin `tsx` entry behind the `render-claims`
script. The runner that wires the real parser to the loader is
`packages/core/test/hierarchy-gate.test.ts`.

## What gets committed (decision D8)

The filled-in `human/` files **are committed**, even though this is a public
repository and the transcripts they describe are not. That is safe because of
what the format can carry — checked against both templates:

- `## meta`: the session uuid, `provenance`, the substrate directory name under
  `spike/`, `labeled-by`, `labeled-on`;
- `## edges`: a child hex, a verdict token or parent hex, and the comment —
  `<agentType>: <description>`, the one-line label the spawning `Agent` call gave
  its subagent, exactly as already committed in `templates/`.

No message text, prompt, tool result, file path or machine path appears in
either section, and step 6 adds none: a verdict is one of four tokens. Keep it
that way. The transcripts stay in `spike/`, the excerpts stay in `.render/`
(git-ignored, never to be force-added), and only claim ids plus verdicts leave
the machine. Do not paste evidence lines into the prose sections "for
reference" — prose is ignored by the loader, but it is not ignored by `git`.

## Why `synthetic/` cannot sign the gate

The eight fixture annotations state the hierarchy that the fixtures were built to
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
