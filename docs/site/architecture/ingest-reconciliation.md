# Ingest & reconciliation

This page is the deep dive on agenthropic's single hardest architectural question:
**which source is ground truth when a hook event and a JSONL transcript line describe the
same fact?** The short answer is that the question is deliberately **not** answered on
paper. Concept-analysis-v2 names it **LB1 — ingest primacy** and resolves it as canonical
decision **CD-1**: ingest is *contingent* on a throwaway Phase-0 empirical spike that either
proves `~/.claude/projects/*.jsonl` carries the subagent parent→child linkage well enough to
rebuild the DAG after a full outage (→ **JSONL-primary + replay-on-startup**), or it doesn't
(→ **hooks-primary + a durable local outbox**, and only then) (concept-analysis-v2 §2, LB1;
§3, CD-1). What *is* decided already, independent of which way that spike falls, is the
reconciliation contract that makes either verdict safe: a single immutable substrate
(`events_raw`) that both sources write into with a cross-source idempotency key, a pure
deterministic projection on top of it, durable JSONL tail offsets, replay-on-startup, and a
per-field reconciliation precedence with deterministic backfill. This page walks that
contract end to end, the Phase-0 probe that decides CD-1, and the three P0 reconciliation
tests that gate every merge from Phase 3 onward.

> **Update — CD-1 empirically pre-answered.** A read-only [Phase-0 corpus
> probe](../../analysis/phase0-probe.md) run against the real `~/.claude/projects/` corpus on
> 2026-07-04 (17 projects · 117 sessions · ~849 nested + 148 flat agent files) pre-answers CD-1
> as **`CONDITIONAL-GO` → build** (confidence 85/100): JSONL *is* a trustworthy,
> outage-surviving single source of truth — **for a parser that keys on the `Agent`/`Workflow`
> spawn tools (not `Task`), walks both on-disk layouts, indexes subagents as parents, and sums
> tokens from child transcripts.** This **de-risks but does not replace** the formal Phase-0
> spike below — `WP-S1`/`WP-S5` still need the paired-capture corpus and Ivan's tree sign-off,
> and the `WP-S7` GO gate still stands (no production code before it).

## 1. Why this is make-or-break (LB1)

Two candidate sources exist for every fact agenthropic needs, and they have opposite
tradeoffs:

- **Hooks** fire live, sub-second, and are the only source of *interim* liveness signal
  (a subagent is currently "working") — but a hook payload has no durability contract of
  its own: if the ingest process is down when a hook fires, or the hook script itself fails
  silently, the fact is gone unless something durable absorbs it.
- **`~/.claude/projects/*.jsonl`** is a durable, per-session transcript that Claude Code
  itself maintains — it survives an ingest-process crash by construction — but whether it
  actually carries the subagent parent→child linkage (`Agent`/`Workflow` spawn → child
  `sessionId` → parent reference) strongly enough to rebuild the tree **from the log alone**
  was, when concept-analysis-v2 was written, **unverified** — the [Phase-0 corpus
  probe](../../analysis/phase0-probe.md) has since verified it empirically (0.000% depth-1
  orphan rate) (concept-analysis-v2 §2, LB1).

concept-analysis-v2 is explicit that this is the single biggest risk carrier in the whole
concept: "this is **make-or-break for the persistent-DAG moat** and both [independently
produced external] reports silently default to hooks-primary with no durability contract. It
cannot be settled on paper — a **Phase-0 empirical spike** must answer it before any
architecture is poured" (concept-analysis-v2 §1, LB1). The Holistic lens sharpens why it
propagates everywhere: "the persistent-DAG moat's durability promise depends **entirely** on
LB1" (concept-analysis-v2 §4.6). Concretely, the choice determines:

- whether the persisted `orchestration_edges` tree (the moat — see
  [the DAG moat](../architecture/dag-moat.md)) is *trustworthy*, i.e. survives an outage;
- whether the ground-truth-tokens invariant is satisfied *naturally* — tokens read from a
  durable log, never inferred — or needs a separate durability story bolted on;
- whether session/agent history is crash-tolerant at all;
- whether **>90% test coverage is even achievable**: replay-from-fixtures needs a
  deterministic, durable source to replay *against* (concept-analysis-v2 §2, LB1).

## 2. CD-1 — the decision rule

| | |
|---|---|
| **Decision** | Ingest primacy is **JSONL-primary + replay-on-startup**, contingent on Phase-0; else **hooks-primary + durable outbox**. |
| **Consolidates** | LB1, AD3, SD3, G-D1 |
| **The rule** | Decided by the **Phase-0 diff** (tree-from-JSONL vs tree-from-hooks), never assumed. |

