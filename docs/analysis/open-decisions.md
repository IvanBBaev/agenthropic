# Open decisions — sign-off form for Ivan

**Status:** Decision form. This file changes nothing on its own — it collects the nine
open decisions catalogued in the 2026-07-06 corpus audit (`corpus-audit-2026-07-06.md`
§4.2, its ranked actions §10.4/§10.10, and the C5/C6/C7/C13/C17/C18 rows of the
inconsistency table §6) into checkboxes you can sign. **This is not a new analysis** — the
roadmap §8 analysis freeze is in force; no findings are added here, only existing IDs are
cited.

**How to use.** Each decision states the question in one sentence, the resolution the
audit already recommended (or, where the audit deliberately left the choice open, the
catalogued options), the consequence of leaving it open, and a checkbox. Deciding is
yours. When you tick a box, the audit's landing rule (§10.4) is: **one dated decision note
lands in `concept-analysis-v2.md` §7 (or a new ADR), and `architecture/data-model.md` /
ADR-0006 are updated to match.** No file is edited by ticking here.

**Blocker legend.** 🟥 = blocks a WP track from starting. The three schema collisions
**OPEN-1, OPEN-2, OPEN-3 must all be resolved before Track D begins** (audit §10.4) — they
are ordered first below.

---

## A. Track-D blockers — resolve these before the data track starts

### OPEN-1 — Retention TTL vs `events_raw` immutability 🟥 blocks Track D

**Question.** Given that ADR-0004/0006/0009 enforce no-UPDATE/no-DELETE on `events_raw` by
trigger + test, while ADR-0012/WP-D10 mandate a retention-TTL sweeper, how does retention
free space without violating the append-only substrate? (docs-consistency view: **C6**.)

**Recommended resolution (audit §4.2 / §9.2, architect lens).** Retention **deletes
projections only**; `events_raw` ages out via **segment-level archival** — a closed period
is detached into an archive file, so deletion is a file operation, never row DML. The
no-UPDATE/no-DELETE triggers and the replay P0 test (rebuild the DB from JSONL) both
survive intact.

**If left open.** Genuine design collision that surfaces as a **red build in Track D** the
moment WP-D10 (the TTL sweeper) meets the immutability triggers. Track D cannot start.

- [ ] Accept: retention deletes projections only; `events_raw` ages out by segment
      archival (file detach), never row DML.
- [ ] Choose another resolution: ________________________________________________

### OPEN-2 — `'unknown'` missing from the `agents.status` CHECK 🟥 blocks Track D

**Question.** The reference DDL (`data-model.md`, `glossary.md`, ADR-0006) allows
`('working','waiting','completed','error')`, but WP-IN12's missing-`Stop` watchdog assigns
`'unknown'` — do we add `'unknown'` to the CHECK, and what is the unknown→revert rule?
(docs-consistency view: **C5**.)

**Recommended resolution (audit §4.2 / §10.4).** **Add `'unknown'` to the `agents.status`
CHECK constraint** and **define the unknown→revert rule** (the open follow-up, v2 §7 q5) —
i.e. how an agent leaves `'unknown'` once a late signal arrives.

**If left open.** The WP-IN12 watchdog writes a value the CHECK rejects → insert fails at
runtime; the status enum is a Track-D schema object, so this blocks Track D alongside
OPEN-1.

**Implemented, awaiting ratification (not a tick).** The CHECK now allows all five values,
and the status lifecycle ships with this revert rule, enforced in SQL inside the upsert
(`apps/server/src/db/agents.ts`, mirrored in `db/sessions.ts`): (1) observed terminals
(`completed`, `error`) are **sticky** — no later ingest downgrades them; (2) inferred states
(`working`, `waiting`, `unknown`) are replaced only when the incoming activity anchor
(`last_seen_at` / `last_activity_at`) **strictly advances**, so a late signal or fresh
transcript activity lifts an agent out of `'unknown'`; (3) an unchanged replay therefore
changes nothing, which is what keeps the P0 byte-identical double-replay proof green. See
`docs/site/architecture/ingest-reconciliation.md` §8.1. Ticking the box below remains the
owner's call.

- [ ] Accept: add `'unknown'` to the CHECK **and** define the revert rule below.
      Revert rule: ______________________________________________________________
- [ ] Choose another resolution: ________________________________________________

### OPEN-3 — Redaction phase: Phase 1 or Phase 2? 🟥 blocks Track D

**Question.** ADR-0012 says "retention TTL + payload redaction **from Phase 1**", while
`operations/backup-restore.md` §5 wires the redactor at WP-IN14 with a **Phase-2** exit
criterion — which phase owns redaction? (docs-consistency view: **C7**.)

**Audit position.** §4.2 states the two docs disagree and says "pick one"; the audit did
**not** hard-recommend a phase there. Its **QA lens (§9.4)** does supply the deciding
argument, though: the fixture redaction rule is undefined, the golden corpus is built from
your **real sessions** (real paths, names, potentially secrets) **with a public repo on the
horizon** — a privacy gap. That argument, plus ADR-0012's own "from Phase 1" stance, points
to **Phase 1**. The final pick is yours.

**If left open.** The golden corpus and fixtures may be captured with unredacted secrets;
if redaction slips to Phase 2, that material has to be rebuilt (or worse, leaks to a public
repo). Redactor wiring (WP-IN14) and the fixture pipeline stay blocked.

- [ ] Phase 1 — redact from the start (aligns `backup-restore.md` §5 to ADR-0012; matches
      the §9.4 privacy argument).
- [ ] Phase 2 — keep the WP-IN14 / Phase-2 exit criterion (aligns ADR-0012 to
      `backup-restore.md` §5).

---

## B. Remaining open decisions

