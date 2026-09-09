# TODO — the assignment board

Open work for **agenthropic**, keyed to the work packages (WPs) in
[`docs/analysis/development-plan.md`](docs/analysis/development-plan.md) as amended by
[`best-path-decision.md`](docs/analysis/best-path-decision.md) §6 (applied 2026-07-06).
Completed milestones move to [`DONE.md`](DONE.md). Context-free session? Read
[`docs/analysis/PROJECT-STATE-2026-07-06.md`](docs/analysis/PROJECT-STATE-2026-07-06.md) first.

> **Status:** `[ ]` open · `[~]` in progress · `[x]` done (then move to `DONE.md`).
> **No production code starts until `WP-S7` reads GO** — that gate (CD-8) is encoded as
> `WP-F1 → WP-S7`. **v1.0 = the DAG + cost cockpit answering the five daily questions —
> no alerts** (best-path §6.1).
> **⚠️ OWNER OVERRIDE 2026-07-11:** Ivan explicitly instructed implementation start in
> chat ("пускай агенти и започвай да имплементираш") after being repeatedly informed that
> CD-8's remaining conditions (LABEL-ME ratification of the CONDITIONAL GO; KC-0's two
> physical boxes) were the block. Per the instruction-precedence rules, an explicit
> current-chat owner instruction outranks this board — **scaffolding began 2026-07-11.**
> The override does NOT touch: the security invariants, the KC calendar (KC-0's two open
> boxes below are still Ivan's, deadline 2026-07-13), the LABEL-ME ratification (numbers
> stay PROVISIONAL), or the no-commit-without-explicit-ask rule.
> **⚠️ OWNER OVERRIDE 2026-07-18:** KC-0's date (2026-07-13) passed with its two physical
> boxes still unchecked — the default branch is archive. Ivan explicitly instructed in chat
> ("пускай Fable агенти и довършвай роудмапа") that implementation work continue; per the
> instruction-precedence rules that explicit current-chat instruction outranks the default.
> The override covers DISPATCHING ONLY: the two physical acts (open the friction log;
> install ≥1 rival dashboard) remain Ivan's and remain open, KC-1 (2026-07-27) still turns
> on the friction log, nothing is archived, and all other invariants stay intact.
> **⚠️ OWNER OVERRIDE 2026-07-29:** KC-1's date (2026-07-27) also passed unmet. Two of its
> three clauses were satisfied long ago (the WP-S7 verdict is written; the THROWAWAY
> DAG-with-dollars render exists), but the third — "the friction log has not crowned a
> rival" — was never *satisfiable*, because the log was never opened; an unopened log
> cannot report a reading. The default branch is therefore archive. Ivan again instructed
> in chat ("пускай агенти и довършвай роудмапа") that work continue. Same scope as the
> two overrides above: **dispatching only.** Nothing is archived, nothing is committed,
> the physical acts stay open and stay Ivan's, the numbers stay PROVISIONAL, and the
> security invariants are untouched.
> **Schedule of record:** [`roadmap-v1-v2-2026-07-06.md`](docs/analysis/roadmap-v1-v2-2026-07-06.md)
> — kill checkpoints **KC-0…KC-5 with default-death**. Gate A signs by **2026-07-13**
> (KC-0) or the project archives by default; **v1.0 hard date 2026-12-01** (KC-4).
> Check today's date against the KC calendar below before dispatching anything.

---

## How to run this board with parallel agents (the coordination protocol)

An orchestrating session (any model) dispatches the lanes below to parallel subagents.
The rules that keep them from colliding:

1. **One lane = one agent = the listed path ownership.** An agent WRITES only inside its
   lane's paths; it may READ anything in the repo.
2. **Orchestrator-only files:** `TODO.md`, `DONE.md`, `WORKLOG.md`,
   `docs/analysis/PROJECT-STATE-*.md`, `CLAUDE.md`. Lane agents never edit these — they
   return a report; the orchestrator updates the trackers and writes the WORKLOG entry.
3. **Lanes in the same wave are disjoint by construction** — dispatch them concurrently.
   A lane whose dependency WP is not `[x]` must not start.
4. **Spike lanes are read-only against `~/.claude/projects`** — never write, move or
   "fix" real transcripts. All spike output stays under `spike/` and is labeled
   THROWAWAY (it dies after WP-S7; nothing under `spike/` is production code).
