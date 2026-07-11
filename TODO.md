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
PROC-4) · authorize committing the docs (repo still has 0 commits). _(The former "pick
a red-team exit" item is **retired**: the KC table replaced the exit choice — Exit B is
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

## The assignment — Phase 0 · feasibility spike _(throwaway; hard GO/NO-GO stop)_

Unlocked by Step 0. Waves run in order; lanes inside a wave run in parallel.

### Wave 1 — two parallel lanes
- [ ] **Lane S1 · WP-S1** _(ingest)_ — Paired-capture harness + hand-labeled corpus (≥3 real
  sessions incl. crashed-no-Stop, deep nesting **on purpose — depth-2 evidence is thin,
  EMP-2**, mid-session PreCompact, two concurrent instances). **Slimmed per best-path §6.6:**
  the install-and-revert throwaway-hook block is OFF the gating path. _Dep: none._
  **Owns: `spike/corpus/**`.** · **Ivan-in-the-loop:** label the expected tree per session.
- [ ] **Lane X10 · WP-X10** _(docs)_ — WORKLOG discipline template + presence check.
  _Dep: none._ **Owns: only the template file it creates (path per dev-plan WP-X10).**

### Wave 2 — three parallel lanes _(dep: WP-S1)_
- [~] **Lane S2 · WP-S2** _(ingest)_ — G0.1 ingest-primacy probe → **emits the CD-1 verdict
  rule**. **Pre-answered by the 2026-07-04 probe: JSONL-primary, `CONDITIONAL-GO`** (JSONL
  self-reconciles by backfill; outbox deferrable). Confirm on the paired-capture corpus.
  **Owns: `spike/ingest-probe/**`.** · **The make-or-break probe (LB1).**
- [~] **Lane S3 · WP-S3** _(data)_ — G0.1b token→`agent_id` join-key probe. **Pre-answered:
  hard key** (`meta.toolUseId == Agent tool_use.id`; `filename hex == toolUseResult.agentId`;
  100% attributable). Confirm on the labeled corpus. **Owns: `spike/join-probe/**`.**
- [ ] **Lane S4 · WP-S4** _(ingest)_ — hook-catalog enumeration, **demoted to liveness-only
  per best-path §6.6** (does `SubagentStart` fire? PreCompact markers — informative, not
  gating). **Owns: `spike/hooks-liveness/**`.**

### Wave 3 — two parallel lanes
- [ ] **Lane S5 · WP-S5** _(qa)_ — G0.3 tree smoke gate against the 11-item parser gate,
  **including the intra-workflow edge-ordering proof via `journal.jsonl`+`promptId` (EMP-1)**;
  **Ivan signs off** the rendered nesting. _Dep: WP-S1, WP-S2._ **Owns: `spike/tree-smoke/**`.**
- [ ] **Lane S6 · WP-S6** _(cost)_ — G0.4 token-reconciliation probe (Σ per-record ==
  JSONL total, exact; capture PreCompact baseline). _Dep: WP-S1, WP-S3._
  **Owns: `spike/token-recon/**`.**

> **Joint Wave-3 deliverable (roadmap §5 — Exit B, absorbed):** one THROWAWAY script/page
> rendering the reconstructed subagent DAG **with real dollars on the nodes** — Lane S5
> owns the render, Lane S6 feeds it the per-agent dollar figures. This is the exact
> artifact red-team Exit B demanded, produced *inside* CD-8 (no production code, no
> scaffold; it dies after WP-S7). Its existence is a **KC-1 stay-alive condition**.

### Wave 4 — single lane (the gate)
- [ ] **Lane S7 · WP-S7** _(docs)_ — **GO / CONDITIONAL-GO / NO-GO report.** Applies the
  CD-1 rule with evidence from all lanes. **Gates all of Phase 1.** _Dep: S2, S3, S4, S5, S6._
  **Owns: `docs/analysis/phase0-verdict.md` (new file).** **Deadline: 2026-07-27 (KC-1)** —
  day 14 of the timebox; no verdict by then = the KC-1 failure branch. The verdict must
  also record the **first measured velocity number** (WPs/week) for the roadmap §3 rebase.

---

## Optional documentation lanes — available NOW, no Gate A needed, mutually disjoint

Agent-executable on request; each cites its finding IDs from
[`corpus-audit-2026-07-06.md`](docs/analysis/corpus-audit-2026-07-06.md):

- [ ] **Lane DOC-A — recover the lost vendor material** (LOST-1/2/3/4): 24-capability
  feature matrix as a UI checklist, OTel `query_source` note, hook-schema-drift risk,
  cost sizing. **Owns: `docs/analysis/recovered-source-material.md` (new file) + one
  pointer line in `docs/analysis/README.md` table.**
- [ ] **Lane DOC-B — recover the lost requirements & tests** (LOST-5/7): FR/NFR IDs
  (incl. PRIV-01, PERF-01) as a column on the CD table; the 10-scenario negative-test
  catalogue. **Owns: `docs/analysis/concept-analysis-v2.md` (CD table only) +
  `docs/site/contributing/testing.md`.**
- [ ] **Lane DOC-C — WP-UX0 design pre-work** (LOST-6 + audit §9.5): IA map, five
  question-to-screen flows, ASCII wireframes for the four views, the
  uncertainty/honesty visual language (inferred edges, estimated costs, `'unknown'`
  status always visible). **Owns: `docs/analysis/ux0-design.md` (new file).**
- [ ] **Lane DOC-D — OPEN-1…9 decision one-pager for Ivan**: each open question with
  the recommended resolution from the audit, as checkboxes for sign-off. **Owns:
  `docs/analysis/open-decisions.md` (new file).** _(Deciding them stays with Ivan.)_

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
  `orchestration_edges` **(moat core — must satisfy the 11-item parser gate: `Agent`/`Workflow`
  not `Task`, both layouts, self-referential parent index)** · **IN9** reconciliation+backfill
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
