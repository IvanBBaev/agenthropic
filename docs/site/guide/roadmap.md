# Roadmap

This page walks through agenthropic's build plan phase by phase — what ships in each
phase, in plain language, and the exit gate that has to pass before the next phase is
allowed to start. The key takeaway: **nothing gets built until a throwaway feasibility
spike (Phase 0) proves the core idea works on real data**, and after that, **security
and test coverage are live from the first line of product code (Phase 1), not
retrofitted later.** Every phase is independently shippable — each one leaves behind a
working, useful system, not a half-finished slice.

As of this writing, agenthropic is **pre-Phase-0**: the design and the build plan
described below are finished, but the **formal** spike has not yet run and no application
code is scaffolded. A read-only desktop probe of the real `~/.claude/projects/` corpus
(2026-07-04) has, however, already **pre-answered CD-1 — the spike's core verdict — as
CONDITIONAL-GO → build (confidence 85)**; the formal spike confirms that on the
paired-capture corpus. See [the Phase-0 corpus probe](../../analysis/phase0-probe.md).

> **Update — 2026-07 (as built). This is the page that was most wrong, so read this box
> before anything below it.**
>
> **The paragraph above is stale, and the phase model it introduces has been superseded.**
> Phases 0–4 are built. More importantly, the schedule that governs this project is no
> longer a phase sequence at all — it is a **kill-checkpoint calendar with default-death
> semantics**, and **two of its checkpoints have already been passed unmet**. Both facts
> are set out in the new section
> [Update — the real schedule: kill checkpoints, and two that were missed](#update--the-real-schedule-kill-checkpoints-and-two-that-were-missed)
> immediately below. Everything after that section is preserved as the design record, with
> `*(As built: … )*` notes on the claims that resolved differently.
>
> Short version of what is true today: implementation began **2026-07-11**, by explicit
> owner override of the CD-8 no-code-before-GO gate — **not** because the gate opened.
> Running now: the loopback-bound, token-gated server; SQLite/WAL with migrations; JSONL
> ingest with replay-on-startup; the persisted subagent DAG; the cost engine; the hook
> receiver; the SSE hub; the read API; and all four dashboard views. **72 test files / 879
> tests pass**, coverage gated >90% in every shipped package. The three P0 correctness
> proofs are green and merge-blocking. **Phases 5–6 (alerting) are not started, are v2.0,
> are entered only via KC-5, and may never start** — the operator-alerts API and UI were
> cut outright. The Phase-0 numbers quoted above and below remain **PROVISIONAL** until
> ratified against a hand-labeled corpus.

## Update — the real schedule: kill checkpoints, and two that were missed

The phase sequence in the rest of this page describes *what* gets built and in what
dependency order. It was never a calendar. The calendar is a set of six **kill
checkpoints**, KC-0 through KC-5, adopted on 2026-07-10 and governed by **default-death**:
at each checkpoint the project's default branch is *archive*, and it continues only if the
checkpoint's condition is affirmatively met by its date. A deferral is not a third state —
a deferral *is* the failure.

| Checkpoint | Date | Condition to continue | Failure branch | Outcome |
|---|---|---|---|---|
| **KC-0** | 2026-07-13 | Gate A signed **and** the friction log opened **and** ≥1 rival dashboard installed for a two-week trial | Archive the repo; salvage the security posture and probe method as a write-up | **PASSED UNMET** — Gate A was signed 2026-07-10, but the friction log was never opened and no rival was ever installed. 2 of 5 boxes open at the deadline. |
| **KC-1** | 2026-07-27 | The WP-S7 verdict written (GO or CONDITIONAL-GO) **and** the throwaway DAG-with-dollars render exists **and** the 14-day friction log does **not** show a rival answering ≥4 of the 5 daily questions acceptably | Archive | **PASSED UNMET** — see below. |
| **KC-2** | 2026-09-14 | Phases 1–2 exit gates green (security spine live, >90% gate blocking, ingest idempotent, kill+restart zero-loss) | Descope per the ladder if the P0 chain is intact; otherwise archive | Not yet reached |
| **KC-3** | 2026-10-12 | The three P0 release blockers green and merge-blocking | Archive — "the moat proof *is* the project" | Not yet reached; the three proofs are already green |
| **KC-4** | **2026-12-01** | v1.0 tagged: five daily questions answerable, <30s time-to-understand, tree/DAG served from `orchestration_edges`, every dollar traceable. **This date does not move.** | Archive + a public write-up of what was learned. No third rebase exists. | Not yet reached |
| **KC-5** | earned, never dated | v2.0 entry: **14 consecutive days of real daily use of v1.0 by its own author**, plus ≥3 dated friction-log entries asking for alerts | v2 cancelled; maintenance mode | Not entered; may never be |

### Why "passed unmet" and not "passed"

**KC-0** required three things. One was done (Gate A signed, 2026-07-10). Two were not:
the friction log was never opened, and no rival dashboard was ever installed. The deadline
arrived with those boxes open, which under default-death means archive.

**KC-1 is the sharper case, and worth stating precisely.** Two of its three clauses were
satisfied well ahead of time — the WP-S7 verdict is written, and the throwaway
DAG-with-dollars render exists. The third clause reads: *the 14-day friction log does not
show a rival answering ≥4 of the 5 daily questions acceptably.* That clause was
**unsatisfiable by construction**, because the friction log was never opened. An unopened
log cannot report a reading — so the condition could not be evaluated at all, in either
direction. **A checkpoint whose condition cannot be evaluated has not been passed; it was
skipped.** Calling KC-1 "met" would mean treating an absence of evidence as evidence, which
is exactly the failure mode the checkpoint existed to prevent.

The specific thing that was never tested, and still has not been: **whether an existing
free dashboard would have answered the daily questions well enough that agenthropic did not
need to exist.** That was designed to be the cheapest experiment available. It was never
run.

### What actually kept the project alive

Three explicit owner overrides, recorded in the repository's own tracker:

| Date | Scope | What it did |
|---|---|---|
| **2026-07-11** | Implementation start | Overrode CD-8 (no production code before a GO verdict) after being told that CD-8's remaining conditions — LABEL-ME ratification of the CONDITIONAL GO, and KC-0's two physical boxes — were the block. Scaffolding began that day. |
| **2026-07-18** | Dispatching only | KC-0's date had passed with its two physical boxes unchecked; the default branch was archive. Work was instructed to continue. |
| **2026-07-29** | Dispatching only | KC-1's date had passed unmet for the reason above; the default branch was archive. Work was instructed to continue. |

None of the three overrides relaxed anything else. The security invariants, the KC calendar
itself, the LABEL-ME ratification (the spike numbers stay **PROVISIONAL**), and the
no-commit-without-an-explicit-ask rule all remain in force, and the two physical acts — open
the friction log, install a rival — remain open and remain the owner's.

**Say it plainly: work continues by owner decision, not because the gates were satisfied.**
KC-4 (2026-12-01) is the next hard date, and that one does not move.

### Where the phases below actually stand

| Phase | Status |
|---|---|
| 0 — Feasibility spike | Probe done (`CONDITIONAL GO`, confidence 85). The formal spike's paired-capture corpus and human tree sign-off were **not** completed before code started; the numbers stay **PROVISIONAL** pending hand-labeled ratification. |
| 1 — Foundation, security spine, storage | **Built.** Loopback bind, mandatory token, WAL, migrations, append-only `events_raw` with triggers, coverage and static gates in CI. |
| 1.5 — Animated-room view | **Not built.** Still optional, still unscheduled. |
| 2 — Ingest substrate | **Built, with a recorded divergence** — see the note on that section. There is no single merged cross-source event log. |
| 3 — Projection, DAG moat, reconciliation, cost | **Built, with a recorded divergence** — no separate Normalizer/Projection stage, and the DAG is derived from JSONL alone rather than "two independent paths." All three P0 proofs are green. |
| 4 — Read API + dashboard | **Built** — all four views. The "<30s to understand a session" exit criterion is **unmeasured**; nobody has timed it. |
| 5 — Alerting core | **Not started.** v2.0, behind KC-5, may never start. |
| 6 — Operator alerts UI + release hardening | Alerts API + UI **cut outright**. Release hardening is tracked separately. |
| Experimental — context-layer feed | **Not built**; the placeholder was deleted rather than left as a stub. |
| Deferred — fleet aggregation | Only the schema key exists, and only on `orchestration_edges`. No second host. |

Also still open, and worth naming rather than burying: the repository's own `LICENSE` is
not yet tracked in git, the GitHub Pages site is not yet enabled (the workflow is
committed, and its deploy job fails by design rather than pretending to succeed), and
**retention is not implemented** — redaction is live, but nothing prunes the database.

## How to read this roadmap

Two documents sit behind this page, and they describe the plan at two different
altitudes:

- The original design basis sketches a shorter, higher-level phase sequence (spike →
  hardened cockpit → an optional cosmetic detour → Telegram → a context-memory feed →
  delegation-savings → moat extensions).
- A later, adversarially-verified build plan decomposes that same sequence into 75
  independently assignable units of work, reconciles their dependencies into an acyclic
  graph, and re-derives the phase boundaries from that graph rather than from an
  author's guess. That re-derivation moved deliverables in both directions relative to
  the original sketch — most notably, Telegram alerting lands **later** than first
  sketched (it's now Phase 5-6, after the read API and dashboard, and — per the
  best-path decision, [`best-path-decision.md` §6.1](../../analysis/best-path-decision.md) —
  **post-1.0**: v1.0 is the daily-driver DAG + cost cockpit, with no alerts), while the
  delegation-savings cost metric actually lands **earlier**, folded directly into the
  Phase 3 cost engine instead of trailing behind Telegram and the context-layer feed as
  first sketched.

This page follows the **verified build plan's phase numbering (0–6, plus an
off-critical-path experimental track)**, since it is the canonical, dependency-checked
version. Where the two documents disagree on *when* something ships, this page says so
rather than picking one silently.

