# ADR-0007: CD-5 — Transport is SSE with same-origin enforcement

- **Status:** accepted
- **Date:** 2026-07-03
- **Deciders:** Ivan Baev (project owner), via the six-lens concept-analysis-v2 workflow
- **Source:** [`concept-analysis-v2.md` §3, row CD-5](../../../analysis/concept-analysis-v2.md#3-canonical-decision-register-v2)
  (consolidates AD5)

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
