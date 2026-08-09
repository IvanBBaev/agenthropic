# Time-to-understand — measurement protocol

**What this is.** The v1.0 exit gate (roadmap §5, `TODO.md` Phase 4, `RELEASE.md` §6)
contains one clause that no test can close:

> all 5 daily questions answerable · **<30s to understand a session** · tree & global
> DAG served by a query over persisted edges · every dollar traces to tokens × price

Three of those four are proven by code and are green. The `<30s` clause is a
**usability claim about a human**, and it is currently **unmeasured**. This document
turns it from a feeling into a bounded, repeatable ~10-minute procedure with a
recorded result.

**Who may run it.** Ivan, and only Ivan. An agent cannot sign a usability claim: it
has no stopwatch, no eyes and no stake in the answer. No automated process may fill
in the log, and nothing in this repository asserts the gate is met until the log
carries a human signature.

---

## 1. Operational definition

"Understanding a session" is **not** a vibe. It is: *answering specific questions
correctly, from the dashboard, without looking anything up afterwards.* The questions
are the project's own five daily questions, recorded verbatim as decision **D3**
(`docs/analysis/implementation-plan.md` §D3) and used as the v1.0 definition of value
in `docs/analysis/best-path-decision.md` §6.1:

> Q1 *What is the subagent tree of this session, and which branch is still running?*
> Q2 *Which agent/subagent burned the most tokens (and roughly what did it cost)?*
> Q3 *Did any session get stuck / error without me noticing?*
> Q4 *What did today/this week cost, and how much did Haiku/Sonnet routing save?*
> Q5 *Show me last night's sessions — persisted, after a restart.*

Two of the five are about **one session** (Q1, Q2); Q3 has both a session-scoped and a
fleet-scoped reading; Q4 and Q5 are about **the fleet**. The gate clause says "to
understand *a session*", so the measured quantity is split accordingly:

| Item | Question | Scope | Counts toward |
| --- | --- | --- | --- |
| **Q1** | agent count + which branch is still running | session | **T_session** |
| **Q2** | biggest token burner + its dollar cost | session | **T_session** |
| **Q3s** | did *this* session get stuck or error | session | **T_session** |
| Q3f | did *any* session get stuck without me noticing | fleet | recorded separately |
| Q4 | today / this week cost, and delegation savings | fleet | recorded separately |
| Q5 | last night's sessions, after a server restart | fleet | recorded separately |

**T_session** = Q1 + Q2 + Q3s, measured as one continuous sitting on one session,
including all navigation between them. **T_session is the number the gate is about.**
The per-question splits are recorded too, because a failure that is 25 s of Q2 is a
different bug from a failure that is three 10-second questions.

### Answer format (fixed, so grading is mechanical)

| Item | You must state | Correct when |
| --- | --- | --- |
| Q1 | `<N> agents; running: <id prefixes \| none>` | N matches `agentCount`; the running set matches the agents with status `working` |
| Q2 | `<agent id prefix \| unattributed>; $<amount>` | the named agent is the one with the highest `totalTokens` (or `unattributed` when that bucket is the largest); the amount is within ±10% or ±$0.01, whichever is larger |
| Q3s | `clean` or `stuck: <id prefixes>` | matches this session's `statusCounts.error + .unknown` |
| Q3f | `none` or `<session id prefixes>` | matches the set of sessions with `error` or `unknown` counts > 0 |
| Q4 | `today $<x>; week $<y>; savings $<z \| not shown>` | x and y within ±10% of the per-day rollup; `not shown` is a **legitimate and expected** answer for savings — see §6 |
| Q5 | `<N> sessions from <date>, ids <prefixes>` | the same ids are present before and after the restart |

An answer you cannot state is `unknown` — which is a **failure**, recorded as one.

---

## 2. Setup (10 minutes total, this part is ~3)

The corpus is read **read-only**: the corpus adapter
(`apps/server/src/corpus/node-corpus-fs.ts`) imports no write, rename, unlink or
open-for-write symbol, so pointing the server at `~/.claude/projects` cannot mutate
it. Everything agenthropic writes goes to its own SQLite file.

```sh
# 1. Real corpus, real database. Loopback only, as always.
export DASHBOARD_TOKEN='<your token>'
pnpm --filter @agenthropic/server dev        # http://127.0.0.1:4317

# 2. In a second shell — the UI (proxies /api to 4317).
pnpm --filter @agenthropic/web dev           # http://127.0.0.1:5173

# 3. Let ingest finish. Watch the sessions count stop growing before you start;
#    a measurement taken mid-replay measures the replay, not the UI.
curl -s -H "Authorization: Bearer $DASHBOARD_TOKEN" \
  http://127.0.0.1:4317/api/sessions?limit=1 | head -c 200
```

Then pick the sessions **before** the clock ever starts, using the fixed rule below —
never by browsing for a session that looks convenient:

```sh
node scripts/time-to-understand.mjs select
```

It prints session ids **and nothing else about them** (no counts, no dollars), so
looking at the selection does not pre-answer any question. The rule it applies:

