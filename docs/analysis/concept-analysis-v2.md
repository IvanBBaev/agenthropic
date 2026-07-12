# Concept Analysis v2 — Consolidated

**Authoritative re-analysis of the agenthropic conceptual brief.** This v2 folds four
inputs into one decision-useful view:

1. the original internal analysis — [`concept-analysis.md`](concept-analysis.md) + [`implementation-plan.md`](implementation-plan.md) (**v1**);
2. two externally-produced parallel reports — **BASE** (~3.7k words) and **EXPANDED** (~7.7k words);
3. the adversarial cross-check of those two — [`external-docs-review.md`](external-docs-review.md);
4. the design of record — `docs/ai/DESIGN.md` and the invariants in `CLAUDE.md`.

It was produced by a six-lens senior workflow (Architect · Developer · QA · Business
Analyst · brutal Gap · Holistic), Opus / high effort, ~468k subagent tokens, run against
all of the above. Where v1 and the externals agree, that is recorded as **confirmed**;
where they diverge, this document **decides**. The consolidated decisions here are the
input to [`development-plan.md`](development-plan.md), which decomposes them into
agent-distributable work packages.

> **Naming:** decisions are tagged by originating lens — `AD*` Architect, `SD*` Developer,
> `QA-D*` QA, `BA-D*` Business, `G-D*` Gap, `LB*/H-*` Holistic. The **canonical set** in
> §3 dedupes them into ten load-bearing decisions the build actually turns on.

> **Empirical update — 2026-07-04 desktop probe.** The full-corpus read-only probe
> ([`phase0-probe.md`](phase0-probe.md), 17 projects · 117 sessions · 33 subagent dirs)
> **pre-answers CD-1 as `CONDITIONAL-GO` → build (confidence 85)** and corrects the
> mechanism assumptions below. It **de-risks but does not replace** the formal Phase-0
> spike — WP-S1/WP-S5 still need the paired-capture corpus + Ivan's tree sign-off, and the
> WP-S7 GO gate still stands (no production code before it).
> - **Spawn tool is `Agent` / `Workflow`, never `Task`** — 0 `Task` blocks in the real
>   corpus (`Agent` = 142, `Workflow` = 29); a `Task`-keyed parser rebuilds an empty DAG.
> - **The two on-disk layouts are spawn-mechanism-driven, not version-driven** — a
>   general-purpose `Agent` writes flat `subagents/agent-<hex>.jsonl`, a `Workflow` writes
>   nested `subagents/workflows/wf_<id>/`; both coexist within the same CC version, so the
>   parser branches on **directory shape**, not `version`.
> - **The proven load-bearing hedges are dual-layout parsing (85% nested) + child-transcript
>   token summation** (parent rollup ≈ 0%) — these, not the outbox, are what protects the moat.
> - **The durable outbox (CD-1 fallback / WP-IN11) is YAGNI-leaning and pulled off the v1
>   critical path** — JSONL self-reconciles by backfill (≈ 0 historical crashes); add it only
>   on a real trigger (a sub-second-liveness need, or a hooks-only data source).

---

## 1. Bottom line

**Build.** The concept is unusually coherent because it descends from a source-level audit
of six real rivals, not a blank page. One dimension — the **security posture** (loopback-only,
mandatory-token-or-fail-startup, no-spawner, same-origin, no-SSRF) — is genuinely
best-in-class and is the system's *spine*, not a bolt-on. The external docs **converge with
v1** on the two decision-critical tripwires (neither repeats the refuted "simple10 has no
DAG"; both diagnose hoangsonww's RCE as a `bypassPermissions` spawner, not a concurrency
cap), which raises confidence in the whole rather than adding new content.

The gap between this A-grade vision and a shippable v1 is a **small number of load-bearing
decisions that are cheap on paper and ruinous in code**. Two of them govern everything else:

