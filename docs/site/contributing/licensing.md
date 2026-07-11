# Licensing & provenance

`agenthropic` is a greenfield build that deliberately reuses patterns from six
audited rival projects ([the moat](../guide/the-moat.md), [`DESIGN.md` §7](../../ai/DESIGN.md))
without inheriting any of their licensing risk. The rule that makes that possible —
**concept-analysis-v2's CD-9**, load-bearing on **LB2** ("personal-first /
commercial-clean") — is per-artifact, not per-project: `cast`, `disler`, and
`nirdiamant` ship no real open-source license, so under the Berne Convention's
default they are **all-rights-reserved**, and their patterns are **clean-room
reimplemented** from a written description, never copied from source; `simple10`
and `hoangsonww` carry a real MIT `LICENSE` file, so their code is **copied with
attribution**. This page is the full per-artifact ledger, the legal reasoning
(idea vs. expression) behind why clean-room reimplementation is safe and copying
source text is not, and exactly how CI enforces the boundary — including the
important limit of what that CI gate can and cannot prove
(concept-analysis-v2 [§2](../../analysis/concept-analysis-v2.md) LB2,
[§3](../../analysis/concept-analysis-v2.md) CD-9; development-plan
[`WP-F5`/`WP-F6`](../../analysis/development-plan.md)).

## 1. The rule, in one table

| Project | License fact | Mode | Governing decision |
|---|---|---|---|
| `simple10` | **MIT + real `LICENSE` file** (© 2025 Joe Johnston) — [`due-diligence/projects/simple10.md`](../../due-diligence/projects/simple10.md) | **COPY, with attribution** | CD-9 |
| `hoangsonww` | **MIT + real `LICENSE` file** — [`due-diligence/projects/hoangsonww.md`](../../due-diligence/projects/hoangsonww.md) | **COPY, with attribution** | CD-9 |
| `cast` | `package.json` sets `private: true`, **no `license` field, no `LICENSE` file**; "MIT" appears only as a README badge — [`due-diligence/projects/cast.md`](../../due-diligence/projects/cast.md) | **CLEAN-ROOM** (never view source while writing) | CD-9 |
| `disler` | `private: true`, **no `license` field, no `LICENSE` file** — [`due-diligence/projects/disler.md`](../../due-diligence/projects/disler.md) | **CLEAN-ROOM, teaching reference only** | CD-9 |
| `nirdiamant` | **MIT declared, but no `LICENSE` file** — [`due-diligence/projects/nirdiamant.md`](../../due-diligence/projects/nirdiamant.md) | **CLEAN-ROOM** | CD-9 |

The line is drawn on **evidence of a real license grant**, not on a badge, a README
claim, or a maintainer's stated intent. `nirdiamant` is the sharpest illustration of
why: it *declares* MIT somewhere in its docs, but ships no `LICENSE` file — under
Berne, a bare declaration with no accompanying license text is not a grant, so it is
treated identically to `cast` and `disler`. concept-analysis-v2 states this as a
correction to looser language elsewhere in the source material: `cast`/`disler`/
`nirdiamant` are **all-rights-reserved by Berne default — not "ambiguous"**
(concept-analysis-v2 [CD-9](../../analysis/concept-analysis-v2.md)).

## 2. Why "no LICENSE file" means all-rights-reserved

Under the Berne Convention (which the US, and every jurisdiction relevant here,
implements), **copyright exists automatically on creation** — an author does not
have to register it, mark it, or declare it for it to apply. The default state of
any published source code is therefore **"all rights reserved,"** and permission to
copy, modify, or redistribute it exists **only** to the extent an explicit license
grants it. A repository with `private: true` in `package.json`, no `license` field,
and no `LICENSE` file has granted **no such permission** — a README badge that says
"MIT" is marketing copy, not a license text, and does not bind the copyright holder
to anything (concept-analysis-v2 [§4.5](../../analysis/concept-analysis-v2.md), Gap
#4: "**Licensing legal blocker** — infringement under commercial intent"; external
review: "no license = all-rights-reserved by the Berne default" —
[`external-docs-review.md`](../../analysis/external-docs-review.md)).

This is precisely the trap the due-diligence documents for all three uncopyable
projects:

