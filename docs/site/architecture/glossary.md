# Glossary & reference

This page is the terminology anchor for the architecture docs: precise, single-source
definitions for the twenty-nine terms used across [data model](../architecture/data-model.md),
[hook ingestion](../architecture/hooks.md), [ingest & reconciliation](../architecture/ingest-reconciliation.md),
[the DAG moat](../architecture/dag-moat.md), and [cost model](../architecture/cost-model.md),
plus two reference tables: the twelve Claude Code lifecycle events DESIGN §5 lists for
ingestion, and the four-value agent status enum DESIGN §4 defines in the schema. The key
takeaway: every term here traces to one authoritative source — the DESIGN.md schema/event
lists, or the deeper architecture page that expands it — so that "ground truth",
"projection", and "reconciliation" mean exactly the same thing wherever they recur across
this docs site. Where a term named something not yet built when it was written, the
definition says so and links the roadmap; where the thing has since been built, an
as-built note follows the original rather than replacing it.

> **Update — 2026-07 (as built).** The system these terms describe now exists, and a few
> definitions shifted with it. The short version, expanded per term below: the installer
> registers **four** hooks, not twelve; `agents.status` is a **five**-value enum
> (`'unknown'` is real); a **token bucket** is one of five token kinds
> (`input`/`output`/`cache_read`/`cache_write_5m`/`cache_write_1h`), not a
> speed/geo/tier partition; JSONL lines are parsed straight into the projections and
> never land in `events_raw` (which holds hook deliveries only); there is no `projects`
> table — sessions carry a `project_slug` string; and the watchdog and delegation
> savings are built, the latter honestly labeled `isEstimate: true`. Building the thing
> also produced vocabulary DESIGN never needed — containment, skip reasons, fingerprints,
> checkpoints, tick outcomes, quarantine, the halt gate — collected in
> [Ingest mechanics](#ingest-mechanics) below.

## How the terms relate

Two shapes underlie almost every term below. The first is the persisted entity hierarchy —
project → session → agent tree — that the design basis insists is **data, not a UI
reconstruction** (DESIGN §3):

```
project                                  (DESIGN §4: simple10-derived base schema)
  └─ session                             (agents.session_id NOT NULL — DESIGN §4)
       └─ agent  type='main'             (CHECK(type IN ('main','subagent')) — DESIGN §4)
            ├─ agent  type='subagent' ───┐
            │    └─ agent  type='subagent'│   parent_agent_id self-reference
            └─ agent  type='subagent' ───┘   (the persisted subagent tree — DESIGN §3, §4)

Each parent→child agent pair also emits one row in `orchestration_edges`
(parent_agent_id, child_agent_id, instance/host, derived_from_event_id) — DESIGN §4, §2.1.
```

The second is the ingest pipeline that produces every row above, from two inbound sources
into one immutable substrate, through one deterministic transform:

```
hook event  ──┐
              ├──►  events_raw (immutable)  ──►  projection  ──►  sessions / agents /
JSONL line  ──┘                                                   orchestration_edges /
                                                                   token_usage
```

(DESIGN §3–§4; the `events_raw`(immutable) + `events`(normalized) split and the
"projection" step are named this way consistently across
[architecture overview](../architecture/overview.md).)

*(As built, only the hook leg of the second diagram exists: JSONL lines are parsed and
written into the projections directly, in one transaction per session, bypassing
`events_raw` entirely. In the first diagram, "project" is a `project_slug` string on
`sessions` — there is no `projects` table — and an edge row carries a `source` join-path
column rather than `derived_from_event_id`.)*

## Core entities

**Agent** — a row in the `agents` table: a persisted, queryable participant in a session,
either the main agent or a subagent, carrying `id`, `session_id`, `type`, `subagent_type`,
`status`, and a self-referential `parent_agent_id` that builds the subagent tree as a data
fact rather than something the UI reconstructs from a flat event log (DESIGN §3, §4):

```sql
CREATE TABLE agents (
  id              TEXT PRIMARY KEY,
  session_id      TEXT NOT NULL,
  type            TEXT CHECK(type IN ('main','subagent')),
  subagent_type   TEXT,
  status          TEXT CHECK(status IN ('working','waiting','completed','error')),
  parent_agent_id TEXT,          -- self-ref: builds the subagent tree
  FOREIGN KEY (parent_agent_id) REFERENCES agents(id) ON DELETE SET NULL
);
```

*(Design-basis sketch. The real migration adds a fifth status `'unknown'` plus
`first_seen_at`/`last_seen_at`.)* Full as-built DDL and migration story:
[data model](../architecture/data-model.md).

**Main agent** — an `agents` row with `type = 'main'`: the top-level agent for a session,
i.e. the direct Claude Code conversation the operator is driving, as opposed to any work it
delegates out (DESIGN §4 `CHECK` constraint above).

**Subagent** (one word) — an `agents` row with `type = 'subagent'` and a non-null
`parent_agent_id`: a unit of delegated work spawned by a parent agent. The `SubagentStop`
event (and, if it exists as a real hook, `SubagentStart`) is what feeds this parent→child
linkage into the persisted tree — see the [hook-event reference](#hook-event-reference-the-twelve-lifecycle-events)
below and DESIGN §5. Whether `SubagentStart` actually fires is unverified pending the
Phase-0 hook-catalog gate; see [what's undecided](../architecture/overview.md#whats-undecided).
*(As built: `SubagentStart` does not exist, and no hook feeds the linkage — the
parent→child tree comes entirely from the JSONL parser's five join paths.
`SubagentStop` keeps a narrower job: it is one of the two events that can observe an
*ending*, so it supplies a `'completed'` verdict for an agent the parser already
created — a status column and nothing structural.)*

**Session** — the scope every `agents` row belongs to (`agents.session_id NOT NULL`,
DESIGN §4): one Claude Code conversation, corresponding to one transcript under
`~/.claude/projects/*.jsonl` (DESIGN §3). `sessions` is one of the base tables the schema
starts from, alongside `projects`, `agents`, `events`, and `filters` (DESIGN §4).
*(As built: `sessions.id` is the session UUID from the transcript — never the directory
slug — and the `projects`/`filters` tables were never created.)*

**Project** — the Claude Code project (working directory) that groups one or more
sessions, per the same base schema DESIGN §4 starts from (`projects`, `sessions`, `agents`,
`events`, `filters` + disciplined migration tables) and the `~/.claude/projects/*.jsonl`
directory convention the ingest loop reads from (DESIGN §3). *(As built: not a table —
a `project_slug` string column on `sessions`, taken from the corpus directory name,
turned out to suffice.)*

**Instance / host** — the `instance`/`host` (also written `host_id`) key carried on
`orchestration_edges` rows (and, per the schema hedge, intended for every row) from the
first migration, identifying which running Claude Code process on which machine produced a
fact. agenthropic is single-host today (one Mac Mini M4); the key exists purely so a later
cross-machine fleet rollup (DESIGN §2.4, roadmap Phase 5+) never forces a schema migration
(DESIGN §4). "Per-instance" is the qualifier that distinguishes a real orchestration edge
from a *type-aggregated* diagram like `hoangsonww`'s (DESIGN §6).

## Pipeline & cost concepts

**Event** — a single lifecycle occurrence: either one of the twelve Claude Code hook types
DESIGN §5 lists, POSTed to the loopback `hook-ingest` endpoint, or a line tailed from the
JSONL transcript. Every event lands first, unmodified, as a row in the immutable
`events_raw` substrate, then is turned into a normalized `events` row and folded into
projected state — the `events_raw`(immutable) + `events`(normalized) split (DESIGN §3–§4).
Full catalogue: [hook ingestion](../architecture/hooks.md).
*(As built, the term covers only the hook leg: `events_raw` holds hook deliveries
exclusively — redacted, then keyed — and `events` is the identifier-only hook liveness
timeline. JSONL lines never become "events"; they are parsed straight into the
projections.)*

**Orchestration edge** — a persisted row in `orchestration_edges` recording one
parent→child agent relationship. Unlike every audited rival's tree, which is
**event-derived and reconstructed at render time, session-scoped**, these edges are
**persisted** (written once, at ingest or projection time), **per-instance** (not
type-aggregated), and carry the `instance`/`host` key described above — the moat feature
DESIGN §2 item 1 names as unclaimed by any of the six audited projects (DESIGN §2.1, §4).
Full design and the rebuild-from-JSONL story: [the DAG moat](../architecture/dag-moat.md).

*(As built, an edge carries its **provenance** in a `source` column whose `CHECK`
constraint admits exactly five values — `'tool_use'`, `'directory'`,
`'task_notification'`, `'queue_operation'`, `'legacy_explore'` — one per join path the
parser can prove, so a consumer can always tell *how* a relationship was established and
filter on it. The table is keyed `UNIQUE(session_id, parent_agent_id, child_agent_id)` and
written with `INSERT OR IGNORE`, which is what makes re-ingesting the same transcript a
no-op instead of a duplicate: the first proof of a relationship wins and later passes add
nothing. There is no `derived_from_event_id` column — the design sketch pointed edges back
at an `events_raw` row, but JSONL never enters that table.)*

> **Empirically validated (2026-07-04 desktop probe).** The persisted, per-instance,
> rebuild-from-JSONL edge model is confirmed against the real corpus: the depth-1
> parent→child edge is a **0%-orphan** hard key, and the tree is reconstructed by keying on
> the `Agent`/`Workflow` spawn tools (**never** `Task`) across **both** on-disk layouts.
> See [Phase-0 corpus probe](../../analysis/phase0-probe.md).

**Token bucket** — the `(speed, inference_geo, service_tier)` partition a `token_usage`
row falls into; each dimension independently changes the per-token rate, so the same
nominal token count can price differently depending on which bucket produced it — the
`hoangsonww` graft DESIGN §4 adopts for production-grade costing. Detail:
[cost model](../architecture/cost-model.md).
*(As built, the term means something simpler: one of the five token kinds the real JSONL
actually records — `input`, `output`, `cache_read`, `cache_write_5m`, `cache_write_1h` —
each with its own dated rate in `model_pricing`. The speed/geo/tier dimensions do not
appear in the transcripts and were never built.)*

**Compaction baseline** — the pre-`PreCompact` token totals a `token_usage` row preserves
so that historical totals still price correctly after Claude Code rewrites the context
window, instead of silently losing history at the rewrite boundary (DESIGN §4). At the
ingest boundary `PreCompact` is handled like most other events — generic, not one of the
two dedicated-handling hooks (see the hook-event reference below) — but its payload is
what feeds this baseline-preservation logic downstream, at projection time.
*(As built, nothing is flagged. The column `token_usage.is_compaction_baseline` exists but
is **dead** — the writer inserts a literal `0` on every row and no read path ever consults
it (implementation review 2026-08-09, finding L-7). Compaction boundaries are detected in
the parsed JSONL substrate itself, at analysis time, and repricing walks them directly;
the `PreCompact` hook feeds nothing but liveness. Stated plainly so nobody plans a query
against a marker the code does not maintain.)*

**Delegation savings** — the dollar amount saved by routing work to a cheaper model (e.g.
Haiku) instead of pricing every token at the top-tier model's rate; part of the moat
DESIGN §2 item 2 names ("live dollar-cost attribution + delegation-savings … Borrow
`cast`'s ~50-LOC formula") and the roadmap's Phase 4 dual-pricing tile (DESIGN §9). DESIGN's
original sketch places this in Phase 4; the verified build plan re-sequences it into Phase
3 alongside the rest of the cost engine — see [roadmap](../guide/roadmap.md) for the
reconciled phase numbering. Computed strictly from ground-truth tokens × the versioned
pricing table, never estimated. Detail: [cost model](../architecture/cost-model.md).
*(As built, one honesty refinement to "never estimated": the actual-cost side is
ground truth, but the top-tier re-price is by definition a counterfactual, so the
shipped result carries a literal `isEstimate: true` and lists agents it could not
attribute a model to in `skippedAgentIds` instead of guessing.)*

## System guarantees

**Ground truth** — the invariant that every token count agenthropic ever displays or
prices is **read** from `~/.claude/projects/*.jsonl`, never estimated from tool-call
counts, never model-guessed, and never backfilled by a cheaper heuristic when one is
available (DESIGN §3, §8; restated as a non-negotiable design invariant in the repo's
`CLAUDE.md`). "Ground-truth tokens" is this docs site's fixed term for the same
guarantee (see [style guide](../STYLE-GUIDE.md)).

**Projection** — the deterministic, pure function that turns the immutable `events_raw`
log into queryable state: `sessions`, `agents`, `orchestration_edges`, `token_usage`.
Replaying the same `events_raw` log twice must yield byte-identical projected state — this
is a release-blocking correctness property, not an aspiration (DESIGN §3–§4, as summarized
in [architecture overview](../architecture/overview.md)). Full treatment:
[data model](../architecture/data-model.md).
*(As built, the pure function is the JSONL **parser** (`packages/core/src/parser`) and
its input is the transcript, not `events_raw`; determinism survived as pure parsing plus
idempotent whole-session writes — re-ingesting an unchanged session changes nothing,
proven by the double-replay P0 test.)*

**Reconciliation** — the per-field precedence rule the projection applies when a hook
event and a JSONL fact describe the same thing, resolved **at projection time**, not as a
two-store merge at query time. The standing rule: tokens are always JSONL-authoritative;
hooks may supply interim liveness/state, but the final session/agent state and cost always
trace to the transcript (DESIGN §3, as summarized in
[architecture overview](../architecture/overview.md), Invariant 1). Full contract,
including the still-open ingest-primacy question: [ingest & reconciliation](../architecture/ingest-reconciliation.md).
*(As built, the precedence rule got structurally simpler: hooks contribute liveness
only — a timeline of receipt-stamped identifier rows — and never write structure, so
there is no per-field merge to arbitrate. Everything structural is JSONL-derived by
construction.)*

> **CD-1 pre-answered (not replaced).** The trustworthiness of JSONL as the outage-surviving
> single source of truth behind this rule — decision **CD-1** — is empirically **pre-answered
> `CONDITIONAL-GO` (confidence 85)** by the 2026-07-04 desktop probe
> ([Phase-0 corpus probe](../../analysis/phase0-probe.md)). This **de-risks but does not
> replace** the formal Phase-0 spike: it still confirms CD-1 on the paired-capture corpus, and
> the still-open ingest-primacy question above is unaffected.

**Watchdog** — the mechanism that flags a stuck agent as an explicit state rather than
leaving it falsely "working" forever when its stop signal never arrives within a window.
The pattern source named in the design basis is `hoangsonww`'s stuck-session watchdog idea:
a ~15-second transcript-interrupt marker plus an idle-timeout fallback, implemented with
`fs.watch` and a polling safety net (DESIGN §6). Deployed behavior (not yet built) and the
exact target state name are covered by
[operations/troubleshooting](../operations/troubleshooting.md) and sequenced in the
[roadmap](../guide/roadmap.md); see also the note on the `unknown` status below.
*(As built: the watchdog exists — a non-terminal agent whose last activity anchor is
older than `DASHBOARD_WATCHDOG_MINUTES` (default 10, PROVISIONAL) flips to the real
`'unknown'` status, and a later re-ingest lets JSONL evidence win the status back.
There is no `fs.watch` anywhere: the ingest watcher deliberately polls.)*

## Ingest mechanics

Everything in this section is vocabulary the running code introduced. None of it appears
in DESIGN — these are the names the implementation needed once the corpus on disk stopped
being a diagram and started being 12.8 GiB of files written by another process while we
read them.

**Legacy-explore edge** — an `orchestration_edges` row with `source = 'legacy_explore'`:
the fifth and only *inferential* join path. The other four prove a parent→child
relationship from structure the transcript states outright; this one exists for
pre-2.1.71 transcripts whose sidecars carry a bare `Explore` shape with none of the modern
anchors. It fires only when every modern anchor has missed **and** two independent
conditions both hold: the sidecar matches the legacy shape by key *presence*, and a
foreign progress record names the child's hex as its own structural top-level `agentId`.
A nested `data.agentId` is deliberately **not** scanned — the parser contract forbids
substring joins, and a substring match here would silently invent parents. The path is
implemented and fixture-covered but **not measured**: no `legacy_explore` edge appears
anywhere in the available corpus, so it is **PROVISIONAL** until a real pre-2.1.71
transcript ratifies it. It carries its own `source` value precisely so a consumer can
exclude inferred edges from a structural query. Detail:
[the DAG moat](../architecture/dag-moat.md).

**Containment** — the guarantee that the corpus reader only ever opens files that are
genuinely inside the configured corpus root. Enforced by opening with
`O_RDONLY | O_NOFOLLOW`, re-checking the descriptor with `fstat` after the open (so a path
swapped between check and use cannot slip through), and inspecting directory entries with
`lstat` rather than `stat` so a symlink is seen as a symlink. A containment violation
raises `ContainmentError` and **aborts the entire run** — unlike a per-file hazard, it
means the corpus is crafted rather than merely messy, and continuing would mean trusting
the rest of it. Contrast `OversizeError` and ordinary IO failures, which are reported as
per-file skips and let the run continue.

**Skip reason** — the recorded, enumerated cause for a discovered file that was *not* fed
to the parser. There are eight: `oversize`, `symlink`, `not-regular-file`, `unreadable`,
`empty-agent`, `empty-main`, `non-artifact`, and `duplicate-session`. The list is a closed
union rather than free text because the whole point is countability — a skip that is
merely logged is a skip nobody notices, and "ingest finished" must never quietly mean
"ingest finished, minus the files it could not read". A run reports its skips; it does not
drop files silently.

**Duplicate session** — two corpus directories claiming the same session id. Resolved
deterministically rather than by arrival order: the smallest-sorting `projectSlug` wins,
and the losers are reported *before* the per-session loop and regardless of any session
filter, so the conflict is visible even when the run was scoped to something else
entirely.

**Fingerprint** — the cheap change-detector for one session: the main transcript's
`size:mtime`, plus a sorted `rel:size:mtime` line for every sidecar artifact. Comparing
fingerprints is how the poll tick decides a session is worth re-parsing. It is not a byte
offset and makes no claim about *where* a file changed — only that it did.

**Checkpoint** — a persisted fingerprint in `ingest_checkpoints` (migration 9) that lets a
restart skip sessions it has already projected. Opt-in; the default is a full replay,
which is also the fail-safe path the double-replay proof exercises. Four rules keep it
from turning speed into trust: it is **scoped** (a sha-256 of the resolved corpus root, so
pointing at a different corpus cannot reuse another one's memory); it is **revisioned**
(`REPLAY_CHECKPOINT_REVISION`, bumped when parser output changes meaning, invalidating
every stored fingerprint at once); it demands **proof of projection** (the store re-checks
that the session row still exists before handing a fingerprint back, and only a session
this process successfully projected in this pass is ever checkpointed — not a failure, not
a quarantine, not a session that yielded no substrate); and it **degrades rather than
crashes** (any checkpoint-store problem falls back to full replay). The rule in one line:
a checkpoint may change how much *work* a boot does, never what the boot *results in*.

**Tail read** — reading the newly-appended portion of a transcript rather than the whole
file. Bounded by `DEFAULT_MAX_FILE_BYTES` (64 MiB) and `DEFAULT_MAX_DEPTH` (4) — both
**PROVISIONAL (LABEL-ME)**, chosen as sane ceilings rather than measured limits.

**Tail cache** — the optimization that keeps the parsed head of a file in memory so a tail
read does not re-read from byte zero. It caches **complete lines only**, which is safe
because `0x0A` cannot occur inside a multi-byte UTF-8 sequence, and it re-reads a small
overlap and compares it before trusting the cached prefix; on any divergence it discards
the cache and reads the whole file. Errors from the underlying filesystem propagate
untouched rather than being swallowed into a cache miss. `OVERLAP_BYTES` is 4096,
`MAX_CACHE_BYTES` 128 MiB, `MAX_CACHE_ENTRIES` 512 — all **PROVISIONAL (LABEL-ME)**. The
design property worth naming: the cache can cost speed when it is wrong, but it can never
change an answer.

**Tick outcome** — what one poll tick reports, as a seven-armed union rather than a
boolean: `ingested`, `unchanged`, `no-corpus-root`, `overlapped`, `stopped`, `read-error`,
`containment-halt`. The arms exist for the same reason `'unknown'` is a real agent status
and not a `NULL` — collapsing "nothing changed" together with "the corpus root does not
exist" or "we halted on a containment violation" would let a broken deployment look
identical to an idle one.

**Quarantine** — what happens to a session that fails ingest repeatedly against an
*unchanged* fingerprint. After `MAX_INGEST_ATTEMPTS` (3) consecutive failures the session
is parked and stops consuming every tick; the outcome carries a `willRetry` flag so the
state is legible rather than inferred. The budget is deliberately small — the retry exists
for a transient cause such as a half-written line, not as a substitute for fixing the
corpus. One event re-admits every parked session with a fresh budget: a change to the
pricing table, so a session that burned its attempts against a missing price is retried
the moment the row is seeded. Failure reasons are sanitized before they are recorded —
paths replaced with `<path>`, whitespace collapsed, capped at 300 characters — so an error
message cannot leak a filesystem layout into a durable record.

**Halt gate** — the pipeline's refusal to write a session it cannot price. The order
inside one session is load-bearing: parse → **compute cost** → normalize → project, with
pricing computed *before* the transaction opens. An unknown model id or a missing bucket
rate raises `PricingError` while the database is still untouched, so the session fails
whole instead of landing as a confident `$0`. There is no partial write to reconcile
later.

**Unpriced tokens** — tokens the read layer counted but could not price, because no
`model_pricing` row covers their model at their timestamp. They are surfaced as their own
figure at every level of the cost API and contribute `$0` to the dollar total — never a
guess, and never quietly folded in. A dollar figure that is missing some tokens is only
honest if the missing tokens are visible next to it.

**`<synthetic>`** — the model id the CLI uses for its own internal messages. It is priced
at zero through **explicit seed rows**, not through a fallback: the distinction matters
because a general "unknown model costs nothing" rule would silently absorb real models
too, which is exactly what the halt gate exists to prevent. Delegation-savings analysis
keeps `<synthetic>` rows on their own zero-rate model rather than re-pricing them at a
top-tier rate.

**Retention policy** — the configured answer to "how many days of what do we keep". The
**mechanism** is built: bounded windows so a run cannot hold the write lock indefinitely,
deletion restricted to the two projection tables (`events` and `token_usage`) by
`RETENTION_PROTECTED_TABLES` so nothing can reach the append-only substrate or the
persisted DAG, only rows with a known timestamp eligible to expire, and a journalled count
of sessions whose rows straddle the cutoff — a partially-pruned session still reports a
total, just a smaller one, which is the exact shape of a silently wrong number. The
**policy** is not built, because it is not a code decision: the default `NO_RETENTION` is
a byte-identical no-op that deletes nothing, ever, and it stays the default until the
owner ratifies real numbers. `WP-D10` is therefore mechanism-done, policy-open.

## Hook-event reference (the twelve lifecycle events)

DESIGN §5 sets the ingestion policy as: ingest all twelve via a single hook-handler, and
give `SubagentStart`/`SubagentStop` dedicated handling to feed the hierarchy tables. Not
all twelve are confirmed real: the independent analysis this design basis synthesizes
separately names a **documented set of only nine** — `PreToolUse`, `PostToolUse`,
`UserPromptSubmit`, `Notification`, `Stop`, `SubagentStop`, `SessionStart`, `SessionEnd`,
`PreCompact` — flagging `SubagentStart` as "probably not a real hook" and leaving
`PermissionRequest`/`PostToolUseFailure` likewise unconfirmed against that documented set.
This is exactly the open question [architecture overview](../architecture/overview.md#whats-undecided)
carries forward as a Phase-0 gate (`G0.2`, per [roadmap](../guide/roadmap.md)) — until it
runs, treat the "confirmed" column below as **DESIGN §5's stated intent**, not verified
fact.

> **Resolved as built (G0.2).** The installer registers exactly four hooks —
> `UserPromptSubmit`, `Stop`, `SubagentStop`, `PreCompact` — and `SubagentStart` does
> not exist. Every registered hook is treated identically: one `events_raw` row plus one
> identifier-only `events` liveness row, in the same transaction. **No hook has dedicated
> handling** — the "Dedicated" cells below are design history; hierarchy and compaction
> baselines both come from the parsed JSONL. Unregistered event names would still be
> accepted and stored (accept-any-event shipped), they are simply never sent.

| Event | Confirmed in the documented nine? | Dedicated handling in agenthropic | Source |
|---|---|---|---|
| `PreToolUse` | Yes | Generic ingest → `events_raw` | DESIGN §5 |
| `PostToolUse` | Yes | Generic ingest → `events_raw` | DESIGN §5 |
| `UserPromptSubmit` | Yes | Generic ingest → `events_raw` | DESIGN §5 |
| `Notification` | Yes | Generic ingest → `events_raw` | DESIGN §5 |
| `Stop` | Yes | Generic ingest → `events_raw` | DESIGN §5 |
| `SubagentStop` | Yes | **Dedicated** — feeds `agents`/`orchestration_edges` hierarchy | DESIGN §5 |
| `SubagentStart` | **No** — unverified, pending Phase-0 gate `G0.2` | **Dedicated, if confirmed** — paired with `SubagentStop` for hierarchy linkage | DESIGN §5; [overview §What's undecided](../architecture/overview.md#whats-undecided) |
| `SessionStart` | Yes | Generic ingest → `events_raw`; session-boundary bookkeeping | DESIGN §5 |
| `SessionEnd` | Yes | Generic ingest → `events_raw`; session-boundary bookkeeping | DESIGN §5 |
| `PreCompact` | Yes | Generic ingest → `events_raw`; marks the compaction boundary so `token_usage` preserves a repriceable baseline | DESIGN §4, §5 |
| `PermissionRequest` | **No** — not in the documented nine | Generic ingest → `events_raw` | DESIGN §5; [overview §What's undecided](../architecture/overview.md#whats-undecided) |
| `PostToolUseFailure` | **No** — not in the documented nine | Generic ingest → `events_raw` | DESIGN §5; [overview §What's undecided](../architecture/overview.md#whats-undecided) |

Full lifecycle-event catalogue and normalizer behavior for unrecognized/new event types
(never fatal — DESIGN §3, concept-analysis-v2 §4.2 as summarized in the overview page):
[hook ingestion](../architecture/hooks.md).

## Status enum

The DESIGN §4 schema quoted above sketched a four-value `CHECK` constraint; **as built,
`agents.status` is a five-value enum** — migration 4 includes `'unknown'` from the start:

| Status | Meaning | Source |
|---|---|---|
| `working` | The agent is actively running (the default live state for main agents and subagents alike). | DESIGN §4 |
| `waiting` | The agent is blocked — e.g. awaiting a permission decision or a delegated subagent's result. | DESIGN §4 |
| `completed` | The agent finished normally. | DESIGN §4 |
| `error` | The agent terminated in an error state. | DESIGN §4 |
| `unknown` | Watchdog-assigned: the agent's stop evidence never arrived within the window. A visible, honest state — never hidden, never mapped onto `working`. | Migration 4 (as built); roadmap Phase 3 |

*(As built, the table above describes the vocabulary; who may speak each word is the part
worth knowing. Ingest asserts exactly one status, `'working'`, because reading a transcript
proves activity and never termination. `'waiting'` comes from the `Stop` hook and means
"the main agent is idle right now" — `Stop` fires at the end of every turn, so reading it
as an ending would be a lie. `'completed'` comes only from `SubagentStop`. `'unknown'`
comes only from the watchdog. The consequence, stated rather than hidden: **with no hooks
installed nothing ever reports `'completed'`** — agents go `'working'` → `'unknown'`, which
is the honest reading of the evidence available. Observed terminals are sticky; an inferred
state reverts only when the JSONL timestamps strictly advance. Full lifecycle:
[hook ingestion](../architecture/hooks.md).)*

> **Open item — the `unknown` status.** *(Resolved as built — kept for the record.)* The
> roadmap and the underlying build plan describe
> a fifth, watchdog-assigned state: when an agent's stop signal never arrives within the
> watchdog window, it should be marked **`unknown`** rather than staying falsely `working`
> forever (roadmap [Phase 3](../guide/roadmap.md)). This is a real, planned behavior, but it
> is **not yet reflected in the DESIGN §4 `CHECK` constraint** quoted above — reconciling
> the schema to add it (or mapping "unknown" onto an existing value) is open work for
> [data model](../architecture/data-model.md) and
> [operations/troubleshooting](../operations/troubleshooting.md), not a decision this page
> makes. *Resolution: the real migration added `'unknown'` to the `CHECK` constraint
> directly, and the read API additionally counts agents with an absent status in the
> `unknown` bucket rather than faking certainty.*

## See also

- [Architecture overview](../architecture/overview.md) — the full ingest loop and the two
  invariants (ground truth, persisted hierarchy) these terms protect.
- [Data model](../architecture/data-model.md) — full DDL for `agents`, `sessions`,
  `events_raw`/`events`, `token_usage`, `orchestration_edges`.
- [Hook ingestion](../architecture/hooks.md) — the lifecycle-event catalogue in depth,
  the status lifecycle, and the argv-free token mechanism.
- [Ingest & reconciliation](../architecture/ingest-reconciliation.md) — the reconciliation
  contract, CD-1, and the Phase-0 ingest-primacy spike.
- [The DAG moat](../architecture/dag-moat.md) — persisted `orchestration_edges` and the
  rebuild-from-JSONL story.
- [Cost model](../architecture/cost-model.md) — token buckets, compaction repricing and
  its delta≈0 invariant, dual-pricing, and delegation savings in depth.
- [Roadmap](../guide/roadmap.md) — phase sequencing for the watchdog, delegation savings,
  and every other item marked not-yet-built above.
- [Style guide](../STYLE-GUIDE.md) — the terminology and authoring conventions this page
  follows.
