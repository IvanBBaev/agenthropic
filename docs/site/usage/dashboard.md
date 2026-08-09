# Using the dashboard

> **Design-target documentation — pre-Phase-0.** This page documents agenthropic's
> *intended* behavior for the web dashboard and its views, as fixed by the design basis
> (`docs/ai/DESIGN.md`) and the build plan (`docs/analysis/development-plan.md`). **No
> application code is built yet** (see the [roadmap](../guide/roadmap.md)); the web
> dashboard ships in **Phase 4 — Read API, the dashboard, and the five daily
> questions**. Values marked _(planned)_ or _(leaning — unconfirmed)_ may change; the
> **security invariants are binding and will not**. This replaces the earlier stub.

> **Update — 2026-07 (as built).** All four views described below are built and
> shipped in `apps/web`, so the "no application code is built yet" sentence above is
> now historical. What actually runs: a React SPA behind a hand-rolled hash router
> (`#/live`, `#/sessions`, `#/dag`, `#/cost` — `apps/web/src/router.ts`) whose shell
> renders nothing until a token is present, held in **`sessionStorage` only**
> (`apps/web/src/token.ts`). The four views are `LiveView` (WP-U6), `SessionsView`
> (WP-U7), `DagView` (WP-U8) and `CostView` (WP-U9). Corrections to the text below,
> each verified against the repository:
>
> - **`agents.status` has five values, not three and not four**:
>   `working | waiting | completed | error | unknown` (`apps/web/src/views/status.ts`).
>   The enumeration mismatch §1 calls unresolved schema work **is resolved**. A
>   `null` persisted status is a *separate* state rendered as `unrecorded` — it is
>   deliberately **not** folded into `unknown`, because `unknown` is a state the
>   watchdog actively assigns while `null` means nothing was ever recorded.
> - **The routes are real and prefixed `/api`**: `GET /api/sessions/:id/tree`,
>   `GET /api/dag/global`, `GET /api/cost/summary`. They are no longer illustrative
>   naming, and [the API reference](api.md) is no longer a stub.
> - **Only the cost view uses D3.** `CostView`'s sankey layout comes from `d3-sankey`
>   (`apps/web/src/views/layout/cost-flow.ts`); the session tree and global DAG are
>   drawn as hand-rolled SVG over a pure layered-layout module
>   (`apps/web/src/views/layout/layered.ts`) — **no force graph was built**.
> - **An unpriced model is not "a red build."** At runtime the per-session
>   cost-analysis endpoint raises `PricingError` → HTTP 422, and the DB rollups
>   surface the affected tokens as a separate `unpricedTokens` figure. Nothing is
>   ever silently costed at $0.
> - **`model_pricing` has no `verified_on` column.** Its primary key is
>   `(model, bucket, effective_from)` (migration 7, `apps/server/src/db/migrations.ts`),
>   and the seeded rates are explicitly **PROVISIONAL / awaiting ratification**.
> - **The UI honesty rules are implemented, not aspirational** — always-rendered
>   status buckets including zero counts, a permanent observed/inferred edge legend,
>   declared-not-drawn dropped edges, a truncation banner with real numbers, and an
>   unpriced-token KPI. They are listed per view below.

This page documents the four views the dashboard's browser SPA is designed to render,
the five daily questions each one exists to answer, and how the SPA authenticates and
stays live. The key takeaway: every view is a read-only projection over data that
already exists in SQLite before the browser ever opens — the session tree and the
global DAG are **queries over the persisted `orchestration_edges` table**, not anything
reconstructed in JavaScript from an event stream (per `DESIGN.md` §6 and WP-U3/WP-U8's
own Done-when clauses) — and the SPA itself renders nothing until it has proven
possession of the mandatory dashboard token (WP-U5).

## The five daily questions

