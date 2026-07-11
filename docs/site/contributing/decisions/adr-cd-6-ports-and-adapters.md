# ADR-0008: CD-6 — Ports & adapters: the named port set

- **Status:** accepted
- **Date:** 2026-07-03
- **Deciders:** Ivan Baev (project owner), via the six-lens concept-analysis-v2 workflow
- **Source:** [`concept-analysis-v2.md` §3, row CD-6](../../../analysis/concept-analysis-v2.md#3-canonical-decision-register-v2)
  (consolidates AD6, SD1); §4.2 (Senior Developer)

## Context

The ingest/normalizer/cost pipeline (ADR-0004…0006) needs to be testable against fixtures
without a live hook receiver or a real SQLite file, and it needs a path to a second runtime
(Codex) without a core rewrite when that day comes. `docs/ai/DESIGN.md` §7 already identifies
`simple10`'s ports/adapters storage and strategy-pattern agent classes as the cleanest, most
portable structural reference among the six audited projects.

## Decision

A **named port set**: `HookSource`, `TokenReader`/`TokenSource`, `StoragePort`, `RealtimeHub`,
`AlertSink`, `PricingProvider`, `CostEngine`, plus an `EventStore` port and a **pure**
`Normalizer`/`Projection`. `simple10`'s strategy-pattern agent classes are adopted as the
**per-runtime adapter** (Claude Code now, Codex later).

```
 per-runtime adapter (simple10 strategy-pattern: Claude Code now, Codex later)
 ┌───────────────┐        ┌────────────────────┐
 │  HookSource   │        │ TokenReader/        │
 │  (loopback)   │        │ TokenSource (JSONL)  │
 └──────┬────────┘        └─────────┬───────────┘
        │                           │
        ▼                           ▼
              EventStore port (append-only events_raw, ADR-0004)
                          │
                          ▼
                 pure Normalizer  ──►  pure Projection
                          │
        ┌─────────────────┼───────────────────┬─────────────┐
        ▼                 ▼                    ▼             ▼
   StoragePort       RealtimeHub         PricingProvider   AlertSink
                                                │
                                                ▼
                                            CostEngine
```

## Acceptance criteria

`concept-analysis-v2.md` §6 does not carry a CD-6-specific quantified numeric gate — this is an
architectural/testability decision rather than a metric one. The nearest testable proxies,
copied from adjacent canonical decisions this one enables:

- The >90% coverage gate (ADR-0009, CD-7) applies to every port and adapter; it is only
  achievable at that scope because ports admit in-memory fakes.
- The replay-determinism criterion (ADR-0004, CD-2): "re-ingesting the same log yields
  byte-identical `events_raw` and an identical projected DB state" requires the Normalizer and
  Projection to be pure functions reachable through a port, not code entangled with a concrete
  driver.
- Supporting evidence, `development-plan.md` `WP-D1` ("Storage port contracts"): "Ports compile
  with no DB imports; consumable across server/web/cost."

## Consequences

- **Positive:** the Normalizer/Projection is testable against an in-memory fake with no real
  hook receiver or SQLite file required; a second runtime (Codex) is addable as a new adapter
  behind `HookSource`/`TokenSource` without touching the core pipeline.
- **Negative / costs:** more interfaces and indirection for a solo owner to design and maintain
  correctly; the boundary discipline (no adapter-specific type leaking across a port) has to be
  enforced by review, not just aspiration.
- **Follow-ups:** `development-plan.md` Track D (`WP-D1`, port contracts), Track IN
  (`WP-IN1`…`WP-IN3`, adapters), Track C (`WP-C2`, `PricingProvider`), Track U (`WP-U0`…`WP-U2`).
  See [architecture overview](../../architecture/overview.md).

## Alternatives considered

- **A single monolithic ingest module** — rejected: not testable/replayable in isolation, and
  forecloses a future non-Claude-Code runtime without a rewrite.
- **Adopt `hoangsonww`'s or `simple10`'s storage layer wholesale** — rejected under ADR-0011
  (CD-9): only specific tree-building/webhook *patterns* from those projects are copyable with
  attribution, not their storage architecture as a whole; the port set here is a clean-room
  design shaped by, not copied from, either project.
