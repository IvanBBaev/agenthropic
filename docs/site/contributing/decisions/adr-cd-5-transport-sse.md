# ADR-0007: CD-5 — Transport is SSE with same-origin enforcement

- **Status:** accepted — **built and holding**, re-checked 2026-08-15 (one open item: `Last-Event-ID` resumability; the origin and auth tests are CI-failing rather than merge-blocking — see the as-built updates below)
- **Date:** 2026-07-03
- **Deciders:** Ivan Baev (project owner), via the six-lens concept-analysis-v2 workflow
- **Source:** [`concept-analysis-v2.md` §3, row CD-5](../../../analysis/concept-analysis-v2.md#3-canonical-decision-register-v2)
  (consolidates AD5)

## As-built update — 2026-07-30

**Verdict: holds, built as decided.** SSE is the transport; no WebSocket dependency
exists anywhere in the tree.

- `/api/stream` is a hijacked Fastify route writing `text/event-stream` with
  `cache-control: no-cache, no-transform` and a periodic heartbeat comment, fanned
  out by a `RealtimeHub`.
- **Same-origin is enforced before auth, not after.** A foreign `Origin` on
  `/api/stream` is rejected with 403 whether or not a valid token was presented — the
  browser attack surface closes before the token is even examined. There is no
  wildcard CORS.
- The auth hook gates on the **routed** path (`request.routeOptions.url`), not the
  raw request URL, specifically so a percent-encoded path like `/%61pi/health` cannot
  slip past a prefix check that the router would then decode back to `/api/`.
- Both behaviours are in the negative-test catalogue and are merge-blocking: a
  foreign `Origin` yields 403 **with and without** a valid token, and the four
  wrong-token shapes return **byte-identical** 401 bodies, so neither check leaks an
  oracle.

One acceptance item is not built as written: `WP-U1` calls the endpoint "resumable."
The server emits a `retry:` directive so a dropped client reconnects, but there is no
`Last-Event-ID` replay — a reconnecting client resubscribes to the live feed rather
than being caught up on frames it missed. For a liveness channel whose durable facts
all live in the database this is a small gap, but it is a gap, not a completed
criterion.

## As-built update — 2026-08-15

**Verdict: holds, with one word corrected.** SSE is still the only realtime transport in
the tree, no WebSocket dependency has appeared, and the security gate would fail the build
if one did ([ADR-0009](adr-cd-7-security-and-coverage-boundary.md)). The negative catalogue
still asserts a 403 on a foreign `Origin` **with and without** a valid token, and
byte-identical 401 bodies across the four wrong-token shapes, so neither check leaks an
oracle.

Calling those assertions **merge-blocking** is the part that was wrong. They run in CI on
every push and pull request and fail the run, but `main` is not branch-protected
(`404 Branch not protected`, verified 2026-08-15), so a red run is a signal rather than a
withheld merge — see [the standing correction](README.md#a-standing-correction-merge-blocking).

The `Last-Event-ID` gap is unchanged: the server still emits only a `retry:` directive, a
reconnecting client still resubscribes to the live feed instead of being caught up on the
frames it missed, and `WP-U1`'s "resumable" is still not met. It has been open long enough
now to be worth naming as a decision rather than an oversight — nobody has chosen to build
replay, and nobody has chosen to drop the word from the work package either.

## Context

The dashboard needs a live, server→browser feed so the status board and DAG views update
without polling. `docs/ai/DESIGN.md` §3's original architecture diagram names the transport
loosely as "WebSocket/SSE," leaving the choice open. A bidirectional channel (WebSocket) carries
a larger same-origin/attack-surface burden than a strictly one-directional one, and this project's
security posture treats attack-surface minimization as a first-class constraint
(`docs/ai/DESIGN.md` §8), not an afterthought.

## Decision

**Transport is Server-Sent Events (SSE)**, with same-origin enforcement live **from Phase 1**.
The feed is server→browser-only; WebSocket is revisited **only if a genuine bidirectional
control need ever arises — it does not today.** This settles the transport choice `docs/ai/DESIGN.md`
§3 left open in favor of SSE specifically.

## Acceptance criteria

From `concept-analysis-v2.md` §6 ("Security, build-failing, from Phase 1") — the CD-5/CD-7
shared acceptance surface:

- **SSE rejects cross-origin** requests; **no wildcard CORS**.
- Same-origin enforcement is live from **Phase 1**, not deferred (rejecting EXPANDED's
  security→Phase 6 sequencing, ADR-0009/CD-7).

Supporting evidence from `development-plan.md` `WP-U1` ("RealtimeHub SSE endpoint"): "A
cross-origin `Origin` on `/api/stream` is rejected; no wildcard CORS."

## Consequences

- **Positive:** a one-directional transport structurally forecloses an entire class of
  write-surface bugs — there is no bidirectional control channel for an attacker to abuse even
  if same-origin checks were ever weakened. This aligns directly with the no-unauthenticated-
  write-endpoints and no-spawner invariants (`docs/ai/DESIGN.md` §8).
- **Negative / costs:** if a genuine future need for server-directed bidirectional control
  emerges (none is currently identified), it requires a protocol change rather than reusing the
  existing channel.
- **Follow-ups:** `development-plan.md` `WP-U1` (RealtimeHub SSE endpoint, same-origin,
  auth-gated, resumable). See [the security model](../../security/model.md) and
  [architecture overview](../../architecture/overview.md).

## Alternatives considered

- **WebSocket** — the option `docs/ai/DESIGN.md` §3's diagram originally left open alongside
  SSE. Rejected for now: no proven bidirectional-control need exists, and a bidirectional
  channel carries a strictly larger same-origin/attack-surface burden to secure correctly.
- **Polling** — rejected: defeats the "<30s time-to-understand" daily-question metric and the
  live-status-board requirement (`concept-analysis-v2.md` §6, "Product / business").
