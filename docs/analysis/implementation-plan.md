# agenthropic — Consolidated Analysis & Implementation Plan

> **⚠️ SUPERSEDED** (2026-07-04; banner added 2026-07-06). Part A's decisions D1–D7
> were re-resolved as **LB1/LB2 + CD-1…CD-10** in
> [`concept-analysis-v2.md`](concept-analysis-v2.md); Part B's phased plan was
> replaced by the 75-WP [`development-plan.md`](development-plan.md) as amended by
> [`best-path-decision.md`](best-path-decision.md) §6. Its phase numbering is the
> OLD scheme (see finding PROC-6). Keep for the audit trail; **do not act on it.**
> Current entry point: [`PROJECT-STATE-2026-07-06.md`](PROJECT-STATE-2026-07-06.md).

> **Companion to** [`concept-analysis.md`](concept-analysis.md). Part A re-runs the
> four-lens review **in decision form** — every open question resolved into a
> recommendation with a rationale. Part B turns those decisions into a sequenced,
> testable, coverage-gated build plan that honours the project's non-negotiable
> security invariants (`docs/ai/DESIGN.md` §8) and Ivan's delivery
> bar (**>90% coverage · README badges + donation · GitHub Pages docs site**).
>
> **Status:** plan only — no code scaffolded. The stack/structure decisions below are
> *recommendations to approve*, consistent with DESIGN §10 leaning.

---

# Part A — Re-run analysis, as decisions

The concept review surfaced seven open questions. Here each is resolved. These
resolutions are the plan's premises; changing one changes the plan.

### D1 — Ingest primacy: **JSONL-primary, hooks-for-liveness**
**Decision.** Treat `~/.claude/projects/*.jsonl` as the **primary, durable source of
truth**; tail-follow it and **replay-on-startup**. Use hooks only for **sub-second
liveness** (instant "agent started/stopped" signals) and for events JSONL doesn't
carry. Every write is an **idempotent upsert keyed on a stable event id**, so hooks
and JSONL converging on the same fact never double-count.
**Why.** It makes history crash-tolerant and backfillable (the dashboard can be down
and lose nothing), it satisfies the "tokens never inferred" invariant naturally
(tokens come from the ground-truth log), and claude-code-templates already proves the
chokidar-watch-over-JSONL pattern works. **Hard dependency:** Phase-0 must confirm
JSONL actually carries the subagent parent→child linkage. If it does not, fall back to
**hooks-primary + a local outbox/spool** for at-least-once delivery — but only then.

### D2 — Identity: **personal-first, commercial-clean**
**Decision.** Build the single-user Mac Mini tool. Adopt only the *cheap* commercial
hedges now — MIT-clean code only, `instance/host` key on rows, a schema that wouldn't
block tenancy later — and **explicitly defer every expensive commercial feature**
(fleet aggregation, multi-tenant isolation).
**Why.** Resolves the identity split (concept §5.2) without paying for a product
nobody is using yet; keeps the door open at near-zero cost.

### D3 — v1 daily-questions (the MVP definition of value)
**Decision.** v1 must let Ivan answer, from real sessions:
1. *What is the subagent tree of this session, and which branch is still running?*
2. *Which agent/subagent burned the most tokens (and roughly what did it cost)?*
3. *Did any session get stuck / error without me noticing?*
4. *What did today/this week cost, and how much did Haiku/Sonnet routing save?*
5. *Show me last night's sessions — persisted, after a restart.*
**Why.** Scope is driven by these five questions, not by feature-parity envy. Q1–Q3
define Phase 1; Q4 is Phase 4's tile; Q5 is the persistence guarantee threaded
throughout. Anything not serving a question waits.

### D4 — Stack: **approve the lean, with two refinements**
- **Backend:** Fastify + **better-sqlite3** (keep `node:sqlite` fallback as portability
  insurance). ✔ endorsed.
