# Documentation-corpus audit — 2026-07-06

**Status:** Findings and recommendations only. Nothing in this file changes the plan of
record, approves a decision, or authorizes code. Gate A (Ivan's approval of CD-1…CD-10 +
LB1/LB2 in `TODO.md`) is still unsigned as of this writing.

**Audience:** a future agent session — any model, including Opus-class — picking up this
project with **zero conversational context**. Everything needed to understand and act on
the findings is spelled out here. Read §0 first; it defines every term and rule you need.

**Produced by:** the 2026-07-06 analysis session (Claude Fable 5). Method in §3.

> **Read this before acting on §0 (amendment, 2026-08-15).** This audit was written for a
> context-free session and its §0 doubles as an operating brief, so two of its rules have
> to be corrected here rather than left to be discovered. **The code exists.**
> Implementation began on **2026-07-11** under an explicit owner override of CD-8, so §0.1's
> "only documentation — zero application code" and §0.3's rule 4 ("no production code, no
> scaffolding until Gate A is signed **and** WP-S7 reads GO") describe a gate that has been
> opened. Gate A itself is **partially signed** as of 2026-07-10 — the three decision boxes
> are signed, the two physical acts are not — so the front-matter's "still unsigned" is half
> stale and half still true. A session reading rule 4 today should not refuse to work; it
> should know that the override covered **dispatching only** and relaxed nothing else — not
> a security invariant, not the `LABEL-ME` ratification (all Phase-0 numbers remain
> PROVISIONAL), and not the commit rule.
>
> Rule 2's parenthetical is also stale: `docs/` is no longer untracked. The
> rule it decorates — never commit or push without an explicit ask — is unchanged and
> still binding, as are all of §0.3's security invariants in rule 5, which the built system
> implements rather than merely promises.
>
> Everything else in §0 remains the correct orientation, and the finding registers below
> are preserved as written. Where a specific finding has since been overtaken, it is noted
> in place; where it has not, silence means it is still open. The current-truth snapshot
> for a fresh session lives in the project-state record, not here.

---

## 0. How to use this document

### 0.1 What this project is (three sentences)

**agenthropic** is a planned self-hosted, local-first dashboard for observing Claude Code
agent/subagent activity on Ivan's Mac Mini M4 — persisted subagent DAG, dollar-accurate
cost, Telegram alerts. It is a **greenfield** build (decided over forking any of six
audited rival dashboards). As of 2026-07-06 the repository contains **only documentation —
zero application code** — by design: canonical decision CD-8 forbids production code until
the Phase-0 feasibility spike returns GO.

### 0.2 Terminology (do not guess — these are project-specific)

| Term | Meaning |
|---|---|
| **CD-1…CD-10** | The ten canonical decisions, resolved in `docs/analysis/concept-analysis-v2.md` §3. |
| **LB1 / LB2** | The two load-bearing decisions: LB1 = ingest primacy (JSONL-primary, contingent on Phase 0); LB2 = personal-first / commercial-clean identity. |
| **WP-xx** | Work package in `docs/analysis/development-plan.md` (75 WPs, 8 tracks: S spike · F foundation · D data · IN ingest · C cost · U realtime/UI · A alerts · X delivery). |
| **DOC-xx** | Documentation work package in `docs/DOCS-PLAN.md` (33 WPs, 6 tracks P/O/A/S/C/U). |
| **Gate A** | Ivan's formal sign-off on CD-1…CD-10 + LB1/LB2. **Unsigned.** Until signed, the entire plan is recommendation-only. |
| **WP-S7 / GO** | The Phase-0 spike's final GO / CONDITIONAL-GO / NO-GO verdict. Gates `WP-F1` (the first scaffold WP) — i.e. gates *all* production code. |
| **The probe** | `docs/analysis/phase0-probe.md` — a 2026-07-04 read-only empirical probe of the real `~/.claude/projects` corpus that pre-answered CD-1 with `CONDITIONAL-GO → build`, confidence 85. It **de-risks but does not replace** the formal spike. |
| **Best-path memo** | `docs/analysis/best-path-decision.md` — the strategic memo that sits **above** the development plan. Its §6 lists plan amendments that were **never applied** (finding AMEND-1…6). |
| **The moat** | Per the best-path memo: **persistent cross-session DAG + dollar-cost attribution — only these two.** (Older docs and the public site say four or five features; see finding LEDGER-23.) |
| **P0 tests** | Three merge-blocking release tests: (1) Σ tokens == JSONL exact; (2) double replay produces a byte-identical DB; (3) DAG rebuilt from JSONL alone. |
| **events_raw** | The immutable append-only ingest substrate (CD-2). Everything else (sessions, agents, edges, token_usage) is a deterministic, replayable projection. |
| **OPCⁿ** | An undefined token inherited from the vendor documents. Nobody has ever defined it. Flagged "define-or-drop" since v2 §7; still open (OPEN-9). |
| **The five daily questions** | The MVP requirement set (CD-10): what is running now · where did tokens/money go · what did session X spawn and why · what failed/stuck · what changed across sessions. Target: answerable in <30 s. |

### 0.3 Binding rules for any session acting on this document

These come from `CLAUDE.md` (root + project) and are **not optional**:

1. Chat with Ivan is **Bulgarian**; everything written into the repo is **English**.
2. **Never commit or push without an explicit ask.** All of `docs/` is currently untracked.
3. AI-harness files (`CLAUDE.md`, `WORKLOG.md`, `.claude/`, `docs/ai/`, `*.docx`) are
   git-excluded via `.git/info/exclude` and never enter commits or PRs.
4. **No production code, no scaffolding** (`package.json`, `src/`, workspaces) until
   Gate A is signed **and** WP-S7 reads GO. This audit does not change that.
