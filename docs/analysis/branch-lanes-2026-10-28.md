# Branch lanes — the remaining v1.0 work, split for parallel branches (2026-10-28)

> **What this is.** An execution plan, not an analysis: it re-cuts the open rows of
> [`TODO.md`](https://github.com/IvanBBaev/agenthropic/blob/main/TODO.md) (Wave 3 → Wave 5 of the
> [closing plan](closing-plan-2026-09-08.md)) into lanes that can each live on their own branch
> at the same time without merge conflicts. It adds no work, no decision and no finding; the
> roadmap §8 analysis freeze is unaffected. Where it and `TODO.md` disagree on _what_ a row
> requires, `TODO.md` wins; this file only governs _who writes which file on which branch_.
>
> **State on 2026-10-28** (inside Wave 3, 2026-10-13 → 2026-11-08; KC-4 = 2026-12-01): `main`
> at `ba4aaa8`, clean tree, 195 test files / 3747 tests green, 100% coverage in five packages.
> Every remaining row needs Ivan — an act, a measurement or a decision. Agents can scaffold,
> verify and write up, but never tick a box that says `[HUMAN]`.

## 1. Rules every lane follows

1. **One lane = one branch = one worktree**, created from current `main`:

   ```sh
   git worktree add ~/Development/_branches/agenthropic-<tag> -b lane/<tag>
   cd ~/Development/_branches/agenthropic-<tag> && pnpm install
   ```

   Never `../agenthropic-<tag>`, never under `.claude/worktrees/`. Node 22 (`node -v` first).

2. **Write only inside the lane's write set** (§3). Reading anything is fine. A change that
   needs a file outside the set is not made in the lane — it goes in the lane's hand-off note
   (rule 7) and the integrator makes it on `main`.

3. **Hot files have one writer — the integrator, on `main`.** No lane edits:
   - `RELEASE.md`, `CHANGELOG.md`, `DONE.md`, `README.md`, root `package.json`, `pnpm-lock.yaml`;
   - `docs/analysis/PROJECT-STATE-2026-07-06.md`, `docs/analysis/open-decisions.md`;
   - the **test-count chains** (`195 test files / 3747 tests` and their dated predecessors) in
     `docs/site/README.md`, `docs/site/contributing/index.md`, `docs/site/contributing/testing.md`,
     `docs/site/guide/{comparison,faq,roadmap,what-is-agenthropic}.md` — a lane that adds tests
     leaves every count alone; one count pass runs on `main` in R2.

   **One exception:** a lane may edit **its own row** in `TODO.md` (the row named in §3) and no
   other line. Rows are far apart, so these hunks merge cleanly.

4. **No new dependencies** in any lane (the lockfile is a hot file). **Migrations:** the next
   free id is **24**, reserved for lane L7. Any other lane that finds it needs a migration stops
   and asks — two lanes picking the same id is a guaranteed conflict and a checksum break.

5. **Gate before merge**, run inside the worktree after rebasing on `main`:

   ```sh
   git fetch . main:main 2>/dev/null; git rebase main
   pnpm run typecheck; echo EXIT=$?
   pnpm run lint; echo EXIT=$?
   pnpm run format:check; echo EXIT=$?
   pnpm run test; echo EXIT=$?
   pnpm --filter @agenthropic/web build; echo EXIT=$?
   pnpm run gate:spawner; echo EXIT=$?
   pnpm run gate:licenses; echo EXIT=$?
   pnpm run gate:node; echo EXIT=$?
   ```

   A docs-only lane may skip the build and the test run, never `format:check`. On a loaded
   machine (load average ≫ 12) wait before the full test run — 5 s Vitest timeouts under load
   are not real failures, but they must be re-run green, not waived.

6. **Finish the same session it merges:** commit on the lane branch → `git checkout main` in the
   main checkout → `git merge --ff-only lane/<tag>` → `git worktree remove
   ~/Development/_branches/agenthropic-<tag>` → `git branch -d lane/<tag>`. Never leave a
   worktree or an unmerged branch behind. **Push only on Ivan's explicit ask.** No AI
   attribution; staged diff checked for secrets before every commit; harness files
   (`CLAUDE.md`, `WORKLOG.md`, `.claude/`, `docs/ai/`) never staged.

7. **Hand-off note.** A lane that needs a hot-file change ends with a short note in its last
   commit message body, under the heading `Integrator:` — e.g. "tick RELEASE §0 LABEL-ME;
   CHANGELOG Unreleased: …". The integrator applies it on `main` right after the merge, as its
   own commit.

