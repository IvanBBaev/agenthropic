# DONE

Completed milestones for **agenthropic**. Newest first. Open work lives in
[`TODO.md`](TODO.md); the sequenced build plan is
[`docs/analysis/development-plan.md`](docs/analysis/development-plan.md).

> Status legend used in `TODO.md`: `[ ]` open · `[~]` in progress · `[x]` done (moved here).

---

## Milestone 1 — Implementation (Phases 1–4)

_Started 2026-07-11 by an explicit owner override of CD-8, and continued past two
kill checkpoints that were **not** satisfied. That is recorded here rather than
smoothed over: KC-0 (2026-07-13) passed with 2 of 5 boxes open, and KC-1
(2026-07-27) passed with clauses 1 and 2 green but clause 3 — "the friction log has
not crowned a rival" — **unsatisfiable by construction**, because the friction log
was never opened. A checkpoint whose condition cannot be evaluated has not been
passed; it has been skipped. The override covers **dispatching only**: it does not
relax the security invariants, the LABEL-ME ratification (Phase-0 numbers stay
PROVISIONAL), Ivan's two physical KC acts, or no-commit-without-an-explicit-ask._

### 2026-07-11 → 2026-07-17 · Phase-1 foundation, security spine, parser
- Monorepo scaffold (`apps/server` · `apps/web` · `packages/shared` · `packages/core` ·
  `packages/test-fixtures` · `hooks/`, Node 22), lint + prettier, v8 coverage harness,
  CI, the **no-spawner gate** and the **license provenance scan**.
- SQLite/WAL with pragmas asserted at open, the migration runner, `events_raw` as an
  **append-only** substrate enforced by SQLite triggers, sessions/agents/edges/usage.
- Fastify bootstrap: **loopback-or-fail** plus a post-listen address re-verification
  that hard-exits, timing-safe token compare, same-origin SSE, TypeBox.
- Security review with a **critical auth fix**; WP-IN8 read-side reconstruction parser
  built and independently verified; a parser join-model defect found and rewritten;
  the disk substrate adapter and corpus ingest runner landed with two source defects
  fixed along the way.

### 2026-07-20 · Wave 1 — five parallel lanes + integration
- Ingest loop (poll tick, fingerprint-gated admission, replay-on-startup as the first
  tick) and the missing-Stop watchdog → `'unknown'`, an honest visible state.
- Cost engine: compaction repricing, delegation savings carrying `isEstimate: true`,
  and a model with no price **halting** with `PricingError` — never a silent $0.
- Read API + the SSE hub (CD-5: SSE, same-origin checked, never WebSocket), with the
  session tree and global DAG served by a query over the **persisted** edges.
- Hook receiver that **stores** unknown event types instead of crashing, redaction at
  the ingest boundary, and the hooks installer.
- SPA shell: token gate (sessionStorage only), connection chip, hash router, SSE client.

### 2026-07-29 → 2026-07-30 · Waves 2–4 — proofs, negatives, the real UI, release readiness
- **The three P0 moat proofs are green** (`apps/server/test/p0/`): Σ `token_usage` ==
  JSONL, checked by an **independent reader written inside the test** so a parser bug
  cannot make its own proof pass; a **byte-identical** double replay (`VACUUM INTO`
  snapshots compared with `Buffer.equals` under a fixed clock); and the DAG rebuilt
  from JSONL alone after a simulated outage, with hooks separately proven
  liveness-only — appending them leaves the DAG dump unchanged.
- **The 12-scenario negative catalogue** passes in full, including byte-identical 401
  bodies across four wrong-token shapes (no token echo, no length oracle), a 403 on a
  foreign `Origin` **with and without** a valid token (no auth oracle), and an unpriced
  model halting before the write transaction leaves the DB entirely empty.
- **The four dashboard views are real**: live status, session tree, global DAG,
  cost/Sankey — with `unknown` as a first-class always-rendered bucket kept distinct
  from a `null` "unrecorded" status, observed vs inferred edges visually distinguished
  behind a permanent legend, truncation announced with real numbers, and
  `unpricedTokens` given its own KPI instead of being drawn as a $0 flow.
- **WP-D5 closed honestly**: the `events` table was created but never written to — a
  lie by omission in a shipped schema. It is now **wired**, not retired: raw row plus
  normalized projection in one transaction, identifiers only (never payload content),
  receipt time labelled as such via `occurredAtSource: 'receipt'`, and a reader at
  `GET /api/sessions/:id/events`.
- **Release readiness**: `RELEASE.md` with the backup→restore drill **actually executed**
  (`integrity_check` = ok), README badges backed by real signals only, and a GitHub
  Pages workflow using official actions and zero new dependencies.
- **Two honesty defects found and fixed rather than shipped**: the README still claimed
  "Pre-code … no application code yet", untrue since 2026-07-11; and ">90% coverage,
  CI-gated" actually held for three of five packages — `apps/web` ran without
  `--coverage`, so its thresholds never executed.
- **Full gate, real numbers:** typecheck · lint · format:check all green ·
  `gate:spawner` OK (174 files, 4 roots) · `gate:licenses` OK (412 packages) ·
  **72 test files / 879 tests passing** — server 489 (99.75% stmts / 97.70% branches),
  core 168 (100% / 95.62%), shared 72 (100% / 100%), web 127 (99.07% / 91.50%),
  test-fixtures 23 (a documented, deliberate coverage-gate exclusion).

### 2026-07-31 → 2026-08-09 · Hardening waves — coverage truth, corpus-scale performance, the status lifecycle, and every `null` made to speak
- **The coverage number was made true, then pinned.** `packages/test-fixtures` ran
  `vitest run` with no `--coverage`, so its thresholds had never once executed; fixed
  and brought into the gate. Thresholds were then raised from the workspace floor of 90
  to the level each package actually holds, verified by a deliberate failing run at 101.
  Every `/* v8 ignore */` under any `src/` was **deleted and replaced with a real test**
  (one was hiding genuinely reachable cycle-cutting code), and per-package guard tests
  now sweep the source **as text, never imports** and fail the build if a pragma —
  or a threshold below 100, or an `exclude` — ever returns. All five packages sit at
  **100% statements / branches / functions / lines, enforced**.
- **Five audited correctness defects; four fixed, the fifth became a feature.**
  `INSERT OR IGNORE` froze the first mid-stream read of a streaming turn forever
  (permanent under-count) → convergence upsert with per-bucket MAX whose `WHERE` guard
  keeps the byte-identical replay proof green; hook idempotency conflated recurrence
  with redelivery (a 50-turn session stored ONE `Stop` row) → sender-minted per-firing
  `deliveryId`; ingest failures were swallowed while `/api/health` said `ok` → bounded
  fingerprint-keyed retry + an SSE failure event; main-agent tokens sat unattributed so
  every root node read $0 → storage-layer fix + backfill migration 8. The fifth —
  everything was written `'completed'` — became the **status lifecycle**: `working`
  (ingest) / `waiting` (`Stop`) / `completed` (`SubagentStop`) / `unknown` (watchdog),
  observed terminals sticky, inferred states advancing only on a strictly newer anchor.
  The WP-IN12 watchdog is live code now, not an inert knob.
