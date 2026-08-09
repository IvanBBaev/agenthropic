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
| **KC-3** | **2026-10-12** | The three P0 moat proofs green & merge-blocking | Archive |
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
  `docs/ai/` is git-excluded and absent from the CI checkout. **No longer blocked on
  Ivan** (2026-08-07): `configure-pages` runs with `enablement: true`, which turns Pages on
  via the API under the `pages: write` permission the workflow already holds, so the
  one-time Settings → Pages click is gone. Idempotent on every later run, and **not** a
  silent success path — a denied token still fails the step loudly rather than deploying
  nowhere. _(Nothing is deployed until the workflow actually reaches `main`, which needs a
  push, which needs an explicit ask.)_
- [ ] **WP-A1** alert port (v2-facing; not on the v1.0 critical path).
- **Exit gate:** coverage >90% green & blocking ✅ (now genuinely including `apps/web` —
  its script ran without `--coverage` until 2026-07-30, so the thresholds silently never
  executed) · security/license gates red on violation ✅ · WP-F7 green via WP-U0 ✅ ·
  `events_raw` append-only proven ✅ · WAL + tested restore ✅ · badges green ✅ — and as
  of 2026-07-30 the badge finally means what it says: CI is `success` on `9b6c6b3`, the
  first pushed commit containing Waves 1–4 (until then the newest run on `main` was
  `eded0b3` from 2026-07-12, so the badge attested only to the Phase-1 foundation) ·
  Pages builds ❌→🔄 — run `30528892265` failed in `configure-pages` with
  `Get Pages site failed … Not Found` while Pages was off; since **2026-08-07** the
  workflow runs `actions/configure-pages` with `enablement: true`, so the next push to
  `main` should switch Pages on and deploy by itself — tick this only after a green
  `pages.yml` run, not by assumption.

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
- [~] **WP-IN6** pure Normalizer · **IN7** projection — **folded into
  `ingest/ingest-session.ts`** by the divergence above (pure parse in
  `packages/core/src/parser`, single-transaction write in the server). The behaviour is
  covered; the two-stage decomposition is not built.
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
- **Exit gate:** three P0 tests green & merge-blocking ⏳ · hierarchy ≥95% without
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
  (`9b6c6b3`, GitHub reports `MIT`). Pages enablement is closed in the workflow itself
  (WP-X7, `enablement: true`). **Still open, and Ivan's alone:** `main` is not
  branch-protected.
- **Exit gate (= the v1.0 definition, best-path §6.1):** all 5 daily questions answerable ✅
  (server + UI — the "+ UI" half was **overstated until 2026-08-07**: `/api/sessions/:id/
  cost-analysis` had no reader in the dashboard, so the compaction/delegation question was
  answerable only by curl. `SessionCostAnalysis.tsx` is what closed it) · <30s to understand
  a session — **unmeasured**: nobody has yet sat in front
  of it with a real corpus and timed it, and until Ivan does, this stays ⏳ (an agent cannot
  sign a usability claim) · tree & global DAG served by a query over persisted edges ✅ ·
  every dollar traces to tokens×price ✅.

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
- [ ] Coverage stays **>90%** (merge-blocking from Phase 1) · `WORKLOG.md` entry per
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