```
Phase 0 ──GO──▶ Phase 1 ──▶ Phase 2 ──▶ Phase 3 ──▶ Phase 4 ──▶ Phase 5 ──▶ Phase 6
 (spike)      (foundation)  (ingest)    (DAG moat    (dashboard)  (alerting)  (release
   │                                     + cost)                              hardening)
   │ NO-GO          │
   ▼                ├╌╌▶ Phase 1.5 — animated-room view (optional, cosmetic,
reconsider the      │      deferred; no earlier than Phase 5's Telegram work,
moat before          │      ideally after Phase 3's delegation-savings metric)
building anything    │
                     └╌╌▶ Experimental — context-layer feed (off critical path,
                            clearly labeled, non-blocking)
```

Phases 5–6 sit **after the v1.0 line**: per the best-path decision
([`best-path-decision.md` §6.1](../../analysis/best-path-decision.md)), v1.0 is the
daily-driver DAG + cost cockpit with **no alerts** — the alerting phases ship
post-1.0.

## Phase 0 — Feasibility spike (throwaway, hard GO/NO-GO stop)

**Goal, in plain terms:** before writing a single line of product code, empirically
settle the two riskiest bets — can the subagent tree be reconstructed reliably, and can
token costs be reconciled exactly against Claude Code's own record of what happened?

