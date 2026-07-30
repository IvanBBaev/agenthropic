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

> **Update — 2026-07 (as built).** Implementation began 2026-07-11 (explicit owner
> override of the CD-8 hard stop; the spike numbers remain PROVISIONAL until ratified
> against the hand-labeled corpus). The shipped ingest resolves this page's central
> question the JSONL-primary way, with one deliberate simplification of the substrate
> design: **JSONL is parsed and projected directly** — the pure parser
> (`packages/core/src/parser`) reconstructs a session, cost is computed as a halt-gate,
> and one transaction per session writes `sessions`/`agents`/`orchestration_edges`/
> `token_usage` (`apps/server/src/ingest/ingest-session.ts`). Consequences for the
> contract described below, stated plainly:
>
> - **`events_raw` holds hook events only.** JSONL lines are never enveloped into it, so
>   the cross-source idempotency key (§5) and the separate Normalizer/Projection stages
>   (`WP-IN6`/`WP-IN7`, §4) were **never built**. Idempotency-keyed `events_raw` exists
>   and is append-only (trigger-enforced) — for the hook leg.
> - **Change detection is an lstat fingerprint** (`rel:size:mtime` per session file,
>   in-memory), not a durable byte/line tail offset (§6). Any change triggers an
>   **idempotent whole-session re-ingest**; a restart's first watcher tick *is* the
>   replay (§7). Determinism comes from the parse being pure and the writes being
>   upserts/INSERT-OR-IGNORE, not from a persisted offset.
> - **CD-1 is intact**: hooks contribute **liveness only, never structure** — no hook
>   ever creates an agent, an edge, or a token row. Hook deliveries are normalized into a
>   small `events` liveness timeline (identifiers only, same transaction as the raw
>   append).
> - **The outbox (§9) was never needed** — the YAGNI-leaning verdict held.
> - **The three P0 tests exist and run green** in the server suite
>   (`apps/server/test/p0/`): token reconciliation, double-replay idempotency, and
>   DAG-rebuild-from-JSONL-alone.
>
> Sections below are kept as the design record; per-section updates mark where the
> as-built system diverges.

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

> **As built:** the shipped ingest implements the **JSONL-primary** branch — chosen by that
> verdict, not assumed ahead of it. The hooks-primary + outbox branch remains the documented
> fallback that was never triggered (§9).

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

> **As built:** the prediction held — `SubagentStart` does not exist. The hooks installer ships
> exactly **four** real lifecycle hooks (`UserPromptSubmit`, `Stop`, `SubagentStop`,
> `PreCompact`), and the edge derivation never needed any of them: all four
> `orchestration_edges` join paths (`tool_use`, `directory`, `queue_operation`,
> `task_notification`) come from the JSONL parser alone.

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

> **As built:** the diagram above is the design record, not the running shape. `events_raw`
> exists and is exactly as promised — append-only (`UPDATE`/`DELETE` blocked by SQLite
> triggers, test-proven), idempotency-keyed, accept-any-shape — but it receives **hook
> envelopes only**. The JSONL leg never writes to it: the pure parser
> (`packages/core/src/parser`) plays the Normalizer/Projection role in one step, and
> `apps/server/src/ingest/ingest-session.ts` writes the projected tables in **one transaction
> per session**. Determinism survived the simplification — the parse is a pure function of the
> transcript bytes, and re-ingesting an unchanged session is a no-op by upsert/`INSERT OR
> IGNORE`. `WP-IN6`/`WP-IN7` were therefore never built as separate stages. The
> accept-and-store-raw rule holds on the hook side: the receiver accepts **any** body shape,
> stores it raw, and projects only identifiers into the `events` liveness timeline.

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

> **As built: the cross-source key was never needed and was not built.** JSONL lines never
> enter `events_raw`, so there is no dual-write to collapse — the two sources never share a
> store, and the "same fact twice" problem this section designs for cannot occur. What *was*
> built is the single-source half of the contract, and it does real work: every hook delivery
> gets a deterministic `hook:`-prefixed SHA-256 key over the canonicalized envelope
> (**minus** `receivedAt`, and computed **after** payload redaction), and the append is an
> `INSERT OR IGNORE` against a `UNIQUE` key inside one transaction with the `events`
> projection — so a duplicate or retried hook delivery lands **zero** new rows in both tables.
> On the JSONL side, idempotency is carried by the whole-session re-ingest being an
> upsert/`INSERT OR IGNORE` write (§6–7), not by an event-level key.

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

