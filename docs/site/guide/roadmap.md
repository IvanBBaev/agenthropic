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

## Phase 3 — Projection, the DAG moat, reconciliation, cost

**Goal:** turn the raw event log into the actual product — the persisted subagent
hierarchy that is the project's core differentiator, reconciled token totals, and
dollar costs — and prove all three survive a crash, a restart, or a missing event.

**What ships:**

- A deterministic transform from raw events into normalized events, and from there into
  sessions, agents, and token usage.
- The persisted, per-instance `orchestration_edges` table — the actual moat artifact —
  built via **two independent paths**, so the subagent tree survives even if one signal
  (say, the dedicated subagent-start hook) never fires for a given session.
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

## Experimental, off the critical path — context-layer feed

Alongside the six numbered phases, the plan keeps a strictly **experimental**, clearly
labeled, non-blocking track: a read-only feed of session and agent data into a future
memory/vector-database layer (the "observability becomes memory" idea from the design
basis). It is deliberately isolated so nothing in the core dashboard imports it, its
coverage is excluded from the >90% gate while it stays experimental, and the API key
that would drive it is kept out of the dashboard's own runtime environment entirely —
a security boundary, not a convenience.

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