- **`cast`** — "'MIT' appears only as a README badge — `package.json` has
  `private:true`, **no `license` field, and no LICENSE file** = all-rights-reserved
  by default" ([`projects/cast.md`](../../due-diligence/projects/cast.md)).
- **`disler`** — "**No license** — `private:true`, no `license` field →
  all-rights-reserved. A hard [commercial] blocker"
  ([`projects/disler.md`](../../due-diligence/projects/disler.md)).
- **`nirdiamant`** — "**No LICENSE file**, though MIT is declared"
  ([`projects/nirdiamant.md`](../../due-diligence/projects/nirdiamant.md)).

Contrast with the two copyable projects, both verified to carry an actual license
grant:

- **`simple10`** — "**MIT + real LICENSE** (© 2025 Joe Johnston)"
  ([`projects/simple10.md`](../../due-diligence/projects/simple10.md)).
- **`hoangsonww`** — "**MIT + LICENSE file**"
  ([`projects/hoangsonww.md`](../../due-diligence/projects/hoangsonww.md)).

## 3. "Steal the pattern," legally: idea vs. expression

`DESIGN.md` §7 and §0 use exactly this language — "*steal the best proven pieces*
from each project rather than inherit any one's baggage" — and Holistic lens
seam #4 in concept-analysis-v2 names the resulting tension directly: **"'steal
these patterns' collides with the flagship grafts being all-rights-reserved"**
(concept-analysis-v2 [§4.6](../../analysis/concept-analysis-v2.md)). CD-9 resolves
that tension with a distinction copyright law itself draws: copyright protects the
**expression** of an idea — the literal source text, its specific structuring,
naming, and phrasing — never the **idea, algorithm, or functional pattern**
underneath it. A `controlGate.ts`-shaped module that 404s non-safe HTTP verbs
unless a token is present, compares that token in constant time, and is mounted
before the router is an *idea* — a design pattern describable in a sentence, older
than any of these six repositories, and not owned by `cast`. The specific
`controlGate.ts` file — its exact variable names, control flow, comments, and line
arrangement — is `cast`'s **expression**, and that is what copyright protects.

CD-9 operationalizes "steal the idea, never the expression" as a **clean-room
process**, not a legal argument to be made after the fact:

> CLEAN-ROOM reimplement `cast` `controlGate` + delegation-savings and `nirdiamant`
> checkpoint (**never view their source while writing**). Enforced by a CI
> provenance/license scan.
> — concept-analysis-v2 [CD-9](../../analysis/concept-analysis-v2.md)

Concretely, for every clean-room artifact in §5 below, the workflow is:

1. Read the **due-diligence description** of the pattern — the file/line evidence
   and the prose explanation already captured in `docs/due-diligence/projects/*.md`
   (e.g., "read-only by default: non-safe HTTP verbs return 404 unless
   `CAST_DASHBOARD_CONTROL=1` **and** `DASHBOARD_TOKEN` are set… constant-time token
   compare (`timingSafeEqual`); mounted **before** the router" —
   [`projects/cast.md`](../../due-diligence/projects/cast.md)).
2. **Never open the source repository itself** while writing the reimplementation —
   the entire point of clean-room process is that the author of the new code has no
   opportunity to reproduce the original's specific expression, even unconsciously,
   because they never looked at it during authoring.
3. Write the agenthropic version from the *idea* alone, in agenthropic's own naming,
   structure, and TypeScript idioms, against agenthropic's own schema and ports.
4. Re-verify anything numeric independently rather than trusting the source's
   values — e.g., `cast`'s pricing table is flagged as "hardcoded and likely stale
   — re-verify model rates before trusting dollar figures"
   ([`due-diligence/projects/cast.md`](../../due-diligence/projects/cast.md); DESIGN.md
   §7 restates this as "re-verify the hardcoded pricing table"); a clean-room
   reimplementation inherits none of the original author's possibly-wrong constants
   by default, and must not silently re-import them.

This is exactly the discipline named as risk mitigation in `best-path-decision.md`'s
risk register: **"Licensing contamination — clean-room ideas copied while reading
all-rights-reserved source, baking infringement into git history"** is mitigated by
"never open[ing] cast/disler/nirdiamant source while authoring; copy only
simple10/hoangsonww with attribution" (`best-path-decision.md` §8, risk 5).