5. Security invariants are non-negotiable and appear in every layer: loopback-only bind,
   no browser-driven subprocess/`claude` spawner, mandatory `DASHBOARD_TOKEN` with
   `timingSafeEqual` (fail startup if unset), same-origin realtime stream (SSE per CD-5),
   no SSRF, tunnel-only remote access, SQLite WAL + tested backups, token counts read
   from `~/.claude/projects/*.jsonl` — never inferred.
6. Append a `WORKLOG.md` entry (English) per meaningful task.

---

## 1. Corpus inventory

| Layer | Files | Git status | Role |
|---|---|---|---|
| Sources | 4 `.docx` under `due-diligence/` (vendor due-diligence v1 + v2; ideen-doklad base + EXPANDED) | excluded | Externally produced inputs. The two families sit on **opposite sides** of the digests: the vendor docx are upstream of `DESIGN.md`; the ideen-doklad docx are **downstream** (they cite DESIGN.md as input). |
| Digests | `docs/ai/DESIGN.md` · `docs/independent-due-diligence.md` | excluded / tracked-eligible | Design basis + the audit that overturned the vendor recommendation. |
| Dossier | `docs/due-diligence/` — 6 modules + 6 per-project deep dives | tracked-eligible | file:line evidence for every rival grade (simple10 A−, hoangsonww B−, nirdiamant C+, cast C, disler C−, claude-code-templates C). |
| Analysis chain | `docs/analysis/`: concept-analysis (v1) → external-docs-review → **concept-analysis-v2** → development-plan → **best-path-decision** → **phase0-probe** (+ animated-room-analysis, README) | tracked-eligible | The decision spine. |
| Trackers | `TODO.md` · `DONE.md` · `WORKLOG.md` (excluded) | mixed | Live state. Gate A lives at the top of `TODO.md`. |
| Public site | `docs/site/` — 44 pages, 13 ADRs, 603 internal links, 0 broken | tracked-eligible | The only public surface (app itself is loopback-only). |
| Docs plan | `docs/DOCS-PLAN.md` | tracked-eligible | 33-WP decomposition of the site. |

## 2. The precedence chain — the single most important fact in this repo

When two documents disagree, resolve in this order (newest evidence wins):

```
1. docs/analysis/phase0-probe.md        (empirical measurements, 2026-07-04)
2. docs/analysis/best-path-decision.md  §6 (strategy memo — "sits above the plan")
3. docs/analysis/concept-analysis-v2.md (CD-1…CD-10, LB1/LB2)
4. docs/analysis/development-plan.md    (75-WP decomposition)
5. TODO.md                              (live tracker)
```

`docs/ai/DESIGN.md` is the design basis. The probe-§8 amendment order against it **was
executed on 2026-07-06** by a 50-agent propagation workflow (see the `DONE.md` entry
"Propagated the four empirical CD-1 corrections") — spawn-tool keying, layout mechanism,
outbox demotion and the CD-1 verdict are now consistent corpus-wide (spot-verified by
this audit: the only remaining `Task` mentions in DESIGN.md, WP-IN8 and `docs/site/` are
correction statements). **The best-path §6 amendments (AMEND-1…6) were NOT part of that
propagation and remain unapplied.**

**Why this matters:** layers 4 and 5 are approximately six amendments behind layer 2
(see AMEND-1…6). A reader who takes `development-plan.md` or `TODO.md` literally will
build the wrong v1.0 (alerts on the critical path, vector-DB stub included, dual SQLite
driver, unslimmed spike).

## 3. Method

- All ten load-bearing strategy/decision documents were read in full, first-hand:
  DESIGN.md, concept-analysis v1 + v2, implementation-plan, development-plan,
  best-path-decision, phase0-probe, independent-due-diligence, DOCS-PLAN,
  TODO/DONE/README.
- Three parallel deep sweeps were run by subagents:
  1. **docs/site digest** — all 44 pages read; 19 cross-page inconsistencies catalogued
     (§6, C1–C19); every page checked against the seven security/design invariants
     (result: zero violations).
  2. **Source-vs-digest audit** — all four `.docx` extracted via `textutil` and diffed
     against the digests (Appendix A).
  3. **Cross-consistency ledger** — 25 analysis/dossier/tracker files cross-checked into
     a 33-decision ledger with staleness and orphan registers (§5, Appendix B).

## 4. Finding register

Each finding: **statement · evidence · impact · fix**. IDs are stable — cite them in
future WORKLOG entries when resolving.

### 4.1 AMEND — decided amendments never applied to the plan of record

The best-path memo states "the plan is being amended to match (see §6)". **That amendment
never happened.** These six findings are the single largest consistency debt in the repo.

- **AMEND-1 — v1.0 scope: no alerts.** best-path §6.1 rules v1.0 = DAG + cost cockpit,
  alerts off the critical path. `development-plan.md`'s critical path still terminates in
  A5→A8→A9→A10 (alerts), and `TODO.md` Phases 5–6 still stage the full alerting stack as
  v1.0 work. *Fix:* re-annotate the critical path; mark Phases 5–6 as post-1.0.
- **AMEND-2 — cut WP-A8/WP-A9 (alerts CRUD API/UI), keep A10.** best-path §6.2. Both WPs
  still listed as deliverables with exit gates in dev-plan Phase 6 and TODO Phase 6.
- **AMEND-3 — delete WP-X11 (vector-DB stub) entirely.** best-path §6.3. TODO Phase 1
  still schedules X11; `docs/DOCS-PLAN.md` §5 — written *after* the memo — explicitly says
  "WP-X11 stays", directly contradicting it. *Fix:* delete from both, plus the DOCS-PLAN
  reconciliation note.
- **AMEND-4 — single SQLite driver (better-sqlite3 only), Node 22 pinned.** best-path
  §6.3. dev-plan WP-D2 still says "dual-driver"; CD-9's copy-list still names hoangsonww's
  "dual-sqlite driver" as a copyable artifact. *Fix:* amend WP-D2 text and strike the CD-9
  line item.