(concept-analysis-v2 §3, CD-1.)

Spelled out in full: ingest is **JSONL-primary + replay-on-startup**, with hooks providing
sub-second liveness only, and **every write is an idempotent upsert on a stable event id** —
**contingent on the Phase-0 spike proving JSONL carries the subagent parent→child linkage.**
If it does not, fall back to **hooks-primary + a durable local outbox/spool** (at-least-once,
idempotent upsert), and only then (concept-analysis-v2 §2, LB1).

The framing that matters for anyone reading the code before the spike has run: **"the primacy
decision is an *output* of Phase-0, not an assumption baked in ahead of it — which is
precisely EXPANDED's error"** (one of the two external reports quarantined for defaulting to
hooks-primary without a durability contract) (concept-analysis-v2 §2, LB1). Nothing in this
codebase should hard-code "JSONL is primary" or "hooks are primary" as a premise; both branches
of CD-1 are designed for, and the spike output picks one — though the 2026-07-04 desktop
[corpus probe](../../analysis/phase0-probe.md) has since **empirically pre-answered** that output
`CONDITIONAL-GO` → build (JSONL-primary; confidence 85/100), which the formal Phase-0 spike (§3)
confirms rather than newly decides.

## 3. The Phase-0 probe that decides CD-1

Phase 0 is a **throwaway GO/NO-GO feasibility spike with a hard ❌ stop** (CD-8) — no
production code, not even the monorepo scaffold, is written until it reads green
(concept-analysis-v2 §3, CD-8). This is encoded as a real dependency in the build plan:
`WP-F1` (the pnpm monorepo scaffold) depends on `WP-S7` (the GO/NO-GO report) — the gate is
absolute, not aspirational (development-plan §1, §4).

The probe chain, in order:

| Gate | WP | What it does |
|---|---|---|
| — | `WP-S1` | **Paired-capture harness + hand-labeled corpus.** ≥3 real sessions including crashed-no-Stop, deep nesting, mid-session `PreCompact`, and two concurrent instances; each captured as **paired** JSONL + hook log; Ivan-labeled expected tree per session; the capture hook block is **throwaway** and reverted after capture. |
| **G0.1** | `WP-S2` | **The ingest-primacy probe.** Reconstruct the subagent tree from **JSONL alone** (no hook input) and diff it against both the hook-derived tree and the hand-labeled tree. Emits the CD-1 verdict rule directly: **JSONL-alone edge accuracy ≥95% surviving a simulated outage → JSONL-primary; below that → hooks-primary+outbox; failing entirely → NO-GO.** |
| **G0.1b** | `WP-S3` | **Join-key probe.** States and demonstrates the exact field path from a JSONL token row to a specific `agent_id`; reports the percentage resolvable by a hard key vs. a heuristic. This decides whether CD-3's backfill (§7 below) is a **hard join** or a **confidence-scored inference** that must be surfaced as uncertainty in the UI. |
| **G0.2** | `WP-S4` | **Hook-catalog enumeration.** Confirms or denies which hooks actually fire — specifically whether `SubagentStart` exists — from at least one subagent-heavy session and one compaction session. Full catalog treatment: [hook ingestion](../architecture/hooks.md). |
| **G0.3** | `WP-S5` | **Tree smoke gate.** Renders the reconstructed nesting legibly for the subagent-heavy session; Ivan signs off correctness by inspection. |
| **G0.4** | `WP-S6` | **Token-reconciliation probe.** Σ per-record token usage equals the session's JSONL ground-truth total **exactly** (zero drift) for every corpus session; captures the `PreCompact` baseline for later repricing. |
| — | `WP-S7` | **GO / NO-GO report.** A single verdict — GO, CONDITIONAL-GO (= hooks-primary+outbox), or NO-GO — with the CD-1 rule applied and the driving evidence attached. **Gates all of Phase 1.** |

(development-plan §5, Track S.)

