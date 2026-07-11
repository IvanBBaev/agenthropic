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
But as of this writing agenthropic is in the **pre-Phase-0 bootstrap phase** — no
server code is scaffolded (`CLAUDE.md`, "Current state") — so every mechanism below is
a **locked design commitment and a Phase-0/Phase-3 build target**, not yet-running
code. Several of the concrete remediation steps an operator would eventually run
(exact log greps, dashboard indicators, a confirmed watchdog window) do not exist yet
and are called out explicitly as **deepening once the corresponding work package
lands** — this page documents the target contract, not a runbook you can execute
today.

## Status of this page

> **Bootstrap phase, no code shipped.** Consistent with
> [`docs/site/STYLE-GUIDE.md`](../STYLE-GUIDE.md)'s rule to say plainly when something
> is undecided rather than gloss over it: this page is tracked in the docs plan as
> `DOC-S5`, explicitly flagged **"partial — deepens once code lands"** (`docs/DOCS-PLAN.md`).
> Nothing described below is an observed runtime behavior; it is the documented,
> sourced *design intent* for each pathology, gated behind the Phase-0 feasibility
> spike's GO/CONDITIONAL-GO verdict (`CD-8`) and, for the missing-`Stop` and
> `PreCompact` mechanisms specifically, Phase 3 of the [roadmap](../guide/roadmap.md).

## The four edge cases at a glance

| Symptom | Mechanism | Target outcome | Owning work | Status |
|---|---|---|---|---|
| A session/agent appears to have stalled — no forward progress, but no clean stop either | Stuck-session watchdog: ~15 s transcript-interrupt marker + idle-timeout fallback, via `fs.watch` with a polling safety net | Flags the stall as an explicit signal instead of leaving the UI showing silent, indefinite "working" | Pattern named in `ai/DESIGN.md` §6 (`hoangsonww` graft); not yet decomposed into its own numbered work package | **Not built** |
| A subagent process crashes and never emits `SubagentStop` | Missing-Stop watchdog + unknown-state rule | `agents.status` → explicit `unknown` within the watchdog window, never a permanent `working` | `WP-IN12` (deps `IN7`, `S5`), Phase 3 | **Not built**; schema does not yet have an `unknown` value (§2 below) |
| A session hits `PreCompact` mid-session (context window rewritten) | Compaction-baseline preservation + repricing | `CostEngine` reprices to **baseline + post-compaction spend**, matching the JSONL oracle exactly | `WP-C4`, fed by `WP-S6`'s empirical baseline capture, Phase 3 | **Not built**; marker mechanism open (`G0.2b`) |
| Two Claude Code instances run at the same time | Phase-0 hand-labeled corpus pathology + the `instance`/`host_id` key on `orchestration_edges` | Hierarchy correctness (≥95% gate) holds even with two overlapping instances in the corpus; edges are tagged per-instance | `WP-S1` (corpus capture), `WP-D7` (schema column) | Corpus not yet captured; no further runtime-detection mechanism described in the sources |

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

**Also unresolved:** whether a watchdog-set `unknown` state reverts to `completed`
once a late `SubagentStop` or the JSONL final record eventually arrives, or whether it
stays permanently flagged as `unknown` for operator review. `docs/analysis/concept-analysis-v2.md`
§7 lists this as its fifth open Phase-0 question, verbatim: *"once a late
`SubagentStop` or the JSONL final arrives, does a watchdog-set 'unknown/stale' revert
to completed or stay flagged? Needs an explicit state-transition rule."* No source
document answers this either way — do not assume a reversion behavior that has not
been decided.

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

**What is genuinely undecided:** whether the JSONL transcript itself carries
pre/post-compaction markers precise enough to reconstruct the baseline after the fact,
or whether the baseline must instead be **snapshotted at hook time**, is an open
Phase-0 question. `docs/analysis/concept-analysis-v2.md` §7 states it as open question
4: *"does the log carry pre/post-compaction markers that let `token_usage` preserve a
repriceable baseline, or must it be snapshotted at hook time?"* (`G0.2b`). Until that
probe runs, "compaction reprices correctly" is the target contract this page and the
cost model page describe — not a confirmed implementation mechanism.

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