> **What clean-room reimplementation is *not*.** It is not a license to reproduce
> the original's distinctive expression from memory after having read it, and it is
> not a shortcut that skips writing real, independent code. If a pattern is so
> constrained that there is essentially only one way to express it (the
> merger doctrine, e.g., a one-line SQL `WHERE` clause), that narrow expression may
> not be protectable regardless — but nothing in this codebase's clean-room
> artifacts is that trivial, so the project does not lean on that argument. The
> operating rule is the stricter one: never view the source while writing, full
> stop.

## 4. Copy-with-attribution: what it means for `simple10` and `hoangsonww`

For the two MIT-licensed projects, CD-9 permits taking the code itself, not merely
the idea — subject to preserving attribution as the MIT license requires (retaining
copyright/permission notices). `DESIGN.md` §7 and the-moat.md §5 name exactly what
is grafted from each:

| From | What is copied | Where it lands |
|---|---|---|
| `simple10` | Ports/adapters storage; strategy-pattern agent classes; `buildAgentTree()`/`layoutTree()` tree algorithm (not its storage model — see below); `AGENTS_OBSERVE_RUNTIME=local` under `launchd` (no Docker daemon) | Structural base, tree rendering ([architecture overview](../architecture/overview.md), [the DAG moat](../architecture/dag-moat.md)) |
| `hoangsonww` | `formatTelegram` webhook provider; `alert_rules`/`webhook_targets`/`webhook_deliveries` schema ~~; dual SQLite driver (`better-sqlite3` + `node:sqlite` fallback)~~ *(dual-driver item dropped per best-path §6.3, applied 2026-07-06 — single `better-sqlite3` driver)* | Phase 5 alerting, post-1.0 (`WP-A2`, [data model](../architecture/data-model.md) — "Alert & webhook schema migration (clean-room-safe, **hoangsonww-attributed**). Forward-only, idempotent.") |

Two boundary notes that matter as much as the "copy" verdict itself:

- **Copying is scoped to the specific artifact, not the whole repository.**
  `simple10`'s tree algorithm is copied; its storage model — session-scoped,
  event-derived, non-persisted edges — is explicitly **not**, because
  `agenthropic`'s moat requires persisted, per-instance `orchestration_edges`
  that `simple10` doesn't have ([the moat §2.1](../guide/the-moat.md#21-global-persistent-per-instance-orchestration-dag)).
  `hoangsonww`'s Telegram/webhook code is copied; its `/api/run` spawner route is
  never mounted, ever — see §5 below and [security model, rule 3](../security/model.md#3-never-a-browser-driven-subprocess--claude-spawner).
- **"With attribution" is the MIT license's own requirement**, not an
  agenthropic-specific courtesy: MIT requires the copyright and permission notice
  be included in copies of the software. The concrete mechanism for satisfying
  this in the agenthropic repository (a `NOTICE`/`THIRD-PARTY-NOTICES` file, an
  inline file-header comment, or a `contributing/` credits page) is **not yet
  decided** in the source docs — see [What's undecided](#whats-undecided) below.

## 5. The full per-artifact ledger

Consolidating `DESIGN.md` §7, the-moat.md §5, and architecture/overview.md's
"patterns we steal" table into the single canonical reference:

| From | Pattern | License fact | Mode | Why |
|---|---|---|---|---|
| `simple10` | Ports/adapters storage + strategy-pattern agent classes; `buildAgentTree()`/`layoutTree()`; `AGENTS_OBSERVE_RUNTIME=local` under `launchd` | MIT + real `LICENSE` | **COPY, attributed** | Cleanest, most portable base architecture |
| `hoangsonww` | `formatTelegram` webhook provider; `alert_rules`/`webhook_targets` schema ~~; dual SQLite driver~~ *(dropped per best-path §6.3 — single `better-sqlite3` driver)* | MIT + real `LICENSE` | **COPY, attributed** | Easiest Telegram bridge |
| `cast` | `controlGate.ts` shape (~73 LOC: read-only by default, non-safe verbs 404 unless token, `timingSafeEqual`, mounted before router); delegation-savings formula (~50 LOC, re-price at top-tier rates) | `private:true`, no `license` field, no `LICENSE` (badge only) | **CLEAN-ROOM** | Drop-in auth-gate shape; the cost-moat formula — reimplemented from the pattern description, re-verifying the pricing table, never by reading `cast`'s source while writing ours |
| `disler` | `send_event.py` (~180-LOC) hook→HTTP→SQLite→WS ingest loop | `private:true`, no `license` field, no `LICENSE` | **CLEAN-ROOM, teaching reference only** | Clearest example of the ingest loop shape; never built on directly |
| `nirdiamant` | git `stash` + tag run-checkpoint | MIT declared, no `LICENSE` file | **CLEAN-ROOM** | Non-destructive session snapshots |

Two artifacts deserve a specific carve-out beyond "clean-room vs. copy," because
they are patterns this project explicitly **studies but never builds**, regardless
of license:

- **`hoangsonww`'s `/api/run` spawner.** Even though `hoangsonww` is MIT-licensed
  and its Telegram provider is copied wholesale, the spawner route
  (`server/routes/run.js`, accepting `permission-mode` from the request body with
  `bypassPermissions` in its allow-list) is never mounted, under any license terms
  — this is a security prohibition ([security model rule 3](../security/model.md#3-never-a-browser-driven-subprocess--claude-spawner)),
  independent of and layered on top of the licensing rule. The due-diligence notes
  it is "cleanly excisable — ~6 files + one mount line + one table"
  ([`projects/hoangsonww.md`](../../due-diligence/projects/hoangsonww.md)), which is
  exactly the boundary `WP-F5` enforces in CI (§6 below).
- **`disler`'s SSRF-vulnerable webhook dial.** `disler`'s server dials an arbitrary
  `responseWebSocketUrl` taken from the request payload
  (`index.ts:198-201` per due-diligence) — the teaching value of `send_event.py` is
  the ingest *shape*, explicitly not this bug. `agenthropic`'s webhook targets are
  always operator-configured, never payload-derived
  ([security model rule 6](../security/model.md#6-no-ssrf--never-dial-a-url-taken-from-an-event-payload)).

## 6. CI enforcement — what the gates actually check

CD-9 states the enforcement mechanism plainly: **"Enforced by a CI
provenance/license scan."** In the development plan, this decomposes into two
distinct, Phase 1 work packages that land in the same CI wave (wave 8, alongside
`WP-F7`'s security-contract tests and `WP-D3`'s migration runner —
development-plan [§4](../../analysis/development-plan.md)):

```
Phase 1 — Foundation, security spine, storage, ports
└── Wave 8: Security static gates + primitives+RED contract tests, migration runner
    ├── WP-F5  Static no-spawner + no-SSRF gate      (owner: security, deps: WP-F4)
    ├── WP-F6  License/provenance scan (CD-9)        (owner: security, deps: WP-F4)
    ├── WP-F7  Security-invariant contract tests
    └── WP-D3  Migration runner
```

### `WP-F6` — License/provenance scan (the licensing gate proper)

Done-when, verbatim from the work-package catalog: **"A non-allowlisted dependency
license makes CI red"** (development-plan [`WP-F6`](../../analysis/development-plan.md)).
This is a **dependency-license allowlist scan** over `package.json`/the pnpm
lockfile: every npm package the monorepo actually depends on must resolve to a
license on an allowlist (permissive licenses such as MIT/Apache-2.0/BSD would be
the obvious candidates given the project's own MIT posture, but the specific
allowlist is not enumerated anywhere in the source docs — see
[What's undecided](#whats-undecided)). If a dependency's declared license falls
outside that allowlist, the build fails. This is the automatable half of CD-9: it
protects the codebase from **accidentally pulling in a restrictively-licensed npm
package as a dependency**.

### `WP-F5` — Static no-spawner + no-SSRF gate (the adjacent security gate)

Done-when: **"Planting a `child_process` import in `apps/server` makes CI red"**
(development-plan [`WP-F5`](../../analysis/development-plan.md)). This gate is
listed alongside `WP-F6` in the task scope because it is the concrete enforcement
that the one MIT-attributed, wholesale-copyable project — `hoangsonww` — cannot
smuggle its RCE spawner in alongside its Telegram provider: a static grep/AST check
over `apps/server` fails the build the moment any `child_process` import appears,
regardless of which file introduced it or why (see [security model, rule
3](../security/model.md#3-never-a-browser-driven-subprocess--claude-spawner)). It
is a security gate first and a provenance gate second — but because the one
artifact this project *does* copy wholesale (`hoangsonww`'s webhook code) sits one
file away from the exact route this gate exists to forbid, it functions as part of
the same per-artifact scoping discipline that CD-9 describes.

### Phase and release gates that reference both

| Gate | Statement | Source |
|---|---|---|
| Phase 1 exit gate | "no-spawner/no-SSRF/**license gates green**" | development-plan [§3](../../analysis/development-plan.md) |
| Phase 6 exit gate | `RELEASE.md` enumerates "every CD-7 build-failing gate **+ CD-9 provenance check** + an exercised backup restore" | development-plan [§3](../../analysis/development-plan.md), `WP-X9` |
| Global Definition of Done (every WP) | "No all-rights-reserved code copied (clean-room for cast/disler/nirdiamant; attribution for simple10/hoangsonww), **verified by the CI provenance scan**" | development-plan [§8](../../analysis/development-plan.md) |
| MVP acceptance criteria | "No all-rights-reserved code ships (clean-room for cast/disler/nirdiamant; attribution for simple10/hoangsonww), verified by a CI provenance check" | concept-analysis-v2 [§6](../../analysis/concept-analysis-v2.md) |

### What the CI gate can prove, and what it cannot

This distinction matters enough to state explicitly, because it is easy to
over-claim what a static scan buys you. `best-path-decision.md`'s own review of the
plan calls out exactly this over-claim as a defect to correct: reasoning that leans
on `WP-F6` for legal safety **"overstates that `WP-F6` (dependency-license scan)
enforces the clean-room *copying* rule (it doesn't — that's discipline)"**
(`best-path-decision.md`, commercial-optionality finding).

- **`WP-F6` can prove:** no *dependency* pulled in via `package.json` carries a
  disallowed license. This is a fully automatable, machine-checkable fact.
- **`WP-F6` cannot prove:** that a human author did not read `cast`'s
  `controlGate.ts` or `nirdiamant`'s checkpoint script and then write something
  structurally similar from memory. There is no static-analysis technique that
  reliably distinguishes "independently reimplemented from a written description"
  from "recalled after reading the original" — that guarantee comes entirely from
  **process discipline** (never opening the source repository while authoring,
  per §3 above), reinforced by code review and the fact that the due-diligence
  descriptions this project works from are themselves short, abstract prose
  (a sentence or two per pattern), not the original source.

In short: the CI gate is real and merge-blocking, but it enforces the
**dependency-license** half of CD-9 mechanically; the **clean-room-authorship**
half of CD-9 is enforced by the documented workflow in §3, not by a script. Both
halves are required for CD-9 to hold; neither substitutes for the other.

## 7. Why this is load-bearing: LB2

CD-9 does not stand alone — it is one of the two consequences of **LB2**,
concept-analysis-v2's second load-bearing decision (**"personal-first /
commercial-clean"**):

> Build the single-user Mac Mini cockpit; take only the **cheap** commercial
> hedges now (MIT-clean code only; `instance`/`host_id` on every row from the
> first migration; a schema that does not *block* tenancy); explicitly **defer**
> fleet and multi-tenancy.
> — concept-analysis-v2 [§2](../../analysis/concept-analysis-v2.md), LB2

The reasoning that makes LB2 hold together, stated directly: **"the constraints
happen to align: the copyable repos (simple10, hoangsonww) carry the *large*
patterns (tree-building, webhook/alert schema), while the uncopyable ones
(cast/disler/nirdiamant) carry only *small* ideas cheap to reimplement
clean-room"** (concept-analysis-v2 [§2](../../analysis/concept-analysis-v2.md)).
That is not a coincidence this project can take credit for — it is a fact about
the underlying market (the two most feature-complete/popular repositories happen
to be the MIT-licensed ones) that LB2 exploits rather than fights. If the
constraint had cut the other way — if the large, structurally valuable patterns
were locked behind all-rights-reserved code — clean-room reimplementation would be
a materially larger engineering investment, and LB2's "cheap hedge" framing would
not hold.

LB2 also names an explicit, still-open dependency of licensing strictness on
commercial intent: the **"OPCⁿ" commercial-line token**, which "leaked from BASE
into the internal docs and must be defined or dropped" before it "drives
tenancy/schema/license-strictness investment" (concept-analysis-v2
[§4.4](../../analysis/concept-analysis-v2.md), Business Analyst lens; [§2](../../analysis/concept-analysis-v2.md)
LB2). Concretely: the clean-room rule in this document is the bar for a
**personal-first** posture. If a genuinely commercial line of the product is ever
defined, licensing strictness (and possibly the copy-with-attribution calls for
`simple10`/`hoangsonww` too, since MIT compliance obligations can interact
differently with redistribution-for-profit) would need re-review at that time —
but per LB2, that investment is explicitly deferred until "OPCⁿ" is defined or the
token is dropped. As of this writing it remains undefined
(concept-analysis-v2 [§5](../../analysis/concept-analysis-v2.md), Weaknesses:
"'OPCⁿ' commercial identity is undefined yet has propagated into the internal
docs").

## What's undecided

This is a design-basis page, not a shipped-CI-config page — several mechanics are
named as a rule but not yet a concrete implementation. Stated explicitly:

- **The dependency-license allowlist itself** (which SPDX identifiers `WP-F6`
  accepts — MIT/Apache-2.0/BSD-\*/ISC are the obvious permissive candidates given
  the project's own posture, but no source doc enumerates the list) is not yet
  written.
- **The specific tool/technique behind `WP-F6`** (an off-the-shelf
  license-checker package vs. a hand-rolled script over the pnpm lockfile) is not
  named in any source document — `WP-F6`'s Done-when specifies the observable
  behavior ("a non-allowlisted dependency license makes CI red"), not the
  implementation.
- **The attribution mechanism for `simple10`/`hoangsonww`** (a root `NOTICE` /
  `THIRD-PARTY-NOTICES` file, per-file header comments, or a credits section in
  [contributing: overview](index.md)) is not specified anywhere in the source
  material.
- **Whether the provenance scan ever grows beyond dependency licenses** — e.g., a
  future check that greps for verbatim string matches against the all-rights-reserved
  repositories' source — is not proposed anywhere in the source docs; §6 above is
  explicit that today's `WP-F6` is dependency-license-only, and the
  clean-room-authorship half of CD-9 relies on discipline, not tooling.

## See also

- [The moat](../guide/the-moat.md) §5 — the same per-artifact table framed as "why
  we steal these specific pieces," with the DAG/cost/Telegram feature context.
- [Architecture overview](../architecture/overview.md) — "Patterns we steal, not
  the repos," the same ledger in the context of the ingest-loop diagram.
- [Cost model](../architecture/cost-model.md) §8 — the delegation-savings formula
  as the concrete example of a clean-room reimplementation end to end.
- [Security model](../security/model.md), rule 2 and rule 3 — `cast`'s
  `controlGate` shape and why `hoangsonww`'s spawner is never mounted, regardless
  of its MIT license.
- [Data model](../architecture/data-model.md) — the alert/webhook schema migration
  (`WP-A2`) marked "clean-room-safe, hoangsonww-attributed."
- [Contributing: overview](index.md) — dev setup, PR flow, and the one-WP-one-agent
  model this licensing rule is checked against at PR time.
- [Contributing: testing & quality](testing.md) — the merge-blocking coverage gate
  that runs alongside `WP-F5`/`WP-F6` in CI.
- [Contributing: governance](governance.md) — the PR-template checklist item that
  points back to this page.
- [Decisions (ADRs)](decisions/README.md) — the full ADR index; the LB-2 ADR
  ([`adr-lb-2-personal-first-commercial-clean.md`](decisions/adr-lb-2-personal-first-commercial-clean.md))
  named CD-9 as a forthcoming follow-up, and that follow-up is now recorded as
  [ADR-0011](decisions/adr-cd-9-per-artifact-licensing.md), "CD-9 — Per-artifact
  licensing" (status: accepted).
