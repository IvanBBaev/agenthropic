# Closing plan — from 85% to a tagged v1.0 (2026-09-08)

**Post-freeze record, not an analysis** (roadmap §8 permits verdict and schedule records;
this is a schedule record). It plans the *remaining* work only. Everything already built is
recorded in [`DONE.md`](../../DONE.md); the open board is [`TODO.md`](../../TODO.md); the
release gate is [`RELEASE.md`](../../RELEASE.md). Where this document and those disagree,
`RELEASE.md` wins on what "done" means and `TODO.md` wins on current status.

## 0. What "100%" means here

**100% = `v1.0.0` tagged on `main` by 2026-12-01 (KC-4) with every box in `RELEASE.md`
ticked — including the `[HUMAN]` ones — and `TODO.md` holding nothing but v2.0 (KC-5) items
and consciously deferred work.**

Two things are *not* in that 100% by design, and the release notes say so instead of
hiding it:

| Deliberately outside v1.0 | Why | Re-entry trigger |
|---|---|---|
| WP-IN11 contingent outbox | JSONL self-reconciles (probe) | sub-second liveness need, or hooks-only data |
| WP-A1…A4 alerting (v2.0) | best-path §6.1: off the critical path | **KC-5 only** — 14 consecutive days of real use + ≥3 friction-log entries wanting alerts |
| Phase 1.5 animated room, context-layer feed | cosmetic / experimental | never, unless asked |

## 1. Where the last 15% actually is

Measured on 2026-09-08 (HEAD `40f1524` + 133 uncommitted files, +15 161 / −1 068):

- **Agent-doable code and docs: ~5%.** Eight small, disjoint items, every one already
  named in a WORKLOG "Open — not taken here" line or a `[~]` board row.
- **Owner decisions: ~3%.** Seven forks that an agent must not pick (retention values,
  the Node pin, two product/contract questions, a wording choice, two waivers).
- **Owner acts and measurements: ~7%.** Hand-labelling (LABEL-ME), the stopwatch run,
  the friction log, one rival dashboard, the release commit and tag. **No agent can do
  these**, and they are the whole difference between "code complete" and "v1.0".

Calendar: **12 weeks** to KC-4. KC-2 (2026-09-14) and KC-3 (2026-10-12) sit inside that
window and are both already satisfiable — they need ticking on the date, not work.

## 2. The decision batch — Ivan, ~30 minutes, unblocks Waves 1–2

Each row has a recommended default so the answer can be a single word. Recording the
answers in `TODO.md` (a dated line under the WP row) is the sign-off.

| # | Decision | Recommended default | Unblocks |
|---|---|---|---|
| D1 | **Commit + push the 133-file tree** (the 2026-08-25 → 09-08 defect and honesty waves) | Yes, now — CI must be green on a pushed commit before anything else is layered on | Wave 0 |
| D2 | **NODE-PIN fork** — (a) pin Node 22 or (b) support 26 | **(a)**: add `.nvmrc` = `22`, tighten `engines.node` to `>=22 <23`, say so in README. (b) costs a native rebuild + CI matrix for no v1.0 value | L6 |
| D3 | **Retention values (OPEN-1/2/3)** | `DASHBOARD_RETENTION_EVENTS_DAYS=90` · `token_usage` **never pruned** in v1.0 (keep `NO_RETENTION` for that table; the `acknowledgeCostLoss` refusal stays) · backups `DASHBOARD_RETENTION_BACKUP_DAYS=30`, `_KEEP_MIN=7` | L9 |
| D4 | **WP-U13 — does `outcomeCause` get a dashboard surface?** (~2 real `error` agents in the corpus) | Yes, minimal: the cause as text on `error` rows in the Live view and the session tree, no new view, no colour | L5 |
| D5 | **WP-U14 — CD-5 contract for unknown SSE event types** | Closed union: add a typed `ingest-failed` arm, **delete** `GenericRealtimeEventSchema`; an unknown `type` is dropped client-side and counted, never rendered. Document in `docs/site/usage/api.md` | L4 |
| D6 | **SS-1 wording** — how loud is a never-connected stream? | Chip reads `○ reconnecting (attempt N)` from the second failed attempt on; N comes from a real `SseClient` channel, not a view-local flag | L3 |
| D7 | **The two KC-0 physical acts** — do or waive | **Do them in Wave 3**: the 14-day friction log doubles as the KC-5 evidence base, so it is not wasted motion. If waived, write the waiver into `RELEASE.md` §0 before tagging | Wave 3 |
| D8 | **LABEL-ME commit caveat** — `spike/` is git-excluded, so committed annotations lose their substrate | Commit the filled `annotations/human/` files plus a README note; CI keeps reporting "substrate unavailable" honestly, and the local ratified number is recorded in `DONE.md` with date and n | L10 |

## 3. Waves