**What ships:** no product code at all. A disposable spike that:

- Captures at least three real, subagent-heavy Claude Code sessions in parallel —
  covering a crash with no clean stop, deep subagent nesting, a mid-session context
  compaction, and two overlapping instances — and hand-labels what the "correct"
  subagent tree looks like for each one.
- Tries to reconstruct that tree from the `~/.claude/projects/*.jsonl` transcript files
  **alone**, with no live hook data, and measures how close it gets to the hand-labeled
  answer.
- Checks whether a token-usage line in the transcript can be tied back to a specific
  agent by a reliable key, or only by a fuzzy heuristic.
- Confirms which lifecycle hooks actually fire in practice — in particular, whether the
  subagent-start signal is reliable and how a context compaction is marked.
- Confirms that summing token counts from the captured data matches the transcript's
  own ground-truth total **exactly**, with zero drift, and captures the baseline needed
  to reprice correctly across a compaction.

**Exit gate:** a single written verdict — **GO**, **CONDITIONAL-GO**, or **NO-GO** —
decided by a fixed rule: if the subagent tree can be rebuilt from the transcript files
alone at ≥95% accuracy, even simulating an outage of the live event stream, the
transcript becomes the primary source of truth; if it can't clear that bar, the live
hooks become primary instead, backed by a durable buffer so events survive downtime; if
neither clears the bar, the moat's feasibility itself is reconsidered before any build
starts. The verdict also requires a human sign-off that a rendered subagent tree
actually matches what happened in a real session — not just that a metric passed.

This is a **hard stop**: nothing else in this roadmap — not even the empty repository
scaffold — is allowed to start until this verdict reads GO or CONDITIONAL-GO.

**Already pre-answered, not yet closed.** The read-only desktop probe of the real corpus
(2026-07-04) has empirically settled this verdict as **CONDITIONAL-GO → build**
(confidence 85), which de-risks the gate — but it does **not** replace it. The formal
spike still has to confirm that on the paired-capture corpus and get a human sign-off on a
rendered subagent tree, and this hard stop stands until it does: no production code starts
early. See [the Phase-0 corpus probe](../../analysis/phase0-probe.md) for the numbers
behind the pre-answer.

