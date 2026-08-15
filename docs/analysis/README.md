# agenthropic — Conceptual-Brief Analysis & Plan

Merciless, multi-lens review of the **agenthropic idea itself** (not another audit of
the six rival dashboards — that lives in [`../due-diligence/`](../due-diligence/)),
plus the build plan it produces.

**Fresh session with no context? Start with [PROJECT-STATE-2026-07-06.md](PROJECT-STATE-2026-07-06.md)** — the single entry point: full timeline, document map with authority order, current-truth snapshot, the pending decision, and "if Ivan says X, do Y" playbooks.

Read in order: **v1 analysis → external review → v2 consolidation → development plan → best-path decision → Phase-0 probe → corpus audit → red-team counter-analysis → v1/v2 roadmap (final).**

| File | What's in it |
|---|---|
| [concept-analysis.md](concept-analysis.md) | **v1 — ⚠️ superseded by v2** (kept for the audit trail). The detailed report: Senior **Architect · Developer · QA · Business Analyst** reviews, a **brutal gap analysis**, a **holistic** read, consolidated **strengths/weaknesses**, and a **deep dimension-by-dimension** analysis with a risk register. |
| [implementation-plan.md](implementation-plan.md) | **v1 plan — ⚠️ superseded** (kept for the audit trail; uses the OLD phase numbering — see PROC-6). Part A's D1–D7 were re-resolved as LB1/LB2 + CD-1…CD-10 in v2; Part B was replaced by [development-plan.md](development-plan.md) as amended by [best-path-decision.md](best-path-decision.md) §6. |
| [external-docs-review.md](external-docs-review.md) | **Adversarial review** (5 lenses) of two externally-produced parallel reports (BASE + EXPANDED). Verdict: both sound, both pass the tripwires; **BASE more precise, EXPANDED more formalized** but defect-carrying. Establishes the synthesis rule for v2. |
| [concept-analysis-v2.md](concept-analysis-v2.md) | **v2 — authoritative.** Re-run of the six lenses folding in v1 + BASE + EXPANDED + the review. Resolves the two load-bearing decisions (**LB1** ingest primacy, **LB2** personal-first/commercial-clean) and the **ten canonical decisions CD-1…CD-10** with quantified acceptance criteria. |
| [development-plan.md](development-plan.md) | **The build.** CD-1…CD-10 decomposed into **agent-distributable work packages** (owner-agent, inputs/outputs, dependencies, acceptance criteria), a verified dependency-DAG with **parallel waves**, a **critical path**, and a phase-by-phase roadmap with exit gates. Open work → [`../../TODO.md`](../../TODO.md). |
| [best-path-decision.md](best-path-decision.md) | **Strategic decision memo — sits above the plan.** _"What is actually best to build, and how."_ Output of an adversarial workflow (6 theses × 3 critics + judge, 25 agents) with the two load-bearing empirical claims hand-verified: **moat-first greenfield spine + attributed simple10 tree**; the empirical **`CONDITIONAL-GO`** correction to CD-1; keep/change edits to the plan (alerts off the critical path, delete vector-DB/dual-driver, keep outbox+backfill); a 6-risk register and honest kill-the-program dissent. Confidence 76/100. |
| [phase0-probe.md](phase0-probe.md) | **The evidence.** Empirical read-only probe of the real `~/.claude/projects` corpus (**2026-07-04 census**: 17 projects · 117 sessions · 33 subagent dirs · 148 flat + ~849 nested agent files — 85.2% nested; **superseded by [parser-spec.md](parser-spec.md) §4.2** — 20 slugs · 141 sessions · 1855 subagent transcripts · 54 sessions with subagents — quote §4.2, not this row) — layout/version census, depth-1 hard-key join, depth-2 recoverability, token reconciliation — producing the **evidence-backed CD-1 verdict** with measured numbers. The `do-this-now` action of the best-path memo, executed. |
| [animated-room-analysis.md](animated-room-analysis.md) | Feature-scoped multi-lens review (**Architect · BA · QA · gap analysis · devil's advocate**) of the **animated-office/room** idea (DESIGN §9 Phase 1.5). Source-verifies the three reference tools (`pixel-agents` MIT, `my-virtual-office` AGPL+spawner, `claw3d`), and lands on **adopt-not-build, gated-behind-moat, read-only**. |
| [corpus-audit-2026-07-06.md](corpus-audit-2026-07-06.md) | **Full-corpus consistency audit** (self-contained for a context-free session). Stable finding register (**AMEND** unapplied amendments · **OPEN** unowned decisions · **LOST** dropped source material · **EMP** empirical gaps · **PROC** hygiene), a 33-decision ledger, the docs-site C1–C19 list, five senior-lens reviews incl. the **first-ever UX/UI pass**, and **10 ranked actions**. Headline: best-path §6 is still unapplied to the plan/TODO (AMEND-1…6). |
| [recovered-source-material.md](recovered-source-material.md) | **Recovered vendor material** (closes corpus-audit findings **LOST-1…4**): the **24-capability feature matrix** (v2 §12, verbatim ✓/~/✗ across all five rivals) re-framed as an agenthropic **UI checklist**; the **adjacent-tools** note (v2 §13 — Claude Code's stable OTel `query_source` = main/subagent/auxiliary signal, ccusage, LiteLLM, Anthropic Console); the **risk register** (v2 §16 — incl. **hook-schema-drift** M/H and the hoangsonww CLA note); and the **cost-of-ownership** developer-day sizing (v2 §17). Also pins **LOST-8**: the "no true DAG" quote is **not** in the sources — do not propagate. |
| [ux0-design.md](ux0-design.md) | **WP-UX0 design pre-work** (closes corpus-audit LOST-6 + §9.5 — the first UX/UI artifact): IA map, the five question-to-screen flows, ASCII wireframes for the four views, and the uncertainty/honesty visual language (inferred edges, estimated costs, `'unknown'` status always visible). |
| [open-decisions.md](open-decisions.md) | **The OPEN-1…9 decision register** — each unowned decision from the corpus audit with its recommended resolution, framed as sign-off checkboxes. Deciding them stays with Ivan. |
| [red-team-audit-2026-07-06.md](red-team-audit-2026-07-06.md) | **Deliberately adversarial counter-analysis** — attacks every premise (defused kill-condition, moat-on-rented-land, n=1 evidence, governance fiction, economics), records what survives (§9), and forces a choice between **three exits** (kill · brutal two-week timebox · status quo) with an explicit **stop condition on further analysis** (§11). Read *after* the corpus audit. |
| [roadmap-v1-v2-2026-07-06.md](roadmap-v1-v2-2026-07-06.md) | **The last analysis (#9 of 9) — schedule of record.** Authored on explicit owner instruction overriding red-team §11. Re-measured numbers (76 files · 141k words · 0 commits), three velocity scenarios against the 63-WP v1.0 path, **kill checkpoints KC-0…KC-5 with default-death**, the detailed phase-by-phase v1.0 roadmap (Exit B absorbed into Phase 0 inside CD-8, descope ladder, forbidden descopes), the earned-not-scheduled v2.0 alerts roadmap, and the **analysis freeze** — after it, only verdict records. |
| [phase0-verdict.md](phase0-verdict.md) | **Post-freeze verdict record #1 (the WP-S7 GO/NO-GO).** The Phase-0 feasibility spike (WP-S1…S7) executed end-to-end against a hostile 5-session / 224-agent corpus: verdict **`CONDITIONAL GO` ~90%** — the subagent DAG + dollar cost is mechanically reconstructable from `~/.claude/projects/*.jsonl` alone, zero inference. Six-row evidence table, the 11-item gate's final status, the three new parser MUSTs, the first velocity number, and what still needs Ivan. **All numbers are self-check / PROVISIONAL** until the five `LABEL-ME.md` trees are hand-filled. |
| [parser-spec.md](parser-spec.md) | **Post-freeze — the parser contract distilled from the verdict.** Normative, implementation-ready: the **14-item requirements gate** (original 11 + three MUSTs the spike found — `<task-notification>` flat join, `queue-operation` 3rd join schema, `message.id` usage dedup + bucket/model pricing), the four structural join paths, token→cost rules, the self-referential depth-2 tree index, the amended EMP-1 wave-partial ordering, and the exact site-doc edits to fold into the published pages. **Normative and IMPLEMENTED (2026-08-15)** — see its §3 for what is implemented (14 of 14) versus what the real corpus actually exercises (11; #11 amended, #7 and N1 witnessed only by fixtures). Also the **census of record** (§4.2) and the duplicate-session-uuid rule (§4.3). |
| [PROJECT-STATE-2026-07-06.md](PROJECT-STATE-2026-07-06.md) | **The entry point for a context-free session.** Navigation only — supersedes nothing: complete timeline 07-03→07-06, document map + authority order, current-truth snapshot (decided / unsigned / ruled-but-unapplied / open / stale), the pending decision funnel (Gate A · three exits · friction log · commit authorization), and per-request playbooks with the binding session rules. |

## The idea in one paragraph
A self-hosted, local-first cockpit for Claude Code agent/subagent activity on a Mac
Mini M4 — persisted subagent DAG + dollar-cost/delegation-savings + Telegram alerts +
owned persistence — differentiated from the 28.4k★ baseline (claude-code-templates) by
the four things it lacks, and from the whole field by a **loopback-only, no-spawner,
mandatory-token** security posture.

## The verdict in one sentence
**Build it** — the vision is A-grade and the security thinking is best-in-class — and
**v2 now resolves the three specification gaps that would otherwise have sunk it in code**
into the ten canonical decisions **CD-1…CD-10**: (1) ingest source-of-truth /
reconciliation → a single immutable substrate + deterministic projection contingent on the
Phase-0 spike; (2) licensing hygiene (cast/disler/nirdiamant are all-rights-reserved —
reimplement, don't copy) → a CI-enforced per-artifact rule; (3) scope discipline →
personal-first / commercial-clean, with the vector-DB leap carved to an experimental track.

## Delivery bar (Ivan's rules, folded into every phase)

**Test coverage (CI-gated)** · **README badges + donation** · **GitHub Pages docs site** —
while the app itself stays **loopback-only**.

> **Where the bar actually stands (2026-08-15).** The historical wording here was ">90%
> coverage, CI-gated". As shipped the threshold is **100%** for statements, branches,
> functions and lines in **all five packages**, and every one of them carries a static guard
> that fails if a `v8 ignore` / `c8 ignore` / `istanbul ignore` pragma appears in `src/` — so
> the figure cannot be bought back by removing code from the denominator. Four of the guards
> live in a file named `coverage-honesty.test.ts`; `apps/web`'s is the `coverage honesty`
> block of `test/honesty.test.tsx`. But **"CI-gated" is not the same as merge-blocking, and
> today nothing is merge-blocking**: branch protection on `main` is not enabled, so a red
> coverage run cannot physically stop a merge. Enabling it is an owner act, not a code task.
> The canonical version of this correction lives in
> [development-plan.md](development-plan.md) §2c, which also records the two other places
> the plan and the tree disagree.

---

_Reviews the design of record in `docs/ai/DESIGN.md` (internal design basis, kept local-only
— not published in this repo). **Implementation began on 2026-07-11 under an explicit owner
override of CD-8**, which had required Gate A to be signed and the `WP-S7` verdict to read
GO before any production code. The override covers **dispatching only**: it relaxes no
security invariant, signs no Gate A, ratifies no `LABEL-ME` numbers (they remain
PROVISIONAL) and does not authorise a commit or push without an explicit ask. Everything in
this corpus written in the future tense about "when code starts" is describing a gate that
opened on 2026-07-11._