Coordination protocol as at the top of `TODO.md`: one lane = one agent = its path list;
lanes in a wave are disjoint; `TODO.md` / `DONE.md` / `WORKLOG.md` / `PROJECT-STATE` /
`CLAUDE.md` are orchestrator-only; no agent runs git. Every lane ends with the seven gates
green (`gate:spawner` · `typecheck` · `lint` · `format:check` · web `build` · `test` at
100/100/100/100 in all five packages · `gate:licenses`) and a fails-before proof for any
defect it closes.

### Wave 0 — this week, closes at KC-2 (2026-09-08 → 2026-09-14)

| Lane | Owner | Paths | Exit |
|---|---|---|---|
| **W0-A** — CHANGELOG `[Unreleased]` for the uncommitted tree | agent | `CHANGELOG.md` | every user-visible change since 0.3.0 listed under Added/Changed/Fixed, in the file's existing voice |
| **W0-B** — decision batch D1…D8 | **Ivan** | `TODO.md` (dated lines) | eight one-word answers recorded |
| **W0-C** — commit + push on D1 | **Ivan** ("commit" / «пушвай») | — | CI `success` on the pushed SHA (`gh api …/actions/workflows/ci.yml/runs?branch=main&per_page=1`) |
| **KC-2 tick** | orchestrator, on 2026-09-14 | `TODO.md` KC table | Phase 1–2 exit gates re-verified green; zero velocity rebases used |

### Wave 1 — closing the code residue (2026-09-15 → 2026-09-28)

Eight disjoint lanes, dispatched together once W0-C is green.

| Lane | Paths (write) | What closes | Proof |
|---|---|---|---|
| **L1 cost-summary contract** | `apps/server/src/api/queries.ts`, `packages/shared/src/schemas/cost.ts`, `apps/server/test/api-cost*.test.ts` | `getCostSummary()` returns `sessionCount` (total, not the slice) and `hasMore`; wire schema updated | a corpus of `COST_TOP_N + 1` sessions serves `hasMore: true` and the exact count |
| **L2 cost-flow truth** | `apps/web/src/views/layout/cost-flow.ts`, `apps/web/src/views/chart-summary.ts`, `apps/web/src/views/CostView.tsx`, matching tests | `hubIsWhole` checks **both** sides (entering and leaving); `describeCostFlow` owns the hub disclosure; CV-5's hedge becomes a statement using L1's `sessionCount` (runs after L1 lands) | a hub with unbalanced ribbons can no longer earn the `all cost` label — fails-before by revert |
| **L3 SSE attempt channel** (D6) | `apps/web/src/sse.ts`, `apps/web/src/views/LiveView.tsx`, `apps/web/src/Shell.tsx`, tests | `SseClient` reports failed attempts with a count; the chip wording per D6 | attempt 1 and attempt 40 are distinguishable in the DOM |
| **L4 realtime contract** (D5) | `packages/shared/src/schemas/realtime.ts`, `apps/server/src/realtime/*`, `apps/server/test/realtime-bridge.test.ts`, `docs/site/usage/api.md` | typed `ingest-failed` arm; generic arm removed; unknown-type client rule documented | `acceptingArms` reports exactly one arm for every event the server can emit; mutation of each arm is killed |
| **L5 outcomeCause surface** (D4) | `apps/web/src/views/LiveView.tsx`, `apps/web/src/views/SessionsView.tsx`, tests | the six causes render as text on `error` rows, NULL renders as nothing (not "ok") | the `agent-outcome-errors` fixture shows each cause verbatim |
| **L6 NODE-PIN** (D2) | `.nvmrc`, `package.json` (`engines`), `README.md`, `docs/site/usage/getting-started.md` | the repo declares only what its native binding can load | `node -v` on v26 fails the `engines` check loudly at install, not at test time |
| **L7 gate docs** | `SECURITY.md`, `docs/site/security/model.md`, `docs/site/contributing/licensing.md` | the two `scripts/` gates described as widened (roots, manifests, file counts as `check-no-spawner` prints them) | numbers in the docs equal the gate's own output on the same tree |
| **L8 BENCH-SHAPE rerun** | `apps/server/bench/`, `docs/measurement/` (new `cold-replay-2026-09.md`) | `corpus-scale.ts --records/--record-bytes` at the real shape (26.19 MiB/session, 51 sessions, 2477 subagent transcripts); the number written down with its command line | the measured band replaces the synthetic 34.87–39.92 s in `TODO.md`/`DONE.md` (orchestrator) — **Ivan ratifies by ticking, the agent only measures** |

### Wave 2 — retention policy + the ratification kits (2026-09-29 → 2026-10-12, closes at KC-3)