> **As built: the hard stop did not hold, and it was overridden knowingly.**
>
> Code started **2026-07-11**, before the formal spike's paired-capture corpus was
> captured and before the human sign-off on a rendered tree. That was an explicit owner
> override of CD-8, made after being told in so many words that those were the remaining
> conditions. It was a decision, not an oversight, and it is recorded as one.
>
> The consequence is still live: **the Phase-0 numbers on this page — the ≥95% figure, the
> confidence-85 verdict, every percentage quoted from the probe — remain PROVISIONAL.**
> They come from a desktop probe against an unlabeled corpus, not from a spike measured
> against a hand-labeled answer key. Ratification against a hand-labeled corpus is still
> outstanding. Read them as strong indications, not as measurements.
>
> What *is* settled by test rather than by probe: the three P0 correctness checks in Phase
> 3 below are green and merge-blocking. Those are proofs. The Phase-0 accuracy percentages
> are not yet.

## Phase 1 — Foundation, security spine, storage

**Goal:** stand up the real project, but make security and automated quality gates live
from the very first commit — not something added at the end.

**What ships:**

- The project scaffold and toolchain, with continuous integration wired up from day
  one.
- A merge-blocking automated test-coverage threshold (**above 90%**), so coverage can
  only go up from here, never quietly regress.
- Static checks that turn the build red the moment anyone introduces a subprocess
  spawner, a URL dialed from untrusted event data (an SSRF path), or a dependency under
  a disallowed license.
- The SQLite **WAL** storage layer, plus a backup routine proven by an actually
  exercised restore — not just "a backup file exists somewhere."
- The append-only raw event log (`events_raw`), with its immutability enforced and
  tested: nothing can update or delete a row once written.
- The server bootstrap that makes the security invariants — loopback-only bind,
  mandatory auth token, same-origin checks on the live stream — real, running code,
  not a design promise. See [the security model](../security/model.md) for the
  invariants themselves.

**Exit gate:** typecheck, lint, and coverage are all green and actually block merges
below the threshold; the security/license static checks genuinely turn red on a
deliberately introduced violation; `events_raw` is proven append-only under test; WAL
mode is on and a restore has been exercised for real; the public documentation site is
building and publishing.

> **As built: this phase shipped, with one clause of the exit gate still open.**
>
> Live and tested: the loopback bind, the mandatory token (hashed, compared in constant
> time), WAL, the migration runner, `events_raw` immutability enforced by SQLite triggers
> and proven by test, the >90% coverage gate blocking merges in every shipped package
> (`packages/test-fixtures` is a deliberate, documented exclusion), and the static guards —
> which do turn the build red on a deliberately introduced spawner, SSRF sink, or
> disallowed license.
>
> Still open: **the documentation site is not publishing.** The workflow is committed, but
> GitHub Pages has not been enabled for the repository — an owner action nobody else can
> take. The deploy job fails rather than reporting a success it did not achieve. The page
> you are reading is in the repository; it is not yet served from a Pages URL.

## Phase 1.5 — Animated-room view *(optional, cosmetic, deferred)*

This is not a numbered step on the critical path — it's a side branch, and it stays
optional on purpose.

**The idea:** a second, purely visual way to look at the *same* live agent data — each
agent drawn as a character in a small animated office, its status
(`working`/`waiting`/`completed`/`error`) driving its animation, a subagent spawn adding
a new character. It reads from exactly the same persisted agents and live update stream
that Phase 1 already produces; it needs no new backend, no schema change, and no new
write or execution surface.

**Why it's gated, not scheduled:** the project's actual differentiators are the
persisted cross-session DAG and real dollar-cost attribution, built on owned
historical data (Telegram alerting is a planned post-1.0 convenience) — not an
animated room, which several existing open-source tools
already do well. Building a room before those differentiators exist would spend scarce
solo-project time on the least differentiated part of the product. The plan is
therefore to **adopt an existing MIT-licensed open-source renderer and adapt it**,
rather than build a sprite/animation pipeline from scratch, and to ship it only once
the real moat is in place — no earlier than the Telegram alerting work below (Phase 5),
and ideally only after the cost engine's delegation-savings metric (Phase 3) is live
too. It stays strictly **read-only**, inherits the loopback-and-mandatory-token
security posture, and is built as an isolated route that can be deleted without
touching the rest of the dashboard.

