# ADR-0002: LB2 — Identity: personal-first / commercial-clean

- **Status:** accepted
- **Date:** 2026-07-03
- **Deciders:** Ivan Baev (project owner), via the six-lens concept-analysis-v2 workflow
  (Architect · Developer · QA · Business Analyst · Gap · Holistic)
- **Source:** [`concept-analysis-v2.md` §2 "LB2 — Identity"](../../../analysis/concept-analysis-v2.md#2-the-two-load-bearing-decisions),
  §4.4 (Business Analyst), §4.6 (Holistic), §5, §7 point 9

## Context

Two independent pressures collide if left unresolved: **scope discipline** (agenthropic is
built and operated by one person, on one Mac Mini) and **legal reality** (the six audited
rival projects are not uniformly free to copy from — some are MIT, some are all-rights-reserved
by Berne default). Left unnamed, either pressure alone can silently drive over-investment: scope
creep toward fleet/multi-tenancy features nobody yet needs, or licensing risk from treating an
unlicensed repo as a free "reference implementation."

A third loose end compounds this: the concept brief's internal docs carry an undefined
commercial-line token, **"OPCⁿ,"** that leaked in from the BASE external report (§4.4 BA
finding, §7 point 9) without ever being defined.

## Decision

Build the **single-user Mac Mini cockpit**; take only the **cheap** commercial hedges now
(MIT-clean code only; `instance`/`host_id` on every row from the first migration; a schema
that does not *block* tenancy); explicitly **defer** fleet and multi-tenancy. Resolve the
"OPCⁿ" commercial-line token — **define it or drop it** — before it drives further
tenancy/schema/license-strictness investment.

This resolves both tensions at once because the constraints happen to align: the copyable
repos (`simple10`, `hoangsonww`) carry the **large** patterns (tree-building, webhook/alert
schema), while the uncopyable ones (`cast`, `disler`, `nirdiamant`) carry only **small** ideas
that are cheap to reimplement clean-room.

## Acceptance criteria

From `concept-analysis-v2.md` §6 ("Product / business") and §4.5 (Gap #7, #9):

- **One `instance`/`host_id` column lands on every row in the first migration** — the
  near-zero-cost fleet hedge, paid once, not retrofitted later.
- No all-rights-reserved code ships (clean-room for `cast`/`disler`/`nirdiamant`; attribution
  for `simple10`/`hoangsonww`), **verified by a CI provenance check** (see ADR-0011, CD-9).
- Vector-DB feed labeled **experimental** and off the critical path; fleet **deferred** — only
  the `instance`/`host_id` hedge is present, no multi-tenant feature work.
- v1 answers all **5 daily questions**; time-to-understand a session **< 30s** — the MVP
  discipline that keeps a solo owner from out-building a 28.4k★ incumbent
  (`davila7/claude-code-templates`) on every axis at once.
- "OPCⁿ" is either **concretely defined** or **dropped** from the internal docs before it is
  allowed to drive further schema/licensing investment (open — see Consequences → Follow-ups).

## Consequences

- **Positive:** avoids the exact "enterprise-cosplay-over-solo-project" trap the Holistic lens
  names as a live risk (§4.6, seam 3) — a solo owner attempting fleet + multi-tenancy + a
  coverage gate + a docs site simultaneously. Keeps the schema future-proof for a second host
  without paying multi-tenancy engineering cost today.
- **Negative / costs:** genuine fleet/commercial functionality is explicitly not being built
  yet — any future pivot toward a commercial or multi-host offering pays a real (though
  bounded, per the hedge) migration cost. Requires ongoing discipline to not scope-creep the
  MVP.
- **Follow-ups:** ADR-0011 (CD-9, per-artifact licensing) and ADR-0012 (CD-10, scope/secrets/
  retention) are the two canonical decisions this identity choice resolves into. The "OPCⁿ"
  definition itself is **still an open item** (BA-D6) — not resolved by this ADR, tracked as
  future work; see [`../../../../TODO.md`](../../../../TODO.md) for open work and
  [`../../guide/roadmap.md`](../../guide/roadmap.md) for phase sequencing.

## Alternatives considered

- **Build multi-tenant from day one** — rejected under Gap #9 ("solo-owner scope creep"):
  program-sized ambition for one owner, stalls delivery in Phase 2.
- **Treat all six audited repos as free-to-copy reference implementations** — rejected by the
  Business Analyst lens (§4.4): `cast`/`disler`/`nirdiamant` are all-rights-reserved by Berne
  default, not "ambiguous"; copying them without attribution is an infringement risk under any
  commercial intent.
- **Leave "OPCⁿ" undefined and let it keep propagating** — rejected: an undefined token cannot
  legitimately drive tenancy, schema, or license-strictness decisions (§4.4, §7 point 9).