> **As built: no tail-follow, no durable offsets.** `WP-IN5` shipped as a **polling corpus
> watcher** (default interval 3 s, `PROVISIONAL`; deliberately polling rather than
> `fs.watch`) with an **in-memory lstat fingerprint** per session file
> (`relative-path:size:mtime`). Any fingerprint change triggers an **idempotent whole-session
> re-ingest** — the file is re-parsed from the start and re-projected in one transaction. This
> is the first bullet's "re-read on restart, rely on idempotent writes to de-dupe" branch,
> chosen deliberately: session transcripts are small enough that a full re-parse is cheap, and
> the double-replay P0 test (§10) proves the de-dupe rather than assuming it. The trade is
> honest — a restart re-ingests rather than resumes, so recovery costs a full pass over the
> corpus (the watcher's first tick), never data loss. The verbatim-tokens rule is unchanged:
> the parser copies `usage` counts as-is, and per-message dedupe happens before summation.

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

> **As built: replay-on-startup *is* the watcher's first tick.** There is no separate replay
> mode — on process start the corpus watcher scans every session file, every fingerprint is
> new to the fresh in-memory map, and every session is re-ingested through the same
> parse → cost halt-gate → one-transaction path as live changes; a replay summary is logged.
> Because the parse is pure and every write is an upsert/`INSERT OR IGNORE`, running it twice
> leaves the projected tables identical — the double-replay P0 test (§10) asserts exactly
> this. Determinism is delivered by purity + idempotent writes rather than by
> replaying an `events_raw` log of JSONL envelopes (which does not exist, §4).

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

> **As built:** the precedence table above holds, but the **two-phase backfill does not exist
> as a phase** — because ingest parses the *whole session* before writing anything,
> `token_usage.agent_id` is attributed inside the parser and written already-resolved in the
> same transaction. `NULL` remains what it always meant: a row that is *genuinely*
> unattributable, surfaced as such in the API and UI, never guessed. `WP-IN9`'s invariant
> (every attributed row belongs to exactly one agent; the session-sum never changes) is
> enforced by the P0 token-reconciliation test rather than by a backfill pass. The
> **watchdog is built** (`WP-IN12`): a non-terminal agent whose last-seen anchor
> (`lastSeenAt`, else `firstSeenAt`) is older than `DASHBOARD_WATCHDOG_MINUTES` (default 10,
> `PROVISIONAL`) — or whose anchor is unparseable — flips to `unknown`; `completed`, `error`
> and `unknown` are terminal for the sweep. The once-open late-arrival rule (open question 5)
> is answered in practice by the re-ingest path: a later whole-session re-ingest upserts the
> status the JSONL evidence supports, so a stale `unknown` yields to the durable record
> instead of sticking forever.

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

> **As built:** exactly as the update above predicted — the verdict was JSONL-primary, the
> trigger never fired, and **no outbox exists in the codebase**. Both proven hedges *are*
> built: the parser walks both on-disk layouts and sums tokens from child transcripts.

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

> **As built: all three exist and run in the server suite** —
> `apps/server/test/p0/p0-token-reconciliation.test.ts`,
> `apps/server/test/p0/p0-double-replay.test.ts`, and
> `apps/server/test/p0/p0-dag-rebuild.test.ts`, over a shared harness that ingests fixture
> corpora through the real parse → one-transaction path. Under the as-built shape, test 3's
> "from JSONL alone" is the *only* branch — hooks never contribute structure, so there is no
> outbox variant to exercise. They are joined by negative suites (`apps/server/test/negative/`)
> covering hook-receiver abuse, ingest restart, and the SSE security contract.

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

> **As built**, the Phase-2 row reads differently in two places: the collapse-to-one-row gate
> holds for the **hook leg** (a duplicate hook delivery lands zero new rows, §5); and
> "resumes at the persisted offset" was replaced by **fingerprint change → idempotent
> whole-session re-ingest** (§6) — same zero-loss/zero-dup outcome, different mechanism. The
> unknown-`event_type`-stored-not-crashed gate holds as written. The Phase-3 row's substance
> is built: the three P0 tests exist (§10), the missing-`Stop` watchdog is live (§8), and
> `PreCompact` repricing runs compaction-aware with the delta≈0 invariant (see
> [cost model](../architecture/cost-model.md)). Note also that the CD-8 hard stop described
> here was ultimately crossed by **explicit owner override on 2026-07-11**, not by a ratified
> `WP-S7` GO — which is why the spike numbers stay `PROVISIONAL`.

## What's undecided

> **Update — 2026-07 (as built).** This section is kept as the historical record of what was
> open when the page was written. Where each item landed:
>
> - **CD-1** — resolved in code: JSONL-primary, per the `CONDITIONAL-GO` verdict.
>   Implementation began 2026-07-11 by explicit owner override of CD-8; the spike numbers
>   remain `PROVISIONAL` until ratified against the hand-labeled corpus.
> - **Join key (G0.1b)** — resolved as a **hard key**: the parser keys on the
>   `Agent`/`Workflow` `tool_use` spawns and joins edges through four deterministic paths
>   (`tool_use`, `directory`, `queue_operation`, `task_notification`); the desktop probe
>   measured 0.000% depth-1 orphans and 100% usage attribution. No confidence-scored
>   heuristic ships — an unresolvable row stays honestly `NULL` and an orphan gets **no**
>   edge, never a guessed one.
> - **Hook catalog (G0.2)** — verified: four real hooks (`UserPromptSubmit`, `Stop`,
>   `SubagentStop`, `PreCompact`); `SubagentStart` does not exist.
> - **Missing-`Stop` late-arrival rule** — built (§8): the watchdog flips stale non-terminal
>   agents to `unknown`, and a later re-ingest upserts the status the JSONL evidence
>   supports.
> - **Retention / redaction / huge-payload** — partially resolved: payload **redaction is
>   built at ingest** (key-name matching plus credential-shape masking, applied *before* the
>   idempotency key), with the exact policy pending owner sign-off; the retention TTL sweeper
>   and the huge-payload threshold are **not built** and remain open.
> - **Hook-POST authentication** — answered: the hook receiver sits behind the same
>   mandatory-token gate as every other endpoint, and the installer writes hook commands that
>   reference `${DASHBOARD_TOKEN}` by shell expansion — the token never lands verbatim in
>   `~/.claude` scripts.

This page documents a contract that is fixed (CD-2, CD-3, idempotency, replay) wrapped around
a decision that was, when this was written, explicitly **not** fixed yet (CD-1). Being precise
about which was which at the time:

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
