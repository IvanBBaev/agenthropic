# External `due-diligence/` Docs — Adversarial Review

Cross-check of the two externally-produced reports in the top-level `due-diligence/`
directory against this project's ground truth. Those two docs are an **independently
produced parallel version of the exact deliverable this project already authored** in
[`concept-analysis.md`](concept-analysis.md) + [`implementation-plan.md`](implementation-plan.md)
— a conceptual brief + gap + holistic + implementation plan. Their strong convergence
with the internal analysis **validates** it; this document records where they are
sharper, where they are softer, and where they are simply wrong.

- **BASE** — `agenthropic_ideen_doklad_gap_holistic_implementation.docx` (~3.7k words, 11 sections)
- **EXPANDED** — `agenthropic_ideen_doklad_gap_holistic_implementation_EXPANDED.docx` (~7.7k words, 26 sections; a superset)

## Method

A five-lens adversarial workflow (5 parallel senior reviewers, Opus, high effort,
~361k subagent tokens) cross-checked every claim against: `docs/ai/DESIGN.md`,
`CLAUDE.md`, [`../independent-due-diligence.md`](../independent-due-diligence.md),
the six per-project deep dives in [`../due-diligence/projects/`](../due-diligence/projects/),
[`../due-diligence/security.md`](../due-diligence/security.md), and the internal
[`concept-analysis.md`](concept-analysis.md) / [`implementation-plan.md`](implementation-plan.md).

The lenses: **factual accuracy on the six rivals · internal consistency & document
defects · completeness vs the internal analysis · security correctness · implementation-plan
soundness.**

## Bottom line

Both docs are **factually sound and materially better than the vendor report they
digest.** They pass the two decision-critical tripwires:

1. **Neither repeats the refuted "simple10 has no DAG" claim** — both explicitly credit
   `buildAgentTree()` + real tests, and correctly note the remaining real gap (edges are
   event-derived / session-scoped, not a persisted global DAG).
2. **Both diagnose the hoangsonww RCE correctly** — a browser-driven `claude` spawner
   exposing `permission-mode` / `bypassPermissions` with opt-in / no-op-when-unset auth —
   **not** the vendor's "concurrency cap 10,000" red herring. Both also flag its DAG as
   "oversold" (a type-aggregated 3–4 layer diagram).

But the two are **not interchangeable**: **BASE is more precise, EXPANDED is more
formalized — and EXPANDED carries real generation defects.** Neither, on its own, is a
superset of the internal analysis.

## Findings — critical / high

| # | Doc | Finding | Ground truth |
|---|-----|---------|--------------|
| H1 | EXPANDED | **§10.1–10.7 "holistic analysis": all seven sub-tables are byte-identical.** The row `"Да се гони feature richness преди data/security foundation."` repeats verbatim at lines 938/952/966/980/994/1008/1022. Security-holism answers a data question; ~95 lines are duplicated filler presented as analysis. | Seven distinct holistic dimensions each promise dimension-specific analysis; six are copy-paste duplicates of the first. |
| H2 | EXPANDED | **Security hardening sequenced to Phase 6 of 8** (loopback enforcement, same-origin WS, no-spawner audit), while the WS/SSE realtime layer ships at Phase 4 — two phases of a cross-origin-vulnerable endpoint. Directly contradicts its own §9.3: "трябва да са първи в backlog-а, не последни". Backup deferred further, to Phase 8. | CLAUDE.md security invariants are non-negotiable from the first listening socket; the internal plan folds them into Phase 1 CI "from commit one — never retrofitted". |
| H3 | EXPANDED | **Phase 0 is a paperwork "decision lock" (write ADRs, freeze scope), not a feasibility spike.** The make-or-break question — does the real hook/JSONL stream carry subagent parent→child linkage? — is only validated at the Phase-4 UI, after scaffold + ingest + the full normalizer are already built on the assumption. **BASE does this correctly** (Phase 0 spike + explicit stop condition). | Internal Gate G0 exists "to answer R1 (can JSONL rebuild the tree?) before any architecture is poured", with a hard ❌ stop. DESIGN §9 Phase 0 = go/no-go gate. |
| H4 | Both | **The reconciliation / ingest source-of-truth join is only implicitly acknowledged, never framed as make-or-break.** EXPANDED marks `token_usage.agent_id` "nullable" and FR-05 says JSONL usage is linked "където е възможно" — a symptom-level nod — but neither states which source wins on disagreement, designs the join key, or asks whether the DAG survives an outage. Both silently default to hooks-primary with no durability/replay contract. | Internal analysis §2.2/§6.1 makes this THE highest-risk unknown: two ingest sources with different durability/coverage and no reconciliation contract; the persistent DAG (the moat) may have permanent holes if only hooks carry linkage. |

