# 01 — Which roles must review this project, and why

> Part of the [role reviews of 2026-10-29](README.md). Input: [00-baseline.md](00-baseline.md).

## 1. How the roles were chosen

A role earns a seat when **(a)** the project makes a claim that only that discipline can
verify, and **(b)** getting that claim wrong would cost the v1.0 release, the owner's data or
the moat. Roles that would only restate another role's findings were merged. The claims
agenthropic makes, and who can check each:

| Claim the project makes | Where it is made | Who can verify it |
|---|---|---|
| Ports & adapters; a pure core; a projection that can be rebuilt from an immutable substrate | `docs/site/architecture/`, ADRs | Software Architect |
| Loopback-only, mandatory token, no spawner, same-origin SSE, the only outbound path is opt-in | `SECURITY.md`, `docs/site/security/` | Application Security Engineer |
| The DAG is a data fact; token counts are ground truth; every dollar = tokens × dated price | `parser-spec.md`, `cost-model.md` | Data Engineer with FinOps expertise |
| 100% coverage means the code is proven; the P0 moat proofs block merges | `testing.md`, `RELEASE.md` §1/§3 | QA / Test Architect |
| The cockpit answers the five daily questions; a session is understood in < 30 s | `ux0-design.md`, `dashboard.md` | Frontend Engineer & UX Designer |
| It runs unattended on a Mac Mini; WAL + tested restore; replay on startup | `operations/`, `RELEASE.md` §5 | SRE / Platform Engineer |
| It is worth building and using, better than the alternatives, and on schedule | roadmap, closing plan, KC table | Product Manager |
| It can be released, installed, read and contributed to as a public MIT project | `README.md`, `RELEASE.md` §7, CI, docs site | Open-Source Maintainer / Release Engineer |

## 2. The eight roles

| # | Role | Prefix | Primary question |
|---|---|---|---|
| 1 | Senior Software Architect | `ARC` | Will the structure hold for v1.x and Claude Code's format drift? |
| 2 | Senior Application Security Engineer | `SEC` | Does the implementation keep every invariant the threat model promises? |
| 3 | Senior Data Engineer / FinOps | `DAT` | Are the DAG and the dollars actually correct, and will they stay correct? |
| 4 | Senior QA / Test Architect | `QA` | Is the 100% bar meaningful, and what would escape it? |
| 5 | Senior Frontend Engineer & UX Designer | `UX` | Does the UI answer the five questions fast, for hundreds of agents? |
| 6 | Senior SRE / Platform Engineer | `OPS` | Can it run unattended for a year and be restored after a failure? |
| 7 | Senior Product Manager | `PRD` | Is it delivering value, and what is the minimum path to the v1.0 tag? |
| 8 | Senior OSS Maintainer / Release Engineer | `OSS` | Can v1.0.0 be cut, installed and maintained without heroics? |

## 3. Roles considered and not seated

| Role | Why not |
|---|---|
| Separate FinOps analyst | Cost correctness is inseparable from parser and schema correctness; merged into role 3. |
| DBA | SQLite schema, WAL and backups are split between roles 3 and 6. |
| Technical writer | The docs corpus is reviewed as a maintenance liability by role 8 and as product truth by role 7. |
| Performance engineer | Covered by role 6 (runtime, cold replay) and role 5 (render cost). |
| Accessibility specialist | Folded into role 5's scope. |
| Legal / licensing | The license gate and clean-room rule are mechanical and covered by role 8; no new legal question exists. |
| Marketing / DevRel | No launch is planned before v1.0; role 7 answers whether one should be. |

## 4. Method

Each role was run as an independent senior reviewer with the same verified context, read-only
access to the repository, a lens-specific brief, and an identical report contract: verdict and
a 0–10 readiness score, strengths, a findings table (`ID | severity | finding | evidence |
recommendation | effort | CONFIRMED/PLAUSIBLE`), risks, recommendations mapped to the
roadmap (before the v1.0 tag / v1.x / v2.0 / never) and questions for the owner. Reviewers
were told to check whether the findings of [`impl-review-2026-08-09.md`](../impl-review-2026-08-09.md)
were actually fixed rather than repeat them. Severity scale:

- **P0** — blocks the v1.0.0 tag.
- **P1** — fix before v1.0 (by 2026-11-22, the Wave 4 release-candidate end).
- **P2** — v1.x.
- **P3** — nice to have.

The reviews were consolidated in [10-synthesis.md](10-synthesis.md), which de-duplicates the
findings and places each one on the schedule.