- **LB1 — ingest primacy** (the #1 architectural unknown): does `~/.claude/projects/*.jsonl`
  carry the subagent parent→child linkage well enough to rebuild the DAG from the durable
  log alone after an outage? This is **make-or-break for the persistent-DAG moat** and both
  externals silently default to hooks-primary with no durability contract. It cannot be
  settled on paper — a **Phase-0 empirical spike** must answer it before any architecture is
  poured.
- **LB2 — identity**: *personal-first / commercial-clean*. One decision simultaneously fixes
  scope discipline (defer fleet + multi-tenancy) **and** licensing strictness (only
  simple10 + hoangsonww are copyable; everything else is clean-room).

Everything else resolves cleanly around these two.

**Synthesis rule for v2:** **BASE's sequencing + accuracy** (Phase-0 spike, security in
Phase 1) **+ EXPANDED's formal apparatus** (FR/NFR/ADR/traceability, negative-test
catalogue, quantified metrics, the `events_raw`+`events` schema split) **+ the eleven
items the internal analysis carries that both externals miss.** EXPANDED's own generation
defects — seven byte-identical §10 holistic tables, security deferred to Phase 6, Phase-0
reduced to paperwork, SSRF dropped — are **explicitly quarantined and not inherited.**

---

## 2. The two load-bearing decisions

Everything hangs off these; if either is wrong the rest is wasted motion.

### LB1 — Ingest primacy (the data-foundation seam)

**Decision:** ingest is **JSONL-primary + replay-on-startup**, with hooks providing
sub-second liveness only, and **every write is an idempotent upsert on a stable event id** —
**contingent on the Phase-0 spike proving JSONL carries the subagent parent→child linkage.**
If it does not, fall back to **hooks-primary + a durable local outbox/spool** (at-least-once,
idempotent upsert), and only then.

Why it is load-bearing: this single choice determines whether the persistent-DAG moat is
*trustworthy* (survives an outage), whether the ground-truth-tokens invariant is satisfied
*naturally* (tokens read from the durable log, never inferred), whether history is
crash-tolerant, and whether >90% coverage is even achievable (replay-from-fixtures needs a
deterministic durable source). **The primacy decision is an *output* of Phase-0, not an
assumption baked in ahead of it — which is precisely EXPANDED's error.** _(The 2026-07-04
desktop probe has since pre-answered it `CONDITIONAL-GO` (confidence 85); the formal
paired-capture spike confirms rather than decides it — see the empirical-update note above
and [`phase0-probe.md`](phase0-probe.md).)_

### LB2 — Identity: personal-first / commercial-clean

**Decision:** build the single-user Mac Mini cockpit; take only the **cheap** commercial
hedges now (MIT-clean code only; `instance`/`host_id` on every row from the first
migration; a schema that does not *block* tenancy); explicitly **defer** fleet and
multi-tenancy. Resolve the "OPCⁿ" commercial-line token — **define it or drop it** — before
it drives tenancy/schema/license-strictness investment.

Why it is load-bearing: it resolves two cross-dimension tensions at once — scope discipline
for a solo owner **and** legal reality. The constraints happen to align: the copyable repos
(simple10, hoangsonww) carry the **large** patterns (tree-building, webhook/alert schema),
while the uncopyable ones (cast/disler/nirdiamant) carry only **small** ideas cheap to
reimplement clean-room.

---

## 3. Canonical decision register (v2)

The ten decisions the build turns on, each consolidating the per-lens decisions that agree
on it. These are the durable output of this analysis.