| Lane | Paths | What closes |
|---|---|---|
| **L9 retention wiring** (D3) | `apps/server/src/retention/`, `apps/server/src/index.ts`, `apps/server/src/config.ts`, `docs/site/operations/backup-restore.md`, `docs/site/usage/configuration.md`, tests | the runner invoked on the daily backup timer with the signed policy; a dry-run report logged at boot; the `token_usage` refusal untouched; WP-D10 → `[x]` |
| **L10 LABEL-ME kit** (D8) | `packages/test-fixtures/annotations/README.md`, a read-only renderer under `packages/test-fixtures/annotations/tools/` | one page per claim: the parent line, the child line, the join path the parser used, the raw JSONL evidence — so a human judges each of the 60 claims in ~20 s. **Reads `spike/`, never writes it** |
| **L11 time-to-understand kit** | `docs/measurement/time-to-understand-log.md` (pre-filled session picks only) | five real sessions chosen by size class, the server launch line, the log rows ready for a stopwatch |
| **KC-3 tick** | orchestrator, on 2026-10-12 | P0-1/2/3 green on `main` and `ci` required by branch protection (`gh api …/branches/main/protection`) |

### Wave 3 — the owner's measurements, and real daily use (2026-10-13 → 2026-11-08)

**No new features in this window.** Agents take only defects the friction log raises;
at most one velocity rebase (roadmap §5).

| Act | Owner | Budget | Records |
|---|---|---|---|
| Fill the 60 claims in `annotations/human/`, run `pnpm --filter @agenthropic/core exec vitest run test/hierarchy-gate.test.ts` | **Ivan** | ~45 min | n, errors, Wilson lower bound → `DONE.md`; PROVISIONAL label dropped everywhere it appears (`RELEASE.md` §0, `phase0-verdict.md`, `parser-spec.md` §3, README) |
| Stopwatch run per `docs/measurement/time-to-understand-protocol.md` on the five sessions | **Ivan** | ~30 min | signed rows in `time-to-understand-log.md` → `RELEASE.md` §6 |
| Friction log, 14 consecutive days of real use | **Ivan** | passive | best-path §9 dates; entries become Wave-3 defect lanes; the same 14 days are the KC-5 evidence |
| Install one free rival dashboard, ask it the five questions | **Ivan** | ~1 h | result in the friction log; if it answers ≥4/5, say so in the release notes — the tag decision stays Ivan's |
| Defect lanes from the log | agents | as needed | each one: fails-before proof, seven gates, WORKLOG |

### Wave 4 — release candidate (2026-11-09 → 2026-11-22)

| Lane | Owner | What |
|---|---|---|
| **R1 mechanical release pass** | agent | `RELEASE.md` §1–§3, §5 automated proof, §6 dollar-trace proof — every command run, real exit codes pasted into the WORKLOG |
| **R2 docs truth pass** | agent | `README.md`, `docs/site/guide/roadmap.md` (the "as built" box), `docs/analysis/PROJECT-STATE-*` snapshot, `docs/analysis/README.md` bar paragraph, `CHANGELOG.md` `[1.0.0]`, `DONE.md` v1.0 milestone entry, `package.json` `0.3.0 → 1.0.0` |
| **R3 human boxes** | **Ivan** | `RELEASE.md` §0 (KC check, LABEL-ME ratified or PROVISIONAL stated, the two acts done or waived), §4 COPY-with-attribution review, §5 live backup→restore drill on the real DB, §6 usability signature |

### Wave 5 — tag (2026-11-23 → 2026-12-01 = KC-4; one week of buffer)

**Ivan:** release commit, `v1.0.0` tag, push. **Orchestrator, post-tag:** CI green on the
tag ref, Pages deploy green, badges resolve, `DONE.md` closed, `TODO.md` reduced to the
KC-5 items — and the public write-up the roadmap asks for either way.

## 4. Effort

- **Agent work:** 8 + 3 + 2 lanes, each a half-day or less; with parallel dispatch roughly
  **two working weeks** of wall-clock inside a twelve-week window.
- **Ivan's work:** ~30 min of decisions, ~2.5 h of measurement and labelling, ~1 h with a
  rival, the release acts (~1 h) — **about five hours in total**, plus 14 days of simply
  using the dashboard.

The critical path is not code. It is D1 → Wave 3's 14 days → R3. Start the log on
2026-10-13 and the buffer week survives; start it on 2026-11-09 and it does not.

## 5. Descope ladder, if Wave 3 slips (roadmap §5, unchanged)

1. L5 (outcomeCause surface) and L3 (attempt counter) are cosmetic — drop first.
2. L9 can ship with the policy signed but the timer off (`NO_RETENTION` stays the
   default; the values are documented, not executed).
3. LABEL-ME **cannot** be descoped into a tick — it can only be descoped into the honest
   word PROVISIONAL in the release notes, which `RELEASE.md` already requires.
4. **Forbidden descopes** stay forbidden: the security invariants, ground-truth tokens,
   the persisted DAG, 100% coverage, the three P0 proofs.