## Findings — medium (by document)

| Theme | BASE | EXPANDED |
|-------|------|----------|
| **Licensing** | "license неяснота" | "license ambiguity"; copied-code legal risk rated only "Low-medium" |
| **nirdiamant shape** | "Config/prompt logic visualization" ✗ | "config/prompt/snapshot observability… не е agent monitor" ✗; command-injection hedged to a "possible risk" |
| **SSRF** | ✅ covered ("no URL fetch from browser", lines 113/423) | ✗ **absent** — and its disler harvest recommends reusing disler's ingest loop without flagging the payload-driven WebSocket dial-out |
| **Payload redaction** | ✗ missing (though it stores `payload_json`) | ✅ covered (NFR-PRIV-01) |
| **Schema** | single `events` table — cannot satisfy its own "raw events immutable" acceptance criterion | `events_raw` immutable + `events` (sounder) |
| **Letter grades** | ✅ keeps all six (all match the dossier) | ✗ dropped for vaguer "Adoptability/Usefulness" prose |

**Shared, medium severity (both docs):**

- **Licensing understated.** cast / disler / nirdiamant are **all-rights-reserved by
  default** (Berne — no LICENSE, `private:true`, "MIT" is a README badge only), stricter
  than "ambiguous". Only simple10 + hoangsonww ship a real LICENSE and are copyable.
  Copying even ~73 LOC of cast's `controlGate` is infringement; patterns must be
  clean-room reimplemented.
- **`instance/host_id` missing from the schema** of both, though both gap analyses demand
  it from v1 — a near-zero-cost hedge turned into a future forced migration.