**What would disqualify a candidate renderer:** anything that *drives* Claude Code
itself (spawns a `claude` process) rather than just observing its output, and anything
under a copyleft license that would contaminate the rest of the codebase. Both concerns
ruled out the two richer-looking alternatives that were evaluated alongside the
adopted approach.

> **As built: not built, and still not scheduled.** No renderer was adopted, no room
> route exists, no candidate was even shortlisted beyond the original evaluation. The
> gating logic held — the moat came first — so this section is a plan that was correctly
> deferred, not a plan that failed.

## Phase 2 — Ingest substrate

**Goal:** get both real-world data sources — the live lifecycle hooks and the JSONL
transcript files — flowing into one immutable, deduplicated event log.

**What ships:**

- A shared envelope format so the same real-world fact, whether it arrives as a hook
  event or a transcript line, collapses into a **single** stored record instead of
  being double-counted.
- An authenticated, loopback-only HTTP receiver for hook events that accepts **any**
  event type without crashing — an event type it has never seen before is stored for
  later, not dropped.
- A transcript-file "tail" reader that resumes from a durable, persisted offset after a
  restart, with zero loss and zero duplication.
- An installer for the hooks themselves, and the versioned model-pricing table that
  Phase 3's cost work depends on.

**Exit gate:** a hook event and a transcript line describing the same fact collapse to
exactly one `events_raw` row; killing and restarting the ingest process resumes exactly
where the transcript reader left off; an unrecognized event type is stored, never
fatal; sensitive payload data is redacted at write time; the pricing table is seeded.

> **As built: shipped, but the first clause of that exit gate describes a design that was
> deliberately abandoned. It was never met, because it stopped being the goal.**
>
> There is **no single merged cross-source event log**, and no shared envelope that
> collapses a hook event and a transcript line into one row. The two sources were separated
> instead, on purpose:
>
> - **`events_raw` holds hook events only.** It is append-only, deduplicated by an
>   idempotency key within its own source, and redacted at write time. Each hook append and
>   its projected `events` row land in one transaction, so the two can never disagree.
> - **JSONL is parsed straight into the projections** — sessions, agents, token usage,
>   `orchestration_edges` — one transaction per session file. It does not pass through
>   `events_raw` at all.
>
> Why the change is an improvement rather than a shortcut: cross-source collapse would have
> required a synthetic identity for "the same real-world fact" observed two different ways,
> and getting that key wrong silently double-counts tokens — the one error the whole
> project exists to avoid. Keeping the sources separate makes hooks structurally incapable
> of contributing to the numbers. **Hooks are liveness only, never structure.** That is
> what makes the Phase 3 outage proof possible at all.
>
> The rest of the gate holds as written: the tail reader resumes from a persisted offset
> with zero loss and zero duplication (and replays the corpus on startup), an unknown event
> type is stored rather than fatal, redaction runs at write time, and the pricing table is
> seeded and versioned.
>
> One more correction to the bullets above: **four** hooks are installed and real —
> `UserPromptSubmit`, `Stop`, `SubagentStop`, `PreCompact`. Earlier drafts of this corpus
> spoke of a dozen. In particular there is **no `SubagentStart` hook**; it does not exist
> in Claude Code, which is precisely why the tree is derived from JSONL.

## Phase 3 — Projection, the DAG moat, reconciliation, cost

**Goal:** turn the raw event log into the actual product — the persisted subagent
hierarchy that is the project's core differentiator, reconciled token totals, and
dollar costs — and prove all three survive a crash, a restart, or a missing event.

**What ships:**

- A deterministic transform from raw events into normalized events, and from there into
  sessions, agents, and token usage.
  *(As built: deterministic, yes — proven by the byte-identical double-replay test — but
  there is no intermediate "normalized events" stage. The planned Normalizer and Projection
  steps were both dropped; JSONL parses directly into sessions, agents, token usage and
  edges in a single transaction per session.)*
- The persisted, per-instance `orchestration_edges` table — the actual moat artifact —
  built via **two independent paths**, so the subagent tree survives even if one signal
  (say, the dedicated subagent-start hook) never fires for a given session.
  *(As built: the table is real and is the moat artifact, but the redundancy works
  differently. It is not "hooks or JSONL" — it is **JSONL alone**, via four structural join
  paths inside the transcript: the `tool_use` link, the working directory, the
  task-notification recovery path, and the queue-operation path. The signal this was hedging
  against — a dedicated subagent-start hook — does not exist in Claude Code at all, so the
  hedge would have had nothing to fall back on. Deriving structure from the transcript alone
  turned out to be the stronger design, and it is the reason the outage proof below can be
  green.)*
