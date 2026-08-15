# Decisions (ADRs)

This page indexes the Architecture Decision Records (ADRs) for agenthropic — one file per
decision, following [`_adr-template.md`](_adr-template.md). There are **thirteen** ADRs: the
two **load-bearing** decisions (LB1, LB2) that everything else hangs off; the **ten canonical
decisions** (CD-1…CD-10) the build actually turns on, each consolidating the per-lens decisions
that agree on it; and one **deferred** decision for the docs-site generator itself. All twelve
concept-analysis decisions are recorded as `accepted` — they are the frozen output of the
six-lens re-analysis in [`concept-analysis-v2.md`](../../../analysis/concept-analysis-v2.md) —
but **`accepted` describes the decision, not the implementation**. Two of the twelve (LB1 and
its canonical form CD-1) were empirically **pre-answered `CONDITIONAL-GO` (confidence 85)** by
the 2026-07-04 desktop probe ([`phase0-probe.md`](../../../analysis/phase0-probe.md)).

> **Update — 2026-07-30 (as built).** When this index was written, no code had been scaffolded
> and the sentence above continued "…agenthropic is still in its bootstrap phase and no code has
> been scaffolded yet." That is no longer true: implementation began **2026-07-11**, by an
> explicit owner override of CD-8's hard stop — **an override, not a passed gate**
> ([ADR-0010](adr-cd-8-phase-0-spike.md)). Nor is "the formal Phase-0 spike still confirms them"
> still true as a forward-looking statement: the `WP-S7` GO gate was bypassed and never ran, so
> the pre-answer was never upgraded to a verdict. Every ADR below has therefore been read against
> the shipped code and carries an appended **`## As-built update — 2026-07-30`** section
> recording what was actually built and whether the decision still holds. The original Context /
> Decision / Acceptance criteria / Consequences / Alternatives text of every ADR is unchanged —
> see [Amending an ADR](_adr-template.md#amending-an-adr-how-this-repo-records-reality-disagreed).
> The **Status** column below now carries the as-built verdict, not just the decision status.

> **Update — 2026-08-15 (second as-built pass).** Every ADR was re-read against the shipped
> code, and twelve of the thirteen now carry a second appended section,
> **`## As-built update — 2026-08-15`**. Six were amended on substance — ADR-0002, ADR-0006,
> ADR-0008, ADR-0009, ADR-0011 and ADR-0012 — and six more on a single shared over-claim
> about enforcement (ADR-0001, ADR-0003, ADR-0004, ADR-0005, ADR-0007, ADR-0010; see
> [the standing correction](#a-standing-correction-merge-blocking) below). Only ADR-0013 needed
> nothing: it is still deferred, `DOC-P1` still has not run, and GitHub Pages is still not
> enabled. Rows below carry both verdicts — the 2026-07-30 reading first, the 2026-08-15 delta
> after it — because a row that silently replaced the older verdict would hide the direction of
> travel, which is the only thing an as-built column is good for. Some of the movement is
> forward (a fifth port; a retention mechanism; a published `MIT` grant), some of it goes both
> ways at once (ADR-0009: the coverage bar rose to 100 across five packages while its "blocks
> merges" clause stayed unmet), and **none of the pre-existing PROVISIONAL, LABEL-ME or
> UNMEASURED caveats was lifted.**

## How to read this set

Start with **LB1** and **LB2** — concept-analysis-v2 is explicit that "everything hangs off
these; if either is wrong the rest is wasted motion" (§2). CD-1…CD-10 are the build-facing
canonical register (§3); several of them directly operationalize LB1 or LB2 (see the
"Consolidates" column below). Every ADR cites its exact source section and, where one exists,
copies the **quantified acceptance criteria** verbatim from
[`concept-analysis-v2.md`](../../../analysis/concept-analysis-v2.md) §6 rather than restating
them loosely.

## Index

The **As-built verdict** column is the verdict from each ADR's appended as-built section, in
date order where there is more than one. It is deliberately blunt: a decision that was
overridden says so, and a decision only half met says which half.

| ADR | Tag | Title | Status | As-built verdict | File |
|---|---|---|---|---|---|
| ADR-0001 | **LB1** | Ingest primacy (the data-foundation seam) | accepted | **built, criterion unverified** — resolved JSONL-primary and shipped; the ≥95%-vs-labeled-golden-corpus criterion has **never been measured** (no labelled corpus exists; thresholds PROVISIONAL). **2026-08-15:** still unmeasured, and the P0 proofs it leans on are **CI-failing, not merge-blocking** ([standing correction](#a-standing-correction-merge-blocking)) | [adr-lb-1-ingest-primacy.md](adr-lb-1-ingest-primacy.md) |
| ADR-0002 | **LB2** | Identity: personal-first / commercial-clean | accepted | **holds on scope; hedge shipped narrower** — no fleet/multi-tenancy built; `instance`/`host_id` landed on `orchestration_edges` only, not "every row"; "OPCⁿ" still undefined. **2026-08-15:** commercial-clean is now *published* — `LICENSE` tracked, GitHub reports `MIT`; the one-table hedge, the undefined "OPCⁿ" and the **UNMEASURED** "< 30s" criterion are all unchanged | [adr-lb-2-personal-first-commercial-clean.md](adr-lb-2-personal-first-commercial-clean.md) |
| ADR-0003 | CD-1 | Ingest source of truth, decided by the Phase-0 diff | accepted | **holds, strengthened** — JSONL is the sole structural source, hooks are liveness-only, and a P0 proof asserts hook events cannot alter the DAG. **2026-08-15:** unchanged; that proof is **CI-failing, not merge-blocking** ([standing correction](#a-standing-correction-merge-blocking)), and the `WP-S7` gate this ADR's own criterion names still never ran | [adr-cd-1-ingest-source-of-truth.md](adr-cd-1-ingest-source-of-truth.md) |
| ADR-0004 | CD-2 | Single immutable substrate + deterministic projection | accepted | **amended in practice** — immutability shipped (triggers + idempotency key + byte-identical replay); the Normalizer → Projection pair was never built, and `events_raw` holds hook events only. **2026-08-15:** thirteen migrations in, still no UPDATE/DELETE path; the abort test is **CI-failing, not merge-blocking**, but the triggers that do the enforcing sit inside the database, below CI ([standing correction](#a-standing-correction-merge-blocking)) | [adr-cd-2-immutable-substrate-projection.md](adr-cd-2-immutable-substrate-projection.md) |
| ADR-0005 | CD-3 | Reconciliation precedence | accepted | **partly moot as built** — JSONL-authoritative tokens hold and are P0-proven; the cross-source precedence and two-phase `agent_id` backfill were never needed. **2026-08-15:** unchanged; the reconciliation proof is **CI-failing, not merge-blocking** ([standing correction](#a-standing-correction-merge-blocking)), and the thresholds it runs against stay **PROVISIONAL** | [adr-cd-3-reconciliation-precedence.md](adr-cd-3-reconciliation-precedence.md) |
| ADR-0006 | CD-4 | Schema: events_raw/events, orchestration_edges, token_usage, model_pricing | accepted | **holds in substance, amended in detail** — all tables exist and are written (`events` included, after a period of created-but-never-written); five named column-level divergences from the sketch. **2026-08-15:** thirteen migrations, not seven; `orchestration_edges.source` admits a fifth value (`legacy_explore`, a name-based heuristic that stays **PROVISIONAL** — no real pre-2.1.71 transcript has ratified it); migration 11 records a seed edited in place after the operator DB had applied it, repaired by a forward migration rather than by rewriting history | [adr-cd-4-schema-events-and-orchestration.md](adr-cd-4-schema-events-and-orchestration.md) |
| ADR-0007 | CD-5 | Transport is SSE with same-origin enforcement | accepted | **holds, built as decided** — SSE only, same-origin checked before auth; open item: `Last-Event-ID` replay not built. **2026-08-15:** unchanged, resumability still absent; the origin and auth assertions are **CI-failing, not merge-blocking** ([standing correction](#a-standing-correction-merge-blocking)) | [adr-cd-5-transport-sse.md](adr-cd-5-transport-sse.md) |
| ADR-0008 | CD-6 | Ports & adapters: the named port set | accepted | **principle holds; port set smaller than drawn** — four seams shipped, not ten; second-runtime portability unproven. **2026-08-15:** a fifth seam has since been named (`RetentionPort`, the one port carrying a *policy* rather than a *driver* distinction); portability still **unproven** — nothing has been ported | [adr-cd-6-ports-and-adapters.md](adr-cd-6-ports-and-adapters.md) |
| ADR-0009 | CD-7 | Security + the coverage gate are boundary conditions from commit one | accepted | **built and enforced** — every criterion is a failing build or a hard process exit; two honesty defects recorded, one criterion (no-SSRF) vacuous. **2026-08-15: half met.** The coverage bar rose to **100 across five packages** (stricter than the >90% specified), but "**blocks merges**" is **false** — `main` is not branch-protected, so a red run is a signal, not a barrier | [adr-cd-7-security-and-coverage-boundary.md](adr-cd-7-security-and-coverage-boundary.md) |
| ADR-0010 | CD-8 | Phase 0 is a throwaway GO/NO-GO feasibility spike | ~~accepted~~ **overridden 2026-07-11** | **OVERRIDDEN, not passed** — the hard ❌-stop was bypassed by explicit owner instruction; spike numbers remain PROVISIONAL; `WP-S3`/G0.1b never ran. **2026-08-15:** no part of the override has been retired — `WP-S7` still has not run, every Phase-0 figure is still **PROVISIONAL (LABEL-ME)**, and the P0 proofs offered in its place are **CI-failing, not merge-blocking** ([standing correction](#a-standing-correction-merge-blocking)) | [adr-cd-8-phase-0-spike.md](adr-cd-8-phase-0-spike.md) |
| ADR-0011 | CD-9 | Per-artifact licensing | accepted | **automatable half live and green** (412 packages OK); ~~**open blocker:** the project's own `LICENSE` is untracked, so GitHub reports `license: null`~~ *(closed — `LICENSE` tracked, GitHub reports `MIT`, re-verified 2026-08-15)*. **2026-08-15:** the gate **verifies** but does not block a merge; the clean-room half is still discipline, not tooling | [adr-cd-9-per-artifact-licensing.md](adr-cd-9-per-artifact-licensing.md) |
| ADR-0012 | CD-10 | Scope, secrets & retention: MVP discipline for a solo owner | accepted | **partially built** — scope held, redaction shipped at the ingest boundary; ~~**retention TTL not implemented**~~ *(2026-08-15 — the retention **mechanism** now exists and is tested; the **policy** is unset and the row-level runner is called only by tests, so "unbounded local storage growth" is still **not mitigated**)*; blocked on OPEN-1/2/3 (Ivan's to decide) | [adr-cd-10-scope-secrets-retention.md](adr-cd-10-scope-secrets-retention.md) |
| ADR-0013 | — | Docs-site generator choice | **deferred** | **still deferred, deliberately** — `DOC-P1` has not run; the Pages pipeline shipped on the stock Jekyll builder with zero deps so it does not decide the generator; Pages still not enabled — `gh api repos/IvanBBaev/agenthropic/pages` answers `404 Not Found`, re-verified 2026-08-15, so the workflow has never published a site | [adr-docs-site-generator.md](adr-docs-site-generator.md) |

### A standing correction: "merge-blocking"

Six of the as-built sections dated 2026-07-30 describe a test as **merge-blocking** — the
P0 outage-rebuild and double-replay proofs (ADR-0001), the P0 DAG-rebuild proof that
asserts hook events cannot alter the DAG (ADR-0003), the append-only abort test on
`events_raw` (ADR-0004), the P0 token-reconciliation proof (ADR-0005), the origin and
wrong-token negative catalogue (ADR-0007), and the three P0 proofs cited as independent
evidence (ADR-0010).

Read every one of them as **"runs in CI on every push and pull request, and fails the run
when violated."** That much is true and verifiable. What none of them does is withhold a
merge: `gh api repos/IvanBBaev/agenthropic/branches/main/protection` answers
`404 Branch not protected`, re-verified on 2026-08-15. The tests are real and their
failures are loud; the setting that turns a red run into a blocked merge button has never
been switched on. It is an owner action on github.com, and no commit in this repository can
perform it — which is exactly why the correction is recorded rather than fixed.

The distinction matters least where the guarantee lives below CI. `events_raw` immutability
(ADR-0004) is enforced by SQLite triggers inside the database file and holds whether or not
a test ever runs; the loopback bind and the token check (ADR-0009) are process-level
refusals to start. Where the distinction matters most is everywhere else: a P0 proof that
nobody is stopped from merging past is a smoke alarm, not a door lock. Each affected ADR
carries the same note locally, so the correction sits where the claim is rather than only
here.

## What each decision consolidates

From [`concept-analysis-v2.md`](../../../analysis/concept-analysis-v2.md) §3, the per-lens
decision IDs each canonical decision folds together (`AD*` Architect, `SD*` Developer, `QA-D*`
QA, `BA-D*` Business, `G-D*` Gap, `LB*`/`H-*` Holistic):

| ADR | Consolidates |
|---|---|
| LB1 | (the make-or-break unknown itself; see also `H-SEQ`) |
| LB2 | (the identity/scope-vs-licensing tension itself) |
| CD-1 | LB1, AD3, SD3, G-D1 |
| CD-2 | AD1, SD2 |
| CD-3 | AD2, SD4 |
| CD-4 | AD4, G-D6, SD5 |
| CD-5 | AD5 |
| CD-6 | AD6, SD1 |
| CD-7 | AD7, SD8, QA-D3, QA-D4, G-D3, H-SEQ |
| CD-8 | AD-Phase0, G-D2, H-SEQ |
| CD-9 | SD6, BA-D4, G-D4, LB2 |
| CD-10 | BA-D1, BA-D3, G-D7, AD8, SD7, LB2 |

## Grouped by theme

For navigating by concern rather than by ID:

- **Data foundation & reconciliation:** LB1, CD-1, CD-2, CD-3, CD-4 — see also
  [ingest & reconciliation](../../architecture/ingest-reconciliation.md),
  [the data model](../../architecture/data-model.md), [the DAG moat](../../architecture/dag-moat.md).
- **Transport & structure:** CD-5, CD-6 — see also
  [architecture overview](../../architecture/overview.md).
- **Security & delivery gates:** CD-7, CD-8 — see also
  [the security model](../../security/model.md) (flagship page),
  [backup & restore](../../operations/backup-restore.md).
- **Product, licensing & scope:** LB2, CD-9, CD-10 — see also
  [licensing](../licensing.md), [the roadmap](../../guide/roadmap.md).
- **Docs infrastructure (deferred):** the generator ADR (ADR-0013) — see also
  [`docs/DOCS-PLAN.md`](../../../DOCS-PLAN.md).

## Status legend

Per [`_adr-template.md`](_adr-template.md):

| Status | Meaning here |
|---|---|
| `proposed` | Under discussion; not yet a decision of record. *(none currently — the concept-analysis-v2 workflow settled LB1/LB2/CD-1…CD-10 directly to `accepted`.)* |
| `accepted` | The decision is locked as the design of record. Does **not** imply the corresponding code matches it — check the As-built column. |
| `deferred` | A decision is explicitly not yet made; the ADR records the context/criteria/candidates so the eventual choice has a fixed target to execute against. Currently only ADR-0013. |
| `superseded by ADR-NNN` | A later ADR replaces this one. None yet. |

### As-built verdicts

ADRs are **immutable historical records**: the decision text is never rewritten to match what
was later built. Divergence is recorded by **appending** a dated
`## As-built update — YYYY-MM-DD` section and updating only the `Status:` metadata line — the
mechanism is specified in
[`_adr-template.md` → Amending an ADR](_adr-template.md#amending-an-adr-how-this-repo-records-reality-disagreed).
The verdict vocabulary used in the As-built column above:

| Verdict | Meaning |
|---|---|
| `holds` | Built as decided. Nothing to correct. |
| `holds, strengthened` | Built as decided, and the implementation enforces the decision more tightly than the ADR required. |
| `amended in practice` | The intent survived; the mechanism differs from what the ADR specified. The divergence is named, not smoothed over. |
| `partially built` | Part of the decision shipped and part did not. The unshipped part is named, along with what blocks it and on whom. |
| `overridden` | Work proceeded without the decision's condition being met. Names who overrode it and when. **An override is never recorded as a pass.** |
| `superseded by ADR-NNN` | A later ADR replaces this one; the `Status:` line moves too. |

Two ADRs (0001, 0010) also carry an earlier `## Empirical update — 2026-07-04 desktop probe`
section. That convention is for **new evidence that does not change what was built**; the
`As-built update` heading is for divergence between the decision and the shipped code. Both
are append-only and both remain in the file.

## Relationship to the source analysis and the build plan

These ADRs are a **restatement in ADR form**, not a new decision-making pass: every claim
traces to [`concept-analysis-v2.md`](../../../analysis/concept-analysis-v2.md) §2 (LB1, LB2) and
§3 (CD-1…CD-10), with acceptance criteria copied from its §6, and — for the docs-generator
ADR only — to [`docs/DOCS-PLAN.md`](../../../DOCS-PLAN.md) §3 (`DOC-P1`). Each ADR's
Consequences → Follow-ups cites the corresponding work packages in
[`development-plan.md`](../../../analysis/development-plan.md), which decomposes CD-1…CD-10
into the actual build. Open, cross-cutting work (the Phase-0 spike outcome) is tracked in
[`../../../../TODO.md`](../../../../TODO.md). The still-undefined **"OPCⁿ"** commercial
token is a separate open item recorded in
[ADR-0002](adr-lb-2-personal-first-commercial-clean.md)'s Follow-ups — not re-litigated
here.