Beyond that schema-level hedge, the sources do not go further: there is no described
mechanism for, say, warning an operator that two instances are running, or for merging
their trees in a dashboard view. Treat "two concurrent instances" as **validated by
the Phase-0 golden-corpus gate**, not yet described as a distinct operational
remediation — this is explicitly one of the facts this page cannot source beyond what
is stated above (see [Open items](#open-items-not-yet-built)).

## Why remediation deepens once the code lands

Every mechanism on this page is a **design commitment, a Phase-0 corpus target, or a
numbered, not-yet-merged work package** — not observed behavior. Concretely, none of
`WP-IN12` (missing-Stop watchdog), `WP-C4` (PreCompact repricing), `WP-S6` (baseline
capture), or `WP-S1` (the hand-labeled corpus itself) has landed; agenthropic has not
passed the Phase-0 GO/CONDITIONAL-GO gate (`CD-8`) that must clear before any of Phase
3's projection/reconciliation/cost work is even allowed to start (see the
[roadmap](../guide/roadmap.md)). Three things in particular are named above as
concretely blocked pending code:

- The `agents.status` `CHECK` constraint has no `unknown` value yet — a real, cited
  schema gap that must be migrated in before `WP-IN12` can ship (§2).
- The `PreCompact` baseline-preservation mechanism (JSONL marker vs. hook-time
  snapshot) is an open Phase-0 probe (`G0.2b`), not a confirmed implementation (§3).
- Whether a `SubagentStop`-derived general watchdog and the `WP-IN12`-scoped
  missing-Stop rule are the same mechanism or two separate ones is unstated (§1).

Once Phase 0 returns a verdict and Phase 3 lands these work packages, this page is
expected to be rewritten with concrete operator-facing detail: the confirmed watchdog
window, the actual dashboard indicator for an `unknown` agent, the finalized
compaction-baseline mechanism, and — if the corpus capture surfaces one — a described
remediation for a detected concurrent-instance collision. Until then, treat everything
above as the target contract this project is building toward, consistent with
`docs/DOCS-PLAN.md`'s own note on this page: *"(partial — deepens once code lands.)"*

## Open items (not yet built)

- **Watchdog identity is unresolved.** `ai/DESIGN.md` §6 names a general
  transcript-interrupt/idle-timeout/`fs.watch` stuck-session pattern; the only
  work package explicitly called a "watchdog" in `docs/analysis/development-plan.md`
  (`WP-IN12`) is scoped narrowly to the missing-`SubagentStop` → `unknown` rule.
  Whether these are the same mechanism is not stated in any source (§1).
- **The `~15 s` watchdog window is a borrowed starting point, not a validated
  constant.** No source states it has been tuned or confirmed against agenthropic's
  own data (§1).
- **State reversibility after `unknown` is an open question.** `docs/analysis/concept-analysis-v2.md`
  §7, open question 5: does a late `SubagentStop` or JSONL final revert an `unknown`
  agent to `completed`, or does it stay flagged? Unresolved (§2).
- **Schema gap:** `agents.status`'s `CHECK` constraint (`working`/`waiting`/`completed`/`error`)
  has no `unknown` value yet, despite `WP-IN12` requiring one — needs a migration
  before `WP-D6`/`WP-IN12` land (§2; flagged first on
  [the data model page](../architecture/data-model.md)).
- **`PreCompact` baseline mechanism is an open Phase-0 probe (`G0.2b`).** Whether the
  JSONL transcript carries usable pre/post-compaction markers, or the baseline must be
  snapshotted at hook time, is unanswered (§3).
- **Two-concurrent-instances handling is thin.** Sourced only as a Phase-0
  hand-labeled corpus pathology (`WP-S1`) plus the `instance`/`host_id` schema key on
  `orchestration_edges`; no runtime detection or operator-facing remediation mechanism
  is described in any source in scope for this page (§4).
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
- [Hook ingestion](../architecture/hooks.md) — the twelve-event catalogue, including
  `SubagentStop` and `PreCompact`'s dedicated handling.
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
