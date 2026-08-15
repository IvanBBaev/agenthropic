# Licensing & provenance

`agenthropic` is a greenfield build that deliberately reuses patterns from six
audited rival projects ([the moat](../guide/the-moat.md), `DESIGN.md` §7)
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

> **Update — 2026-08 (as built; both gates re-run locally on 2026-08-15).** Both
> gates named in §6 exist, are wired into the root `package.json`, and run as named
> steps in [`.github/workflows/ci.yml`](https://github.com/IvanBBaev/agenthropic/blob/main/.github/workflows/ci.yml),
> so the CD-9 mechanism below is live rather than planned. The two figures quoted
> here are a dated measurement of the tree as it stood on 2026-08-15, not constants —
> both move with every dependency change and every added file.
>
> - **`WP-F6` — `pnpm run gate:licenses`** → [`scripts/check-licenses.mjs`](https://github.com/IvanBBaev/agenthropic/blob/main/scripts/check-licenses.mjs).
>   It enumerates every installed dependency in the workspace (prod + dev) via
>   `pnpm licenses list --json` and exits 1 on anything outside an explicit
>   allowlist — `MIT`, `MIT-0`, `ISC`, `Apache-2.0`, `BSD-2-Clause`, `BSD-3-Clause`,
>   `0BSD`, `BlueOak-1.0.0`, `CC0-1.0`, `Unlicense`, `Python-2.0` — with SPDX
>   expressions resolved properly (an `OR` passes if any branch is allowlisted, an
>   `AND` requires every part). There is exactly one documented per-package
>   exception, and it is keyed to an exact license string rather than to the package
>   name alone: `caniuse-lite` is accepted under `CC-BY-4.0` **and nothing else**,
>   an attribution-only data file pulled in transitively by the Vite toolchain — if
>   that package ever relicenses, the exception stops matching and the gate goes red
>   rather than waving it through. Workspace-local `@agenthropic/*` packages are
>   skipped as private, so the count is of third-party code only:
>   `check-licenses: OK (412 installed packages, all licenses allowlisted)`. The
>   first open question in [What's undecided](#whats-undecided) — "which SPDX
>   identifiers are on the allowlist" — is answered by that file; it is no longer
>   undecided.
> - **`WP-F5` — `pnpm run gate:spawner`** → `scripts/check-no-spawner.mjs`:
>   `check-no-spawner: OK (235 files scanned across 4 roots + repo-root config;
>   1 allowlisted)`. Its scope is wider than the work-package title suggests — it
>   walks `apps/`, `packages/`, `scripts/` and `hooks/` in full (source, tests, and
>   package-root config such as `vite.config.ts`, which is exactly where a dev-server
>   bind would be widened) plus the repo-root config files, and it forbids four
>   families of pattern, not one: the whole subprocess API surface, dynamic code
>   evaluation, wide network binds, and WebSocket servers. Sanctioned exceptions must
>   carry an inline `spawner-gate-allow` marker, and the only one in the repository is
>   the license scanner's own fixed-argv
>   `execFileSync('pnpm', ['licenses', 'list', '--json'])` — no shell, no
>   interpolation. One file is allowlisted wholesale, the gate script itself, because
>   it defines every forbidden pattern as a literal; that allowlisting is printed on
>   every run rather than applied silently.
>
> **Neither gate is physically merge-blocking.** Both run in CI on every push and
> pull request, and both fail the workflow correctly when violated — but branch
> protection on `main` is not enabled, so a red run does not prevent a merge. Where
> §6 below says the license gate is "merge-blocking," read that as the intended
> configuration, not the current one; see
> [governance](governance.md) for the open owner action.
>
> **§4's undecided attribution mechanism has not been decided, because nothing has
> triggered it.** No source text from any of the six audited projects has been
> copied into this repository. The two MIT rows in §5's ledger describe work that
> either was written from scratch anyway (the tree/layout code lives in
> `apps/web/src/views/layout/layered.ts` and `cost-flow.ts`, not a port of
> `simple10`'s) or has not been built at all (`hoangsonww`'s Telegram/webhook
> provider belongs to the alerts workstream, which is v2.0 and gated behind KC-5).
> Consequently there is no `NOTICE` or `THIRD-PARTY-NOTICES` file — none is owed
> yet. The moment any MIT-licensed source is pasted in, the obligation activates and
> the mechanism has to be chosen; until then this is an open decision with no
> outstanding debt behind it.
>
> **The one real licensing defect — this repository's own license — was open for a
> day and is now closed.** From 2026-07-29 a root `LICENSE` file existed (MIT, © 2026
> Ivan Baev) but was **untracked**: the repository was public with no license grant
> visible to anyone who cloned it, and GitHub's API reported `license: null`. Under
> exactly the Berne reasoning §2 applies to `cast` and `disler`, an unpublished
> `LICENSE` file grants nothing — `agenthropic` was presenting to the world as
> all-rights-reserved while its own README advertised MIT. It was tracked on
> **2026-07-30** in commit `9b6c6b3`, and
> `gh api repos/IvanBBaev/agenthropic --jq .license.spdx_id` now returns `MIT`.

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
This is a **dependency-license allowlist scan** over the installed dependency
graph: every npm package the monorepo actually depends on must resolve to a license
on an allowlist. If a dependency's declared license falls outside that allowlist,
the build fails. This is the automatable half of CD-9: it protects the codebase from
**accidentally pulling in a restrictively-licensed npm package as a dependency**.

As built, the scan reads the installed tree rather than the manifest — it shells out
once to `pnpm licenses list --json`, which reports what is actually on disk after
resolution, so a restrictive license arriving through a transitive dependency is
caught even though no `package.json` in this repository names it. The allowlist is
the eleven permissive identifiers quoted in the update note at the top of this page,
and SPDX expressions are evaluated rather than string-matched: `MIT OR GPL-3.0`
passes on its MIT branch, `MIT AND CC-BY-4.0` does not pass unless both halves are
allowlisted. That the allowlist is now a concrete, readable list in a committed file
is the substantive change since this section was first written.

### `WP-F5` — Static no-spawner + no-SSRF gate (the adjacent security gate)

Done-when: **"Planting a `child_process` import in `apps/server` makes CI red"**
(development-plan [`WP-F5`](../../analysis/development-plan.md)). This gate is
listed alongside `WP-F6` in the task scope because it is the concrete enforcement
that the one MIT-attributed, wholesale-copyable project — `hoangsonww` — cannot
smuggle its RCE spawner in alongside its Telegram provider: a static pattern scan
fails the build the moment any `child_process` import appears, regardless of which
file introduced it or why (see [security model, rule
3](../security/model.md#3-never-a-browser-driven-subprocess--claude-spawner)). It
is a security gate first and a provenance gate second — but because the one
artifact this project *does* copy wholesale (`hoangsonww`'s webhook code) sits one
file away from the exact route this gate exists to forbid, it functions as part of
the same per-artifact scoping discipline that CD-9 describes.

The shipped gate is broader than that Done-when in both scope and coverage. It scans
`apps/`, `packages/`, `scripts/` and `hooks/` rather than `apps/server` alone, it
includes tests and package-root config files rather than `src/` only, and it forbids
dynamic evaluation, wide network binds and WebSocket servers alongside the
subprocess family. It is also honest in its own source comments about what a regex
scanner can and cannot do: it stops the idiomatic ways a spawner could be
reintroduced during ordinary development, and it explicitly does not claim to stop a
developer who is deliberately obfuscating with runtime-assembled strings or
char-code arrays. Those are left to the runtime loopback guard and to code review.
The gate is defence-in-depth, not the last line — the same limits-of-tooling
reasoning §6's closing subsection applies to `WP-F6`.

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

In short: the CI gate is real, and it enforces the **dependency-license** half of
CD-9 mechanically; the **clean-room-authorship** half of CD-9 is enforced by the
documented workflow in §3, not by a script. Both halves are required for CD-9 to
hold; neither substitutes for the other.

There is a second, smaller over-claim worth retiring in the same breath, because
this page made it too. "Merge-blocking" was the word used here, and as of 2026-08-15
it is not accurate: `gate:licenses` runs on every push and pull request and exits
non-zero on a disallowed license, but with no branch-protection rule on `main` a red
workflow is a red mark, not a closed door. The mechanism is built and correct; the
enforcement switch is an owner action on github.com that has not been taken. Until it
is, read every "the gate blocks X" sentence in this documentation set as a statement
of design intent — the gate reliably *tells* you, and a human still has to act on
what it says.

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

Two of the four items listed here when this page was written have since been
decided by being built, and are recorded below as answered rather than deleted, so
that the shape of the original uncertainty stays visible. Two remain genuinely open.

- ~~**The dependency-license allowlist itself**~~ — **decided by implementation.**
  The eleven accepted SPDX identifiers and the single `caniuse-lite` exception are
  enumerated in `scripts/check-licenses.mjs` and quoted in the update note at the top
  of this page. The original concern was that no source document named the list; the
  list is now source code, which is the strongest form the answer could take.
- ~~**The specific tool/technique behind `WP-F6`**~~ — **decided by implementation:**
  a hand-rolled script over `pnpm licenses list --json`, not an off-the-shelf
  license-checker. That choice was never argued out in a design document, so treat it
  as a fact about what exists rather than as a ratified decision; the trade-off it
  makes — one more file to maintain, one fewer dependency in a repository whose whole
  premise is auditability — is legible from the file itself.
- **The attribution mechanism for `simple10`/`hoangsonww`** (a root `NOTICE` /
  `THIRD-PARTY-NOTICES` file, per-file header comments, or a credits section in
  [contributing: overview](index.md)) is still not specified anywhere in the source
  material — and, as the update note at the top explains, still not owed: no source
  text from either project has been copied into this repository. The decision is
  deferred, not skipped; the moment MIT-licensed source is pasted in, the obligation
  activates and the mechanism has to be chosen before that commit lands.
- **Whether the provenance scan ever grows beyond dependency licenses** — e.g., a
  future check that greps for verbatim string matches against the all-rights-reserved
  repositories' source — is not proposed anywhere in the source docs; §6 above is
  explicit that today's `WP-F6` is dependency-license-only, and the
  clean-room-authorship half of CD-9 relies on discipline, not tooling. Nothing in
  the shipped gates changes that: `check-no-spawner.mjs` grew in scope, but it looks
  for security patterns, never for provenance.

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
- [Contributing: testing & quality](testing.md) — the coverage gate that runs
  alongside `WP-F5`/`WP-F6` in CI, specified at >90% and shipped at 100, and subject
  to the same branch-protection caveat as the gates on this page.
- [Contributing: governance](governance.md) — the PR-template checklist item that
  points back to this page.
- [Decisions (ADRs)](decisions/README.md) — the full ADR index; the LB-2 ADR
  ([`adr-lb-2-personal-first-commercial-clean.md`](decisions/adr-lb-2-personal-first-commercial-clean.md))
  named CD-9 as a forthcoming follow-up, and that follow-up is now recorded as
  [ADR-0011](decisions/adr-cd-9-per-artifact-licensing.md), "CD-9 — Per-artifact
  licensing" (status: accepted).