### OPEN-4 — Browser token transport: header vs cookie vs query 🟥 blocks remote-access / security WPs

**Question.** How does the browser present its auth token to the loopback server — request
header, cookie, or query parameter? (docs-consistency view: **C17**.)

**Audit position.** `security/remote-access.md` defers to `security/model.md`, which also
does not decide — a **circular, unowned** deferral (§4.2). The audit lists this under "close
the small opens" (§10.10) but **did not reach a recommendation**; the choice is yours from
the three catalogued options. (Security-sensitive: whichever is picked must respect the CD-5
same-origin check on the SSE stream and the loopback-only bind.)

**If left open.** The token-guard / remote-access surface cannot be implemented; the
circular deferral persists and two site pages that already promise concrete paths (e.g.
`apps/server/src/security/token-guard.ts`) have no defined mechanism to honor.

- [ ] Header (e.g. `Authorization: Bearer …`)
- [ ] Cookie
- [ ] Query parameter
- [ ] Other: ____________________________________________________________________

### OPEN-5 — Hook-POST auth mechanism 🟥 blocks hook-ingest WPs

**Question.** The invariant (hook POSTs are authed) is decided; **which mechanism** — a
shared token or Unix-socket peer credentials? (docs-consistency view: **C13**.)

**Audit position.** This is question 8 in three architecture pages, while
`architecture/hooks.md` prose reads as if already settled — a settled-in-prose /
open-in-question-list contradiction (§4.2, C13). The audit **did not reach a
recommendation**; it catalogues the two options.

**If left open.** The hook-ingest endpoint's auth cannot be implemented; the prose and the
open-questions list stay in contradiction.

- [ ] Shared token
- [ ] Socket peer credentials (Unix-socket peer creds)
- [ ] Other: ____________________________________________________________________

### OPEN-6 — Pricing data source 🟥 blocks cost-model / Track-D cost attribution

**Question.** `model_pricing` is versioned and CI-gated (a no-price-row fails CI), but where
do prices come from and how does `verified_on` get refreshed? (audit §4.2, v2 §7 residue.)

**Audit position.** Nobody chose a source; the audit lists this under "close the small
opens" (§10.10) and **did not recommend one**. The only adjacent candidates surfaced
anywhere in the corpus are in LOST-2 (the **Anthropic Console / Analytics API**); treat
those as candidates, not a recommendation.

**If left open.** `model_pricing` has no provenance and no refresh process, so the CI
no-price-row gate cannot be satisfied honestly and the dollar-cost attribution moat rests
on unsourced numbers.

- [ ] Source: __________________________________  ·  `verified_on` refresh cadence /
      owner: __________________________________

### OPEN-7 — App port number and where it is configured 🟥 blocks config / scaffold + remote-access docs

**Question.** Which port does the app bind (loopback), and where is that configured?
(docs-consistency view: **C18**.)

**Audit position.** `remote-access.md` flags the port as uncommitted; the tunnel examples
have nothing to bind to (§4.2, C18). The audit **did not pick a number**; the choice — and
its config location — is yours.

**If left open.** Tunnel/SSH examples reference a port that does not exist; scaffold and
remote-access docs cannot be finalized.

- [ ] Port: ____________  ·  configured in: ____________________________________

### OPEN-9 — "OPCⁿ" — define or drop 🟩 docs only, no track blocked

**Question.** "OPCⁿ" is an undefined token inherited from the vendor documents and used in
two live docs — do we define it or drop it? (audit §0.2 glossary, §4.2; ADR-0002 left it
open.)

**Audit position.** "Nobody has ever defined it" (§0.2); flagged **"define-or-drop"** since
v2 §7 and still open (§10.10). No firm recommendation was reached; because it has never had
a meaning, dropping it is the low-risk path, but that is your call.

**If left open.** Reader confusion and lingering docs debt in the two pages that still use
the term. No WP track is blocked.

- [ ] Drop it (remove from the two live docs)
- [ ] Define it as: _____________________________________________________________

---

## C. Closed — recorded for completeness, do not reopen

### OPEN-8 — Coverage boundary — ✅ CLOSED (2026-07-06)

The ">90%" vs "≥90%" coverage-gate ambiguity (audit §4.2 / C8, where ADR-0009 contradicted
itself) was **normalized to `>90%` on 2026-07-06**. This matches the project quality
conventions (README/CLAUDE.md coverage bar). **Resolved — no sign-off needed; do not
reopen.**

- [x] Coverage merge gate is **`>90%`**. (Closed 2026-07-06.)

---

## Sign-off ledger

| # | Decision | Blocks | Recommendation reached by audit? | Decided (date) |
|---|---|---|---|---|
| OPEN-1 | Retention TTL vs `events_raw` immutability | 🟥 Track D | Yes — projections-only + segment archival | |
| OPEN-2 | `'unknown'` in `agents.status` CHECK | 🟥 Track D | Yes — add `'unknown'` + revert rule | |
| OPEN-3 | Redaction Phase 1 vs 2 | 🟥 Track D | Lean Phase 1 (§9.4 privacy); pick yours | |
| OPEN-4 | Browser token transport | 🟥 remote-access / security | No — options only | |
| OPEN-5 | Hook-POST auth mechanism | 🟥 hook-ingest | No — options only | |
| OPEN-6 | Pricing data source | 🟥 cost-model / Track-D cost | No — candidates only (LOST-2) | |
| OPEN-7 | App port + config location | 🟥 config/scaffold + remote-access | No — pick a number | |
| OPEN-8 | Coverage boundary | — | ✅ Closed `>90%` (2026-07-06) | 2026-07-06 |
| OPEN-9 | "OPCⁿ" define or drop | 🟩 docs only | No firm rec (drop is low-risk) | |