- **AMEND-5 — slim WP-S1 (drop the throwaway-hook block from the gating path), demote
  WP-S4 to liveness-only.** best-path §6.6. TODO still runs both at full scope, and WP-S1
  at full scope gates everything in wave 2+.
- **AMEND-6 — add `packages/core` (server/web-import-free) to the scaffold.** best-path
  §6.7. No scaffold WP mentions it; WP-F1's layout predates the memo. Cheap now,
  expensive after scaffold.
- **AMEND-7 — DESIGN.md amendment ordered by probe §8 — ✅ RESOLVED 2026-07-06.** The
  probe proved: spawn tool is **`Agent`/`Workflow`, never `Task`** (0 `Task` blocks — a
  `Task`-keyed parser builds an **empty DAG**); layout is spawn-mechanism-driven (flat
  `agent-*.jsonl` for `Agent`, nested `workflows/wf_*/` for `Workflow` — 85.2% of agent
  files nested), not CC-version-driven. A 50-agent propagation workflow applied this
  (plus the outbox demotion and the CD-1 verdict) across DESIGN.md, WP-IN8 and all of
  `docs/site/` on 2026-07-06 (`DONE.md` entry), with an adversarial residual sweep
  reporting zero misses — independently spot-verified by this audit (every remaining
  `Task` hit is a correction statement). Kept in the register as the **one worked example
  of precedence being materialized correctly**; AMEND-1…6 still await the same treatment.

### 4.2 OPEN — decisions with no owner and no WP

- **OPEN-1 — Retention TTL vs `events_raw` immutability.** ADR-0004/0006/0009 enforce
  no-UPDATE/no-DELETE on `events_raw` by trigger + test; ADR-0012/WP-D10 mandate a
  retention TTL sweeper. Flagged open in `architecture/data-model.md` and
  `operations/backup-restore.md` §4; resolved nowhere. This is a genuine design collision
  that will surface as a red build in Track D. *Recommended resolution (architect lens,
  §9.2): retention deletes projections only; `events_raw` ages out by segment archival
  (file-level detach), never row DML — preserving the triggers and the replay P0 test.*
- **OPEN-2 — `'unknown'` missing from `agents.status` CHECK.** The reference DDL
  (data-model.md, glossary.md, ADR-0006) allows `('working','waiting','completed','error')`,
  but WP-IN12's missing-Stop watchdog assigns `'unknown'`. Self-flagged in three pages,
  fixed in none. Also an unanswered follow-up: the unknown→revert rule (v2 §7 q5).
- **OPEN-3 — Redaction phase drift.** ADR-0012 says "retention TTL + payload redaction
  **from Phase 1**"; `operations/backup-restore.md` §5 wires the redactor at WP-IN14 with
  a **Phase-2** exit criterion. Pick one.
- **OPEN-4 — Browser token transport (header vs cookie vs query).** `security/remote-access.md`
  defers to `security/model.md`, which also doesn't decide it. Security-sensitive,
  circular, unowned.
- **OPEN-5 — Hook-POST auth mechanism.** The invariant (authed) is decided; the mechanism
  (shared token vs socket peer creds) is question 8 in three architecture pages, while
  `architecture/hooks.md` prose reads as if already settled.
- **OPEN-6 — Pricing data source** (v2 §7). `model_pricing` is versioned and CI-gated
  (no-price-row fails CI) but nobody chose where prices come from or how `verified_on`
  gets refreshed.
- **OPEN-7 — App port number** and where it is configured (remote-access.md flags it).
- **OPEN-8 — Coverage boundary: ">90%" vs "≥90%".** ADR-0009 contradicts **itself**
  (Decision says ">90%", Acceptance says "blocks merges below 90%", i.e. ≥90 passes).
  It's the merge gate — the exact boundary matters. Pick ≥90% once, sweep all pages.
- **OPEN-9 — "OPCⁿ"** — define or drop (ADR-0002 left it open; used in two live docs).

> **Status of this register on 2026-08-15.** The nine OPEN items were lifted out of this
> audit into [open-decisions.md](open-decisions.md), which is now where their current state
> is maintained; read that file rather than this list when you need to act on one. Most of
> them have since been **answered by implementation** — the code picked a transport, a port,
> a hook-auth mechanism, a status vocabulary and a coverage threshold — but answered by
> implementation is not the same as decided, and none of the sign-off boxes in
> `open-decisions.md` has been ticked. Two of the items above are also wrong as stated and
> are corrected there: **OPEN-6** rests on a `verified_on` column that does not exist in the
> shipped `model_pricing` table, and **OPEN-8**'s premise (a boundary between ">90%" and
> "≥90%") was overtaken by a 100% threshold — while its "blocks merges" clause turned out
> to be the unexamined half, and is still false because branch protection is not enabled.
> **OPEN-1** (retention) and **OPEN-9** (OPCⁿ) remain open in the plain sense: undecided,
> unowned, and now with more surface area than they had here.

### 4.3 LOST — substantive source content that never reached the plan of record

From the source-vs-digest audit (full detail in Appendix A):

- **LOST-1 — Vendor v2 §12: the 24-capability feature matrix** (✓/~/✗ across all rivals:
  cache-token accounting, compaction-aware totals, token-burn/quota window, live activity
  pulse, transcript replay, snapshot/restore…). The closest thing to a target-feature
  checklist for agenthropic's own UI. Dropped entirely.
- **LOST-2 — Vendor v2 §13: adjacent tools.** Notably: Claude Code emits a **stable
  OpenTelemetry span schema with `query_source` = main/subagent/auxiliary** — directly
  relevant to ingest strategy as a corroborating (or fallback) signal; plus LiteLLM
  gateway, claude-token-lens, Anthropic Console/Analytics API.
- **LOST-3 — Vendor v2 §16 risk register**, esp. **"Claude Code hook-schema drift"
  (M/H)** — a live risk for the greenfield build too (the parser reads undocumented
  internals across 7 observed CC versions) — and the hoangsonww **CLA relicensing** note.