| # | Decision | Consolidates | Satisfies (FR/NFR — recovered EXPANDED §3, LOST-5) | The rule |
|---|----------|--------------|---------------------------------------------------|----------|
| **CD-1** | **Ingest primacy is JSONL-primary + replay-on-startup, contingent on Phase-0; else hooks-primary + durable outbox.** | LB1, AD3, SD3, G-D1 | **FR-01**, **FR-05**; **NFR-OPS-01** | Decided by the Phase-0 diff (tree-from-JSONL vs tree-from-hooks), never assumed. |
| **CD-2** | **Single immutable substrate + deterministic projection.** Both sources write into append-only, idempotency-keyed `events_raw`; `sessions`/`agents`/`orchestration_edges`/`token_usage` are a **pure replayable projection** over it. | AD1, SD2 | **FR-04**; **NFR-DATA-01/02** | Reconciliation is **per-field precedence at projection time**, not a two-store merge at query time. |
| **CD-3** | **Reconciliation precedence.** Tokens are **JSONL-authoritative** (never inferred); interim liveness/state from hooks; final session/agent state + cost from JSONL. `token_usage.agent_id` is **nullable at first write, deterministically backfilled** once the agent is known. | AD2, SD4 | **FR-03**, **FR-05**; **NFR-DATA-02** | Cross-source idempotent upsert: a fact seen by *both* a hook and JSONL lands once. |
| **CD-4** | **Schema:** `events_raw`(immutable) + `events`(normalized); persisted `orchestration_edges` (self-ref `parent_agent_id`, `instance`/`host_id`, `derived_from_event_id`, idempotent); fine-grained `token_usage` (service_tier / speed / inference_geo + **compaction baseline**); **versioned** `model_pricing` (`effective_from`, `verified_on`). | AD4, G-D6, SD5 | **FR-02/03/04/06/08**; **NFR-MAINT-01** | `events_raw` is provably append-only (no UPDATE/DELETE path, enforced by test). |
| **CD-5** | **Transport is SSE** with same-origin enforcement from Phase 1. | AD5 | **FR-06**, **FR-07**; **NFR-SEC-02** | Server→browser-only feed; revisit WebSocket only if bidirectional control is ever needed (it is not). |
| **CD-6** | **Ports & adapters:** named set — `HookSource`, `TokenReader/TokenSource`, `StoragePort`, `RealtimeHub`, `AlertSink`, `PricingProvider`, `CostEngine` + an `EventStore` port + a pure `Normalizer/Projection`; simple10's strategy-pattern agent classes are the per-runtime adapter (Claude Code now, Codex later). | AD6, SD1 | **FR-01/05/08/09** (via named ports); **NFR-MAINT-01** | Keeps the normalizer testable/replayable and the system multi-runtime-ready without a core rewrite. |
| **CD-7** | **Security + the coverage gate are boundary conditions from commit one**, CI-blocking: loopback-or-fail bind; mandatory `DASHBOARD_TOKEN`-or-fail-startup (timing-safe compare); SSE same-origin; **no-spawner** grep/static gate; **no-SSRF** (webhook targets operator-configured, never dialed from a payload); WAL + tested restore; >90% coverage blocks merges. | AD7, SD8, QA-D3/D4, G-D3, H-SEQ | **NFR-SEC-01/02/03**, **NFR-MAINT-01** | **Rejects** EXPANDED's security→Phase 6 / backup→Phase 8. Slice 8 is polish only. |
| **CD-8** | **Phase 0 is a throwaway GO/NO-GO feasibility spike** with a hard ❌ stop — G0.1 ingest-primacy probe · G0.2 hook-catalog enumeration (don't assume "the twelve"; confirm/deny `SubagentStart`) · G0.3 tree smoke gate · G0.4 token-reconciliation probe. No production code until green. | AD-Phase0, G-D2, H-SEQ | — _(process gate; de-risks FR-01/03/05/06)_ | **Rejects** EXPANDED's paperwork "decision lock" that validates linkage only at the Phase-4 UI. |
| **CD-9** | **Per-artifact licensing.** COPY simple10 tree/ports + hoangsonww Telegram/webhook schema ~~+ dual-sqlite driver~~ _(dropped — single better-sqlite3 driver per best-path §6.3, applied 2026-07-06)_ **with attribution**; CLEAN-ROOM reimplement cast `controlGate` + delegation-savings and nirdiamant checkpoint (never view their source while writing). Enforced by a CI provenance/license scan. | SD6, BA-D4, G-D4, LB2 | — _(licensing/provenance; underpins FR-09)_ | cast/disler/nirdiamant are **all-rights-reserved by Berne default** — not "ambiguous". |
| **CD-10** | **Scope + secrets + retention.** MVP = the 5 daily questions; Phase-3 vector-DB "observability-becomes-memory" feed on a **labeled experimental track**; fleet deferred until a second host exists; Telegram token via `token_ref` → launchd env / chmod-600 (never in SQLite, never to the browser); **retention TTL + payload redaction from Phase 1.** | BA-D1/D3, G-D7, AD8, SD7, LB2 | **FR-09**; **NFR-PRIV-01** | `ANTHROPIC_API_KEY` stays out of the dashboard env entirely. |

**Cost-trust chain (CD-3 + CD-4 crosscut, H-COST):** every displayed dollar traces to
*(ground-truth tokens × a dated, priced model)*; a model observed in fixtures with **no
price** row **FAILS CI** — silent staleness is a red build, not a runtime "estimated" label.
This extends the byte-exact-tokens guarantee to the priced output.

---

## 4. The six lenses (consolidated)

### 4.1 Senior Architect

**Verdict:** the topology (hooks + JSONL → ingest → SQLite/WAL → SSE → SPA), the
ports-&-adapters backbone, and the "hierarchy is persisted data, not UI reconstruction"
invariant are all correct and confirmed — build proceeds. The one load-bearing gap v1 named
and both externals still miss is the **reconciliation contract**; v2 resolves it structurally
via CD-2/CD-3 (single `events_raw` substrate + deterministic projection + per-field
precedence), which collapses replay-on-startup, idempotency, and outage-backfill into one
mechanism.

- **Confirmed:** the proven local-first loop; persisted `orchestration_edges` as the moat's
  core artefact (queried from the table, never render-time reconstructed); fine-grained
  `token_usage` + compaction baseline that both externals coarsen away; the `instance`/`host_id`
  near-zero-cost fleet hedge.
- **Adopted from EXPANDED:** the `events_raw`(immutable)+`events`(normalized) split — the one
  genuine schema improvement — elevated to *the* reconciliation substrate both sources write
  into; the named adapter set; the FR/NFR register with proof columns; ADRs as decision-memory.
- **Rejected from EXPANDED:** security→Phase 6 (architecturally wrong, self-contradictory);
  Phase-0-as-paperwork.
- **Decisions:** AD1–AD8 → canonical CD-1..CD-8.

### 4.2 Senior Developer (buildability by a solo owner)

**Verdict:** feasible for one owner; the stack lean (Fastify + better-sqlite3 + React/Vite/D3,
pnpm monorepo, SSE) is correct. Developer-critical value sits in three places the externals
only half-cover: (1) the **normalizer is a two-path problem** — forward-link on `SubagentStart`
*if it exists*, else post-hoc reconstruction on `SubagentStop`, with the JSONL `Agent`/`Workflow`
spawn-tool chain as the **primary durable linkage source**; (2) the **cost engine** must combine
EXPANDED's versioned `model_pricing` with v1's tier/speed/geo buckets + PreCompact baseline as
an append-only recomputable layer; (3) **licensing is a per-artifact engineering rule**, not a
vibe.

- **`SubagentStart` is probably not a real hook** — the documented set is
  PreToolUse/PostToolUse/UserPromptSubmit/Notification/Stop/SubagentStop/SessionStart/SessionEnd/PreCompact.
  Plan for its **absence** as the base case: JSONL-primary + post-hoc-on-Stop is the likely
  real design. **G0.2 confirms before the normalizer is committed.**
- **Monorepo:** `apps/server` + `apps/web` (deployables), `packages/shared` + `packages/test-fixtures`
  (libraries), `hooks/` (installable scripts) — reconciles BASE `packages/*` vs EXPANDED
  `apps/*`; `test-fixtures` becomes first-class.
- **Ingest must accept-and-store-raw ANY event type** (graceful audit) so an unknown/new hook
  never crashes the pipeline; the normalizer keys only off verified events + `schema_version`.
- **Decisions:** SD1–SD9 → CD-2/3/4/5/6/7/9/10.

### 4.3 Senior QA

**Verdict:** the QA posture is sound and now well-instrumented. You cannot unit-test "the
dashboard"; the four real units are **ingest correctness, tree correctness, cost correctness,
live-flow correctness**, each with a distinct harness. The **golden real-session fixture
corpus** is the #1 QA investment — without it, >90% coverage is high-coverage tests of
synthetic happy-paths (false safety).

- **Consolidated test model:** BASE's 5-layer pyramid (Unit / Integration / Security / UI /
  Manual-real-session) + EXPANDED's P0/P1/P2 priority tiering + EXPANDED's 10-scenario negative
  catalogue **plus two v1-only cases** (compaction-mid-session, PreCompact re-pricing).
