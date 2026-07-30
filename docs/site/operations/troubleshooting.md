# Troubleshooting

This page walks through four operational edge cases agenthropic's design is
explicitly built to survive — a session or agent that appears **stuck**, a subagent
process that **crashes without ever sending `SubagentStop`**, a session that hits a
**mid-session context compaction (`PreCompact`)**, and **two Claude Code instances
running concurrently** — and states, for each one, exactly what the source documents
commit to doing about it. The key takeaway: agenthropic is designed to fail **toward
visible uncertainty, never toward silent wrongness** — a hung agent becomes an
explicit `unknown`, not a permanently green "working" light; a compacted session's
cost history is **preserved and repriced**, never silently reset or double-counted.
This page was written in the **pre-Phase-0 bootstrap phase**, when no server code was
scaffolded and every mechanism below was a **locked design commitment and a
Phase-0/Phase-3 build target**. *(Resolved 2026-07 — implementation began 2026-07-11;
the missing-`Stop` watchdog, the compaction repricing, and the polling ingest watcher
are now running, test-proven code. See the as-built update in the status block below
and the per-section notes; the original design-intent text is kept as the record of
what was committed before any code existed.)*

## Status of this page

> **Bootstrap phase, no code shipped.** Consistent with
> [`docs/site/STYLE-GUIDE.md`](../STYLE-GUIDE.md)'s rule to say plainly when something
> is undecided rather than gloss over it: this page is tracked in the docs plan as
> `DOC-S5`, explicitly flagged **"partial — deepens once code lands"** (`docs/DOCS-PLAN.md`).
> Nothing described below is an observed runtime behavior; it is the documented,
> sourced *design intent* for each pathology, gated behind the Phase-0 feasibility
> spike's GO/CONDITIONAL-GO verdict (`CD-8`) and, for the missing-`Stop` and
> `PreCompact` mechanisms specifically, Phase 3 of the [roadmap](../guide/roadmap.md).

> **Update — 2026-07 (as built).** The code landed (implementation began 2026-07-11)
> and three of the four mechanisms are now **running, test-proven behavior**:
>
> - **Missing-`Stop` watchdog (`WP-IN12`): built.** `apps/server/src/ingest/watchdog.ts`
>   sweeps every non-terminal agent and flips a stale one to an explicit `unknown` —
>   never a guessed `completed`. The window is **minutes, not ~15 s**:
>   `DASHBOARD_WATCHDOG_MINUTES`, default 10, a PROVISIONAL constant. The schema gap
>   flagged below is closed — migration 4 ships the five-value `CHECK`
>   (`'working','waiting','completed','error','unknown'`).
> - **`PreCompact` repricing (`WP-C4`/G0.2b): built, and the open question resolved
>   toward JSONL.** The transcript does carry usable compaction boundaries; the
>   baseline is parsed from the JSONL substrate (rows flagged
>   `is_compaction_baseline = 1` — the shipped name for the sketched
>   `is_precompact_baseline`), and repricing holds a delta-of-approximately-zero
>   invariant against the oracle. No hook-time snapshot was needed.
> - **Stuck-transcript detection: built as a polling watcher, deliberately without
>   `fs.watch`.** `apps/server/src/ingest/corpus-watcher.ts` polls (default 3000 ms,
>   PROVISIONAL) with an `lstat`-only fingerprint and re-ingests changed sessions
>   whole. The `fs.watch`-plus-safety-net shape described in §1 was **not** built —
>   the safety net became the only mechanism, which is simpler and has no
>   missed-event mode.
> - **Two concurrent instances:** still schema-level only, with one honest
>   correction — the shipped uniqueness on `orchestration_edges` is
>   **session-scoped** (`UNIQUE (session_id, parent_agent_id, child_agent_id)`), not
>   the per-`instance` key sketched in §4; `instance`/`host_id` shipped `NOT NULL`
>   as promised. Concurrent instances do not collide because they never share a
>   `session_id`.
>
> Per-section notes below mark the details; the original text is kept as the design
> record.

## The four edge cases at a glance