- **LOST-4 — Vendor v2 §17 cost-of-ownership sizing** (developer-day estimates). The
  roadmap kept the phases and dropped all effort numbers.
- **LOST-5 — EXPANDED §3: FR-01…FR-10 / NFR catalogue** — incl. **PRIV-01** (payload
  redaction) and **PERF-01** (render 500+ events / 50+ agents). Partially absorbed into
  CDs; never as testable requirements with IDs.
- **LOST-6 — EXPANDED §15: the 7-screen UX model + the honest-uncertainty principle**
  (inferred edges and estimated costs must be visibly labelled; unknown model ⇒
  "estimated", never a silent zero). **The project's best UX thinking lives only in a
  git-excluded docx.** See §9.5.
- **LOST-7 — EXPANDED §7.1: the 10-scenario negative-test catalogue** (SubagentStop
  before Start → anomaly flag; orphan → pending-reparent, no silent fake root;
  timing-attack attempt; huge payload; restart mid-session…). `contributing/testing.md`
  admits its 12-scenario gate does not reproduce them. Recovering them is ~30 minutes.
- **LOST-8 — The "no true DAG" nuance.** The quote the independent audit attributes to
  the vendor is **not verbatim in either docx**. The vendor scores simple10 "~" (partial)
  on "Orchestration DAG / graph" and 3-vs-5 on visualization. The audit's core argument
  (the tie-break is contestable; the vendor's own weighted model ranks simple10 first,
  4.1 vs 4.0) **stands** — but the characterization "factual error" is stronger than the
  source warrants. Since the greenfield decision leans on this audit, soften the wording
  to "contestable judgment call" in `docs/independent-due-diligence.md` §0 and DESIGN §0.
  Related: DESIGN §0's claim that greenfield is "reinforced, not weakened, by the
  independent audit" overstates — the audit recommended *forking simple10*, and vendor v1's
  explicit "building from scratch is not justified" argument is never rebutted anywhere.

### 4.4 EMP — empirical gaps

- **EMP-1 — Intra-workflow edge ordering is unproven.** Reconstruction via
  `journal.jsonl` + `promptId` is item 11 of the probe's parser gate but was never
  demonstrated. P0 test #3 ("DAG rebuilt from JSONL alone") **depends on it**. No WP owns
  proving it before Phase 3 relies on it. *Fix:* add it to the formal spike (WP-S5 scope).
- **EMP-2 — Depth-2 evidence is thin.** The 100% depth-2 recovery claim rests on 6 edges.
  The formal spike's paired-capture corpus (WP-S1) must include deep nesting on purpose.
- **EMP-3 — The kill-condition is formally undecidable.** best-path §7/§9 defined it as:
  kill if the 2-week baseline-friction log (using `claude-code-templates --analytics`) is
  empty AND the probe is messy. The probe half resolved favorably; **the friction log was
  never started, scheduled, or closed out.** Either run it (passive, near-zero effort) or
  record explicitly that the probe's strength (confidence 85) retires it. The dangling
  state is the worst option.

### 4.5 PROC — process and hygiene

- **PROC-1 — Root `README.md` is stale on three counts:** (a) "ingests Claude Code
  lifecycle hooks into SQLite" — CD-1 inverted this to JSONL-primary with hooks as
  liveness; (b) "stack and structure are being decided" — the stack is effectively decided
  (Fastify + TypeBox, better-sqlite3 single driver, React/Vite/D3, pnpm, Node 22), pending
  only Gate-A signature; (c) no mention that a plan of record and a 44-page docs corpus
  exist.
- **PROC-2 — Project `CLAUDE.md` lags the decision chain:** still says "stack & repo
  structure are an open decision — do not scaffold" (the *do-not-scaffold* half is still
  correct; the *open-decision* half is not) and "same-origin check on the **WebSocket**"
  (canonical transport is **SSE** per CD-5/ADR-0007). Every future session reads this
  file first — it is actively misleading agents.
- **PROC-3 — `DONE.md` is missing the docs-site milestone** (2026-07-04: 22 pages + 13
  ADRs authored by a 22-writer/22-reviewer fan-out, 44 pages / 603 links / 0 broken —
  recorded only in DOCS-PLAN's status block and WORKLOG). The stated convention
  ("completed milestones move to DONE.md") is broken for the largest artifact since the
  probe.
- **PROC-4 — No `LICENSE` file.** `contributing/licensing.md` asserts "the project's own
  MIT posture" and applies Berne-convention logic to rivals (no LICENSE file ⇒
  all-rights-reserved ⇒ clean-room only). By its own logic, **agenthropic itself is
  currently all-rights-reserved.** The LB2 commercial-clean hedge is void until a LICENSE
  lands.
- **PROC-5 — Governance artifacts unowned.** SECURITY.md, CODE_OF_CONDUCT.md, issue/PR
  templates are described in `contributing/governance.md` but exist nowhere and no WP
  owns creating them ("natural fit alongside WP-X6/X9" is a suggestion, not an
  assignment).
- **PROC-6 — Two live phase vocabularies.** Old scheme (DESIGN §9 / implementation-plan:
  P2 = Telegram, P4 = global DAG) vs new scheme (development-plan: Phase 5 = alerts).
  `animated-room-analysis.md` gates itself on the old numbering — its "not before
  Phase 2, ideally after Phase 4" now silently means something different. Any doc that
  says "Phase N" without naming the scheme is ambiguous.
- **PROC-7 — Dossier files carry no supersession banners.** `docs/due-diligence/README.md`
  and `recommendation.md` still instruct "fork simple10, graft cast analytics.ts
  ~50 LOC" — dead advice twice over (greenfield per best-path; cast is clean-room-only
  per CD-9). A reader entering the corpus through the dossier gets obsolete instructions
  with no pointer forward.

## 5. Decision ledger — status summary