The dashboard's entire scope is driven by five concrete questions, not feature-parity
envy with the audited rivals. They are recorded verbatim as decision **D3** in
`docs/analysis/implementation-plan.md` ("v1 daily-questions — the MVP definition of
value"), and every downstream work package that builds a view cites one or more of them
by number:

| # | Daily question (verbatim, D3) | Answered by |
|---|---|---|
| Q1 | *What is the subagent tree of this session, and which branch is still running?* | Session subagent tree (§2) for the tree shape; live status (§1) for "still running" |
| Q2 | *Which agent/subagent burned the most tokens (and roughly what did it cost)?* | Cost / Sankey / delegation-savings (§4) |
| Q3 | *Did any session get stuck / error without me noticing?* | Live status board (§1) |
| Q4 | *What did today/this week cost, and how much did Haiku/Sonnet routing save?* | Cost / Sankey / delegation-savings (§4) |
| Q5 | *Show me last night's sessions — persisted, after a restart.* | Live status board's session list (§1), backed by SQLite WAL persistence |

The backend read endpoints that serve these are grouped by the same numbering in
`development-plan.md`: `WP-U3` ("Session/agent/subagent-tree endpoints — **daily
Q1/Q3/Q5**") and `WP-U4` ("Cost, delegation & global-DAG endpoints — **daily Q2/Q4**").
Note that `WP-U4` bundles the global-DAG read endpoint in with the cost/delegation ones
even though the global DAG (§3 below) isn't itself one of the five named questions — it
is the moat feature that cuts across all of them, not an answer to a single one (see
[the moat](../guide/the-moat.md)). This grouping is the development plan's own, quoted
as-is rather than re-derived.

Phase 4's exit gate (`docs/analysis/development-plan.md`, Phase 4 row; restated in the
[roadmap](../guide/roadmap.md#phase-4--read-api-the-dashboard-and-the-five-daily-questions))
is explicit that shipping means **all five** are answerable from the UI, and that **a
new session's story is understandable in under 30 seconds** — the numeric bar every
view below is designed against, not a vague "should feel snappy."

## How the four views fit together

```
                    SQLite (WAL) — projected tables, written once at ingest/projection
                              │
        ┌─────────────────────────────────────────────┐
        │ orchestration_edges   agents   token_usage    │
        │ (moat artifact)       (tree)   (ground-truth) │
        └───────────────┬───────────────┬──────────────┘
                         │ query, never render-time      │ query
                         │ reconstruction (WP-U3, WP-U8)  │ (WP-U4)
                         ▼                                ▼
        Read API (loopback, token-gated, WP-U2) ── + ── RealtimeHub (SSE, WP-U1)
                         │                                │
                         └───────────────┬────────────────┘
                                          ▼
                      React/Vite SPA (WP-U5) — loads only behind the token gate
        ┌───────────────┬───────────────┬───────────────┬─────────────────────┐
        │ (a) Live       │ (b) Session   │ (c) Global    │ (d) Cost / Sankey / │
        │ status board   │ subagent tree │ persistent    │ delegation-savings  │
        │ (WP-U6)        │ (WP-U7)       │ DAG (WP-U8)   │ (WP-U9)             │
        └───────────────┴───────────────┴───────────────┴─────────────────────┘
```

This is the same `hook-ingest → SQLite (WAL) → SSE → browser SPA` loop described on
the [architecture overview](../architecture/overview.md); the dashboard is the read
side of that pipeline, not a second data path.

## (a) Live status board — working / unknown / done

**Answers:** Q3 ("did any session get stuck / error without me noticing?") and,
alongside §2, the "which branch is still running" half of Q1; its session list also
backs Q5 ("show me last night's sessions").

**What it is.** A board of every agent/subagent, each showing one of a small set of
states, built to be read at a glance rather than studied. `WP-U6`'s Done-when names the
target directly:

> **Live status view** (working/unknown/done) — the **<30s at-a-glance**. A newly-stuck
> agent flips to "unknown" live via SSE within the window. (`development-plan.md`,
> `WP-U6`)

**What backs it.** The `unknown` state is not a UI label invented for the board — it is
a real, persisted status produced by the missing-`SubagentStop` watchdog (`WP-IN12`):
"a missing `SubagentStop` → **'unknown'** within the window, never a permanent
'working' forever" (see [the DAG moat](../architecture/dag-moat.md#dual-path-edge-construction-wp-in8)).
The board reads that same `agents.status` column the tree and DAG views read — it does
not maintain a separate notion of "stuck." One naming note worth flagging rather than
smoothing over: `DESIGN.md` §4's original schema sketch for `agents.status` enumerates
`working`/`waiting`/`completed`/`error`, with no `unknown` value — the three-state
`working`/`unknown`/`done` framing is the later, more specific one named by `WP-U6` and
`WP-IN12` together, and this page follows the newer, work-package-level framing as the
one actually built to. The exact reconciliation between the two enumerations is schema
work not yet written (owned by `WP-D4`). *(As built: it is written. See the box below.)*

> **As built:** the reconciliation landed as a **five-value** enumeration —
> `working | waiting | completed | error | unknown` — i.e. `DESIGN.md` §4's four
> original values **plus** the watchdog's `unknown`, rather than either sketch
> winning. `apps/web/src/views/status.ts` is the single place that fixes the order
> and the glyphs (`● working`, `◌ waiting`, `✓ done`, `✕ error`, `▲ unknown`).
>
> One distinction the design docs never drew, and the code insists on: a row whose
> `status` is **`null`** is *not* `unknown`. It renders as its own `· unrecorded`
> state, because `unknown` is a claim the watchdog actively makes ("this should have
> stopped and didn't") while `null` only means no status was ever written. Folding
> them together would fake certainty. On the API side, however, agents with a `null`
> status are counted **into** the `unknown` bucket of a session's rollup — "an absent
> status IS unknown, and hiding it would fake certainty" (`apps/server/src/api/queries.ts`).

**How to read it.** Three states, read left to right as urgency: a session/agent still
executing is `working`; one whose expected completion signal never arrived within the
watchdog window is `unknown` — the state that should draw your eye first, since it is
exactly the "stuck without me noticing" case Q3 asks about; one that reported a clean
stop is `done`. Because the flip to `unknown` arrives over SSE (§5 below) rather than on
a page reload, a session that goes stale while the board is already open updates in
place.

> **As built:** `LiveView` renders **all five** buckets for every session, including
> the ones sitting at zero (they get a dimmed `bucket-zero` class rather than being
> filtered out) — a board that hides empty buckets would let a reader infer "no
> errors" from an absent error count. It fetches `GET /api/sessions` (page size 50)
> and then stays live off two typed SSE frames: `session-ingested` triggers a
> refetch, `agent-status-changed` patches the affected session's counts in place and
> falls back to a refetch when the patch does not match anything it is holding.
> Heartbeats are SSE *comment* frames and never surface to the client. Where a
> session has tokens that could not be priced, the row shows `~ n unpriced`
> alongside its dollar figure rather than absorbing them into it.
>
> **Who writes each state — and what you see with no hooks installed.** Reading a
> transcript proves *activity*, never *termination*, so ingest only ever writes
> `working`. `completed` comes from the `SubagentStop` hook, `waiting` from the `Stop`
> hook (which fires at the end of every **turn**, so it means "idle right now", not
> "finished"), and `unknown` from the watchdog after `DASHBOARD_WATCHDOG_MINUTES` of
> silence. **If you have not installed the hooks (`hooks/install.mjs`), nothing on this
> board will ever read `done`** — agents move `working` → `unknown` and sit there. That
> is not a bug in the board; it is the board declining to claim an ending nobody
> observed. See
> [the status lifecycle](../architecture/ingest-reconciliation.md#81-the-status-lifecycle-as-built).

## (b) Session-scoped subagent tree

**Answers:** Q1 (the tree shape of "what is the subagent tree of this session").

**What it is.** A D3-rendered tree/force graph of one session's agents and subagents,
parent→child. `WP-U7`'s Done-when:

> **Session-scoped subagent tree view** (D3 force+tree, live). From a real fixture the
> tree matches the labeled hierarchy (**≥95%**). (`development-plan.md`, `WP-U7`)

**What backs it.** This is the point where the moat's core discipline is most visible
in the UI: the tree is **not** walked from a raw event log by the browser at render
time. `WP-U3`'s backend endpoint states this explicitly — `GET /sessions/:id/tree`
(the work package's own illustrative naming, not yet a built or confirmed route)
*(As built: it is a real route, at `GET /api/sessions/:id/tree`.)* is
"built from a **query over `orchestration_edges`**" (per
[the DAG moat](../architecture/dag-moat.md#persisted-not-event-derived-at-render-time)),
the same persisted table `DESIGN.md` §4 requires to be written once, at ingest/
projection time, rather than recomputed on every page load. The ≥95% accuracy bar is
the same figure Phase 3's exit gate holds the underlying reconstruction to against a
hand-labeled real session, "even without the dedicated subagent-start signal"
(`docs/site/guide/roadmap.md#phase-3--projection-the-dag-moat-reconciliation-cost`) —
the tree view inherits that correctness bar rather than defining a separate, looser one
for display purposes.

**How to read it.** Root is the main agent; each edge is a persisted parent→child
`orchestration_edges` row, not an inferred nesting guess; each node's status (see §1) is
what tells you which branch is still running versus finished versus stuck.
`DESIGN.md` §6 names `simple10`'s `buildAgentTree()`/`layoutTree()` (parent→child,
orphan-reparenting, root synthesis) plus its dependency-free N-body force graph as the
rendering model to match for this view specifically — table-stakes to hit, not the
moat itself (the moat is §3, next).

> **As built:** `SessionsView` renders hand-written SVG over a **deterministic
> layered layout** (`apps/web/src/views/layout/layered.ts`), not a force simulation
> — the force-graph model above was studied and not adopted. What the view adds
> beyond the design text is edge provenance and three honesty affordances:
>
> - Every edge is drawn **solid when observed** (`source = tool_use`) and **dashed
>   when inferred** (`directory`, `task_notification`, `queue_operation`), with the
>   provenance also in each edge's `<title>` and a legend that is permanently on
>   screen rather than behind a hover or a toggle.
> - Edges whose endpoint is not in the payload are **counted and declared in text**
>   ("reference agents outside this payload and are not drawn"), never drawn to a
>   node that isn't there and never silently dropped.
> - Cyclic nodes are likewise declared rather than laid out as if acyclic, and the
>   `unattributed` bucket is always rendered — including when it is empty.

## (c) Global, persistent, per-instance orchestration DAG

**Answers:** no single one of the five questions by name — it is the cross-cutting moat
feature, not a Q-numbered item (see [the mapping caveat](#the-five-daily-questions)
above) — but it is what makes "which branch across *all* my recent sessions is doing
the work" answerable at all, something none of the five audited rivals can do (per
[the moat](../guide/the-moat.md)).

**What it is.** The same kind of parent→child graph as §2, except it spans **every**
session for this instance, not just one. `WP-U8`'s Done-when:

> **Global persistent per-instance orchestration DAG view** (the moat). Spans multiple
> sessions, sourced from a query over persisted edges. (`development-plan.md`, `WP-U8`)

**What backs it.** This is precisely the feature [the DAG moat](../architecture/dag-moat.md)
page exists to explain in depth: `orchestration_edges` rows carry a non-null
`instance`/`host_id` column from the very first migration (`WP-D7`'s Done-when; CD-4 in
`concept-analysis-v2.md`), which is what makes a query spanning multiple sessions
possible without a schema change — the same table §2's session-scoped tree reads, just
queried without a `session_id` filter. No other audited project has this: `simple10`'s
tree is session-scoped and event-derived at render time; `hoangsonww`'s
"DAG cockpit" (`OrchestrationDAG.tsx`) is a *type-aggregated* 3–4-layer diagram
reconstructed post-hoc on `SubagentStop`, not a per-instance persisted graph
(`DESIGN.md` §6). agenthropic's version is per-instance (one node per actual agent run,
never collapsed into a "type" category) and persisted (written once, queried many
times) — see [the DAG moat's contrast table](../architecture/dag-moat.md#contrast-with-rivals)
for the full rival-by-rival comparison.

> **Empirical footing.** The persisted, per-instance DAG this view queries is not a
> speculative design bet. The [Phase-0 corpus probe](../../analysis/phase0-probe.md)
> read the real `~/.claude/projects/` corpus and empirically **pre-answered CD-1 as
> `CONDITIONAL-GO` (confidence 85)**: JSONL is a trustworthy, outage-surviving single
> source of truth for the persisted subagent DAG — *provided* the parser keys on the
> `Agent`/`Workflow` spawn tools (not `Task`), walks **both** on-disk layouts (85% of
> agent files are nested), and indexes subagents as parents. That de-risks, but does
> **not** replace, the formal Phase-0 spike; no production code ships before the
> `WP-S7` GO gate.

**How to read it.** Same visual grammar as §2 (nodes = agent instances, edges =
persisted parent→child relationships, node status = working/unknown/done from §1), but
the frame is "everything this Mac Mini has run," not one session. `DESIGN.md` §6 names
the first planned layout improvement for this view once it exists — "ELK/Graphviz
layout over the persisted tree" — as future work with no committed timing, not
something scoped into the current view (`WP-U8` builds the query and the render; the
layout upgrade is separately deferred).

> **As built:** `DagView` reads `GET /api/dag/global` and shares `SessionsView`'s
> layered layout, solid/dashed provenance legend and declared-not-drawn dropped
> edges. The one thing unique to it is **truncation honesty**: the endpoint is capped
> at 1000 nodes, and when the cap bites the view shows a banner with the real
> figures — "Truncated: showing *n* of *N* agents and *m* of *M* edges (node limit
> 1000)" — instead of presenting a partial graph as the whole picture. The
> ELK/Graphviz layout upgrade is still not built.

## (d) Cost / Sankey / delegation-savings

**Answers:** Q2 (which agent/subagent burned the most tokens/cost) and Q4 (today/this
week's cost and Haiku/Sonnet routing savings).

**What it is.** A Sankey-style flow of token spend, plus a delegation-savings figure.
`WP-U9`'s Done-when:

> **Cost / Sankey / delegation-savings view** (daily Q2/Q4). Every displayed dollar
> traces to ground-truth tokens × dated price. (`development-plan.md`, `WP-U9`)

**What backs it.** Every number here is the read-side of the equation
[the cost model](../architecture/cost-model.md) describes in full: `cost = Σ
(tokens_in_bucket × dated_rate_for_bucket)`, computed server-side by `CostEngine` from
`token_usage` (ground-truth, copied verbatim from `~/.claude/projects/*.jsonl`, never
inferred) and `model_pricing` (a dated, versioned table — `effective_from`/
`verified_on` *(As built: the shipped table has `effective_from` only; **no
`verified_on` column was ever created**.)* — never a single hardcoded constant).
Delegation-savings is the same
equation run twice per row and diffed: `Σ max(0, top-tier-equiv − actual)` against
whatever model actually ran (see
[cost model §7](../architecture/cost-model.md#7-delegation-savings-quantifying-haikusonnet-routing)).
A model observed in a fixture with no priced row is a **red build**, never a silent
"estimated" label (`WP-C6`, the staleness-fails-CI gate) *(As built: the enforcement
is at **runtime**, not only in CI — see the box below.)* — so a dollar figure this view
shows is never a guess, and the delegation-savings metric is explicitly tied to the
model-routing decision it's meant to inform, not displayed as a decoration
(`WP-C5`; see [cost model §7](../architecture/cost-model.md#7-delegation-savings-quantifying-haikusonnet-routing)
on the named vanity-metric risk and its mitigation).

**How to read it.** Sankey flow width is proportional to token volume, colored/grouped
by model or bucket (`speed`/`inference_geo`/`service_tier` — DESIGN §4); the
delegation-savings figure sits alongside it as "what routing to a cheaper model already
saved you," re-priced against the top-tier rate that would otherwise have applied.
`DESIGN.md` §6 names `hoangsonww`'s D3 Sankey as the rendering technique worth studying
directly — its *aggregation* shortcut (type-aggregated categories instead of a
per-instance graph) is what agenthropic does not copy for §3's DAG, but the Sankey
rendering idea itself is fair game for this cost view.

> **As built:** `CostView` reads `GET /api/cost/summary` (default top-5 sessions) and
> lays out a `model → all cost → session` sankey with `d3-sankey`. Three things
> differ from, or are more specific than, the text above:
>
> - **Unpriced tokens are their own KPI**, captioned "no price row matched — not
>   counted in $", and an `Unpriced` column appears in the per-model, per-day and
>   top-session tables. That column renders `~ n` or a plain `0` — never a blank
>   cell, which a reader could mistake for "none."
> - **A model with usage but a $0 price is listed in text**, under "Not in the flow
>   (usage but $0 priced)", rather than drawn as a zero-width flow that would be
>   invisible. The same applies to the "other sessions" remainder outside the top-N.
> - **Two different failure modes, not one.** The DB rollups behind this view never
>   halt: unpriced tokens contribute $0 to the total *and* are surfaced separately.
>   The per-session `GET /api/sessions/:id/cost-analysis` endpoint does the opposite
>   — it raises `PricingError` and returns **HTTP 422** rather than serve a figure it
>   cannot justify, and its delegation-savings number carries an explicit
>   `isEstimate: true`. The seeded rates themselves are still **PROVISIONAL and
>   unratified** (`apps/server/src/db/migrations.ts`), so treat the dollar amounts as
>   correctly-computed from numbers that have not yet been signed off.

## Auth & realtime: the SPA loads only behind the token gate

The dashboard is not a public page with a login screen bolted on — it renders **nothing**
without the token. `WP-U5`'s Done-when states this as the shell's own contract:

> **React/Vite SPA shell + token auth + resilient SSE client.** Loads only behind the
> token gate; no token → no data/stream. (`development-plan.md`, `WP-U5`)

Two things follow directly from "no token → no data/stream":

- **No unauthenticated read.** Every view above is served by an endpoint `WP-U2` (Read
  API foundation) requires to be timing-safe auth-guarded — "every read route
  auth-guarded (timing-safe)," stricter than treating reads as automatically safe (the
  exact gap `cast`'s unauthenticated GETs left open — see
  [security model, rule 5](../security/model.md#5-no-unauthenticated-endpoints--read-or-write)).
  The token itself is a `DASHBOARD_TOKEN` compared with Node's `timingSafeEqual`, never
  a plain `===`, and the server refuses to start at all if it is unset — never a
  no-op-when-unset fallback (`hoangsonww`'s mistake; see
  [security model, rule 2](../security/model.md#2-auth-token-is-mandatory--timingsafeequal-not-a-no-op-when-unset)).
  A sample env line always uses a placeholder, never a real value:

  ```
  DASHBOARD_TOKEN=<token>
  ```

- **Realtime is SSE, not WebSocket, and it is "resilient."** The transport decision is
  already settled (CD-5, `concept-analysis-v2.md`): a server→browser-only feed, so SSE
  — which auto-reconnects and needs no same-origin WS handshake — was chosen over
  WebSocket, and `DESIGN.md` §8's older "WebSocket" wording is superseded by that later,
  canonical decision (see [architecture overview, transport](../architecture/overview.md#transport-sse-not-websocket)).
  `WP-U1` (`RealtimeHub` SSE endpoint) is done-when "a cross-origin `Origin` on
  `/api/stream` is rejected; no wildcard CORS" — the same-origin enforcement is a
  contract test, not a convention (`WP-F7`). "Resilient" in `WP-U5`'s framing and the
  Phase 4 "what ships" wording ("served over a resilient, reconnecting stream" —
  `docs/site/guide/roadmap.md#phase-4--read-api-the-dashboard-and-the-five-daily-questions`)
  means the client reconnects the SSE feed on its own after a drop; the exact reconnect
  backoff mechanics are not specified anywhere in the source docs and are treated here
  as _(planned)_, not fixed.

> **As built:** the token gate and the SSE client both exist, with two specifics the
> design text left open and one requirement that is **not met as stated**:
>
> - The SPA holds the token in **`sessionStorage` only** — never `localStorage`,
>   never a cookie, never logged and never rendered (`apps/web/src/token.ts`). It
>   travels as a `Bearer` header on API calls; the `?token=` query form is used
>   **only** on `/api/stream`, because `EventSource` cannot set headers, and the
>   server's log serializer strips it.
> - The client exposes four connection states — `connecting → open → reconnecting →
>   closed` — surfaced in the header chip. Malformed frames are dropped silently
>   rather than crashing the view, and only two typed server frames exist:
>   `session-ingested` and `agent-status-changed`.
> - **"Resilient" resolved to the browser's built-in `EventSource` reconnect**, hinted
>   by a server-sent `retry:` field — there is no custom backoff schedule, and there
>   is **no replay**: a reconnect re-subscribes to the live feed, it does not
>   redeliver frames missed while disconnected. `WP-U5`'s "resumable" wording is
>   therefore not satisfied in the literal sense; the views compensate by refetching
>   their snapshot on reconnect.

Full endpoint and stream reference (routes, payload shapes, reconnection semantics)
belongs on [the API reference](api.md) once it is written — that page is Phase 4 work
exactly like this one, and is still a stub as of this writing. *(As built:
[the API reference](api.md) is written and documents the ten real routes.)*

## Access: reached only through a tunnel

The dashboard is never reachable at a routable address, from a phone, a second laptop,
or anywhere off the Mac Mini itself, except through an SSH local port-forward or a
Tailscale tunnel terminating at the loopback socket — the bind stays `127.0.0.1`
regardless of which carrier you use, and the mandatory token check applies identically
whether the request originated at the Mac Mini's own keyboard or arrived over either
tunnel (`DESIGN.md` §8; see [remote access](../security/remote-access.md) for the
step-by-step setup of both options, and [security model](../security/model.md) for why
a reverse proxy to the open port is never an acceptable substitute).

## What's undecided

This is a design-basis page, not a shipped-system page — stated plainly rather than
glossed over. *(As built: four of these five are now settled; each carries its
resolution inline.)*

- **The exact route shapes and payloads** for every endpoint behind these four views
  (`GET /sessions/:id/tree` and similar names above are `WP-U3`'s own illustrative
  naming in its Done-when text, not a confirmed, frozen API surface) — the authoritative
  reference is [the API reference](api.md), a Phase 4 deliverable not yet written.
  *(As built: **resolved.** The routes are real, `/api`-prefixed, TypeBox-schema'd with
  `additionalProperties: false`, and documented on [the API reference](api.md).)*
- **The `agents.status` enumeration mismatch** between `DESIGN.md` §4's original sketch
  (`working`/`waiting`/`completed`/`error`) and the later `working`/`unknown`/`done`
  framing `WP-U6`/`WP-IN12` build the live status board to — see §1 above. The concrete
  migration DDL that resolves this is `WP-D4`'s deliverable, not yet written.
  *(As built: **resolved** as the union — five values,
  `working | waiting | completed | error | unknown` — plus a distinct `null` =
  "unrecorded" state that is deliberately not merged into `unknown`.)*
- **The SSE reconnect/backoff mechanics** behind "resilient" (`WP-U5`) are named as a
  requirement, not yet specified in detail. *(As built: **resolved by choosing the
  minimum** — `EventSource`'s own reconnect plus a server `retry:` hint. No custom
  backoff, and no replay of frames missed while disconnected.)*
- **The exact D3 layout** for the global DAG (§3) beyond "queried from persisted
  edges" — `DESIGN.md` §6 names ELK/Graphviz as the first extension "when needed," with
  no committed timing or library choice. *(As built: **still open.** The DAG ships on a
  hand-written deterministic layered layout; ELK/Graphviz was not adopted and has no
  committed timing.)*
- **Stack and repo structure** — React/Vite/D3, a pnpm monorepo, and the exact package
  names implied by paths like `apps/web` throughout this page are leanings per
  `DESIGN.md` §10, not locked decisions. *(As built: **locked.** pnpm monorepo with
  `apps/server`, `apps/web`, `packages/shared`, `packages/core`,
  `packages/test-fixtures`, `hooks/`; React + Vite; D3 only via `d3-sankey`, and only
  in the cost view.)*

## See also

- [The DAG moat](../architecture/dag-moat.md) — the persisted `orchestration_edges`
  mechanics behind the session tree (§2) and global DAG (§3) views.
- [Cost model](../architecture/cost-model.md) — the full pricing/bucket/
  delegation-savings design behind the cost/Sankey view (§4).
- [Architecture overview](../architecture/overview.md) — the full ingest loop this
  dashboard is the read side of.
- [The moat](../guide/the-moat.md) — why the global DAG is the one feature no audited
  rival ships, and how it relates to the other four moat items.
- [API reference](api.md) — the endpoint/stream reference this page defers to (stub,
  also Phase 4). *(As built: written, and the accurate source for the ten real routes.)*
- [Security model](../security/model.md) — the full loopback/token/same-origin
  catalogue every view and endpoint above inherits.
- [Remote access](../security/remote-access.md) — SSH/Tailscale tunnel setup for
  reaching the dashboard off the Mac Mini.
- [Roadmap](../guide/roadmap.md) — Phase 4's exit gate and where it sits relative to
  Phase 3's DAG/cost work and Phase 5's alerting.
