# Time-to-understand — measurement log

> ## ⚠ UNSIGNED — the `<30s to understand a session` gate is **NOT MET**
>
> This file is the recording artifact for
> [`time-to-understand-protocol.md`](./time-to-understand-protocol.md). It is
> **empty of measurements**. Nobody has yet sat in front of the dashboard with a real
> corpus and a stopwatch.
>
> An agent cannot sign a usability claim and must not fill this in. Until Ivan runs
> the protocol and signs §3 below, the v1.0 exit-gate clause stays ⏳ in `TODO.md` and
> `RELEASE.md` §6. A `PASS` here is the *only* thing that changes that — and a `FAIL`
> here is a perfectly good outcome that names what to fix.

---

## 1. Run header

Fill this in once per run, by hand, before the first trial.

| Field | Value |
| --- | --- |
| Date | _(YYYY-MM-DD)_ |
| Operator | _(name — a human, not an agent)_ |
| Build | _(`git rev-parse --short HEAD`)_ |
| Corpus | _(`~/.claude/projects`, N sessions / M projects)_ |
| Server | _(`pnpm --filter @agenthropic/server dev`, port 4317)_ |
| UI | _(`pnpm --filter @agenthropic/web dev`, port 5173)_ |
| Ingest settled before first trial? | _(yes / no — "no" voids the run)_ |

## 2. Summary

One row per trial. `T_session` = Q1 + Q2 + Q3s, in seconds, one decimal.
Verdict vocabulary: `PASS · FAIL(time) · FAIL(wrong) · FAIL(unanswerable) ·
FAIL(discipline) · VOID` (protocol §4).

| Slot | Session id | Q1 s | Q2 s | Q3s s | **T_session** | Verdict | Note |
| --- | --- | --- | --- | --- | --- | --- | --- |
| P (practice, excluded) | | | | | | | |
| S1 | | | | | | | |
| S2 | | | | | | | |
| S3 | | | | | | | |
| S4 | | | | | | | |
| S5 | | | | | | | |

Fleet questions (scored separately — the "all five answerable" clause):

| Item | Trial | Seconds | Verdict | Note |
| --- | --- | --- | --- | --- |
| Q3f (anything stuck fleet-wide) | | | | |
| Q4 (today / week / savings) | | | | |
| Q5 (persisted across restart) | | | | |

**Gate arithmetic** (protocol §4 — do not adjust after seeing the numbers):

- Every session-scoped answer in S1…S5 correct? _(yes / no)_
- `T_session < 30.0 s` in ≥ 4 of 5 trials? _(yes / no)_
- No trial above 45.0 s? _(yes / no)_
- **Gate met** = all three `yes`. → _(MET / NOT MET)_

## 3. Signature

> Signing means: I personally ran the protocol as written, the numbers above are what
> the stopwatch said, and the verdict is what the numbers give — not what I hoped for.

```
Result:     ______________________   (MET / NOT MET)
Signed by:  ______________________   (human name)
Date:       ______________________
Build:      ______________________
```

Unsigned = unmeasured = the gate is open. There is no third state.

## 4. Trial records

`node scripts/time-to-understand.mjs run <sessionId> --label <slot>` appends one block
per trial below, verbatim and append-only. Hand-written blocks are fine too — the
format is the point, not the tool. Nothing here is ever edited after the fact; a
correction is a **new** block that says what it corrects.

The shape of a block, for reference:

Every value below is a `<placeholder>` on purpose. This block is a SHAPE, not a
reading — no real timestamp, no real session id, no verdict word, so that nothing
in this file can ever be skimmed, grepped or quoted as if a trial had happened.

```
### Trial <slot> — <ISO timestamp> — session <session id>
build: <short sha> | corpus: <corpus path>

| Item | Seconds | Answer given | Ground truth | Correct |
| --- | --- | --- | --- | --- |
| Q1  | <s> | <what you typed> | <what the API says> | <y/n> |
| Q2  | <s> | <what you typed> | <what the API says> | <y/n> |
| Q3s | <s> | <what you typed> | <what the API says> | <y/n> |
T_session: <sum of the three> s → <PASS | FAIL(time) | FAIL(wrong) | FAIL(unanswerable) | FAIL(discipline) | VOID>
Notes: <what was slow, what misled, what was missing>
```

<!-- trial records are appended below this line -->