The developer lens adds a specific, falsifiable expectation for G0.2 that shapes how the
normalizer must be written even before the spike runs: **`SubagentStart` is probably not a
real hook** — the documented hook set is `PreToolUse`/`PostToolUse`/`UserPromptSubmit`/
`Notification`/`Stop`/`SubagentStop`/`SessionStart`/`SessionEnd`/`PreCompact`, nine events, not
the twelve DESIGN §5 lists. If `SubagentStart` is absent, edge derivation must key off the
`Agent`/`Workflow`-tool `PostToolUse` invocation plus `SubagentStop` instead — "**JSONL-primary +
post-hoc-on-Stop** is the likely real design" (concept-analysis-v2 §4.2, Developer lens). This
is exactly why `WP-IN8` (dual-path edge derivation, [the DAG moat](../architecture/dag-moat.md))
is designed to build the correct tree **even if `SubagentStart` never fires** — it does not bet
on the optimistic hook existing.

## 4. The substrate that makes either verdict safe: `events_raw` + deterministic projection

Whichever way CD-1 falls, the schema underneath it does not change. **CD-2** fixes this
independently: **a single immutable substrate + deterministic projection.** Both hooks and
JSONL write into an append-only, idempotency-keyed `events_raw`; `sessions`, `agents`,
`orchestration_edges`, and `token_usage` are a **pure replayable projection** over it
(concept-analysis-v2 §3, CD-2). The load-bearing consequence: **"reconciliation is per-field
precedence at projection time, not a two-store merge at query time"** — there is no second
store to merge against later, and no query-time logic decides which source wins; that decision
is baked into the projection function itself (concept-analysis-v2 §3, CD-2).

```
   HookSource adapter            TokenReader/TokenSource
   (authed loopback POST)        (JSONL tail-follow, durable offset)
          │                                │
          └──────────────┬─────────────────┘
                          ▼
                 events_raw  (append-only, idempotency-keyed,
                              provably no UPDATE/DELETE path)
                          │
                          ▼
              Normalizer  (pure fn: events_raw → events,
                            deterministic — identical input
                            → identical output)
                          │
                          ▼
              Projection  (pure fn: events → sessions / agents /
                            orchestration_edges / token_usage,
                            precedence-aware)
```

Two properties are enforced by test, not by convention:

- **`events_raw` is provably append-only** — no `UPDATE`/`DELETE` path exists; `WP-D4`'s
  done-when is literally "`UPDATE`/`DELETE` raises and leaves the row unchanged (test-proven)"
  (development-plan §5, Track D; concept-analysis-v2 §3, CD-7).
- **Ingest must accept-and-store-raw *any* event type** — an unrecognized or new hook, or a
  JSONL line of an unfamiliar shape, is stored for audit, never crashes the pipeline. The
  Normalizer keys only off verified event types plus a `schema_version`, so new/unknown input
  is inert until explicitly handled (concept-analysis-v2 §4.2, Developer lens; Phase-2 exit
  gate, development-plan §3: "an unknown `event_type` is stored, not crashed").

The Normalizer and Projection are each their own work package specifically so each stays a
pure function: `WP-IN6` — "**Pure Normalizer** — `events_raw` → normalized `events`.
Identical input → identical output (deterministic)"; `WP-IN7` — "**Projection** — `events` →
sessions/agents/`token_usage` (precedence-aware). Σ `token_usage` per session == JSONL exact"
(development-plan §5, Track IN). Full column-level DDL for `events_raw`, `events`, and the
projected tables is the scope of [the data model](../architecture/data-model.md), not this
page — this page is about the *contract*, not the schema shape.

## 5. Idempotency keys — collapsing dual writes into one fact