- **Frontend:** React + Vite + D3. ✔ endorsed.
- **Transport:** **SSE, not WebSocket** — the feed is server→browser only; SSE
  auto-reconnects, needs no same-origin WS handshake, and is simpler to secure.
  (Revisit WS only if bidirectional control is ever needed — it isn't at v1.)
- **Repo structure:** **pnpm monorepo** — `packages/server`, `packages/web`,
  `packages/shared` (types/schema), `hooks/` (installable hook scripts). Justified by
  shared types across server/web; kiko-aligned.

### D5 — Phase 3 (vector-DB context feed): **move to an experimental track**
**Decision.** Remove "observability becomes memory" from the core delivery line;
label it `future/experimental`. It must not compete with shipping the cockpit.
**Why.** It's a different product with a large undefined dependency (concept §5.3).

### D6 — Pricing source-of-truth: **one dated constant, under test**
**Decision.** A single `model_pricing` seed (dated, with model IDs) is the source of
truth; a test asserts every model seen in fixtures has a price, and the constant
carries a "verified on <date>" stamp. Re-verify rates on each cost-feature change.
**Why.** Turns a silent staleness liability (concept §6.4) into a failing test.

### D7 — Secret home: **environment + tight file perms, never in the app's data path**
**Decision.** Telegram bot token via a `launchd`-injected env var (or a `chmod 600`
dotfile the service reads at boot); never stored in SQLite, never sent to the browser.
`ANTHROPIC_API_KEY` stays out of the dashboard env entirely (only the
experimental/Phase-3 track would need it, and it's deferred).

### Cross-cutting policy resolved here
- **Licensing (concept §6.2):** copy code **only** from `simple10` and `hoangsonww`
  (MIT + LICENSE), with attribution. From **cast / disler / nirdiamant** —
  **reimplement ideas clean-room; never copy source** (all-rights-reserved / murky).
  This is a hard rule, not a preference.
- **Security invariants become tests** (concept §4.4), gating CI from Phase 1.

---

# Part B — Implementation plan

## B.0 Guiding principles
1. **Resolve the make-or-break unknown first.** Phase 0 exists to answer R1 (can JSONL
   rebuild the tree?) before any architecture is poured.
2. **Every phase is independently shippable and independently useful** to Ivan.
3. **The security invariants and the >90% coverage gate are load-bearing from Phase 1
   — not a hardening pass at the end.**
4. **Test infrastructure (fixtures + reconciliation + security tests) is a
   first-class, phase-spanning workstream**, not overhead.
5. **Copy only MIT-clean code; reimplement everything else clean-room.**

## B.1 Cross-cutting workstreams (run through every phase)
- **WS-Test** — golden real-session fixtures corpus (happy + pathological: deep
  nesting, missing Stop, mid-session compaction, two concurrent instances);
  reconciliation/idempotency/compaction/security test suites; **CI coverage gate at
  >90%**, blocking merges.
- **WS-Sec** — security-invariant tests (loopback-only, token constant-time, SSE
  same-origin, no-spawner grep gate, no-SSRF), wired into CI from Phase 1.
- **WS-Docs** — `README` with **green-only badges** (via the `badges` skill) + a
  **donation** section; a **GitHub Pages docs site** (Vite/MkDocs-style) published by
  CI; keep DESIGN/analysis cross-links honest.
- **WS-Ops** — WAL + tested backup/restore; retention + payload-redaction policy;
  a liveness heartbeat (the observer must not fail silently).

---

## Phase 0 — Validation spike (GO/NO-GO gate) 🔴 do this first
**Objective:** de-risk the concept's two make-or-break unknowns before committing
architecture. Throwaway code is fine.

**Tasks**
- **G0.1 Ingest-primacy probe.** Run one genuinely subagent-heavy session on the Mac
  Mini. Inspect the raw `~/.claude/projects/*.jsonl`: **does it carry the subagent
  parent→child linkage** (spawn-tool invocations, subagent session ids, parent refs)?
  Reconstruct the tree from JSONL alone in a scratch script.
- **G0.2 Hook catalog verification.** Enumerate the **actual** Claude Code hook events
  on the installed version. Confirm/deny `SubagentStart`, `PermissionRequest`,
  `PostToolUseFailure`; note which events carry which fields. (Use the
  `claude-code-guide` agent / current Claude Code docs — do **not** assume the twelve.)
- **G0.3 Tree smoke gate.** Render the reconstructed nesting (even as text/JSON) and
  confirm it matches Ivan's mental model of that session.
- **G0.4 Token-reconciliation probe.** Sum token counts from JSONL for the session;
  confirm they're extractable as ground truth.

**Gate G0 (decision):**
- ✅ **JSONL carries linkage** → proceed **JSONL-primary** (D1 default).
- ⚠️ **Only hooks carry linkage** → proceed **hooks-primary + local outbox/spool**,
  and re-cost the durability work into Phase 1.
- ❌ **Neither reliably yields the tree** → stop; reconsider the moat feature's
  feasibility before building.

**Definition of Done:** a one-page spike report (append to `WORKLOG.md`) recording the
ingest decision, the verified hook catalog, and the tree/tokens confirmation. No
production code.

---

## Phase 1 — Hardened internal cockpit (the MVP)
**Answers daily-questions Q1–Q3, Q5.** This is the first thing Ivan uses daily.

**Scope**
- **Ingest pipeline** per the G0 decision: JSONL tail-follow + replay-on-startup
  (+ hooks for liveness), **idempotent upsert on stable event id**, orphan-reparenting
  + root-synthesis, watchdog for missing Stop → explicit `working → unknown` state.
- **Schema (MVP cut):** `projects`, `sessions`, `agents` (self-ref `parent_agent_id`),
  `events`, plus the **persisted `agent_edges`** table (the moat's core:
  `parent_agent_id, child_agent_id, session_id, instance, derived_from_event_id,
  created_at`, idempotent). `instance/host` key on rows (D2 hedge). Forward-only
  migration runner chosen and in place.
- **Server:** Fastify, **bind `127.0.0.1` only**, mandatory `DASHBOARD_TOKEN`
  (`timingSafeEqual`), SSE stream with same-origin check, WAL + backup.
- **Web:** the **session-scoped subagent tree** (reimplemented force graph + tree
  layout — the flagship UI item), live-updating via SSE; a session list that
  **survives restart** (Q5).
- **Ops:** run under `launchd` (no Docker daemon); tested backup/restore; retention +
  redaction policy for stored payloads.

**Cross-cutting (must land in this phase, not later):**
- **WS-Sec** security-invariant tests in CI (loopback, token, SSE origin, no-spawner
  grep gate).
- **WS-Test** golden fixtures + reconciliation/idempotency tests; **CI coverage gate
  live at >90%** and blocking.
- **WS-Docs** README scaffold with badges + donation; Pages site skeleton.

**Acceptance criteria (Definition of Done)**
- [ ] From a real session, the subagent tree renders correctly and updates live.
- [ ] Kill + restart the dashboard mid-session → **no data loss**; history intact.
- [ ] Ingesting the same log twice → **identical DB state** (idempotency test passes).
- [ ] `Σ token_usage == JSONL ground truth` per session (reconciliation test passes).
- [ ] Server refuses `0.0.0.0`; unauth write → 401/404 (constant-time); SSE rejects
      cross-origin; **no route spawns a subprocess from request input** (all tested).
- [ ] A missing `SubagentStop` yields an `unknown` state within the watchdog window,
      not a permanently "working" agent.
- [ ] **CI: >90% coverage, all green; badges render green/true; Pages builds.**

---

## Phase 2 — Telegram integration
**Answers Q3 remotely** ("did anything get stuck/error while I was away?").

**Scope**
- Graft **hoangsonww's** `formatTelegram` provider + `alert_rules` / `webhook_targets`
  / `webhook_deliveries` subschema (MIT — **copyable with attribution**). Relay to
  **`@baev_bot_bot`**.
- `alert_rules` for **error / session-complete / quota**; **dedupe + rate-limit**
  alerts (a stuck loop must not spam); retries/backoff via `webhook_deliveries`.
- Bot token per **D7** (env / `chmod 600`), never in SQLite, never to the browser.

**Acceptance criteria**
- [ ] A real error/stuck condition produces exactly one throttled Telegram alert.
- [ ] Delivery failures retry with backoff and are recorded.
- [ ] Secret handling verified; token never leaves the server.
- [ ] Coverage/badges/Pages gates still green.

---

## Phase 3 — Delegation-savings tile (cost moat)
**Answers Q4.** (Re-sequenced *ahead of* the old vector-DB Phase 3 per D5.)

**Scope**
- `model_pricing` as **one dated constant, under test** (D6). `token_usage` bucketed
  by speed/geo/tier with **compaction baselines** preserved across `PreCompact`
  (the subtle piece — designed feature, own tests, not a graft).
- **Delegation-savings** metric — **reimplemented clean-room** from cast's idea
  (all-rights-reserved; do **not** copy `analytics.ts`): conservative
  `max(0, sonnetEquiv − actualHaiku)` off ground-truth JSONL tokens.
- A dashboard tile: today/this-week cost + savings, labelled with the decision it
  informs (§5.3 of the concept review).

**Acceptance criteria**
- [ ] Cost per session/agent matches a hand-computed check against JSONL + pricing.
- [ ] A session that hit `PreCompact` still prices correctly (compaction test passes).
- [ ] A model with no price in the table **fails a test** (no silent staleness).
- [ ] No code copied from cast; metric independently derived.
- [ ] Gates green.

---

## Phase 4 — Global persistent per-instance DAG (the deep moat)
**The differentiator no rival delivers.**

**Scope**
- Elevate the session-scoped tree to a **global, cross-session, per-instance**
  orchestration graph over the **persisted `agent_edges`** (built in Phase 1).
- Layout via **ELK/Graphviz** over the persisted tree; keep queries cheap/precomputed
  (perf budget — concept §9.3).
- Optional: study (do not copy blind) hoangsonww's D3 Sankey/aggregate polish for the
  cost-flow view.

**Acceptance criteria**
- [ ] Global DAG renders across multiple sessions from persisted edges (not
      render-time reconstruction).
- [ ] Query stays within a defined latency budget on a realistic history size.
- [ ] Gates green.

---

## Phase 5+ — Deferred (explicitly out of the near-term line)
- **Cross-machine / fleet aggregation** — only when a second machine actually exists;
  requires a transport + inter-node auth + clock-skew design (concept §2.4).
- **`future/experimental`: context-layer / vector-DB "observability becomes memory"
  feed** — the old Phase 3, parked per D5. Needs `ANTHROPIC_API_KEY` (out of the main
  app's env), an embedding pipeline, and nightly jobs. Not on the critical path.

---

## B.2 Definition of Done — global (applies to every shippable phase)
1. All phase acceptance criteria met.
2. **>90% coverage, CI-gated and green** (blocking merges).
3. **Security-invariant tests green** (loopback, token, SSE origin, no-spawner,
   no-SSRF).
4. **README badges all green/true** (via `badges` skill) + donation section present.
5. **GitHub Pages docs site builds and publishes** the phase's user-facing docs.
6. `WORKLOG.md` entry appended (per the `worklog` skill).
7. No all-rights-reserved code copied; grafts attributed (MIT sources only).
8. Loopback-only invariant intact; the public docs site does **not** expose the app.

## B.3 Sequencing rationale (one line each)
- **P0 before all** — resolves R1/R5/R9, the unknowns that could invalidate the design.
- **P1 = MVP** — the tree + persistence + security that make it daily-usable (Q1–Q3,Q5).
- **P2 before P3** — remote alerting is higher daily value than the cost tile, and
  reuses the webhook schema cheaply.
- **P3 (cost) before P4 (global DAG)** — cost is small, high-visibility, and validates
  the token/compaction model that the global DAG's aggregates also rely on.
- **P4** — the deep moat, built on edges already persisted in P1.
- **P5+ deferred** — no fleet until a second host exists; vector-DB is a different
  product.

## B.4 Risk → mitigation → phase (traceability to the concept review's register)
| Risk (concept §9.10) | Mitigated by | Phase |
|---|---|---|
| R1 JSONL can't rebuild tree | G0 spike; JSONL-primary or outbox fallback | P0 |
| R2 Token double-count on replay | Idempotent upsert + replay test | P1 |
| R3 All-rights-reserved code copied | Clean-room rule; MIT-only copy | P0 policy / all |
| R4 Stale pricing | Dated constant + coverage test | P3 |
| R5 Scope diffusion | Daily-questions MVP; Phase-3 deferred | P0 / all |
| R6 Missed SubagentStop | Watchdog + `unknown` state | P1 |
| R7 Unbounded DB / full payloads | Retention + redaction policy | P1 |
| R8 Security drift | Invariant tests + grep gate in CI | P1 |
| R9 Hook-catalog assumptions | G0 verification | P0 |
| R10 Coverage theatre | CI gate blocking <90% | P1 |

## B.5 Immediate next actions (to start Phase 0)
1. **Approve the Part A decisions** (D1–D7 + licensing/security policy) — or amend.
2. Run **G0.1–G0.4** on the Mac Mini; write the spike report into `WORKLOG.md`.
3. On a ✅ gate: scaffold the **pnpm monorepo** skeleton (`server` / `web` / `shared`
   / `hooks`) with the CI coverage gate and security-invariant test harness **wired in
   from commit one** — never retrofitted.
4. Update `docs/ai/DESIGN.md` so the design of record reflects the
   resolved decisions (SSE, JSONL-primary, clean-room licensing rule) and Ivan's
   delivery bar (coverage/badges/donation/Pages).

---

_Plan is a living document — revise as Phase 0 findings and real usage refine the
sequencing. No code until the Part A decisions are approved and Gate G0 is green._
