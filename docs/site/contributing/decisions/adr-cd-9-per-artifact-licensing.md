# ADR-0011: CD-9 — Per-artifact licensing

- **Status:** accepted — CI provenance scan **live and green** (412 packages) as of 2026-07-30; ~~**open blocker:** the project's own `LICENSE` is untracked, so GitHub reports this repository's license as `null`~~ *(closed 2026-07-30 — `LICENSE` tracked, GitHub reports `MIT`; re-verified 2026-08-15)* (see the as-built updates below)
- **Date:** 2026-07-03
- **Deciders:** Ivan Baev (project owner), via the six-lens concept-analysis-v2 workflow
- **Source:** [`concept-analysis-v2.md` §3, row CD-9](../../../analysis/concept-analysis-v2.md#3-canonical-decision-register-v2)
  (consolidates SD6, BA-D4, G-D4, LB2); §4.4 (Business Analyst)

## As-built update — 2026-07-30

**Verdict: the automatable half is live and green; the project's own license is not
yet published.**

**What shipped.** `scripts/check-licenses.mjs` runs as `gate:licenses` in CI on every
push and exits non-zero on any dependency whose license falls outside an explicit
allowlist (`MIT`, `MIT-0`, `ISC`, `Apache-2.0`, `BSD-2-Clause`, `BSD-3-Clause`,
`0BSD`, `BlueOak-1.0.0`, `CC0-1.0`, `Unlicense`, `Python-2.0`, plus a short list of
documented per-package exceptions). SPDX `OR` expressions pass if any branch is
allowlisted; `AND` expressions require every part to be. It currently reports **OK
across 412 installed packages**. The allowlist that [licensing.md](../licensing.md)
listed under "What's undecided" is now decided and in the repository.

The gate is also the one sanctioned exception to the no-spawner rule
([ADR-0009](adr-cd-7-security-and-coverage-boundary.md)): it shells out to
`pnpm licenses list --json` with a fixed argv, marked inline with a
`spawner-gate-allow` comment that the spawner gate itself recognizes. That exception
is deliberate, narrow, and visible — not a hole.

**The honest blocker: the repository still has no license as far as anyone can
tell.** A `LICENSE` file (MIT, © 2026 Ivan Baev) exists in the working tree but is
**not tracked in git**. GitHub therefore reports this repository's license as
`null` — which means agenthropic currently sits in exactly the position this ADR
condemns in `cast`, `disler` and `nirdiamant`: source published with no license
grant, all-rights-reserved by the Berne default. The reasoning in
[licensing.md §2](../licensing.md) applies to this project too, and right now it
applies against it. This is a one-line fix owned by Ivan (the file must be committed);
until it is, the "commercial-clean" posture of [ADR-0002](adr-lb-2-personal-first-commercial-clean.md)
is asserted but not published.

**The clean-room half is still discipline, not tooling**, exactly as
[licensing.md §6](../licensing.md) says. Nothing built since changes that. The
attribution mechanism for `simple10`/`hoangsonww` (a `NOTICE` file, file headers, or a
credits page) remains unchosen — and remains unexercised, because the
`hoangsonww`-attributed alert schema is post-1.0 and has not been written.

## As-built update — 2026-08-15

**Verdict: holds; the blocker recorded above is closed.** The `LICENSE` file is now
tracked in git, and `gh api repos/IvanBBaev/agenthropic --jq .license.spdx_id`
returns `MIT` — re-verified on 2026-08-15. agenthropic no longer occupies the
position it condemns in `cast`, `disler` and `nirdiamant`: the grant is published,
not merely intended. The blocker was open for roughly one day, and it is left visible
above rather than deleted, because the interesting fact is not that it was fixed but
that a project whose own licensing page reasons carefully about the difference
between a README badge and a real grant nearly shipped as a repository with neither.

**The gate itself is unchanged and still green:** `check-licenses: OK (412 installed
packages, all licenses allowlisted)` on 2026-08-15. Two clarifications the
2026-07-30 note left loose. First, "a short list of documented per-package
exceptions" is, concretely, exactly one: `caniuse-lite`, accepted only under
`CC-BY-4.0`, an attribution-only data file arriving transitively through the Vite
toolchain. The exception is keyed to the license string and not to the name alone, so
a relicense of that package turns the gate red rather than passing it through.
Second, workspace-local `@agenthropic/*` packages are skipped as private, so the 412
counts third-party code only.

**One over-claim to retire.** The 2026-07-30 note says the gate "runs as
`gate:licenses` in CI on every push," which is accurate, but this ADR set has
elsewhere described the CD-9 gate as merge-blocking. It is not: branch protection on
`main` is not enabled, so a red run is a signal rather than a barrier
([ADR-0009](adr-cd-7-security-and-coverage-boundary.md)'s 2026-08-15 update covers
the same gap for the coverage gate). The acceptance criterion — "verified by a CI
provenance check" — is satisfied on its own wording, since verification is what the
check performs; enforcement was never this ADR's word, and should not be borrowed
into it.

**The clean-room half is still discipline, not tooling.** Nothing has changed:
no source text from any of the six audited projects has been copied in, the
attribution mechanism remains unchosen, and it remains unowed.

## Context

agenthropic deliberately "steals the best proven pieces" from the six audited rival projects
(`docs/ai/DESIGN.md` §0, §7) rather than forking any one of them wholesale. That stance only
survives contact with reality if licensing is treated per-artifact, not as a vibe: `simple10`
and `hoangsonww` are MIT; `cast`, `disler`, and `nirdiamant` carry **no** license file, which
means they are **all-rights-reserved by Berne default** — the Business Analyst lens is explicit
that this is a hard legal fact, "not ambiguity" (§4.4).

## Decision

**Per-artifact licensing, enforced by a CI provenance/license scan:**

- **COPY** (with attribution): `simple10`'s tree/ports pattern; `hoangsonww`'s Telegram/webhook
  schema~~; `hoangsonww`'s dual-SQLite driver~~ *(dual-driver item dropped 2026-07-06 —
  single `better-sqlite3` driver per best-path §6.3)*.
