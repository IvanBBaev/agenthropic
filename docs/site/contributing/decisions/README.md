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

## How to read this set

Start with **LB1** and **LB2** — concept-analysis-v2 is explicit that "everything hangs off
these; if either is wrong the rest is wasted motion" (§2). CD-1…CD-10 are the build-facing
canonical register (§3); several of them directly operationalize LB1 or LB2 (see the
"Consolidates" column below). Every ADR cites its exact source section and, where one exists,
copies the **quantified acceptance criteria** verbatim from
[`concept-analysis-v2.md`](../../../analysis/concept-analysis-v2.md) §6 rather than restating
them loosely.

## Index

The **As-built (2026-07-30)** column is the verdict from each ADR's appended as-built section.
It is deliberately blunt: a decision that was overridden says so.

| ADR | Tag | Title | Status | As-built (2026-07-30) | File |
|---|---|---|---|---|---|
| ADR-0001 | **LB1** | Ingest primacy (the data-foundation seam) | accepted | **built, criterion unverified** — resolved JSONL-primary and shipped; the ≥95%-vs-labeled-golden-corpus criterion has **never been measured** (no labelled corpus exists; thresholds PROVISIONAL) | [adr-lb-1-ingest-primacy.md](adr-lb-1-ingest-primacy.md) |
| ADR-0002 | **LB2** | Identity: personal-first / commercial-clean | accepted | **holds on scope; hedge shipped narrower** — no fleet/multi-tenancy built; `instance`/`host_id` landed on `orchestration_edges` only, not "every row"; "OPCⁿ" still undefined | [adr-lb-2-personal-first-commercial-clean.md](adr-lb-2-personal-first-commercial-clean.md) |
| ADR-0003 | CD-1 | Ingest source of truth, decided by the Phase-0 diff | accepted | **holds, strengthened** — JSONL is the sole structural source, hooks are liveness-only, and a P0 proof asserts hook events cannot alter the DAG | [adr-cd-1-ingest-source-of-truth.md](adr-cd-1-ingest-source-of-truth.md) |
| ADR-0004 | CD-2 | Single immutable substrate + deterministic projection | accepted | **amended in practice** — immutability shipped (triggers + idempotency key + byte-identical replay); the Normalizer → Projection pair was never built, and `events_raw` holds hook events only | [adr-cd-2-immutable-substrate-projection.md](adr-cd-2-immutable-substrate-projection.md) |
| ADR-0005 | CD-3 | Reconciliation precedence | accepted | **partly moot as built** — JSONL-authoritative tokens hold and are P0-proven; the cross-source precedence and two-phase `agent_id` backfill were never needed | [adr-cd-3-reconciliation-precedence.md](adr-cd-3-reconciliation-precedence.md) |
| ADR-0006 | CD-4 | Schema: events_raw/events, orchestration_edges, token_usage, model_pricing | accepted | **holds in substance, amended in detail** — all tables exist and are written (`events` included, after a period of created-but-never-written); five named column-level divergences from the sketch | [adr-cd-4-schema-events-and-orchestration.md](adr-cd-4-schema-events-and-orchestration.md) |
| ADR-0007 | CD-5 | Transport is SSE with same-origin enforcement | accepted | **holds, built as decided** — SSE only, same-origin checked before auth; open item: `Last-Event-ID` replay not built | [adr-cd-5-transport-sse.md](adr-cd-5-transport-sse.md) |
| ADR-0008 | CD-6 | Ports & adapters: the named port set | accepted | **principle holds; port set smaller than drawn** — four seams shipped, not ten; second-runtime portability unproven | [adr-cd-6-ports-and-adapters.md](adr-cd-6-ports-and-adapters.md) |
| ADR-0009 | CD-7 | Security + the coverage gate are boundary conditions from commit one | accepted | **built and enforced** — every criterion is a failing build or a hard process exit; two honesty defects recorded, one criterion (no-SSRF) vacuous | [adr-cd-7-security-and-coverage-boundary.md](adr-cd-7-security-and-coverage-boundary.md) |
| ADR-0010 | CD-8 | Phase 0 is a throwaway GO/NO-GO feasibility spike | ~~accepted~~ **overridden 2026-07-11** | **OVERRIDDEN, not passed** — the hard ❌-stop was bypassed by explicit owner instruction; spike numbers remain PROVISIONAL; `WP-S3`/G0.1b never ran | [adr-cd-8-phase-0-spike.md](adr-cd-8-phase-0-spike.md) |
| ADR-0011 | CD-9 | Per-artifact licensing | accepted | **automatable half live and green** (412 packages OK); **open blocker:** the project's own `LICENSE` is untracked, so GitHub reports `license: null` | [adr-cd-9-per-artifact-licensing.md](adr-cd-9-per-artifact-licensing.md) |
| ADR-0012 | CD-10 | Scope, secrets & retention: MVP discipline for a solo owner | accepted | **partially built** — scope held, redaction shipped at the ingest boundary; **retention TTL not implemented**, blocked on OPEN-1/2/3 (Ivan's to decide) | [adr-cd-10-scope-secrets-retention.md](adr-cd-10-scope-secrets-retention.md) |
| ADR-0013 | — | Docs-site generator choice | **deferred** | **still deferred, deliberately** — `DOC-P1` has not run; the Pages pipeline shipped on the stock Jekyll builder with zero deps so it does not decide the generator; Pages not yet enabled | [adr-docs-site-generator.md](adr-docs-site-generator.md) |

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