- **Corpus-scale benchmark** (`apps/server/bench/`, with an `assertSynthetic()` guard
  that refuses any path near the real corpus) exposed two read-path defects, both
  proven at the sqlite3 prompt before fixing: an unfiltered priced CTE made paging
  price all 752k usage rows (627 ms → 9 ms byte-identical), and the cost summary ran
  that scan four times → one rollup. The projection it produced — warm tick 3.6% duty
  cycle, **cold replay ~137 s** — is recorded as a product risk feeding OPEN-1/2/3,
  answered meanwhile by persisted replay checkpoints. **Corrected 2026-09-01:** that
  line used to say "over the real **1855-session** corpus". `1855` counts **subagent
  transcripts**, not sessions — the census of record (`docs/analysis/parser-spec.md`
  §4.2) is **141 sessions** — so the ~137 s was extrapolated onto a target roughly 13x
  the real session count. The bench now runs at census scale and has **measured** cold
  replay at **39.92 s and 34.87 s over 996.4 MiB / 141 sessions** (Node v22.23.2,
  darwin arm64), as one synchronous event-loop stall. **Resolved 2026-09-01: the ~137 s
  is retired as wrong, not carried as "unverified"** — unverified means we do not know,
  and we now know. This line used to refuse to rescale the projection into the
  measurement, on the grounds that 12.80 GiB and 0.97 GiB describe different corpora.
  That refusal was right, and is exactly what kept the question answerable. What settled
  it was provenance, not rescaling: the 12.80 GiB was never measured either. It implies
  12.80 GiB / 1855 = **7.0659 MiB** per session; the measured corpus gives
  996.4 MiB / 141 = **7.0667 MiB**. Two supposedly independent quantities do not agree to
  **0.011%** by chance — it is one clone size multiplied by two different session counts,
  i.e. the same 13x transcripts-for-sessions error expressed in bytes rather than counts,
  which is why it survived the round of corrections that fixed the counts. Corrected, the
  projection targeted **the exact scale since measured**, so the two are directly
  comparable: it overstated cold replay by **3.43-3.92x**. The product risk is unchanged
  at either scale.
- **Web honesty audit: 11 violations, each fixed test-first.** Two real crashes (an
  unrecognised status word took out both D3 views; the live board painted `NaN` from a
  missing bucket) and nine confident lies in copy — `null` slug as "no project", an
  absent count as "0 waiting", `$0.00` beside unpriced tokens, the session-level
  `unknown` not rendered at all. Chart facts became visible prose (`chart-summary.ts`)
  instead of hover-only `<title>`s hidden by `role="img"`.
- **Every load-bearing `null` was split into named facts.** `tick()` returns a
  seven-arm `TickOutcome` union and the boot line says which one happened (a missing
  corpus root and a healthy quiet one no longer boot identically silent); the
  cost-analysis route stopped answering three different absences with one false
  `404 Session not found.` — no-root 503, unreadable-root 503 and true 404 are now
  three distinct sentences, carried through to the SPA verbatim.
- **Landed alongside:** the WP-D10 retention mechanism (bounded transactional prune,
  fsync'd cost receipt inside the delete transaction, a static guard proving no DML
  ever targets the ground-truth tables; policy VALUES still blocked on OPEN-1/2/3) ·
  the WP-X2 annotations loader + hierarchy gate (one-sided Wilson bound, n ≥ 52,
  "substrate unavailable" rather than a vacuous pass) · `SessionCostAnalysis.tsx`,
  closing the exit-gate claim that was true of the server and false of the dashboard ·
  the time-to-understand protocol (`docs/measurement/`, runnable by Ivan alone).
- **A five-lane read-only audit** (security · honesty · concurrency) re-verified all
  seven security invariants PASS and produced twelve verified findings; the six Ivan
  approved were fixed — honest compaction KPI labels, the hook `applyStatus` seam
  surviving crash-retry redelivery, transactional status pairs, LiveView refetching
  persisted truth on SSE reconnect, unreadable-root in the substrate union, the
  `formatUsd` `<$0.0001` floor — and the new suite promptly caught a real bug in one
  fix's own wiring (`deps.onTickOutcome?.(tick())` — an optional call short-circuits
  its *arguments*, so an unwired watcher never ticked).
- **Full gate, real numbers (2026-08-09):** typecheck · lint · format:check green ·
  `gate:spawner` OK (214 files) · `gate:licenses` OK (412 packages) · **1318 tests
  passing, 100/100/100/100 in all five packages** — server 731, web 232, core 193,
  test-fixtures 90, shared 72. Test count rose 879 → 1318 across the span.

### 2026-09-01 → 2026-09-02 · The v1.0 exit gate goes 3-of-5 to 5-of-5 — by first disproving it

- **The gate was tested end-to-end for the first time, and two of the five daily questions
  failed.** `apps/server/test/p0/p0-five-daily-questions.test.ts` boots a real server over a
  real corpus (`materializeCorpus` → `runCorpusIngest` → `buildServer`) and asks every question
  over HTTP with a Bearer token. Until it existed, the ✅ marks had been assembled from
  server-side and UI-side unit tests separately, with **no test that booted a server and asked
  anything**. Q4 and Q5 turned red the moment one did.
- **WP-U10 — Q4's "failed" half had no producer.** `status = 'error'` was declared in four
  places (the SQLite `CHECK` constraint, the `AgentStatus` union, an `error_count` SUM, a DTO
  field) and **written by nothing in `src/`**. Every consumer was correct, every test passed,
  and 100% coverage on all four axes could not see it — coverage measures whether written code
  RAN, never whether a declared value is ever PRODUCED. The dashboard had a column that was
  structurally always zero, so a crashed agent was indistinguishable from an idle one. Closed
  by `packages/core/src/parser/agent-outcome.ts` (classifier) plus `ERROR_CAUSES` in
  `apps/server/src/ingest/normalize-session.ts` (promotion), driven end-to-end by a new
  `agent-outcome-errors` fixture. The **discriminating** assertion is the sibling one: two
  errored spawns on the same parent record must land on *different* statuses
  (`terminated_early` → `'error'`, `user_interrupt` → `'unknown'`), because flattening the
  five observed causes into one bucket would be a fresh lie in place of the old one.
- **WP-U11 — Q5 had no endpoint.** "What changed across sessions" required the caller to stitch
  `/api/dag/global` with `/api/cost/summary` `perDay` client-side. Closed by `GET /api/changes`
  (`apps/server/src/api/routes.ts:449`), auth-gated like every other route.
- **The corpus figures behind WP-U10 were wrong on the board and right in the code.** `TODO.md`
  claimed "30 error terminals in four causes"; `agent-outcome.ts` had said "33 in five" since
  it was written. Re-verified over 2633 transcripts / 442,140 records: **ok 1369 / error 33** —
  19 `concurrency_limit`, 7 `user_interrupt`, 3 `permission_failed`, 2 `dispatch_unavailable`,
  2 `terminated_early`. The board's scan had collected `Task`/`Agent` spawns but not `Workflow`
  ones, which made `permission_failed` look like a bucket invented without a corpus behind it.
  Recorded as a dated **ERRATUM**, not a silent edit. The `ok` count moved 1243 → 1369 with
  corpus growth; **the error count and the cause set did not move at all**, so the five causes
  are a property of how agents fail rather than of what was on disk in July.