Because both a hook and a JSONL line can describe the *same* underlying fact (e.g. the same
subagent's completion), the substrate needs a way to guarantee that fact lands **once**, not
twice. This is `WP-IN1`: **"Raw event envelope + cross-source idempotency-key contract. A hook
payload and the JSONL line for the same fact produce byte-identical idempotency keys"**
(development-plan §5, Track IN). `WP-IN2` then builds the write path around that contract:
**"`EventStore` port + append-only idempotent upsert… Appending the same envelope twice → exactly
one row"** (development-plan §5, Track IN).

```
 hook POST  { session, agent, event_type, ts, … }  ──┐
                                                       ├─►  same idempotency key  ──►  ONE events_raw row
 JSONL line { session, agent, event_type, ts, … }  ──┘
```

This is exactly what CD-1's "every write is an idempotent upsert on a stable event id" clause
protects (concept-analysis-v2 §2, LB1), and it is what makes the Phase-2 exit gate provable:
**"a hook event and a JSONL line for the same fact **collapse to one** `events_raw` row"**
(development-plan §3, Phase 2). The same mechanism is what absorbs redelivery from the
contingent outbox (§9 below) without double-counting.

## 6. Durable JSONL tail offsets

The JSONL leg of ingest is a **tail-follow**, not a re-read: `WP-IN5` — **"`TokenReader`/
`TokenSource` — JSONL tail-follow with durable offsets. One envelope per line, tokens copied
**verbatim** (no inference)"** (development-plan §5, Track IN). "Durable" here means the
byte/line offset the reader has consumed is itself persisted, not held only in memory — so a
restart resumes exactly where it left off:

- **Not persisting the offset** would mean either re-reading from the start on every restart
  (duplicate ingestion — relying entirely on the idempotency key to de-dupe) or resuming from
  "now" (silent data loss for anything written while the process was down).
- **Persisting the offset** turns "kill the process mid-session" into a bounded, provable
  recovery: the Phase-2 exit gate states it directly — **"kill+restart resumes JSONL at the
  persisted offset with **zero loss/dup**"** (development-plan §3, Phase 2).

Tokens are copied **verbatim** off this tail — never re-derived, never estimated — which is
the mechanical enforcement of the ground-truth-tokens invariant at the one place tokens enter
the system at all (DESIGN §3; concept-analysis-v2 §5, Strengths).

## 7. Replay-on-startup

Durable offsets on the read side only matter if the write side can safely re-derive state from
them. `WP-IN10` closes that loop: **"Replay-on-startup + deterministic full projection
rebuild. Double-replay → **byte-identical** `events_raw` and projected DB"** (development-plan
§5, Track IN). Concretely, the acceptance criterion from concept-analysis-v2 §6:

> **Kill + restart mid-session** → replay-on-startup reconstructs identical
> sessions/agents/`orchestration_edges`/`token_usage`; zero data loss.

This is only possible because of everything above: `events_raw` is immutable and
idempotency-keyed (§4–5), the JSONL offset is durable (§6), and the Normalizer/Projection are
pure functions (§4) — so replaying the same log twice is guaranteed, not merely expected, to
produce the same output. This determinism is also the concrete reason a >90% coverage bar is
achievable at all: **"replay-from-fixtures needs a deterministic durable source"**
(concept-analysis-v2 §2, LB1) — the golden fixture corpus (see
[testing](../contributing/testing.md)) is replayed against exactly this mechanism.

## 8. Reconciliation precedence & backfill (CD-3)

Idempotency answers "does the same fact land once"; **CD-3** answers "when the two sources
disagree or arrive out of order, which one wins, per field":

> **Reconciliation precedence.** Tokens are **JSONL-authoritative** (never inferred); interim
> liveness/state from hooks; final session/agent state + cost from JSONL. `token_usage.agent_id`
> is **nullable at first write, deterministically backfilled** once the agent is known.
> Cross-source idempotent upsert: a fact seen by *both* a hook and JSONL lands once.
>
> (concept-analysis-v2 §3, CD-3.)

| Fact | Authoritative source | Why |
|---|---|---|
| Token counts (final) | **JSONL, always** | Ground-truth invariant — never inferred, never hook-estimated (DESIGN §3; concept-analysis-v2 §5). |
| Interim liveness ("working"/"waiting") | Hooks | Only hooks fire sub-second; JSONL is not live. |
| Final session/agent state | JSONL | The durable record of what actually happened, once available. |
| `token_usage.agent_id` | Deterministic backfill | May be `NULL` at first write (a token row can arrive before the owning agent is known) — resolved once the agent is known, never guessed (CD-3). |

`WP-IN9` implements the backfill side of this: **"Reconciliation precedence + deterministic
`token_usage.agent_id` backfill. After backfill every row attributed to exactly one agent;
session-sum invariant holds"** (development-plan §5, Track IN) — i.e. backfilling `agent_id`
must never change the session-level token total, and must never attribute one token row to two
agents.

A related, still-open reconciliation rule governs the *liveness* side: **once a late
`SubagentStop` or the JSONL final arrives, does a watchdog-set "unknown/stale" state revert to
completed, or stay flagged?** This needs an explicit state-transition rule not yet finalized
(concept-analysis-v2 §7, open question 5). What *is* fixed is the fail-safe direction: `WP-IN12`
— **"Missing-`Stop` watchdog + unknown-state rule. A missing `SubagentStop` → **"unknown"**
within the window, never a permanent 'working'"** (development-plan §5, Track IN) — an agent
can never appear falsely alive forever; it can only ever fail toward visible uncertainty.

## 9. The contingent outbox — hooks-primary fallback only