- **`token_usage` too coarse** — no service_tier / speed / inference_geo buckets, no
  compaction-baseline preservation across `PreCompact`; historical totals will misprice
  after a context rewrite (despite EXPANDED's own FR-08 "reprice" requirement).
- **"Twelve hook events" + `SubagentStart` assumed without verification.** DESIGN itself
  hedges `SubagentStart`; if it doesn't fire, both normalizers rest on a wrong premise.
- **Hooks-primary with no durable spool/outbox** — events emitted while the observer is
  DOWN are lost; EXPANDED's "0 lost raw events" holds only while the receiver is running.
- **No coverage / badge / Pages gate** — both miss the delivery bar entirely (>90%
  CI-blocking coverage, README badges + donation, GitHub Pages docs site).

## Findings — generation artifacts & internal defects

| Doc | Defect | Location |
|-----|--------|----------|
| EXPANDED | §9.1–9.5 gap sections each close with a **byte-identical "Извод:" paragraph**, repeated five times | lines 772/806/840/874/908 |
| EXPANDED | **Numeric contradiction on the core KPI**: exec summary sets "100% correctly reconstructed hierarchy"; MVP metrics table sets ≥95% | line 63 vs line 244 |
| EXPANDED | TOC collapses six appendix sections (21–26) into one unnumbered "21. Appendices" entry | TOC lines 22–42 vs body 1509–1716 |
| BASE | **Devanagari word mid-sentence**: `"Не се правят अनुमानения за tokens"` (intended: "предположения") | §3.1, line 87 |
| BASE | **"OPCn"** — meaningless token used twice as if a product-line name | lines 120, 287 |
| BASE | Lists "SSE stream" as a cast strength (unsupported by the deep dive) | §5, line 190 |
| BASE | Omits `orchestration_edges` from the "Core entities" list, though it calls that table the #1 moat | line 58 vs schema line 401 |
| Both | BASE vs EXPANDED disagree with each other on schema (`events` vs `events_raw`+`events`; `webhook_targets` vs `alert_deliveries`), monorepo layout (`packages/*` vs `apps/*`), and phase count/semantics (6 dated phases vs 9 narrative phases; "Phase 2" = Alerts in BASE, = Ingestion in EXPANDED) | — |

## What the external docs do better than the internal analysis

- **Formal requirement register** — numbered FR-01..10 and NFR-SEC/DATA/PERF/OPS/MAINT/PRIV,
  each with a test/proof column. The internal analysis has no numbered requirement IDs.
- **Explicit ADR set** (ADR-001..010 with decision + rationale). The internal analysis
  states decisions D1–D7 but never turns them into ADR files.
- **Traceability matrix** (capability → FR → QA evidence → phase), **release checklist**,
  and **Definition-of-Done by role** (EXPANDED). The internal analysis has a global DoD
  and a risk→phase table, but no capability traceability matrix or per-role DoD.
- **Negative-test catalogue** (SubagentStop-before-Start, missing parent id, timing
  attack, foreign-origin WS, huge payload, restart mid-session) + lettered QA gates A–F.
- **Quantified MVP metrics** — hierarchy correctness ≥95%, time-to-understand <30s, 0
  lost raw events. The internal analysis used qualitative "daily questions".
- **Concrete phase durations** (BASE) — 2–3 days, 1–2 weeks — making the plan schedulable.

## What the internal analysis has that both external docs miss

1. **The reconciliation CONTRACT as make-or-break** — which source is authoritative
   (JSONL-primary vs hooks-primary), whether the DAG can rebuild from JSONL alone after an
   outage, replay-on-startup vs local outbox. Both externals default to hooks-primary and
   never state this (internal §2.2/§6.1/§6.3, Gate G0).
2. **Precise licensing reality** — no license = all-rights-reserved by the Berne default;
   the sharp copy-vs-reimplement line; only simple10 + hoangsonww are copyable.
3. **Ivan's delivery bar** — >90% CI-blocking coverage, README green-only badges +
   donation, GitHub Pages docs site.
4. **The SSE-over-WebSocket decision** with rationale (D4) — both leave "WS/SSE" open.
5. **Compaction-baseline re-pricing** as the subtle costing sleeper with its own tests.
6. **The Phase-3 vector-DB carve** — "a different product" moved to a labeled experimental
   track (D5); soft in EXPANDED, only partial in BASE.
7. **JSONL-primary ingest + replay-on-startup** (D1) — both externals treat JSONL only as
   a token source with no durable backfill.
8. **Hook-catalog verification** ("don't assume the twelve", confirm/deny `SubagentStart`).
9. **`instance/host_id` in the first migration** as a cheap commercial hedge (D2).
10. **The Telegram bot-token secret home** (env/keychain, never in SQLite, never to the
    browser) as a decision, not just a risk (D7).
11. **Pricing staleness as a FAILING TEST** (a model with no price fails CI), not merely a
    runtime "estimated" label (D6).

## Verdict

| | BASE | EXPANDED |
|---|------|----------|
| **Accuracy** | higher (grades kept, security framing, SSRF) | lower (dropped grades, SSRF absent, duplicated tables) |
| **Formalism** | lower | higher (FR/NFR/ADR/traceability) |
| **Sequencing** | correct (Phase 0 spike, security in Phase 1) | defective (security → Phase 6, backup → Phase 8, Phase 0 = paperwork) |
| **Artifacts** | Devanagari + "OPCn" | duplicated §10 + §9 conclusions |

**The two together ≈ the internal deliverable, but neither alone is a superset of it.**
The right synthesis for the plan going forward is: **BASE's sequencing and accuracy +
EXPANDED's formal apparatus (FR/NFR/ADR/traceability) + the internal analysis's eleven
missed items above.** That synthesis is carried into
[`concept-analysis-v2.md`](concept-analysis-v2.md) and
[`development-plan.md`](development-plan.md).

---
_Reviewed against the design of record in `docs/ai/DESIGN.md` and the
independent audit in [`../independent-due-diligence.md`](../independent-due-diligence.md)._
