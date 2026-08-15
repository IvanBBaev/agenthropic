# ADR-0009: CD-7 — Security + the coverage gate are boundary conditions from commit one

- **Status:** accepted — **built and enforced** as of 2026-07-30; every criterion below is a failing build or a hard process exit, with one criterion (no-SSRF) currently vacuous (see the as-built update below); **amended 2026-08-15** — the coverage bar is now 100 in five packages, but the "**blocks merges**" half of that criterion is **not met**: branch protection on `main` is not enabled
- **Date:** 2026-07-03
- **Deciders:** Ivan Baev (project owner), via the six-lens concept-analysis-v2 workflow
- **Source:** [`concept-analysis-v2.md` §3, row CD-7](../../../analysis/concept-analysis-v2.md#3-canonical-decision-register-v2)
  (consolidates AD7, SD8, QA-D3/D4, G-D3, H-SEQ); `docs/ai/DESIGN.md` §8

## As-built update — 2026-07-30

**Verdict: holds, and it is the part of this project that was built exactly as
decided.** Every acceptance criterion below is enforced by something that fails a
build or kills a process — not by a policy sentence.

- **Loopback-or-fail, with a post-listen re-check.** The server binds `127.0.0.1`,
  and then *re-verifies every actually-bound address after listening*: any
  non-loopback address logs a secret-free FATAL and hard-exits the process. That
  second check exists because a config-level bind constant is only a claim about
  intent; the socket is the fact.
- **Token-or-refuse-to-start**, never "auth disabled," compared with a **timing-safe**
  comparison. All `/api/` routes are gated.
- **No auth oracle.** The negative catalogue asserts **byte-identical 401 bodies**
  across four wrong-token shapes, and a **403 on a foreign `Origin` both with and
  without a valid token** — so neither response distinguishes "wrong token" from
  "no token," nor "bad origin" from "bad credential."
- **`gate:spawner`** (`scripts/check-no-spawner.mjs`) scans `apps`, `packages`,
  `scripts`, `hooks` and the repo-root config files for subprocess spawners, wide
  binds (`0.0.0.0`, `host: true`, `host: ''`), WebSocket servers, and dynamic
  evaluation including indirect `eval` — and exits 1 with the offenders listed. It
  runs in CI on every push. Its allowlist contains exactly one file: the gate itself,
  which necessarily contains the patterns it forbids.
- **`gate:licenses`** runs the CD-9 allowlist scan ([ADR-0011](adr-cd-9-per-artifact-licensing.md)).
- **WAL is asserted, not assumed** — the connection sets `journal_mode = WAL` and
  then reads the pragma back, throwing if SQLite did not honour it. Foreign keys are
  enforced the same way.
- **Backup restore is exercised in CI**, not documented as a procedure: the test
  writes, backs up, deletes the original, restores, and asserts `integrity_check =
  ok`, WAL mode preserved, and the substrate rows readable through the port.
- **`events_raw` has no UPDATE/DELETE path**, enforced by SQLite triggers rather
  than by discipline ([ADR-0004](adr-cd-2-immutable-substrate-projection.md)).
- **The >90% coverage gate is real in every shipped package.** `apps/server`,
  `apps/web`, `packages/core` and `packages/shared` each run `vitest run --coverage`
  with 90% thresholds on lines/branches/functions/statements.
  `packages/test-fixtures` is a deliberate, documented exclusion — it is fixture data
  consumed by other packages' tests, not shipped logic.

**Two honesty defects found in this area and fixed rather than shipped**, recorded
here because a security ADR that only lists its successes is not evidence of
anything:

1. `apps/web` ran its tests **without `--coverage`**. The thresholds were configured,
   looked enforced in review, and silently never executed — a gate that cannot fail is
   not a gate. Now `vitest run --coverage`, same as every other package.
2. The `events` table was created by a migration and never written to — a lie by
   omission in a shipped schema. Now wired ([ADR-0006](adr-cd-4-schema-events-and-orchestration.md)).

**One criterion is vacuously satisfied, and should be read that way.** There is no
SSRF test, because there is no outbound network call anywhere in `apps/server` — no
`fetch`, no `http.request`, no HTTP client dependency. Webhook targets do not exist
yet ([ADR-0008](adr-cd-6-ports-and-adapters.md): `AlertSink` has no adapter; alerts
are post-1.0). "No outbound dial to a payload-supplied URL" is currently true because
there is no outbound dial at all. When alerting is built, this criterion needs a real
test; today it has nothing to test.

## As-built update — 2026-08-15

**Verdict: the coverage bar strengthened; its enforcement clause is still unmet.**
Two things changed since the 2026-07-30 reading, and they point in opposite
directions. Recording only the first would be exactly the kind of
success-list-as-evidence this ADR already refuses.

**The bar is 100, not 90, and it covers five packages, not four.** Every package —
`apps/server`, `apps/web`, `packages/core`, `packages/shared` **and**
`packages/test-fixtures` — runs `vitest run --coverage` with lines, branches,
functions and statements all set to `100`, and on a clean run at this date all five
hold it. Two of the 2026-07-30 statements are therefore superseded: the threshold is
no longer 90, and `packages/test-fixtures` is no longer an exclusion. Its config
records why the original reasoning was revisited — `getFixture`, `listFixtures` and
`makeRawEventEnvelope` are real code, and "a defect in a fixture builder does not fail
loudly; it silently weakens every downstream parser and ingest test that consumes it."
The reasoning for the raised bar is stated in the same place: **a 90% bar on a package
sitting at 100% licenses a ten-point regression to pass in silence, which is the
opposite of a gate.** These are measured figures on one dated run, not a constant —
see [testing & quality](../testing.md) §6.1 for the per-package numbers, the three
ways a coverage figure can be bought, and the static guards that read the config as
text to stop each of them.

**But "blocks merges" remains false.** The Decision below says **CI-blocking**, and
the fifth acceptance criterion says the gate "**blocks merges** at or below 90%."
As of 2026-08-15, `gh api repos/IvanBBaev/agenthropic/branches/main/protection`
returns `404 Branch not protected`. CI runs the gate on every push and pull request
and fails correctly when a threshold is missed — the mechanism is real and stricter
than specified — but nothing physically prevents a merge over a red run. The
workflow file says so itself in a header comment: making it merge-blocking requires a
GitHub branch-protection rule, which is an owner action on github.com and cannot be
configured from the repository.

So this criterion is **half satisfied and should be read that way**: the measurement
side exceeds what was asked, the enforcement side has not been switched on. It is not
an override — nobody decided to proceed without it — but it is also not a pass, and
no commit inside this repository can close it.

**One criterion remains vacuous.** The no-SSRF position is unchanged: still no
outbound network call anywhere in `apps/server`, still nothing to test, still owed a
real test the moment alerting exists.

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
