# ADR-0009: CD-7 — Security + the coverage gate are boundary conditions from commit one

- **Status:** accepted
- **Date:** 2026-07-03
- **Deciders:** Ivan Baev (project owner), via the six-lens concept-analysis-v2 workflow
- **Source:** [`concept-analysis-v2.md` §3, row CD-7](../../../analysis/concept-analysis-v2.md#3-canonical-decision-register-v2)
  (consolidates AD7, SD8, QA-D3/D4, G-D3, H-SEQ); [`docs/ai/DESIGN.md` §8](../../../ai/DESIGN.md)

## Context

Every one of the six audited rival projects binds `0.0.0.0` and/or ships no-op auth in
practice (`simple10`: `0.0.0.0` + zero auth; `cast`: `0.0.0.0` unauth GET reads; `hoangsonww`:
token is a no-op when unset, and its `/api/run` spawner — accepting `permission-mode` from the
request body with `bypassPermissions` in its allow-list — is an outright RCE). EXPANDED, one of
the two external parallel reports, sequenced security to Phase 6 and backup to Phase 8; the
Holistic and Architect lenses both call this "architecturally wrong, self-contradictory" (§4.1,
§4.6) — a cross-origin-vulnerable socket cannot be a "later polish" item on a system whose entire
positioning is security-by-default.

## Decision

Security and the coverage gate are **boundary conditions from commit one**, **CI-blocking**:
loopback-or-fail bind; mandatory `DASHBOARD_TOKEN`-or-fail-startup (timing-safe compare); SSE
same-origin; **no-spawner** grep/static gate; **no-SSRF** (webhook targets operator-configured,
never dialed from a payload); WAL + tested restore; **>90% coverage blocks merges**. This
**rejects** EXPANDED's security→Phase 6 / backup→Phase 8 sequencing outright — in the roadmap,
Slice 8 is polish only, never the first appearance of these guarantees.

## Acceptance criteria

Verbatim from `concept-analysis-v2.md` §6 ("Security, build-failing, from Phase 1") and
("Delivery bar"):

- Server binds **`127.0.0.1` only** and **FAILS startup when `DASHBOARD_TOKEN` is unset**
  (never "auth disabled"); token compare is **timing-safe**; SSE rejects cross-origin; no
  wildcard CORS.
- A **grep/lint gate fails the build** if any route spawns a subprocess from request input.
- An **SSRF test** proves no outbound dial to a payload-supplied URL.
- `events_raw` exposes **no UPDATE/DELETE path** (enforced by test); SQLite runs **WAL**; a
  backup is taken **and a restore is exercised** at least once per release candidate.
- **CI coverage gate blocks merges at or below 90%** — the bar is **>90%** (scope
  defined), live from **Phase 1**.

## Consequences

- **Positive:** closes the exact vulnerability class every audited rival shipped, structurally
  — not as a policy statement but as CI-blocking gates that fail the build. Makes the security
  posture the system's actual spine (`docs/ai/DESIGN.md` §0), not a bolt-on appendix.
- **Negative / costs:** a heavier Phase 1 up-front lift — `development-plan.md` §7 notes that
  `WP-F5`…`WP-F7` (static no-spawner/no-SSRF/license gates, security-contract tests) plus
  `WP-F8` (backup/restore) all land **before any ingest feature code**, and `WP-F7`'s contract
  tests are *intentionally red* from wave 8 until `WP-U0` wires the real primitives at wave 9.
- **Follow-ups:** `development-plan.md` Track F (`WP-F1`…`WP-F8`), `WP-U0` (server bootstrap
  that turns `WP-F7` green). See [the security model](../../security/model.md) (flagship page)
  and [backup & restore](../../operations/backup-restore.md).

## Alternatives considered

- **EXPANDED's security→Phase 6 / backup→Phase 8 sequencing** — explicitly rejected; named a
  "generation defect" and "architecturally wrong, self-contradictory" (§4.1, §1).
- **Add the coverage gate once code exists, rather than from Phase 1** — rejected as Gap #8,
  "coverage theatre": a gate introduced after code exists measures what was convenient to test,
  not what needed testing.
