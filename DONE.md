# DONE

Completed milestones for **agenthropic**. Newest first. Open work lives in
[`TODO.md`](TODO.md); the sequenced build plan is
[`docs/analysis/development-plan.md`](docs/analysis/development-plan.md).

> Status legend used in `TODO.md`: `[ ]` open · `[~]` in progress · `[x]` done (moved here).

---

## Milestone 0 — Analysis & planning (pre-code)

_No application code is scaffolded yet. Everything below is design, audit, and
planning documentation — the evidence base the build stands on._

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
