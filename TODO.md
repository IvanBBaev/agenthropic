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
| **KC-0** | **2026-07-13** | All Step-0 boxes above checked | Archive |
| **KC-1** | **2026-07-27** | WP-S7 verdict written **+** the THROWAWAY DAG-with-dollars render exists **+** the friction log has not crowned a rival (≥4/5 questions) | Archive |
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

## Blocked — released by the WP-S7 GO verdict

Authored and dependency-ordered in the development plan (§4 waves, §5 catalog), as
amended by best-path §6. Unlocks wave-by-wave after GO.

### Phase 1 · Foundation, security spine, storage, ports _(security + coverage go LIVE; KC-2 window — Phases 1–2 complete by **2026-09-14**)_
- [ ] **Foundation/CI (F):** WP-F1 scaffold — pnpm monorepo `apps/server` · `apps/web` ·
  `packages/shared` · `packages/core` (server/web-import-free moat IP, best-path §6.7) ·
  `packages/test-fixtures` · `hooks/`, Node 22 _(← WP-S7)_ · F2 lint · F3 coverage-harness ·
  F4 CI · F5 no-spawner/no-SSRF gate · F6 license scan · F7 security contract tests
  (**RED until WP-U0**) · F8 backup/tested-restore.
- [ ] **Data (D):** WP-D1 ports+shared types · D2 SQLite/WAL — **better-sqlite3 only,
  single driver (best-path §6.3)** · D3 migration runner · D4 `events_raw` append-only
  substrate · D5 `events` · D6 sessions+agents · D7 `orchestration_edges` · D8
  `token_usage` · D10 retention+redaction **(OPEN-1/2/3 must be resolved first — see
  Lane DOC-D)**. _(D9 merged into C1.)_
- [ ] **WP-U0** _(backend)_ — **Fastify server bootstrap**: loopback-or-fail +
  timing-safe token + same-origin + TypeBox + config; **turns WP-F7 green.**
  _Dep: WP-F1, WP-F7, WP-D2._
- [ ] **Delivery/QA (X):** WP-X1 golden fixture corpus · X2 labeled annotations+loader ·
  X5 blocking >90% coverage gate · X6 README green badges+donation · X7 GitHub Pages
  build. **WP-A1** alert port. _(WP-X11 vector-DB stub **deleted** per best-path §6.3.)_
- **Exit gate:** coverage (>90%) green & blocking · security/license gates red on
  violation · WP-F7 green via WP-U0 · `events_raw` append-only proven · WAL + tested
  restore · badges green · Pages builds.

### Phase 2 · Ingest substrate
- [ ] **WP-IN1** envelope+idempotency-key · **IN2** EventStore append-only · **IN3**
  HookSource authed loopback receiver (accept-any-event) · **IN5** JSONL tail-follow +
  durable offsets · **IN11** contingent outbox _(**deferrable per the probe** — JSONL
  self-reconciles; add only on a sub-second-liveness or hooks-only-data trigger)_ · **IN14**
  redaction at ingest boundary. **WP-C1** pricing table+seed · **C2** PricingProvider.
  Hooks installer **WP-X8** _(absorbs IN4)_.
- **Exit gate:** hook + JSONL for one fact → one `events_raw` row · kill/restart resumes at
  offset, zero loss/dup · unknown event_type stored not crashed · redaction live.

### Phase 3 · Projection, the DAG moat, reconciliation, cost _(P0 blockers — exit = **KC-3, by 2026-10-12**)_
- [ ] **WP-IN6** pure Normalizer · **IN7** projection · **IN8** dual-path
  `orchestration_edges` **(moat core — must satisfy the 14-item parser gate of
  [`parser-spec.md`](docs/analysis/parser-spec.md): `Agent`/`Workflow` not `Task`, both
  layouts, all four join paths, self-referential parent index)** · **IN9** reconciliation+backfill
  **(load-bearing — child-transcript token summation is the ledger)** · **IN10**
  replay-on-startup · **IN12** missing-Stop→unknown watchdog · **IN13** P0 suite.
  **Cost:** WP-C3 CostEngine · C4 compaction repricing · C5 delegation-savings · C6
  priceless-fails-CI · C7 cost API. **QA:** WP-X3 three release-blocker tests · X4
  12-scenario negative catalogue.
- **Exit gate:** **three P0 tests green & merge-blocking** (Σtokens==JSONL exact ·
  double-replay byte-identical DB · DAG rebuilt from JSONL alone) · hierarchy ≥95% without
  `SubagentStart` · PreCompact reprices vs baseline · no priceless model.

### Phase 4 · Read API + SPA + the five daily questions — **v1.0 ships at this exit gate** _(KC-4 hard date: **2026-12-01** — it does not move)_
- [ ] **WP-U1** SSE RealtimeHub · **U2** read API foundation · **U3** session/tree endpoints ·
  **U4** cost/global-DAG endpoints · **U5** SPA shell+auth+SSE client _(consider Lane DOC-C /
  WP-UX0 output before starting U5)_ · **U6** live status view (<30s) · **U7** session tree
  view · **U8** global persistent DAG view · **U9** cost/Sankey view · **X9** release
  checklist (**pulled into the v1.0 tail per roadmap §5** — the plan filed it post-1.0 by
  defect; v1.0 does not ship without its own `RELEASE.md`).
- **Exit gate (= the v1.0 definition, best-path §6.1):** all 5 daily questions answerable ·
  <30s to understand a session · tree & global DAG served by a query over persisted edges ·
  every dollar traces to tokens×price.

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
