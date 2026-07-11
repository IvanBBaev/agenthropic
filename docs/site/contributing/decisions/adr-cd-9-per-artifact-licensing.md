# ADR-0011: CD-9 — Per-artifact licensing

- **Status:** accepted
- **Date:** 2026-07-03
- **Deciders:** Ivan Baev (project owner), via the six-lens concept-analysis-v2 workflow
- **Source:** [`concept-analysis-v2.md` §3, row CD-9](../../../analysis/concept-analysis-v2.md#3-canonical-decision-register-v2)
  (consolidates SD6, BA-D4, G-D4, LB2); §4.4 (Business Analyst)

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
