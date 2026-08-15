# Testing & quality

This page is the QA reference for agenthropic: how the **golden real-session fixture
corpus** is captured, promoted, and labeled with ground truth; the **three P0
release-blocker tests** that must be green before Phase 3 is considered done; the
**12-scenario negative-test catalogue**; and the **coverage gate** — specified at >90%,
shipped at 100 — that is live from Phase 1, not a hardening pass bolted on at the
end. The key takeaway up front: this project treats test infrastructure as a first-class,
phase-spanning engineering problem, not overhead — "you cannot unit-test 'the
dashboard'; the four real units are ingest correctness, tree correctness, cost
correctness, live-flow correctness, each with a distinct harness. The golden
real-session fixture corpus is the #1 QA investment — without it, >90% coverage is
high-coverage tests of synthetic happy-paths (**false safety**)" (concept-analysis-v2
§4.3). Everything below traces to
[`development-plan.md`](../../analysis/development-plan.md) Track X (`WP-X1`…`WP-X5`)
and the quantified acceptance criteria in
[`concept-analysis-v2.md`](../../analysis/concept-analysis-v2.md) §6.

> **Update — 2026-08 (as built).** This page was written before a single test existed, so
> the sections below still speak in the future tense about gates that have since been
> built, superseded by something stricter, or blocked on a human act that has not
> happened. This note is the verified state of the suite as of **2026-08-15**, measured by
> running `pnpm -r --workspace-concurrency=1 run test` on a clean tree and reading the
> per-package `coverage/coverage-summary.json` it writes. Where a section below disagrees
> with this note, this note is the current truth and the section is the historical intent.
>
> - **The three P0 release-blocker tests are green.** They live in `apps/server/test/p0/` —
>   `p0-token-reconciliation.test.ts`, `p0-double-replay.test.ts`, `p0-dag-rebuild.test.ts`,
>   sharing a `harness.ts`. One detail matters more than the pass/fail: the
>   token-reconciliation proof does **not** compare the parser against itself. It reads the
>   JSONL with an independent minimal reader written inside the test against the normative
>   rules of [`parser-spec.md`](../../analysis/parser-spec.md) §5.1–5.3, so a parser bug
>   cannot make its own proof pass. The double-replay proof compares two `VACUUM INTO`
>   snapshots with `Buffer.equals` under a fixed clock — byte-identical, not "equivalent" —
>   and then re-asserts the same claim a second, independent way against an ordered logical
>   dump of every table. The DAG-rebuild proof additionally demonstrates the
>   hooks-are-liveness-only rule: appending hook events leaves the DAG dump unchanged.
> - **All twelve negative-catalogue scenarios now have executable bodies, and they are
>   green.** They are split by nature rather than kept in one file: the pure parser and
>   cost facets (#3, #4, #8, #11, #12) live in
>   `packages/core/test/negative/negative-catalogue.core.test.ts`, and the HTTP,
>   persistence and security facets (#1, #2, #3-db, #4-http, #5, #6, #7, #8-halt, #9, #10)
>   live in `apps/server/test/negative/`. Three scenarios appear on both sides on purpose —
>   a malformed JSONL line and a malformed HTTP body are different failures of the same
>   catalogue entry. The security entries are asserted at the level where an oracle would
>   hide: byte-identical `401` bodies across four different wrong-token shapes (no token
>   echo, no length oracle) and a `403` on a foreign `Origin` **both with and without** a
>   valid token, so a probe cannot learn whether its token was good either. One half of
>   scenario #2, "normalized anomaly flagged", remains untestable as the catalogue words it
>   — there is no hook normalizer, because hooks are a secondary signal — and the test file
>   says so in place of quietly dropping the clause; the anomaly surfaces instead through
>   the `WP-IN12` watchdog as a visible `unknown` status.
> - **Totals as of 2026-08-15: 106 test files / 1554 tests, green, across five packages**
>   — `apps/server` 66/881, `apps/web` 17/283, `packages/core` 12/210,
>   `packages/test-fixtures` 4/100, `packages/shared` 7/80. These counts move with every
>   commit; treat them as a dated measurement, not a constant.
> - **The coverage gate is no longer ">90%" anywhere in the repo. It is 100.** All five
>   packages run `vitest run --coverage` and all five pin `lines`/`branches`/`functions`/
>   `statements` at `100`, and all five are currently at 100 on every one of those four
>   metrics. `packages/test-fixtures` is no longer excluded from the gate — that carve-out
>   was reversed on the reasoning that a defect in a fixture builder does not fail loudly,
>   it silently weakens every downstream test that consumes the fixture. §6.1 below is the
>   as-built account of why the number is 100 rather than 90 and what stops it from being
>   bought cheaply. **Honest note, kept from the previous revision:** until 2026-07-30
>   `apps/web` ran `vitest run` *without* `--coverage`, so its configured thresholds
>   silently never executed. That was found and fixed.
> - **§2's golden real-session corpus is not what shipped.** The three-tier
>   raw/redacted/manifested promotion of ≥3 captured real sessions was not built. What
>   exists is `packages/test-fixtures` with **seven** typed fixtures — `flat-tool-use`,
>   `nested-workflow`, `queue-operation`, `task-notification-recovery`, `depth-2-sync`,
>   `usage-dedup`, `legacy-bare-explore` — plus per-suite corpora written into temp
>   directories. Tests **never** touch the real `~/.claude/projects`: every corpus is built
>   under `mkdtempSync` with explicitly injected env. The package location that
>   §"What's undecided" called "a named leaning" is settled — it is `packages/test-fixtures`.
> - **§3's labeled ground truth is half-built, and the missing half cannot be built by an
>   agent.** The format, loader, scorer, report and gate runner all exist (§3.1). The
>   labels do not. `packages/test-fixtures/annotations/human/` is empty, and the five
>   `spike/corpus/sessions/<short>/LABEL-ME.md` trees are still unfilled — labeling is
>   Ivan's act, not an agent's. **Consequence, stated plainly: the ≥95% hierarchy
>   correctness gate in §2/§4 has never been scored.** The gate run reports
>   `SUBSTRATE UNAVAILABLE`, `Phase-3 exit clause: NOT MEASURED - no hand-labeled sessions`
>   and a **NOT CERTIFIED** verdict, and it passes as a test in that state, because an
>   unlabeled corpus is an honest state rather than a broken build. Every spike-derived
>   accuracy number in this corpus stays **PROVISIONAL** until that labeling happens. No
>   test result on this page should be read as satisfying that bar.
> - **Nothing here is physically merge-blocking yet.** `.github/workflows/ci.yml` runs the
>   spawner gate, typecheck, lint, format check, the web production build, the full suite
>   with its coverage thresholds, and the license gate — in that order, security first so a
>   broken invariant fails in seconds. But branch protection on `main` is not enabled, so
>   GitHub does not withhold the merge button when that workflow is red. The gates are real
>   and they fail loudly; calling them "merge-blocking" requires an owner action on
>   github.com that has not been taken. Sections below that say "merge-blocking" are
>   describing the intended end state.

## 1. Four units, not "the dashboard"

The QA lens's starting move is refusing to treat "test the dashboard" as one problem.
It decomposes into four real units, each needing its own harness because each fails in
a structurally different way (concept-analysis-v2 §4.3):

| Unit | What it proves | Fails when |
|---|---|---|
| **Ingest correctness** | A hook event and a JSONL line for the same fact collapse into one `events_raw` row; nothing is lost or double-counted. | Dual-write dedup is wrong, or a crash mid-ingest drops data. |
| **Tree correctness** | The reconstructed subagent hierarchy in `orchestration_edges` matches reality. | A parent→child edge is missing, mis-attributed, or the tree is only "almost correct" — which the QA lens judges **worse than no graph** because it manufactures false trust (concept-analysis-v2 §4.3). |
| **Cost correctness** | Every displayed dollar traces to ground-truth tokens × a dated, versioned price, including across a compaction. | A stale price, a silent zero-cost default, or a `PreCompact` repricing bug. |
| **Live-flow correctness** | The realtime status board reflects reality without a permanent false "working" state. | A missing `SubagentStop` never resolves to a watchdog "unknown". |

On top of these four units, the project's consolidated test model layers a shape and a
priority scheme (concept-analysis-v2 §4.3):

- **A 5-layer pyramid** — Unit / Integration / Security / UI / Manual-real-session.
- **P0/P1/P2 priority tiering** — P0 is release-blocking; the three reconciliation tests
  in §4 below are the canonical P0 set.
- **A negative-test catalogue of 12 scenarios** — 10 inherited from an externally
  produced parallel report's own catalogue, plus two cases added because they are
  specific to this system (compaction-mid-session and `PreCompact` re-pricing) — see §5.

This is scoped as a project-wide, always-on workstream, not a phase: the implementation
plan names it `WS-Test` — "golden real-session fixtures corpus (happy + pathological:
deep nesting, missing Stop, mid-session compaction, two concurrent instances);
reconciliation/idempotency/compaction/security test suites; CI coverage gate at >90%,
blocking merges" — one of four cross-cutting workstreams that "run through every phase"
(implementation-plan.md §B.1), alongside security, docs, and ops.

## 2. The golden real-session fixture corpus

Synthetic fixtures cannot stand in for this corpus: a hand-written happy-path JSONL
transcript cannot prove the tree survives a crash it was never built to have, so the
corpus has to be captured from **real** Claude Code sessions, not authored. Capture and
permanent promotion are two different work packages in two different phases:

```
Phase 0 (throwaway spike)                Phase 1 (permanent corpus)
──────────────────────────               ──────────────────────────
WP-S1 paired-capture harness    ──────►  WP-X1 golden fixture corpus
 · ≥3 real sessions                       · promotes the Phase-0 capture
 · paired JSONL + hook log per            · three artifacts: raw, redacted,
   session                                  manifested
 · Ivan-labeled expected tree             · ≥3 real sessions; all four
   per session                              pathologies each represented
 · throwaway hook block                   · a "manifest self-test" — CI
   reverted after capture                   asserts pathology coverage from
                                             the manifest, not a comment
```

(development-plan §5, `WP-S1`, `WP-X1`.) `WP-X1` depends on `WP-S2`, `WP-S4`, and `WP-F1`
— the two Phase-0 probes that already exercise the corpus, plus the monorepo scaffold —
and is scheduled at **wave 6**, labeled there as "corpus promotion" (development-plan
§4, wave 6). It is not stood up in isolation: `WP-X1` runs alongside `WP-X5` (the
coverage gate config) and `WP-X7` (the docs-site build) in the same wave, all gated on
the Phase-0 `GO`/`CONDITIONAL-GO` verdict (`WP-S7`) that unblocks `WP-F1` in the first
place (development-plan §1, §4).

### The three tiers

`WP-X1`'s own Done-when names three artifacts, not one (development-plan §5, `WP-X1`):

- **raw** — the session exactly as captured by `WP-S1`'s paired harness: the JSONL
  transcript and the hook log side by side, unmodified.
- **redacted** — the same session with payload content scrubbed before it can live in a
  version-controlled repository, applying the payload-redaction policy that CD-10
  requires from Phase 1 (concept-analysis-v2 §3, CD-10). The exact redaction rule and
  retention TTL are open Phase-0 inputs, not yet fixed numbers (concept-analysis-v2 §7,
  open question 6) — see [backup & restore](../operations/backup-restore.md).
- **manifested** — accompanied by a manifest that records, per session, which
  pathology(ies) it demonstrates, so a CI check can assert corpus completeness by
  reading the manifest rather than by trusting a code comment — the "manifest
  self-test" (development-plan §5, `WP-X1`).

### The four pathologies

Both `WP-S1`'s capture harness and `WP-X1`'s promoted corpus are required to represent
the same four pathological session shapes (development-plan §5, `WP-S1`;
concept-analysis-v2 §6):

| # | Pathology | Why it's in the corpus |
|---|---|---|
| 1 | **Crashed, no `Stop`** | Proves the missing-`SubagentStop` → watchdog "unknown" rule, and that a crash doesn't leave a permanent false "working" state. |
| 2 | **Deep nesting** | Stresses the DAG-rebuild-from-JSONL path against multi-level subagent-of-subagent chains, not just a flat parent→child pair. |
| 3 | **Mid-session `PreCompact`** | The one EXPANDED's own negative-test catalogue omitted — proves the tree and the cost baseline both survive a context compaction (concept-analysis-v2 §4.3, "its catalogue dropping the compaction case"). |
| 4 | **Two concurrent instances** | Proves `instance`/`host_id` correctly partitions two simultaneously running Claude Code sessions instead of merging their trees. |

The corpus size floor is **≥3 real sessions** (development-plan §5, `WP-S1`/`WP-X1`;
concept-analysis-v2 §6), and it doubles as the population the **≥95% hierarchy
correctness gate** is measured against in Phase 3 (concept-analysis-v2 §6) — see
[ingest & reconciliation](../architecture/ingest-reconciliation.md) §10 for that gate in
full.

## 3. Labeled ground truth: `expected/*.json` and the typed loader

A corpus of real sessions is only useful to CI if there is a machine-checkable answer
key. `WP-X2` — **labeled ground-truth annotations + typed fixture loader** — is that
answer key: "every session has an `expected/*.json`; a test fails if any lacks one"
(development-plan §5, `WP-X2`). Two things make this more than a convention:

- **Coverage is enforced, not requested.** The loader itself fails a session that has no
  matching `expected/*.json`, so a new corpus session cannot silently ship unlabeled and
  invisible to the P0 and negative-catalogue suites that consume it.
- **The loader is typed.** `WP-X2` is scheduled directly after `WP-X1` and depends on
  `WP-D1` (the shared storage-port row types), at **wave 7**, where development-plan
  labels it "labeled fixtures" (development-plan §4, wave 7; §5, `WP-X2`) — the expected
  trees are consumed as typed fixtures against the same row-shape contracts the
  production projection code uses, not as untyped JSON blobs a test has to hand-parse.

Everything downstream — the three P0 tests (§4), the negative catalogue (§5), and the
≥95% hierarchy gate (§2) — is scored against these `expected/*.json` files, which is why
`WP-X2` sits on the critical dependency edge into both `WP-X3` and `WP-X4`
(development-plan §5).

## 3.1 As built: the annotation corpus, the Wilson floor, and a gate that refuses to sign

What shipped is not `expected/*.json` but something with the same job and a stricter
posture about its own authority. The ground truth lives in
`packages/test-fixtures/annotations/`, in a hand-writable markdown format that is
diffable and needs no tooling to author: a `## meta` block declaring the session,
`provenance`, `substrate`, `labeled-by` and `labeled-on`, then a `## edges` block of one
line per subagent — `<child hex> <- ROOT | ORPHAN | UNKNOWN | <parent hex>`, with an
optional trailing comment. Everything outside those two blocks is prose the loader
ignores, so a labeler can leave notes to themselves in the file. The loader, validator,
scorer, report renderer and read-only filesystem adapters are in
`packages/test-fixtures/src/annotations/`; the runner that wires the real parser to them
is `packages/core/test/hierarchy-gate.test.ts`.

Three design choices in that tooling are the point of it, and each exists to stop a
number from meaning less than it appears to.

**The score is a Wilson lower confidence bound, not a ratio.** A naive percentage is
silent about sample size — 3/3 and 300/300 both read "100%", and only one of them is
evidence. `wilsonLowerBound()` computes the one-sided 95% lower bound instead, which
returns 0 when there are no observations at all: no data, no confidence. The direct
consequence is a hard floor on the sample. Solving `n / (n + z²) ≥ 0.95` gives
`n ≥ 0.95 · 1.6449² / 0.05 = 51.4`, so **52 labeled agents is the minimum at which even a
flawless run can clear the bar**, and roughly 90 are needed to survive a single error.
`minimumClaimsForThreshold()` computes that floor and `certifyExitGate()` refuses to
certify below it no matter how good the raw percentage looks. The two prepared templates
— `b24be30c` (42 agents, dual on-disk layout, deepest observed nesting) and `f28af3fd`
(18 agents, an independent depth-2 population, 5 compactions) — total 60, chosen to clear
52 with a little headroom while covering structurally distinct ground. Labeling only one
of them leaves the sample below the floor, and the gate says so.

**Provenance is enforced structurally, not by convention.** `annotations/synthetic/`
holds seven annotations, one per fixture, that state the hierarchy each fixture was
*built* to have. They are genuinely useful — they prove the loader, the scorer, the
report and every join path work end to end, and they regression-guard the depth-2 case —
but they were written by the same side as the parser, so agreement with them proves
internal consistency and nothing else. Every annotation must therefore declare
`provenance: human` or `provenance: synthetic-by-construction`; `scoreCorpus()` throws if
a corpus mixes the two, so a blended figure cannot be produced by accident;
`certifyExitGate()` hard-refuses any non-`human` corpus and prints the reason; and the
report prints an `ADMISSIBILITY` banner above the numbers so no reader can quote the
figure without also reading what it is made of.

**Abstention is a first-class answer.** `UNKNOWN` is not scored as a miss and not scored
as agreement — it is excluded from the accuracy fraction and reported in its own bucket,
because a guess that turns out wrong is strictly worse than an abstention when the exit
gate would be signed against it. `ORPHAN`, by contrast, is a positive claim ("there is no
parent to find here, and a parser that invents one is wrong") and is scored. To stop
abstention from becoming a way to launder a number, the report prints label coverage and
a worst-case figure — every abstention assumed wrong — next to the headline, so an
under-labeled corpus cannot masquerade as a passing one.

**What the gate reports today.** `annotations/human/` is empty. Running
`pnpm --filter @agenthropic/core exec vitest run test/hierarchy-gate.test.ts` therefore
prints `SUBSTRATE UNAVAILABLE - not measured` for each missing substrate and
`Phase-3 exit clause: NOT MEASURED - no hand-labeled sessions`, points at
`packages/test-fixtures/annotations/README.md`, and returns **NOT CERTIFIED**. The test
itself passes in that state, and the code says why in a comment at the branch: *nothing
to certify on this machine — do not manufacture a verdict*. This is the distinction the
whole subsystem is built around. A build that fails because a human has not done a manual
task teaches a team to route around the check; a build that green-washes an unmeasured
gate is worse. Passing while loudly reporting `n = 0` and refusing to certify is the only
option that is both honest about the state and honest about the number.

Until those templates come back filled in, **every hierarchy-accuracy figure anywhere in
this corpus is PROVISIONAL** and the Phase-3 exit clause is unmet — not failed, unmeasured.

## 4. The three P0 release-blocker tests

Three tests are named **release-blockers**: they must be green **and merge-blocking**
in CI before Phase 3 — projection, the DAG moat, reconciliation, cost — can be
considered done, and no other feature work substitutes for them
(development-plan §3, Phase 3 exit gate; concept-analysis-v2 §4.3). The QA
lens calls the third one "the make-or-break test both externals omit"
(concept-analysis-v2 §4.3):

| # | Test | Proves |
|---|---|---|
| 1 | **Σ `token_usage` == JSONL exact**, per session | The ground-truth-tokens invariant holds in the *projected* data, not just the raw log — zero drift, no silent rounding, no double count. |
| 2 | **Double-replay → byte-identical DB state** | Replay-on-startup is deterministic and safe to run on every process start, not just theoretically pure. |
| 3 | **DAG-rebuild from JSONL alone**, after a simulated outage | The persisted `orchestration_edges` tree survives the exact failure mode it exists to survive. |

(concept-analysis-v2 §4.3, §6; development-plan §5, `WP-X3`: "Three P0 reconciliation
release-blocker tests. Σ`token_usage`==JSONL exact; double-replay byte-identical;
DAG-rebuild-from-JSONL-alone.") Ownership is split across two work packages by design:
`WP-X3` (QA/fixture track, deps `X2, IN10, IN7, D1`) owns the test bodies run against the
golden corpus from §2–3; `WP-IN13` (deps `IN10, IN9, X1`) wires them into CI as
"Reconciliation / idempotency / DAG-rebuild suite (P0 blockers). All three P0 tests green
in CI and blocking" (development-plan §5, `WP-IN13`). Both land at **wave 16**, alongside
the operator alerts endpoints — the last thing on the moat's own critical sub-chain
before release (development-plan §4, wave 16 and the "moat spine" note).

Two adjacent, non-P0 bars sharpen what "passing" is allowed to mean, and both are scored
against the same corpus:

- **Hierarchy correctness ≥95%**, not 100% — the QA lens judges 100% untestable on messy
  real sessions, and explicitly **holds stop-the-release authority** on this bar:
  "an 'almost-correct hierarchy' manufactures false trust and is worse than no graph"
  (concept-analysis-v2 §4.3).
- **A missing `SubagentStop` must resolve to an explicit "unknown" state** within the
  watchdog window, never a permanent "working" (concept-analysis-v2 §6; `WP-IN12`).

The full mechanics of *why* these three tests are structured this way — the
`events_raw` substrate, idempotency keys, replay-on-startup, and the contingent outbox —
are the architecture-level deep dive on
[ingest & reconciliation](../architecture/ingest-reconciliation.md) §10; this page is
the QA-process view: who owns the test body, what corpus it runs against, and where it
sits in the release gate.

## 5. The 12-scenario negative-test catalogue

`WP-X4` — **expanded negative-test catalogue (12 scenarios)** — requires that "each maps
to a CD/acceptance criterion" (development-plan §5, `WP-X4`). Its composition is
explicit in the consolidated test model (concept-analysis-v2 §4.3):

- **10 scenarios** carried over from an externally produced parallel report's own
  negative-test catalogue (referenced in concept-analysis-v2 as "EXPANDED" — one of the
  two externally produced parallel reports folded into this analysis; concept-analysis-v2,
  opening summary). These ten are now **recovered verbatim in §5.1** from the source docx
  per finding **LOST-7**; the individual scenario names are that report's §7.1 content.
- **Plus 2 scenarios added because the internal analysis judged the external catalogue
  incomplete for this system specifically**: **compaction-mid-session** and
  **`PreCompact` re-pricing** — "all ten EXPANDED §7.1 negative scenarios pass, plus
  compaction-mid-session and PreCompact re-pricing" (concept-analysis-v2 §6), correcting
  what the QA lens itself flags as the external catalogue "dropping the
  compaction case" outright (concept-analysis-v2 §4.3).

`WP-X4` depends on `WP-X2` (the labeled corpus + typed loader, §3), `WP-IN6` (the pure
Normalizer), and `WP-C4` (compaction-baseline repricing), and is scheduled at
**wave 14**, alongside the reconciliation/backfill and session-tree endpoints
(development-plan §4, wave 14; §5, `WP-X4`). That dependency set is itself informative
about the catalogue's shape: it has to exercise the Normalizer's handling of malformed
or unrecognized input (via `IN6`) and the cost engine's repricing path (via `C4`), not
only the reconciliation logic the three P0 tests already cover.

The base 10 of the catalogue are now recovered from the source in §5.1 (LOST-7); the
table below is the complementary **CD-anchored** view — the acceptance criteria elsewhere
in concept-analysis-v2 §6 and the CD register (§3) name the concrete, individually
testable conditions the catalogue has to trace to, each the kind of scenario "mapped to a
CD/acceptance criterion" that `WP-X4`'s Done-when requires:

| Traceable condition | CD / WP | Category |
|---|---|---|
| An unknown `event_type` is stored, not crashed | CD-2; development-plan §3, Phase 2 exit gate | Ingest robustness |
| Kill+restart resumes JSONL tail-follow at the persisted offset, zero loss/dup | development-plan §3, Phase 2 exit gate | Ingest robustness |
| Missing `SubagentStop` → explicit "unknown" within the watchdog window | concept-analysis-v2 §6; `WP-IN12` | Live-flow honesty |
| A `PreCompact` session reprices correctly against its preserved baseline | concept-analysis-v2 §6; `WP-C4` | Cost correctness |
| A fixture model with no price row **FAILS CI** | concept-analysis-v2 §6; `WP-C6` | Cost correctness |
| `events_raw` exposes no UPDATE/DELETE path | CD-4, CD-7; concept-analysis-v2 §6 | Data integrity |
| Server **fails startup** when `DASHBOARD_TOKEN` is unset | CD-7 | Security |
| No-spawner grep/static gate fails the build on a `child_process` import | CD-7; `WP-F5` | Security |
| An SSRF test proves no outbound dial to a payload-supplied URL | CD-7; `WP-F5` | Security |
| SSE rejects a cross-origin connection | CD-5, CD-7 | Security |

This table is illustrative of the *categories and traceable anchors* the 12-scenario
catalogue draws from in this project's own decision set — it is not a claim that these
are the literal, final 12 entries. The literal **base 10** originate in the external
report's §7.1; they are now recovered verbatim in §5.1 below (finding **LOST-7**).

## 5.1 The recovered EXPANDED §7.1 base catalogue (10 scenarios) — LOST-7

The ten literal scenarios below are the external EXPANDED report's own §7.1 negative-test
catalogue, recovered from the EXPANDED external report (internal source material, not
published in this repo) per
corpus-audit finding **LOST-7** ([`corpus-audit-2026-07-06.md`](../../analysis/corpus-audit-2026-07-06.md)
§4.3). They are the **base 10** of `WP-X4`'s 12-scenario catalogue; the remaining two
(**compaction-mid-session** and **`PreCompact` re-pricing**) are the project-specific
additions described in §5 above (concept-analysis-v2 §6). The *expected-behavior* column
is quoted from the source; the *maps to* column is this project's decision anchor. Two
scenarios were **hardened** as they crossed into the plan of record — flagged inline.

| # | Scenario (EXPANDED §7.1) | Expected behavior (source) | Maps to (CD / NFR / WP) |
|---|---|---|---|
| 1 | **Duplicate hook event** | No duplicate normalized event or double token total. | CD-2 idempotency-keyed `events_raw`; **NFR-DATA-02**; P0 double-replay test (§4). |
| 2 | **`SubagentStop` arrives before `SubagentStart`** | Raw event stored; normalized anomaly flagged; UI shows uncertain edge. | CD-2/CD-3; anomaly + watchdog state (`WP-IN12`); relates to **OPEN-2** (`'unknown'` missing from the `agents.status` CHECK). |
| 3 | **Missing parent id** | Agent marked orphan / pending reparent; no fake root unless explicitly synthesized. | CD-4 self-ref `parent_agent_id`, orphan-safe self-FK (`WP-D6`); **NFR-DATA-01**. |
| 4 | **Malformed JSON** | 400 error; no DB mutation except optional audit log. | CD-2 ingest schema validation (**FR-01**). *Distinct from* the §5 anchor "an unknown `event_type` is stored, not crashed" — this one **rejects**, that one **accepts-and-stores**. |
| 5 | **Unauthenticated POST** | 401/403; no raw event stored. | CD-7 mandatory `DASHBOARD_TOKEN`; **NFR-SEC-02**. |
| 6 | **Invalid-token timing-attack attempt** | Timing-safe compare; no differentiated error leak. | CD-7 timing-safe `DASHBOARD_TOKEN` compare; **NFR-SEC-02**. |
| 7 | **Connection from a foreign origin** _(hardened: WS → SSE)_ | Rejected. | CD-5 same-origin **SSE** (transport corrected from the source's "WebSocket" per CD-5/ADR-0007), CD-7. Overlaps §5's "SSE rejects a cross-origin connection". |
| 8 | **Unknown model pricing** _(hardened)_ | Token counts shown; cost marked unknown/estimated, **not silently zero**. | CD-3/CD-4; the "estimated, never silent zero" rule governs **runtime** display. **Project hardening:** at fixture/build time a model with **no price row FAILS CI** (`WP-C6`) — a stricter gate the source did not have; both hold, at different times. |
| 9 | **Huge payload** | Rejected or truncated per policy; no UI lockup. | Payload-size + redaction policy (CD-10); **NFR-PERF-01** (no UI lockup — render budget). |
| 10 | **Server restart mid-session** | Session resumes / marks stale via watchdog; raw events intact. | CD-1 replay-on-startup; **NFR-OPS-01**; P0 double-replay test (§4). **Refinement:** the project's watchdog separates **stale** (idle session) from **"unknown"** (an agent whose `SubagentStop` never arrived, `WP-IN12`); the source folded both into "stale". |

**Reconciliation with `WP-X4`'s 12 and §5's illustrative anchors.** `WP-X4`'s catalogue =
these 10 + compaction-mid-session + `PreCompact` re-pricing (concept-analysis-v2 §6), so
the recovered 10 are a strict **subset** — no conflict, no duplication. Where the recovered
scenarios **overlap** the §5 illustrative anchor table, they are the same control seen from
the negative-test angle: #5/#6 ↔ "Server fails startup when `DASHBOARD_TOKEN` is unset" +
the timing-safe compare (one CD-7 control, three distinct assertions — keep all three);
#7 ↔ "SSE rejects a cross-origin connection"; #8 ↔ "a fixture model with no price row
FAILS CI" (`WP-C6`, the hardened build-time facet); #10 ↔ "kill+restart resumes JSONL
tail-follow at the persisted offset" + P0 test #2.

Where the recovered scenarios fill a **gap** — EXPANDED entries with *no* row in §5's
illustrative anchor table, implicit in acceptance criteria but never enumerated as negative
scenarios — the value of the recovery concentrates: **#1** duplicate-hook dedup, **#3**
missing-parent-id orphaning, **#4** malformed-JSON rejection (as distinct from the
accept-and-store `event_type` case), and **#9** huge-payload handling. These four are the
scenarios `WP-X4` most needs written as explicit test bodies.

## 6. The coverage gate: specified at >90%, shipped at 100

The coverage bar is a canonical decision, not a style preference: CD-7 states plainly
that "the coverage gate [is a] boundary condition from commit one, CI-blocking… >90%
coverage blocks merges" (concept-analysis-v2 §3, CD-7), and the build-sequencing
principle underneath it is that "the security invariants and the >90% coverage gate are
load-bearing from Phase 1 — not a hardening pass at the end" (implementation-plan.md
§B.0). Three work packages implement it end to end:

| WP | Owner | What it does |
|---|---|---|
| `WP-F3` | qa | **Vitest coverage harness + >90% gate config** (scope defined). Produces `lcov` + `json-summary` output. |
| `WP-F4` | devops | **CI pipeline skeleton** (GitHub Actions) with the coverage gate **blocking merges**. |
| `WP-X5` | devops | **CI coverage gate (>90%, blocking) live from Phase 1.** A PR dropping below the threshold is blocked, **demonstrated** as such. |

(development-plan §5, `WP-F3`/`WP-F4`/`WP-X5`.) All three land in **wave 6–7**, ahead of
any ingest feature code (development-plan §4, waves 6–7; §7, "security + coverage go
live at Phase 1, never deferred"), and CD-7's coverage-gate obligation is itself
implemented by `WP-X5` in the CD-coverage matrix (development-plan §6, CD-7 row).

**Scope is resolved explicitly, not left ambiguous.** The open scope question the gap
analysis raised — whether the shipped UI would be quietly exempted from the bar — is
resolved by *not* exempting it: the web package "counts toward the >90% gate" once
Phase 4 ships it (development-plan §3, Phase 4 exit gate), and alerts modules are held
to the same ">90% covered" bar once the alert track ships them (development-plan §3,
Phase 6 exit gate — post-1.0 per best-path §6.1; `WP-A10`). The one deliberate
carve-out — the labeled-experimental vector-DB stub — no longer exists: `WP-X11` was
**deleted per best-path §6.3 (applied 2026-07-06)**, so no coverage exemption remains
in scope.

**A concrete illustration of "coverage from commit one" in practice:** `WP-F7`'s
security-invariant contract tests (loopback bind, token compare, SSE origin) are
committed **intentionally red** at wave 8, before the server bootstrap (`WP-U0`) exists
to make them pass at wave 9 — "do not merge `WP-F7` as 'passing'; its DoD is jointly
owned with `WP-U0`" (development-plan §7). The same red-then-green discipline the
coverage gate enforces for ordinary unit tests is applied deliberately to the security
suite, not relaxed for it — see [security model](../security/model.md) for the control
catalogue those contract tests protect.

## 6.1 As built: why the number is 100, and what stops it being bought

The gate that shipped is stricter than the gate that was specified. All five packages —
`apps/server`, `apps/web`, `packages/core`, `packages/shared`, `packages/test-fixtures` —
run `vitest run --coverage` and pin `lines`, `branches`, `functions` and `statements` at
`100`, and as of 2026-08-15 all five sit at 100 on all four. The reasoning is written into
the configs themselves, in a comment repeated in each: *a 90% bar on a package sitting at
100% licenses a ten-point regression to pass in silence, which is the opposite of a gate.*
A threshold is only load-bearing when it is set at the level the code actually holds. Set
lower, it does not measure the code; it measures how far the code is allowed to fall
before anyone is told.

That raises the obvious objection: a 100% figure is exactly the kind of number that gets
manufactured. There are three ways to buy one, and each has a test that reads the source
as **text** and never imports it, so a mock or a stub cannot satisfy it.

| The cheat | What it actually does | The guard |
|---|---|---|
| An ignore pragma — `/* v8 ignore */`, `/* c8 ignore */`, `/* istanbul ignore */` | Removes **both** arms of the operator from the denominator, so the uncovered arm stops existing rather than starts being tested | Every file under `src/**` is swept; the offender list must be empty |
| Lowering the threshold | The bar moves to wherever the code happens to be | The config is read as text and each of the four numbers must literally be `100` |
| Adding an `exclude` | A file that is never measured cannot lower the average | The config must contain `include: ['src/**']` and must **not** contain `exclude` |

The guards live in `apps/server/test/coverage-honesty.test.ts` and its counterparts in
`packages/core`, `packages/shared` and `packages/test-fixtures`, plus the
`coverage honesty` block in `apps/web/test/honesty.test.tsx`. Their premise is stated in
the server file's header and is the same premise as the ground-truth-tokens invariant
this whole project is built on: *a coverage figure inflated by hiding code is the same
category of lie as an inferred token count.*

The corollary the guards enforce is that **the remedy for a genuinely unreachable branch
is to delete it, not to hide it.** There is a worked instance of this in the history of
`apps/server`: the branch threshold sat at 99 while `server.ts` carried an unreachable
`??` fallback — Fastify types `request.url` as `string`, so the alternative arm was dead
code. The arm was deleted and the threshold raised to 100. Suppressing it with a pragma
would have produced the same headline number by removing *both* arms from the
denominator, which is the cosmetic version of the same move and the reason the pragma is
banned outright rather than merely discouraged.

**Three asymmetries in that story, stated rather than smoothed over.**

First, `apps/web` does carry an `exclude`: `src/main.tsx` and `src/vite-env.d.ts`.
`main.tsx` is the DOM entry point — a mount call exercised by the browser, not by jsdom —
and is excluded on the same reasoning as a CLI entry point. The exclusion is narrow and
named, but it means `apps/web` is the one package whose 100 is over a set of files chosen
by hand rather than over everything under `src/**`. Worth recording alongside it: seven
type-defensive `??` arms in `src/views/layout/cost-flow.ts` used to be excluded and are
now genuinely reached, through the exported `toFlowNode` / `toFlowLink` converters and an
injectable `pathFor` seam — the exclusion list shrank by being tested away rather than by
being argued away.

Second, and directly downstream of the first, `apps/web`'s honesty test is weaker than the
other four. It sweeps `src/` for pragmas and asserts the offender list is empty, but it
does **not** assert the four thresholds and it does **not** assert the absence of further
`exclude` entries — it cannot, since the package legitimately has one. The practical
consequence is that a change widening the web exclude list, or lowering the web
thresholds, would not trip a guard. That is a real gap in the mechanism, not a
technicality.

Third, 100% means 100% of `src/**` — not of the repository. Every package's coverage
`include` is `src/**`, so two areas of live code never enter a denominator at all:
`hooks/install.mjs`, which is exercised in earnest by `apps/server/test/hooks-installer.test.ts`
against a throwaway temp directory but is measured by nothing; and the two CI gate scripts
`scripts/check-no-spawner.mjs` and `scripts/check-licenses.mjs`, which have no unit tests
whatsoever and are exercised only by being executed in CI. Both gates do run on every CI
invocation and both currently pass — the spawner gate reports `OK (235 files scanned
across 4 roots + repo-root config; 1 allowlisted)` and the license gate `OK (412 installed
packages, all licenses allowlisted)`, measured 2026-08-15 — but "the gate script works" is
established by its output, not by a test of the script.

And the standing caveat that no coverage number escapes: 100% line and branch coverage
records that every line and branch **executed**, not that every behaviour was
**asserted**. It is a floor under the test suite, not a statement about its depth. What
gives this suite its actual weight is the material in §3.1, §4 and §5 — an independent
reader in the token proof, byte-identical replay snapshots, and twelve enumerated ways
the system is expected to fail well.

## 7. Where this lands on the roadmap

| Phase | Wave(s) | Testing-relevant exit gate |
|---|---|---|
| **0 — Feasibility spike** | 1–4 | `WP-S1`'s paired corpus + Ivan-labeled trees captured; `WP-S7` reads `GO`/`CONDITIONAL-GO` on the evidence they produced. |
| **1 — Foundation, security spine, storage, ports** | 6–8 | Coverage harness + CI gate **green & blocking** (`WP-F3`, `WP-F4`, `WP-X5`); golden fixture corpus promoted and labeled (`WP-X1`, `WP-X2`); `WP-F7`'s security contract tests exist, deliberately red. |
| **3 — Projection, the DAG moat, reconciliation, cost** | 14, 16 | **Three P0 tests green & merge-blocking**; hierarchy ≥95% vs. the labeled corpus; 12-scenario negative catalogue green (`WP-X3`, `WP-X4`, `WP-IN13`). |
| **4 — Read API + SPA** | — | Web package counts toward the >90% gate. |
| **6 — Alert-track release hardening** *(post-1.0 per best-path §6.1; the operator alerts UI `WP-A8`/`WP-A9` was cut per §6.2)* | 17 | Alerts modules >90% covered; `RELEASE.md` enumerates every CD-7 gate with a verification step (`WP-A10`, `WP-X9`). |

(development-plan §3, §4.) The hard structural point: none of this is a procedural
checklist an agent could skip under time pressure — `WP-F1` (the monorepo scaffold
itself) has a real dependency edge on `WP-S7`, and `WP-IN13`/`WP-X3` are wired as
**blocking** CI checks, not advisory ones (development-plan §1, §5). Two corrections to
that table from the as-built note: the coverage figure it calls ">90%" is 100 in every
package that shipped, and "blocking" describes the intent rather than the current
mechanism — the workflow runs on every push and pull request, but branch protection on
`main` has not been enabled, so nothing physically withholds a merge.

## What's undecided

- **The 12 negative-catalogue test bodies are written** — the item that stood open here
  is closed. The literal base 10 were recovered in §5.1 from the external report's §7.1
  (finding LOST-7), and all twelve now exist as executable tests, split between
  `packages/core/test/negative/` (parser and cost facets) and `apps/server/test/negative/`
  (HTTP, persistence and security facets). Two source-level readings the recovery
  surfaced are settled in the tests themselves: scenario #7 is asserted against **SSE**
  (CD-5 supersedes the source's "WebSocket", and the test proves it by checking the
  `text/event-stream` content type), and scenario #8 holds at both times — build-time
  `no-price-row-FAILS-CI` and a runtime halt that never degrades to a silent `$0`. What
  is genuinely still open is the clause of scenario #2 that asks for a "normalized
  anomaly flagged": there is no hook normalizer to flag it in, so the anomaly is observed
  through the watchdog instead and the gap is recorded in the test file.
- **Where the corpus physically lives in the repo** is settled: `packages/test-fixtures`,
  which is now a real workspace package carrying seven typed fixtures, the annotation
  corpus, and its own coverage gate.
- **The redaction rule and the retention TTL** are still open, and remain the owner's to
  set. The retention *mechanism* has since been built in `apps/server/src/retention/`,
  but its default policy is a byte-identical no-op and every concrete number — what to
  prune, after how long, with what backup floor — is deliberately unset pending
  ratification (concept-analysis-v2 §7, open question 6; OPEN-1/2/3). See
  [backup & restore](../operations/backup-restore.md).
- **The join key behind `token_usage.agent_id`** (`WP-S3`, G0.1b) turned out not to need
  the confidence-scored heuristic the open question contemplated. Attribution is a hard
  structural key: `extractUsageRows()` in `packages/core/src/parser/parse-session.ts`
  stamps each usage row with the owner of the transcript file the line was read from, and
  usage in the main transcript is stamped `null` rather than attributed to a guess. That
  is why the P0 token-reconciliation test can assert **integer** equality per session, per
  model, per bucket instead of a tolerance. What has *not* been ratified is the accuracy
  of the surrounding hierarchy attribution — that is the §3.1 gate, and it is unmeasured.

## See also

- [Contributing overview](index.md) — the Global Definition of Done this page's gates
  are one clause of, and the one-WP-one-agent delivery model that schedules them.
- [Ingest & reconciliation](../architecture/ingest-reconciliation.md) — the `events_raw`
  substrate, idempotency keys, and replay-on-startup mechanics the three P0 tests prove
  correct.
- [The DAG moat](../architecture/dag-moat.md) — the dual-path `orchestration_edges`
  derivation the DAG-rebuild test and the deep-nesting/two-instances pathologies exist
  to validate.
- [Cost model](../architecture/cost-model.md) — the `PreCompact` re-pricing case and the
  no-priceless-model-fails-CI gate (`WP-C6`).
- [Security model](../security/model.md) — the loopback/token/no-spawner/no-SSRF
  invariants the security-flavored negative-catalogue entries in §5 trace to.
- [Roadmap](../guide/roadmap.md) — the full phase-by-phase build sequence this page's
  waves slot into.
- [Licensing & provenance](licensing.md) — the CI provenance scan that is CD-7's/CD-9's
  sibling build-failing gate to the coverage bar.
- [Decisions (ADRs)](decisions/README.md) — CD-7 and CD-8 as individual ADRs.
- [`development-plan.md`](../../analysis/development-plan.md) — the full Track X
  work-package catalog (`WP-X1`…`WP-X10`; `WP-X11` deleted per best-path §6.3), waves,
  and Global Definition of Done (§8).
- [`concept-analysis-v2.md`](../../analysis/concept-analysis-v2.md) §4.3, §6 — the QA
  lens verdict and the quantified acceptance criteria in full.