| Symptom | Mechanism | Target outcome | Owning work | Status |
|---|---|---|---|---|
| A session/agent appears to have stalled — no forward progress, but no clean stop either | *(As built)* Polling ingest watcher (`corpus-watcher.ts`, default 3000 ms, PROVISIONAL) + the `WP-IN12` staleness sweep — **no `fs.watch`**; the design-basis sketch was ~15 s transcript-interrupt marker + idle-timeout fallback via `fs.watch` with a polling safety net | Flags the stall as an explicit signal instead of leaving the UI showing silent, indefinite "working" | Pattern named in `ai/DESIGN.md` §6 (`hoangsonww` graft); landed as the polling watcher + `WP-IN12` (§1 below) | **Built** (polling shape, not `fs.watch`) |
| A subagent process crashes and never emits `SubagentStop` | Missing-Stop watchdog + unknown-state rule | `agents.status` → explicit `unknown` within the watchdog window (`DASHBOARD_WATCHDOG_MINUTES`, default 10, PROVISIONAL), never a permanent `working` | `WP-IN12` — `apps/server/src/ingest/watchdog.ts` | **Built**; migration 4's `CHECK` includes `'unknown'` (§2 below) |
| A session hits `PreCompact` mid-session (context window rewritten) | Compaction-baseline preservation + repricing | Reprices to **baseline + post-compaction spend**, matching the JSONL oracle (delta ≈ 0 invariant) | `WP-C4` — `packages/core/src/parser/compaction.ts` + `packages/core/src/cost/compaction-repricing.ts` | **Built**; `G0.2b` resolved toward JSONL markers (§3 below) |
| Two Claude Code instances run at the same time | Phase-0 hand-labeled corpus pathology + the `instance`/`host_id` key on `orchestration_edges` | Hierarchy correctness (≥95% gate) holds even with two overlapping instances in the corpus; edges are tagged per-instance | `WP-S1` (corpus capture), `WP-D7` (schema column) | Schema key shipped (`instance`/`host_id` `NOT NULL`; uniqueness is session-scoped, §4); hand-labeled ratification still pending (spike numbers PROVISIONAL); no runtime-detection mechanism built or described |

## 1. Stuck session — the watchdog pattern

**What "stuck" means here:** a session or agent that is still nominally `working` but
has stopped producing new events — no tool calls, no transcript growth, no lifecycle
hook — for long enough that treating it as still-live would mislead an operator
watching the dashboard.

`ai/DESIGN.md` §6 names the pattern to copy, verbatim:

> Copy `hoangsonww`'s stuck-session watchdog idea (~15 s: transcript-interrupt
> marker + idle-timeout fallback; `fs.watch` with a polling safety net).

Breaking that down into its stated parts:

- **A ~15-second window** — the borrowed starting point for how long a session can go
  quiet before the watchdog acts. The sources do not state that this number has been
  independently validated against agenthropic's own data; it is the value named in the
  design basis as the pattern to copy, not a tuned or Phase-0-confirmed constant.
- **A transcript-interrupt marker** — a signal derived from the JSONL transcript
  itself going quiet or being interrupted.
- **An idle-timeout fallback** — a second, independent trigger so the watchdog does
  not depend on only one signal source.
- **`fs.watch` with a polling safety net** — the implementation shape: an
  event-driven file watcher on the transcript file, backed by a periodic poll so a
  missed or unreliable `fs.watch` event does not leave the watchdog permanently blind.

> **As built:** the shipped implementation dropped `fs.watch` entirely — there is no
> `fs.watch` call anywhere in the codebase. The "safety net" became the only
> mechanism: `apps/server/src/ingest/corpus-watcher.ts` polls the corpus on a fixed
> interval (default **3000 ms**, PROVISIONAL), fingerprints transcripts by `lstat`
> only, and re-ingests a changed session whole. This is deliberately simpler than the
> sketch — a pure poll has no missed-event failure mode, so it needs no second
> mechanism to guard it. The **~15 s window did not ship either**: staleness is judged
> by the `WP-IN12` sweep in `apps/server/src/ingest/watchdog.ts` against
> `DASHBOARD_WATCHDOG_MINUTES` (default **10 minutes**, PROVISIONAL — chosen for a
> dashboard that observes long-running agent sessions, not the borrowed
> interrupt-detection constant).