Full 33-decision ledger was compiled; below, everything not simply **OK**. ("OK" =
consistent everywhere: security posture — the single most consistent decision in the
corpus — SSE transport in the analysis chain, React/Vite/D3, Fastify+TypeBox, scope/five
questions, secrets handling, per-artifact licensing rule, pricing structure, gate
discipline, token ground truth.)

| Decision | Status | Where it stands |
|---|---|---|
| v1.0 contents / critical path | **CONTRADICTED** | best-path (no alerts) vs dev-plan/TODO (alerts in). AMEND-1/2. |
| Vector-DB WP-X11 | **CONTRADICTED ×3** | best-path deletes; TODO schedules; DOCS-PLAN §5 blesses. AMEND-3. |
| SQLite driver | **CONTRADICTED** | best-path: single; WP-D2 + CD-9 copy-list: dual. AMEND-4. |
| WP-S1 scope / WP-S4 demotion | **CONTRADICTED** | best-path §6.6 vs TODO full-scope. AMEND-5. |
| Spawn-tool keying (`Agent`/`Workflow`) | **RESOLVED 2026-07-06** | Probe proved it; the 50-agent propagation carried it into DESIGN + WP-IN8 + the whole site. AMEND-7. |
| Monorepo layout | **SUPERSEDED, unconsolidated** | v1 `packages/*` → v2 `apps/*` → +`packages/core` (§6.7). No single doc states the final layout: `apps/server`, `apps/web`, `packages/shared`, `packages/core`, `packages/test-fixtures`, `hooks/`. |
| Durable outbox WP-IN11 | **SUPERSEDED cleanly** | Probe: YAGNI-leaning, deferrable; TODO annotated correctly; dev-plan body text unamended. |
| Moat definition | **CONTRADICTED in framing** | Dossier/site: 4–5 features incl. alerting; best-path: **2** (persistent DAG + dollar cost). Public positioning and build strategy tell different stories. LEDGER-23. |
| Fleet status | **INCONSISTENT ×3** | roadmap "future decision" vs the-moat "not scheduled" vs faq "is scheduled". Canonical: deferred until a second host exists (ADR-0002/0012). |
| Docs generator | **INTERNALLY INCONSISTENT** | DOC-P1 marked deferred, yet `adr-docs-site-generator` (ADR-0013) exists and content lives at `docs/site/` (a path neither DOC-P1 option names). |
| Ingest primacy (LB1/CD-1) | **OK in chain; STALE-TEXT in README** | Root README still hooks-primary. PROC-1. |
| Transport SSE (CD-5) | **OK in chain; residual WS wording** | project CLAUDE.md + three site diagrams still say WebSocket/"WS/SSE". PROC-2, C3. |

## 6. docs/site cross-page inconsistencies (C1–C19)

All 44 pages respect the seven invariants — **zero violations**; two pages even
strengthen them (auth on *all* endpoints including reads; restore-drill instance also
loopback+token). The 19 real inconsistencies:

| ID | Issue | Pages |
|---|---|---|
| C1 | Fleet status in three versions | roadmap / the-moat / faq (+ "Phase 5+" citations blur deferred→scheduled) |
| C2 | Fastify asserted as fact while stack is formally a leaning — the only style-guide violation in the corpus | architecture/hooks.md, security/model.md (vs overview, what-is, contributing/index) |
| C3 | Residual "WebSocket/SSE" wording vs canonical SSE | what-is (diagram), overview (own diagram), threat-model (diagram+prose) |
| C4 | 12 hooks listed unhedged; everywhere else hedged 12-assumed/9-documented (SubagentStart, PermissionRequest, PostToolUseFailure unconfirmed) | guide/what-is-agenthropic.md |
| C5 | `agents.status` CHECK lacks `'unknown'`; WP-IN12 assigns it (= OPEN-2) | data-model, glossary, ADR-0006 vs troubleshooting |
| C6 | TTL sweeper vs no-DELETE triggers (= OPEN-1) | ADR-0004/0006/0009 vs ADR-0012/WP-D10 |
| C7 | Redaction Phase 1 vs Phase 2 (= OPEN-3) | ADR-0012 vs backup-restore §5 |
| C8 | ">90%" vs "≥90%" coverage; ADR-0009 self-contradicts (= OPEN-8) | testing, model.md, ADR-0001/0004/0009 vs contributing/index, governance |
| C9 | Illustrative DDL drifts across three pages (compaction column ×3 names; `model` vs `model_id`; PK types) | data-model vs cost-model vs ADR-0006 |
| C10 | hoangsonww DAG described oppositely | comparison ("persisted parent_agent_id") vs the-moat ("never persisted") |
| C11 | Telegram phase: DESIGN §9 says 2, plan says 5 | flagged in overview/data-model, unresolved at source |
| C12 | Delegation-savings: DESIGN §9 Phase 4 vs plan Phase 3 | cost-model, glossary |
| C13 | Hook-POST auth settled-in-prose, open-in-question-list (= OPEN-5) | hooks.md vs its own open questions |
| C14 | "Four non-negotiable constraints" vs nine-rule catalogue, no mapping | threat-model vs model.md |
| C15 | "Four things it lacks" vs "five capabilities absent" in one page | what-is-agenthropic.md |
| C16 | Project license absent while licensing posture asserted (= PROC-4) | licensing.md vs governance.md |
| C17 | Circular deferral on token transport (= OPEN-4) | remote-access ↔ model.md |
| C18 | App port uncommitted; tunnel examples have nothing to bind to (= OPEN-7) | remote-access, comparison |
| C19 | Port name `TokenReader` vs `TokenSource` never picked | ADR-0008 |

Cheapest high-value fixes: C1, C3, C4, C8, C10, C16.

## 7. Holistic analysis

The project is an **inverted pyramid: a large, high-quality documentation mass on top of
zero code** — intentional (CD-8), but producing three systemic effects:

1. **The only real blockers are human, not technical.** Everything funnels into two
   actions by Ivan: signing Gate A, and running the formal Phase-0 spike (S1, S4–S7;
   S2/S3 pre-answered by the probe). More documentation moves nothing.
2. **Entropy grows with every document written from unamended sources — and shrinks only
   when precedence is materialized as edits.** The 44-page site inherited the unverified
   hook catalog and pre-probe wording because it was authored before DESIGN.md was
   amended; the 2026-07-06 propagation then had to sweep ~24 documents to fix what one
   timely edit would have prevented. AMEND-1…6 are still accruing the same debt.
3. **The public story and the strategy have split.** The site markets a 4–5-feature moat
   including Telegram alerting; the ruling memo narrows the moat to two features and
   pushes alerting past 1.0. Read literally, dev-plan/TODO re-inflate the MVP.

Counterweights, equally real: the security core is remarkably coherent at every layer
(zero invariant violations across ~70 files); data-as-truth (JSONL ground truth,
persisted edges, tokens × dated price) runs unbroken through all layers; process hygiene
(WORKLOG, git-exclusions, no attribution, no unasked commits) has been followed
flawlessly; and the corpus is unusually self-aware — most defects found by this audit
were already self-flagged in-page, just never resolved.

> **The pyramid is no longer inverted (note added 2026-08-15).** Code exists — a little
> over 17,000 lines with 106 test files beside it — so the structural diagnosis that opens
> this section has expired. Two of the three systemic effects it predicted did not survive
> contact with the build, and one did. Effect 1 is the one that survived, and it survived
> exactly: the remaining blockers are still human. The spike ran and returned CONDITIONAL
> GO, Gate A is still only partially signed, and the items nobody but Ivan can perform —
> hand-labelling the `LABEL-ME` corpus, running the friction log, enabling branch
> protection — are still the whole of what is outstanding. Effect 2 has reversed direction:
> the code is now the amending authority, and documentation that disagrees with it is what
> gets corrected, which is why this note exists. Effect 3, the split between the public
> story and the strategy, is best judged against the site as it stands today rather than
> against this paragraph's 2026-07-06 reading of it.
>
> The counterweights held. The security invariants are implemented, not merely written
> down; ground truth is still read from the JSONL and never inferred; and the corpus's
> habit of flagging its own defects in-page is the reason a build could be reconciled
> against it at all.

## 8. Business analysis

- **Market.** The vendor's "no tool exists" thesis is false as written (claude-code-templates
  28.4k★, claude-hud 26.1k★, ccusage 16.8k★ — all free). It survives only narrowed:
  **nobody persists a per-instance DAG with long-horizon history and dollar attribution;
  all rivals derive edges at render time.** That is a real, narrow, defensible moat — with
  a real cost: it rests on undocumented, churning Anthropic internals (7 CC versions in
  the observed corpus; the layout mechanism already changed once).
- **Customer.** One user: Ivan (LB2 admits this honestly). Value = the five daily
  questions in <30 s + real dollars at Max-20x usage + delegation savings. The best-path
  memo's honest dissent (cost tracking is free elsewhere; opportunity cost vs
  kiko/servicenow-mcp) was never answered — the friction log was the designed answer and
  was never run (EMP-3).
- **Scale vs capacity.** 75 WPs + ≥90% coverage from commit one + 13 ADRs + 44 doc pages
  is team-grade process serving a solo owner. best-path §6 made the right cut (~15% of
  WPs, alerting off the critical path) — but the cut never landed (AMEND-1…6), so the
  project's nominal scope today is still the uncut one. Applying §6 is the highest-ROI
  single action in the backlog.
- **Commercial hedge.** LB2 is cheap and well-designed (MIT-clean code, `host_id` in the
  first migration, no RBAC) — and literally void until a LICENSE file exists (PROC-4).

> **Two of these four have moved (note added 2026-08-15).** The commercial hedge is no
> longer void: an MIT `LICENSE` sits at the repository root, closing PROC-4. The coverage
> figure in *scale vs capacity* is now 100% rather than ≥90%, which makes the paragraph's
> point about team-grade process serving a solo owner stronger, not weaker. The *customer*
> paragraph is untouched by anything that has been built: the friction log was still never
> run, the dissent is still unanswered, and the "<30 s" figure in the value proposition
> has **never been measured** — it is an exit gate that has been neither passed nor failed,
> because nobody has timed it. The *market* paragraph's warning about churning Anthropic
> internals is the one to keep watching; the parser now defends against layouts it has
> never seen in the wild, which is preparation, not evidence.

## 9. Senior-lens reviews

### 9.1 Business analyst

The five daily questions (CD-10) are the real functional requirements and they are good:
user-phrased, measurable, with a numeric target (<30 s). The quantified acceptance
criteria (hierarchy ≥95%, zero lost raw events, Σ tokens exact) are rare quality for a
pre-code project. What's missing: a formal FR/NFR layer in the plan of record (EXPANDED
§3 had FR-01…10 + NFRs incl. PRIV-01/PERF-01; never transplanted — LOST-5), personas/JTBD
(same), and **upward traceability** — no definition of how anyone will know the dashboard
actually saves time post-launch. Cheapest fix: add the FR/NFR IDs as a column to the
existing CD table, and let the friction log double as the baseline measurement.

### 9.2 Architect

The spine is right: `events_raw` (append-only, idempotency-keyed) + deterministic
projection is event-sourcing-lite at exactly the right weight; persisted
`orchestration_edges` with `derived_from_event_id` makes the moat auditable; nine named
ports keep the core testable; SSE is the correct transport for a one-way stream.

Four real concerns, in pain order:

1. **OPEN-1 (TTL vs immutability) must be resolved before Track D.** Recommended:
   retention deletes projections only; `events_raw` ages out via segment-level archival
   (detach a closed period into an archive file; deletion is a file operation, not row
   DML) — the no-UPDATE/DELETE triggers and the replay P0 test survive intact.
