# PROJECT STATE — 2026-07-06 (start here)

**Purpose:** the single entry point for a **context-free future session** (any model —
written explicitly so an Opus-class reader with zero chat history can reconstruct the
entire project state, know what is authoritative, and act correctly on the first try).
Everything here is links + status; the substance lives in the linked documents. This
file supersedes nothing — it navigates.

**As of:** 2026-07-06, end of the roadmap session (the third working session that day,
after audit/red-team and cleanup/reorganization). **First action for any future
session: check today's date against the KC calendar** (top of [`TODO.md`](../../TODO.md);
source: [`roadmap-v1-v2-2026-07-06.md`](roadmap-v1-v2-2026-07-06.md) §4) — the correct
behavior depends on which checkpoint window you are in, and a passed-unfulfilled
checkpoint has its own playbook in §6 below. If you are reading this much later, also
check `DONE.md` and `WORKLOG.md` for entries newer than this date before trusting the
snapshot in §4–§5.

> **Update — 2026-07-07 (the snapshot below remains accurate; nothing is superseded):**
> the roadmap §8 **analysis freeze was exercised for the first time** — in the 07-06
> evening chat session Ivan asked for a merciless "what is missing" analysis (i.e. #10);
> the session declined per the §6 playbook and answered with the KC table plus a digest
> of already-catalogued findings (Gate A unsigned · friction log not started · no rival
> installed · 0 commits · OPEN-1…9 · EMP-1…3 · LOST-1…8 — full digest preserved in the
> `WORKLOG.md` 2026-07-07 entry). **No analysis document #10 was created; the freeze
> held.** A 2026-07-07 state check found the repo unchanged since the 07-06 close: all
> five Step-0 boxes unchecked, 0 commits. **KC-0 (2026-07-13) is 6 days away.**

> **⚠️ Update — 2026-07-30 (read this before acting on §1, §4 or §5).** This file is a
> navigator, and its 07-06 snapshot has been overtaken by events. Three things in it are
> now factually wrong, and a fresh session that trusts them will act incorrectly:
>
> 1. **"Zero application code. Zero git commits" is false.** Implementation began
>    **2026-07-11**. What runs today: the loopback-bound token-gated Fastify server, the
>    SQLite/WAL substrate with migrations and an append-only `events_raw` enforced by
>    triggers, JSONL corpus ingest with replay-on-startup, the persisted subagent DAG,
>    the cost engine, the hook receiver, the SSE hub, the read API, and all four SPA
>    views. **72 test files / 879 tests pass**, coverage gated >90% in every shipped
>    package. The three P0 moat proofs and the 12-scenario negative catalogue are green.
> 2. **"No production code until Gate A + WP-S7 GO — CD-8 is still binding" no longer
>    describes the operating reality.** CD-8 was **overridden by the owner in chat on
>    2026-07-11** ("пускай агенти и започвай да имплементираш"), and again on 2026-07-18
>    to keep dispatching past a failed checkpoint. The override covers **dispatching
>    only** — it does not relax the security invariants, the LABEL-ME ratification
>    (Phase-0 numbers stay **PROVISIONAL**), Ivan's two physical KC acts, or
>    no-commit-without-an-explicit-ask. Record it as an override, never as a pass.
> 3. **KC-0 (2026-07-13) and KC-1 (2026-07-27) both passed UNMET.** KC-0 closed with 2 of
>    5 boxes open. KC-1's clauses 1 and 2 were green, but clause 3 — "the friction log has
>    not crowned a rival" — was **unsatisfiable by construction**, because the friction
>    log was never opened. A checkpoint whose condition cannot be evaluated has not been
>    passed; it was skipped. The next real checkpoint is **KC-2, 2026-09-14**.
>
> Still true and still binding: the security invariants (§ everywhere), the analysis
> freeze (9 of 9 — decline #10), the **immovable KC-4 date of 2026-12-01**, and the rule
> that at a failed checkpoint you report and stop rather than archiving anything
> yourself. **Newest truth lives in [`../../DONE.md`](../../DONE.md) Milestone 1,
> [`../../TODO.md`](../../TODO.md) and `WORKLOG.md`** — prefer them over §4–§5 below.

---

## 1. What this project is

**agenthropic** — a planned self-hosted, local-first dashboard for observing Claude Code
agent/subagent activity on Ivan Baev's Mac Mini M4. Differentiator (the "moat", per the
ruling strategy memo): **persistent cross-session subagent DAG + dollar-accurate cost
attribution** — only those two. Greenfield clean build (ports & adapters, in the spirit
of Ivan's `kiko` project), decided over forking any of six audited rival dashboards.

**Hard facts about the current repository:**
- **Zero application code. Zero git commits** (`main` has no commits; everything is
  untracked working-tree files). 77 markdown files, ~144k words (re-measured
  2026-07-06 — roadmap §1).
- The **schedule of record** is [`roadmap-v1-v2-2026-07-06.md`](roadmap-v1-v2-2026-07-06.md):
  kill checkpoints **KC-0…KC-5 with default-death** — Gate A signs by **2026-07-13**
  (KC-0) or the project archives; WP-S7 verdict due **2026-07-27** (KC-1); **v1.0 hard
  date 2026-12-01** (KC-4, immovable); v2.0 (alerts) entered only via KC-5 (earned by
  real daily use). **Analysis is frozen** (roadmap §8 — 9 analyses of 9; a request for
  #10 is declined and answered with the KC table).
- No production code may be written until **Gate A** is signed and the Phase-0 spike
  returns **GO** (`WP-S7`) — see §5. This is decision CD-8 and it is still binding.
- The one user is Ivan. The app will bind to `127.0.0.1` only, forever.

## 2. Complete timeline (what happened, in order)

Every entry below has a fuller record in [`DONE.md`](../../DONE.md) and `WORKLOG.md`.

| Date | Milestone | Primary artifact |
|---|---|---|
| 07-03 | Repo bootstrap; two vendor due-diligence `.docx` digested; **greenfield decision** | `docs/ai/DESIGN.md` (git-excluded, readable locally) |
| 07-03 | Independent due-diligence dossier — 6 rival deep dives with file:line evidence; vendor's self-contradiction documented | [`../due-diligence/`](../due-diligence/) |
| 07-03 | Concept analysis v1 (4 lenses + gap + holistic) + v1 implementation plan (D1–D7) | [`concept-analysis.md`](concept-analysis.md), [`implementation-plan.md`](implementation-plan.md) |
| 07-03 | Adversarial review of two externally-produced reports (BASE + EXPANDED) | [`external-docs-review.md`](external-docs-review.md) |
| 07-04 | **v2 consolidation** — LB1/LB2 + the ten canonical decisions **CD-1…CD-10** | [`concept-analysis-v2.md`](concept-analysis-v2.md) |
| 07-04 | Development plan — **75 work packages**, 8 tracks, 17 waves, 7 phases, verified DAG | [`development-plan.md`](development-plan.md) |
| 07-04 | **Best-path strategy memo** (sits *above* the plan; §6 orders plan amendments) + **empirical Phase-0 probe** of the real `~/.claude/projects` corpus → CD-1 pre-answered `CONDITIONAL-GO`, confidence 85, 11-item parser gate | [`best-path-decision.md`](best-path-decision.md), [`phase0-probe.md`](phase0-probe.md) |
| 07-04 | Public docs site authored: **44 pages, 13 ADRs**, 603 internal links, 0 broken *(the `DONE.md` gap — finding PROC-3 — was backfilled 2026-07-06)* | [`../site/`](../site/), [`../DOCS-PLAN.md`](../DOCS-PLAN.md) |
| 07-06 | **Propagation workflow** (parallel session, 50 agents): the four probe corrections carried corpus-wide (spawn tool `Agent`/`Workflow` not `Task`; layout by directory shape; outbox → YAGNI; CD-1 verdict), zero residuals | `DONE.md` entry |
| 07-06 | **Full-corpus audit** (six-part analysis persisted, self-contained) + **red-team counter-analysis** (deliberately merciless) | [`corpus-audit-2026-07-06.md`](corpus-audit-2026-07-06.md), [`red-team-audit-2026-07-06.md`](red-team-audit-2026-07-06.md) |
| 07-06 | **Corpus cleanup & reorganization** — AMEND-1…6 applied to the plan (dev-plan §2b) · supersession banners (v1 analysis/plan, due-diligence recommendation) · `README.md`/`CLAUDE.md` refreshed (PROC-1/2) · docs/site C-fixes · coverage bar normalized to **>90%** (OPEN-8 closed) · **`TODO.md` rebuilt as the parallel-agent assignment board** with disjoint lane ownership | [`../../TODO.md`](../../TODO.md), `DONE.md` entry |
| 07-06 | **v1/v2 roadmap — the last analysis (#9 of 9)**, authored on explicit owner instruction overriding red-team §11: kill checkpoints **KC-0…KC-5 with default-death** (Gate A sign-or-archive by **2026-07-13**; v1.0 hard date **2026-12-01**), phase-by-phase v1.0 schedule (Exit B absorbed into Phase 0 inside CD-8), earned-not-scheduled v2.0 alerts track, and the **analysis freeze** | [`roadmap-v1-v2-2026-07-06.md`](roadmap-v1-v2-2026-07-06.md) |
| 07-07 | **Analysis freeze exercised** (request for #10 declined per playbook, answered with the KC table + existing-findings digest); state check: repo unchanged, Step 0 unsigned, 6 days to KC-0 | `WORKLOG.md` 2026-07-07 entry |

## 3. Document map — what to trust, in what order

**Authority order when documents disagree** (full reasoning: corpus-audit §2):

1. [`phase0-probe.md`](phase0-probe.md) — empirical measurements. Trust its numbers over
   any citation of them elsewhere (stale citations have already been caught, e.g. "18
   nested" vs the true ~849).
2. [`best-path-decision.md`](best-path-decision.md) §6 — ruling strategy. Its six plan
   amendments (AMEND-1…6) were **applied 2026-07-06** as dated strikethrough edits citing
   §6 (see development-plan §2b). If an un-updated copy elsewhere still conflicts, §6 wins.
3. [`concept-analysis-v2.md`](concept-analysis-v2.md) — CD-1…CD-10 + LB1/LB2.
4. [`development-plan.md`](development-plan.md) — the 75-WP decomposition.
5. [`TODO.md`](../../TODO.md) — live tracker.

**Role of everything else:** `docs/ai/DESIGN.md` = design basis (amended 07-06, now
consistent); [`README.md`](README.md) here = index of the analysis chain;
[`../site/`](../site/) = public-facing docs (44 pages; the 19 cross-page
inconsistencies catalogued as C1–C19 in corpus-audit §6 — **substantive ones fixed
2026-07-06**, the rest were wording-level); [`../due-diligence/`](../due-diligence/)
= rival evidence (its `recommendation.md` is **obsolete** — "fork simple10" was
superseded by greenfield; **bannered 2026-07-06**, closing PROC-7); `WORKLOG.md`, `CLAUDE.md`,
`docs/ai/`, `*.docx` = git-excluded but present on disk — **read them, just never commit
them**.

**The three closing documents from 2026-07-06** are the distilled current picture:
- [`corpus-audit-2026-07-06.md`](corpus-audit-2026-07-06.md) — the fair pass. Finding
  register with stable IDs (**AMEND-1…7** unapplied amendments · **OPEN-1…9** unowned
  decisions · **LOST-1…8** dropped source material · **EMP-1…3** empirical gaps ·
  **PROC-1…7** hygiene), a 33-decision ledger, five senior-lens reviews (BA, architect,
  developer, QA, and the first-ever **UX/UI** pass — proposes WP-UX0), and **10 ranked
  actions**. Cite the finding IDs in WORKLOG when resolving anything.
- [`red-team-audit-2026-07-06.md`](red-team-audit-2026-07-06.md) — the adversarial pass.
  Kill-condition defused not passed; corpus self-contradictions; moat-on-rented-land;
  n=1 evidence critique; governance fiction; economics. §9 = what survives; §10 = three
  exits; **§11 = stop condition: do not write analysis document #9** (see §6 below).
- [`roadmap-v1-v2-2026-07-06.md`](roadmap-v1-v2-2026-07-06.md) — **the last analysis
  (#9 of 9), schedule of record**, authored on explicit owner instruction overriding
  §11. Its §4 kill-checkpoint table (KC-0…KC-5, default-death) **supersedes red-team
  §10's open exit choice**; its §8 hardens the analysis freeze. Subordinate to
  best-path on strategy and the dev-plan on WP content; authoritative on dates,
  checkpoints and scope boundaries **once Ivan signs its two §8 lines**.

**Post-freeze records (added after this snapshot; not analyses — permitted by roadmap §8):**
- [`phase0-verdict.md`](phase0-verdict.md) — **the WP-S7 GO/NO-GO verdict record**
  (2026-07-10): the Phase-0 spike executed end-to-end against a hostile 5-session /
  224-agent corpus → **CONDITIONAL GO ~90%**; all numbers self-check / PROVISIONAL
  until Ivan hand-fills the five `LABEL-ME.md` trees.
- [`parser-spec.md`](parser-spec.md) — the normative parser contract distilled from the
  verdict (the **14-item gate**, four structural join paths, token→cost rules). For any
  parser/ingest question this is now the most-current authority; it supersedes the
  11-item framing embedded in older docs. Design only — CD-8 still gates code.

## 4. Current truth snapshot

**Decided and consistent corpus-wide:**
security posture (loopback-only · no browser-driven spawner · mandatory `DASHBOARD_TOKEN`
+ `timingSafeEqual` · same-origin SSE · no SSRF · tunnel-only remote · WAL + tested
backups) · tokens read from JSONL, never inferred · every dollar = tokens × dated price ·
agents/subagents first-class with self-referential `parent_agent_id` · greenfield ·
`events_raw` append-only substrate + deterministic projection (CD-2/CD-4) · SSE transport
(CD-5) · spawn keying on **`Agent`/`Workflow`, never `Task`** + dual layout by directory
shape + child-transcript token summation (probe, propagated 07-06).

**Effectively decided but formally unsigned (Gate A open):**
CD-1…CD-10, LB1 (JSONL-primary ingest), LB2 (personal-first/commercial-clean), and the
stack: Fastify + TypeBox · better-sqlite3 (single driver) · React/Vite/D3 · pnpm monorepo
(`apps/server`, `apps/web`, `packages/shared`, `packages/core`, `packages/test-fixtures`,
`hooks/`) · Node 22.

**Ruled and applied 2026-07-06 (was the biggest debt — corpus-audit AMEND-1…6):**
best-path §6 is now materialized in `development-plan.md` (§2b lists every edit),
`concept-analysis-v2.md` (CD-9 dual-driver struck) and `TODO.md`: alerts off the v1.0
critical path (Phases 5–6 → post-1.0); WP-A8/A9 cut, A10 kept; **WP-X11 deleted**;
single better-sqlite3 driver in WP-D2; WP-S1 slimmed / WP-S4 demoted to liveness-only;
`packages/core` in the WP-F1 scaffold.

**Scheduled with teeth (2026-07-06, pending Ivan's two-line signature — roadmap §8):**
the KC-0…KC-5 kill-checkpoint calendar (roadmap §4, mirrored at the top of `TODO.md`),
the 63-WP v1.0 committed path with per-phase dates + descope ladder + forbidden
descopes (roadmap §5, Exit B absorbed into Phase 0 inside CD-8), and the KC-5-gated
v2.0 alerts track (roadmap §6). Until signed, the dates are décor by the document's own
admission — but the **analysis freeze (roadmap §8) binds sessions immediately**: it was
authored on the owner's explicit order and only his explicit chat instruction overrides it.

**Open with no owner (OPEN-1…9, corpus-audit §4.2):** retention-TTL vs `events_raw`
immutability (recommended: projection-only deletes + segment archival) · `'unknown'`
missing from `agents.status` CHECK · redaction Phase 1-vs-2 · browser token transport ·
hook-POST auth mechanism · pricing data source · app port · define-or-drop "OPCⁿ".
_(OPEN-8, the ≥90/>90 coverage boundary, was **closed 2026-07-06**: the bar is **>90%**,
per Ivan's standing delivery bar; normalized corpus-wide.)_

**Formerly-stale files, all fixed 2026-07-06 — a fresh session can now take them at
face value:** project `CLAUDE.md` (stack-decided wording + SSE — PROC-2; the
*do-not-scaffold* rule remains binding), root `README.md` (rewritten JSONL-primary —
PROC-1), `docs/due-diligence/recommendation.md` (supersession banner — PROC-7),
`docs/DOCS-PLAN.md` §5 X11 line (AMEND-3).

## 5. The pending decision — everything funnels through Ivan

Nothing below can be decided by an agent. As of 2026-07-06 Ivan owes the project exactly
one choice; until he makes it, the correct agent behavior is §6.

- **Gate A** ([`TODO.md`](../../TODO.md) top): sign CD-1…CD-10 + LB1/LB2, or defer with a
  dated note. Unsigned since 07-04 while 13 site ADRs already say "accepted" — the
  governance gap the red-team calls fiction. **The roadmap sets a deadline: sign by
  2026-07-13 (KC-0) or archive by default.**
- **The three exits** (red-team §10) — **superseded, pending signature, by the roadmap's
  §4 default-death checkpoint schedule** ([`roadmap-v1-v2-2026-07-06.md`](roadmap-v1-v2-2026-07-06.md)):
  Exit B's two-week timebox is absorbed into Phase 0 *inside* CD-8 (the throwaway
  DAG-with-dollars render is now the fused S5+S6 deliverable, so CD-8 is not bent);
  Exit A becomes the automatic on-failure branch of every checkpoint; Exit C is
  eliminated by KC-0's 2026-07-13 deadline.
- **The roadmap signature** (roadmap §8): two lines — Gate A + the KC schedule
  (default-death accepted). Until signed, the KC table is décor by its own admission.
- **The friction log** (best-path §7/§9, finding EMP-3): 2 weeks of passively noting
  pain while using free rivals. Never started; without it the kill-condition is
  undecidable and the "should this exist?" question has zero data.
- **Commit authorization:** the repo has **no commits**; 133k words are one `rm -rf`
  from gone. Committing requires Ivan's explicit ask — see playbook below.

## 6. Playbooks — "if Ivan says X, do Y"

- **"Commit the docs"** → verify `.git/info/exclude` covers `CLAUDE.md`, `CLAUDE.local.md`,
  `WORKLOG.md`, `.claude/`, `docs/ai/`, `due-diligence/*.docx`, `.DS_Store`; then commit
  the publishable set (`README.md`, `TODO.md`, `DONE.md`, `docs/analysis/`,
  `docs/due-diligence/`, `docs/site/`, `docs/DOCS-PLAN.md`,
  `docs/independent-due-diligence.md`). English commit messages, **no AI attribution**,
  never push unless asked separately.
- **"Apply best-path §6" / "fix AMEND-1…6"** → **already done 2026-07-06** (development-plan
  §2b · concept-analysis-v2 CD-9 · TODO.md · DOCS-PLAN §5); nothing left to apply.
- **"Dispatch parallel agents" / any multi-agent work** → follow the coordination protocol
  at the top of [`TODO.md`](../../TODO.md): one lane = one agent = the listed path
  ownership; lanes in a wave are disjoint by construction; `TODO.md`, `DONE.md`,
  `WORKLOG.md`, this file and `CLAUDE.md` are **orchestrator-only** — lane agents return
  reports, the orchestrator writes the trackers.
- **"Sign Gate A"** → flip the Step-0 checkboxes in `TODO.md` with a date (Gate A + the
  KC schedule can be one act — roadmap §8); record the friction-log start date; Phase-0
  WPs (S1, S4–S7; S2/S3 pre-answered) become the only actionable work, with the WP-S7
  verdict due **2026-07-27 (KC-1)** and the Wave-3 joint THROWAWAY DAG-with-dollars
  render as a KC-1 stay-alive condition.
- **"Run Exit B"** → **no CD-8 bend is needed anymore**: the roadmap absorbed Exit B
  into Phase 0 (roadmap §5 — the fused S5+S6 THROWAWAY DAG-with-dollars render). Run
  the `TODO.md` Phase-0 waves as written; the probe's 11-item parser gate is the spec;
  day 14 = WP-S7 = KC-1.
- **"Start the friction log"** → add start/end dates to best-path §9; it needs Ivan's
  attention, not agent work — just record it and set expectations for day 14. It is a
  KC-0 checkbox and its day-14 reading is a KC-1 kill clause (a rival answering ≥4 of
  the 5 daily questions acceptably fires KC-1 regardless of the spike verdict).
- **A KC date has passed unfulfilled** → do exactly three things: report the failed
  checkpoint and its default branch (archive), stop dispatching new work, decline new
  analysis and new code. **No agent ever archives, deletes, `git`-resets or `rm`s
  anything** — "archive" is Ivan's manual act; your job is the honest report. Only
  Ivan's explicit instruction in chat overrides a default.
- **Asked for more analysis of the idea** → decline per red-team §11 **as hardened by
  roadmap §8 (the analysis freeze — the corpus is complete at 9 analyses)**; answer with
  the roadmap's §4 kill-checkpoint table. The repo has a decision problem, not an
  information problem. Only Ivan's explicit chat instruction can override the freeze
  (as it did, exactly once, to create the roadmap itself).
- **Any request to scaffold `package.json`/`src/`** → refuse until Gate A + WP-S7 GO
  (or an explicit Exit-B order, which produces throwaway-only code).

**Session rules that bind you regardless of the ask:** chat with Ivan in **Bulgarian**;
everything in the repo in **English**; never commit/push unasked; git-excluded files stay
excluded; WORKLOG entry per meaningful task; run typecheck/lint/tests once code exists
and report real results; the security invariants in §4 are non-negotiable in any code you
ever write here.

## 7. Where this session's full reasoning lives

The 2026-07-06 session delivered its analyses in Bulgarian in chat (ephemeral) and
persisted everything substantive in English: the fair audit → `corpus-audit-2026-07-06.md`,
the merciless pass → `red-team-audit-2026-07-06.md`, the narrative → `WORKLOG.md`
(2026-07-06 entries), the milestone log → `DONE.md`. The three subagent sweeps behind the
audit (44-page site digest; docx source-vs-digest diff; 33-decision consistency ledger)
were session-scratchpad work — their conclusions are fully folded into the audit's §5,
§6 and appendices; no external artifact needs recovering. Nothing was committed; nothing
in the plan of record was altered by the audits themselves except: the two audit files,
this file, index/staleness fixes in [`README.md`](README.md), and the `DONE.md`/
`WORKLOG.md` entries.
