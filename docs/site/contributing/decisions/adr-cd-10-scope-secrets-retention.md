# ADR-0012: CD-10 — Scope, secrets & retention: MVP discipline for a solo owner

- **Status:** accepted
- **Date:** 2026-07-03
- **Deciders:** Ivan Baev (project owner), via the six-lens concept-analysis-v2 workflow
- **Source:** [`concept-analysis-v2.md` §3, row CD-10](../../../analysis/concept-analysis-v2.md#3-canonical-decision-register-v2)
  (consolidates BA-D1/D3, G-D7, AD8, SD7, LB2); §4.6 (Holistic, seam 3)

## Context

Three separate risks compound if left undecided together: **scope creep** (a solo owner
out-building a 28.4k★ incumbent on five axes plus a coverage gate plus a docs site is, in the
Holistic lens's words, "the exact hoangsonww enterprise-cosplay-over-solo-project trap," §4.6);
**secret handling** (the Telegram bot token must never reach SQLite, the SSE stream, or the
browser); and **unbounded local storage growth** (a local-first tool that never prunes its own
history eventually chokes on its own data).

## Decision

- **MVP = the 5 daily questions.**
- **Phase-3 vector-DB** "observability-becomes-memory" feed ships on a **labeled experimental
  track**, off the critical path.
- **Fleet deferred** until a second host actually exists.
- **Telegram token via `token_ref`** → resolved from `launchd` env or a `chmod 600` file —
  **never in SQLite, never sent to the browser.**
- **Retention TTL + payload redaction from Phase 1.**

## Acceptance criteria

From `concept-analysis-v2.md` §6 ("Product / business") and §3 (CD-10 row):

- v1 answers all **5 daily questions**; **time-to-understand a session < 30s.**
- Vector-DB feed **labeled experimental** and off the critical path; **fleet deferred** — only
  the `instance`/`host_id` hedge (ADR-0002, LB2) is present.
- **`ANTHROPIC_API_KEY` stays out of the dashboard env entirely.**

Supporting evidence, `development-plan.md`:

- `WP-A3` ("Secret handling: `token_ref` resolver"): "A `>0600` dotfile is rejected."
- `WP-D10` ("Retention TTL sweeper + payload redaction at ingest"): "Redaction deterministic;
  redacted re-ingest byte-identical + idempotent."
- `WP-X11` ("Vector-DB EXPERIMENTAL stub"): "Unambiguously labeled; documented as non-blocking";
  "no core package imports it (asserted)." *(Amendment 2026-07-06: `WP-X11` was deleted
  per best-path-decision.md §6.3 — the isolation principle stands; the stub does not.)*

## Consequences

- **Positive:** keeps a solo owner inside a shippable MVP instead of the "enterprise-cosplay"
  trap; the Telegram secret never touches a code path that could leak it into a log, a SQLite
  dump, or a browser payload; storage growth is bounded from the first release, not retrofitted.
- **Negative / costs:** deferring fleet means the near-zero-cost `instance`/`host_id` hedge
  (ADR-0002, LB2) is paid now for value that may only be realized much later — a bet the
  concept-analysis-v2 verdict accepts explicitly as "cheap on paper."
- **Follow-ups:** `development-plan.md` `WP-D10` (retention TTL + redaction), `WP-A3`
  (`token_ref` resolver), ~~`WP-X11` (vector-DB EXPERIMENTAL stub)~~ *(deleted per
  best-path §6.3, applied 2026-07-06)*. See
  [scope & the roadmap](../../guide/roadmap.md) and
  [troubleshooting](../../operations/troubleshooting.md).

## Alternatives considered

- **Build fleet-ready multi-tenancy now** — rejected under ADR-0002 (LB2) and Gap #9:
  program-sized ambition for a single owner, stalls delivery in Phase 2.
- **Store the Telegram token in SQLite alongside `alert_rules`** — rejected: violates the
  "secrets never in SQLite/SSE/logs" invariant carried in both `docs/ai/DESIGN.md` §8 and the
  project's Global Definition of Done (`development-plan.md` §8).
