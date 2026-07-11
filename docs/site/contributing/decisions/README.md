# Decisions (ADRs)

This page indexes the Architecture Decision Records (ADRs) for agenthropic — one file per
decision, following [`_adr-template.md`](_adr-template.md). There are **thirteen** ADRs: the
two **load-bearing** decisions (LB1, LB2) that everything else hangs off; the **ten canonical
decisions** (CD-1…CD-10) the build actually turns on, each consolidating the per-lens decisions
that agree on it; and one **deferred** decision for the docs-site generator itself. All twelve
concept-analysis decisions are recorded as `accepted` — they are the frozen output of the
six-lens re-analysis in [`concept-analysis-v2.md`](../../../analysis/concept-analysis-v2.md) —
but **`accepted` describes the decision, not the implementation**: per the repo's `CLAUDE.md`,
agenthropic is still in its bootstrap phase and **no code has been scaffolded yet**. Two of the
twelve (LB1 and its canonical form CD-1) were empirically **pre-answered `CONDITIONAL-GO`
(confidence 85)** by the 2026-07-04 desktop probe
([`phase0-probe.md`](../../../analysis/phase0-probe.md)); the formal Phase-0 spike still confirms
them on the paired-capture corpus, so that pre-answer — spike pending — is called out in each
ADR's Status line.

## How to read this set

Start with **LB1** and **LB2** — concept-analysis-v2 is explicit that "everything hangs off
these; if either is wrong the rest is wasted motion" (§2). CD-1…CD-10 are the build-facing
canonical register (§3); several of them directly operationalize LB1 or LB2 (see the
"Consolidates" column below). Every ADR cites its exact source section and, where one exists,
copies the **quantified acceptance criteria** verbatim from
[`concept-analysis-v2.md`](../../../analysis/concept-analysis-v2.md) §6 rather than restating
them loosely.

## Index

| ADR | Tag | Title | Status | File |
|---|---|---|---|---|
| ADR-0001 | **LB1** | Ingest primacy (the data-foundation seam) | accepted (pre-answered CONDITIONAL-GO by the 2026-07-04 desktop probe; formal spike pending) | [adr-lb-1-ingest-primacy.md](adr-lb-1-ingest-primacy.md) |
| ADR-0002 | **LB2** | Identity: personal-first / commercial-clean | accepted | [adr-lb-2-personal-first-commercial-clean.md](adr-lb-2-personal-first-commercial-clean.md) |
| ADR-0003 | CD-1 | Ingest source of truth, decided by the Phase-0 diff | accepted (pre-answered CONDITIONAL-GO by the 2026-07-04 desktop probe; formal spike pending) | [adr-cd-1-ingest-source-of-truth.md](adr-cd-1-ingest-source-of-truth.md) |
| ADR-0004 | CD-2 | Single immutable substrate + deterministic projection | accepted | [adr-cd-2-immutable-substrate-projection.md](adr-cd-2-immutable-substrate-projection.md) |
| ADR-0005 | CD-3 | Reconciliation precedence | accepted | [adr-cd-3-reconciliation-precedence.md](adr-cd-3-reconciliation-precedence.md) |
| ADR-0006 | CD-4 | Schema: events_raw/events, orchestration_edges, token_usage, model_pricing | accepted | [adr-cd-4-schema-events-and-orchestration.md](adr-cd-4-schema-events-and-orchestration.md) |
| ADR-0007 | CD-5 | Transport is SSE with same-origin enforcement | accepted | [adr-cd-5-transport-sse.md](adr-cd-5-transport-sse.md) |
| ADR-0008 | CD-6 | Ports & adapters: the named port set | accepted | [adr-cd-6-ports-and-adapters.md](adr-cd-6-ports-and-adapters.md) |
| ADR-0009 | CD-7 | Security + the coverage gate are boundary conditions from commit one | accepted | [adr-cd-7-security-and-coverage-boundary.md](adr-cd-7-security-and-coverage-boundary.md) |
| ADR-0010 | CD-8 | Phase 0 is a throwaway GO/NO-GO feasibility spike | accepted | [adr-cd-8-phase-0-spike.md](adr-cd-8-phase-0-spike.md) |
| ADR-0011 | CD-9 | Per-artifact licensing | accepted | [adr-cd-9-per-artifact-licensing.md](adr-cd-9-per-artifact-licensing.md) |
| ADR-0012 | CD-10 | Scope, secrets & retention: MVP discipline for a solo owner | accepted | [adr-cd-10-scope-secrets-retention.md](adr-cd-10-scope-secrets-retention.md) |
| ADR-0013 | — | Docs-site generator choice | **deferred** | [adr-docs-site-generator.md](adr-docs-site-generator.md) |

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
| `accepted` | The decision is locked as the design of record. Does **not** imply the corresponding code exists yet — see the bootstrap-phase note above. |
| `deferred` | A decision is explicitly not yet made; the ADR records the context/criteria/candidates so the eventual choice has a fixed target to execute against. Currently only ADR-0013. |
| `superseded by ADR-NNN` | A later ADR replaces this one. None yet. |

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
