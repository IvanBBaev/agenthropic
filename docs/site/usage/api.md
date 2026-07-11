# API reference

> **Design-target documentation — pre-Phase-0.** This page documents agenthropic's
> *intended* behavior for the read API and the realtime SSE feed, as fixed by the design
> basis (docs/ai/DESIGN.md) and the build plan (docs/analysis/development-plan.md). **No
> application code is built yet** (see the [roadmap](../guide/roadmap.md)); the read API
> and the realtime SSE feed ship in **Phase 4 — Read API, the dashboard, and the five
> daily questions**. Values marked _(planned)_ or _(leaning — unconfirmed)_ may change;
> the **security invariants are binding and will not**. This replaces the earlier stub.

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

There is no route in this design — present or planned — that is reachable without
crossing both checks that apply to it. See the [security model](../security/model.md)
for the full nine-rule catalogue this API sits inside, and
[configuration](configuration.md) for how `DASHBOARD_TOKEN` itself is supplied to the
running server.

## The realtime feed — `/api/stream`

`/api/stream` is the one concrete path the sources name explicitly (`WP-U1`,
`RealtimeHub SSE endpoint`). Every other path in this page is a planned shape, not a
literal one — see the [Read endpoints](#read-endpoints) table below.

| Property | Value | Source |
|---|---|---|
| Transport | Server-sent events (SSE) — one long-lived HTTP response, server→browser only | CD-5; security model rule 4 |
| Path | `/api/stream` (fixed) | `WP-U1` Done-when |
| Direction | Server → browser only; no client-to-server control channel over this connection | CD-5 ("revisit WebSocket only if bidirectional control is ever needed — it is not") |
| Auth | Same mandatory `timingSafeEqual(DASHBOARD_TOKEN)` gate as every other route | `WP-U2`, security model rule 2 |
| Origin check | Same-origin only; a cross-origin `Origin` header is rejected; no wildcard CORS | `WP-U1` Done-when: "a cross-origin `Origin` on `/api/stream` is rejected; no wildcard CORS" |
| Resumability | Resumable — the connection can pick back up after a drop | `WP-U1`: "server→browser, same-origin, auth-gated, **resumable**" |
| What it pushes | Deltas from the projection layer (new/changed `sessions`, `agents`, `orchestration_edges`, `token_usage` rows) | `docs/analysis/development-plan.md` §7: "`WP-U1` needs a projection change-notifier that only exists after `WP-IN7`" |

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

## Read endpoints

Every row below other than `/api/stream` (above) and `GET /sessions/:id/tree` is a
**_(planned shape — exact path undecided)_** — the sources fix the resource, the backing
data, and the owning work package, but not a literal REST path. Do not treat any path
other than those two as decided.

| Resource | Purpose | Backing data | Source WP |
|---|---|---|---|
| `GET /sessions/:id/tree` | The session-scoped subagent tree (daily Q1/Q3/Q5) | Query over `orchestration_edges`, joined to `agents` | `WP-U3` — fixed path: "`GET /sessions/:id/tree` built from a query over `orchestration_edges` (proven, not reconstruction)" |
| Sessions & agents _(planned shape)_ | List/get sessions and their agents, including per-agent `status` (`working`/`waiting`/`completed`/`error`) | `sessions`, `agents` projection tables | `WP-U3` |
| Cost & delegation-savings _(planned shape)_ | Per-session/agent dollar cost and the Haiku/Sonnet-routing delegation-savings figure (daily Q2/Q4) | `token_usage` × `model_pricing`, via `CostEngine` (`WP-C3`), delegation-savings via `WP-C5` | `WP-U4` |
| Global orchestration DAG _(planned shape)_ | The cross-session, per-instance persisted DAG (the moat view) | Query over `orchestration_edges` across sessions, keyed by `instance`/`host_id` | `WP-U4`; see [the DAG moat](../architecture/dag-moat.md) |
| Token usage _(planned shape)_ | Fine-grained ground-truth token buckets (`speed`/`inference_geo`/`service_tier`), including PreCompact baselines | `token_usage` | `WP-U3`/`WP-U4`, backed by `WP-D8` |
| Events _(planned shape)_ | Read access to normalized `events` (and, where exposed, `events_raw`) for a session/agent | `events`, `events_raw` | Implied by `WP-U2`'s Read API foundation over the projection; no dedicated WP names an events-listing endpoint explicitly |

Every route in this table — fixed or planned — is TypeBox-contract-validated and shares
one auth guard implementation: `WP-U2` (Read API foundation) is explicitly "a Fastify
plugin, TypeBox contracts, auth guard, shared DTOs," so no individual route author can
forget to wrap a new endpoint in the gate.

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

## Operator alerts API (`WP-A8`, Phase 6)

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
phase ahead of this CRUD surface.

## What's fixed vs. planned, at a glance

| Claim | Status |
|---|---|
| Transport is SSE, not WebSocket; `/api/stream` is the path | **Fixed** — CD-5; `WP-U1` |
| Same-origin enforcement, no wildcard CORS, on the stream | **Fixed** — `WP-U1` Done-when |
| Every route (read + write) is `timingSafeEqual`-gated | **Fixed** — `WP-U2`, `WP-A8` Done-when |
| Loopback-only bind for the whole server | **Fixed** — `WP-U0`; security model rule 1 |
| `GET /sessions/:id/tree` reads `orchestration_edges` | **Fixed path & mechanism** — `WP-U3` Done-when |
| Stream is resumable | **Fixed requirement**; exact resume protocol _(planned)_ |
| Cost/delegation/global-DAG/token/events endpoint paths | _(planned shape — exact path undecided)_ — `WP-U4`/`WP-U3` name the resource, not the route |
| Alerts CRUD paths | _(planned shape — exact path undecided)_ — `WP-A8` names the surface, not the route |
| Underlying stack (Fastify, TypeBox) | _(leaning — unconfirmed)_ per the project's `CLAUDE.md`; treated here as the working assumption because the sources name it, not because it is locked |

## See also

- [Security model](../security/model.md) — the full nine-rule catalogue this API
  inherits in its entirety: loopback bind, mandatory token, no spawner, same-origin
  realtime, no unauthenticated endpoints, no SSRF, tunnel-only remote access,
  `ANTHROPIC_API_KEY` isolation, WAL + tested restore.
- [Data model](../architecture/data-model.md) — the `events_raw` → `events` →
  `sessions`/`agents`/`orchestration_edges`/`token_usage` schema this API reads from.
- [Using the dashboard](dashboard.md) — the SPA built on top of this API and the
  realtime feed, once Phase 4 ships it.
- [Configuration](configuration.md) — how `DASHBOARD_TOKEN` and the server's other
  settings are supplied to the process this API runs inside.
- [Telegram alerts](telegram.md) — the Phase 5 alerting core the Phase 6 alerts API in
  this page manages.
- [Roadmap](../guide/roadmap.md) — Phase 4's exit gate in full, and where the alerts API
  sits relative to it in Phase 6.