```
                 ┌─────────────────────────┐
                 │  agent/session: working  │
                 └────────────┬─────────────┘
                              │  fs.watch (event-driven)
                              │  + periodic poll (safety net)
                              ▼
                 ┌─────────────────────────┐
                 │ transcript still growing?│
                 └───────┬─────────┬────────┘
                     yes │         │ no, for ~15s
                         ▼         ▼
                   stays working   watchdog fires:
                                   transcript-interrupt marker
                                   OR idle-timeout fallback
```

`docs/site/architecture/glossary.md` restates this same pattern under its **Watchdog**
entry and is explicit that the "[d]eployed behavior (not yet built) and the exact
target state name" belong on this page — which is the honest position: the *general*
stuck-session detection idea is named in `ai/DESIGN.md` §6, but the development plan's
only work package that is explicitly labeled a "watchdog" is `WP-IN12`, and `WP-IN12`
is scoped narrowly to the missing-`SubagentStop` → `unknown` rule (§2 below), not to
the broader transcript-interrupt/idle-timeout/`fs.watch` mechanism described here.
Whether `WP-IN12` is meant to be the concrete implementation vehicle for this general
pattern, or whether the two are separate mechanisms that happen to share the word
"watchdog," is **not stated in any source document** — flagged as open rather than
assumed either way (see [Open items](#open-items-not-yet-built) below).

> **As built, the answer is: two cooperating mechanisms, neither of them `fs.watch`.**
> The *ingest watcher* (`corpus-watcher.ts`) notices transcript growth by polling and
> keeps the projections fresh; the *status watchdog* (`watchdog.ts`, `WP-IN12`)
> notices the *absence* of growth and flips a stale non-terminal agent to `unknown`.
> The general transcript-interrupt/idle-timeout/`fs.watch` pattern quoted above was
> the design basis both descend from, but no component implements it as written.

## 2. Crashed session with no `Stop` — the agent is marked `unknown`

**The failure mode:** a subagent (or main agent) process dies — crash, force-kill, a
host reboot — before Claude Code ever emits its `SubagentStop` lifecycle hook. Without
an explicit rule, the agent's `agents.status` row would stay `working` forever, even
though nothing is actually running.

`docs/analysis/development-plan.md`'s Track IN table names the fix directly:

> **`WP-IN12`** (backend, size M, deps `IN7`, `S5`) — **Missing-Stop watchdog +
> unknown-state rule.** A missing `SubagentStop` → **"unknown"** within the window,
> never a permanent "working".

`docs/analysis/concept-analysis-v2.md` §6 states the same rule as an acceptance
criterion for the whole system, not just a nice-to-have:

> A missing `SubagentStop` → explicit **"unknown"** state within the watchdog window,
> never a permanent "working".

[Ingest & reconciliation](../architecture/ingest-reconciliation.md) §8 frames why this
matters at the level of the reconciliation contract (`CD-3`): interim liveness comes
from hooks, but hooks can simply stop arriving. The fail-safe direction is fixed even
though the mechanism isn't fully built: *"an agent can never appear falsely alive
forever; it can only ever fail toward visible uncertainty."*

```
   SubagentStart / working
            │
            ▼
      ┌───────────┐   SubagentStop arrives in time   ┌────────────┐
      │  working  │ ────────────────────────────────▶│ completed  │
      └─────┬─────┘                                    └────────────┘
            │
            │  watchdog window elapses, no SubagentStop
            ▼
      ┌───────────┐
      │  unknown  │   ◄── target state per WP-IN12 / concept-analysis-v2 §6
      └─────┬─────┘
            │
            ?   late SubagentStop or JSONL final arrives afterward —
            │   revert to completed, or stay flagged?
            ▼
       NOT YET DECIDED (concept-analysis-v2 §7, open question 5)
```

> **As built:** two corrections to the diagram. First, its entry label
> "`SubagentStart`" is not a real hook — the shipped hook set
> ([hook ingestion](../architecture/hooks.md)) is four events (`UserPromptSubmit`,
> `Stop`, `SubagentStop`, `PreCompact`); a subagent's existence and `working` state
> come from the JSONL transcript, not from a start hook. Second, the "NOT YET
> DECIDED" leg now has an answer in running code: the watchdog
> (`apps/server/src/ingest/watchdog.ts`) treats `unknown` as **terminal** and never
> flips it again itself, and a late *hook* never reverts it either — hooks contribute
> liveness only, never status. What *does* win the status back is the JSONL
> transcript: the ingest watcher re-ingests a changed session whole, and if the
> transcript's final record shows a real terminal state, that JSONL-derived status
> overwrites the watchdog's `unknown`. So: late `SubagentStop` hook → stays `unknown`;
> late JSONL final → reverts to the transcript's truth.

**A concrete, citable reason this "deepens once code lands":** the `agents` table's
`status` column, per the verbatim DDL fixed in `ai/DESIGN.md` §4 and reproduced on
[the data model page](../architecture/data-model.md), is a four-value `CHECK`
constraint today:

```sql
status TEXT CHECK(status IN ('working','waiting','completed','error')),
```

There is **no `unknown` value in that constraint as written**. [The data model
page](../architecture/data-model.md) flags this explicitly as a schema/roadmap
mismatch: *"the `status` `CHECK` constraint... has no `unknown` value. But the
missing-`SubagentStop` watchdog rule that `WP-IN12` implements... states: 'A missing
`SubagentStop` → explicit "unknown" state...' As written, the verbatim DESIGN §4 DDL
cannot represent that state. This table's `CHECK` constraint will need `unknown` added
before `WP-D6`/`WP-IN12` land."* Until that migration happens, this rule is a stated
requirement with no schema to hold its result — a concrete example of remediation
detail that literally cannot be filled in before the corresponding code (and a schema
change) lands.

> **As built: this gap is closed.** Migration 4 in
> `apps/server/src/db/migrations.ts` ships the `agents` table with the five-value
> constraint —
> `status TEXT CHECK (status IN ('working','waiting','completed','error','unknown'))`
> — so the watchdog's verdict has a schema slot from day one; no follow-up migration
> was needed. The four-value DDL quoted above is the pre-code design sketch this page
> was correctly flagging.

**Also unresolved:** whether a watchdog-set `unknown` state reverts to `completed`
once a late `SubagentStop` or the JSONL final record eventually arrives, or whether it
stays permanently flagged as `unknown` for operator review. `docs/analysis/concept-analysis-v2.md`
§7 lists this as its fifth open Phase-0 question, verbatim: *"once a late
`SubagentStop` or the JSONL final arrives, does a watchdog-set 'unknown/stale' revert
to completed or stay flagged? Needs an explicit state-transition rule."* No source
document answers this either way — do not assume a reversion behavior that has not
been decided. *(Resolved 2026-07 in code, split by source: a late hook never reverts
it — hooks are liveness-only; a late JSONL final does, because whole-session
re-ingest lets the transcript-derived status win. See the as-built note under the
diagram above.)*

Finally, "crashed-no-Stop" is not a hypothetical: it is one of the four named
pathologies the Phase-0 hand-labeled corpus is required to capture as a real session,
per `WP-S1`: *"≥3 real sessions incl. **crashed-no-Stop**, deep nesting, mid-session
PreCompact, two concurrent instances; each captured as paired JSONL + hook log;
Ivan-labeled expected tree per session"* (`docs/analysis/development-plan.md`). The
hierarchy-correctness gate this feeds is ≥95% against that same labeled corpus
(`docs/analysis/concept-analysis-v2.md` §6) — so this rule has to work against a real
crash, not just a synthetic test case, before Phase 3 can ship it.

## 3. Mid-session `PreCompact` — the cost baseline is preserved, not lost

**The failure mode:** Claude Code can rewrite (compact) a session's context window
mid-session. A naive costing scheme that only tracks a running token total risks
losing or double-counting history at that rewrite boundary — named directly as
negative scenario 6 in `docs/analysis/concept-analysis-v2.md` §3: *"coarse token
costing... misprices after PreCompact."*

The fix is structural. `docs/analysis/development-plan.md`'s Track C table names it:

> **`WP-C4`** — Compaction-baseline preservation + RE-pricing across PreCompact. A
> `PreCompact` session reprices to **baseline + post-compaction spend**, matching the
> oracle.

`docs/analysis/concept-analysis-v2.md` §6 states the same outcome as an acceptance
criterion: *"a session that hit PreCompact still reprices correctly against its
preserved baseline."* [The cost model page](../architecture/cost-model.md) §6 restates
this in full and notes it is one of two v1-only test cases added on top of the
negative-test catalogue (the other being compaction-mid-session hierarchy handling,
concept-analysis-v2 §4.3).

```
  pre-compaction spend        PreCompact event        post-compaction spend
 ───────────────────────►  ┌──────────────────┐  ───────────────────────►
   (tokens × dated price)   │ baseline preserved│    (tokens × dated price)
                            │  (token_usage row) │
                            └──────────────────┘
                                      │
                                      ▼
                total reprice = preserved baseline + post-compaction spend
                                (WP-C4; matches the JSONL oracle exactly)
```

[The data model page](../architecture/data-model.md) carries an illustrative,
not-yet-finalized `is_precompact_baseline` column on `token_usage` as one way this
preservation could be represented; `docs/analysis/development-plan.md`'s `WP-S6`
("G0.4 token-reconciliation probe") is scoped to empirically "capture the PreCompact
baseline" from real corpus sessions as validation input **before** `WP-C4` is built —
i.e. the mechanism is deliberately proven on real data first, not designed in the
abstract.

> **As built:** the column shipped as **`is_compaction_baseline`** (migration 6,
> `apps/server/src/db/migrations.ts` — `INTEGER NOT NULL DEFAULT 0` on
> `token_usage`), a slight rename of the sketch above. Compaction boundaries are
> detected in the pure parser (`packages/core/src/parser/compaction.ts`) from the
> JSONL transcript itself, and repricing lives in
> `packages/core/src/cost/compaction-repricing.ts`, holding the
> baseline-plus-post-compaction total to a delta-of-approximately-zero invariant
> against the JSONL oracle. No hook-time snapshot exists — the `PreCompact` hook
> contributes liveness only, like every other hook.

**What is genuinely undecided:** whether the JSONL transcript itself carries
pre/post-compaction markers precise enough to reconstruct the baseline after the fact,
or whether the baseline must instead be **snapshotted at hook time**, is an open
Phase-0 question. `docs/analysis/concept-analysis-v2.md` §7 states it as open question
4: *"does the log carry pre/post-compaction markers that let `token_usage` preserve a
repriceable baseline, or must it be snapshotted at hook time?"* (`G0.2b`). Until that
probe runs, "compaction reprices correctly" is the target contract this page and the
cost model page describe — not a confirmed implementation mechanism. *(Resolved
2026-07 — the JSONL branch won: the transcript's compaction markers proved usable,
the baseline is parsed from JSONL, and no hook-time snapshot was built. One
sub-question remains open in the code itself: which segment a usage row sitting
exactly on a compaction boundary is assigned to.)*

Like crashed-no-Stop, "mid-session PreCompact" is one of the four pathologies the
Phase-0 corpus (`WP-S1`) is required to capture as a real, hand-labeled session, so
this repricing rule is validated against an actual compaction event, not only a
synthetic one.

## 4. Two Claude Code instances running concurrently

**The scenario:** two separate Claude Code processes are active at the same time —
for example, two terminal sessions on the same Mac Mini, or (per `ai/DESIGN.md` §4's
forward-looking fleet-aggregation language) two different hosts. `WP-S1`
(`docs/analysis/development-plan.md`) names this explicitly as one of the four
pathologies the Phase-0 hand-labeled corpus must capture as a real, paired
JSONL-plus-hook-log session: *"≥3 real sessions incl. crashed-no-Stop, deep nesting,
mid-session PreCompact, **two concurrent instances**."* The same hierarchy-correctness
acceptance gate applies here as for the other three pathologies — `docs/analysis/concept-analysis-v2.md`
§6: *"Hierarchy correctness ≥95% vs a labeled golden corpus of ≥3 real sessions
including crashed-no-Stop, deep nesting, mid-session PreCompact, two concurrent
instances."*

This is honestly the thinnest-sourced of the four edge cases: **no document in scope
describes a specific runtime detection or resolution mechanism for two instances
colliding** (no described operator warning, no described conflict-resolution
algorithm). What *is* sourced is the schema-level disambiguation key that would make
such a collision representable rather than silently merged. [The data model
page](../architecture/data-model.md) reproduces the `orchestration_edges` DDL with two
distinct, both-`NOT NULL` columns:

```sql
CREATE TABLE orchestration_edges (
  ...
  instance           TEXT NOT NULL,   -- which Claude Code process/instance produced this
  host_id            TEXT NOT NULL,   -- which machine — the fleet-aggregation hedge
  ...
  UNIQUE(parent_agent_id, child_agent_id, instance)   -- idempotent: dup edge -> 1 row
);
```

`instance` — "which Claude Code process/instance produced this" — is the column that
specifically corresponds to disambiguating two Claude Code processes running at once,
as distinct from `host_id`, which `ai/DESIGN.md` §4 documents as existing for
*future cross-machine fleet aggregation* rather than same-host concurrency. Both are
`NOT NULL` per `WP-D7`'s done-when (*"Non-null `instance`/`host_id`"*,
`docs/analysis/development-plan.md`), and the edge-uniqueness constraint is itself
scoped per-`instance`, not globally — so two concurrent instances producing what looks
like "the same" parent→child edge still land as two distinct, correctly-attributed
rows rather than colliding into one.

> **As built:** the shipped migration 5 (`apps/server/src/db/migrations.ts`) keeps
> `instance` and `host_id` as `TEXT NOT NULL` exactly as promised, but the uniqueness
> key landed differently from the sketch above: it is
> **`UNIQUE (session_id, parent_agent_id, child_agent_id)`** — session-scoped, with
> **no `instance` in the key**. The concurrency argument still holds, just one level
> up: two concurrent Claude Code instances never share a `session_id` (each session
> is its own transcript file with its own UUID), so their edges can never collide
> under a session-scoped constraint; `instance`/`host_id` remain attribution columns,
> not disambiguators. Edge `source` provenance
> (`tool_use`/`directory`/`task_notification`/`queue_operation`) is stored per row
> and served verbatim by the API, so inferred edges stay distinguishable from
> observed ones.

Beyond that schema-level hedge, the sources do not go further: there is no described
mechanism for, say, warning an operator that two instances are running, or for merging
their trees in a dashboard view. Treat "two concurrent instances" as **validated by
the Phase-0 golden-corpus gate**, not yet described as a distinct operational
remediation — this is explicitly one of the facts this page cannot source beyond what
is stated above (see [Open items](#open-items-not-yet-built)).

## Why remediation deepens once the code lands

This section was written before any code existed; the "concretely blocked" list it
carried is now resolved item by item:

- The `agents.status` `CHECK` constraint had no `unknown` value in the design-basis
  DDL. **Resolved:** migration 4 shipped the five-value constraint from the start;
  no follow-up migration was needed (§2).
- The `PreCompact` baseline-preservation mechanism (JSONL marker vs. hook-time
  snapshot) was an open Phase-0 probe (`G0.2b`). **Resolved toward JSONL:** the
  transcript's markers proved usable; the baseline is parsed, stored as
  `is_compaction_baseline` rows, and repriced with a delta-of-approximately-zero
  invariant (§3).
- Whether the general stuck-session watchdog and the `WP-IN12`-scoped missing-Stop
  rule were one mechanism or two was unstated. **Resolved as two cooperating
  mechanisms**, neither of them `fs.watch`: the polling ingest watcher and the
  `WP-IN12` status watchdog (§1).

What the pre-code text promised for "once code lands" has partly happened: the
watchdog window is now a concrete, configurable constant
(`DASHBOARD_WATCHDOG_MINUTES`, default 10 — still PROVISIONAL, i.e. chosen, not
empirically tuned), the compaction-baseline mechanism is finalized, and an `unknown`
agent is a real, visible state served by the API. Still pending: ratification of the
hand-labeled corpus numbers (the spike figures stay PROVISIONAL until then) and any
operator-facing remediation for a detected concurrent-instance collision — none has
been designed or built, and none was surfaced as needed (§4).

## Open items (not yet built)

- **Watchdog identity is unresolved.** `ai/DESIGN.md` §6 names a general
  transcript-interrupt/idle-timeout/`fs.watch` stuck-session pattern; the only
  work package explicitly called a "watchdog" in `docs/analysis/development-plan.md`
  (`WP-IN12`) is scoped narrowly to the missing-`SubagentStop` → `unknown` rule.
  Whether these are the same mechanism is not stated in any source (§1).
  *(Resolved as built — two cooperating mechanisms, neither of them `fs.watch`;
  see the §1 note.)*
- **The `~15 s` watchdog window is a borrowed starting point, not a validated
  constant.** No source states it has been tuned or confirmed against agenthropic's
  own data (§1). *(Superseded as built — the shipped window is
  `DASHBOARD_WATCHDOG_MINUTES`, default 10 minutes; still PROVISIONAL, i.e. chosen
  rather than empirically tuned, so the "not validated" caveat carries over to the
  new number.)*
- **State reversibility after `unknown` is an open question.** `docs/analysis/concept-analysis-v2.md`
  §7, open question 5: does a late `SubagentStop` or JSONL final revert an `unknown`
  agent to `completed`, or does it stay flagged? Unresolved (§2). *(Resolved as
  built, split by source — a late hook never reverts it; a late JSONL final does,
  via whole-session re-ingest; see the §2 note.)*
- **Schema gap:** `agents.status`'s `CHECK` constraint (`working`/`waiting`/`completed`/`error`)
  has no `unknown` value yet, despite `WP-IN12` requiring one — needs a migration
  before `WP-D6`/`WP-IN12` land (§2; flagged first on
  [the data model page](../architecture/data-model.md)). *(Resolved as built —
  migration 4 shipped with `'unknown'` in the constraint.)*
- **`PreCompact` baseline mechanism is an open Phase-0 probe (`G0.2b`).** Whether the
  JSONL transcript carries usable pre/post-compaction markers, or the baseline must be
  snapshotted at hook time, is unanswered (§3). *(Resolved as built — the JSONL
  branch won; one sub-question, boundary-row segment assignment, remains open in
  code.)*
- **Two-concurrent-instances handling is thin.** Sourced only as a Phase-0
  hand-labeled corpus pathology (`WP-S1`) plus the `instance`/`host_id` schema key on
  `orchestration_edges`; no runtime detection or operator-facing remediation mechanism
  is described in any source in scope for this page (§4). *(Still open — the schema
  key shipped, but no runtime detection or remediation was built.)*
- **This page's target links** — [security model](../security/model.md),
  [threat model](../security/threat-model.md),
  [backup & restore](backup-restore.md),
  [testing & quality](../contributing/testing.md), and
  [Decisions (ADRs)](../contributing/decisions/README.md) — all already exist in the
  repository as of this writing.

## See also

- [Data model](../architecture/data-model.md) — the verbatim `agents` DDL, the
  `orchestration_edges` DDL with the `instance`/`host_id` columns, and the flagged
  `status` `CHECK`-constraint gap this page relies on.
- [Ingest & reconciliation](../architecture/ingest-reconciliation.md) — the `CD-3`
  reconciliation-precedence contract (tokens JSONL-authoritative, hooks supply interim
  liveness) that the missing-Stop rule sits inside.
- [The DAG moat](../architecture/dag-moat.md) — dual-path edge derivation (`WP-IN8`),
  which is what keeps `orchestration_edges` correct even when one signal path (a
  crashed subagent's hooks) goes silent.
- [Cost model](../architecture/cost-model.md) — the full `PricingProvider`/`CostEngine`
  contract and §6's treatment of compaction-baseline repricing.
- [Hook ingestion](../architecture/hooks.md) — the hook-event catalogue *(as built:
  four hooks are installed — `UserPromptSubmit`, `Stop`, `SubagentStop`, `PreCompact`
  — all treated uniformly as liveness signals; there is no dedicated per-event
  handling, and no `SubagentStart` hook exists)*.
- [Glossary & reference](../architecture/glossary.md) — the **Watchdog** and
  **Compaction baseline** term definitions, and the `unknown`-status open item restated
  from the status-enum table.
- [Roadmap](../guide/roadmap.md) — Phase 0's corpus capture and Phase 3's
  projection/DAG/cost work, where the mechanisms on this page are scheduled to land.
- [Security model](../security/model.md) and
  [threat model](../security/threat-model.md) — the security invariants (loopback-only
  bind, mandatory `timingSafeEqual` token, no request-driven spawner, no SSRF) that
  remain in force regardless of any operational state described on this page; nothing
  above implies relaxing them for debugging convenience.
- [Backup & restore](backup-restore.md) — the adjacent operations runbook for
  SQLite WAL backup/restore, retention, and redaction; a distinct topic from the
  liveness/costing edge cases covered here.
