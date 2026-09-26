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
| **KC-2** | **2026-09-14** | Phase 1–2 exit gates green; at most **one** velocity rebase applied — **MET; ticked 2026-09-18, four days after the date** (the session that owns the tick was inactive 2026-09-10 → 09-18, so the bookkeeping is late, not the condition: nothing in the tree changed after 2026-09-10). Phase 1 and Phase 2 exit gates ✅ (their rows below), all eight gates green on 2026-09-18 over that unchanged tree (2,428 tests, 100% coverage ×5), CI `success` on the pushed SHA `39e565a`, **zero** velocity rebases applied. The descope ladder was not pulled. | Descope ladder (roadmap §5) or archive |
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
- [x] **WP-D10 retention+redaction** _(closed 2026-09-10 — L9 wired the signed D3 values)_ — redaction is live (**`apps/server/src/hooks/redact.ts`**
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
  **Held `[~]` until 2026-09-10 because:** the policy VALUES stayed blocked on OPEN-1/2/3 — Ivan's decision,
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
  - **Wired 2026-09-10 (L9, closes the row):** `loadRetentionValues` in `apps/server/src/config.ts`
    (defaults 90 / 30 / 7; `0` disables a rule; a malformed value throws;
    `DASHBOARD_RETENTION_TOKEN_USAGE_DAYS` set → refuses to start), `signedRetentionPolicy`
    in `retention/policy.ts` (`tokenUsage` always `null`), and `index.ts` chains
    `retention.run` after each *successful* daily backup inside its own try/catch; boot logs
    a dry run and prunes nothing. Journal: `<DASHBOARD_DB_PATH>.retention-journal.jsonl`.
    Docs: configuration.md, backup-restore.md, running.md, ADR CD-10 as-built 2026-09-10.
    Residual by decision: `token_usage` is unbounded in v1.0.
- [x] **NODE-PIN** _(toolchain, done 2026-09-09 — L6)_ — **the repo does not pin a Node version
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
  - **Done 2026-09-09 (L6):** `.nvmrc` = `22`; `engines.node` `>=22 <23`; `.npmrc`
    `engine-strict=true`; CI `node-version-file: .nvmrc`; README, `SECURITY.md`,
    `CONTRIBUTING.md`, three site pages. **Found while proving:** pnpm checks `engines` against
    the Node that runs pnpm — here corepack's shim hard-codes nvm's v22.23.2 (userAgent
    `node/v22.23.2`) — while `pnpm run` hands scripts the first `node` on PATH (`pnpm exec
    node -v` → v26.7.0). So a scratch copy with `engines` `>=22 <23` installs cleanly under the
    v26 shell and would still run vitest under v26: the plan's "fails at install" proof is
    vacuous on this machine, and the headline cascade lives at run time. Hence
    `scripts/check-node-version.mjs` (reads `.nvmrc`, compares majors, missing-is-loud, no
    child process), run first by `test` and `start` and standalone as `gate:node`. Proved:
    under the v26 shell `pnpm run test` stops at the guard with a pointed message (rc=1);
    under v22 it prints OK and the suite runs. Beyond D2's letter, within its intent — Ivan
    may veto the script. Not taken: pnpm's `useNodeVersion` (downloads its own Node; heavier
    than asked). Seven gates re-run after: all rc=0, spawner scans 266 files. **Coverage
    caveat:** `scripts/**` sits outside every package's coverage include, like the two
    existing gate scripts, so the 100 % table says nothing about this guard; its evidence is
    a ten-case `.nvmrc` probe (missing, empty, `lts/*`, trailing comment → rc=1; `22`, `22\n`,
    `v22`, `22.23.2` → OK; other major → rc=1), run 2026-09-09.
    **AMENDED 2026-09-23 (finding C-8).** "Run first by `test` and `start`" was true of the
    ROOT scripts only; every per-package entry point bypassed the guard. Measured that day:
    `pnpm --filter @agenthropic/server exec node -p process.version` → v26.7.0, unguarded.
    Now wired into `apps/server`'s `dev`/`start`/`bench`/`test`, `apps/web`'s `dev`/`test`
    and the `test` script of `packages/shared`, `packages/core`, `packages/test-fixtures`, as
    `node ../../scripts/check-node-version.mjs && …` (the script resolves `.nvmrc` from
    `import.meta.url`, so the relative path works from `apps/*` and `packages/*` alike).
    Proved: rc=0 from `apps/server` and `packages/shared` under v22, rc=1 from `apps/web`
    under v26 with the pointed message, and `pnpm run test` now prints the guard's OK line
    **six** times (root + five packages). Deliberately NOT wired: `build`, `typecheck`,
    `lint`, `format:check`, `render-claims` - the native ABI does not participate in them.
    Still bypassable by invoking `vitest`/`tsx` directly, which goes through no package script.
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
  - **Measured 2026-09-09, unratified** — five runs at the real shape, command lines and raw
    logs in `docs/measurement/cold-replay-2026-09.md` + `runs/2026-09-09/`: **81.68–92.29 s**
    at today's real per-session shape (61 sessions × 26.80 MiB, 2,747 B/record), **61.65 s** at
    this row's 2026-09-01 shape (53 × 26.19 MiB); the band scales with records, not bytes
    (byte-linear transfer underestimates it 1.10–1.61×), and the real shape costs 4.1–6.1× the
    band per session; synthetic lower bound (subagent bytes folded into one file). Ivan ticks
    this row; the doc's §7 lists every line that changes then.
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
    rows in the Live view and the session tree; no new view, no colour. Wave-1 lane L5. As
    applied: any non-NULL `outcomeCause` renders, whatever the status (see the Closing board);
    the Live-view half is open as D9.

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
- [x] **WP-U14 — the realtime schema assertion cannot fail.** `RealtimeEventSchema`
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
  mutation said so. **Was still open** until 2026-09-09: whether `GenericRealtimeEventSchema`
  should exist at all, and whether `ingest-failed` deserves a typed arm — a CD-5
  transport-contract question (what an unknown event type over SSE is allowed to mean), not an
  agent's call. Decided by D5 (Ivan, "всички", 2026-09-08), landed as L4 below.

  **CONTRACT HALF CLOSED 2026-09-09 (L4 / D5).** `GenericRealtimeEventSchema` and its type are
  deleted; `IngestFailedEventSchema` is the union's third arm — `type: Literal('ingest-failed')`,
  `payload: { sessionId, reason, attempt: Integer ≥ 1, willRetry, occurredAt }`,
  `additionalProperties: false` on both levels — and `RealtimeEventSchema` is a closed three-arm
  union. The `payload` envelope stays on purpose, byte-identical on the wire: the SPA carries no
  TypeBox and narrows this frame by hand (`toIngestFailureNotice`), so a flattened arm would have
  turned every quarantine notice into an anonymous counter with no gate going red — the same drift
  class WP-IN5's unheard event came from. The bridge now returns `IngestFailedEvent`; `hub.ts` keeps
  the CR/LF collapse as defence in depth (a closed union can no longer hand it a hostile `type`, and
  the hub test says so with a visible `offUnion` cast). `acceptingArms` reports exactly one arm for
  each of the three events the server emits, with negative controls per field (hoisted `occurredAt`,
  extra payload key, `attempt` 0 / 2.5, non-boolean `willRetry`, non-string `reason`, wrong `type`
  literal); the shared schema test refuses `{ type: 'custom', payload }` on the union. **Verified by
  mutation, restored byte-identical (`cmp`) after every run:** payload `additionalProperties →
  true`, outer `additionalProperties → true`, `attempt Integer → Number`, `attempt minimum 1 → 0`,
  `willRetry → Unknown`, `reason → Unknown`, `type Literal → String` — all seven **KILLED** by both
  suites; the last one SURVIVED the first pass and is what the wrong-literal negatives were added
  for. `docs/site/usage/api.md` documents the closed union and what an unknown `event:` name means
  (EventSource never delivers it, so never rendered; it still burns a hub `id`, so it surfaces as a
  stream gap and is counted there). Web half (peer lane): `IngestFailedEvent` re-exported type-only
  through `dto.ts`, a new `realtime-wire-shape.test.ts` pins the narrowing to the shared type
  (compiles only while the envelope exists; the flat shape → `null` is documented as a test),
  LiveView docblock amended. Peer's follow-up worth a line, not a wave: `session-ingested` and
  `agent-status-changed` are still narrowed by hand in `live-model.ts` with no type pin.
  **Follow-up closed 2026-09-26:** both arms are now pinned in `realtime-wire-shape.test.ts`
  (`agent-status-changed` in `live-model.ts`, `session-ingested` in `LiveView.tsx`, where it
  actually lives). The status guard gets an exhaustive `satisfies Record<keyof
  AgentStatusChangedEvent, true>` field list plus a drop-one-field sweep; the ingest reader gets a
  typed frame. Mutation-checked, restored byte-identical (`cmp`): a field added to the shared
  schema → `tsc -b apps/web` red on the field list; `sessionId` renamed → red on the typed frame;
  the guard's `agentId` check removed → `refuses a frame missing agentId` red. Web tests +9.
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