8. **Security invariants bind every lane** (loopback-only bind, mandatory token, auth on every
   endpoint, SSE same-origin, no browser-driven spawner, corpus read-only, WAL, tokens read
   never inferred). Nothing here relaxes them, the KC calendar or the LABEL-ME ratification.

## 2. Lane map at a glance

| Lane | What | Who | Branch | Starts | Conflicts with |
|---|---|---|---|---|---|
| L1 | Friction log, 14 consecutive days | Ivan | `lane/friction-log` | now | — |
| L2 | One rival dashboard, the five daily questions | Ivan | `lane/rival` | now | — |
| L3 | LABEL-ME: fill the 60 hierarchy claims (WP-X2) | Ivan | `lane/label-me` | now | — |
| L4 | Drop PROVISIONAL after LABEL-ME | agent | `lane/provisional` | after L3 merges | **every docs lane** — exclusive window |
| L5 | Stopwatch: time-to-understand on five sessions | Ivan | `lane/stopwatch` | now | — |
| L6 | BENCH-SHAPE ratification (cold replay) | Ivan | `lane/bench-shape` | now | — |
| L7 | WP-C1 pricing ratification (+ migration 24 if a rate moves) | Ivan + agent | `lane/pricing` | now | — |
| L8 | D9 / WP-U13 UI half (Live view cause) | Ivan decides; agent builds if "yes" | `lane/d9-live-cause` | after D9 answer | — |
| L9 | D15: throwaway coverage-drop PR, red CI recorded | agent, on Ivan's go-ahead (needs a push) | `lane/d15-coverage-drop` | after go-ahead | — (never merged) |
| L10 | RELEASE §4: ship the alerting core dark or remove it | Ivan decides; agent applies | `lane/alerts-ship` | after §4 answer | L11 if "remove" |
| L11 | Alerting-core hardening (the peer session's current work) | agent | `lane/alerts-hardening` | ongoing | L10 "remove" variant |
| INT | Integrator: hot files, count pass, R1/R2 | agent, on `main` | — (`main`) | after each merge | — |
| R3 / W5 | `[HUMAN]` release boxes, release commit, tag, push | Ivan (+ INT) | — (`main`) | after every lane above has merged | everything — serial |

Everything marked "now" can run at the same time.

## 3. Lanes

### L1 — Friction log _(TODO: Step 0 "Open the friction log"; Wave 3)_

- **Write set:** `docs/measurement/friction-log.md` (new file), plus the start/end dates the
  Step-0 row asks for in `docs/analysis/best-path-decision.md` §9 (that section only).
- **Work:** one dated entry per day of real use — date, the question you had, what the
  dashboard answered or failed to answer, time spent. Fourteen **consecutive** days; a gap
  restarts the count. Commit on the branch as you go; merge once at the end (or every few days —
  the file is the lane's own, so merges stay clean).
- **Done when:** 14 consecutive dated entries. **Integrator:** tick RELEASE §0 KC-0 act
  (friction half) after Ivan's yes; note the count of entries that want alerts — that is the
  KC-5 evidence.

### L2 — Rival dashboard _(TODO: Step 0 "Install ≥1 free rival dashboard"; Wave 3)_

- **Write set:** `docs/measurement/rival-dashboard-2026-10.md` (new file).
- **Work:** install one free rival (best-path action 2 names `claude-code-templates --analytics`),
  ask it the five daily questions, record for each: answered / partly / no, and the time.
  The rival runs outside this repo; nothing it installs lands in the tree.
- **Done when:** five answers recorded. **Integrator:** tick the rival half of RELEASE §0.

### L3 — LABEL-ME _(TODO: WP-X2; RELEASE §0 and §3 "Hierarchy correctness ≥95%")_

- **Write set:** `packages/test-fixtures/annotations/human/**` only. The templates in
  `annotations/templates/` are read, never edited.
- **Work:** fill the `__________` blanks of the 60 claims, save into `annotations/human/`, then:
  `pnpm --filter @agenthropic/core exec vitest run test/hierarchy-gate.test.ts`. The gate needs
  n ≥ 52 with zero errors (≈ n ≥ 90 to survive one error). The 60 claims are Ivan's ground
  truth — an agent may explain a claim, never fill one.
- **Done when:** the gate passes on the human files. **Integrator:** tick LABEL-ME and the
  hierarchy box; then open L4.

### L4 — Drop PROVISIONAL _(Wave 3 "drop PROVISIONAL"; follows L3)_

- **Write set:** every tracked file carrying the word for **spike / hierarchy** numbers (62
  files mention `PROVISIONAL` on 2026-10-28, across code comments, site pages and analysis docs).
- **Why exclusive:** that set overlaps nearly every docs page, so this lane runs in a
  **short window when no other docs-writing lane is open** (L1/L2/L5/L6 write only their own
  new or measurement files and may stay open; L7, L8, L10, L11 must be merged or paused). Do it in
  one session, merge the same day.
- **Work:** classify each hit first — the pricing seed's PROVISIONAL belongs to WP-C1 (L7) and
  stays until L7 ratifies; only the hits that LABEL-ME settles are dropped, each as a dated
  "Amended" note, never a silent delete. Checksummed migration SQL is not edited.
- **Done when:** the classification list is in the commit body and the grep shows only the
  hits deliberately kept.

### L5 — Stopwatch _(Wave 3 "stopwatch run on five sessions"; RELEASE §6 `[HUMAN]` five questions < 30 s)_

- **Write set:** `docs/measurement/time-to-understand-log.md` only.
- **Work:** follow `docs/measurement/time-to-understand-protocol.md` on five real sessions;
  record each time. Agent help is limited to running `scripts/time-to-understand.mjs` and
  reading the protocol aloud — the stopwatch is Ivan's.
- **Done when:** five timed rows. **Integrator:** RELEASE §6 box stays for Ivan to tick.

### L6 — BENCH-SHAPE _(TODO: BENCH-SHAPE row)_

- **Write set:** `docs/measurement/cold-replay-2026-09.md`, a new
  `docs/measurement/runs/<date>/` directory if Ivan reruns, and the BENCH-SHAPE row in
  `TODO.md`. `apps/server/bench/corpus-scale.ts` is **not** edited in this lane.
- **Work:** Ivan accepts the 2026-09-09 runs (81.68–92.29 s at the real shape) or reruns them;
  either way the file's "UNRATIFIED" banner becomes a dated ratification.
- **Done when:** the banner is gone. **Integrator:** the file's §7 lists every line elsewhere
  (README, site pages) that changes with the number — those edits are made on `main`, not here.

### L7 — Pricing ratification _(TODO: WP-C1 ratification tick; RELEASE §6 pricing re-read)_

- **Write set:** `apps/server/src/db/migrations.ts` (**migration 24 only**, if a rate moves),
  `apps/server/test/` migration and checksum suites, the dollar expectations that read a moved
  rate, `docs/site/architecture/cost-model.md`, and the WP-C1 row in `TODO.md`.
- **Work:** Ivan re-reads the official pricing page; an agent compares it with the seed. No rate
  moves → no code, only the dated ratification note. A rate moves → migration 24 with the
  upsert-on-PK pattern of migration 20, checksum re-pinned in both suites, every affected dollar
  test re-derived by hand.
- **Done when:** the seed's PROVISIONAL is dropped by a dated note. **Integrator:**
  CHANGELOG line if a rate moved.

### L8 — D9 / WP-U13 UI half _(TODO: WP-U13 row, D9)_

- **Decision first (Ivan):** D9 — a session-level cause in the Live view. Recommended
  default: **no for v1.0** (the session tree already shows every cause).
- **"No":** no branch. The integrator records the answer in the WP-U13 row and closes it.
- **"Yes" — write set:** the sessions DTO in `packages/shared/src/schemas/`, the sessions query
  in `apps/server/src/api/queries.ts`, `apps/web/src/views/LiveView.tsx`,
  `apps/web/src/views/live-model.ts`, and their tests; `docs/site/usage/api.md` and
  `docs/site/usage/dashboard.md` paragraphs on the sessions payload / Live view. No migration
  (the column exists since migration 17). Coverage stays 100%.

### L9 — D15 coverage-drop demonstration _(TODO: D15, decided (a) 2026-09-30)_

- **Needs Ivan's explicit go-ahead**, because it pushes a branch and opens a PR.
- **Branch:** `lane/d15-coverage-drop`, one commit that removes a test so coverage drops below
  100%. Push, open the PR, record the red `ci` run URL, **close the PR without merging**,
  delete the branch locally and on GitHub. This is the one lane that is never merged.
- **Write set of the record:** `docs/measurement/d15-coverage-gate-demo.md` (new), committed on
  a short `lane/d15-record` branch (or directly by the integrator) — PR number, run URL, the
  failing threshold line, date.
- **Done when:** the record is on `main`. **Integrator:** D15 row and the WP-X5 clause closed.

### L10 — RELEASE §4: the alerting core in v1.0.0 _(RELEASE §4 `[HUMAN]` box)_

- **Decision first (Ivan):** ship the core **dark** (off unless `DASHBOARD_ALERTS_CONFIG` is set)
  — recommended — or **remove** it from the tagged tree.
- **"Dark":** no branch. The integrator writes the decision into RELEASE §4 / §7 and the
  CHANGELOG release-notes draft.
- **"Remove" — write set:** `apps/server/src/alerts/**`, `apps/server/src/db/alerts.ts`, the
  alerts wiring in `apps/server/src/index.ts`, `apps/server/test/alerts-*.test.ts`,
  `packages/shared/src/{ports/alert-sink.ts,schemas/alerts.ts,testing/in-memory-alert-sink.ts}`,
  `packages/shared/test/alerts-schema.test.ts`, `docs/site/usage/telegram.md`. Migration 23
  stays (a shipped migration is never deleted; its tables simply go unused). **Exclusive with
  L11** — the two write the same files; L11 merges or stops first.

### L11 — Alerting-core hardening _(the peer session's lane)_

- **Write set:** the same alert files as L10's "remove" list, plus the alert sections of
  `SECURITY.md` / `docs/site/security/*` **through the integrator** (hot or shared pages).
- **Work:** whatever defects the peer session is closing (five landed 2026-10-27/28:
  config-permission refusal, throttled-target fairness, shutdown waits for in-flight delivery,
  bidi / zero-width id sanitising, docs). No new alert features — KC-5 has not been earned.

### INT — Integrator, on `main`

- Owns every hot file in rule 3. After each lane merge: apply its `Integrator:` note as one
  commit. Runs **R1** (the mechanical RELEASE §1–3/5/6 pass) and **R2** (docs truth pass, one
  test-count pass, `CHANGELOG [1.0.0]`, `DONE.md` milestone, `0.3.0 → 1.0.0`) only after all
  Wave 3 lanes have merged — R2's count pass is the reason lanes never touch counts.

### R3 / Wave 5 — serial, on `main`, after every lane

- R3 `[HUMAN]` boxes: COPY-with-attribution review, live backup → restore drill on the real
  database (keep the pre-tag backup), usability signature, pricing re-read + real-corpus boot.
- Wave 5: release commit, `v1.0.0` tag, push — Ivan's explicit act; post-tag CI / Pages /
  badges green; `TODO.md` reduced to the KC-5 items.

## 4. Who writes what — the overlap check

| File or area | Only writer |
|---|---|
| `docs/measurement/friction-log.md` | L1 |
| `docs/measurement/rival-dashboard-2026-10.md` | L2 |
| `packages/test-fixtures/annotations/human/**` | L3 |
| `docs/measurement/time-to-understand-log.md` | L5 |
| `docs/measurement/cold-replay-2026-09.md`, `runs/<new date>/` | L6 |
| `apps/server/src/db/migrations.ts` (id 24), pricing tests, `cost-model.md` | L7 |
| sessions DTO / query, `LiveView.tsx`, `live-model.ts` | L8 |
| `docs/measurement/d15-coverage-gate-demo.md` | L9 |
| `apps/server/src/alerts/**`, `db/alerts.ts`, shared alert files, `usage/telegram.md` | L11, then L10 ("remove" only) |
| PROVISIONAL hits across the tree | L4, in its exclusive window |
| Hot files (rule 3) | INT |
| Own `TODO.md` row | that lane |

No path appears twice except the two pairs that are serialised on purpose (L10/L11, L4/all).

## 5. Order of merges

```text
now ─┬─ L1 friction (14 days) ─────────────┐
     ├─ L2 rival ──────────────────────────┤
     ├─ L3 LABEL-ME ── L4 PROVISIONAL ─────┤
     ├─ L5 stopwatch ──────────────────────┤
     ├─ L6 BENCH-SHAPE ────────────────────┤
     ├─ L7 pricing ────────────────────────┤   INT: R1 + R2   R3 [HUMAN]   Wave 5
     ├─ L8 D9 (if "yes") ──────────────────┼──► (2026-11-09) ─► ──────────► tag by
     ├─ L9 D15 (on go-ahead) ──────────────┤                                2026-12-01
     ├─ L11 alerts hardening ── L10 (§4) ──┘
```

The critical path is L1, and it is already late: Wave 3 ends 2026-11-08, so a fourteen-day
run had to start by 2026-10-26. Started on 2026-10-28 it ends 2026-11-10, two days into Wave 4;
every further day of delay comes out of the one-week buffer before KC-4.