- A reconciliation pass that assigns every `token_usage` record to exactly one agent,
  and a full rebuild-on-startup that must produce a byte-identical database if run
  twice in a row.
- A missing-stop watchdog, so an agent that never reports completion is marked
  **unknown** rather than staying falsely "working" forever.
- The cost engine: ground-truth tokens priced against the versioned pricing table,
  correct repricing across a context compaction against its pre-compaction baseline,
  and the delegation-savings metric — how much routing to a cheaper model saved versus
  always using the most expensive one.

**Exit gate:** three release-blocking correctness checks have to be green: the sum of
`token_usage` for a session matches the transcript's ground-truth total **exactly**;
replaying the whole event log twice produces a **byte-identical** database; and the
subagent DAG can be fully rebuilt from the transcript files alone after a simulated
outage. On top of that, the reconstructed hierarchy has to match a hand-labeled real
session at ≥95% accuracy even without the dedicated subagent-start signal, a
compaction has to reprice correctly, and no cost can ever silently compute to zero for
a model with no price on file — that's a hard failure, not a quiet default.

> **As built: this is the phase that delivered, and the exit gate is the one part of this
> page you can take literally.**
>
> **The three release-blocking proofs are green and merge-blocking today:**
>
> 1. **Σ `token_usage` equals the JSONL, exactly.** The check is deliberately hostile to
>    itself: the expected total is computed by an independent reader written inside the
>    test, not by the production parser, so a parser bug cannot quietly produce its own
>    passing evidence.
> 2. **A double replay produces a byte-identical database.**
> 3. **The DAG rebuilds from the transcript files alone after a simulated outage** — with
>    hooks separately proven to carry liveness only, never structure.
>
> A 12-scenario negative catalogue passes alongside them. The watchdog is real: an agent
> that never reports completion is marked `unknown`, a fifth status value alongside
> `working`, `waiting`, `completed` and `error`. Compaction repricing against the
> pre-compaction baseline is implemented, the delegation-savings metric is implemented, and
> a model with no price on file is a hard failure rather than a silent zero.
>
> **Do not read more into that than it says.** Three specific properties are proven. The
> ≥95% hand-labeled-accuracy clause in the same exit gate is **not** among them — that
> still rests on the PROVISIONAL probe numbers, and ratification against a hand-labeled
> corpus remains outstanding. "Exact, deterministic, and rebuildable" is proven. "95%
> accurate against a human's answer key" is not yet.

See [the DAG moat](../architecture/dag-moat.md) and [the cost model](../architecture/cost-model.md)
for the mechanics behind this phase.

## Phase 4 — Read API, the dashboard, and the five daily questions

**Goal:** put a real, authenticated user interface in front of everything the earlier
phases built.

**What ships:** authenticated, loopback-only read endpoints; a live update stream
(server-sent events) with same-origin enforcement and no wildcard cross-origin access;
and the React/Vite dashboard itself — a live status board, the session-scoped subagent
tree, the global cross-session DAG, and the cost/Sankey view — all served over a
resilient, reconnecting stream.

**Exit gate:** every one of the dashboard's core "daily questions" is answerable from
the UI; a new session's story is understandable in under 30 seconds; the tree and
global DAG views are proven to come from a **query over the persisted
`orchestration_edges` table**, not a reconstruction done in the browser from raw
events; and every dollar figure shown traces back to ground-truth tokens multiplied by
a dated, versioned price.

> **As built: shipped, with one clause of the exit gate never measured.**
>
> The read API is authenticated and loopback-only, the live stream is SSE with a
> same-origin check and no wildcard cross-origin access, and **all four views exist**:
> live status, the session-scoped subagent tree, the global cross-session DAG, and the
> cost-flow view. `apps/web` carries 127 tests and — since 2026-07-30 — actually runs
> them under a coverage gate.
>
> Two of the exit-gate clauses hold literally. The tree and global DAG are served by
> SQL over the persisted `orchestration_edges` table (`apps/server/src/db/edges.ts` →
> `apps/server/src/api/queries.ts`), not rebuilt in the browser; and every dollar
> figure is ground-truth tokens times a dated, versioned price, with anything unpriced
> surfacing as `unpricedTokens` rather than a silent `$0`.
>
> **The "understandable in under 30 seconds" clause has never been measured.** Nobody
> has sat down with a stopwatch and a session they didn't already know. It is not
> claimed as met — it is simply untested, and it needs a human, not an agent.

