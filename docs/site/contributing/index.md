# Contributing overview

This page is the entry point for anyone about to work on agenthropic: what the repo is
trying to be, how to get a dev environment up (the scaffold exists as of 2026-07-11 —
the commands below are runnable), how work is decomposed and handed out, and the rules every
contribution — human or agent-authored — has to clear before it merges. The key
takeaway up front: agenthropic is built as **one work package (WP) → one agent → one
PR**, gated by a **merge-blocking >90% coverage bar** and a fixed set of security
invariants that apply from Phase 1 onward, every WP owes a `WORKLOG.md` entry, git
history carries **no AI attribution**, and **nothing gets committed or pushed without an
explicit ask** from the project owner. None of this is aspirational — it is the literal
Global Definition of Done in
[`development-plan.md`](../../analysis/development-plan.md) §8 and the conventions in
the project's own `CLAUDE.md` (see [Version-control conventions](#version-control-conventions)
below for why that file itself won't be in your checkout).

## Repo intent, in short

agenthropic is a **self-hosted, local-first dashboard for observing Claude Code agent
and subagent activity** — ingesting Claude Code's lifecycle hooks and the
ground-truth `~/.claude/projects/*.jsonl` transcripts into an owned SQLite database,
then rendering the resulting subagent tree, token cost, and (later) Telegram alerts.
It is a **greenfield clean build** in the spirit of a sibling project (`kiko`),
structured with **ports and adapters** so ingest, storage, cost, realtime, and alerting
each sit behind a named interface. Two invariants are non-negotiable design facts, not
implementation details, and every WP is checked against them:

- **Token counts are ground truth**, read from `~/.claude/projects/*.jsonl` — never
  inferred.
- **Agents and subagents are first-class, persisted, queryable entities** with a
  self-referential `parent_agent_id` — the subagent tree is a data fact the projection
  writes once, not something the browser reconstructs from a flat event log.

For the full pitch and the "why build instead of fork" argument, see
[What is agenthropic](../guide/what-is-agenthropic.md) and
[The moat](../guide/the-moat.md); for the architecture these invariants imply, see
[Architecture overview](../architecture/overview.md).

## Where the project stands today

> **Update — 2026-07 (as built).** The section below was written during the pre-code
> bootstrap phase and its answers are **no longer true**. Implementation began
> **2026-07-11**. The table has been rewritten with the real answers; the paragraph after
> it preserves why the original said what it said.

The scaffold exists and the commands in this guide are runnable:

| Question | Answer today (verified 2026-07-30) |
|---|---|
| Can I `pnpm install` and run something? | **Yes.** `pnpm install` against the committed `pnpm-lock.yaml`, then `pnpm --filter @agenthropic/server dev` (needs `DASHBOARD_TOKEN`) and `pnpm --filter @agenthropic/web dev`. |
| Is the stack decided? | **Locked and built**: Fastify + TypeBox, `better-sqlite3` (single driver), React/Vite/D3, SSE, in a pnpm monorepo — `apps/server`, `apps/web`, `packages/shared`, `packages/core`, `packages/test-fixtures`, `hooks/`. |
| What Node version? | **Node 22** (`engines.node: ">=22"`), `pnpm@11.11.0` pinned via `packageManager`. |
| When does the scaffold land? | It landed. `WP-F1`'s dependency on a `WP-S7` **GO** was resolved by an owner override, not by a GO — see the note below. |
| Where do lint/test commands come from? | They exist at the repo root: `pnpm run typecheck` · `lint` · `format:check` · `test` · `gate:spawner` · `gate:licenses`. |
| Is the test suite real? | **72 test files / 879 tests**, >90% coverage gated in every shipped package. See [Testing & quality](testing.md). |

[`TODO.md`](../../../TODO.md) at the repo root remains the live, authoritative status of
what's done vs. open, and [`DONE.md`](../../../DONE.md) Milestone 1 records the
implementation phase. The [Roadmap](../guide/roadmap.md) carries the checkpoint calendar.

### Why there was nothing to scaffold — and what changed

CD-8 (the Phase-0 hard-stop) meant **no production code — not even the monorepo
scaffold — before a throwaway feasibility spike returned a verdict.** That sequencing was
encoded as a literal dependency in the plan: `WP-F1` (the scaffold) depended on `WP-S7`
(the GO/NO-GO report), which itself depended on five upstream Phase-0 probes
(`WP-S2`…`WP-S6`) that empirically tested whether the subagent tree could be rebuilt from
the JSONL transcript alone. Two human approval gates sat above even that: Ivan had to
**approve the ten canonical decisions (CD-1…CD-10)** and **approve running Phase 0 at
all** (`TODO.md`, "Gate A").

