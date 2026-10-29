# 00 — Baseline: what agenthropic is on 2026-10-29

> Part of the [role reviews of 2026-10-29](README.md). Measured on `main` at `db3f042`
> (clean tree, 5 commits ahead of `origin/main`). Every number here was taken on that tree
> on that date; nothing is copied forward from an older snapshot.

## 1. The product in one paragraph

A self-hosted, local-first dashboard that observes Claude Code agent and subagent activity on
the owner's Mac Mini M4. It reads the JSONL transcripts in `~/.claude/projects/` (token counts
are ground truth, never inferred), receives Claude Code hook events, and turns both into two
things no rival offers together: a **persisted, cross-session subagent DAG** (agents are
first-class rows with a self-referential `parent_agent_id`) and **dollar-accurate cost
attribution** (tokens × dated price per model and bucket). It is bound to `127.0.0.1` only,
token-gated, has no browser-driven process spawner, and is reached remotely only through an
SSH/Tailscale tunnel.

## 2. Code

| Package | Source (lines / files) | Tests (lines / test files) | Role |
|---|---|---|---|
| `apps/server` | 15,796 / 57 | 44,601 / 132 | Fastify + TypeBox, better-sqlite3 (WAL), ingest, projection, cost, SSE, hook receiver, retention, alerts |
| `apps/web` | 10,616 / 34 | 18,214 / 27 | React/Vite/D3 SPA — Live, Sessions, DAG, Cost views |
| `packages/core` | 2,427 / 13 | 5,941 / 21 | Pure projection logic |
| `packages/shared` | 1,862 / 18 | 1,534 / 9 | DTOs and TypeBox schemas shared by server and web |
| `packages/test-fixtures` | 4,341 / 21 | 2,303 / 6 | Synthetic corpora and annotations |
| **Total** | **~35,000 / 143** | **~72,600 / 195** | Test code is ~2.1× the source |

- **Schema:** 24 migrations in a single `apps/server/src/db/migrations.ts` (2,005 lines);
  `events_raw` is append-only, enforced by triggers. Migration 24 (2026-10-28) priced
  `claude-sonnet-5-5`; `claude-haiku-5-5` stays unseeded by owner decision.
- **Largest modules:** `apps/server/src/db/migrations.ts` (2,005), `apps/server/src/api/queries.ts`
  (2,003), `apps/web/src/views/CostView.tsx` (1,596).
- **Gates (8):** `gate:node`, `gate:spawner`, `typecheck`, `lint`, `format:check`, web build,
  `test` (100% statements/branches/functions/lines in all five packages, pragma-free),
  `gate:licenses`. Result of the run on this date: see [README.md](README.md) §"Gate on the
  review date".
- **Version:** `0.3.0` everywhere. The `1.0.0` bump, the `CHANGELOG` `[1.0.0]` section and the
  `DONE.md` v1.0 entry are acts of the release commit.

## 3. Documentation

- 207 Markdown files, ~481,000 words in the repository (including `due-diligence/` and the
  public `docs/site/`; excluding `docs/ai/`). The analysis corpus alone is 20 documents.
- Board files: `TODO.md` 1,375 lines (13 open, 7 in progress, 67 done rows), `DONE.md` 783,
  `CHANGELOG.md` 930, `RELEASE.md` 446 lines with **41 open and 3 ticked boxes**.
- Public docs site: <https://ivanbbaev.github.io/agenthropic/> (`docs/site/`, 6 sections,
  ~30 pages).

## 4. Schedule position

| Checkpoint | Date | State on 2026-10-29 |
|---|---|---|
| KC-0 | 2026-07-13 | Passed **unmet**; overridden by the owner (2026-07-18) |
| KC-1 | 2026-07-27 | Passed **unmet** (friction log never opened); overridden (2026-07-29) |
| KC-2 | 2026-09-14 | **Met** (ticked late, 2026-09-18) |
| KC-3 | 2026-10-12 | Condition **met**; the tick is still the owner's |
| **KC-4** | **2026-12-01** | **v1.0.0 tag — 33 days away; the date does not move** |
| KC-5 | earned | v2.0 entry: 14 days of daily use + ≥3 friction-log entries wanting alerts — not satisfiable yet |

The closing plan is in Wave 3 (2026-10-13 → 2026-11-08, "Ivan's, no new features"). The
branch-lane split of 2026-10-28 closed lanes L7–L10; **L1–L6 are the owner's physical acts**
(friction log, rival install, LABEL-ME, the stopwatch run, BENCH-SHAPE, the backup→restore
drill) and L11 is a peer lane. The v2.0 alerting core (Telegram sink) was built under the
2026-10-24 owner override and **ships dark** in v1.0.0 (RELEASE §4, decided 2026-10-29).

## 5. What is not yet known

These are the facts no amount of code produces, and they are exactly what is still open:

1. **Is the hierarchy accurate?** The ≥95% gate reports `NOT CERTIFIED` until ≥52 agents are
   hand-labelled (LABEL-ME). Every Phase-0 number is PROVISIONAL.
2. **Is it fast to understand?** The "<30 s to understand a session" claim is unmeasured.
3. **Is it used?** The 14-day friction log was never opened; there is no daily-use evidence.
4. **Is it better than the alternatives?** No rival dashboard has been installed and tried.
5. **Does restore work on the real database?** The RELEASE §5 drill is an open `[HUMAN]` box.

## 6. Owner overrides on record

| Date | Override | Scope |
|---|---|---|
| 2026-07-06 | Analysis #9 (the roadmap) despite red-team §11 | One document |
| 2026-07-11 | Implementation start despite CD-8 | Dispatching only |
| 2026-07-18 | Continue past failed KC-0 | Dispatching only |
| 2026-07-29 | Continue past failed KC-1 | Dispatching only |
| 2026-10-24 | Build the v2.0 alerting core before KC-5 | A1–A7 + A10 implementation only |
| **2026-10-29** | **These role reviews despite the roadmap §8 analysis freeze** | **This review set only** |
