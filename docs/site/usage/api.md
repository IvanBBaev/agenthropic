# API reference

> **How to read this page.** The read API and the realtime SSE feed are **built and
> running**; the sections below describe what `apps/server/src` actually serves. The page
> was first written before any code existed, as a design target derived from the design
> basis (docs/ai/DESIGN.md) and the build plan (docs/analysis/development-plan.md), so it
> still carries that older narrative underneath — every design-era table is kept as the
> record, with an `As built` note wherever the shipped system settled a question the
> design left open. Markings such as _(planned)_ and _(leaning — unconfirmed)_ belong to
> that record and no longer describe the current system. The **security invariants were
> binding then and remain binding now.**

> **Update — 2026-07 (as built).** The read API is built. This page was written before any
> code existed, so the "no application code is built yet" framing above and every
> _(planned shape — exact path undecided)_ marking below are out of date. What actually
> ships in `apps/server/src`:
>
> - **Ten routes, all under `/api/`, all behind the one auth gate.** Nine `GET`
>   (`/api/health`, `/api/stream`, `/api/sessions`, `/api/sessions/:id`,
>   `/api/sessions/:id/tree`, `/api/sessions/:id/events`,
>   `/api/sessions/:id/cost-analysis`, `/api/cost/summary`, `/api/dag/global`) and one
>   `POST` (`/api/hooks/event`, the hook liveness receiver). Note the `/api` prefix — the
>   design-era table below writes the tree route as `GET /sessions/:id/tree`; the real
>   path is `/api/sessions/:id/tree`.
> - **The gate is registered before any route** and authorizes on the *routed* path
>   (`request.routeOptions.url`), not the raw URL, because the router percent-decodes and
>   a raw-prefix check would let `/%61pi/health` through. Loopback bind, timing-safe
>   token compare and the stream's same-origin check are all as designed and binding.
> - **Every route carries TypeBox response schemas with `additionalProperties: false`,**
>   a uniform `{ "error": "…" }` shape on every non-2xx, and capped limit/offset
>   pagination on everything unbounded (`limit` ≤ 200, `offset` ≤ 1000000, `topN` ≤ 50,
>   DAG `limit` ≤ 5000).
> - **There is no write surface beyond the hook receiver.** The alerts CRUD described in
>   [Operator alerts API](#operator-alerts-api-wp-a8-phase-6) below was **cut** — see the
>   note in that section.
> - **The stream carries three typed event types, not generic projection deltas:**
>   `session-ingested`, `agent-status-changed` and `ingest-failed` (the third
>   documented 2026-08, when the SPA gained a listener for it — a quarantined session
>   is now a visible banner, not a silent absence). Resumability is **not** implemented
>   as replay — see the "Resumability" note in the realtime-feed section below.
>
> The design-era prose and tables are kept below as the record, with `As built` notes
> where the shipped system settled a question the page left open.

This page covers the two things a client of agenthropic ever talks to: a set of
authenticated HTTP **read** endpoints over the projected SQLite state, and one
authenticated **realtime push** endpoint, `/api/stream`, that fans out projection
deltas over server-sent events. The key takeaway: every endpoint — read, write, and the
stream — sits behind the same mandatory, timing-safe `DASHBOARD_TOKEN` gate and the same
loopback-only bind; the realtime transport is **SSE, not WebSocket** (CD-5); and nothing
this API returns is inferred — every token is copied verbatim from
`~/.claude/projects/*.jsonl`, every dollar is that ground-truth token count times a
dated `model_pricing` row, and the subagent tree is served by a query over the
persisted `orchestration_edges` table, never reconstructed from raw events at request
time.

## Transport & auth preamble

Three rules apply uniformly to **every** route below, read or write, and are restated
here rather than per-endpoint because there is no exception anywhere in the design:

1. **Loopback-only.** The Fastify server (`apps/server`, `WP-U0`) binds `127.0.0.1`
   exclusively — a loopback-or-fail listen call, never `0.0.0.0`, not even behind a
   flag. See [security model, rule 1](../security/model.md#1-bind-loopback-only-127001-never-0000).
2. **Mandatory `timingSafeEqual` token, on every route.** `WP-U2` (Read API foundation)
   states its Done-when as "every read route auth-guarded (timing-safe)" — deliberately
   stricter than DESIGN §8's original "no unauthenticated *write* endpoints" wording,
   closing the exact gap `cast`'s unauthenticated GETs left open. `WP-A8` (operator
   alerts CRUD) carries the identical requirement for the write surface: "all write
   endpoints token-guarded, cross-origin rejected." There is no unauthenticated route in
   this design, full stop — see [security model, rules 2 and 5](../security/model.md#2-auth-token-is-mandatory--timingsafeequal-not-a-no-op-when-unset).
   The server refuses to start at all if `DASHBOARD_TOKEN` is unset; it never falls back
   to "no auth needed."
3. **SSE, same-origin, no wildcard CORS — not WebSocket.** CD-5 in
   `docs/analysis/concept-analysis-v2.md` settles the realtime transport as SSE
   ("server→browser-only feed; revisit WebSocket only if bidirectional control is ever
   needed — it is not"). DESIGN §8's older wording still says "WebSocket"; that wording
   is superseded, and this page — like the [security model](../security/model.md#4-same-origin-check-on-the-realtime-channel)
   — follows the later, canonical decision. A cross-origin `Origin` header on the stream
   is rejected outright; the server never emits a wildcard `Access-Control-Allow-Origin`.

```
                    every request, read or write, passes through:

  client ──▶ [ same-origin check ] ──▶ [ timingSafeEqual(DASHBOARD_TOKEN) ] ──▶ route
                (stream only)              (all routes, no exceptions)
                                                    │
                       ┌────────────────────────────┼───────────────────────────┐
                       ▼                             ▼                           ▼
              read endpoints                  /api/stream (SSE)          alerts CRUD
              (WP-U2 … U4)                    (WP-U1)                    (WP-A8, write)
```

*(As built: the diagram's third branch never happened — the alerts CRUD surface was cut.
The only write route is `POST /api/hooks/event`, which crosses the identical gate.)*

There is no route in this design — present or planned — that is reachable without
crossing both checks that apply to it. See the [security model](../security/model.md)
for the full nine-rule catalogue this API sits inside, and
[configuration](configuration.md) for how `DASHBOARD_TOKEN` itself is supplied to the
running server.

## Liveness and ingest visibility — `GET /api/health`

`/api/health` is auth-gated like everything else — there is no unauthenticated probe
path — and it answers `200` with a payload whose schema declares two required fields and
four optional ones:

| Field | Type | Always present? | Meaning |
|---|---|---|---|
| `status` | the literal `"ok"` | yes | The process is serving. It stays `"ok"` even while ingest is still replaying: a warming server is healthy, just not yet current. |
| `schemaVersion` | integer | yes | The migration version the open database is at. |
| `ingestSkips` | object of `{ reason: count }` | no | Cumulative count per skip reason since boot. |
| `ingest` | `"replaying"` or `"idle"` | no | `"replaying"` between the loopback bind and the end of the startup replay pass; `"idle"` after. |
| `lastTickDurationMs` | number | no | Wall-clock duration of the **last completed** corpus pass. |
| `crossSessionUsageCollisions` | integer | no | Usage messages skipped since boot because another session had already claimed them. |

**An absent field is never a zero, and that distinction is the point of the endpoint.**
Each optional field is backed by a seam the composition root wires in only when ingest is
running. When the seam is absent — a server built without ingest wiring — the field is
omitted. When the seam is present but has nothing to report yet (no corpus pass has
finished), the field is *also* omitted, because a `lastTickDurationMs` of `0` would read
as "the poll is instantaneous", which is the wrong fact rather than a missing one. The
handler's own comment states the rule: *"No pass yet" and "no seam" both OMIT the field —
never a fake number.* `crossSessionUsageCollisions` is the one case where a present seam
does report a genuine `0`: zero collisions is a measured result, not an absence.

**Why skips are on the health payload at all.** A skipped corpus file freezes that
session's dollar totals — the transcript that would have advanced them was never read.
That consequence is invisible in the dashboard views, so the running total is surfaced
where an operator can see it without log access. Eight reasons exist, and they are the
complete set:

| Skip reason | What it means |
|---|---|
| `oversize` | The file exceeded the per-file read cap and was deliberately not read. |
| `symlink` | The entry is a symlink; the walk never follows one out of the corpus root. |
| `not-regular-file` | Not a regular file (directory, socket, device). |
| `unreadable` | An I/O error (`ENOENT`, `EACCES`, …) on this file. |
| `empty-agent` | A subagent artifact with no usable records. |
| `empty-main` | A main transcript with no usable records. |
| `non-artifact` | A file under a session directory that is not a transcript artifact. |
| `duplicate-session` | The same session id was discovered under two project slugs. |

`duplicate-session` deserves its own note. When one session id appears under two slugs the
tiebreak keeps the **lexicographically smallest slug** — deterministic by construction, so
two runs over the same corpus agree, rather than mtime-based, which would make ingest
racy. The losing copy is **counted here, not dropped silently**: the number is how you
find out the corpus contains a duplicate at all. The rule itself is PROVISIONAL
(LABEL-ME) and awaits ratification.

## The realtime feed — `/api/stream`

`/api/stream` is the one concrete path the sources name explicitly (`WP-U1`,
`RealtimeHub SSE endpoint`). Every other path in this page is a planned shape, not a
literal one — see the [Read endpoints](#read-endpoints) table below. *(As built: every
path is now literal — see the table's "As built" column.)*

> **As built:** `/api/stream` is a hijacked Fastify reply that writes a `retry: <ms>`
> field, a `: connected` comment, then hub frames, with a `: heartbeat` comment every
> 15 s. Heartbeats are SSE **comment** frames and therefore never surface to
> `EventSource` — client liveness is the connection state, not a heartbeat count. Three
> typed frames are emitted: `session-ingested`, `agent-status-changed` and
> `ingest-failed` (update 2026-08: this page previously said two — the third frame was
> already published but undocumented, and the SPA did not listen for it). The frame-type
> list is a single shared constant (`SERVER_EVENT_TYPES` in `packages/shared`) imported
> by both the server bridge and the SPA's SSE client, because `EventSource` silently
> drops a named event with no registered listener. The token may
> be presented as `?token=` here (and only here) because `EventSource` cannot set
> headers; the server's request-log serializer redacts it. The same-origin check runs
> **before** the token check, so a foreign `Origin` gets 403 whether or not it holds a
> valid token.

| Property | Value | Source |
|---|---|---|
| Transport | Server-sent events (SSE) — one long-lived HTTP response, server→browser only | CD-5; security model rule 4 |
| Path | `/api/stream` (fixed) | `WP-U1` Done-when |
| Direction | Server → browser only; no client-to-server control channel over this connection | CD-5 ("revisit WebSocket only if bidirectional control is ever needed — it is not") |
| Auth | Same mandatory `timingSafeEqual(DASHBOARD_TOKEN)` gate as every other route | `WP-U2`, security model rule 2 |
| Origin check | Same-origin only; a cross-origin `Origin` header is rejected; no wildcard CORS | `WP-U1` Done-when: "a cross-origin `Origin` on `/api/stream` is rejected; no wildcard CORS" |
| Resumability | Resumable — the connection can pick back up after a drop | `WP-U1`: "server→browser, same-origin, auth-gated, **resumable**" |
| What it pushes | Deltas from the projection layer (new/changed `sessions`, `agents`, `orchestration_edges`, `token_usage` rows) | `docs/analysis/development-plan.md` §7: "`WP-U1` needs a projection change-notifier that only exists after `WP-IN7`" |

*As built, the last two rows resolved differently:*

| Property | As built |
|---|---|
| Resumability | **Reconnect, not replay.** The server sends a `retry:` hint and the browser's `EventSource` auto-reconnects; there is no `Last-Event-ID` handling and no `events_raw.seq` replay. Frames emitted while a client was disconnected are **lost**. The SPA compensates by treating any stream event as a cue to refetch persisted truth, so the displayed state re-converges — but a client that needs a gapless event log must read `GET /api/sessions/:id/events`, not the stream. |
| What it pushes | Three typed frames only — `session-ingested` (a session was persisted; refetch), `agent-status-changed` (one agent moved between status buckets, including into `unknown` via the missing-Stop watchdog), and `ingest-failed` (a session's ingest failed; rides the shared union's generic arm as `{ "type": "ingest-failed", "payload": { sessionId, reason, attempt, willRetry, occurredAt } }` with a sanitized, single-line, path-free reason — the SPA renders it as a dismissible banner on the live board, because a quarantined session never reaches the read API and would otherwise be invisible). Not a generic row-delta feed over `sessions`/`agents`/`orchestration_edges`/`token_usage`. |

**The event-push model.** `/api/stream` is a fan-out off already-committed projection
state, not a raw firehose of `events_raw` — the same "single-writer pipeline, read-only
fan-out" shape the [architecture overview](../architecture/overview.md) describes for
every read path (API, realtime hub, webhook sink alike). Practically, this means a
client never has to reconcile "hook value or JSONL value" itself: by the time a delta
reaches `/api/stream`, the projection has already applied CD-2's per-field precedence
rule once, at projection time — the stream only ever announces the settled result. The
build-plan notes name a sequencing detail worth carrying into any client implementation:
`WP-U1` is built first against an in-memory change-notifier fake (Phase 1) and rewired
to the real projection emitter only once `WP-IN7` (the projection) lands in Phase 3 —
so the wire *shape* of a pushed delta is fixed early, but the events it can actually
carry only become meaningful once Phase 3's projection exists.

**Same-origin rejection, concretely.** A request to `/api/stream` whose `Origin` header
does not match the dashboard's own origin is rejected before the connection is ever
promoted to a stream — this is the same `shared/security` origin-check primitive
`WP-F7` builds and unit-tests, wired into the bootstrap by `WP-U0`, and it is what stops
an unrelated tab you merely have open from silently attaching to your live feed even if
it somehow obtained or guessed the token (security model rule 4). There is no
same-origin exemption for a valid token presented cross-origin — both checks apply.

**Resumability, as a design constraint, not yet a mechanism.** `WP-U1`'s Done-when names
"resumable" as a requirement but the sources do not fix *how* — e.g., a `Last-Event-ID`
replay against `events_raw.seq` (which `WP-IN2`'s `readSince()` already supports for
replay-on-startup) is a plausible shape given the schema, but no source states this as
the literal mechanism. Treat resumability as a fixed requirement and its exact protocol
as _(planned)_.

> **As built:** the mechanism chosen was **browser auto-reconnect, not replay**. The
> server emits a `retry:` hint and nothing else; no `Last-Event-ID` is read or honoured,
> and no `events_raw.seq` cursor is exposed on the stream. That is a real gap against
> `WP-U1`'s "resumable" wording and is recorded here rather than papered over: a client
> that drops the connection misses the frames sent in the interim. The SPA's answer is
> to refetch from the read API on reconnect, which restores correct *state* but not the
> missed *event sequence*.

## Read endpoints

Every row below other than `/api/stream` (above) and `GET /sessions/:id/tree` is a
**_(planned shape — exact path undecided)_** — the sources fix the resource, the backing
data, and the owning work package, but not a literal REST path. Do not treat any path
other than those two as decided.

*(The paths are all decided now. The design-era table is kept below; the "As built"
column names the route that actually shipped.)*

| Resource | Purpose | Backing data | Source WP | As built |
|---|---|---|---|---|
| `GET /sessions/:id/tree` | The session-scoped subagent tree (daily Q1/Q3/Q5) | Query over `orchestration_edges`, joined to `agents` | `WP-U3` — fixed path: "`GET /sessions/:id/tree` built from a query over `orchestration_edges` (proven, not reconstruction)" | `GET /api/sessions/:id/tree` — note the `/api` prefix |
| Sessions & agents _(planned shape)_ | List/get sessions and their agents, including per-agent `status` (`working`/`waiting`/`completed`/`error`) | `sessions`, `agents` projection tables | `WP-U3` | `GET /api/sessions?limit&offset` (returns `{sessions,total,limit,offset}`) and `GET /api/sessions/:id`. The status enumeration gained a **fifth** value, `unknown` — see below |
| Cost & delegation-savings _(planned shape)_ | Per-session/agent dollar cost and the Haiku/Sonnet-routing delegation-savings figure (daily Q2/Q4) | `token_usage` × `model_pricing`, via `CostEngine` (`WP-C3`), delegation-savings via `WP-C5` | `WP-U4` | Split in two: `GET /api/cost/summary?topN` (DB rollup: totals, per-model, per-day, top sessions) and `GET /api/sessions/:id/cost-analysis?topTierModel` (compaction-aware cost + delegation savings, computed from the JSONL substrate) |
| Global orchestration DAG _(planned shape)_ | The cross-session, per-instance persisted DAG (the moat view) | Query over `orchestration_edges` across sessions, keyed by `instance`/`host_id` | `WP-U4`; see [the DAG moat](../architecture/dag-moat.md) | `GET /api/dag/global?limit` — returns nodes, edges and a `counts` block whose `truncated` flag the client must surface |
| Token usage _(planned shape)_ | Fine-grained ground-truth token buckets (`speed`/`inference_geo`/`service_tier`), including PreCompact baselines | `token_usage` | `WP-U3`/`WP-U4`, backed by `WP-D8` | **No dedicated endpoint.** Token figures are served folded into the session, tree, DAG and cost responses (`totalTokens`, `costUsd`, `unpricedTokens`); there is no route that returns raw `token_usage` rows or per-bucket breakdowns |
| Events _(planned shape)_ | Read access to normalized `events` (and, where exposed, `events_raw`) for a session/agent | `events`, `events_raw` | Implied by `WP-U2`'s Read API foundation over the projection; no dedicated WP names an events-listing endpoint explicitly | `GET /api/sessions/:id/events?limit&offset` (WP-D5). Serves the normalized `events` table only — `events_raw` is never exposed |

Every route in this table — fixed or planned — is TypeBox-contract-validated and shares
one auth guard implementation: `WP-U2` (Read API foundation) is explicitly "a Fastify
plugin, TypeBox contracts, auth guard, shared DTOs," so no individual route author can
forget to wrap a new endpoint in the gate. *(As built: this held — the gate is a single
`onRequest` hook on the whole app, and the route plugin is registered inside its scope,
so a new route is gated by construction rather than by remembering.)*

### As-built details worth knowing before you call these

- **`GET /api/sessions/:id/events` never conflates "no events" with "no session".** A
  known session with zero hook events is `200` with an empty array; only an unknown
  session id is `404`. Rows are oldest-first with `id` as tiebreak and carry a `total`
  so truncation stays visible.
- **Those event rows are hook *liveness* only.** They are not the DAG, they never
  influence `agents` / `orchestration_edges` / `token_usage`, and their **absence means
  nothing** about whether an agent ran — hooks are a best-effort secondary channel and
  JSONL transcripts are ground truth. Only identifiers are projected into `events`,
  never payload content.
- **Event timestamps are receipt time.** The hook envelope carries no event-originated
  timestamp, so every row reports `occurredAtSource: "receipt"` — the DTO says so on
  every row rather than letting a reader assume the time is when the thing happened.
- **`GET /api/sessions/:id/cost-analysis` distinguishes six different ways to fail, and
  the distinctions are the product** — see [the failure table](#the-six-answers-of-the-cost-analysis-endpoint)
  below. Corpus paths and offending lines are never echoed to the client.
- **The `agents.status` enumeration is five values:** `working`, `waiting`, `completed`,
  `error`, `unknown`. `unknown` is what the missing-Stop watchdog assigns and is a
  first-class bucket in every rollup, not an error state to be hidden.
- **A `NULL` status is folded into `unknown` by the API.** The status-count queries
  bucket a row whose `agents.status` column is `NULL` together with the explicit
  `unknown` rows, because an absent status *is* unknown and putting it anywhere else —
  or nowhere — would fake certainty the database does not have. The SPA on the other side
  of the wire draws a per-agent `NULL` as its own `· unrecorded` marker, since at the
  level of one named agent "never recorded" and "watchdog gave up" are worth telling
  apart. Both treatments are deliberate; neither invents a value.
- **Pagination caps are contract, not convention:** `limit` default 50 / max 200,
  `offset` max 1000000, `topN` default 5 / max 50, DAG `limit` default 1000 / max 5000.
  Exceeding one is a `400` with the uniform `{ "error": … }` body, not a clamp.

### The six answers of the cost-analysis endpoint

`GET /api/sessions/:id/cost-analysis` is the only route that reads the JSONL substrate
live rather than the projected tables, so it has more ways to come up empty than any
other — and it answers each one differently, on purpose:

| Status | Body `error` | When |
|---|---|---|
| `503` | `corpus access is not configured` | No corpus provider was wired at all (a DB-only deployment). The server does not guess where transcripts live. |
| `503` | `no corpus root is present on this machine, so nothing can be analysed` | The provider exists but there is no corpus root here. Retryable: the root is re-resolved per call, so a corpus that appears later fixes this without a restart. |
| `503` | `the corpus root exists but could not be read; retry shortly` | The root is there; this process could not read it on this attempt. Also retryable, and deliberately a different sentence from the one above. |
| `404` | `Session not found.` | The corpus was read and this session id is genuinely not in it. |
| `422` | `Session transcripts could not be parsed.` | A poisoned transcript — a data problem, not a server bug. |
| `422` | `the session transcript holds no analysable records` | The session was found and read, and holds nothing to analyse. |

A seventh shape shares the `422` status: an unpriced model raises `PricingError`, and its
message (model and message ids only, never a path) is returned verbatim. The route's
declared schema additionally covers `400` for a malformed request and a detail-free `500`
for anything unexpected.

The reason this table is six rows rather than one is written into the route itself: these
cases used to share a single `404 Session not found.`, which the code comment records as
*"untrue in most cases"*. With no corpus root — or one that cannot be read — nothing in
the process knows whether the session exists, so answering `404` would be stating a fact
the server has not established. The three `503`s say "this server cannot answer right
now" and invite a retry; the `404` says "the answer is no" and means it.

### Response payloads, field by field

The TypeBox schemas in `packages/shared/src/schemas` are the contract — every response
sets `additionalProperties: false`, so a field not listed here cannot appear.

**`GET /api/sessions`** → `{ sessions, total, limit, offset }`. Each session summary is
`id`, `projectSlug`, `status`, `startedAt`, `lastActivityAt` (the last four nullable),
`agentCount`, `totalTokens`, `totalCostUsd`, `unpricedTokens`, and `statusCounts` — an
object carrying **all five** buckets (`working`, `waiting`, `completed`, `error`,
`unknown`) every time, so a bucket at zero is a stated zero rather than a gap the client
has to interpret.

**`GET /api/sessions/:id`** → the same summary shape plus `edgeCount` and `models`, a
per-model array of `{ model, tokens, costUsd, unpricedTokens }`.

**`GET /api/sessions/:id/tree`** → `{ sessionId, agents, edges, agentCount, edgeCount,
unattributed }`. Each agent node carries `id`, `sessionId`, `type`, `subagentType`,
`status`, `parentAgentId`, `firstSeenAt`, `lastSeenAt`, `totalTokens`, `costUsd`,
`unpricedTokens`. Each edge carries `id`, `sessionId`, `parentAgentId`, `childAgentId`,
`source`, `instance`, `hostId`, `createdAt`. **`unattributed` is always present** —
`{ totalTokens, costUsd, unpricedTokens }` for usage that resolves to no materialized
agent row. It is rendered even when it is all zeros, because the alternative is tokens
that exist in the database and appear nowhere in the tree.

**`GET /api/sessions/:id/events`** → `{ sessionId, events, total, limit, offset }`, each
event `{ id, rawEventId, agentId, eventType, occurredAt, occurredAtSource }`.
`occurredAtSource` is a union with exactly one member today, `"receipt"`. A one-member
union looks redundant and is not: the hook envelope carries no event-originated
timestamp, so every row's time is when the *server received* it, and the field says so on
every row instead of letting a reader assume it is when the thing happened. If a true
event time is ever wired, the union widens and old rows stay honestly labelled.

**`GET /api/cost/summary`** → `{ totals, perModel, perDay, topSessions }`. `perDay` uses
`YYYY-MM-DD` keys, with the literal string `"unknown"` for usage rows that carry no
timestamp — again a named bucket rather than a silent omission.

**`GET /api/sessions/:id/cost-analysis`** → `{ compaction, delegationSavings }`.
`compaction` is `{ naiveUsd, repricedUsd, deltaUsd, compactionCount, segments }`; a
materially nonzero `deltaUsd` is a mispricing signal and is served as-is rather than
averaged away. `delegationSavings` is `{ actualUsd, hypotheticalUsd, savingsUsd,
perAgent, skippedAgentIds, isEstimate }` where **`isEstimate` is the literal `true`** —
not a boolean that might be false. The counterfactual cache profile is not observable, so
the schema makes it impossible to serialize this figure without the label. `skippedAgentIds`
lists subagents with no resolvable top-tier model: excluded from the estimate and named,
because a guess would be worse than a gap.

**`GET /api/dag/global`** → `{ nodes, edges, counts }`, where `counts` is
`{ totalSessions, totalAgents, totalEdges, returnedAgents, returnedEdges, truncated }`.
Returned-versus-total is reported separately, and `truncated` flips when the node cap cut
the response short — a client that renders the DAG without surfacing that flag is showing
a partial graph as if it were the whole one.

### No API-side inference — ever

Two guarantees hold for every figure this API can ever return, and neither is a
runtime best-effort:

- **Tokens are ground truth, never inferred.** Every `token_usage` row the API surfaces
  was copied verbatim from `~/.claude/projects/*.jsonl` at projection time (`WP-IN5`);
  the API layer performs no estimation, rounding-up, or backfilling of its own. `WP-U4`'s
  Done-when states this precisely for the cost endpoints: "cost matches JSONL × versioned
  pricing; no API-side inference."
- **Cost is tokens × a dated price, computed once, upstream of the API.** `PricingProvider`
  (`WP-C2`) resolves the price that was live at each event's timestamp against
  `model_pricing.effective_from`; `CostEngine` (`WP-C3`) then multiplies ground-truth
  tokens by that resolved price. The API's cost endpoints only ever surface a figure
  `CostEngine` already computed — `WP-C7`'s Done-when is literally "figures match direct
  engine calls (no drift)." A model+bucket combination with no priced row is a **build
  failure** (`WP-C6`'s staleness gate), never a silent runtime "estimated" label — see
  [the cost model](../architecture/cost-model.md).

> **As built:** the no-inference guarantee holds, and an unpriced model is never costed
> at `$0` — but the *shape* of the refusal differs by endpoint, and a client must handle
> both:
>
> - **DB rollups** (`/api/sessions`, `/api/sessions/:id`, `/api/sessions/:id/tree`,
>   `/api/cost/summary`, `/api/dag/global`) resolve each `token_usage` row against the
>   newest `model_pricing` row with `effective_from <= occurred_at` for that exact
>   `(model, bucket)`. Rows with no resolvable rate contribute `$0` to `costUsd` **and
>   are counted separately in `unpricedTokens`**, which appears on every one of those
>   payloads. The dollar figure is therefore always "cost of what could be priced", and
>   `unpricedTokens` is the declared size of what could not. A client that renders
>   `costUsd` without `unpricedTokens` is misreporting.
> - **`/api/sessions/:id/cost-analysis`** does not degrade: it throws `PricingError` and
>   answers `422` naming the model. The compaction and delegation-savings figures are
>   all-or-nothing by design, and `delegationSavings` carries `isEstimate: true` in the
>   DTO so the hypothetical can never be read as a measurement.

### The tree is a query, not a reconstruction

`GET /sessions/:id/tree` (`WP-U3`) and the global DAG endpoint (`WP-U4`) both read from
`orchestration_edges` — the persisted, dual-path-derived table that is the moat artifact
itself (see [the data model](../architecture/data-model.md)). Neither endpoint walks
raw events or recomputes parent→child relationships at request time; the Phase 4 exit
gate in the roadmap states this as a release-blocking property: "the tree and global DAG views are
proven to come from a query over the persisted `orchestration_edges` table, not a
reconstruction done in the browser from raw events." This is also why a session's tree
survives a missing `SubagentStart` hook — the edge may have been derived from the JSONL
`Agent`/`Workflow` spawn-chain path instead (`WP-IN8` — the spawn tool is
`Agent`/`Workflow`, never `Task`) — the API has no way to tell, or need to care, which
of the two derivation paths produced a given row, because both write into the same
idempotent table before the API ever queries it.

> **As built:** the query-not-reconstruction property held, and the API does serve
> `orchestration_edges` verbatim. Two corrections to the paragraph above:
>
> - **There is no `SubagentStart` hook.** It does not exist in Claude Code. The shipped
>   installer registers four hooks (`UserPromptSubmit`, `Stop`, `SubagentStop`,
>   `PreCompact`) and **no hook ever asserts a parent→child edge**. The DAG is built
>   entirely from the JSONL transcripts; a session's tree does not merely "survive"
>   missing hooks, it never depended on them.
> - **The API does tell you which derivation path produced a row.** Every edge carries a
>   `source` of `tool_use` (observed) or `directory` / `task_notification` /
>   `queue_operation` / `legacy_explore` (inferred), and the SPA is required to draw
>   observed edges solid and inferred edges dashed behind a permanent legend. Provenance
>   is served, not flattened.

**The fifth source, and why it is named separately.** `legacy_explore` is a heuristic
join for pre-2.1.71 bare-`Explore` sidecars (parser-spec gate #7), added in migration 13.
It is the weakest provenance the table can hold: where the other three inferred sources
follow a structural join path, this one matches on a name. It gets its own member of the
union rather than being folded into `tool_use` precisely because collapsing it would
present a name-based guess as an observed spawn — the schema comment says so in as many
words. Treat it as PROVISIONAL: it has **never been observed in the real corpus** and
exists in the test corpus only as the synthetic `legacy-bare-explore` fixture. A client
that renders edges should give it the inferred treatment, not the observed one.

## The hook receiver — `POST /api/hooks/event`

This is the only write route the server exposes, and it crosses the same auth gate as
every read route. It accepts one Claude Code hook envelope and appends it to the
append-only `events_raw` substrate.

- **Path:** `POST /api/hooks/event`.
- **Optional header `X-Agenthropic-Delivery-Id`,** capped at 200 characters by the route
  schema. It names one *firing* of one hook, so the receiver can tell a retry of the same
  firing (deduplicate) from the same hook firing twice (two real events). The installer
  never bakes a value into the settings file: the generated command computes it at fire
  time.
- **A repeated or empty header counts as absent.** If the header arrives twice it arrives
  as an array, and the route treats that as no delivery id at all rather than picking one
  — an ambiguous id names no firing, and guessing which one it meant would be worse than
  admitting it is unknown.
- **`202` with `{ "stored": boolean }`.** `stored: false` is a success: it means this
  delivery was already seen and the append deduplicated it.
- **Errors use the same uniform `{ "error": … }` shape** — `400` for a malformed envelope
  or an over-long delivery id, `500` (detail-free, raw error to the log only) if the
  append itself fails. The `400` deliberately does not echo the offending value back.
- **The liveness callback runs even when the append deduplicated.** A sender retries
  exactly when it cannot know whether the first attempt landed; if the process had
  crashed between a committed append and the status update, a retry that skipped the
  callback would lose that terminal status forever. Re-applying is safe because the seam
  is a guarded no-op when the agent already holds the status, so no duplicate SSE
  transition is published. A *thrown* append still skips it: nothing landed, so there is
  nothing to say.

What this route may do is bounded by CD-1: hooks move **liveness**, never structure. The
callback the composition root supplies is `UPDATE`-only by construction — no hook
delivery has ever created an agent, an edge, or a token-usage row.

## Operator alerts API (`WP-A8`, Phase 6)

> **Update — 2026-07 (as built): this surface was CUT and does not exist.** `WP-A8`
> (operator alerts API) and `WP-A9` (alerts UI) were cut outright, not deferred. There
> is no `alert_rules` table, no `webhook_targets` table, no alerts schema module, no
> alerts route and no alerts view anywhere in the codebase — the only `POST` route the
> server exposes is `/api/hooks/event`. Alerting as a whole is **v2.0 material**, off
> the v1.0 critical path, and v2.0 is entered only through kill checkpoint **KC-5**,
> which requires evidence of real daily v1.0 use before any of it is written. If that
> evidence never appears, this API is never built — and the roadmap counts that as a
> success, not a shortfall. Everything below is the design record for a surface that
> was deliberately abandoned. See [Telegram alerts](telegram.md) for the full v2.0
> gating story.

The alerts CRUD surface is the write side of this API and lands later than the read API
and stream above — Phase 6 (`WP-A8`, `WP-A9`, `WP-A10`) per the
[roadmap](../guide/roadmap.md#phase-6--operator-alerts-ui--release-hardening), not Phase
4. It is documented here for completeness because it shares this page's transport/auth
preamble exactly:

- **Auth-gated CRUD for `alert_rules` and `webhook_targets`.** `WP-A8`'s Done-when: "all
  write endpoints token-guarded, cross-origin rejected" — the identical gate as every
  read route, with no relaxation for being a write path.
- **Never exposes a token.** A `webhook_targets` row holds a `token_ref`, never the
  Telegram bot secret itself (CD-10); the alerts UI built on this API "shows a target by
  name only — never the underlying secret" (roadmap, Phase 6). The secret is resolved
  server-side from a locally-held reference (launchd env / chmod-600) and never appears
  in an API response, in SQLite, on `/api/stream`, or in logs.
- **Cross-origin rejected**, same as the realtime stream — there is no separate,
  looser CORS policy for the alerts surface.

Full rule configuration (cost thresholds, stuck-agent detection, error conditions) and
the Telegram delivery path this API manages are the dedicated subject of
[Telegram alerts](telegram.md), which itself ships with Phase 5's alerting core, one
phase ahead of this CRUD surface. *(As built: neither the Phase 5 alerting core nor
this Phase 6 CRUD surface was built; both are v2.0, KC-5-gated.)*

## What's fixed vs. planned, at a glance

The `Status` column is the design-era assessment. `As built` records what the shipped
code actually does.

| Claim | Status | As built |
|---|---|---|
| Transport is SSE, not WebSocket; `/api/stream` is the path | **Fixed** — CD-5; `WP-U1` | Holds. SSE, `/api/stream`, no WebSocket anywhere |
| Same-origin enforcement, no wildcard CORS, on the stream | **Fixed** — `WP-U1` Done-when | Holds — and the origin check runs *before* the token check, so a foreign origin is 403 even with a valid token |
| Every route (read + write) is `timingSafeEqual`-gated | **Fixed** — `WP-U2`, `WP-A8` Done-when | Holds for every `/api/*` route including `/api/health` and `POST /api/hooks/event`. `WP-A8` was cut, so it contributes nothing |
| Loopback-only bind for the whole server | **Fixed** — `WP-U0`; security model rule 1 | Holds. `HOST = '127.0.0.1'` is an exported constant with no configuration path |
| `GET /sessions/:id/tree` reads `orchestration_edges` | **Fixed path & mechanism** — `WP-U3` Done-when | Mechanism holds; path is `/api/sessions/:id/tree` |
| Stream is resumable | **Fixed requirement**; exact resume protocol _(planned)_ | **Not met as stated.** Browser auto-reconnect only — no `Last-Event-ID`, no replay. Frames sent while disconnected are lost |
| Cost/delegation/global-DAG/token/events endpoint paths | _(planned shape — exact path undecided)_ — `WP-U4`/`WP-U3` name the resource, not the route | All decided: `/api/cost/summary`, `/api/sessions/:id/cost-analysis`, `/api/dag/global`, `/api/sessions/:id/events`. **No token-usage endpoint exists** — token figures are folded into the other payloads |
| Alerts CRUD paths | _(planned shape — exact path undecided)_ — `WP-A8` names the surface, not the route | **Cut.** `WP-A8`/`WP-A9` will not be built on the v1.0 path; v2.0 requires KC-5 |
| Underlying stack (Fastify, TypeBox) | _(leaning — unconfirmed)_ per the project's `CLAUDE.md`; treated here as the working assumption because the sources name it, not because it is locked | Confirmed and shipped: Fastify with `@fastify/type-provider-typebox`, `additionalProperties: false` on every response schema |

## See also

- [Security model](../security/model.md) — the full nine-rule catalogue this API
  inherits in its entirety: loopback bind, mandatory token, no spawner, same-origin
  realtime, no unauthenticated endpoints, no SSRF, tunnel-only remote access,
  `ANTHROPIC_API_KEY` isolation, WAL + tested restore.
- [Data model](../architecture/data-model.md) — the `events_raw` → `events` →
  `sessions`/`agents`/`orchestration_edges`/`token_usage` schema this API reads from.
- [Using the dashboard](dashboard.md) — the SPA built on top of this API and the
  realtime feed. *(As built: shipped, with the four planned views plus an opt-in
  per-session cost-analysis panel.)*
- [Configuration](configuration.md) — how `DASHBOARD_TOKEN` and the server's other
  settings are supplied to the process this API runs inside.
- [Telegram alerts](telegram.md) — the Phase 5 alerting core the Phase 6 alerts API in
  this page manages. *(As built: v2.0 only, KC-5-gated, nothing built.)*
- [Roadmap](../guide/roadmap.md) — Phase 4's exit gate in full, and where the alerts API
  sits relative to it in Phase 6.