**What actually happened, stated without varnish:** the spike ran and returned
**CONDITIONAL GO** — not GO. Implementation began on **2026-07-11** by an **explicit
owner override**, while some of the conditions were still open. Record it as an override,
never as a gate that was cleared. Two consequences that still bind today: the
spike-derived accuracy numbers remain **PROVISIONAL** until they are ratified against a
hand-labeled corpus, and the roadmap's kill checkpoints **KC-0 (2026-07-13) and KC-1
(2026-07-27) both passed unmet** — KC-1's third clause was *unsatisfiable by
construction*, because the friction log it referred to was never opened. A checkpoint
whose condition cannot be evaluated has not been passed; it was skipped. Work continues
because the owner said so, not because the evidence said so.

## Reading order before you touch anything

Per [`development-plan.md`](../../analysis/development-plan.md) §1, an implementing
agent (human or AI) should read, in this order:

1. `concept-analysis-v2.md` §3 (the CD-1…CD-10 decisions) and §6 (acceptance criteria).
2. The design basis (architecture, data model, hooks, security model — digested on this
   site under [Architecture](../architecture/overview.md) and
   [Security](../security/model.md)).
3. The project's `CLAUDE.md` — the non-negotiable security constraints in it apply to
   **every** WP, no exceptions.
4. Your assigned WP in [`development-plan.md`](../../analysis/development-plan.md) §5 —
   honour its `deps`, satisfy its Done-when.

## The work-package model: one WP → one agent → one PR

Every unit of work is a **WP** — sized S/M/L for a single agent's working session, with
explicit inputs, concrete deliverables, hard dependencies, a testable Done-when, and
the CD decision(s) it implements
([`development-plan.md`](../../analysis/development-plan.md) §1). The rule is
literal: **one WP, one agent, one PR.** No two WPs write the same file (five
duplicate-pair merges in the plan exist specifically to enforce this — pricing,
`events_raw` append, redaction, the hooks installer, and the storage substrate each
have exactly one owning WP).

```
WP defined (deps, Done-when, owner-agent type)
        │
        ▼
  deps all merged? ──no──► blocked, wait for the wave
        │ yes
        ▼
  one agent picks up the WP
        │
        ▼
  implements + tests to the Done-when
        │
        ▼
  PR: typecheck + lint + tests + coverage(>90%) + security/license gates
        │
        ▼
  merge ──► unblocks every WP that named this one in `deps`
```

### WP id scheme and owner-agent types

IDs follow `WP-<TRACK><n>`. Tracks: **S** Phase-0 spike, **F** Foundation/CI, **D**
Data, **IN** Ingest/Normalizer, **C** Cost, **U** Realtime + UI, **A** Alerts, **X**
Delivery/Docs/QA. Each WP is assigned to an **owner-agent type** specialised for it:
`ingest`, `data`, `backend`, `cost`, `frontend`, `devops`, `security`, `qa`, `docs`
([`development-plan.md`](../../analysis/development-plan.md) §1).

### Dependencies are hard, and waves are the schedule

An agent may only start a WP once **every** id in its `deps` is merged. The plan's
**17 topological waves** (§4) are the distribution schedule: every WP in wave *N* can
run concurrently once wave *N-1* is fully merged. The **GO/NO-GO gate is absolute** —
wave 4 (`WP-S7`) blocks all of wave 5 onward via the `WP-F1 → WP-S7` dependency. A
concrete illustration of how strictly "hard dependency" is meant: `WP-F7`'s security
contract tests are **written and merged intentionally red** at wave 8, and stay red
until `WP-U0` wires the loopback/token/origin primitives at wave 9 — the plan
explicitly warns "do not merge `WP-F7` as passing"; its Done-when is jointly owned with
`WP-U0` ([`development-plan.md`](../../analysis/development-plan.md) §7). Deps are not
a suggestion.

### Human-in-the-loop gates

A handful of WPs cannot be closed by an agent alone — they require Ivan's sign-off in
the loop, not just a passing test suite:

- **Gate A** — approving CD-1…CD-10 and approving that Phase 0 runs at all
  (`TODO.md`, "Now").