## Phase 5 — Alerting core *(post-1.0)*

**Goal:** turn the dashboard from something you have to look at into something that
tells you when it needs your attention — starting with a Telegram relay. This phase
sits past the v1.0 line: alerting is a post-1.0 convenience, not part of the v1.0
cockpit ([`best-path-decision.md` §6.1](../../analysis/best-path-decision.md)).

**What ships:** the alert and webhook data schema; a secret-handling design that never
stores a raw token in the database (only a reference to a locally-held secret); a
webhook dispatcher hardened against SSRF, so it only ever calls operator-configured
targets and never a URL taken from event payload data; a rules engine for cost
thresholds, stuck agents, and errors; the Telegram delivery adapter; and a delivery log
with retry/backoff and throttling, so one real problem produces one notification, not a
flood.

**Exit gate:** a real triggering condition (say, a stuck agent) produces **exactly one**
throttled notification; a dedicated test proves the dispatcher never dials a URL taken
from event data; and the secret token never appears in the database, the live stream,
or the logs.

> **As built: not started, and it may never be.** There is no `alert_rules` table, no
> `webhook_targets` table, no dispatcher and no Telegram adapter anywhere in the
> repository — the grep is empty, not thin. This phase is v2.0 work, and v2.0 is
> entered only through **KC-5**, the one checkpoint with no date on it: it is earned by
> the dashboard surviving real daily use, or it is never entered at all. Read this
> section as a design that is on file, not a queue position.

## Phase 6 — Operator alerts UI + release hardening

**Goal:** let you actually manage alert rules and targets from the UI, and formally
close out the release. The alerts-UI scope here is post-1.0, like Phase 5; the
release-hardening checklist applies to any release.

**What ships:** authenticated create/read/update/delete endpoints for alert rules and
webhook targets; an alerts UI that shows a target by name only — never the underlying
secret; a hardened negative-test suite for the alerting surface; and a release
checklist enumerating every security and coverage gate, including a live-fire backup
restore.

**Exit gate:** an operator can fully manage rules and targets from the UI; no endpoint
or view ever exposes a raw secret; the alerting code is covered at the same >90% bar as
everything else; the release checklist is complete.