- **A near-miss worth keeping.** The first re-verification returned "36" by asking whether a
  failed tool result *mentioned* a subagent — precisely the tool-level `is_error` heuristic
  `agent-outcome.ts` names as forbidden ("a failed grep and a missing file are not a failed
  agent"), which swept in 15 `Exit code 1` Bash results. It was one substring away from being
  reported as a correction to a docstring that was already correct. A wrong denominator
  announces itself; a wrong **predicate** returns a plausible number in the right units.
- **`eslint .` was reporting on files that are not in the repo** — 5 warnings, all from a stale
  187 MB `.claude/worktrees/…` copy. `.claude/` is harness-local and git-excluded, so the noise
  described files that will never be committed while masking any real warning in files that
  will. `.claude/**` added to the ignores in `eslint.config.mjs`; lint is now **0 warnings**.
- **Full gate, real numbers (2026-09-02, verified by a run under the pinned Node 22 — not
  relayed from an agent's report):** typecheck · lint · format:check · `gate:spawner` ·
  `gate:licenses` all exit 0 · **2032 tests in 126 files passing, 100/100/100/100 in all five
  packages** — server 1213, web 387, core 251, test-fixtures 101, shared 80. Test count rose
  1318 → 2032 since 2026-08-09.
- **Toolchain trap, recorded because it cost a wasted debugging pass:** the shell default
  `node` on this machine is **v26**, `better-sqlite3` is compiled for Node 22, and a v26 run
  fabricates a large cascade of unrelated failures that reads exactly like real breakage. Every
  run above was made under `v22.23.2`. The repo still pins nothing (**NODE-PIN**, open).

### 2026-09-02 · The 5-of-5 audited by mutation testing — two of the five ticks did not survive

- **The exit gate was attacked instead of re-run.** A falsification lane injected deliberate
  defects at the exact sites each of the five daily questions claims to verify. Two assertions
  turned out to be **unable to fail**, both by the same mechanism that hid WP-U10: an arm of the
  code with no producer in the fixture.
- **The dated price was decorative.** `apps/server/test/p0/harness.ts` seeded a *single* pricing
  epoch, so `ORDER BY effective_from DESC` and `ASC` select the same row — the end-to-end proof
  of "every dollar = tokens × **dated** price" never exercised the dating. Fixed by seeding a
  superseded, **strictly dominated** 7 USD/Mtok 2019 rate behind the live 1 USD/Mtok 2020 one:
  never the right answer for any row, and 7× off, so no rounding tolerance can absorb a wrong
  pick. `DESC` → `ASC` now turns **Q5 red** at `apps/server/src/api/queries.ts:59` and **Q2 red**
  at `apps/server/src/db/migrations.ts:917`. The split also documented itself: `/api/cost/summary`
  is served from the `token_usage_rollup` materialization, `/api/changes` from the API's own
  `pricedCte`. Dated-price resolution is implemented **three** times in this repo; the P0 gate
  had been exercising none of them *as dated*.
- **`/api/changes`'s `'updated'` label had no producer.** Every fixture session is minutes long
  and they sit in two tight clusters, so both windows the test asked for contained only sessions
  that also *started* inside them. Swapping the `'new'` and `'updated'` arms
  (`queries.ts:1563`) passed green. Fixed by **deriving** a third window at the midpoint of the
  earliest session that measurably spans time — not hard-coding a date that rots when a fixture
  moves — plus per-row `change`-map equality across all three windows, a
  `new + updated + unknown == total` partition check, and explicit anti-vacuity assertions that
  both labels actually occur.
- **Both remedies were null-hypothesis tested.** Restore the old fixture/test text, keep the
  mutation: **6 passed (6)** in each case. So the new kills belong to the new assertions and not
  to some pre-existing check that would have caught the defect anyway. Without that control the
  audit would have been indistinguishable from the thing it was auditing.
- **A published mutation result of my own was withdrawn.** The previous entry recorded M17 (drop
  `'error'` from the sticky arm of `AGENT_STATUS_CASE`) as a kill on "1 failed | 12 passed". The
  baseline was already **red**: my own test passed `parentAgentId: ROOT_ID` while `beforeEach`
  seeds only the session, so SQLite threw `FOREIGN KEY constraint failed` with *and* without the
  mutation. Seeded the parent, re-ran honestly — M17 kills **exactly one** test across the whole
  1214-test server suite. **A mutation kill is only valid if the baseline is green first**, and
  that rule is now written down because breaking it produced a plausible-looking number.
- **"Real corpus" was the wrong word on the board.** The exit-gate line said the P0 proof runs
  "real corpus → real `runCorpusIngest` → real `buildServer`". In this repo "real corpus" means
  `~/.claude/projects`, which P0 has never touched. Everything downstream of the files *is* real
  — no stubs, no fakes, no in-memory shortcut — but the proof covers 8 curated, all-parseable
  fixture sessions and says nothing about the 141-session / 996.4 MiB census. Corrected in place
  with a dated note stating both halves.
- **The dead-value sweep found three more, all verified before being written down** — and none
  patched silently, because two are contract decisions: **WP-U12** seven `*Row` interfaces in
  `packages/shared` with zero importers that also **contradict the schema** (`AgentRow` says
  `started_at`/`ended_at` against `first_seen_at`/`last_seen_at`; `TokenUsageRow` describes a
  *wide* row against a *tall* table) — a type nobody imports can never fail a typecheck;
  **WP-U13** `agents.outcome_cause` written by ingest and read by nothing, the exact mirror of
  WP-U10; **WP-U14** the realtime schema assertion `Value.Check(RealtimeEventSchema, event)`,
  which cannot fail on shape because the union's third arm accepts any `{type: string, payload:
  object}` — a tautological assertion sitting inside the suite meant to catch tautologies.
- **The corpus figure moved a third time, and the important half did not.** Re-measured over
  **2693 transcripts / 461,334 records, 0 unparseable**: **ok 1421 / error 33**, causes
  19 / 7 / 3 / 2 / 2. `ok` has gone 1243 → 1369 → 1421 across three scans in two days — corpus
  growth, nothing else — while the error count and the five causes have not moved at all. That
  stability is the finding: the causes are a property of how agents fail, not of what was on disk.
- **Full gate, my own run under `v22.23.2` (not relayed):** typecheck · lint · format:check ·
  `gate:spawner` (262 files, 1 allowlisted) · `gate:licenses` (412 packages) all exit 0 ·
  **2035 tests in 126 files, 100/100/100/100 in all five packages** — server 1214, web 387,
  core 253, test-fixtures 101, shared 80.

### 2026-09-02 · WP-U12 closed — and the closure corrected the plan that opened it

- **The seven dead `*Row` interfaces are gone, and so are three type aliases the board had
  called load-bearing.** `packages/shared/src/types/rows.ts` declared six string unions and
  seven interfaces that claimed, in their own docstring, to be "the cross-package data
  contracts" that "every workspace consumes". All seven interfaces had **zero importers**;
  two had drifted into contradicting the schema they claimed to mirror (`AgentRow` declaring
  `started_at`/`ended_at` against `first_seen_at`/`last_seen_at`; `TokenUsageRow` describing a
  *wide* row against a *tall* `token_usage` table). Four of the names were meanwhile redeclared
  locally, and correctly, at their point of use — which is exactly why the originals were free
  to rot. A type nobody imports can never fail a typecheck.
- **The interesting half is what the fix found out about the plan.** TODO.md's action read
  "delete the seven interfaces, keep the six type aliases — they are load-bearing (`AgentStatus`
  63 references, `OrchestrationEdgeSource` 17, `AgentType` 10, …)". Three of the six were not
  load-bearing and those counts were not references to that file. `index.ts` re-exported
  `AgentStatus`, `AgentType` and `OrchestrationEdgeSource` **explicitly** from `./schemas/common`
  while also carrying `export type * from './types/rows'` — and **an explicit re-export shadows a
  star re-export**. Every consumer outside the package already resolved to `schemas/common`; the
  copies in `rows.ts` were reachable only from inside that one file. The number had been produced
  by counting **name occurrences and calling them references** — substring, not resolution: the
  identical error this board already records twice, committed by the same hand that wrote the
  warnings. Two independent declarations of one union with nothing holding them in step is drift
  waiting to happen; they happened to still agree, which is luck, not a guarantee.
- **What shipped.** `types/rows.ts` → `types/enums.ts`, holding only the three unions that are
  genuinely load-bearing and genuinely have no schema of their own — `AgentOutcomeCause`,
  `TokenBucket`, `RawEventSource`. `schemas/common.ts` is now the single declaration of the other
  three, and the better one, being derived from the runtime TypeBox validator rather than sitting
  beside it. Two importers updated (`index.ts:1`, `ports/event-store.ts:7`). **The index line is
  now an explicit named re-export rather than `export type *`** — the star export is what let a
  duplicate declaration hide in plain sight, so with every export named the next duplicate is a
  compile error instead of a silent shadow. A stale `dist/src/types/rows.d.ts` orphaned by
  incremental `tsc -b` was removed too; it is gitignored, untracked and regenerated, but it had
  already fooled one grep during this very change.
- **Gates, real numbers, all five packages green and unmoved:** typecheck · lint · format:check
  exit 0; `gate:spawner` OK (262 files, 1 allowlisted); `gate:licenses` OK (412 packages);
  **2035 tests in 126 files, all passing, 100% on all four axes everywhere**. `packages/shared`
  coverage counters are byte-identical before and after (83/18/8/83) — the deleted code
  contributed **zero** runtime statements, which is the measurement that confirms it was dead
  rather than merely quiet.

### 2026-09-02 · WP-U14 test half — the assertion that could not fail now fails on demand

- **The tautology is gone, and it was hiding two worse things.** `realtime-bridge.test.ts:104`
  asserted `Value.Check(RealtimeEventSchema, event)` on an event that lands on the union's
  catch-all arm — and `GenericRealtimeEventSchema` accepts **any** `{type: string, payload:
  object}`, so the check could not see one thing about the payload it was nominally validating.
  While replacing it: the check was applied **only** to that catch-all event. The two events with
  real typed arms — `session-ingested` and `agent-status-changed`, where a union check has genuine
  bite (`additionalProperties: false`, a literal `type`, integer minimums) — were asserted with
  `toEqual`/`toMatchObject` alone and **never met the shared schema at all**. The teeth were
  everywhere the check was not.
- **The fix names the arm.** `acceptingArms(event)` returns which of the three arms accept an
  event, in a fixed order, so "some arm said yes" becomes "exactly this arm said yes and the other
  two refused" — a claim that fails if any arm is loosened or a typed event decays onto the
  catch-all. The generic-arm case additionally carries a **negative control**: hoisting
  `occurredAt` out of the payload must be refused by all three arms, which is the one thing that
  arm genuinely enforces and the only thing that gives the positive assertion any weight.
- **Verified by mutation — baseline green first, `realtime.ts` restored byte-identical (`cmp -s`)
  after every run.** Generic arm `additionalProperties: false → true`: the **old** form was re-run
  as a scratch test under the mutation and **passed** — the tautology is measured, not asserted —
  while the new form dies with `expected [ 'generic' ] to deeply equal []`.
  `SessionIngestedEventSchema.agentCount` `Integer → String`: dies with `expected [] to deeply
  equal [ 'session-ingested' ]`. `previousStatus` `nullable(…) → AgentStatusSchema`: **survived
  the first repair**, because `toMatchObject({previousStatus: null})` passes just as well against
  a schema that forbids the null; killed only after the null-previous-status test got its own arm
  assertion. That third one is the finding worth keeping — the repair was itself incomplete, and
  nothing but the mutation would have said so.
- **Not closed, and not an agent's to close:** whether `GenericRealtimeEventSchema` should exist
  at all, and whether `ingest-failed` deserves a typed arm. That is a CD-5 transport-contract
  question — what an unknown event type over SSE is allowed to mean — and it stays on the board.
- **Gates:** typecheck · lint · format:check exit 0; `gate:spawner` OK (262 files, 1 allowlisted);
  `gate:licenses` OK (412 packages); **2035 tests / 126 files, all passing, 100% on all four axes
  in all five packages**, coverage counters unmoved.

### 2026-09-03 · WP-U13 API half — the column ingest wrote for nobody now reaches the wire

- **`outcomeCause` is a served field, not just a stored one.** It is a required, nullable property
  on `AgentNodeDto` (`packages/shared/src/schemas/graph.ts`) and is selected and mapped by **both**
  node readers in `apps/server/src/api/queries.ts` — `getSessionTree` and the global-DAG query.
  NULL is served as NULL: "no outcome was observed" is not a claim that the agent succeeded, and
  the causes stay distinct on the wire exactly as the column holds them.
- **The board said "the five causes"; there are six.** Migration 17's CHECK
  (`apps/server/src/db/migrations.ts:1096-1097`) admits `unclassified` alongside the five named in
  the census, and an API union that dropped it would have rejected rows the database can legally
  hold — a 500 on serialization for data that is entirely valid. The count in the finding was
  copied from the *census* (which only ever observed five) and read as if it were the *schema*.
- **The union had no runtime validator at all** — only a hand-written alias in
  `packages/shared/src/types/enums.ts`. Adding a TypeBox schema beside it would have rebuilt the
  WP-U12 defect one week after closing it: two declarations of one name, one shadowed and dead. So
  the declaration was **moved, not copied** — `schemas/common.ts` owns `AgentOutcomeCauseSchema`
  and derives the type from it; `enums.ts` records why it left. All eight import sites resolve
  through `@agenthropic/shared`, so no consumer changed.
- **Proved by mutation, not by coverage** (baseline green first; `queries.ts` restored
  byte-identical with `cmp -s` after every run). The seeds give each agent a *different* cause and
  leave both mains NULL, so a reader that hard-coded a constant or derived the cause from `status`
  cannot produce the expected list. Mapper → `null`: **killed**, both endpoints. Dropping
  `ag.outcome_cause` from the session-tree SELECT: **killed**, and *only* `api-sessions` failed.
  Dropping it from the global-DAG SELECT: **killed**, and *only* `api-dag` failed. Each SELECT
  list has its own witness — neither hides behind the other's coverage.
- **Not closed, and not an agent's to close:** whether a ~2-agent `error` bucket justifies any
  dashboard surface at all. Nothing in the web app reads `outcomeCause` yet, and this closure
  deliberately did not invent a place for it. The UI half stays on the board as Ivan's.
- **Gates, my own run under `v22.23.2`:** typecheck · lint · format:check exit 0; `gate:spawner`
  OK (262 files, 1 allowlisted); `gate:licenses` OK (412 packages); **2040 tests / 126 files, all
  passing, 100% on all four axes in all five packages** (shared's statement count moved 83 → 84 —
  the one new schema line — and nothing else moved).

### 2026-08-25 → 2026-09-26 · 0.3.0, the closing plan, Waves 0–2, and the hardening wave

_Written 2026-09-26 as a Wave-4 R2 item, from the three commits of the span (`40f1524`,
`39e565a`, `4b3cd2d`) and the `TODO.md` Closing board rows. The per-item detail — commands,
counts, mutation results — lives there and in `CHANGELOG.md` `[Unreleased]`; this is the
milestone record, not a second copy._

- **`40f1524` (2026-08-25) — defect wave D-5…D-8 and 0.3.0.** A symlinked session directory
  was walked and fingerprinted (D-5; the guard consolidated into `corpus/corpus-paths.ts`);
  a session whose subagents all failed to price showed `$0.00` beside "no subagent ran"
  (D-6); the coverage banner overstated what excluded sessions are missing from (D-7); the
  SSE backlog reap freed nothing because it called `end()` (D-8). Two comments that cited a
  non-existent equivalence suite were corrected. Version 0.3.0 across the root and all five
  packages. The same day `main` began requiring the `ci` check and Pages went live.
- **`39e565a` (2026-09-09) — the defect and honesty waves 2026-08-25 → 09-08, and the
  closing plan.** `GET /api/changes`; migration 17 `agents.outcome_cause` with the six-cause
  classifier; the cost summary served from the `token_usage_rollup` materialization with
  equivalence, seed and trigger-order suites and migration checksum pins; the single-port
  static site; the hooks installer's ours/ambiguous/foreign classifier; the web error
  boundary, DTO guards, provenance stamps and stream-gap banner. The closing plan
  (`docs/analysis/closing-plan-2026-09-08.md`) and decisions **D1–D8** were accepted by Ivan
  on 2026-09-09; this commit is D1's "commit the whole tree", CI and Pages green on it.
- **Closing-board Waves 0–2 (2026-09-09 → 09-10, dispatched early; committed partly in
  `39e565a` and the rest in `4b3cd2d` — migration 18, L6's `.nvmrc`, L9, L10 and L11 are in
  the latter).** L1 `sessionCount` /
  `hasMore` on the cost summary; L2 two-sided `hubIsWhole`; L3 the reconnect-attempt chip
  (D6); L4 the closed three-arm realtime union (D5, WP-U14); L5 `outcomeCause` in the session
  tree (D4, WP-U13 UI half); L6 NODE-PIN (`.nvmrc` 22, `engines`, the run-time guard); L7 the
  gate docs; L8 BENCH-SHAPE measured at the real shape (81.68–92.29 s, **unratified**);
  L9 retention wired on the signed D3 values (WP-D10 closed); L10 the LABEL-ME rendering
  kit; L11 the time-to-understand kit — whose real-corpus boot found 52 of 60 sessions
  unpriced, fixed by migration 18. **KC-2 met**, ticked 2026-09-18.
- **Docs-truth sweeps #3–#6 (2026-09-19 → 09-23)** re-verified the public corpus against the
  code (hundreds of substitutions, each checked before applying), fixed the Pages-only link
  and Liquid defects, and settled the owner items the sweeps could settle.
- **`4b3cd2d` (2026-09-26) — the hardening wave.** Transient read failures heal with backoff
  re-reads; session and agent anchors are monotonic; timestamps are canonical at the ingest
  boundary; status writes are scoped to the owning session and a cross-session
  `SubagentStop` is refused; retention gained exact budgets, all-or-nothing journal
  receipts and a staged restore that checks before touching the target; the hooks
  installer writes atomically and its curl ignores `curlrc`/proxy; the spawner, licence and
  Node-version gates were tightened; it also carries migrations 18 and 19 — 19 prices
  `claude-opus-5-5` after a real-corpus boot refused 27 of 61 sessions. CI `success` on that
  SHA.
- **Still Ivan's from this span:** the BENCH-SHAPE tick, the KC-3 tick (2026-10-12), D9
  (recommended "no for v1.0"), and everything in Wave 3.

### 2026-09-26 · D10 closed as migration 20, and the last two realtime arms pinned

- **Sonnet 5 priced at the official rate (D10).** The seed carried `claude-sonnet-5` at 3 / 15.
  The platform pricing page, re-read 2026-09-26, says the $2 / $10 launch price "is now the
  standard price" and the scheduled increase to $3 / $15 "will not occur" — so 3 / 15 was never
  in force and every Sonnet 5 dollar shown was 1.5× too high, on every bucket. Migration 20
  (`model-pricing-sonnet-5-official`) rewrites the five seeded floor rows in place (2 / 10,
  cache read 0.2, writes 2.5 / 4) instead of adding a later-dated row, which would have kept the
  cancelled price in force for every earlier message. No row is added (still 40); an operator's
  Sonnet 5 row at any other instant is untouched; stored usage re-prices on the next read,
  because the rollup does not store the rate. The other seed models were re-checked against the
  same page and are unchanged. Still PROVISIONAL — the WP-C1 ratification tick is Ivan's.
- **Proved, not asserted.** Checksum `1ab85d62…` identical under tsx, vitest and
  `node --experimental-strip-types`. Four new migration tests (fresh database, in-place rewrite
  with every other row byte-identical, operator row at another instant, read-time re-pricing
  with the rollup unchanged); mutation input 2 → 3 killed by five tests. Every dollar
  expectation that read the seeded Sonnet rate was re-derived by hand; migration 19's tests
  are now bounded to `<= 19`.
- **The two hand-narrowed realtime arms are pinned** (the L4 follow-up). An exhaustive
  `satisfies Record<keyof AgentStatusChangedEvent, true>` field list makes a shared-schema
  field change a compile error in `apps/web`; a drop-one-field sweep proves
  `isAgentStatusChangedEvent` reads every field; a `SessionIngestedEvent`-typed frame pins
  `ingestedSessionId`. Three mutations (field added, `sessionId` renamed, the `agentId` check
  removed) — all red.
- **A pre-existing test race, found by the final gate run and fixed.** The web test for a 401
  on the stored token asserted the SSE stream closed the moment the entry screen appeared;
  React 19 runs the closing effect cleanup after that commit when the 401 lands outside `act`,
  so it failed about once in seventeen coverage runs. Proved by deferring the close one
  macrotask (old assertion 3 of 3 red, new one 3 of 3 green) and by removing it (new one red).
  The test now waits for the eventual close and asserts a stream existed. No product code
  changed.
- **The web coverage guard caught up with the other four packages.** `RELEASE.md` §1 had
  told the release reader to diff `apps/web/vitest.config.ts` by hand, because nothing
  stopped a lowered web threshold or a widened web `exclude`. The web honesty block now pins
  the exact thresholds object and the exact exclude list; four mutations each fail it.
- **The no-SSRF half of `WP-F5`, built.** The Phase-1 row was ticked with only the spawner
  half in place; no-SSRF, a CD-7 CI-blocking condition, rested on a release-time grep. The
  gate now refuses outbound network primitives and HTTP clients in server-process source
  and manifests (93 files clean today). Nineteen new gate tests; six mutations of the gate
  each killed. Eight documents that said "upheld by review, not by CI" carry a dated
  correction.
- **Documentation drift found on the way:** the migration ledger stopped at 18 and three pages
  said "eighteen migrations" although 19 already existed. Ledger rows 19 and 20 added, counts
  set to twenty.
- **Gates under Node 22:** all eight green — typecheck, lint, format, web build, 3,060 tests
  (web 860 · shared 94 · test-fixtures 139 · core 338 · server 1629) at 100% coverage,
  `gate:spawner`, `gate:licenses`. Pushed to `claude/fervent-maxwell-2hmdro`.

### Still open, and owned by Ivan — not by any agent
- ~~**Everything above is UNCOMMITTED.**~~ **Closed 2026-07-30** — committed and pushed
  as `9b6c6b3` on Ivan's explicit instruction (198 files, +27 133 / −1 113). CI is
  `success` on that commit, so the README badge now attests to Waves 1–4 rather than
  to the Phase-1 foundation alone. The 2026-07-31 → 2026-08-09 hardening span was
  committed and pushed 2026-08-09, again on an explicit ask («пушвай»). Further
  commits still require their own explicit ask.
- The two physical KC acts: open the friction log, install ≥1 rival dashboard.
- **LABEL-ME ratification** — until the hand-labeled corpus exists, the Phase-0 numbers
  stay PROVISIONAL and the hierarchy ≥95% gate cannot be signed by machine.
- ~~LICENSE tracking~~ **closed 2026-07-30** — tracked in `9b6c6b3`; GitHub now reports
  `MIT` instead of `license: null`. ~~Enabling GitHub Pages~~ **closed 2026-08-25** — and
  not the way the 2026-08-07 entry here claimed: `enablement: true` on
  `actions/configure-pages` could never switch Pages on, because `pages: write` authorises
  deploying to an existing site and not creating one. Three runs died proving it. Pages was
  created by an owner-credentialled `POST …/pages -f build_type=workflow`, run
  `32863218759` was re-run and went green, and the site serves at
  <https://ivanbbaev.github.io/agenthropic/>. ~~Branch protection on `main`~~ **closed
  2026-08-25** — `main` requires the `ci` check and refuses force-pushes and deletion, so
  CD-7's "coverage blocks merges" is physically enforced against a contributor.
  `enforce_admins` is deliberately off: one maintainer whose normal mode is a direct push
  would otherwise be locked out, so for Ivan the gate stays a red run rather than a barrier.
- **Retention policy VALUES (OPEN-1/2/3).** The WP-D10 mechanism is built and tested;
  the actual retention windows are a product decision informed by the cold-replay cost —
  **measured** 34.87–39.92 s at census scale (141 sessions, 996.4 MiB, 2026-09-01). The
  ~137 s projection that used to be quoted here is retired, not weighed alongside it: it
  overstated the same scale by 3.43-3.92x (see above) — and only Ivan sets them. Note what
  the measured band still does **not** establish: it was measured over a *synthetic* corpus
  whose per-session size is 3.7x below the real one, so it transfers as a lower bound rather
  than a figure (**BENCH-SHAPE**). Until then the server runs `NO_RETENTION`.
- **"<30s to understand a session" is unmeasured.** The protocol and log template now
  exist (`docs/measurement/time-to-understand-protocol.md`), but only Ivan can sit in
  front of a real corpus with a stopwatch; an agent cannot sign a usability claim.

---

## Milestone 0 — Analysis & planning (pre-code)

_Everything in this milestone is design, audit, and planning documentation — the
evidence base the build stands on. No application code existed while it ran;
implementation began 2026-07-11 and is recorded in Milestone 1 above._

### 2026-07-03 · Repo bootstrap & design basis
- `git init`, branch `main`, personal identity verified (`ivanbbaev@gmail.com`).
- `.git/info/exclude` — AI-harness files + source `*.docx` excluded (local-only).
- Read both source due-diligence `.docx`; extracted architecture, data model, hook
  set, security model, roadmap.
- **Decision: greenfield clean build** (not a fork of hoangsonww).
- `docs/ai/DESIGN.md` — digested design of record (moat, patterns-to-steal, security
  model). `CLAUDE.md` (stack marked TBD) + `README.md` stub written.

### 2026-07-03 · Independent due-diligence dossier
- Built `docs/due-diligence/` — index, methodology, report meta-audit, market
  landscape, security, recommendation + **6 per-project deep dives** (simple10,
  hoangsonww, cast, disler, nirdiamant, claude-code-templates), each with `file:line`
  evidence.
- Documented the vendor panel's self-contradiction (its own model ranks simple10 #1;
  recommendation flips to hoangsonww on a false "simple10 has no DAG" tie-break).
- Independent grades recorded: simple10 A−, hoangsonww B−, cast C, disler C−,
  nirdiamant C+, claude-code-templates C (missed by the vendor).

### 2026-07-03 · Conceptual-brief analysis & implementation plan (v1)
- `docs/analysis/concept-analysis.md` — four senior lenses (Architect · Developer ·
  QA · BA) + brutal gap analysis + holistic read + strengths/weaknesses + deep
  dimension analysis + risk register. **Three headline findings:** (1) ingest
  source-of-truth / reconciliation unspecified; (2) licensing — cast/disler/nirdiamant
  are all-rights-reserved (reimplement, don't copy); (3) scope outruns a solo owner.
- `docs/analysis/implementation-plan.md` — Part A resolves 7 open questions into
  decisions D1–D7; Part B is the phased, coverage-gated, security-first plan.
- Delivery bar saved to memory (`quality-and-release-conventions`).

### 2026-07-03 · Adversarial review of the external `due-diligence/` docs
- Ran a 5-lens adversarial workflow (Opus, high effort) cross-checking the two
  externally-produced parallel reports (BASE + EXPANDED) against ground truth.
- `docs/analysis/external-docs-review.md` — verdict: both factually sound and better
  than the vendor report; both pass the two tripwires (simple10-has-a-DAG,
  hoangsonww-RCE-is-a-spawner). **BASE is more precise, EXPANDED more formalized**;
  EXPANDED carries real defects (duplicated §10 holistic tables, security deferred to
  Phase 6, Phase-0-is-paperwork, SSRF omitted, generation artifacts). Their
  convergence validates the internal analysis.

### 2026-07-04 · v2 consolidation + agent-distributable development plan
- `docs/analysis/concept-analysis-v2.md` — authoritative re-run of the six lenses
  (Architect · Developer · QA · BA · gap · holistic) folding in v1 + BASE + EXPANDED +
  the adversarial review. Resolves the **two load-bearing decisions** (LB1 ingest
  primacy; LB2 personal-first/commercial-clean) and the **ten canonical decisions
  CD-1…CD-10** with quantified acceptance criteria and a what-changed-vs-v1 table.
- `docs/analysis/development-plan.md` — CD-1…CD-10 decomposed into **75 live
  agent-distributable work packages** across 8 tracks by an 8-owner decomposition
  workflow, then **adversarially verified** by a 9th agent: dependency DAG proven
  acyclic, **17 parallel waves** + a **critical path** computed, CD-coverage confirmed
  (all ten), and **twelve corrections applied** (added the missing `WP-U0` Fastify
  bootstrap; rewired ~20 placeholder cross-track deps; merged 5 duplicate pairs; fixed
  the `WP-F1 → WP-S7` hard-stop). 7-phase roadmap with exit gates; Phase-0 GO/NO-GO
  gates all production code.
- `TODO.md` — open items keyed to the development-plan WPs (Phase-0 spike is the only
  currently-actionable wave; everything else blocked on the GO verdict).

### 2026-07-04 · Best-path decision memo + empirical Phase-0 probe (CD-1 answered)
- `docs/analysis/best-path-decision.md` — durable strategic memo capturing the deep
  best-path analysis (adversarial workflow: 6 theses × 3 critics + judge, 25 agents,
  the two load-bearing empirical claims hand-verified). Verdict: **moat-first greenfield
  spine + attributed simple10 tree**; alerts + non-moat off the critical path; a 6-risk
  register, keep/change tables, and an honest kill-the-program dissent. Confidence 76.
- `docs/analysis/phase0-probe.md` — **the empirical CD-1 verdict.** An 8-agent read-only
  workflow (census → reconstruct → reconcile → independent re-verification → judge) over
  the **real `~/.claude/projects` corpus** (17 projects · 117 sessions · 33 subagent dirs ·
  148 flat + ~849 nested agent files), plus hand-verification of the two load-bearing facts.
  **CD-1 = `CONDITIONAL-GO → build`, confidence 85.** Depth-1 edge is a **0%-orphan hard
  key**; depth-2 recovers 100% (self-referential index); **100%** of tokens attribute to an
  `agentId`; **Σ must be summed from child transcripts** (parent rollup ≈0%). Ships an
  **11-item parser-requirements acceptance gate** for Track S.
- **Three corrections to prior docs, evidenced:** (1) the spawn tool is **`Agent`/`Workflow`,
  not `Task`** (0 `Task` blocks — a `Task`-keyed parser builds an empty DAG); (2) layout is
  **spawn-mechanism-driven, not version-driven**; (3) the **durable outbox is now
  `YAGNI`-leaning**, not load-bearing (JSONL self-reconciles by backfill; ~0 historical
  crashes) — while **dual-layout parsing** (85% nested) and **child-transcript token
  summation** (0% parent rollup) are proven **load-bearing**. Memo annotated with an
  empirical-update callout; `docs/analysis/README.md` index extended.

### 2026-07-04 · Public docs corpus authored (`docs/site/`) — 44 pages, 13 ADRs
- _(Recovered milestone — happened on 2026-07-04 but was never logged here; recorded
  2026-07-06 per audit finding PROC-3.)_
- `docs/DOCS-PLAN.md` + `docs/site/` — the full public documentation corpus authored by
  a **22-writer / 22-reviewer fan-out workflow**: index, getting-started, architecture
  set (ingest, data model, DAG, cost, realtime, security), guides, reference, and
  **13 accepted ADRs**; a parallel session added the Track-U usage pages the same day.
- Final state: **44 pages · 603 internal links · 0 broken** (link-checked).

### 2026-07-06 · Propagated the four empirical CD-1 corrections across the doc corpus
- A **50-agent propagation workflow** (apply → adversarial-verify pipeline over 24 candidate
  docs + a completeness sweep + a cross-doc consistency judge) carried the four
  probe-verified findings out of `phase0-probe.md` into the **entire living corpus** — design
  record, analysis, plan, and the full `docs/site/` tree (architecture pages, guide, ADRs,
  usage): **C1** spawn tool is `Agent`/`Workflow` not `Task`; **C2** layout is
  spawn-mechanism-driven, branch on **directory shape** not version; **C3** the durable outbox
  is **YAGNI-leaning**, not load-bearing (JSONL self-reconciles; dual-layout parsing +
  child-transcript token summation are the real hedges); **V** CD-1 is **pre-answered
  `CONDITIONAL-GO` (confidence 85)** — while the `WP-S7` GO gate **still stands** everywhere.
- **Concurrency race investigated and cleared:** a parallel session authored the Track-U usage
  pages at the same time; confirmed legitimate (snapshot + its own WORKLOG entry) — **nothing
  reverted**; the one overlap (`hooks-installer.md`) resolved clean.
- **Manual residual cleanup** the automated pass missed, then a **final adversarial sweep →
  ZERO C1/C2/C3/V residuals** corpus-wide; every remaining "Task" is a correction-statement or
  an unrelated noun. Gate ("no production code before `WP-S7`") intact in all five key docs.

### 2026-07-06 · Full-corpus audit + red-team counter-analysis (durable, self-contained)
- `docs/analysis/corpus-audit-2026-07-06.md` — the six-part analysis (documentation ·
  gap · holistic · business · five senior lenses incl. the **first-ever UX/UI pass**)
  persisted as a **self-contained document for a context-free future session**: stable
  finding register (**AMEND-1…7 · OPEN-1…9 · LOST-1…8 · EMP-1…3 · PROC-1…7**), the
  33-decision consistency ledger, the docs-site C1–C19 list, the precedence chain, and
  **10 ranked actions**. Headline: **best-path §6 is still unapplied** to
  development-plan/TODO (AMEND-1…6); AMEND-7 verified **resolved** by the same-day
  propagation workflow.
- `docs/analysis/red-team-audit-2026-07-06.md` — deliberately **adversarial
  counter-analysis**: the kill-condition was defused not passed (friction log never run);
  the corpus contains false statements about itself; moat-on-rented-land (undocumented
  internals; the ignored OTel signal); n=1 evidence quoted as format guarantees;
  governance fiction (13 accepted ADRs under an unsigned Gate A; **0 git commits**
  protecting 132k words); economics without anesthesia. §9 records what survives
  (security posture, probe method, event-sourcing spine, depth-1 hard key); §10 forces
  **three exits** (kill · two-week brutal timebox · status quo) recommending the
  timebox; §11 declares a **stop condition on further analysis**.
- `docs/analysis/README.md` — both documents indexed; stale probe numbers fixed
  (“18 nested” → **~849 nested, 85.2%**).
- `docs/analysis/PROJECT-STATE-2026-07-06.md` — **single entry point for a
  context-free future session** (navigation-only, supersedes nothing): complete
  timeline 07-03→07-06, document map with authority order, current-truth snapshot,
  the pending decision funnel (Gate A · red-team exits · friction log · commit
  authorization), and “if Ivan says X, do Y” playbooks. Linked from
  `docs/analysis/README.md` (top) and `CLAUDE.md` (Current state).

### 2026-07-06 · Corpus cleanup & reorganization — amendments applied, TODO.md rebuilt as a parallel-agent assignment board
- **AMEND-1…6 applied** (the audit's biggest debt): best-path §6 carried into
  `development-plan.md` + `concept-analysis-v2.md` as dated strikethrough edits citing
  §6 (new §2b "Best-path §6 amendments applied"): alerts off the v1.0 critical path
  (§6.1), `WP-A8`/`WP-A9` cut / `WP-A10` kept (§6.2), `WP-X11` deleted (§6.3), single
  `better-sqlite3` driver in `WP-D2` + CD-9 dual-driver copy item struck (§6.4),
  `WP-S1` slimmed / `WP-S4` demoted to liveness-only (§6.5), `packages/core` in
  `WP-F1` (§6.6). v1.0 = persistent DAG + cost attribution — no alerts.
- **TODO.md rewritten as the assignment board** for a fresh orchestrator session:
  lane = agent = disjoint path ownership, orchestrator-only tracker files, 4 waves for
  the Phase-0 spike (S1+X10 → S2/S3/S4 → S5/S6 → S7), optional DOC lanes (A–D) that
  need no Gate A, and the standing constraints footer.
- **Superseded docs bannered, none moved** (603 links preserved): v1
  concept-analysis/implementation-plan rows + footer in `docs/analysis/README.md`;
  `due-diligence/recommendation.md` + its README (PROC-7); root `README.md` and
  project `CLAUDE.md` refreshed to current truth (PROC-1/PROC-2); the missing
  2026-07-04 docs-corpus milestone backfilled above (PROC-3); PROC-6 old-vs-new phase
  numbering noted in DESIGN §9 / animated-room-analysis.
- **docs/site consistency pass** (the substantive C1–C19 findings): fleet/moat
  reframing + alerts-as-post-1.0 (C1, the-moat/roadmap/faq), ingest diagram + threat
  model (C3), 12-hooks-assumed-9-documented hedge (C4), comparison table reconciled
  (C10), four-things list (C15), coverage bar normalized to **>90%** corpus-wide
  (C8, closing OPEN-8 per the standing delivery bar), `WP-X11`/dual-driver blessings
  struck in security/model, ADR-CD-9/CD-10, testing, licensing, overview, faq,
  the-moat, data-model, DOCS-PLAN; LOST-8 ("fork simple10" = contestable judgment
  call) softened in the two audit docs.
- `PROJECT-STATE-2026-07-06.md` updated to reflect all of the above + a new
  "dispatch parallel agents" playbook. _Process note: one of three parallel cleanup
  agents died mid-task on a session limit; its remaining edits were verified against
  its transcript and completed inline — nothing double-applied._

### 2026-07-06 · v1/v2 roadmap — the last analysis (#9 of 9), kill checkpoints with default-death
- `docs/analysis/roadmap-v1-v2-2026-07-06.md` authored **on explicit owner instruction
  overriding red-team §11** (the override is acknowledged in the document itself; the
  price is that it is final — the **analysis freeze** in its §8 permits only verdict
  records afterwards).
- Re-measured numbers: **76 md files · 141,270 words · 0 commits · 0 LOC** — the corpus
  grew ~8.5k words *after* the audit that ordered it to stop; three new indictments
  recorded (virtuous growth as failure mode, agreement ≠ progress, a coordination
  protocol for a never-hired workforce).
- **Kill checkpoints KC-0…KC-5, death as the default:** Gate A sign-or-archive by
  **2026-07-13** (KC-0, includes opening the friction log + installing a rival); Phase-0
  spike verdict + restored *executable* kill condition by **07-27** (KC-1); Phases 1–2
  by **09-14** (KC-2, single velocity rebase allowed); the three P0 moat proofs by
  **10-12** (KC-3); **v1.0 hard date 2026-12-01** (KC-4, immovable); v2 entry earned by
  14 days of real daily use + friction-log evidence (KC-5).
- **v1.0 roadmap detailed** over the 63-WP committed path: red-team **Exit B absorbed
  into Phase 0 *inside* CD-8** (throwaway DAG-with-dollars render = fused S5+S6
  deliverable, no CD bend needed); three velocity scenarios (hobby pace ships the day
  KC-4 kills it — descope or die); descope ladder + forbidden descopes; explicit
  NOT-in-v1.0 list; one plan defect found and fixed in the schedule (`WP-X9` release
  checklist sat in post-1.0 Phase 6 while v1.0 releases at wave 16 — pulled forward).
- **v2.0 = alerts core A1–A7 + A10** in 5 waves (~3–4 weeks at scenario B), entered
  only via KC-5; A8/A9 stay cut; v2 candidates admitted only with a friction-log entry
  as ticket. Beyond-v2 table: fleet only on a second host; vector-DB/public
  bind/spawner = **never**.
- Indexed in `docs/analysis/README.md` (reading order + table row) and
  `PROJECT-STATE-2026-07-06.md` (timeline, document map, pending-decision funnel —
  red-team §10's open exit choice marked superseded pending signature; the
  "more analysis" playbook now answers with the KC table).
- **Operational wiring for a context-free orchestrator (any model):** `TODO.md` Step 0
  rewritten as the KC-0 signature block (Gate A + KC schedule + friction log + rival
  install, deadline 2026-07-13) with the **KC calendar table** and the
  agent-rules-at-a-failed-checkpoint (report + stop + decline — no agent ever
  archives/deletes); phase headers dated (KC-2/KC-3/KC-4); the Wave-3 joint THROWAWAY
  DAG-with-dollars deliverable (Exit B absorbed) made a KC-1 stay-alive condition;
  WP-S7 deadline = KC-1 + must record the first measured velocity number; WP-X9 moved
  to the Phase-4 tail; the Post-1.0 alerts block gated on KC-5. `PROJECT-STATE`
  (date-check-first rule, re-measured §1 numbers, "scheduled with teeth" §4 block,
  four §6 playbooks updated/added) and the project `CLAUDE.md` (schedule-of-record
  bullet) now lead every cold start to the KC calendar.

### 2026-07-10 · Phase-0 feasibility spike executed end-to-end (WP-S1…S7) + DOC-A…D recovery
- Ran the **entire** Phase-0 throwaway spike in one day via parallel background lanes,
  under CD-8 (no production code scaffolded). All output under `spike/` (THROWAWAY,
  git-excluded); `~/.claude/projects` + `spike/corpus` stayed read-only; no agent ran git.
  Gate A partially signed the same day (3/5 Step-0 boxes: CD-1…CD-10 + LB1/LB2, the KC
  schedule, approve-running-Phase-0).
- **Wave 1** — S1 hostile corpus (5 real sessions · 224 agents · ~66 MB, deliberately
  loaded with crashed-no-Stop, depth-2 nesting, mid-session PreCompact, two concurrent
  same-slug instances); X10 WORKLOG-discipline template.
- **Wave 2** — S2 ingest-primacy → **CD-1 = JSONL-PRIMARY confirmed** (edge accuracy
  100% ×5 sessions, 0/463 hook-sourced; discovered `<task-notification>` as a 3rd flat
  join path recovering compaction-evicted parent blocks); S3 token→agent join → **HARD
  KEY 6654/6654, zero heuristic** (discovered `queue-operation` as a 3rd structural
  schema that closes `run_in_background` spawns to 224/224); S4 hooks → **`SubagentStart`
  is not a real Claude Code hook** (never fires), only `UserPromptSubmit` leaves a
  footprint (37), compaction read from `compact_boundary` (30, all `trigger=auto`).
- **Wave 3** — S5 tree smoke gate **PASS 5/5** + EMP-1 resolved (**wave-partial ordering,
  not a total order**; max inverted Δt 0.003 s; `promptId` is a batch key not an ordinal)
  + concurrency (`69ac12d0` 103 agents vs `a362e15d` 57 — **two independent roots**, empty
  intersection); S6 reconciliation (**parent rollup 0.00%**, disjoint `message.id` sets;
  dedup 8540→3339 messages, naive over-count 2.4–2.7×; corpus ≈ **$345.91** over
  206,001,429 tokens) + the **THROWAWAY DAG-with-dollars render** (fused S5+S6, Exit B
  absorbed — a **KC-1 stay-alive condition**; it exists).
- **Wave 4** — S7 verdict → **new** `docs/analysis/phase0-verdict.md`: **CONDITIONAL GO
  ~90%** — the subagent DAG + dollar cost is mechanically reconstructable from
  `~/.claude/projects/*.jsonl` alone, zero inference, on the hostile corpus. Beyond the
  11-item gate the spike surfaced **three new production-parser MUSTs** (`<task-notification>`
  flat join · `queue-operation` 3rd join schema · `message.id` dedup + bucket/model
  pricing). First measured velocity number recorded for the roadmap §3 rebase.
- **DOC-A…D** (needed no Gate A): `recovered-source-material.md` (LOST-1…4),
  `ux0-design.md` (LOST-6), `open-decisions.md` (OPEN-1…9), the Satisfies column on the
  `concept-analysis-v2.md` CD table, and `testing.md` §5.1 negative catalogue (LOST-7).
- **All results are self-check / PROVISIONAL** — scored against machine inventories, not
  Ivan's hand-labeled trees. Filling the five `spike/corpus/sessions/*/LABEL-ME.md`
  (224 per-edge blanks) is the human act that ratifies the GO (KC-0/KC-1).

### 2026-07-11 · First commit & push to public origin; parser spec
- `docs/analysis/parser-spec.md` — **new**, the normative parser contract distilled from
  S1…S7: the **14-item requirements gate** (original 11 + the three new MUSTs), the four
  structural join paths, token→cost rules (dedup + bucket/model pricing), the
  self-referential depth-2 tree index, the amended EMP-1 wave-partial ordering, and the
  exact `docs/site` edits to apply **at scaffold time**. Design document only — scaffolds
  nothing; CD-8 still gates code.
- **First commit `9dfcc9c`** (79 files: `DONE/README/TODO` + all of `docs/`; clean
  English message, no AI attribution) **pushed** to `github.com/IvanBBaev/agenthropic`
  (**PUBLIC**, by Ivan's informed choice after the visibility discrepancy was surfaced).
  Pre-push hygiene: excluded `.DS_Store` and the top-level source `due-diligence/`
  (`.docx` was already excluded; an 825 KB source `.pdf` was leaking). Harness files,
  the throwaway `spike/`, and source docs correctly kept out.
- `docs/analysis/README.md` — indexed `phase0-verdict.md` + `parser-spec.md` (were
  dangling). `~/Development/CLAUDE.md` workspace map — added the missing `agenthropic`
  row (public, pre-code). CD-8 unchanged; still waiting on Ivan for KC-0 (2026-07-13).

---
_Each entry is also recorded in `WORKLOG.md` (the local-only session journal) with affected files._
