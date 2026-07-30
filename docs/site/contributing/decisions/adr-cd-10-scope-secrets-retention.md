# ADR-0012: CD-10 — Scope, secrets & retention: MVP discipline for a solo owner

- **Status:** accepted, **partially built as of 2026-07-30** — scope discipline held; payload redaction shipped at the ingest boundary; **retention TTL is not implemented**, blocked on the open OPEN-1/2/3 decisions (see the as-built update below)
- **Date:** 2026-07-03
- **Deciders:** Ivan Baev (project owner), via the six-lens concept-analysis-v2 workflow
- **Source:** [`concept-analysis-v2.md` §3, row CD-10](../../../analysis/concept-analysis-v2.md#3-canonical-decision-register-v2)
  (consolidates BA-D1/D3, G-D7, AD8, SD7, LB2); §4.6 (Holistic, seam 3)

## As-built update — 2026-07-30

**Verdict: partially built.** This decision bundles three separate risks, and they
shipped at three different depths. Taking them in order:

**Scope — held.** No vector-DB feed, no fleet, no multi-tenancy. The
`instance`/`host_id` hedge is present and `NOT NULL` on every `orchestration_edges`
row, exactly as the cheap-hedge criterion requires. The API surface is small
(sessions, DAG, cost, events, stream). The "< 30s time-to-understand a session"
criterion is **unmeasured** — no one has timed it, so it is neither met nor missed;
it is untested.

**Redaction — shipped, in the strong position.** `apps/server/src/hooks/redact.ts`
scrubs hook payloads at the **ingest boundary**, before persistence and — critically
— **before the idempotency key is computed**, so a redelivered event redacts
identically and still dedupes. Two independent rules run: key-based (any field whose
normalized name matches `token`, `secret`, `password`, `apikey`, `authorization`,
`bearer`, `privatekey`, `accesskey`, … is replaced wholesale, whatever its value
type) and value-based (string values are scanned for credential shapes — `sk-`,
`ghp_`, `xox`, `AKIA`, JWTs, `Bearer <…>` — and each match is masked in place). An
explicit allowlist keeps **token-count** fields (`input_tokens`, `output_tokens`, …)
intact, because token counts are observability data, not credentials — the one place
where a naive "redact anything called `*token*`" rule would have destroyed the
project's core dataset.

Two caveats stated plainly: the redaction policy implements the *recommended*
resolution of OPEN-3 as a default and is **pending Ivan's sign-off**; and it can only
ever grow on sign-off, never relax.

**Retention — NOT implemented.** There is no TTL sweeper, no prune, no purge, and no
retention configuration anywhere in `apps/server`, `packages/core` or
`packages/shared`. `WP-D10` shipped its redaction half and not its retention half.
The Decision below says "Retention TTL + payload redaction from Phase 1"; half of
that sentence is true.

This is **blocked, and on a named person**: the retention policy depends on the
still-open OPEN-1 / OPEN-2 / OPEN-3 decisions
([`open-decisions.md`](../../../analysis/open-decisions.md)), which are Ivan's to
make. Building a sweeper before those land would mean choosing a data-destruction
policy by default — the precise failure mode this project was built to avoid. So the
gap is deliberate, but it is still a gap: the "unbounded local storage growth" risk
this ADR names in its Context is, as of today, **not mitigated**. A long-running
instance grows without bound.

**Telegram `token_ref` — not built, because there is nothing to secure yet.** No
`token_ref` resolver exists (`WP-A3`), because alerting is post-1.0 and no Telegram
secret is handled by any code path. The `>0600`-dotfile-rejected criterion has
nothing to run against. Separately, `ANTHROPIC_API_KEY` does stay out of the
dashboard env entirely — it appears nowhere in the server source, and the server has
no outbound network call that could use one.

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
