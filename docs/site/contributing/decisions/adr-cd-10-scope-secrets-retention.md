# ADR-0012: CD-10 — Scope, secrets & retention: MVP discipline for a solo owner

- **Status:** accepted, **partially built as of 2026-07-30** — scope discipline held; payload redaction shipped at the ingest boundary; ~~**retention TTL is not implemented**~~ *(amended 2026-08-15 — the retention **mechanism** now exists and is tested; the retention **policy** is still unset)*, blocked on the open OPEN-1/2/3 decisions (see the as-built updates below)
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

## As-built update — 2026-08-15

**Verdict: still partially built, but the shape of the gap has changed.** The
2026-07-30 sentence "there is no TTL sweeper, no prune, no purge, and no retention
configuration anywhere" is superseded. `apps/server/src/retention/` now holds
`policy.ts`, `prune.ts`, `journal.ts`, `backup-files.ts`, `runner.ts` and `port.ts`,
with `db/retention-queries.ts` behind them. What has **not** changed is the reason
`WP-D10` is still not done: the policy numbers are blank, and they are not an agent's
to fill in.

**The separation being maintained here is mechanism versus policy, and it is the
whole point.** The mechanism can express either branch of OPEN-1; the policy that
selects a branch awaits Ivan's ratification. Concretely:

- **The default deletes nothing, ever.** `NO_RETENTION` is what
  `loadRetentionPolicy` returns for an environment with no `DASHBOARD_RETENTION_*`
  variable set, and a deployment that never configures retention behaves
  byte-identically to a build without the module. Shipping a mechanism therefore did
  not smuggle in a data-destruction default.
- **`events_raw` is never a delete target under any policy.** It is on a protected
  list alongside `sessions`, `agents`, `orchestration_edges`, `model_pricing` and
  `schema_version` — the append-only substrate and the persisted DAG. The reason
  `agents` is protected is the sharpest of them: deleting an agent row would fire
  `parent_agent_id ON DELETE SET NULL` and **silently re-parent a subtree**, turning
  a retention pass into a quiet corruption of the moat artifact.
- **The recommended resolution of OPEN-1 is declared and refused, not silently
  ignored.** `rawEvents: 'archive-segments'` parses, and then
  `assertRetentionPolicy` throws an error naming the decision it is waiting on. A
  configuration this project cannot honour honestly produces a loud stop rather than
  a plausible no-op — the same posture as the `PricingError` halt in
  [ADR-0006](adr-cd-4-schema-events-and-orchestration.md).
- **Pruning cost-bearing rows requires an explicit acknowledgement.** `token_usage`
  is the ground truth behind every dollar the dashboard reports, so a policy that
  prunes it must set `acknowledgeCostLoss`, and the prune then refuses to run without
  a durable journal receipt. Priced rows can only leave the database with the removed
  dollars written down first.
- **An unparseable retention variable throws rather than defaulting.** A typo in a
  deletion policy is never interpreted generously.

**What is wired, and what is not.** Backup-file pruning is live: the daily backup
scheduler in `apps/server/src/index.ts` runs a keep-minimum-floored pass after each
write, so backup files on disk are bounded today. The **row**-level runner
(`createRetentionRunner`) is constructed only by its tests — no bootstrap path calls
it. That is consistent with the policy being unset, since wiring it up would run a
no-op, but it means the row half of the mechanism has never executed outside a test
and should not be described as running in production.

**So the risk named in Context is still not mitigated.** "Unbounded local storage
growth" now has a bounded, tested tool pointed at it and no instruction to fire. A
long-running instance still grows without bound in `events` and `token_usage`. The
blocker remains OPEN-1 / OPEN-2 / OPEN-3 in
[`open-decisions.md`](../../../analysis/open-decisions.md), and it remains Ivan's.
Building the mechanism was the part that could be done without choosing on his
behalf; choosing is not.

**Redaction, secrets and scope are unchanged.** The redaction default is still
pending sign-off and still may only grow, never relax; `token_ref` still does not
exist because alerting does not; `ANTHROPIC_API_KEY` still appears nowhere in the
server source; and **"< 30s time-to-understand a session" is still UNMEASURED** — no
one has timed it, so it is neither met nor missed.

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