If the Phase-0 spike (§3) reads CONDITIONAL-GO rather than GO — i.e. JSONL does **not** carry
the linkage strongly enough — CD-1 falls back to **hooks-primary + a durable local
outbox/spool (at-least-once, idempotent upsert)** (concept-analysis-v2 §2, LB1). This is built
as its own, explicitly conditional work package: `WP-IN11` — **"Durable outbox/spool
(CONTINGENT — hooks-primary fallback only). Events buffered while the DB is down, flushed
at-least-once on recovery"** (development-plan §5, Track IN).

Two things make this fallback safe rather than a second, parallel ingest design:

- It reuses the **same idempotency-key contract** (§5) — an at-least-once redelivery from the
  outbox after recovery is exactly the "same fact arrives twice" case the key already
  collapses to one row.
- It only ever activates on that specific verdict. Nothing in the schema, the Normalizer, or
  the Projection needs to know which branch is live — CD-2's substrate is identical either way
  (§4). The outbox is additive plumbing on the write path, not a fork of the read path.

> **Update — the outbox is off the v1 critical path.** The [Phase-0
> probe](../../analysis/phase0-probe.md) found JSONL self-reconciles by backfill with ≈0
> historical crashes in the real corpus, so the durable outbox buys **latency, not correctness**
> and is `YAGNI`-leaning — pulled off the v1 critical path and added only on a real trigger (a
> sub-second live-freshness need, *or* hooks becoming a data source not also present in JSONL).
> The empirically **proven** load-bearing hedges are instead (a) **dual-layout parsing** (~85% of
> agent files are nested) and (b) **child-transcript token summation** (parent token rollup is
> ≈0%). `WP-IN11` stays the contingent fallback described above, not an expected build item.

The DAG-rebuild acceptance criterion is written to cover both branches explicitly:

> **DAG-rebuild:** after a simulated mid-session outage the tree reconstructs from JSONL alone
> (or, if Phase-0 forces hooks-primary, from the durable outbox with at-least-once + idempotent
> dedupe, no double-count).
>
> (concept-analysis-v2 §6.)

## 10. The three P0 reconciliation tests

Three tests are named **release-blockers** — they must be green **and merge-blocking** in CI
before Phase 3 can be considered done, and no other feature work substitutes for them
(concept-analysis-v2 §3, CD-8; §4.3, QA lens). The QA lens calls the third one "the make-or-break
test both externals omit" (concept-analysis-v2 §4.3):

| # | Test | Proves |
|---|---|---|
| 1 | **Σ `token_usage` == JSONL exact**, per session | The ground-truth-tokens invariant holds in the projected data, not just in the raw log — zero drift, no silent rounding or double count. |
| 2 | **Double-replay → byte-identical DB state** | `events_raw` and the full projection are deterministic — replay-on-startup (§7) is safe to run on every process start, not just theoretically pure. |
| 3 | **DAG-rebuild from JSONL alone**, after a simulated outage (or from the outbox, under CONDITIONAL-GO) | The persistent-DAG moat actually survives the failure mode it exists to survive — this is the empirical proof of whatever CD-1 decided, re-run continuously, not just once at Phase-0. |

(concept-analysis-v2 §4.3, §6; development-plan §5, `WP-X3`: "Three P0 reconciliation
release-blocker tests. Σ`token_usage`==JSONL exact; double-replay byte-identical;
DAG-rebuild-from-JSONL-alone.") The development plan tracks the same three tests under two
work packages by design: `WP-X3` (QA/fixture track) owns the test bodies against the golden
corpus; `WP-IN13` wires them as **"Reconciliation / idempotency / DAG-rebuild suite (P0
blockers). All three P0 tests green in CI and **blocking**"** (development-plan §5, Track IN,
Track X).

Two adjacent, non-P0 acceptance bars sharpen what "passing" is allowed to mean:

- **Hierarchy correctness gate is ≥95%** against a labeled golden corpus of ≥3 real sessions —
  not 100%, which the QA lens judges untestable on messy real sessions (concept-analysis-v2
  §4.3). QA explicitly **holds stop-the-release authority** here: "an 'almost-correct
  hierarchy' manufactures false trust and is worse than no graph" (concept-analysis-v2 §4.3).
- **A missing `SubagentStop` must resolve to an explicit "unknown" state within the watchdog
  window, never a permanent 'working'** (concept-analysis-v2 §6; `WP-IN12`, §8 above) — the P0
  tests prove *reconciliation correctness*, this bar proves *failure-mode honesty*.