5. **No agent runs git commands.** Committing is Ivan's explicit call, always.
6. Everything written is **English**; security invariants (bottom of this file) bind
   every lane; if a probe needs a listener (it shouldn't), loopback + token, no exceptions.

---

## Step 0 — Gate A + the KC signature _(Ivan; blocks the spike lanes; **deadline 2026-07-13 = KC-0, sign-or-archive**)_

Per the schedule of record ([`roadmap-v1-v2-2026-07-06.md`](docs/analysis/roadmap-v1-v2-2026-07-06.md)
§8), signing Gate A and the KC schedule can be one act. A dated deferral note is **no
longer a valid third state** — KC-0's failure branch is archive.

- [x] **Approve CD-1…CD-10** ([`concept-analysis-v2.md`](docs/analysis/concept-analysis-v2.md) §3)
  and **LB1/LB2** (§2). The plan is recommendation-only until signed. (date: **2026-07-10**)
- [x] **Accept the KC schedule** — the roadmap §4 checkpoints, **including default-death**.
  (date: **2026-07-10**)
- [ ] **Open the friction log** (add start/end dates to best-path §9) — runs concurrently
  with Phase 0; its day-14 reading is a KC-1 kill clause. **← Ivan's own act; still open.**
- [ ] **Install ≥1 free rival dashboard** and try the five daily questions against it
  during the log window — the cheapest experiment, never yet run (red-team §6). If a
  rival answers **≥4 of 5 acceptably**, KC-1 fires regardless of the spike verdict.
  **← Ivan's own act; still open.**
- [x] **Approve running Phase 0** (the throwaway feasibility spike below). (date: **2026-07-10**)

> **Gate A is PARTIALLY signed (2026-07-10).** The three decision boxes are signed, which
> authorizes Phase 0 to run — the spike lanes below are unblocked as of today. **KC-0 is
> NOT yet satisfied:** its stay-alive condition is *all five* Step-0 boxes checked by
> **2026-07-13**. The two remaining boxes are physical acts only Ivan can perform (start
> the friction log; install and try a rival dashboard). If they are still `[ ]` on
> 2026-07-13, KC-0's default branch — archive — fires regardless of spike progress.

**Also parked with Ivan (not blocking, decide any time):** approve `LICENSE` (MIT —
PROC-4; a standard MIT `LICENSE` draft, © 2026 Ivan Baev, now sits in the tree
uncommitted — approving means asking for it to be committed, or request a different
license and it gets replaced). _(Committing the docs is **done** — first commit `9dfcc9c` pushed to the PUBLIC
origin 2026-07-11; future commits/pushes still need an explicit ask. The former "pick a
red-team exit" item is **retired**: the KC table replaced the exit choice — Exit B is
absorbed into Phase 0 inside CD-8, Exit A is every checkpoint's failure branch, Exit C
is eliminated by the KC-0 deadline.)_

## The KC calendar — check today's date against this FIRST

Binding once Step 0 is signed; dates from roadmap §4. Every failure branch is the
**default** — it executes without a meeting, a reassessment, or a new analysis.

| Checkpoint | Date | Stay-alive condition | On failure (the default) |
|---|---|---|---|
| **KC-0** | **2026-07-13** | All Step-0 boxes above checked | Archive — **DATE PASSED UNMET (2 of 5 boxes open); default overridden by owner instruction, see above** |
| **KC-1** | **2026-07-27** | WP-S7 verdict written **+** the THROWAWAY DAG-with-dollars render exists **+** the friction log has not crowned a rival (≥4/5 questions) | Archive — **DATE PASSED UNMET: clauses 1 and 2 green, clause 3 unsatisfiable (log never opened); default overridden by owner instruction, see above** |
| **KC-2** | **2026-09-14** | Phase 1–2 exit gates green; at most **one** velocity rebase applied | Descope ladder (roadmap §5) or archive |
| **KC-3** | **2026-10-12** | The three P0 moat proofs green & merge-blocking — _the merge-blocking half became satisfiable on **2026-08-25**, when `main` started requiring the `ci` check; it blocks a contributor, not the owner (`enforce_admins: false`). Not yet due; do not tick early._ | Archive |
| **KC-4** | **2026-12-01** | **v1.0 tagged. The date does not move.** | Archive + public write-up |
| **KC-5** | earned, not dated | 14 consecutive days of real daily v1.0 use + ≥3 friction-log entries wanting alerts | v2.0 cancelled; maintenance mode |

**Agent rules at a failed checkpoint:** no agent ever archives, deletes, `git`-resets or
`rm`s anything — "archive" is Ivan's manual act. A session that finds a KC date passed
unfulfilled does exactly three things: **(1)** report the failed checkpoint and its
default branch, **(2)** stop dispatching new work, **(3)** decline new analysis (the
roadmap §8 freeze) and new code. Only Ivan's explicit instruction in chat overrides a
default.

### Empirical prelude — the desktop Phase-0 probe already ran _(2026-07-04)_
A read-only probe of the real `~/.claude/projects` corpus **pre-answers CD-1**:
[`phase0-probe.md`](docs/analysis/phase0-probe.md) → **`CONDITIONAL-GO → build`, confidence 85**
(depth-1 = 0%-orphan hard key · depth-2 recovers 100% · 100% of tokens attribute to an
`agentId` · Σ summed from child transcripts). This **de-risks but does not replace** the formal
spike (WP-S1/WP-S5 still need the paired-capture corpus + Ivan's tree sign-off). It hands
Track S an **11-item parser-requirements acceptance gate** — the reconstructor is GREEN only
when it: (1) keys spawns on **`Agent`/`Workflow`, never `Task`** (0 `Task` blocks exist);
(2) walks **both** layouts (flat + nested `workflows/wf_*`; nested = 85%); (3) uses two join
schemas; (4) indexes subagents as **parents** (self-referential); (5) joins on structural
block-id equality, never substring; (6) **sums tokens from child transcripts** (parent rollup
≈0%); (7–11) legacy `2.1.70` fallback · compaction resets (63/117) · concurrency-safe on
`session-uuid`+timestamps (92/117 overlap) · version detection but **branch on directory
shape** · intra-workflow edge reconstruction via `journal.jsonl`+`promptId` **(unproven —
EMP-1; proving it is in-scope for Lane S5)**.

---

## Phase 0 · feasibility spike — ✅ COMPLETE 2026-07-10 (verdict CONDITIONAL GO ~90%)

_Full record in [`DONE.md`](DONE.md) (2026-07-10 entry) and the verdict
[`phase0-verdict.md`](docs/analysis/phase0-verdict.md); parser findings consolidated in
[`parser-spec.md`](docs/analysis/parser-spec.md). All spike output under `spike/`
(THROWAWAY, git-excluded)._

- [x] **Wave 1** — S1 hostile corpus (5 sessions · 224 agents; crashed-no-Stop, depth-2,
  mid-PreCompact, two concurrent same-slug) · X10 WORKLOG template.
- [x] **Wave 2** — S2 ingest-primacy → **CD-1 JSONL-PRIMARY confirmed** (edge 100% ×5,
  0/463 hook-sourced; found `<task-notification>` 3rd flat join path) · S3 join-key →
  **HARD KEY 6654/6654** (found `queue-operation` 3rd schema → 224/224) · S4 hooks →
  **`SubagentStart` is not a real hook**, only `UserPromptSubmit` fires.
- [x] **Wave 3** — S5 tree smoke **PASS 5/5** + EMP-1 (**wave-partial ordering, not
  total**; two same-slug sessions = **two independent roots**) · S6 reconciliation
  (**parent rollup 0.00%**, `message.id` dedup 8540→3339, corpus ≈$345.91) + the
  **THROWAWAY DAG-with-dollars render** (KC-1 stay-alive condition — exists).
- [x] **Wave 4** — S7 verdict → [`phase0-verdict.md`](docs/analysis/phase0-verdict.md):
  **CONDITIONAL GO ~90%**. Three new parser MUSTs beyond the 11-item gate
  (`<task-notification>` flat join · `queue-operation` 3rd join schema · `message.id`
  dedup + bucket/model pricing) captured in
  [`parser-spec.md`](docs/analysis/parser-spec.md). First velocity number recorded.

> **Still self-check — the one open spike-adjacent act is Ivan's.** Every number above is
> scored against machine inventories, not Ivan's hand-labeled trees. Filling the five
> `spike/corpus/sessions/*/LABEL-ME.md` (224 per-edge blanks — esp. confirming `69ac12d0`
> + `a362e15d` stay two independent roots) is the **KC-0/KC-1 human act** that upgrades
> the WP-S7 GO from *conditional / self-check* to *human-verified* and ratifies it.

---

## Optional documentation lanes — ✅ ALL COMPLETE 2026-07-10

Ran alongside the spike (no Gate A needed); each closed its `corpus-audit-2026-07-06.md`
finding IDs. Recorded in [`DONE.md`](DONE.md) (2026-07-10 entry).

- [x] **Lane DOC-A** (LOST-1/2/3/4) → [`recovered-source-material.md`](docs/analysis/recovered-source-material.md):
  24-capability feature matrix as a UI checklist, OTel `query_source` note,
  hook-schema-drift risk, cost sizing. Indexed in the README table.
- [x] **Lane DOC-B** (LOST-5/7) → Satisfies column on the
  [`concept-analysis-v2.md`](docs/analysis/concept-analysis-v2.md) CD table + the
  10-scenario negative-test catalogue in `docs/site/contributing/testing.md` §5.1.
- [x] **Lane DOC-C** (LOST-6 + audit §9.5) → [`ux0-design.md`](docs/analysis/ux0-design.md):
  IA map, five question-to-screen flows, ASCII wireframes for the four views, the
  uncertainty/honesty visual language (inferred edges, estimated costs, `'unknown'`
  status always visible).
- [x] **Lane DOC-D** (OPEN-1…9) → [`open-decisions.md`](docs/analysis/open-decisions.md):
  each open question with its recommended resolution, as sign-off checkboxes.
  _(Deciding them still stays with Ivan.)_

---

## Implementation board _(released by the WP-S7 GO verdict; running under the owner overrides)_

Authored and dependency-ordered in the development plan (§4 waves, §5 catalog), as
amended by best-path §6. Status as of **2026-07-29**: **Phases 1–2 are substantially
complete, Phase 3 is complete except its proof suites, Phase 4 is complete on the
server side and in progress on the SPA.** _(Updated **2026-07-30**: the SPA landed too —
all four views ship. Everything below is now **committed and pushed** — `9b6c6b3` on
`main`, on Ivan's explicit "пушвай"; further commits still need their own explicit ask.)_
_(Updated **2026-08-09**: the 2026-07-31 → 2026-08-09 hardening waves are committed and
pushed on a second explicit «пушвай» — coverage pinned at **100/100/100/100 in all five
packages** with zero pragmas and guard tests, the status lifecycle + WP-IN12 watchdog
live, the corpus-scale benchmark + read-path fixes, the WP-D10 retention mechanism
(values still OPEN-1/2/3), the web/API honesty audits, and the six approved audit
fixes — **1318 tests**. See DONE.md Milestone 1 for the full record.)_
_(Updated **2026-08-15**: the 2026-08-10 → 2026-08-15 review-remediation waves are done but
**UNCOMMITTED** (base `2f8d103`) — the 14-item parser gate is now **14/14 implemented** (the
last one, #7 legacy bare-`Explore`, ships as a defensive fallback with a DISTINCT persisted
`legacy_explore` provenance; #7 and N1 stay **absent from real corpus**, so they remain
PROVISIONAL fallbacks, not measured paths), plus M-14 duplicate-`session-uuid` dedup at
enumeration (gate item #9 hardened: two slugs holding the same session uuid now ingest once,
smallest slug wins, the loser is counted as a `duplicate-session` skip), M-15 byte-offset
tail-read cache (a poll pass costs O(new bytes); `lastTickDurationMs` on `/api/health`), and
M-16 listen-before-replay with `ingest: 'replaying' | 'idle'` on `/api/health`. Gates on the
merged tree: typecheck · lint · format:check · gate:spawner · gate:licenses green, **105 test
files / 1540 tests, 100/100/100/100 in all five packages**. New PROVISIONAL constants:
`OVERLAP_BYTES` = 4096, tail-cache caps 128 MiB / 512 entries, M-14 smallest-slug-wins.)_

> **Recorded architectural divergence (deliberate, not a defect to refactor):** JSONL is
> parsed and ingested straight into the projections (`sessions` · `agents` ·
> `orchestration_edges` · `token_usage`) inside a single transaction per session.
> `events_raw` therefore holds **hook events only**, and the WP-IN6→IN7 normalizer /
> projection pair was never built as separate stages. This keeps CD-1 (JSONL-primary)
> intact — hooks contribute **liveness only, never structure** — and keeps replay
> idempotent, but the WP rows below are marked accordingly rather than silently ticked.

### Phase 1 · Foundation, security spine, storage, ports _(security + coverage LIVE; KC-2 window — Phases 1–2 complete by **2026-09-14**)_
- [x] **Foundation/CI (F):** WP-F1 scaffold — pnpm monorepo `apps/server` · `apps/web` ·
  `packages/shared` · `packages/core` (server/web-import-free moat IP, best-path §6.7) ·
  `packages/test-fixtures` · `hooks/`, Node 22 · F2 lint (eslint + prettier `format:check`) ·
  F3 coverage-harness (v8) · F4 CI (`.github/workflows/ci.yml`) · F5 no-spawner gate
  (`scripts/check-no-spawner.mjs`) · F6 license scan (`scripts/check-licenses.mjs`) ·
  F7 security contract tests (`apps/server/test/security-contract.test.ts` — **GREEN**,
  turned by WP-U0) · F8 backup/tested-restore (`db/backup.ts` + `test/backup.test.ts`).
- [x] **Data (D):** WP-D1 ports+shared types (`packages/shared/src/ports`, `types/rows.ts`) ·
  D2 SQLite/WAL — **better-sqlite3 only**, pragmas asserted at open · D3 migration runner ·
  D4 `events_raw` append-only substrate (proven in `test/events-raw.test.ts`) ·
  D6 sessions+agents · D7 `orchestration_edges` · D8 `token_usage`.
- [x] **WP-D5 `events`** — **wired**, not retired. `SqliteEventStore.append` now writes the
  raw row and its normalized projection in **one transaction** (proven by a rollback test);
  a duplicate idempotency key produces zero rows in both tables. Only identifiers are
  projected — never payload content. `occurred_at` is **receipt time**, because the WP-IN1
  envelope carries no event-originated timestamp, and every DTO row says so via
  `occurredAtSource: 'receipt'` rather than letting a consumer mistake one for the other.
  Id extraction is total and defensive (the receiver accepts any shape: non-object payloads
  and non-string ids yield NULL, no silent coercion). Read side: `GET /api/sessions/:id/events`
  — Bearer-gated, 404 unknown session vs **200 + empty array** for a session with no hook
  events (different facts, not conflated), oldest-first with an `id` tiebreak, paginated
  with `total` so truncation stays visible. Hooks remain **liveness only, never structure**:
  P0 proof 3 still shows the DAG dump unchanged by hook appends. _(Honest residue:
  `jsonl`-source envelopes are stored raw but deliberately not projected; rows whose
  `session_id` could not be extracted belong to no session timeline and are reachable only
  via `events_raw`; the shared `InMemoryEventStore` fake does not mirror the projection.)_
- [~] **WP-D10 retention+redaction** — redaction is live (**`apps/server/src/hooks/redact.ts`**
  — the old `hooks/redact.ts` path recorded here was stale; the repo-root `hooks/` holds only
  the installer, and `hooks/README.md:146` already cited the correct path). It runs at the hook
  ingest boundary **before** the envelope, so the idempotency key is computed over the redacted
  payload and persistence never sees the raw body; `redactTokenInUrl` is separately wired into
  the Fastify log serializer. The corpus path needs none — it persists no raw payload.
  **Retention mechanism now implemented** (2026-08-07, `apps/server/src/retention/`): bounded,
  transactional prune over the `events`/`token_usage` projections with a dry-run mode, an
  fsync'd JSONL cost receipt written inside the delete transaction, a `keepMinimum`-floored
  backup-file expiry, and a static source guard proving no DML ever targets `events_raw`,
  `sessions`, `agents`, `orchestration_edges`, `model_pricing` or `schema_version`. Default
  (`NO_RETENTION`) is a byte-identical no-op that opens no transaction; pruning `token_usage`
  is refused outright without an explicit `acknowledgeCostLoss`. 80 tests, 100% coverage.
  **Still `[~]`, NOT done:** the policy VALUES stay blocked on OPEN-1/2/3 — Ivan's decision,
  not an agent's — and nothing invokes the runner on a timer or over HTTP, deliberately, until
  the policy is signed. The two additive prune indexes are now **built** (migration 10
  `retention-scan-indexes`: `idx_events_occurred_at_id`, `idx_token_usage_occurred_at_id` —
  keyed `(occurred_at, id)` because the batch cursor is (age, id), not age alone). They are
  pure read-path accelerators — a dropped index costs speed, never truth — so nothing else in
  the suite would have noticed their absence; `migrations.test.ts` asserts them over
  `sqlite_master` for exactly that reason. Known residue: a pruned `token_usage` row whose source JSONL still exists returns on
  the next replay — totals self-heal upward, never silently down, but space is not durably
  reclaimed until segment archival exists (an argument for pruning `events` only, for now).
  - **Decided 2026-09-09 (D3, Closing board):** `DASHBOARD_RETENTION_EVENTS_DAYS=90`;
    `token_usage` never pruned in v1.0 (`NO_RETENTION` kept, `acknowledgeCostLoss` refusal
    stays); backups `DASHBOARD_RETENTION_BACKUP_DAYS=30`, `_KEEP_MIN=7`. Wiring is Wave-2 lane L9.
- [ ] **NODE-PIN** _(toolchain, blocked on Ivan)_ — **the repo does not pin a Node version
  locally, and the default one on this machine silently fakes a whole-suite failure.**
  `package.json` declares `engines.node >= 22` and CI pins `node-version: 22`, but there is no
  `.nvmrc`, and the shell default resolves to `/opt/homebrew/bin/node` **v26.7.0**. The installed
  `better-sqlite3` binding is built for `NODE_MODULE_VERSION 127` (Node 22) and refuses to load on
  `147`, cascading into `Cannot read properties of undefined (reading 'close'/'cleanup')` across
  every DB-touching test — the P0 proofs, `security-contract`, `hook-receiver` and
  `security-stream` included — plus ~16 spurious `localStorage is undefined` failures in
  `apps/web` under jsdom. Measured 2026-09-01: the same tree shows a full cascade on v26 and
  **15 real failures on v22**. The failure is loud, large, and blames the wrong files.
  **The fix is a fork Ivan has to pick, so it is not taken here:** either (a) pin to 22 — add
  `.nvmrc`, tighten `engines` to `>=22 <23` — or (b) actually support 26, which means rebuilding
  the native binding and widening CI to a version matrix. Declaring `>=22` while shipping a
  binding that only loads on 22 is the part that is currently untrue either way. Workaround
  meanwhile: `export PATH="$HOME/.nvm/versions/node/v22.23.2/bin:$PATH"`.
  - **Decided 2026-09-09 (D2, Closing board):** (a) — `.nvmrc` = `22`, `engines.node` tightened
    to `>=22 <23`, README says so. Wave-1 lane L6.
- [ ] **BENCH-SHAPE** _(benchmark, blocked on Ivan)_ — **the measured `34.87-39.92 s` cold replay
  does not describe the real corpus, and the gap is per-session size, not total bytes.**
  Established 2026-09-01 at the source: `corpus-scale.ts` deliberately never reads
  `~/.claude/projects` (`:82`, `:740`) — it plants a synthetic corpus (`:1349`) whose per-session
  size is two literals, `DEFAULT_RECORDS = 1800` x `DEFAULT_RECORD_BYTES = 4100` (`:253-254`) =
  **7.038 MiB** (~7.07 with subagents). That single constant is the whole provenance of both
  retired figures: `141 x 7.07 = 996.4 MiB` and `1855 x 7.07 = 12.80 GiB`. Measured on disk the
  same day, the real corpus is **51 sessions / 2477 subagent transcripts / 1335.5 MiB =
  26.19 MiB per session** — 34% more bytes in total, but **3.7x the benchmark's per-session
  size** and 1.8x the WP-S1 median it was calibrated against. Linear-in-bytes puts real cold
  replay near ~47-53 s; a session is parsed as a unit, so any per-session superlinearity lands
  precisely on the axis that is 3.7x off. **Settle it by rerunning with `--records` /
  `--record-bytes` at the real shape — NOT done here, because a benchmark rerun changes a number
  Ivan has to stand behind.** Feeds OPEN-1/2/3. See the 2026-09-01 WORKLOG entry.
- [x] **WP-U0** _(backend)_ — Fastify bootstrap: loopback-or-fail (plus post-listen address
  re-verification that hard-exits), timing-safe token compare, same-origin SSE check,
  TypeBox, config. _(D9 merged into C1; WP-X11 vector-DB stub **deleted** per best-path §6.3.)_
- [x] **Delivery/QA (X):** WP-X1 golden fixture corpus (`packages/test-fixtures` — 6
  fixtures: flat tool_use · nested workflow · queue-operation · task-notification recovery ·
  depth-2 sync · usage dedup) · X5 blocking >90% coverage gate (enforced per package in CI).
- [~] **WP-X2** labeled annotations + loader — the **loader half is built** (2026-08-07):
  `packages/test-fixtures/annotations/` holds the schema, the loader, blank templates for
  60 claims, and `packages/core/test/hierarchy-gate.test.ts`, which computes the one-sided
  Wilson lower bound and fails the gate unless it clears 0.95. The arithmetic is pinned:
  n ≥ 0.95 · 1.6449² / 0.05 → **n ≥ 52 with zero errors**, ~n ≥ 90 to survive a single one.
  With no filled annotations present the gate reports **"substrate unavailable"** rather
  than passing vacuously. **Still blocked on Ivan's LABEL-ME act** — the human ground truth
  itself: fill the `__________` blanks in `annotations/templates/`, save into
  `annotations/human/`, then run
  `pnpm --filter @agenthropic/core exec vitest run test/hierarchy-gate.test.ts`.
  ⚠️ Caveat to weigh before committing filled templates: `spike/` is git-excluded, so the
  annotations would land without the substrate they were labelled against, degrading the
  gate back to "substrate unavailable" for anyone else checking out the repo.
- [x] **WP-X6** README badges + donation — CI (real workflow status) · Node (from
  `engines.node`) · MIT (linked to `LICENSE`). Coverage/npm/CodeQL badges deliberately
  **not** added: nothing real backs them today. Support section added.
- [x] **WP-X7** GitHub Pages build — `.github/workflows/pages.yml` (official
  `configure-pages` → `jekyll-build-pages` → `upload-pages-artifact` → `deploy-pages`
  flow, zero new dependencies). Publishes **`docs/`, not `docs/site/`** — 129 relative
  links point outward to `../analysis`, so a site-only publish would break them;
  `docs/ai/` is git-excluded and absent from the CI checkout. **UNBLOCKED 2026-08-25 — the
  site is live** at <https://ivanbbaev.github.io/agenthropic/>. The blocker was real while
  it lasted: the 2026-08-07 claim recorded here ("`enablement: true` turns Pages on via the
  API, so the one-time Settings → Pages click is gone") was **wrong, and two real runs
  disproved it** (`31318246506` on 2026-08-09, `31879212583` on 2026-08-15): `Create Pages
  site failed. Error: Resource not accessible by integration`. `pages: write` authorises
  **deploying to** an existing Pages site; **creating** one needs repo-administration rights
  that the default `GITHUB_TOKEN` never has. That is why it took an owner-credentialled call:
  `gh api -X POST repos/IvanBBaev/agenthropic/pages -f build_type=workflow` → `has_pages:
  true`, `build_type: workflow`. Re-running the previously failed `32863218759` then
  **succeeded**, and `curl` returns HTTP 200 on both `/` and `/site/`.
- [ ] **WP-A1** alert port (v2-facing; not on the v1.0 critical path).
- **Exit gate:** coverage >90% green & blocking ✅ (now genuinely including `apps/web` —
  its script ran without `--coverage` until 2026-07-30, so the thresholds silently never
  executed) · security/license gates red on violation ✅ · WP-F7 green via WP-U0 ✅ ·
  `events_raw` append-only proven ✅ · WAL + tested restore ✅ · badges green ✅ — and as
  of 2026-07-30 the badge finally means what it says: CI is `success` on `9b6c6b3`, the
  first pushed commit containing Waves 1–4 (until then the newest run on `main` was
  `eded0b3` from 2026-07-12, so the badge attested only to the Phase-1 foundation) ·
  Pages builds ✅ **as of 2026-08-25**, and ticked the only way this box allows — by a green
  `pages.yml` run (`32863218759`, re-run after enablement), not by assumption. Three runs
  had failed before it, all the same cause: `30528892265` (`Get Pages site failed … Not
  Found`), then `31318246506` and `31879212583` after `enablement: true` was added (`Create
  Pages site failed … Resource not accessible by integration`). The `enablement: true` fix
  did **not** work; a workflow token cannot create a Pages site, which is why enablement had
  to be an owner-credentialled call (see WP-X7 above).

### Phase 2 · Ingest substrate
- [x] **WP-IN1** envelope + idempotency-key (`hooks/envelope.ts`) · **IN2** EventStore
  append-only (`db/event-store.ts`) · **IN3** HookSource authed loopback receiver,
  accept-any-event (`hooks/routes.ts`) · **IN5** JSONL follow + durable resume
  (`corpus/` — enumeration, containment-safe reads, `fingerprint.ts` as the durable
  per-session offset/identity) · **IN14** redaction at the ingest boundary
  (`hooks/redact.ts`). **WP-C1** pricing table + seed (`db/pricing.ts`) · **C2**
  PricingProvider (`loadPricing`). Hooks installer **WP-X8** (`hooks/install.mjs`,
  _absorbs IN4_).
- [ ] **WP-IN11** contingent outbox — **deliberately deferred** per the probe (JSONL
  self-reconciles). Add only on a sub-second-liveness or hooks-only-data trigger.
- **Exit gate:** one fact → one `events_raw` row ✅ · kill/restart resumes, zero loss/dup ✅
  (fingerprint replay) · unknown `event_type` stored not crashed ✅ · redaction live ✅.

### Phase 3 · Projection, the DAG moat, reconciliation, cost _(P0 blockers — exit = **KC-3, by 2026-10-12**)_
- [x] **WP-IN8** dual-path `orchestration_edges` **(moat core — satisfies the 14-item
  parser gate of [`parser-spec.md`](docs/analysis/parser-spec.md): `Agent`/`Workflow` not
  `Task`, both layouts, all four join paths, self-referential parent index)** · **IN9**
  reconciliation + backfill **(load-bearing — child-transcript token summation is the
  ledger; `message.id` dedup applied)** · **IN10** replay-on-startup (the watcher's first
  tick; a `ContainmentError` is a stop-everything exit) · **IN12** missing-Stop→`unknown`
  watchdog (`ingest/watchdog.ts`).
- [x] **WP-IN6** pure Normalizer · **IN7** projection — **the decomposition IS built**
  (verified 2026-08-15; the "folded into `ingest-session.ts`, not built" note recorded here
  was stale). `ingest/normalize-session.ts` is the pure half — 243 lines, four **type-only**
  imports, no database, clock, filesystem or environment, so the parent-first ordering rule
  and the FK-safety nulling rule are decided as a value and asserted without a DB.
  `ingest/project-session.ts` is the impure half — the single transaction, the edge
  `created_at` stamp, and the M-13 replay of stored `SubagentStop` verdicts.
  `ingest/ingest-session.ts` is down to 123 lines of orchestration between the two.
- [x] **Cost:** WP-C3 CostEngine (`core/cost/compute-cost.ts`) · C4 compaction repricing ·
  C5 delegation-savings (`isEstimate: true` carried in the DTO) · C6 priceless-fails —
  `PricingError` HALTS the session ingest **before any row is written** (no partial
  session, never a silent $0); read-side gaps surface as `unpricedTokens`.
- [x] **WP-C7** cost API — `/api/cost/summary` plus `GET /api/sessions/:id/cost-analysis`
  (C4/C5 over a read-only substrate seam; 503 unconfigured · 404 unknown · 422 on
  `PricingError` **and** on a poisoned transcript · detail-free 500 on a crafted corpus;
  `isEstimate` is `Type.Literal(true)` so it cannot serialise as `false`). **UI consumer
  added 2026-08-07** (`apps/web/src/views/SessionCostAnalysis.tsx`, opt-in per session from
  the CostView top-sessions table — the route reads transcripts off disk, so it is never
  fetched for every row). Until then the endpoint had no reader, which is what made the
  Phase-4 exit-gate claim true of the server and false of the dashboard. The panel carries
  the honesty contracts visibly: `isEstimate` surfaces as a badge, a `~` on every modelled
  figure and the named hypothetical model; `skippedAgentIds` is reported as an explicit
  exclusion ("a guess would be worse than a gap"); and `deltaUsd` is labelled a **mispricing
  signal, not a saving** — called out at ≥ $0.01, silent below (rounding must not cry wolf).
  The four failures (503/404/422/other) render as four distinct sentences, which is the
  whole reason `ApiResult` carries a status.
- [x] **WP-X3** three release-blocker tests · **IN13** P0 suite — `apps/server/test/p0/`.
  Σ token_usage == JSONL proven against an **independent reader written inside the test**
  (not the production parser); double-replay proven **byte-identical** via `VACUUM INTO`
  snapshots under a fixed clock, cross-checked by a full ordered logical dump; DAG-from-
  JSONL-alone proven equal to the reference DB **and** hooks proven liveness-only (the DAG
  dump is unchanged by appending them), plus a kill/reopen outage replay.
- [x] **WP-X4** 12-scenario negative catalogue — `apps/server/test/negative/` +
  `packages/core/test/negative/`, all 12 green, each citing its scenario number and mapped
  criterion. _(Scenario #2's "anomaly flagged" half is documented against the current
  honest posture — raw stored + WP-IN12 `unknown` — because no hook normalizer seam
  exists; if one is ever built, that test must be extended.)_
- **Exit gate:** three P0 tests green ✅ & merge-blocking ✅ since 2026-08-25 — for a
  contributor; the owner stays exempt by design (`enforce_admins: false`), so on Ivan's own
  pushes this is discipline, not a barrier · hierarchy ≥95% without
  `SubagentStart` — **blocked on LABEL-ME** (the ≥95% is measured against Ivan's hand-labeled
  corpus; machine-vs-machine cannot sign it) · PreCompact reprices vs baseline ✅ (core) ·
  no priceless model ✅.

### Phase 4 · Read API + SPA + the five daily questions — **v1.0 ships at this exit gate** _(KC-4 hard date: **2026-12-01** — it does not move)_
- [x] **WP-U1** SSE RealtimeHub (CD-5: SSE, same-origin checked, one hub shared by the
  ingest loop and the stream route) · **U2** read API foundation (Bearer-gated, TypeBox
  response schemas, uniform `{error}`) · **U3** session/tree endpoints (served by a query
  over the **persisted** edges) · **U4** cost/global-DAG endpoints · **U5** SPA shell +
  token gate (sessionStorage only) + SSE client + hash router.
- [x] **WP-U6** live status view (`GET /api/sessions?limit=50` + SSE; an
  `agent-status-changed` moves an agent between buckets in place, anything else refetches
  the **persisted** truth — never a client-side invention) · **U7** session tree view (SVG
  tree drawn **only** from persisted edges) · **U8** global persistent DAG view · **U9**
  cost/Sankey view (model → cost hub → top sessions + an explicit "other sessions"
  remainder; **no invented model×session split**). Honesty carried into the UI: `unknown`
  is a first-class always-rendered bucket and is **not** merged with a `null` "unrecorded"
  status; observed (`tool_use`) edges are solid, inferred (`directory` /
  `task_notification` / `queue_operation`) are dashed with a permanent legend; edges to
  missing nodes are counted and declared, not drawn; `counts.truncated` surfaces a banner
  with real numbers; `unpricedTokens` gets its own KPI and a `~n` column, and a
  $0-priced model with usage is listed in text rather than drawn as a $0 flow.
- [x] **WP-X9** release checklist — [`RELEASE.md`](RELEASE.md): every CD-7 gate, every CD-9
  check, the backup→restore drill (**actually executed** against `data/agenthropic.db`:
  readonly open → online backup → `integrity_check` = ok), and an explicit **blockers**
  section that names what is still open instead of hiding it. Two of those four blockers
  are now closed: `apps/web` coverage is enforced (2026-07-30) and `LICENSE` is tracked
  (`9b6c6b3`, GitHub reports `MIT`). **All four are now closed:** branch protection on
  `main` and GitHub Pages both landed on 2026-08-25, the two that had been "Ivan's alone"
  since this line was written (the `enablement: true` fix had failed against a workflow
  token — see WP-X7; corrected 2026-08-15, resolved 2026-08-25).
- [x] **WP-U10 — a producer for `status = 'error'` (Q4's "failed" half).** Found 2026-09-01 by
  the E2E proof: the value is declared in four places and written by none. Blocks the v1.0
  exit gate, since "what failed" is one of the five questions. The producer must respect CD-1
  — a *failure* is structure-adjacent and belongs to JSONL ground truth if the transcript
  carries one; hooks may only confirm liveness.
  **Scanned 2026-09-01 — the signal exists, and it is worth ~2 agents.** Read-only pass over
  2555 transcripts / 422,461 JSON lines. *Ruled out:* `stop_reason` (corpus-wide only
  `tool_use` 122,679, `end_turn` 3,050, `stop_sequence` 829, `refusal` 2 — no error value, and
  876 of 1252 workflow transcripts *end* on `tool_use`); tool-level `is_error: true` (862 of
  2552 files — a failed `grep`, not a failed agent); `isApiErrorMessage: true` (780 records,
  `apiErrorStatus` 429 ×486 / 529 ×36 / 500 ×7 — a failed *turn*, the session continues).
  *Confirmed:* the **parent-side `Task`/`Agent`/`Workflow` `tool_result` with `is_error: true`**
  — 1243 ok vs **33** error corpus-wide, and those 33 are **five** distinct facts that must not
  be flattened: 19 spawn refused by the concurrency limit (no agent ever ran), 7 user interrupts
  (not a failure), **3 tool-permission failures** (`Tool permission request failed:
  AbortError`), 2 model-unavailable, **2 genuinely terminated mid-run by an API session limit**.
  So the honest count is ~2, not 33. That is still the right change: it replaces a
  *structurally impossible* zero with a *measured* one.
  **ERRATUM 2026-09-02.** This paragraph read "30 ... four distinct facts" and omitted the 3
  permission failures, which made `permission_failed` — one of the six causes the code ships —
  look like a speculative bucket with no corpus behind it. It is measured. The error came from
  a scan that matched only `Task`/`Agent` spawn blocks; `agent-outcome.ts` had 33-and-five right
  all along, and it is the file that carries the argument, so the board was the wrong half.
  Re-verified 2026-09-02 by a two-pass scan (spawn `tool_use.id` collected first, then
  `tool_result` matched by `tool_use_id` — never by substring, gate #5) over 2633 transcripts /
  442,140 records: **ok 1369 / error 33**, in exactly those five causes. The `ok` count moved
  1243 -> 1369 because the corpus grew; the error count and the cause set did not move at all.
  A first attempt at this re-verification returned "36 errors" by testing whether the result
  *mentioned* a subagent — i.e. the tool-level `is_error` heuristic this very module forbids,
  which pulled in 15 `Exit code 1` Bash results. Recorded because the wrong number was one
  substring away from being reported as a correction to a docstring that was already right.
  **ERRATUM, third pass, 2026-09-02.** Re-measured once more over **2693 transcripts /
  461,334 records, 0 unparseable**: **ok 1421 / error 33**, causes 19/7/3/2/2. So the `ok`
  figure has moved 1243 -> 1369 -> 1421 across three scans in two days — that is corpus
  growth and nothing else — while **the error count and the five causes have not moved at
  all**. `packages/core/src/parser/agent-outcome.ts` carries the current number and the full
  provenance chain; this board line has now lagged it twice, which is itself the argument for
  keeping the figure in the file that makes the argument rather than in the tracker.
  "Stuck" needs nothing new — dangling
  `tool_use` is 3 main + 7 subagent + 0 workflow files of 2555, already covered honestly by
  the watchdog's `'unknown'`. Evidence in `WORKLOG.md`, entry of 2026-09-01 (second).
  **CLOSED 2026-09-02.** `packages/core/src/parser/agent-outcome.ts` classifies the parent-side
  errored spawn; `apps/server/src/ingest/normalize-session.ts` promotes exactly one cause
  (`terminated_early`, via `ERROR_CAUSES`) onto `agents.status = 'error'`, and
  `isTerminalAgentStatus` in `apps/server/src/ingest/watchdog.ts` already listed `'error'`, so an
  errored agent is never swept back to `'unknown'`. Driven end-to-end by a new synthetic fixture
  `agent-outcome-errors` whose two sibling spawns share one parent record: the terminated-early
  one lands on `'error'`, the user-interrupt one on `'unknown'`. **That second assertion is the
  point** — the fixture proves the causes do NOT collapse into one bucket, which is the defect a
  19/7/3/2/2 distribution makes tempting.
- [x] **WP-U11 — Q5 "what changed across sessions" is answered by no single endpoint.** Eight
  routes exist; none is a diff/delta. Today the answer requires the caller to stitch
  `/api/dag/global` with `/api/cost/summary` `perDay` client-side. Either add the endpoint or
  amend the exit gate to state that this question is answered by the *dashboard*, not the API
  — but it must not stay ticked as if one call answered it.
  **CLOSED 2026-09-02** by the first route rather than the amendment: `GET /api/changes`
  (`apps/server/src/api/routes.ts:449`), auth-gated like every other endpoint and covered by
  `apps/server/test/api-changes.test.ts`.
- [x] **WP-U12 — seven dead `*Row` interfaces in `packages/shared/src/types/rows.ts`, and they
  are wrong.** Found 2026-09-02 by the dead-value sweep, verified by me the same day: all seven
  (`SessionRow`, `AgentRow`, `TokenUsageRow`, …) have **zero importers** anywhere in the
  monorepo, while `packages/shared/src/index.ts:1` re-exports them wholesale
  (`export type * from './types/rows'`). The same names appear at `db-sessions.test.ts:5`,
  `db-agents.test.ts:10`, `event-store.test.ts:57` and `src/db/pricing.ts:35`, but each is a
  **locally redeclared, correctly-shaped duplicate** — which is precisely why nobody noticed the
  originals rot. They are not merely unused, they contradict the schema: `AgentRow` declares
  `started_at`/`ended_at` where the table has `first_seen_at`/`last_seen_at`, and `TokenUsageRow`
  describes a **wide** row (`input`, `output`, `cache_read`, `cache_write_5m`, `cache_write_1h`)
  against a `token_usage` table that is **tall**. A type nobody imports can never fail a
  typecheck; an exported one is a trap for the next reader, and this package is the shared
  contract.

  **CLOSED 2026-09-02 — and the plan written on this line was half wrong, in exactly the way the
  board warns about twice.** The action recorded here was "delete the seven interfaces, keep the
  six type aliases — they are load-bearing (`AgentStatus` 63 references, `AgentOutcomeCause` 26,
  `OrchestrationEdgeSource` 17, `TokenBucket` 13, `AgentType` 10, `RawEventSource` 8)." Three of
  those six were **not** load-bearing and those three counts are **not** references to this file.
  `packages/shared/src/index.ts` re-exported `AgentStatus`, `AgentType` and
  `OrchestrationEdgeSource` **explicitly** from `./schemas/common` (lines 28-33) alongside the
  `export type * from './types/rows'` on line 1 — and an explicit re-export **shadows** a star
  re-export. So every consumer outside the package was already resolving to `schemas/common`; the
  copies in `types/rows.ts` were reachable only from inside that one file. I had counted **name
  occurrences and called them references** — substring, not resolution, the same error this board
  already records twice. Two identical declarations of one union with nothing holding them in
  step is drift waiting to happen; they happened to still agree.

  **What was actually done.** `types/rows.ts` → `types/enums.ts`: the seven interfaces and the
  three shadowed aliases deleted, `schemas/common.ts` left as the single declaration of each of
  the three (the better one — derived from the runtime TypeBox validator rather than sitting
  beside it); `AgentOutcomeCause`, `TokenBucket` and `RawEventSource` kept, these three being the
  ones that really are load-bearing and really have no schema. Two importers updated
  (`index.ts:1`, `ports/event-store.ts:7`). The index line is now an explicit named re-export
  rather than `export type *` — **a star export is what let the duplicate hide**, so with every
  export named the next duplicate is a compile error instead of a silent shadow. The four correct
  local redeclarations (`db-sessions.test.ts:5`, `db-agents.test.ts:10`, `event-store.test.ts:57`,
  `src/db/pricing.ts:35`) are untouched and still correct.
- [~] **WP-U13 — `agents.outcome_cause` is written by ingest and read by nothing.** The mirror of
  WP-U10: that was a value read by no writer, this is a column written for no reader. Produced at
  `apps/server/src/ingest/normalize-session.ts:267,277` → `apps/server/src/db/agents.ts:130,146,156`;
  no `src/` path ever selects it. Migration 17 justified the column with "the dashboard can say
  *why*" — the dashboard cannot, because nothing serves it. This one is **not** a cleanup: the five
  causes are exactly the distinction Q4 was reopened to preserve (19 of 33 are `concurrency_limit`,
  a scheduling fact with no failed agent in it), so collapsing them is the defect and surfacing
  them is an API-response-shape change plus a UI decision. **Blocked on Ivan for the UI half** —
  whether a ~2-agent `error` bucket justifies any dashboard surface at all is his call, not an
  agent's. The API half (expose `outcomeCause` on the agent DTO) can move independently.
  - **Decided 2026-09-09 (D4, Closing board):** yes, minimal — the cause as text on `error`
    rows in the Live view and the session tree; no new view, no colour. Wave-1 lane L5.

  **API HALF CLOSED 2026-09-03; the UI half is still Ivan's.** `outcomeCause` is now a required,
  nullable field on `AgentNodeDto` (`packages/shared/src/schemas/graph.ts`) and is selected and
  served by **both** node readers in `apps/server/src/api/queries.ts` — `getSessionTree` and the
  global-DAG query. NULL is served as NULL: "no outcome was observed" is not a claim that the
  agent succeeded, and the six causes stay distinct on the wire exactly as they are in the column.

  **Two corrections to the line above, both found while closing it.** (1) The board says "the five
  causes" three times; there are **six** — migration 17's CHECK
  (`apps/server/src/db/migrations.ts:1096-1097`) admits `unclassified` alongside the five, and an
  API union that dropped it would reject rows the database can legally hold. (2) The union had **no
  TypeBox schema at all**, only a bare type alias in `packages/shared/src/types/enums.ts`. Putting
  it on the wire needs a runtime validator, and adding one next to a hand-written alias would have
  rebuilt the exact WP-U12 defect (two declarations of one name, one of them shadowed and dead). So
  the declaration was **moved, not copied**: `schemas/common.ts` now owns
  `AgentOutcomeCauseSchema` and `AgentOutcomeCause = Static<typeof …>`, and `enums.ts` records why
  it left. All eight import sites go through `@agenthropic/shared`, so no consumer changed.

  **Verified by mutation, baseline green first, `queries.ts` restored byte-identical (`cmp -s`)
  after every run.** The seeds deliberately carry *different* causes per agent, and both mains
  carry NULL, so a reader that hard-coded a constant or derived the cause from `status` cannot
  produce the expected list:
  | mutation | result |
  |---|---|
  | mapper `outcomeCause: row.outcome_cause → null` | **KILLED** — both endpoints fail (`api-dag`, `api-sessions`) |
  | drop `ag.outcome_cause` from the **session-tree** SELECT | **KILLED** — and *only* `api-sessions` fails |
  | drop `ag.outcome_cause` from the **global-DAG** SELECT | **KILLED** — and *only* `api-dag` fails, both of its cases |

  The last two rows are the point: each SELECT list has its own test, so deleting one column does
  not hide behind the other's coverage. **Still open, and unchanged:** whether a ~2-agent `error`
  bucket justifies any dashboard surface at all is Ivan's call, not an agent's — nothing in the
  web app reads `outcomeCause` yet, and this closure deliberately did not invent a place for it.
- [~] **WP-U14 — the realtime schema assertion cannot fail.** `RealtimeEventSchema`
  (`packages/shared/src/schemas/realtime.ts:48-64`) appears in **no** `src/` path; its single use is
  `apps/server/test/realtime-bridge.test.ts:104`,
  `expect(Value.Check(RealtimeEventSchema, event)).toBe(true)`. Because the union's third arm is
  `GenericRealtimeEventSchema` (`{ type: string, payload: Record<string, unknown> }`), **any** object
  with a string `type` and an object `payload` validates — the assertion is tautological, and it sits
  inside the suite that was supposed to catch tautologies. **Action:** assert the *specific* schema
  per event type (`session-ingested`, `agent-status-changed`), and decide whether the generic arm
  should exist at all — that second half is a CD-5 transport-contract question (what an unknown
  event type over SSE is allowed to mean), not a test fix.
  - **Decided 2026-09-09 (D5, Closing board):** closed union — a typed `ingest-failed` arm,
    `GenericRealtimeEventSchema` deleted, an unknown `type` dropped client-side and counted;
    documented in `docs/site/usage/api.md`. Wave-1 lane L4.

  **TEST HALF CLOSED 2026-09-02; the contract half is still Ivan's.** The tautology is replaced by
  a named-arm helper, `acceptingArms(event)`, which reports *which* of the three arms accept an
  event — so "some arm said yes" becomes "exactly this arm said yes and the other two refused."
  Two further gaps turned up while fixing it, both worse than the one on the board: the check was
  applied **only** to the event that lands on the catch-all, while `session-ingested` and
  `agent-status-changed` — the two arms where a union check has real bite
  (`additionalProperties: false`, a literal `type`, integer minimums) — were asserted with
  `toEqual`/`toMatchObject` alone and **never met the shared schema at all**. The check had teeth
  everywhere it was not used.

  **Verified by mutation, baseline green first, `realtime.ts` restored byte-identical (`cmp -s`)
  after every run:**
  | mutation | old assertion | new assertion |
  |---|---|---|
  | generic arm `additionalProperties: false → true` | **SURVIVED** (measured, not assumed — the old form was re-run as a scratch test under the mutation and still passed) | **KILLED** — `expected [ 'generic' ] to deeply equal []` |
  | `SessionIngestedEventSchema.agentCount` `Integer → String` | n/a (no assertion existed) | **KILLED** — `expected [] to deeply equal [ 'session-ingested' ]` |
  | `previousStatus` `nullable(AgentStatusSchema) → AgentStatusSchema` | n/a | **SURVIVED at first**, then killed after the null-previous-status test got its own arm assertion — `toMatchObject({previousStatus: null})` passes just as well against a schema that forbids the null |

  The third row is the one worth keeping: the first repair was itself incomplete, and only the
  mutation said so. **Still open:** whether `GenericRealtimeEventSchema` should exist at all, and
  whether `ingest-failed` deserves a typed arm — a CD-5 transport-contract question (what an
  unknown event type over SSE is allowed to mean), not an agent's call.
- **Exit gate (= the v1.0 definition, best-path §6.1):** all 5 daily questions answerable — **5
  of 5 ✅** as of 2026-09-02. This read **3 of 5 ✅, 2 RED** on 2026-09-01, the day the claim was
  first tested end-to-end instead of asserted
  (`apps/server/test/p0/p0-five-daily-questions.test.ts`: the 8 **synthetic fixtures**
  materialized as real JSONL on real disk → real `runCorpusIngest` → real `buildServer`, every
  question asked over HTTP with a Bearer token). **WORDING CORRECTED 2026-09-02** — this line
  read "real corpus", which in this repo means `~/.claude/projects`; the P0 proof has never
  touched it. Everything downstream of the files IS real (no stubs, no fakes, no in-memory
  shortcut), and that is the claim the gate can carry. What it cannot carry is scale or
  messiness: 8 curated sessions, all parseable, and P0 says nothing about the 141-session /
  996.4 MiB census.
  **AUDITED BY MUTATION 2026-09-02, and two of the five ticks did not survive first contact.**
  A falsification lane re-ran the gate with deliberate defects injected at the sites each
  question claims to verify. Two assertions could not fail: (a) the P0 fixture seeded a single
  flat pricing epoch, so `ORDER BY effective_from DESC` and `ASC` were indistinguishable and
  the "dated" half of "tokens x dated price" was never exercised — fixed by seeding a
  superseded, strictly-dominated 7 USD/Mtok 2019 rate behind the live 1 USD/Mtok 2020 one, after
  which `DESC->ASC` turns Q5 RED via `api/queries.ts:59` and Q2 RED via `migrations.ts:917`;
  (b) no fixture session spanned a `/api/changes` window boundary, so `change_kind`'s `'updated'`
  arm had no producer and swapping `'new'`/`'updated'` in `queries.ts:1563` passed green — fixed
  by deriving a third window at the midpoint of the earliest session that measurably spans time,
  plus per-row `change`-map equality, a `new + updated + unknown == total` partition check and
  explicit anti-vacuity assertions. **Both remedies were null-hypothesis tested** (restore the
  old fixture/test text, keep the mutation: 6 passed (6)), so the kills belong to the new
  assertions and not to something that was already there. The 5-of-5 stands on this audit; it
  did not stand on the run that first claimed it. Q1 "what is running now"
  ✅ · Q2 "where did tokens/money go" ✅ (recomputed independently from `token_usage` +
  `model_pricing`, matching at all four grains) · Q3 "what did session X spawn and why" ✅ (all five
  provenance kinds, depth-2 chain) · **Q4 "what failed / stuck" ✅** (closed 2026-09-02, WP-U10) —
  "stuck" was always answered by `statusCounts.unknown`; "failed" had **no data source** until then.
  `status = 'error'` existed in the CHECK constraint, the union and the `error_count` SUM while
  **nothing in `src/` ever wrote it**, so a crashed agent was indistinguishable from an idle one.
  Where the P0 test used to carry a *tripwire* asserting that bucket was structurally always zero,
  it now asserts the positive property: a named session reports `statusCounts.error > 0`, the global
  DAG carries an `'error'` node, and its user-interrupted sibling on the same parent record is
  asserted `'unknown'` — the causes must not collapse · **Q5 "what changed across sessions" ✅**
  (closed 2026-09-02, WP-U11 — `GET /api/changes`; until then no diff/delta endpoint existed among
  the eight routes and the answer required stitching `/api/dag/global` with `/api/cost/summary`
  `perDay` client-side). This tick had been **overstated twice** — once before 2026-08-07
  (`/api/sessions/:id/cost-analysis` had no dashboard reader, so the compaction/delegation question
  was answerable only by curl; `SessionCostAnalysis.tsx` closed it) and again until the E2E proof
  above, because the ✅ was assembled from server and UI unit tests separately, with no test that
  booted a server and asked anything · <30s to understand a session — **unmeasured**: nobody has yet
  sat in front of it with a real corpus and timed it, and until Ivan does, this stays ⏳ (an agent
  cannot sign a usability claim) · tree & global DAG served by a query over persisted edges ✅ ·
  every dollar traces to tokens×price ✅.

### Closing board — the road to v1.0 = 100% _(plan of record: [`closing-plan-2026-09-08.md`](docs/analysis/closing-plan-2026-09-08.md); added 2026-09-08)_

"100%" is defined there as **`v1.0.0` tagged by KC-4 with every `RELEASE.md` box ticked,
`[HUMAN]` ones included**. The last 15% splits ~5% agent code/docs · ~3% owner decisions ·
~7% owner acts and measurements. Lanes below carry the plan's lane ids; a lane's full paths,
exit and proof live in the plan. Dated one-word answers under D1…D8 are the sign-off.

- [ ] **Wave 0 · 2026-09-08 → 2026-09-14 (KC-2)** — W0-A CHANGELOG `[Unreleased]` for the
  133-file uncommitted tree (agent) · W0-B decision batch **D1 commit · D2 Node pin · D3
  retention values · D4 `outcomeCause` surface · D5 SSE contract · D6 SS-1 wording · D7 the
  two KC-0 acts (do/waive) · D8 LABEL-ME commit caveat** (Ivan; defaults in plan §2) · W0-C
  commit + push on D1, CI green on the pushed SHA (Ivan) · KC-2 tick on 2026-09-14.
  - **Decisions recorded 2026-09-09** (Ivan, in chat: all eight recommended defaults of plan
    §2 accepted) — **D1 yes**: commit + push the whole uncommitted tree now, CI green on the
    pushed SHA before anything else is layered on · **D2 (a)**: `.nvmrc` = `22`,
    `engines.node` `>=22 <23`, README says so · **D3**: `DASHBOARD_RETENTION_EVENTS_DAYS=90`;
    `token_usage` never pruned in v1.0 (`NO_RETENTION` kept, the `acknowledgeCostLoss` refusal
    stays); backups `DASHBOARD_RETENTION_BACKUP_DAYS=30`, `_KEEP_MIN=7` · **D4 yes, minimal**:
    the cause as text on `error` rows in the Live view and the session tree, no new view, no
    colour · **D5 closed union**: typed `ingest-failed` arm, `GenericRealtimeEventSchema`
    deleted, an unknown `type` is dropped client-side and counted, documented in
    `docs/site/usage/api.md` · **D6**: chip reads `○ reconnecting (attempt N)` from the second
    failed attempt on, N from a real `SseClient` channel · **D7 do**: both KC-0 acts in Wave 3
    (the friction log doubles as KC-5 evidence) · **D8 commit**: the filled
    `annotations/human/` files plus a README note; CI keeps reporting "substrate unavailable",
    the locally ratified number goes to `DONE.md` with date and n.
  - W0-A done 2026-09-09: `CHANGELOG.md` `[Unreleased]` written from the 2026-08-25 → 09-08
    WORKLOG entries. W0-C pending: `apps/web` test half of CF-2/LV-9 held by the peer session.
- [ ] **Wave 1 · 2026-09-15 → 2026-09-28** — eight disjoint agent lanes: **L1** cost-summary
  `sessionCount`/`hasMore` · **L2** two-sided `hubIsWhole` + `describeCostFlow` owns the hub
  disclosure + CV-5 statement · **L3** `SseClient` attempt channel (D6) · **L4** typed
  `ingest-failed`, generic arm removed (D5; closes WP-U14) · **L5** `outcomeCause` on error
  rows (D4; closes WP-U13) · **L6** NODE-PIN (D2) · **L7** `SECURITY.md` + two site pages
  describing the widened `scripts/` gates · **L8** BENCH-SHAPE rerun at the real shape
  (agent measures, Ivan ratifies by ticking).
- [ ] **Wave 2 · 2026-09-29 → 2026-10-12 (KC-3)** — **L9** retention wiring on the signed
  values (closes WP-D10) · **L10** LABEL-ME kit: one evidence page per claim, read-only over
  `spike/` · **L11** time-to-understand kit: five sessions picked, log rows ready ·
  KC-3 tick on 2026-10-12 (P0-1/2/3 green + `ci` required).
- [ ] **Wave 3 · 2026-10-13 → 2026-11-08 — Ivan's, no new features** — fill the 60 claims,
  run the hierarchy gate, drop PROVISIONAL (closes WP-X2 + LABEL-ME) · stopwatch run on five
  sessions (closes the `<30s` clause) · **friction log, 14 consecutive days** (Step-0 box;
  doubles as KC-5 evidence) · one rival dashboard, five questions (Step-0 box) · agents take
  only log-raised defects; at most one velocity rebase.
- [ ] **Wave 4 · 2026-11-09 → 2026-11-22 — release candidate** — R1 mechanical
  `RELEASE.md` §1–3/5/6 pass (agent) · R2 docs truth pass + `CHANGELOG` `[1.0.0]` + `DONE.md`
  milestone + `0.3.0 → 1.0.0` (agent) · R3 the `[HUMAN]` boxes, COPY-with-attribution review,
  live backup→restore drill, usability signature (Ivan).
- [ ] **Wave 5 · by 2026-12-01 (KC-4)** — release commit, `v1.0.0` tag, push (Ivan) ·
  post-tag CI/Pages/badges green, `DONE.md` closed, this board reduced to the KC-5 items
  (orchestrator). One week of buffer; the critical path is D1 → Wave 3's 14 days → R3.

### Post-1.0 / v2.0 · Alerting core _(off the v1.0 critical path — best-path §6.1; **entered only via KC-5**: 14 consecutive days of real daily v1.0 use + ≥3 friction-log entries wanting alerts — roadmap §6. If that evidence never materializes, v2.0 never starts, and that is a success of the roadmap, not a failure.)_
- [ ] **WP-A2** alert/webhook schema · **A3** secret `token_ref` resolver · **A4** no-SSRF
  webhook dispatcher · **A5** rules engine (cost/stuck/error) · **A6** Telegram sink · **A7**
  delivery log + retry/backoff + dedupe.
- ~~**WP-A8** operator alerts API · **A9** alerts UI~~ — **CUT per best-path §6.2** (near-zero
  value for a single operator). **A10 kept** (SSRF/secret-leak negative corpus).
  _(WP-X9 release checklist moved to the Phase-4 tail — roadmap §5.)_
- **Exit gate:** one real condition → exactly one throttled notification · SSRF test proves
  no payload-URL dial-out · secret never in SQLite/SSE/logs · alerts modules >90% covered ·
  `RELEASE.md` enumerates every CD-7 gate + CD-9 check + a restore.

---

## Standing constraints _(apply to every lane — see the plan §8 Global DoD)_
- [ ] Loopback-only bind · mandatory-token-or-fail-startup · SSE same-origin · **no
  subprocess spawner** · no SSRF · secrets never in SQLite/SSE/logs.
- [ ] Ground-truth tokens **read, never inferred**; every dollar = tokens × dated price.
- [ ] No all-rights-reserved code copied (clean-room cast/disler/nirdiamant; attribute
  simple10/hoangsonww) — CI provenance scan enforces it.
- [ ] Coverage stays at **100%** on all four axes in all five packages — raised from the
  CD-7 floor of >90% on 2026-07-30 and pinned in every `vitest.config.ts`. Since
  **2026-08-25** it is **merge-blocking for a contributor and CI-failing for the owner**:
  `main` requires the `ci` check, but `enforce_admins` is off by design, because one
  maintainer working by direct push would otherwise be locked out of their own repository.
  (Earlier revisions of this line said ">90%, merge-blocking from Phase 1", and then
  "CI-failing, not merge-blocking, that rule is still unset" — the first was wrong on both
  halves, the second was right until the rule existed.) · `WORKLOG.md` entry per
  meaningful WP (written by the orchestrator) · AI-harness files stay git-excluded ·
  no commits without an explicit ask.

---
_Plan of record: [`docs/analysis/development-plan.md`](docs/analysis/development-plan.md)
(as amended by [`best-path-decision.md`](docs/analysis/best-path-decision.md) §6) ·
schedule of record: [`roadmap-v1-v2-2026-07-06.md`](docs/analysis/roadmap-v1-v2-2026-07-06.md)
(KC-0…KC-5 · analysis freeze §8) ·
decisions: [`concept-analysis-v2.md`](docs/analysis/concept-analysis-v2.md) ·
entry point: [`PROJECT-STATE-2026-07-06.md`](docs/analysis/PROJECT-STATE-2026-07-06.md) ·
completed: [`DONE.md`](DONE.md)._
