# Testing & quality

This page is the QA reference for agenthropic: how the **golden real-session fixture
corpus** is captured, promoted, and labeled with ground truth; the **three P0
release-blocker tests** that must be green and merge-blocking before Phase 3 is
considered done; the **12-scenario negative-test catalogue**; and the **merge-blocking
>90% coverage gate** that is live from Phase 1, not a hardening pass bolted on at the
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

## 6. The merge-blocking >90% coverage gate

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
**blocking** CI checks, not advisory ones (development-plan §1, §5).

## What's undecided

- **The literal 10 base entries of the negative-test catalogue** are now **recovered** in
  §5.1 from the external report's §7.1 (finding LOST-7); together with the two v1-only
  additions (compaction-mid-session, `PreCompact` re-pricing) that gives the full
  12-scenario enumeration. What remains open is only the **`WP-X4` test bodies** — writing
  each of the 12 as an executable, corpus-scored test with its CD/acceptance-criterion
  assertion — plus two source-level items the recovery surfaced: the WS→SSE wording of
  scenario #7 (CD-5 supersedes the source) and the runtime-"estimated" vs build-time
  "no-price-row-FAILS-CI" split of scenario #8 (`WP-C6`).
- **Where the corpus physically lives in the repo** — a dedicated `packages/test-fixtures`
  package is a named leaning for the eventual monorepo layout, not a locked decision
  (see [architecture overview](../architecture/overview.md)); stack and repo structure
  are an open decision project-wide.
- **The redaction rule and retention TTL** that the corpus's "redacted" tier has to
  implement are named as open Phase-0 inputs, not fixed policy numbers yet
  (concept-analysis-v2 §7, open question 6).
- **The join-key mechanism** behind `token_usage.agent_id` backfill (`WP-S3`, G0.1b) —
  hard key vs. confidence-scored heuristic — is undecided and would change what the
  P0 token-reconciliation test and the negative catalogue's backfill scenario are
  actually allowed to assert (concept-analysis-v2 §7, open question 2; see
  [ingest & reconciliation](../architecture/ingest-reconciliation.md)).

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