- **Three ground-truth reconciliation tests are P0 release-blockers:** (1) Σ `token_usage` ==
  JSONL exact per session; (2) double-replay → byte-identical DB state; (3) **DAG-rebuild from
  JSONL alone** after a simulated outage — the make-or-break test both externals omit.
- **Resolved contradictions:** hierarchy correctness gate **≥95%** against a labeled golden
  corpus (100% is aspiration, untestable on messy real sessions); pricing staleness is a
  **failing test**, not a runtime label.
- **QA holds stop-the-release authority:** an "almost-correct hierarchy" manufactures false
  trust and is worse than no graph.
- **Rejected:** EXPANDED's Gate D / security → Phase 6; its catalogue dropping the compaction
  case; SSRF omitted.
- **Decisions:** QA-D1–D8 → CD-7 + the acceptance criteria in §6.

### 4.4 Senior Business Analyst

**Verdict:** the business case is sound and sharper than v1 — a real, narrow gap (no
persistent-DAG cockpit with dollar cost + owned persistence + Telegram alerts +
security-by-default that is *also* popular/maintained) against a named incumbent
(davila7/**claude-code-templates, 28.4k★**). The identity split is resolved to
**personal-first / commercial-clean** (LB2).

- **Durable moat = only what is hard to retrofit:** persistent per-instance DAG + security
  posture + fleet. The other four (persistence, cost, alerts, DAG-lite) the incumbent *could*
  add — positioning must lead with the architecturally-hard differentiators.
- **Quantified success metrics** replace v1's qualitative daily-questions: hierarchy ≥95%,
  time-to-understand <30s, 0 lost raw events, idempotent totals, cost = exact JSONL match.
- **Three BA findings survive:** licensing is a **hard commercial/legal gate** (all-rights-reserved,
  not "ambiguity"); **"OPCⁿ" is an undefined token** that leaked from BASE into the internal
  docs and must be defined or dropped; **scope is program-sized** — the Phase-3 vector-DB leap
  is a *different product* on an experimental track.
- **Decisions:** BA-D1–D6 → CD-9/CD-10 + the metrics in §6.

### 4.5 Brutal Gap Analysis

The eleven gaps between vision and a shippable v1, ranked by danger. None is fatal; each has a
**smallest provable slice** that closes it, and none is closed by "more documentation".

| # | Gap | Danger | Smallest provable slice |
|---|-----|--------|-------------------------|
| 1 | **Reconciliation/durability contract** | make-or-break for the moat | Phase-0 script: rebuild tree from JSONL alone for one real session, diff vs hook-derived tree |
| 2 | **Phase 0 must be a real GO/NO-GO spike** | builds normalizer on unproven premise | Gate G0 with a hard ❌ stop; throwaway code only |
| 3 | **Security sequencing (Phase 1, not 6)** | cross-origin-vulnerable socket for two phases | security-invariant tests in CI from commit one |
| 4 | **Licensing legal blocker** | infringement under commercial intent | CI provenance/license scan; copy only simple10/hoangsonww |
| 5 | **Hook-catalog uncertainty** | both normalizers rest on unverified "twelve" | G0.2 enumerates actual hooks + fields |
| 6 | **Coarse token costing** | misprices after PreCompact | compaction re-pricing test + priceless-model-fails-CI |
| 7 | **Missing `instance`/`host_id`** | future forced migration | one column on every row in the first migration |
| 8 | **Missing coverage/badges/Pages gate** | coverage theatre | CI gate blocking <90% live from Phase 1 |
| 9 | **Solo-owner scope creep** | stalls in Phase 2 | cut vector-DB to experimental; defer fleet; gate MVP to daily questions |
| 10 | **SSRF + secret home + retention** | dial-out, leaked token, unbounded growth | SSRF guard test; token via launchd env; retention/redaction in Phase 1 |
| 11 | **External docs' own defects** | inherited as if analysis | one reconciled KPI; `events_raw`+`events`; `orchestration_edges` first-class |

**Decisions:** G-D1–D7 → the canonical set.

### 4.6 Holistic / Systems

**Verdict:** an unusually coherent concept. Coherence is **not automatic** — it holds only
once **LB1** and **LB2** are locked. Five commitments then reinforce rather than fight each
other: the security spine keeps the surface small (helps the solo owner *and* maintainability);
JSONL-primary ingest makes the ground-truth-tokens invariant *free*; the >90%-coverage CI gate
is the enforcement layer that turns the security spine from prose into fact.

Four seams where coherence is stressed:
1. the persistent-DAG moat's durability promise depends **entirely** on LB1;
2. the cost moat inherits exact tokens but a **churn-prone hand-maintained pricing table** —
   precision on the input can be silently betrayed downstream (→ H-COST / CD-4);
3. **ambition vs ownership** — a solo owner out-building a 28.4k★ incumbent on five axes + a
   coverage gate + a docs site is the exact hoangsonww "enterprise-cosplay-over-solo-project"
   trap (→ scope discipline, CD-10);
4. **"steal these patterns"** collides with the flagship grafts being all-rights-reserved
   (→ CD-9).

The reassuring finding: the constraints are **well-aligned** — the copyable repos carry the
large patterns, the uncopyable ones only small cheap ideas. EXPANDED is itself the **negative
holistic exemplar** (seven identical tables, security to Phase 6) — the precise failure this
lens exists to prevent. v2 must be the counter-example.

**Decisions:** LB1, LB2, H-SEQ, H-APPARATUS, H-COST → CD-1/7/8 + the synthesis rule.

---

## 5. Strengths & weaknesses (v2)

### Strengths (confirmed and reinforced)
- **Descends from a real audit,** not a blank page — six rivals graded with `file:line` evidence.
- **Security posture is best-in-class** and functions as the system's spine; every rival binds
  `0.0.0.0` and/or ships no-op auth, and hoangsonww ships an actual RCE spawner.
- **Ground-truth-tokens invariant** is architecturally honest — tokens are read, never inferred.
- **The moat is genuinely defensible in its narrowed form** (persistent per-instance DAG +
  security + fleet are hard to retrofit).
- **Independent external convergence** on the two tripwires validates v1's coherence.

### Weaknesses (open until closed by the plan)
- **LB1 is empirically de-risked but not yet formally proven** — the 2026-07-04 desktop
  probe pre-answered it `CONDITIONAL-GO` (confidence 85; [`phase0-probe.md`](phase0-probe.md)),
  yet the paired-capture Phase-0 spike still has to confirm it on a labeled corpus; it remains
  the single biggest risk carrier.
- **Hook catalog is assumed, not verified** (`SubagentStart` likely absent).
- **Cost precision is only as good as a hand-maintained pricing table** amid active model churn
  (Opus 4.8, Sonnet 5, Haiku 4.5, Fable 5).
- **Scope is program-sized for one owner** — needs ruthless daily-questions-driven sequencing.
- **"OPCⁿ" commercial identity is undefined** yet has propagated into the internal docs.
- **Delegation-savings risks being a vanity metric** unless the decision it informs is named.

---

## 6. Acceptance criteria the MVP must meet (quantified)

Merged across lenses; these become the gates in [`development-plan.md`](development-plan.md).

**Data foundation & reconciliation**
- Both hooks and JSONL land in `events_raw` with a stable idempotency key; re-ingesting the
  same log yields **byte-identical** `events_raw` **and** an identical projected DB state.
- Σ `token_usage` per session **== JSONL ground truth exactly**; a static check proves no token
  row can originate from inference.
- **Kill + restart mid-session** → replay-on-startup reconstructs identical
  sessions/agents/`orchestration_edges`/`token_usage`; zero data loss.
- **DAG-rebuild:** after a simulated mid-session outage the tree reconstructs from JSONL alone
  (or, if Phase-0 forces hooks-primary, from the durable outbox with at-least-once + idempotent
  dedupe, no double-count).
- `orchestration_edges` is persisted; the global/cross-session DAG is served **by querying the
  table**, never render-time reconstruction. Every row carries a non-null `instance`/`host_id`.
- `token_usage.agent_id` may be NULL at first write, backfilled deterministically; a
  reconciliation test asserts no double-count or misattribution after backfill.

**Tree correctness**
- From one real subagent-heavy session, the correct parent→child tree reconstructs via the
  JSONL `Agent`/`Workflow` spawn chain **even if `SubagentStart` never fires**.
- Hierarchy correctness **≥95%** vs a labeled golden corpus of **≥3 real sessions** including
  crashed-no-Stop, deep nesting, mid-session PreCompact, two concurrent instances.
- A missing `SubagentStop` → explicit **"unknown"** state within the watchdog window, never a
  permanent "working".
- All ten EXPANDED §7.1 negative scenarios pass, **plus** compaction-mid-session and
  PreCompact re-pricing.

**Cost**
- A session that hit PreCompact still reprices correctly against its preserved baseline.
- A fixture model with **no price** row **FAILS CI**; `model_pricing` is versioned
  (`effective_from`/`verified_on`).

**Security (build-failing, from Phase 1)**
- Server binds `127.0.0.1` only and **FAILS startup when `DASHBOARD_TOKEN` is unset** (never
  "auth disabled"); token compare is timing-safe; SSE rejects cross-origin; no wildcard CORS.
- A grep/lint gate fails the build if any route spawns a subprocess from request input.
- An SSRF test proves no outbound dial to a payload-supplied URL.
- `events_raw` exposes no UPDATE/DELETE path (enforced by test); SQLite runs WAL; a backup is
  taken **and a restore is exercised** at least once per release candidate.

**Product / business**
- v1 answers all **5 daily questions**; **time-to-understand a session < 30s.**
- No all-rights-reserved code ships (clean-room for cast/disler/nirdiamant; attribution for
  simple10/hoangsonww), verified by a CI provenance check.
- Vector-DB feed labeled experimental and off the critical path; fleet deferred (only the
  `instance`/`host_id` hedge present).

**Delivery bar (Ivan's, missed by both externals)**
- CI coverage gate **blocks merges below 90%** (scope defined), live from Phase 1.
- README badges render **green/true** (via the badges skill) with a donation section.
- The **GitHub Pages docs site builds** — while the application stays bound to `127.0.0.1`
  (docs public, app never exposed).

---

## 7. Open questions → Phase-0 inputs

The empirical unknowns that must be answered before architecture is poured. These are the
Phase-0 gate's job (CD-8); every one feeds a `G0.*` probe in the development plan.

1. **G0.1 — THE make-or-break:** does `~/.claude/projects/*.jsonl` carry the subagent
   parent→child linkage (`Agent`/`Workflow` spawn-tool → child `sessionId` → parent ref) so the DAG rebuilds
   from JSONL alone after a full outage? Governs CD-1 (JSONL-primary vs hooks-primary+outbox).
2. **G0.1b — join key:** what is the exact key from a JSONL token row to a specific `agent_id`?
   Does a subagent get its own transcript with a recorded parent, or must attribution fall back
   to a timestamp/model heuristic? Determines whether CD-3's backfill is a hard join or a
   confidence-scored inference (surface uncertainty in the UI if the latter).
3. **G0.2 — hook catalog:** which of the assumed "twelve" actually fire — specifically does
   `SubagentStart` exist? If not, edge derivation keys off the `Agent`/`Workflow` PostToolUse + `SubagentStop`.
4. **G0.2b — PreCompact mechanism:** does the log carry pre/post-compaction markers that let
   `token_usage` preserve a repriceable baseline, or must it be snapshotted at hook time?
5. **State reconciliation:** once a late `SubagentStop` or the JSONL final arrives, does a
   watchdog-set "unknown/stale" revert to completed or stay flagged? Needs an explicit
   state-transition rule.
6. **Policy numbers:** retention window + payload-redaction rule (which fields, at ingest or at
   query), "huge payload" reject-vs-truncate threshold, and the coverage-gate scope (line vs
   branch, per-package vs global, does the web package count).
7. **Pricing source:** the authoritative dated source for `model_pricing` and the refresh
   cadence that keeps the staleness-fails-CI test honest as the model lineup churns.
8. **Hook-POST auth:** is the loopback hook endpoint itself authenticated, and how does the
   hook script obtain the token without leaking it into `~/.claude` scripts?
9. **"OPCⁿ":** define the commercial line concretely or drop the token (BA-D6).

---

## 8. What changed vs v1

| Area | v1 | v2 (this document) |
|------|----|--------------------|
| Reconciliation | named as make-or-break, unresolved | **resolved** — single `events_raw` substrate + deterministic projection + per-field precedence (CD-2/3) |
| Schema | implicit single `events` | **`events_raw`(immutable) + `events`(normalized)** adopted from EXPANDED (CD-4) |
| Ports | prose "ports & adapters" | **named adapter set** + `EventStore` + pure `Normalizer/Projection` (CD-6) |
| Requirements | prose decisions D1–D7 | **FR/NFR register + ADR set + traceability matrix + negative-test catalogue** folded in |
| Metrics | qualitative "daily questions" | **quantified** — hierarchy ≥95%, time-to-understand <30s, 0 lost raw events (CD + §6) |
| Normalizer | tree-building, `SubagentStart` hedged | **dual-path** design; plan for `SubagentStart` **absence** as base case (SD3) |
| Cost | compaction sleeper flagged | **versioned pricing + buckets + baseline + cost-trust chain** (CD-4, H-COST) |
| Licensing | copy-vs-reimplement line | hardened to a **CI-enforced per-artifact rule** (CD-9) |
| KPI | — | **reconciled** the external 100%-vs-95% contradiction to a **≥95% gate** |
| Phase 0 | go/no-go gate | reaffirmed as an **empirical spike**, explicitly against EXPANDED's paperwork degradation (CD-8) |

---

## 9. Verdict

**Build — personal-first, security-spine-first, moat-led.** Freeze **LB1** (ingest primacy,
answered by the Phase-0 spike) and **LB2** (personal-first / commercial-clean). Adopt **BASE's
sequencing** (empirical Phase-0, security in Phase 1) + **EXPANDED's formal apparatus**
(FR/NFR/ADR/traceability, `events_raw`+`events`) + **the eleven internal-only items**. Quarantine
EXPANDED's generation defects. The consolidated decisions **CD-1 … CD-10** are the input to the
work-package decomposition in [`development-plan.md`](development-plan.md); open work is tracked
in [`../../TODO.md`](../../TODO.md), completed milestones in [`../../DONE.md`](../../DONE.md).

---
_Six-lens re-analysis (Architect · Developer · QA · BA · Gap · Holistic), Opus / high effort,
~468k subagent tokens, run against v1 + BASE + EXPANDED + the adversarial review. Reviewed
against the design of record in `docs/ai/DESIGN.md`._