- **`WP-S1`** — Ivan hand-labels the expected subagent tree per captured session.
- **`WP-S5`** — Ivan signs off that the rendered tree nesting is correct (the "G0.3
  tree smoke gate").
- **`WP-S7`** — the GO / CONDITIONAL-GO / NO-GO verdict itself, which "gates all of
  Phase 1."

## The merge-blocking bar: Global Definition of Done

Every WP, in every phase, is held to the same bar
([`development-plan.md`](../../analysis/development-plan.md) §8):

- Touched code passes **typecheck + lint + tests**; coverage stays **>90%** — the gate
  is **merge-blocking from Phase 1 onward**, not a soft target added later.
- No security invariant is weakened: loopback-only bind, mandatory-token-or-fail-startup,
  SSE same-origin, no subprocess spawner, no SSRF, secrets never in SQLite/SSE/logs.
- Ground-truth tokens are **read, never inferred**; every displayed dollar traces to
  (tokens × a dated priced model).
- No all-rights-reserved code is copied (clean-room reimplementation for the
  all-rights-reserved reference projects; attribution for the two whose licenses permit
  copying), verified by the CI provenance scan.
- A `WORKLOG.md` entry is appended for each meaningful WP; AI-harness files stay
  git-excluded.

The **>90% coverage gate** specifically is not deferred: Phase 1's exit gate requires
it "green & blocking" (`WP-X5`, `WP-F3`/`WP-F4`), meaning a PR that drops coverage
below the threshold is rejected by CI, demonstrated as such, before any ingest feature
code is written. `WP-F7`'s security-contract tests and `WP-F5`/`WP-F6`'s static
no-spawner/no-SSRF/license gates land in the **same phase**, deliberately, so security
and coverage are live "from commit one," never bolted on at the end. Full mechanics —
the golden fixture corpus, the three P0 reconciliation tests, and the 12-scenario
negative catalogue — are covered on [Testing & quality](testing.md).

## WORKLOG discipline

Every project keeps a local `WORKLOG.md` — a session journal appended after each
meaningful task. It is git-excluded (see [Version-control
conventions](#version-control-conventions)), so it never appears in the public repo or
on this docs site; it exists purely as the project's own audit trail of what was done
and why. `WP-X10` — "WORKLOG discipline: template + presence check" — is the WP that
formalizes this as a checked convention rather than an informal habit: a template plus
a presence check that a WP isn't considered closed without a corresponding entry
([`TODO.md`](../../../TODO.md), [`development-plan.md`](../../analysis/development-plan.md)
Track X). It is one of only two dep-free work packages in wave 1 (alongside `WP-S1`),
so it is actionable immediately, ahead of any scaffold.

## Version-control conventions

Two rules apply to **every** commit in this repository, stated as-is in the project's
own `CLAUDE.md`:

- **No AI attribution in git history.** No `Co-Authored-By` trailers for an AI agent,
  no "Generated with …" lines in commit messages or PR descriptions.
- **Never commit or push without an explicit ask.** An agent completing a WP does not
  get to merge itself — a human (or an explicit instruction in the working session)
  authorizes the commit and the push.

A practical consequence for anyone cloning the repo fresh: **`CLAUDE.md`, `WORKLOG.md`,
`.claude/`, and `docs/ai/` are all git-excluded** (via `.git/info/exclude`, not
`.gitignore` — so the exclusion rule itself isn't committed either). If you're reading
this docs site, that's exactly what you're seeing: the durable design and process
documentation, republished from those local-only sources into `docs/site/`, without
the harness files themselves ever entering git history.

## Licensing & provenance

Per-artifact licensing is a canonical decision (CD-9), enforced by a CI provenance/
license scan, not left to reviewer memory: reference-project patterns copied from the
two permissively-licensed projects are attributed; patterns adapted from the three
all-rights-reserved-by-default reference projects are **clean-room reimplemented**
(never viewing their source while writing the equivalent). `WP-F6` is the WP that makes
a non-allowlisted dependency license fail CI red. Full rule, the per-project
attribution table, and the scan mechanics live on
[Licensing & provenance](licensing.md).

## Decisions and governance

The ten canonical decisions (CD-1…CD-10) plus the two load-bearing ones (LB1 ingest
primacy, LB2 personal-first/commercial-clean) are the constitution this whole plan
decomposes from. Each is recorded, or will be recorded, as an ADR using the standard
template at [`decisions/_adr-template.md`](decisions/_adr-template.md); the indexed set
lives at [Decisions](decisions/README.md). Repository governance — the security-report
path, code of conduct, and issue/PR templates — is documented on
[Governance](governance.md).

## See also

- [Testing & quality](testing.md) — the golden fixture corpus, the three P0
  reconciliation tests, the 12-scenario negative catalogue, and the coverage gate in
  detail.
- [Licensing & provenance](licensing.md) — the clean-room vs. attribution rule and the
  CI scan.
- [Decisions](decisions/README.md) — the ADR set for CD-1…CD-10 and LB1/LB2.
- [Governance](governance.md) — security-report path, code of conduct, issue/PR
  templates.
- [Roadmap](../guide/roadmap.md) — the phase-by-phase build sequence this guide's
  WPs slot into.
- [Security model](../security/model.md) — the invariants every WP's Done-when is
  checked against.
- [`development-plan.md`](../../analysis/development-plan.md) — the full 75-WP
  catalog, dependency DAG, waves, and Global Definition of Done (§8).
- [`TODO.md`](../../../TODO.md) / [`DONE.md`](../../../DONE.md) — live open work and
  completed milestones.