2. **The reference DDL lives in three diverging versions** (C9). One source file, quoted
   not paraphrased by other pages, owned by Track D.
3. **The parser is the project's real architecture.** The probe's 11-item gate *is* the
   spec: two join schemas, two layouts (flat/nested), self-referential parent index,
   child-transcript token summation (parent rollup ≈0% — any "easy" implementation that
   reads the root transcript is silently wrong), compaction resets (63/117 sessions),
   concurrent same-slug sessions (92/117). It deserves its own module with a versioned
   payload contract and per-CC-version fixtures; the lost hook-schema-drift risk (LOST-3)
   re-enters DESIGN right here.
4. **`packages/core` has no owner** (AMEND-6). Add it to WP-F1 before scaffold; it is
   expensive to retrofit.

### 9.3 Developer

The stack is effectively decided — Fastify + TypeBox, better-sqlite3 (single driver),
React/Vite/D3, pnpm, Node 22 — and `CLAUDE.md` should stop calling it open (PROC-2),
because every agent session reads that file first. The final monorepo layout has never
been consolidated into one sentence anywhere (see ledger row); writing that paragraph is
high-value.

Practical risks from the implementer's chair: (1) the hardest module is the JSONL parser,
not the UI — 85% of agent files are nested and the 11-item gate should become literally
the skeleton of the first test suite (WP-S5); (2) one-WP-one-PR across 75 WPs is heavy
for a solo owner — after applying §6, merge mechanical WPs into wave-sized PR series
(e.g. D5–D8); (3) coverage-from-commit-one means WP-F3 (the harness) must genuinely land
first or early PRs lie; pick ≥90% vs >90% once (OPEN-8); (4) two site pages already
promise concrete paths (`apps/server/src/security/token-guard.ts`) — at scaffold time,
either honor them or fix the pages.

### 9.4 QA

On paper the strategy is above standard: three P0 release blockers, a three-tier golden
corpus (raw/redacted/manifested) with four pathologies, QA stop-the-release authority,
tested restore per release candidate. The gaps:

- The 12-scenario negative catalogue is **not fully specified** — the 10
  externally-sourced scenarios (LOST-7) exist only in a git-excluded docx. Recover them.
- **P0 test #3 stands on an unproven premise** (EMP-1). QA should demand the
  intra-workflow proof as a Phase-0 addition, not discover it in Phase 3.
- **The fixture redaction rule is undefined** — the golden corpus will be built from
  Ivan's real sessions (real paths, names, potentially secrets) with a public repo on the
  horizon. Privacy gap.
- Keep the Ivan-in-the-loop gates (S1 labeling, S5 tree sign-off) — the cheapest
  ground-truth mechanism in the plan; do not optimize them away while slimming S1
  (AMEND-5).

### 9.5 UX/UI designer — the lens that had never been run

Measurably the emptiest zone of the corpus: across ~70 files there are **zero wireframes,
zero user flows, zero information architecture, zero visual language.** Everything that
exists on the topic: the five questions + <30 s target (CD-10), the `usage/dashboard.md`
stub, four view names (WP-U6…U9) — and, only in the git-excluded EXPANDED docx, the
7-screen UX model (§15), the honest-uncertainty principle, and PERF-01 (LOST-6). **The
project's best UX thinking is buried in a file agents cannot see.**

What is concretely missing, by weight:

1. **A visual language for uncertainty and status.** Uniquely among rivals, this product
   ingests from two reconciled sources: edges can be *inferred*, costs *estimated*,
   status *unknown* (watchdog). "Inferred/estimated is always visible, never silent" is a
   **design system**, not a footnote — dashed edges? badges? confidence chips? The answer
   feeds back into the schema (a confidence field?), so it belongs **before** Phase 4,
   not inside it.
2. **Scale reality.** The real corpus: 117 sessions, ~849 nested agents — and 84/117
   sessions have **zero** subagents. So the DAG view is mostly sparse/empty (design the
   empty and sparse states, not just the dense showcase), while workflow sessions need
   hundreds of nodes (virtualization, collapse policy, initial zoom). Nobody has decided
   what first-paint shows.
3. **The five questions have no screens.** "<30 s to understand" is a measurable target
   with no defined path — which question, which screen, how many clicks, what is above
   the fold. One page of flows per question turns the Phase-4 exit gate from a wish into
   a checklist.
4. **Live semantics.** SSE means a moving screen: what animates, what stays still, how
   jitter is avoided with 10 concurrent agents. The copied simple10 `layoutTree`/physics
   is a starting point; nobody recorded which of its interactions survive.
5. Smaller but real: first-run/empty experience (zero sessions after install); dark mode
   (terminal-native user — presumably dark default, stated nowhere); table accessibility
   (contrast/keyboard); money display conventions ($0.0043 vs <$0.01).

**Recommendation:** one lightweight design WP (**WP-UX0**), dependency-ordered before
WP-U5: IA map, five question-to-screen flows, sketch/ASCII wireframes for the four views,
the uncertainty visual language, and transplanting EXPANDED §15 + PERF-01 into the plan
of record. Roughly one day of work; without it Phase 4 starts with invisible design debt
and a <30 s target no screen was designed to hit.

## 10. Priority actions (ranked by value ÷ effort)

Items marked **(Ivan)** require his decision; the rest are executable by an agent session
on request. Never commit any of this without an explicit ask.

1. **(Ivan) Sign or explicitly defer Gate A** (`TODO.md` top). Everything else is
   recommendation-only until then. *Done when: the two Gate-A checkboxes flip or a dated
   deferral note is added.*
2. **Apply best-path §6 to `development-plan.md` + `TODO.md`** — AMEND-1…6 in one
   editorial pass. *Done when: no alerts on the critical path; A8/A9 cut; X11 deleted
   (incl. DOCS-PLAN §5 note); WP-D2 single-driver; S1 slimmed/S4 demoted; `packages/core`
   in WP-F1; each edit cites best-path §6.*