| Slot | Rule | Why this one |
| --- | --- | --- |
| P | any session not in S1…S5 | practice run, recorded, excluded from the gate |
| S1 | most recent session with ≥ 5 agents | a real tree |
| S2 | highest-cost session in the last 7 days | the cost path under load |
| S3 | a session with an `error` or `unknown` agent | the ATTENTION path (if none exists, record "no such session" — the absence is data) |
| S4 | the oldest session still in the database | cold context, nothing remembered |
| S5 | a session with exactly one agent | the trivial case must not be *slower* than the complex one |

---

## 3. Procedure

Run the practice trial P first, then S1…S5 in order.

```sh
node scripts/time-to-understand.mjs run <sessionId> --label S1
```

**Clock rules — read these once, then obey them exactly.**

1. **Start closed.** Before each item, the browser sits on the default view
   (`#/live`), freshly reloaded, and **you are not looking at it**. Look at the
   terminal instead.
2. **The script prints the question. You press Enter, and only then look at the
   screen.** That Enter is T0.
3. **Press Enter again the moment you know the answer.** That is T1. The clock stops
   when you *know*, not when you have finished typing — typing speed is not what the
   gate is about.
4. **Then type the answer without looking back at the screen.** If you need a second
   look, the item is a **FAIL (discipline)**; say so and the log records it. An answer
   you cannot hold in your head for five seconds was not understood.
5. **No devtools, no `curl`, no SQL during a timed item.** The dashboard alone.
6. Between items you may navigate freely — that navigation time is inside T_session
   and is supposed to be.
7. **One trial per session, ever.** A session you have already been timed on is burnt:
   you now remember the answers. If a trial is voided, pick a *new* session by the
   same rule and record the void.

After the six items, the script fetches ground truth from the read API and prints it
next to your answers. You mark each `y` / `n`. The script never decides correctness
for you and never edits an answer you typed.

Q5 needs a restart: the script pauses, you `Ctrl-C` the server, start it again, reload
the browser, press Enter, and then the Q5 item runs. Restart time is **not** in the
clock; the clock starts when the reloaded page is in front of you.

---

## 4. Pre-registered pass criteria

These thresholds are fixed **before** the first run. Do not move them after seeing a
number. If they turn out to be wrong, change them in a separate commit, before the
next run, and note the change in the log.

The `<30s to understand a session` gate is **met** when all of:

- **Correctness is absolute.** Every session-scoped answer (Q1, Q2, Q3s) in every one
  of S1…S5 is correct. One wrong answer fails the gate — and names the bug.
- **Time.** `T_session < 30.0 s` in **at least 4 of the 5** trials, and **no** trial
  exceeds 45.0 s.
- The practice trial P is excluded from both criteria.

Recorded but scored separately (they belong to the *"all 5 questions answerable"*
clause, not to the session clock): Q3f, Q4 and Q5 must each be answered correctly in
at least one trial, with their times reported.

**Anything else is a FAIL.** A protocol that can only produce a pass is worthless, so
the failure modes are named up front and every one of them has a slot in the log:

| Verdict | Meaning |
| --- | --- |
| `PASS` | correct and inside the time bound |
| `FAIL(time)` | correct, but too slow — the answer is there and the UI buries it |
| `FAIL(wrong)` | fast, but wrong — worse than slow; the UI is confidently misleading |
| `FAIL(unanswerable)` | the data is not on any screen; name the missing surface |
| `FAIL(discipline)` | you looked back, used devtools, or already knew the session |
| `VOID` | something outside the measurement broke (ingest mid-replay, server down) |

A `FAIL` is a result, not an embarrassment. It is the only kind of result that tells
you what to build next.

---

## 5. Recording

Everything lands in [`time-to-understand-log.md`](./time-to-understand-log.md) — the
script appends a block per trial; it never rewrites or deletes an existing one. Fill
in the session-selection rule, the build (`git rev-parse --short HEAD`) and the corpus
size by hand at the top of the run.

**The log is the result. Memory is not.** If a run is not in the log it did not
happen, and if the log says `FAIL` then the gate is not met, regardless of how the run
felt.

---

## 6. Pre-registered known risk: Q4's savings half

Stated here *before* the measurement, so it is a prediction and not an excuse.

The delegation-savings figure (`WP-C5`) exists and is correct on the server:
`GET /api/sessions/:id/cost-analysis` returns `delegationSavings.savingsUsd` with its
`isEstimate` label intact. **No view calls it.** `apps/web/src/api.ts` exposes exactly
four reads — health, sessions, session tree, global DAG, cost summary — and the cost
view renders Total cost / Total tokens / Unpriced tokens, per-model, per-day and
top-sessions. The `Today $ / This week $ / Delegation saved $` KPI strip designed in
`docs/analysis/ux0-design.md` §3(d) was not built.

So the expected honest answer to Q4 is `savings: not shown`, and the expected verdict
for the savings half is `FAIL(unanswerable)`. If the measurement confirms that, the
fix is a UI change, not a protocol change — and the gate stays open until it lands.
Similarly, "this week" currently has to be summed by eye across seven rows of the
per-day table; if Q4 fails on time, that is why.

---

## 7. Signature

**This protocol is unsigned and the gate is UNMET until Ivan runs it.** Nothing in
this file, in the log, or in any agent's report may be read as evidence that the
`<30s` clause is satisfied. The only thing that can satisfy it is a completed log with
a human name on it.
