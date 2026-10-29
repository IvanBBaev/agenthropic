# Role reviews — 2026-10-29

Eight independent senior reviews of agenthropic, each through one professional lens, taken on
`main` at `db3f042` 33 days before the v1.0.0 hard date (KC-4, 2026-12-01). The findings are
de-duplicated and placed on the schedule in [10-synthesis.md](10-synthesis.md); the roadmap
carries them in [§9 of the roadmap](../roadmap-v1-v2-2026-07-06.md#9-role-reviews-2026-10-29)
and `TODO.md` carries the accepted rows.

> **Status of this set.** The roadmap §8 analysis freeze is in force. This set exists by the
> **owner override of 2026-10-29** (Ivan, in chat: a deep analysis, the roles that should
> review the project, one senior analysis per role, all placed on the roadmap). It is a
> post-freeze verdict record, not analysis #10 opening a new line of work: it adds no new
> scope beyond what it schedules in [10-synthesis.md](10-synthesis.md), and the KC calendar
> does not move.

## Index

| File | Content |
|---|---|
| [00-baseline.md](00-baseline.md) | What the project is on the review date — code, docs, schedule, unknowns, overrides |
| [01-roles.md](01-roles.md) | Which roles review it and why; roles not seated; method and severity scale |
| [02-architect.md](02-architect.md) | Senior Software Architect (`ARC`) |
| [03-security.md](03-security.md) | Senior Application Security Engineer (`SEC`) |
| [04-data-finops.md](04-data-finops.md) | Senior Data Engineer / FinOps (`DAT`) |
| [05-qa.md](05-qa.md) | Senior QA / Test Architect (`QA`) |
| [06-ux.md](06-ux.md) | Senior Frontend Engineer & UX Designer (`UX`) |
| [07-ops.md](07-ops.md) | Senior SRE / Platform Engineer (`OPS`) |
| [08-product.md](08-product.md) | Senior Product Manager (`PRD`) |
| [09-oss.md](09-oss.md) | Senior OSS Maintainer / Release Engineer (`OSS`) |
| [10-synthesis.md](10-synthesis.md) | De-duplicated backlog, schedule placement, owner decisions, critical path |

## Scores

Each reviewer scored readiness for the v1.0.0 tag on its own lens, 0–10.

| Role | Score | One-line verdict | P0 | P1 |
|---|---|---|---|---|
| ARC — Architect | **7.5** | Sound ports & adapters; the pricing gate and transcript retention are the structural holes | 0 | 3 |
| SEC — Security | **6.5** | Invariants hold in code; a confirmed ReDoS and world-readable DB files block the tag | 0 | 2 |
| DAT — Data / FinOps | **6.5** | The ledger is sound; ingest drops whole sessions on a pricing gap and caps the largest files | 0 | 4 |
| QA — Test | **6.5** | 100% coverage is real but synthetic; the hierarchy gate is NOT CERTIFIED | 1 | 3 |
| UX — Frontend & UX | **5** | Correct views, but the five daily questions are not answered fast | 0 | 10 |
| OSS — Release | **5** | Releasable after small fixes; npm claim, audit highs and docs bloat | 1–2 | 7 |
| OPS — SRE | **4** | Nothing makes it run unattended: no service, no SIGTERM, unverified backups | 0 | 11 |
| PRD — Product | **4** | Engineering 9, evidence of value 1 — the product is not in use | 3 | 5 |

The pattern is the finding: the closer a lens is to code, the higher the score; the closer it
is to "does this run and earn its keep on the Mac Mini", the lower.

## Gate on the review date

Run on `db3f042`, Node 22.23.2, by the coordinator before dispatch:

| Gate | Result |
|---|---|
| `gate:node`, `gate:spawner`, `typecheck`, `lint`, `format:check`, web build, `test` (100% × 5 packages), `gate:licenses` | **all EXIT 0** (load average 12–16) |

**Load-sensitivity, observed twice.** With eight reviewer agents running, a second `test` run
had 3 web tests time out; a web-only rerun at load average ~100 had **9 tests in 7 files** fail
with `Test timed out in 5000ms` (all render/fetch tests in `apps/web/test/`). No assertion
failed. Vitest's default 5 s `testTimeout` is in force — this is QA-4, independently
confirmed, and is scheduled in the synthesis.

## Reproducing

Every review was read-only on the repository. Each report states its evidence as
`file:line`, a command, or a measurement, and labels each finding CONFIRMED or PLAUSIBLE.
Corpus surveys read structural fields only; no prompt content is reproduced in any report.
