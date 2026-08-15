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
> - **Change detection is an lstat fingerprint** (`size:mtime` for the main transcript
>   plus one `rel:size:mtime` entry per subagent artifact), not a durable byte/line tail
>   offset (§6). It is in-memory by default, with an **opt-in persisted checkpoint**
>   (`ingest_checkpoints`, migration 9) that shortens a restart without being allowed to
>   change what a restart produces (§6.1). Any change triggers an **idempotent
>   whole-session re-ingest**; a restart's first watcher tick *is* the replay (§7).
>   Determinism comes from the parse being pure and the writes being
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
> `PreCompact`), and the edge derivation never needed any of them: all five
> `orchestration_edges` join paths (`tool_use`, `directory`, `queue_operation`,
> `task_notification`, and the pre-2.1.71 `legacy_explore` fallback) come from the JSONL
> parser alone.

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

> **As built: no byte offsets — a fingerprint, in memory by default and optionally
> persisted.** `WP-IN5` shipped as a **polling corpus watcher** (default interval 3 s,
> `PROVISIONAL`; deliberately polling rather than `fs.watch`, because polling is
> deterministic and immune to the platform-specific event coalescing that loses appends).
> Change detection is an **lstat fingerprint per session**: the main transcript's
> `size:mtime` plus one `relative-path:size:mtime` entry per subagent artifact, sorted, with
> no file content read at all. Any fingerprint change triggers an **idempotent whole-session
> re-ingest** — the session is re-parsed and re-projected in one transaction. This is the
> first bullet's "re-read, rely on idempotent writes to de-dupe" branch, chosen deliberately:
> the double-replay P0 test (§10) proves the de-dupe rather than assuming it. The
> verbatim-tokens rule is unchanged: the parser copies `usage` counts as-is, and per-message
> dedupe happens before summation.

### 6.1 The checkpoint that makes a restart cheap without making it trusting

The fingerprint map lives in process memory, so a restart starts blank and every session
counts as changed. That is correct, and on a small corpus it is also free — but on the
measured corpus (12.80 GiB across 1855 sessions) a full cold replay projects to roughly
**137 s of boot-time work**, paid again on every restart, for sessions whose bytes have not
moved in months.

Migration 9 added `ingest_checkpoints` and the watcher grew an **optional** `checkpoints`
dependency: supply it and the fingerprint map is hydrated from the database on the first
tick, so an unchanged session is not merely ingested-and-ignored — it is never read from
disk at all, because the runner applies its session filter before building any substrate.
Omit it, and the watcher behaves exactly as it always did.

The optionality is the design, not a hedge. **The unconditional full replay is the fail-safe
path and stays the default**, and it is the path the P0 double-replay proof exercises. Around
that, four rules keep the cache from ever becoming an answer:

- **Scope.** Checkpoints are keyed by a sha-256 of the *resolved* corpus root, so a different
  root can never be mistaken for the same corpus — and no absolute path (which on this
  machine encodes the user's home directory and project names) is persisted.
- **Revision.** Every row carries `REPLAY_CHECKPOINT_REVISION` (currently `1`), a stamp of
  the ingest semantics that produced the projection. Bumping it when the parser, the cost
  engine or the projected schema changes invalidates every checkpoint at once, instead of
  letting a code change quietly leave stale rows in place. It is a constant in code precisely
  so the bump shows up in a diff.
- **Proof of projection.** A checkpoint is honored only while its session still has a row in
  `sessions`; the lookup joins on that existence. A checkpoint may therefore never be the
  reason a session is invisible — restore an older backup, delete a row by hand, and the
  session re-ingests exactly as it would have.
- **Degrade, never crash.** Every statement is wrapped: an absent, corrupt or unwritable
  checkpoint table yields an empty map — a full replay — never an exception into the ingest
  loop.

And what is deliberately *not* trusted is the fingerprint on its own: only a session this
process successfully projected in that pass is checkpointed. A failed or quarantined session
is never written, so a restart always hands it a fresh retry budget.

### 6.2 Reading the corpus without being tricked by it

The corpus is user-writable data on the same machine, so the read layer treats it as
untrusted input rather than as its own filesystem. Files are opened `O_RDONLY | O_NOFOLLOW`
and the open descriptor is re-checked with `fstat` — closing the window between "we checked
this path" and "we read this file"; directory entries are examined with `lstat`, never
`stat`, so a symlink is seen as a symlink instead of as whatever it points at. Every resolved
path must still sit under the corpus root.

The two error classes that come out of this layer are deliberately different in kind:

- **`OversizeError` and ordinary I/O hazards are per-file skips.** They are counted and
  reported as a `SkippedFile` with a reason (`oversize`, `symlink`, `not-regular-file`,
  `unreadable`, `empty-agent`, `empty-main`, `non-artifact`, `duplicate-session`) — the run
  continues. A file that cannot be read honestly is announced, never silently dropped.
- **`ContainmentError` aborts the entire run.** A traversal-shaped entry name or a path that
  escapes the root is not a damaged file, it is a *crafted* corpus, and the only safe response
  to that is to stop touching the corpus rather than to skip one entry and keep going. The
  watcher stops itself permanently and surfaces it through `onFatal`, which the composition
  root turns into a loud non-zero exit.

One more whole-run abort exists, for a related reason: an **unreadable corpus root**. Returning
an empty summary there would report a root the runner could not even list as a quiet, fully
ingested corpus — a confident lie about the entire corpus. It throws instead, and the watcher's
tick catch turns it into an honest `read-error` outcome that retries next poll.

The read caps are bounds, not truths, and are labelled as such: `DEFAULT_MAX_FILE_BYTES` is
64 MiB and `DEFAULT_MAX_DEPTH` is 4 (real artifacts reach depth 3 under a session directory),
both **PROVISIONAL (LABEL-ME)** — chosen to be comfortably above anything observed, not
derived from a measured distribution.

### 6.3 The tail read, and a cache that can cost speed but never answers

Live transcripts are append-only in practice, yet every watcher pass re-read each changed
file in full, which makes a poll cost O(total corpus bytes) instead of O(new bytes). A
decorator over the filesystem port now serves `.jsonl` reads from a byte-offset cache, using
a confined tail read that keeps the same `O_NOFOLLOW` + `fstat` guarantees as a full read.
Its cap applies to the **whole file**, not to the requested slice, so an oversize file cannot
be smuggled in one tail at a time.

Three anchors make "cached read ≡ full read" a property rather than a hope:

- **Only complete lines are cached.** A region is cached only up to the last `0x0A`. Because
  `0x0A` cannot occur inside a multi-byte UTF-8 sequence, decoding chunks split at newline
  boundaries is byte-for-byte equivalent to decoding the whole file. The torn remainder after
  the last newline — possibly half a character — is re-decoded fresh on every call and never
  cached, so it decodes together with its completion once the writer finishes the line.
- **An overlap window is re-read and compared** on every incremental read, so an in-place
  rewrite that happens to grow the file is detected instead of silently mis-served. Any
  divergence — the file shrank, the overlap bytes differ — drops the entry and falls back to
  a full read.
- **Any error from the inner filesystem drops the entry and propagates untouched**, so the
  decorator is invisible to every error-handling arm above it.

Its tuning constants — `OVERLAP_BYTES` 4096, `MAX_CACHE_BYTES` 128 MiB, `MAX_CACHE_ENTRIES`
512 — are all **PROVISIONAL (LABEL-ME)**.

### 6.4 One session id, one session — the duplicate-session rule

A session uuid can appear under more than one project-slug directory (the same session
recorded against two slugs). Enumeration keeps exactly **one** ref for it, chosen
deterministically by the smallest-sorting `projectSlug`, and records every other copy as a
`duplicate-session` skip. Two details are load-bearing: the losers are reported **before** the
per-session loop, and **regardless of any session filter** — a shadowed copy is a corpus-level
fact, not a property of an admitted ref, so it must not become invisible just because the
watcher is only looking at changed sessions this pass.

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
> replaying an `events_raw` log of JSONL envelopes (which does not exist, §4). With
> checkpoints enabled (§6.1) the *work* of that first tick shrinks to the sessions whose
> bytes moved; the *result* is identical either way, which is the whole reason the
> checkpoint is allowed to exist.

### 7.1 The order inside one session is itself a decision

For a single session the pipeline is fixed, and each boundary is there for a reason:

```
parseSession → computeCostUsd (the HALT GATE) → normalizeSession → projectSession
```

**Cost is computed before any write.** An unknown model id throws `PricingError` while the
database is still untouched, so an unpriceable substrate can never leave a partial session,
agent or usage row behind. The alternative — write first, price later — would have produced
exactly the silent zero-dollar rows the cost model refuses to emit (see
[cost model](../architecture/cost-model.md)).

**The two steps after the gate are the `WP-IN6`/`WP-IN7` pair, and the split survived even
though the stages did not.** `normalizeSession` is pure — no database, no clock, no I/O — and
decides the row shapes, the parent-first agent ordering the self-referential foreign key
demands, and which parent references must be nulled, all as a value that can be asserted in a
test without a database. `projectSession` does nothing but write that value inside **one
transaction**, stamping each edge from an injected clock. A session commits whole or not at
all.

**`ingestSession` never rethrows.** Every failure path collapses into an outcome with
`ok: false` and a human-readable reason, which is what lets the corpus runner isolate one
poisoned session — a non-JSON line, an unpriceable model, a build that yields nothing — and
count it without sinking the rest of the corpus. The runner still wraps the call in its own
try/catch as belt-and-braces.

### 7.2 What one tick reports

A pass used to return a summary or `null`, which merged "the corpus is fully checkpointed and
quiet" with "there is no corpus root" and with "the root could not be read". That is the same
collapse of distinct facts the dashboard forbids for agent status, where `unknown` is never
`null` — so the tick now returns a seven-armed outcome, six of whose arms carry no summary at
all but are six *different* facts:

| Outcome | What it means |
|---|---|
| `ingested` | A pass ran and ingested the changed sessions (carries the summary). |
| `unchanged` | A pass ran; every session on disk matched its committed fingerprint. |
| `no-corpus-root` | No corpus root resolved — not configured, or gone. Fingerprints reset. |
| `overlapped` | A re-entrant call arrived while a pass was in flight; this call did nothing. |
| `stopped` | The watcher was already stopped; polling is over. |
| `read-error` | Transient I/O trouble; the pass was skipped and retries next tick. |
| `containment-halt` | A `ContainmentError` escaped; the watcher stopped itself, for good. |

Per-session failures inside a pass have their own posture. A fingerprint is committed only
for a session that did not fail, so a failed session stays "changed" and is retried next
tick — committing unconditionally once made failure *terminal*, leaving the dashboard silently
empty while `/api/health` still reported "ok". Retries are bounded: after
`MAX_INGEST_ATTEMPTS` (3) consecutive failures against the **same** fingerprint the session is
quarantined, which works by committing its fingerprint and thereby stopping the retry loop. It
is re-admitted with a fresh budget as soon as its file changes **or the pricing table
changes** — the canonical cure for a halt-gate failure is seeding the missing pricing row, and
that row has to unblock the watcher without a restart.

Every failure is reported through a single seam, so a silent dashboard always has a matching
report: session id, a 1-based `attempt` count, a `willRetry` flag that goes false at
quarantine, and a **sanitized** reason. Sanitizing means absolute paths collapse to `<path>`
(they encode the user's home directory and project names), all whitespace collapses to single
spaces so a reason can never forge a second log line, and the result is capped at 300
characters. An ordinary halt-gate refusal survives that treatment verbatim.

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
| Final session/agent state | JSONL | The durable record of what actually happened, once available. *(As built: JSONL proves **activity**, never **termination** — see the status lifecycle below.)* |
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

### 8.1 The status lifecycle, as built

The precedence table's "final session/agent state → JSONL" row needed one correction the
design did not anticipate. **A transcript proves that activity happened; it never proves that
it stopped.** `ParsedAgent.endedAt` is the timestamp of the *last record seen so far* — a file
that has stopped growing is indistinguishable from one whose next line has not been flushed
yet. Deriving `completed` from it marked every agent finished the first time its transcript
was read, while the agent was still running. Ingest therefore asserts exactly one status:

| Status | Written by | On what evidence |
|---|---|---|
| `working` | ingest (`ingest-session.ts`) | A transcript was read — activity, and nothing more. |
| `waiting` | `Stop` hook | The main agent finished a turn and is idle. `Stop` fires **per turn**, not at session end (see `hooks/README.md`), so it can never mean `completed`. |
| `completed` | `SubagentStop` hook | An identified subagent terminated. The only observation of an ending the system has. |
| `error` | — | Reserved. v1 never guesses it. |
| `unknown` | the watchdog | No activity for `DASHBOARD_WATCHDOG_MINUTES`. |

**Consequence, stated rather than hidden: with no hooks installed, nothing ever reports
`completed`.** Agents go `working` → `unknown`. That is the honest reading of the evidence
available, and `unknown` is displayed as `unknown` — never softened into something friendlier.

Precedence between the three writers is one rule, enforced in SQL inside the upsert
(`db/agents.ts`, mirrored in `db/sessions.ts`):

1. **Observed terminals are sticky.** Once `completed` or `error`, no later ingest downgrades it.
2. **Inferred states yield to fresh evidence.** `working`/`waiting`/`unknown` are replaced only
   when the incoming activity anchor (`last_seen_at` / `last_activity_at`) **strictly advances** —
   this is the concrete answer to OPEN-2's "unknown → revert" blank.
3. **An unchanged replay changes nothing.** Rule 2 makes re-reading an untouched transcript a
   no-op on `status`, which is what keeps the P0 byte-identical double-replay proof green while
   status itself is time-sensitive. All wall-clock dependence lives behind the watchdog's
   injected clock; the ingest path stays clock-free.

Hooks stay within CD-1: the status applier is UPDATE-only by construction (`applyAgentStatus`),
so a hook can move the `status` column of a row the parser already created and nothing else —
it can never create, delete or re-parent an agent, and a hook naming an unknown agent is stored
as raw liveness and changes no row.

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
> whole-session re-ingest** (§6) — same zero-loss/zero-dup outcome, different mechanism, with
> the optional `ingest_checkpoints` table (§6.1) recovering the *speed* the persisted offset
> was meant to buy without inheriting its trust assumptions. The
> unknown-`event_type`-stored-not-crashed gate holds as written. Three of the Phase-3 row's
> four items are built: the three P0 tests exist (§10), the missing-`Stop` watchdog is live
> (§8), and `PreCompact` repricing runs compaction-aware with the delta≈0 invariant (see
> [cost model](../architecture/cost-model.md)). **The fourth is not met, and the row is
> therefore not satisfied** — "hierarchy ≥95% vs. the labeled corpus" has never been scored,
> because the labeled corpus does not exist yet (the `LABEL-ME` trees are still blank
> templates); the gate reports `NOT CERTIFIED` at `n = 0` against a required `n ≥ 52`. Two
> smaller readings also need correcting: the P0 tests are **CI-failing, not merge-blocking**
> as §10 words it, because `main` carries no branch-protection rule; and the CD-8 hard stop
> described here was ultimately crossed by **explicit owner override on 2026-07-11**, not by
> a ratified `WP-S7` GO — which is why the spike numbers stay `PROVISIONAL`.

## What's undecided

> **Update — 2026-07 (as built).** This section is kept as the historical record of what was
> open when the page was written. Where each item landed:
>
> - **CD-1** — resolved in code: JSONL-primary, per the `CONDITIONAL-GO` verdict.
>   Implementation began 2026-07-11 by explicit owner override of CD-8; the spike numbers
>   remain `PROVISIONAL` until ratified against the hand-labeled corpus.
> - **Join key (G0.1b)** — resolved as a **hard key**: the parser keys on the
>   `Agent`/`Workflow` `tool_use` spawns and joins edges through four deterministic
>   structural paths (`tool_use`, `directory`, `queue_operation`, `task_notification`); the
>   desktop probe measured 0.000% depth-1 orphans and 100% usage attribution. A fifth path,
>   `legacy_explore`, was added for pre-2.1.71 transcripts whose `Explore` sidecars carry no
>   `toolUseId` — it is tried only after all four structural paths miss, requires two
>   independent signals to agree, and carries its own `source` label so a consumer can always
>   tell inference from observation. It is **implemented but not measured**: the shape is
>   absent from the available corpus, so it is exercised by fixtures only and stays
>   `PROVISIONAL` until a real pre-2.1.71 transcript ratifies it. No confidence-scored
>   heuristic ships — an unresolvable row stays honestly `NULL` and an orphan gets **no**
>   edge, never a guessed one.
> - **Hook catalog (G0.2)** — verified: four real hooks (`UserPromptSubmit`, `Stop`,
>   `SubagentStop`, `PreCompact`); `SubagentStart` does not exist.
> - **Missing-`Stop` late-arrival rule** — built (§8): the watchdog flips stale non-terminal
>   agents to `unknown`, and a later re-ingest upserts the status the JSONL evidence
>   supports.
> - **Retention / redaction / huge-payload** — partially resolved. Payload **redaction is
>   built at ingest** (key-name matching plus credential-shape masking, applied *before* the
>   idempotency key), with the exact policy pending owner sign-off. Retention is now split
>   cleanly: the **mechanism exists** (a policy-driven prune with a protected-table list that
>   only ever allows `events` and `token_usage` to be touched, a bounded rows-per-run cap, and
>   a `NO_RETENTION` default that is a byte-identical no-op), while the **policy — which TTL,
>   for which table — is still unset and owner-owned**, so `WP-D10` is not done. The
>   huge-payload threshold remains open. See [the data model](../architecture/data-model.md)
>   for the table-by-table detail.
> - **Hook-POST authentication** — answered: the hook receiver sits behind the same
>   mandatory-token gate as every other endpoint, and the installed hook command never puts
>   the token on any command line. The value is imported into curl from the environment with
>   `--variable '%DASHBOARD_TOKEN'` and expanded *inside* curl, after argv parsing, by
>   `--expand-header` — so neither the hook shell's argv nor curl's own argv ever carries it,
>   and the token never lands verbatim in `~/.claude` scripts. See
>   [hook ingestion](../architecture/hooks.md) for the mechanism and its curl version floor.

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
- [Cost model](../architecture/cost-model.md) — how compaction-aware repricing and its
  delta≈0 invariant build on the JSONL-authoritative token precedence in §8.
- [Testing](../contributing/testing.md) — the golden fixture corpus and the P0 test harness in
  full.
- [Decisions (ADRs)](../contributing/decisions/README.md) — CD-1, CD-2, CD-3, and CD-8 as
  recorded individual ADRs.
- [Roadmap](../guide/roadmap.md) — Phase 0 → 3 sequencing, public-friendly.
