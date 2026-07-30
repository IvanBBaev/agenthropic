# ADR-NNN: <short decision title>

- **Status:** proposed | accepted | deferred | superseded by ADR-MMM
- **Date:** <YYYY-MM-DD>
- **Deciders:** <who>
- **Source:** <link to concept-analysis-v2 §, DESIGN §, or development-plan §>

<!--
  AMENDMENT SECTIONS (optional, append-only) go HERE — after the metadata list,
  before ## Context. See "Amending an ADR" below for the rules.
-->

## Context
What forces are at play — the technical and product pressures, the constraint, the
open question. State it neutrally.

## Decision
The choice, in one or two sentences. Present tense ("We bind loopback only").

## Acceptance criteria
Quantified, testable conditions that make this decision "done" / verifiable (copy from
the canonical decision where one exists).

## Consequences
- **Positive:** what this buys us.
- **Negative / costs:** what it makes harder.
- **Follow-ups:** WPs, gates, or later decisions this creates.

## Alternatives considered
What else was on the table and why it lost.

---

## Amending an ADR (how this repo records "reality disagreed")

An ADR is an **immutable historical record**. It states what was decided, when, by
whom, and on what evidence *at that time*. When reality later diverges — the thing
was built differently, the acceptance criteria were overridden, the spike came back
with different numbers — the original text is **never** rewritten, softened, or
deleted. An ADR that was contradicted by what got built is not a wrong document; it
is a correct record of a decision that reality then amended. Rewriting it destroys
the one thing an ADR exists for.

Instead, **append** a dated amendment section. The convention already in use in this
directory is a level-2 heading placed **after the metadata bullet list and before
`## Context`**, so a reader meets the amendment before the original reasoning:

```markdown
## As-built update — YYYY-MM-DD

**Verdict:** holds | holds, strengthened | amended in practice | partially built |
overridden | superseded by ADR-MMM

<What was actually built, in plain terms. What diverged from the decision below and
why. Whether the decision still holds. Link the code, migration, workflow or gate
that is the evidence.>
```

Existing amendment headings follow the same shape and are equally valid — e.g.
`## Empirical update — 2026-07-04 desktop probe` on the ADRs the desktop probe
touched. Use `As-built update` for divergence between a decision and shipped code;
use `Empirical update` for new evidence that does not itself change what was built.

Rules:

1. **Append only.** Never edit `Context`, `Decision`, `Acceptance criteria`,
   `Consequences` or `Alternatives considered` after an ADR is accepted.
2. **One section per amending event**, newest last. Do not merge two amendments.
3. **Update the `Status:` line** to reflect the amended reality, and keep the
   original wording visible where it still matters (strike through with `~~…~~` plus
   an italic parenthetical naming the date and the amending source, rather than
   deleting). The `Status:` line is metadata, not the decision record — it is the one
   field that is expected to change over time.
4. **Never let an amendment read as a pass.** If an acceptance criterion was not met
   and work proceeded anyway, the verdict is `overridden`, and the amendment names
   who overrode it and what remains open. "Overridden" and "satisfied" are different
   words for different facts.
5. **Mirror the new status** in the [ADR index](README.md) table.

For non-ADR pages in `contributing/` the equivalent convention is a blockquote near
the top of the page beginning `> **Update — 2026-07 (as built).**` — pages are living
documents and may be revised in place; ADRs are not.