## 11. Where this lands on the roadmap

| Phase | Exit gate relevant to ingest & reconciliation |
|---|---|
| **0 — Feasibility spike** | `WP-S7` reads GO (or CONDITIONAL-GO); CD-1 verdict recorded with evidence; hook catalog + join key + Σtokens==JSONL + tree sign-off captured. **On NO-GO the moat feasibility is reconsidered before build.** |
| **2 — Ingest substrate** | A hook event and a JSONL line for the same fact collapse to one `events_raw` row; kill+restart resumes JSONL at the persisted offset with zero loss/dup; an unknown `event_type` is stored, not crashed. |
| **3 — Projection, the DAG moat, reconciliation, cost** | The **three P0 tests** green & merge-blocking; hierarchy ≥95% vs. the labeled corpus even without `SubagentStart`; missing-`Stop`→unknown; `PreCompact` reprices vs. baseline. |

(development-plan §3.) The hard stop is structural, not procedural: `WP-F1` — the pnpm
monorepo scaffold itself — **depends on `WP-S7`**, so "no production code before GO" is a real
dependency edge in the build graph, not a note in a README (development-plan §1, §2).

## What's undecided

This page documents a contract that is fixed (CD-2, CD-3, idempotency, replay) wrapped around
a decision that is explicitly **not** fixed yet (CD-1). Being precise about which is which:

- **CD-1 itself** — JSONL-primary vs. hooks-primary+outbox — has been empirically
  **pre-answered `CONDITIONAL-GO` → build** (confidence 85/100) by the 2026-07-04 desktop
  [corpus probe](../../analysis/phase0-probe.md): JSONL *is* a trustworthy, outage-surviving
  single source of truth for a parser that keys on the `Agent`/`Workflow` spawn tools, walks
  both on-disk layouts, and sums tokens from child transcripts. This **de-risks but does not
  replace** the formal Phase-0 spike (§3), which confirms the verdict on the paired-capture
  corpus; the `WP-S7` GO gate still stands and no production code starts before it.
- **The join-key mechanism (G0.1b)** — whether a JSONL token row resolves to an `agent_id` via
  a hard key or only a confidence-scored heuristic — is undecided and directly changes whether
  the backfill in §8 is a deterministic join or something that must surface uncertainty in the
  UI (concept-analysis-v2 §7, open question 2).
- **The hook catalog (G0.2)**, specifically whether `SubagentStart` fires at all, is unverified
  — see [hook ingestion](../architecture/hooks.md) for the full catalog treatment.
- **The missing-`Stop`-then-late-arrival state-transition rule** (does a watchdog "unknown"
  revert to completed, or stay flagged?) has no fixed answer yet (concept-analysis-v2 §7, open
  question 5).
- **Retention window, payload-redaction rule, and the "huge payload" reject-vs-truncate
  threshold** are named as open Phase-0 inputs, not yet fixed as policy numbers
  (concept-analysis-v2 §7, open question 6) — see
  [backup & restore](../operations/backup-restore.md) for the retention/redaction detail.
- **Hook-POST authentication mechanics** — whether the loopback hook receiver is itself
  authenticated and how the hook script obtains the token without leaking it into
  `~/.claude` scripts — is an open question (concept-analysis-v2 §7, open question 8), distinct
  from (and in addition to) the mandatory-token invariant that already applies to every other
  endpoint (see [security model](../security/model.md)).

## See also

- [Architecture overview](../architecture/overview.md) — the full ingest loop diagram and the
  two invariants this contract exists to protect.
- [Data model](../architecture/data-model.md) — full DDL for `events_raw`, `events`,
  `orchestration_edges`, `token_usage`.
- [Hook ingestion](../architecture/hooks.md) — the lifecycle-event catalog, `SubagentStart`
  uncertainty, and `SubagentStop` handling.
- [The DAG moat](../architecture/dag-moat.md) — dual-path `orchestration_edges` derivation and
  the outage-rebuild story in full.
- [Cost model](../architecture/cost-model.md) — how `token_usage`'s compaction baseline and
  the `PreCompact` reprice test build on the JSONL-authoritative token precedence in §8.
- [Testing](../contributing/testing.md) — the golden fixture corpus and the P0 test harness in
  full.
- [Decisions (ADRs)](../contributing/decisions/README.md) — CD-1, CD-2, CD-3, and CD-8 as
  recorded individual ADRs.
- [Roadmap](../guide/roadmap.md) — Phase 0 → 3 sequencing, public-friendly.