3. ~~Amend `docs/ai/DESIGN.md` per probe §8 (AMEND-7)~~ — **✅ done 2026-07-06** by the
   propagation workflow, spot-verified by this audit. Residual from the same family
   still open: the WS→SSE wording sweep (C3, PROC-2) — see action 7.
4. **Resolve the three schema collisions before Track D** (OPEN-1/2/3): TTL-vs-immutability
   (segment archival recommended), add `'unknown'` to the status CHECK + define the
   revert rule, pick redaction Phase 1 or 2. *Done when: one dated decision note lands in
   concept-analysis-v2 §7 (or a new ADR) and data-model.md/ADR-0006 are updated.*
5. **Run or retire the friction log** (EMP-3) **(Ivan)**. *Done when: either
   `claude-code-templates --analytics` baseline logging starts with an end date, or a
   dated retirement note is added to best-path §9.*
6. **Add `LICENSE` (MIT) (Ivan approves)** + record the docs-site milestone in `DONE.md`
   (PROC-3/4). *Done when: LICENSE exists and DONE.md has the 2026-07-04 docs entry.*
7. **Refresh `README.md` and project `CLAUDE.md`** (PROC-1/2): JSONL-primary framing,
   stack-decided-pending-Gate-A, SSE. *Done when: no hooks-primary or WebSocket or
   stack-open wording remains.*
8. **Recover the lost source material** (LOST-1/2/3/5/6/7): feature matrix as a UI
   checklist appendix, OTel/adjacent-tools note, hook-schema-drift risk into DESIGN,
   FR/NFR IDs into the CD table, EXPANDED §15 + honest-uncertainty + PERF-01 into the
   plan, the 10 negative scenarios into `contributing/testing.md`.
9. **Create WP-UX0** (§9.5) with a dependency edge before WP-U5.
10. **Close the small opens:** define-or-drop OPCⁿ (OPEN-9), pricing source (OPEN-6),
    token transport (OPEN-4), coverage boundary sweep (OPEN-8), soften the "no true DAG"
    wording (LOST-8), add supersession banners to the two dossier files (PROC-7).

---

## Appendix A — source-vs-digest audit (the four .docx)

**Causal position:** the vendor due-diligence docx (v1, v2) are *upstream* of the digests;
the ideen-doklad docx (base, EXPANDED) are *downstream* — they cite DESIGN.md,
independent-due-diligence.md and WORKLOG as inputs. So vendor content absent from the
digests is "lost in digestion"; ideen-doklad content absent is "never folded back".

**Vendor v1 → v2:** same recommendation (adopt hoangsonww), but v2 introduces the
8-criterion weighted scoring model in which **simple10 wins 4.1 vs 4.0**, then overrides
the result on the visualization axis — the exact paragraph the independent audit attacks.
Grade change disler B+→B; hoangsonww test files 67→65; adds §12 feature matrix, §13
adjacent tools, §16 risk register, §17 cost model, §18 threat model, §19 integration
blueprint, §20 roadmap (~6 developer-days), appendices A–G.

**Ideen-doklad base → EXPANDED:** 11 → 26 sections. EXPANDED adds FR/NFR catalogue,
personas/JTBD, numeric MVP metrics (≥95% hierarchy, 0 lost events, <30 s), ADR-001…010,
negative-test catalogue, QA gates A–F, UX screen model + honest-uncertainty, risk
register R-01…R-10 (adds R-09 DB growth, R-10 false confidence from inferred data),
23-item backlog, traceability matrix, release checklist. **Unresolved schema fork between
the two:** base = single `events` + `webhook_targets`/`webhook_deliveries`; EXPANDED =
`events_raw`+`events` + `alert_deliveries`. v2/CD-4 adopted the EXPANDED shape; the
alert-tables divergence resurfaces in WP-A2 and was never explicitly reconciled.

**Digest claims not supported by sources:** the "no true DAG" verbatim quote (LOST-8);
DESIGN §0's "reinforced, not weakened" framing (both sources recommend fork-not-build;
v1 explicitly says building from scratch is not justified — never rebutted); DESIGN's
Phase 1.5 animated-room material comes from a later separate analysis, outside DESIGN's
declared sources. Also noted: the independent audit reports simple10 at 78 test files vs
the vendor's 76 without comment.

**Generation-quality note:** EXPANDED §§10.1–10.7 repeat an identical four-row table
seven times; the base doc contains a stray Hindi-script token. Both docx are partially
templated — treat their apparatus (IDs, catalogues) as valuable and their prose volume
as inflated.

## Appendix B — orphan register (analysis conclusions tracked nowhere)

1. best-path §6.1/§6.2/§6.3/§6.6/§6.7 edits (= AMEND-1…6).
2. best-path §6.9 — tokenless public demo with synthetic fixtures, post-1.0. No backlog item.
3. best-path §7/§9 — the friction log / kill-condition (= EMP-3).
4. probe §8 — DESIGN.md + reconstructor-spec amendment (= AMEND-7; **closed 2026-07-06**
   by the propagation workflow — the only orphan in this register that has been adopted).
5. probe §2 — intra-workflow ordering proof (= EMP-1).
6. nirdiamant non-destructive run-checkpoint pattern (git stash + tag) — praised in the
   dossier as portable to agenthropic's session model; absent from every plan.
7. v2 §7 residue — retention TTL number, coverage scope, pricing source, hook-POST auth
   detail, OPCⁿ (= OPEN-3/6/5/9 + coverage scope).
8. recommendation.md's three "open questions for Ivan" — two answered implicitly by later
   docs, OPCⁿ never; no closure recorded.
9. DOCS-PLAN deferred WPs (DOC-P1/P2/P4/P5, Track U fills) — invisible from TODO.md,
   which claims to be "the only actionable work" list.
10. Animated-room approval decision — deliberately parked, but with no "decide at gate X"
    entry anywhere; the parking brake has no release lever.