> **As built: split in two — the alerts half is cut, the release half is done.** The
> operator-alerts API and UI follow Phase 5 into v2.0 behind KC-5 and were cut outright
> from v1.0. The release-hardening half, which never depended on alerting, exists:
> [`RELEASE.md`](https://github.com/IvanBBaev/agenthropic/blob/main/RELEASE.md)
> enumerates every build-failing gate and the backup-restore drill. Its remaining
> unticked boxes are human acts — tracking the `LICENSE` file, enabling Pages and
> branch protection, ratifying the labeled corpus — not missing code.

## Experimental, off the critical path — context-layer feed

Alongside the six numbered phases, the plan keeps a strictly **experimental**, clearly
labeled, non-blocking track: a read-only feed of session and agent data into a future
memory/vector-database layer (the "observability becomes memory" idea from the design
basis). It is deliberately isolated so nothing in the core dashboard imports it, its
coverage is excluded from the >90% gate while it stays experimental, and the API key
that would drive it is kept out of the dashboard's own runtime environment entirely —
a security boundary, not a convenience.

> **As built: nothing here exists.** No feed, no adapter, no API key, no excluded
> coverage directory — the track stayed experimental in the sense of never having been
> started. It remains on file as an idea, which is exactly the status it was given.

## What's deliberately *not* scheduled yet

The design basis names **cross-machine / fleet aggregation** (running agenthropic
against more than one host) as one of five things no existing tool delivers. The data
model already carries the `instance`/`host` key needed to support it later, but
building the aggregation itself is **not** one of the 75 work packages in the current
six-phase plan — it remains a future decision, not a scheduled deliverable, **deferred
until a second host physically exists**
([ADR-0002](../contributing/decisions/adr-lb-2-personal-first-commercial-clean.md)/[ADR-0012](../contributing/decisions/adr-cd-10-scope-secrets-retention.md)).
If a second host ever materializes, the work would extend the same persisted DAG that
Phase 3 builds.

## How the build is actually scheduled: parallel waves, not a single line

The phases above describe *what* ships and in *roughly* what order, but the underlying
build plan is not a single sequential todo list. It decomposes into many small,
independently assignable units of work — each one sized for a single engineer (or
agent) to own end-to-end, with explicit inputs, a concrete deliverable, and a testable
definition of done. Those units are arranged into a dependency graph, verified to have
no cycles, and grouped into **sequential waves**: every unit of work in a given wave
can be handed to a different engineer to build **concurrently**, as long as everything
in the previous wave has already merged. Concretely, the current plan is 75 such units
across 9 specialty tracks (ingest, data, backend, cost, frontend, devops, security, QA
and docs), arranged into 17 waves.

In generic terms, the shape looks like this:

| Wave range | What happens concurrently |
|---|---|
| Early waves | Phase 0's spike: capture the labeled corpus, then run the tree-from-transcript, join-key, and hook-catalog probes in parallel, then a legibility sign-off and a token-reconciliation probe, converging on the single GO/NO-GO verdict. |
| Right after GO | The repository scaffold — deliberately the *only* thing that depends on the verdict, so it can start the moment GO lands. |
| Mid waves | Phase 1 fans out widely: toolchain, coverage harness, storage/WAL driver, migration runner, CI pipeline, the security static gates, and the server bootstrap that turns the (initially failing) security tests green — many of these run at the same time once the scaffold exists. |
| Middle-to-late waves | Ingest, the normalizer, the projection, and the dual-path DAG derivation (the moat core) proceed along a mostly sequential chain, while the read API, SPA shell, and cost-engine foundations build in parallel alongside them. |
| Late waves | Reconciliation, the three release-blocking correctness tests, the dashboard views, and the alert rules engine converge. |
| Final wave | Alerting hardening and the release checklist close out the plan. |

A single sequential chain runs through this whole graph — the **critical path** — that
determines the earliest the whole plan can finish: the scaffold, then the storage
substrate, then the append-only raw event log, then the normalizer, then the
projection, then the missing-Stop watchdog, and from there straight into alerting's own
chain — the rules engine, the operator alerts API, the alerts UI, and its negative-test
hardening. A separate, independent sub-chain — the **moat spine** — peels off after the
projection instead and runs through the dual-path DAG derivation, reconciliation, and
replay-on-startup, landing the three release-blocking correctness tests on its own
schedule without ever touching alerting. Alerting turns out to be the **longest tail of
the whole graph** — by design, it's Phase 5-6, post-1.0 work — so its lowest-risk pieces (the
alert port design and schema) are started early, in parallel with unrelated tracks, so
alerting doesn't end up being the very last thing blocking a release.

> **As built: the wave model survived; the numbers did not.** The build did run as
> concurrent waves of independently owned units — but as **four** waves of agent lanes
> over roughly three weeks, not 17 waves across 9 tracks, and the units were lanes
> owning disjoint file paths rather than the 75 catalogued work packages. Wave 1 built
> the ingest loop, the cost engine, the read API and SSE hub, the hook receiver and the
> SPA shell in parallel; Wave 2 added the three P0 proofs, the negative catalogue and
> the cost-analysis API; Wave 3 the release scaffolding; Wave 4 the four real views and
> the events projection. The critical path described above never ran to its end,
> because its tail is alerting and alerting was cut — what actually landed is the
> **moat spine**: substrate → ingest → projection → dual-path DAG → reconciliation →
> replay-on-startup → the three release-blocking tests. The sub-chain that was designed
> to peel off from the main line turned out to be the whole build.

## See also

- [What is agenthropic](what-is-agenthropic.md) — the one-paragraph pitch.
- [The moat](the-moat.md) — the five things no existing tool delivers, and why that's
  worth building instead of forking.
- [Comparison vs the field](comparison.md) — how agenthropic stacks up against the
  baseline and the audited alternatives.
- [The DAG moat](../architecture/dag-moat.md) — how the persisted, per-instance
  orchestration graph actually works.
- [Cost model](../architecture/cost-model.md) — dual-pricing and delegation-savings.
- [Security model](../security/model.md) — the invariants every phase above has to
  hold: loopback-only bind, mandatory token, no spawner, no SSRF.
- [Backup & restore](../operations/backup-restore.md) — the WAL/backup/restore
  discipline that ships in Phase 1.
- [Testing & quality](../contributing/testing.md) — the coverage gate and the P0
  correctness tests that gate Phase 3.
- [FAQ](faq.md) — for questions this page doesn't answer directly.