- **CLEAN-ROOM reimplement** (never view their source while writing): `cast`'s `controlGate`
  pattern and delegation-savings metric; `nirdiamant`'s checkpoint idea.

## Acceptance criteria

From `concept-analysis-v2.md` §6 ("Product / business"):

- **No all-rights-reserved code ships** (clean-room for `cast`/`disler`/`nirdiamant`;
  attribution for `simple10`/`hoangsonww`), **verified by a CI provenance check**.

Supporting evidence, `development-plan.md` `WP-F6` ("License/provenance scan (CD-9)"): "A
non-allowlisted dependency license makes CI red."

## Consequences

- **Positive:** removes a genuine commercial/legal blocker (ADR-0002, LB2) before any commercial
  intent exists, while still capturing the two largest, safely-copyable patterns in the audited
  set — `simple10`'s tree/ports and `hoangsonww`'s webhook schema, both MIT.
- **Negative / costs:** clean-room reimplementation of `cast`'s `controlGate` and
  delegation-savings, and `nirdiamant`'s checkpoint idea, costs more engineering time than a
  direct port would — the design must be reasoned from the *idea*, never the source line.
- **Follow-ups:** `development-plan.md` `WP-F6` (license/provenance scan gate), `WP-A2`/`WP-A6`
  (hoangsonww-attributed alert schema + Telegram adapter), `WP-C5` (clean-room
  delegation-savings). A dedicated writeup of the clean-room rule itself belongs on
  [`../licensing.md`](../licensing.md).

## Alternatives considered

- **Treat all six audited repos as free-to-copy reference implementations** — rejected: the
  Business Analyst lens is explicit that `cast`/`disler`/`nirdiamant` are all-rights-reserved by
  Berne default, and copying them without attribution is an infringement risk under any
  commercial intent (§4.4).
- **Copy nothing; reimplement everything from scratch** — rejected: this throws away the two
  large, safely-copyable patterns (`simple10`'s tree/ports, `hoangsonww`'s webhook schema) that
  ADR-0002 (LB2) identifies as the reason the licensing and scope constraints align cheaply.