- [x] **Wave 0 · 2026-09-08 → 2026-09-14 (KC-2)** — W0-A CHANGELOG `[Unreleased]` for the
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
    WORKLOG entries. W0-C done 2026-09-09: the whole tree (156 files) committed as `39e565a`
    and pushed; CI run `34375436756` and Pages run `34375436730` green on that SHA. Both
    ran after the web lane finished CF-2/LV-9 and all seven gates were re-run locally (test
    1214/1214, coverage 100/100/100/100). The KC-2 tick was recorded on 2026-09-18 — four
    days late, condition met on the date (see the KC table) — which closes the row.
- [~] **Wave 1 · 2026-09-15 → 2026-09-28** — eight disjoint agent lanes: **L1** cost-summary
  `sessionCount`/`hasMore` · **L2** two-sided `hubIsWhole` + `describeCostFlow` owns the hub
  disclosure + CV-5 statement · **L3** `SseClient` attempt channel (D6) · **L4** typed
  `ingest-failed`, generic arm removed (D5; closes WP-U14) · **L5** `outcomeCause` on error
  rows (D4; closes WP-U13) · **L6** NODE-PIN (D2) · **L7** `SECURITY.md` + two site pages
  describing the widened `scripts/` gates · **L8** BENCH-SHAPE rerun at the real shape
  (agent measures, Ivan ratifies by ticking).
  - **L3 + L5 done 2026-09-09** (web lane, dispatched early — the row's gate is "W0-C green",
    the date range is the window). L3: `SseClient` keeps a ledger of consecutive failed
    attempts (`failedAttempts`, reset on open) and `SseStateHandler` is widened additively to
    `(state, failedAttempts)`; the chip reads `○ reconnecting (attempt N)` / `○ connecting…
    (attempt N)` from N ≥ 2, inside the label so it reaches the live region. Underneath, a real
    bug: `setState` compared the state word alone, so the 2nd+ failure of a reconnecting stream
    produced no notification — fixed and test-pinned. L5: `outcomeCauseText()` plus an
    `observed agent outcomes` list in TreePanel, read from `tree.agents` (not the layout) and
    outside the `role="img"` SVG; NULL renders nothing (test-pinned), an unrecognised value
    renders `unrecognised (<raw>)`. Web tests 665 → 681. Re-verified here 2026-09-09: all
    seven gates rc=0 under Node 22 (681/81/101/253/1214 tests, 100% coverage). CHANGELOG
    `[Unreleased]` carries both. Uncommitted, rides with the next explicit commit ask.
  - **L6 done 2026-09-09** (this lane) — see the NODE-PIN row for the mechanism and the
    run-time finding; CHANGELOG `[Unreleased]` carries it.
  - **L7 done 2026-09-09** (this lane) — `SECURITY.md` §2, `docs/site/security/model.md` §3
    as-built note, `docs/site/contributing/licensing.md` update block. Numbers re-taken from
    the gates' own output on this tree (spawner: 266 files / 4 roots / 1 allowlisted /
    6 manifests; licences: 412 packages / 429 installed versions / 411 allowlisted /
    1 documented exception, printed on its own line — the old "412 installed packages, all
    licenses allowlisted" wording predates finding L-1). The G-3 direct-dependency manifest
    scan is now described in all three, and the `spawner-gate-allow` census is corrected from
    "only the licence scanner" to three sites (licence scanner, the migrations-checksum
    test's `tsx` run, the shared loopback test). Docs only, no gate to re-run; prettier
    explicit on the three files green. Wave 1 open after L7: L1, L4, L8.
  - **L1 done 2026-09-09** (this lane: server + shared half) — `CostSummaryResponseSchema`
    gained two required fields, `sessionCount` (integer ≥ 0: every session with a rollup row,
    priced or unpriced — the population the slice was cut from, never the slice length) and
    `hasMore` (`sessionCount > topSessions.length`); `getCostSummary` fills them from
    `bySession.size`. Tests: the shared schema test demands both (the pre-L1 shape is refused;
    negative / fractional counts and a non-boolean flag fail), the route test proves two seeded
    sessions at default topN → `2 / false`, `topN=1` → `2 / true`, and a `DEFAULT_COST_TOP_N +
    1` corpus → `hasMore: true` with the exact count while an unpriced-only session still
    counts; the ledger oracle in the equivalence suite carries the fields, so its `topN ∈ {0, 1,
    2, n−1}` sweep checks them too (`topN=0` is HTTP-unreachable — querystring minimum 1 — and
    lives only there). `docs/site/usage/api.md` names the shape. Gates (Node 22): shared 82/82,
    server 1216/1216, typecheck, lint, format rc=0. The web half is the peer lane's L2, landing
    in parallel: fixture defaults derived from `topSessions` (not `0/false`, which would render
    "3 of 0"), `isCostSummary` requiring a number and a boolean (shape, not sanity — no integer
    check by that module's rule 1), CV-5 hedge → "N of M" statement, plus a discrepancy branch
    when `hasMore` is false yet dollars sit outside the slice. Monorepo gates re-run over the
    union once the peer reports. CHANGELOG `[Unreleased]` carries it. Wave 1 open after L1: L4,
    L8 (this lane) and the L2 web half (peer lane).
  - **L4 done 2026-09-09** (both halves) — closed realtime union: typed `IngestFailedEventSchema`
    (payload envelope kept, wire bytes unchanged), `GenericRealtimeEventSchema` deleted,
    `RealtimeEventSchema` three arms; bridge/hub typed accordingly; `acceptingArms` names exactly
    one arm per emitted event with per-field negative controls; seven mutations over the new arm all
    killed by both suites. Full detail on the WP-U14 row. Gates (Node 22): shared 84/84, server
    1216/1216, typecheck, lint rc=0; `format:check` red only on `apps/web/test/cost-view.test.tsx`,
    a peer-lane file mid-flight (CV-5), not touched here. Web half by the peer lane: `dto.ts` type-
    only re-export, `realtime-wire-shape.test.ts` pin, LiveView docblock amended. Wave 1 open after
    L4: L8 (this lane) and the L2 web half (peer lane, running).
  - **L8 measured 2026-09-09**, awaiting Ivan's tick — see the BENCH-SHAPE row's sub-bullet and
    `docs/measurement/cold-replay-2026-09.md`. Wave 1 open after L8: the L2 web half + CV-5
    (peer lane). Wave 2 launched 2026-09-09 on Ivan's launch-agents order: L9 (retention wiring,
    D3), L10 (LABEL-ME kit, D8), L11 (time-to-understand kit) — three background agents in this
    session's lanes; the board moves only after their gates are re-run here under Node 22.
  - **Doc drift fixed 2026-09-09** (found by the web lane): `graph.ts:12`, `common.ts:61` and
    `queries.ts:281` called the outcome cause "five-valued" / "the five causes"; the schema has
    six literals (`unclassified` is the sixth). Amended in place. `agent-outcome.ts:23`'s "five
    legible causes" is the corpus count (19/7/3/2/2 = 33) and stays.
  - **DagView, decided not omitted (2026-09-09):** `DagView.tsx` renders the same `AgentNodeDto`
    and could surface the cause identically; left untouched under D4's "minimal". Takes a lane
    only if the Wave-3 friction log asks for it.
  - **D4 as applied (2026-09-09):** `ERROR_CAUSES` in `normalize-session.ts` is a one-element
    set — only `terminated_early` yields `status: error` — so a literal "on `error` rows"
    filter would render 1 of the 6 causes and hide the 19-of-33 `concurrency_limit` refusals,
    while the plan's proof line wants each cause verbatim. Surface: any agent row whose
    `outcomeCause` is non-NULL renders it as text, whatever the status; NULL renders nothing
    (never "ok"). Text only, no new view, no colour — the rest of D4 stands. Ivan may veto.
  - **Open decision D9 (Ivan):** the Live view has no per-agent row — it renders session cards
    whose buckets are counts — so D4's "in the Live view" half is void as written. Attaching a
    cause there needs a session-level field on the sessions DTO (server + shared, this lane).
    Recommended default: **no for v1.0** — the session tree is where agents are; DagView is out
    of D4's "minimal" scope by the same reading. Found-not-taken by the web lane, not invented.
  - **L2 closed 2026-09-09** before Wave 1 opened: the web lane's CF-2 made `hubIsWhole`
    two-sided (`flow.hub` carries both drawn sides; labels `all cost` / `drawn cost` /
    `larger drawn side`), `describeCostFlow` states the hub note itself, and the CV-5 dollar
    statement over the top-sessions table was already in CostView — all in `39e565a`. Wave 1
    is seven lanes: L1, L3–L8.
  - Note 2026-09-09 for **L7**: `SECURITY.md:117-123` and `docs/site/security/model.md:277-283`
    enumerate the spawner gate more narrowly than `scripts/check-no-spawner.mjs` now checks
    (understated, not false) — found by the web lane, left for L7.
  - Open, found-not-taken 2026-09-09 (web lane, LV-9): a status frame applied while a
    RELOAD fetch is in flight is still discarded by the landing response. Deliberately not
    generalised — a "refetch if superseded" rule loops under a steady frame rate, the request
    storm LV-7 warned against. Takes a lane only if the Wave-3 friction log raises it.
  - **Row state 2026-09-18:** L1–L7 closed on 2026-09-09 (L2 before the wave opened, L3/L5
    by the web lane); the only open item is L8's ratification tick, which is Ivan's. `[~]`
    for that tick alone — no agent work is left on this row.
- [~] **Wave 2 · 2026-09-29 → 2026-10-12 (KC-3)** — **L9** retention wiring on the signed
  values (closes WP-D10) · **L10** LABEL-ME kit: one evidence page per claim, read-only over
  `spike/` · **L11** time-to-understand kit: five sessions picked, log rows ready ·
  KC-3 tick on 2026-10-12 (P0-1/2/3 green + `ci` required).
  - **Launched early on 2026-09-09** (Ivan's launch-agents order); all three lanes closed on
    2026-09-10 and their gates were re-run here under Node 22. The row stays `[~]` only for
    the KC-3 tick itself — Ivan's, on 2026-10-12. Its preconditions were re-verified on
    2026-09-18 without ticking (not due): `main` still requires the `ci` check
    (`gh api …/branches/main/protection` → `contexts: ["ci"]`, `strict: false`,
    `enforce_admins: false`) and P0-1/2/3 are green in the 2026-09-18 gate run.
  - **L9 done 2026-09-10** — see the WP-D10 row (now `[x]`) for the wiring; server suite
    1255/1255 with the new config/index/policy tests, 100% coverage held.
  - **L10 done 2026-09-10** — LABEL-ME kit in `packages/test-fixtures`:
    `src/annotations/render-claims.ts` (logic, under the coverage gate; 139 tests) +
    `annotations/tools/render-claims.ts` (tsx CLI, `pnpm --filter @agenthropic/test-fixtures
    render-claims -- <template id>`) + git-ignored `annotations/.render/`; README §3
    rewritten. Real renders over the local `spike/` corpus: b24be30c 42 claims (20 with both
    records, 22 with the parent record absent; joins tool_use 20 / directory 22), f28af3fd
    18 claims (all with both records; tool_use 15 / queue_operation 3). `human/` stays empty
    by design — filling the 60 claims is Wave 3, Ivan's; the hierarchy gate is still NOT
    CERTIFIED. Side effect: `pnpm-lock.yaml` +3 lines (tsx devDep for test-fixtures, needed
    for `--frozen-lockfile` in CI).
  - **L11 done 2026-09-09/10** — `docs/measurement/time-to-understand-log.md` §0: a launch
    line proven to boot over the real corpus with a scratch DB, a sizes-only pre-selection,
    the observed boot figures. The gate stays UNSIGNED until Ivan's stopwatch run. Its
    finding is the defect below.
  - **Defect found by L11, fixed 2026-09-10 — the real corpus was 52/60 unpriced.** With the
    shipped seed, `claude-opus-5` (×48) and `claude-fable-5-1` (×4) had no `model_pricing`
    row, so the halt gate parked 52 of 60 sessions and the dashboard showed 8. Migration 18
    `model-pricing-opus-5-fable-5-1` seeds both ids with all five buckets explicit, from the
    platform pricing page fetched 2026-09-10 (Fable 5.1 `cache_read` 0.25 = 0.025× input —
    the seed's 0.1× derivation would have been 4× too high), at the same floor, upsert on the
    PK so an operator's hand-written row converges instead of aborting; numbers live in the
    SQL text so the checksum is executor-stable (ec11bd68…, pinned in both checksum suites;
    agreeing set now 13 of 18). 35 rows / seven models; five new migration tests (fresh
    seed, the 0.025× exception, 17→18 upgrade, operator-row convergence, rollup re-pricing
    `''` → floor); schema/db-pricing suites bumped to 35. PROVISIONAL like the rest of the
    seed until WP-C1 ratifies. The corpus watcher re-reads pricing every pass, so parked
    sessions are re-admitted without a restart. **Re-run over the real corpus on 2026-09-18**
    (log §0.5): schema 18, 54 of 54 sessions admitted, `sessionsExcluded` 0, zero
    `unknown model id` halts — the fix is confirmed on the corpus that exposed the defect.
  - **Open decision D10 (Ivan) — the Sonnet 5 rate.** The seed carries `claude-sonnet-5` at
    3 / 15; the pricing page fetched 2026-09-10 lists Sonnet 5 at 2 / 10 standard. A rate
    change is not a coverage gap, so it was deliberately NOT folded into migration 18. If
    2 / 10 is the right rate for the observed window, every sonnet-5 dollar shown today is
    1.5× too high; whether the seed's figure was ever right is itself unratified (WP-C1).
    Recommended default: migration 19 with the official five-bucket rows at the same floor,
    shipped together with the WP-C1 ratification tick.
    **Decided and applied 2026-09-26** (Ivan, in chat: "продължавай" after the D10 offer) as
    **migration 20** — 19 had meanwhile gone to `claude-opus-5-5`. The pricing page re-read that
    day settles the "was the seed ever right" half too: footnote 3 says the $2 / $10 launch
    price "is now the standard price" and the scheduled 3 / 15 increase "will not occur", so the
    five floor rows are rewritten in place (`ON CONFLICT DO UPDATE`), not superseded by a dated
    row. Still 40 rows; the other seed models re-checked against the same page and unchanged
    (opus-4-8 5/25/0.5, fable-5 10/50/1, haiku-4-5 1/5/0.1). Checksum `1ab85d62…`, identical
    under tsx, vitest and `node --experimental-strip-types`. Four new migration tests; every
    existing dollar expectation that read the seeded Sonnet rate re-derived by hand (api-cost,
    cost-summary cache, aggregate-savings, dag-scoping), and the rollup tie test's sonnet inputs moved
    200k → 300k so every slice stays exactly $3. Mutation (input 2 → 3) killed by 5 tests.
    Server 1625 → 1629. **The WP-C1 ratification tick stays Ivan's.**
- [ ] **Wave 3 · 2026-10-13 → 2026-11-08 — Ivan's, no new features** — fill the 60 claims,
  run the hierarchy gate, drop PROVISIONAL (closes WP-X2 + LABEL-ME) · stopwatch run on five
  sessions (closes the `<30s` clause) · **friction log, 14 consecutive days** (Step-0 box;
  doubles as KC-5 evidence) · one rival dashboard, five questions (Step-0 box) · agents take
  only log-raised defects; at most one velocity rebase.
- [ ] **Wave 4 · 2026-11-09 → 2026-11-22 — release candidate** — R1 mechanical
  `RELEASE.md` §1–3/5/6 pass (agent) · R2 docs truth pass + `CHANGELOG` `[1.0.0]` + `DONE.md`
  milestone + `0.3.0 → 1.0.0` (agent) · R3 the `[HUMAN]` boxes, COPY-with-attribution review,
  live backup→restore drill, usability signature (Ivan).
  - **R1 rehearsed 2026-09-18** on the uncommitted tree (HEAD `39e565a` + 83 modified
    files): the appendix block — install, typecheck, lint, format:check, test (131 files /
    2,428 tests, 100% ×4 in five packages), gate:spawner (allowlist = the policy file only),
    gate:licenses (412 packages, one documented exception) — every exit code 0; §2 no-SSRF
    and corpus-read-only greps clean; §3 P0 4 files / 19 tests green; §5 automated
    `backup.test.ts` green; §6 dollar-trace suites green, `has_pages` true, Pages
    `HTTP/2 200`, license MIT, branch protection unchanged. The R2 dated figures were
    refreshed the same day (test totals 106/1554 → 131/2,428 in eleven places, `0.1.0` →
    `0.3.0` in four as-built notes, P0 3/13 → 4/19). A rehearsal ticks no `RELEASE.md`
    box; the `[HUMAN]` boxes, the §5 live drill, §7 and the whole pass re-run on the
    release commit. The same day, the R2 items that are true today: `PROJECT-STATE` gained
    a 2026-09-18 update block, ADR-0004/ADR-0006 and the decisions index a 2026-09-18
    addendum (eighteen migrations; `events_raw` still without an UPDATE/DELETE path), the
    analysis README bar paragraph a re-measured line. **2026-09-19:** the public
    `data-model.md` was still at thirteen migrations — inventory row and section for
    `token_usage_rollup` (16), `agents.outcome_cause` (17) in the `agents` section, ledger
    rows 14–18, the retention row closed (WP-D10 done 2026-09-10), ten tables not nine;
    `ingest-reconciliation.md`'s "WP-D10 is not done" got the same dated close. Later the
    same day the 2026-09-10 retention close reached the remaining summary blurbs —
    `README.md`, the site README, `data-model.md`'s library note, `glossary.md`,
    `testing.md`, the decisions index (ADR-0012 row), ADR CD-6 / CD-10, `comparison.md`,
    `faq.md` (three places), `roadmap.md` (two), `running.md` (the three
    `DASHBOARD_RETENTION_*` rows plus the loader paragraph) and `troubleshooting.md` §7;
    `api.md` now counts twelve routes and carries the `/api/cost/delegation-savings` and
    `/api/changes` payloads, `outcomeCause` on the tree node and the optional `coverage`
    block on the cost summary; `governance.md`'s "drafted, unpublished" rows closed
    (published in `ef40885`, 2026-08-15; `CODE_OF_CONDUCT.md` still absent); stale counts
    re-dated (`licensing.md`, `testing.md`, ADR CD-8, ADR LB-2, `roadmap.md` web tests);
    `SECURITY.md` `0.1.0 → 0.3.0`; `CHANGELOG.md`'s `substrate unavailable` token
    corrected. 36 substitutions across 20 files; `format:check` green; leak grep 0. The
    two "broken anchor" findings (`hooks-installer.md` → `#leak-free-token-acquisition-
    security-critical`, `telegram.md` → `#the-designed-setup-flow-planned`) were false
    positives: rendered with the pinned kramdown 2.4.0 + parser-gfm 1.1.0 stack and
    compared with GitHub's slugging, all 152 intra-site fragment links resolve (0 failing,
    0 missing targets, 0 kramdown-vs-GitHub differences) — only a naive slug rule that
    keeps the `_` emphasis markers would break them, and neither renderer uses it.
    Nothing changed. The same check surfaced a real Pages-only defect: `jekyll-relative-links` 0.6.1 does not rewrite a `.md` link whose text wraps onto a second source line (`LINK_TEXT_REGEX` stops at a newline), so the live `telegram.html` and `testing.html` carried raw `.md#…` hrefs that land on the unrendered Markdown file. 15 such links across 8 site pages (`cost-model.md`, `ingest-reconciliation.md`, `contributing/index.md`, `licensing.md`, `testing.md`, `faq.md`, `troubleshooting.md`, `telegram.md`) joined onto one source line each, blockquote and list prefixes preserved; rescan 0, `format:check` green, leak grep 0. A full read-only link audit followed the same day (1289 links across 89 `docs/**/*.md` sources; 0 missing local targets, 0 missing live pages of 81 expected, 0 dead external links, 1 external probe blocked by a 403 that a browser passes). The 35 links in 14 files from `docs/` to repo-root files (`README.md`, `CONTRIBUTING.md`, `TODO.md`, `DONE.md`, `RELEASE.md`, `SECURITY.md`, `CHANGELOG.md`, `LICENSE`) 404ed on Pages because the repo root is outside the Pages source; they now point at the GitHub `blob/main` URL (rescan 0), and two directory links (`external-docs-review.md` → `due-diligence/projects/`, `cold-replay-2026-09.md` → `runs/2026-09-09/`) point at the GitHub `tree/main` URL, since a directory without a README has no Pages index. The audit also found that the Primer footer's "Improve this page" link on all 82 pages was `edit/main/<page>` without the `docs/` segment (the Pages API reports `source.path` as `/` under a workflow build); `.github/workflows/pages.yml` now pins `github.source: { branch: main, path: /docs }` in the generated `_config.yml`. Verified against the pinned `jekyll-github-metadata` 2.16.1 source (`SiteGitHubMunger#github_namespace` deep-merges a `github:` config hash over its drop; `EditLinkTag#parts` joins `repository_url / edit / branch / path / page.path`) and then against a local build of the pinned github-pages 232 stack (Jekyll 3.10.0 + jekyll-github-metadata 2.16.1 + Primer 0.6.0 loaded from a scratch gem home on the system Ruby 2.6, `PAGES_REPO_NWO` set, no token): all 84 rendered pages carry `edit/main/docs/<page>`, 0 without; the live build on the next push is the final confirmation (Ivan's act). The same local build reproduced a Pages-only rendering defect the live site has today: Liquid runs before kramdown and treats `{{DASHBOARD_TOKEN}}` as a variable, so the copyable curl hook command on `hooks-installer.html` (×2), `running.html` and `hooks.html` read `Authorization: Bearer ` with nothing after it and the `{{…}}` mention vanished; the five spots are now wrapped in `{% raw %}` / `{% endraw %}` inside HTML comments (hidden on GitHub, honoured by Liquid), and the rebuilt pages show the template verbatim with no Liquid warning. `format:check` green after each batch, leak grep 0. Row stays open. Docs-truth sweep #3 (2026-09-19; four narrow agents after a first single agent died of context thrashing): every finding verified against the code before applying. 8 findings on the two security pages (the auth gate covers `/api/*` with the SPA carve-out; retention is signed and running under D3) and 39 substitutions on ten more files: `configuration.md` documents `DASHBOARD_WEB_ROOT` and counts eleven variables; `getting-started.md` no longer says the server hosts no UI or lacks a `start` script (`pnpm start` builds the SPA and the server serves it on the API's own origin, the dev SPA is the second-process route, curl expands the hook token at fire time); `hooks-installer.md` / `hooks.md` show `"async": true` and `--show-error`, name the per-firing `deliveryId` in the idempotency key and withdraw the byte-identical-Stop-body claim (amended 2026-09-02); `the-moat.md` no longer says retention is switched off and gains as-built notes for `orchestration_edges` / `token_usage`; `private: true` replaced by "publishable (`publishConfig.access: public`) but never published"; `README.md` counts nine read endpoints, six optional health fields, 30-day / floor-7 backups and CI on push to `main` plus PRs; `dashboard.md` twelve routes; `cost-model.md` attribution order (parser hard join, writer resolves `null` to the session id, migration 8 back-fills only pre-resolution rows) and migration-11 checksum wording; `docs/site/README.md` eighteen migrations, re-verified 2026-09-19. Left unverified on purpose: the Tailscale/Origin behaviour note, the WP-X9 wording, the `CostEngine` design name, the cost-model boot measurement, the "12-scenario" catalogue count, the simple10 licence row, branch protection, the 2026-09-10 wiring date. Raw-guard check, `format:check` and leak grep green. Row stays open. Docs-truth sweep #4 (2026-09-22; five agents over the pages the first three sweeps had not covered: architecture, `api.md` / `running.md` / `troubleshooting.md` / `telegram.md`, the guide pages and `testing.md`, the root community files plus `licensing.md` / `governance.md` / `STYLE-GUIDE.md`, and the ADRs): every finding verified against the code before applying; 67 substitutions across 27 files. Headline corrections: `dag-moat.md` states the as-built parent-resolution order (`directory` first, then `tool_use`, `queue_operation`, `task_notification`, `legacy_explore`), names migration 13 as the authority and the real migration-12 index names, and says `SubagentStop` carries a status verdict, never an edge; `ingest-reconciliation.md` reads compaction boundaries from `compactMetadata`, not the `PreCompact` hook; `data-model.md` and the ADR index count migration 18 as ten pricing rows; `api.md` and `troubleshooting.md` list all six optional health fields; `running.md` shows the real three-step `start` (Node-major guard first) and `--show-error`; `troubleshooting.md` no longer says hooks are liveness-only — a late `Stop` / `SubagentStop` reverts a watchdog `unknown` — and the retention window and cadence are the signed D3 policy; `telegram.md` marks the SSRF static gate as planned (no such pattern in `check-no-spawner.mjs`), counts the four test-side `fetch` sites and the `waiting`/unset watchdog inputs; `faq.md`, `SECURITY.md` and `STYLE-GUIDE.md` say the root package is unpublished (not `private: true`, which the workspace packages are) and retention is signed; `comparison.md`, `roadmap.md` (KC-2 row now MET) and `STYLE-GUIDE.md` count three P0 moat proofs plus the fourth over real HTTP, and the static-gate list drops the non-existent SSRF guard; `testing.md` counts eight fixtures and annotations, closes OPEN-2 (migration 4) and the retention TTL; `CONTRIBUTING.md` says `main` requires the `ci` check with `enforce_admins` off; `RELEASE.md` lists all seven CI commands (web build added, no box ticked) and the real auth enforcement points; `licensing.md` says an unused exception is reported, not fatal; `governance.md` records the community files in `ef40885`, only `CODE_OF_CONDUCT.md` missing, branch protection closed and four registered hooks; the ADRs gain dated as-built addenda (Normalizer/Projection stages exist since 2026-08-09 over parser output, fourth P0 proof, fifth edge mechanism, time-to-understand aid present but unmeasured, closing plan accepted 2026-09-08, five ADRs carry the desktop-probe update). The brief given to the agents wrongly said `source` has four values (migration 13 makes it five); no lane repeated the slip, and the three pages still saying four were fixed on top. Left unverified on purpose: GitHub-side state, measured figures, the 2026-09-10 wiring dates, the bot handle, the launchd deployment, design-era names and counts. Raw-guard, `format:check`, leak grep and `RELEASE.md` box-tick checks green. Row stays open. Docs-truth sweep #5 (2026-09-23; six agents, lanes J–O over architecture overview/glossary, security threat-model/remote-access, operations backup-restore, guide what-is-agenthropic, PR template, six ADRs + ADR template, `hooks/README.md`, the analysis entry point/README/closing plan, `parser-spec.md`, `DOCS-PLAN.md`): 29 findings verified against the code, all applied (plus 3 cross-lane: `testing.md` names the fourth P0 file; `open-decisions.md` gets dated D3 notes, Decided cells left to the owner); records only for the corpus figure, the CLAUDE.md/DESIGN.md quotations in `threat-model.md`, branch-protection state, the 412-package licence count and the Claude Code 2.1.251 payload claims. Raw-guard, `format:check`, leak grep and `RELEASE.md` box-tick checks green. Row stays open. Truth sweep #6 (2026-09-23; five agents, lanes P–T over server hooks/api/corpus, db/ingest/retention, core + shared, web/scripts/installer, fixtures/annotations/measurement docs): 48 code-comment and fixture-annotation findings verified against the code, all applied as 51 substitutions across 40 files (one duplicate dropped; the log reference block in the owner's time-to-understand measurement log left to Ivan). Owner items recorded, not edited: two stale comments inside checksummed migration 10, the `Shell.tsx` user-facing "every route is auth-gated" string, path numbering in `parse-session.ts` and a few dated-history comments. Suspected script defects reported, not fixed: `time-to-understand.mjs` answers the fleet Q4 per session, lists sessions without paging past 200, and its `[::1]` allow entry never matches (fails closed). All seven CI gates green (131 files / 2,428 tests, 100% coverage), leak grep 0, `RELEASE.md` untouched. Row stays open. Sweep #6 follow-up (2026-09-23; two agents): nine owner items settled in comments and one string (`parse-session.ts` renumbered to the real `resolveParent` order, `runner.ts`, `corpus-watcher.ts` pricing re-admission, `envelope.ts` + `install.mjs` no-retry sender, `top-burners.ts`, `dto-guards.ts` four exemptions, `CostView.tsx` four additions, `Shell.tsx:237` `/api/*`, `index.ts` M-13→M-18) plus four web test comments; the three `time-to-understand.mjs` defects fixed (IPv6 loopback, pagination, fleet Q4 savings). Still open for Ivan: migration 10's two stale comments (checksummed), `impl-review-2026-08-09.md:90` merging M-13 with M-18, T12. Seven gates green, 2,428 tests, 100% coverage. Row stays open.
  - **R1 rehearsed again 2026-09-26** on `af10c87` (branch `claude/fervent-maxwell-2hmdro`,
    clean tree), on Ivan's "continue by the roadmap": all seven CI commands plus `gate:node`
    exit 0 — 167 test files / 3,060 tests, 100% ×4 in five packages; spawner 313 files, the
    policy file the only allowlisted one; licences 406 packages / 428 installed versions, one
    documented exception. §2 no-SSRF grep empty, corpus write-symbol grep matches only the two
    in-file comments, no `0.0.0.0` in server source; §3 P0 4 files / 19 tests; §5
    `backup.test.ts` 4/4, and the live-drill command run against a **scratch** database at
    schema 20 printed `restore drill OK` (proves the command, not the live drill — that box
    stays Ivan's). `apps/web/vitest.config.ts` unchanged since `2f8d103`. CI's latest `main`
    run is `success` on `4b3cd2d`; the branch commits have no CI run (`ci.yml` fires on
    `main` pushes and PRs). Branch protection and Pages were not re-checked (no `gh`). No box
    ticked. **R2 figures refreshed the same day:** the 2026-09-23 "140 / 2621" reading was
    already stale on `main` (server 1,358 → 1,625 before this session's work), now dated
    2026-09-26 "167 / 3060" beside it in `README.md`, `RELEASE.md` §1, the site README,
    `testing.md` (per package), `contributing/index.md`, `comparison.md` ×2, `faq.md`,
    `roadmap.md`, `what-is-agenthropic.md` ×2 and the analysis README; gate outputs re-dated
    in `testing.md` and `licensing.md`. Historical readings kept, not overwritten.
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
