# ADR-0008: CD-6 — Ports & adapters: the named port set

- **Status:** accepted, **amended in practice 2026-07-30** — the ports/adapters principle holds (pure core, no DB imports, fakes everywhere); the named port set shipped as ~~four~~ *(five, as of 2026-08-15)* seams, not ten (see the as-built updates below)
- **Date:** 2026-07-03
- **Deciders:** Ivan Baev (project owner), via the six-lens concept-analysis-v2 workflow
- **Source:** [`concept-analysis-v2.md` §3, row CD-6](../../../analysis/concept-analysis-v2.md#3-canonical-decision-register-v2)
  (consolidates AD6, SD1); §4.2 (Senior Developer)

## As-built update — 2026-07-30

**Verdict: the principle holds; the named port set is smaller than drawn.** Ports &
adapters is the shape of the codebase — the pure parser and cost engine live in
`packages/core` with **no DB imports**, and the whole ingest path is driven in tests
by in-memory fakes that never touch the real `~/.claude/projects`. What changed is
which seams turned out to need naming.

**The seams that exist:**

| Port | Where | Note |
|---|---|---|
| `CorpusFs` | `apps/server/src/corpus/fs-port.ts` | The JSONL reader — this ADR's `TokenReader`/`TokenSource`, realized. **Read-only by construction**: it exposes no write, rename, unlink, chmod or open-for-write operation, so the live corpus cannot be perturbed even by a bug. |
| `EventStorePort` | `packages/shared/src/ports/event-store.ts` | The append-only substrate seam (`append` / `readAll`). The only formal port living in `packages/shared`; it compiles with no DB imports, satisfying `WP-D1`'s stated criterion. |
| `RealtimeHub` | `apps/server/src/realtime/hub.ts` | SSE fan-out ([ADR-0007](adr-cd-5-transport-sse.md)). |
| `SubstrateProvider` | `apps/server/src/api/substrate-provider.ts` | Read-only seam letting the cost-analysis endpoint reach the corpus on demand — not in the original set, because the need (compaction repricing and delegation savings want raw substrate, which DB rows cannot answer) only became visible once the cost engine was real. |

**The names in the diagram below that have no adapter:**

- **`Normalizer` / `Projection`** — never built as separate stages; see
  [ADR-0004](adr-cd-2-immutable-substrate-projection.md)'s as-built update. This
  matters to *this* ADR because the second acceptance criterion below explicitly
  leans on them ("requires the Normalizer and Projection to be pure functions
  reachable through a port"). Replay determinism was achieved anyway — the P0
  double-replay proof asserts a byte-identical result — but by a different
  construction than the one this criterion names.
- **`AlertSink`** — no adapter. Alerts are post-1.0 and gated behind KC-5.
- **`HookSource`, `StoragePort`, `PricingProvider`, `CostEngine`** — not separate
  named interfaces. The functionality exists (a hook HTTP route, the DB modules under
  `apps/server/src/db/`, the seeded `model_pricing` table, `computeCostUsd` in
  `packages/core`) but as concrete modules, not as ports with fakes behind them.
- **`simple10`'s strategy-pattern per-runtime agent classes** are not adopted.
  There is one runtime adapter (Claude Code) and no strategy indirection; a Codex
  adapter would be added behind `CorpusFs` and the parser, not behind a class
  hierarchy.

**Honest read:** the "more interfaces and indirection for a solo owner to maintain"
cost named below was paid down by not building the interfaces that had exactly one
implementation and no test seam to gain. The four ports that survived are the four
that a fake actually plugs into. The second-runtime portability claim is therefore
**unproven** — plausible from the parser's purity, but nothing has been ported.

## As-built update — 2026-08-15

**Verdict: holds; a fifth seam has since been named.** `RetentionPort`
(`apps/server/src/retention/port.ts:42`) joins the four listed above, and it was
named for exactly the reason the 2026-07-30 amendment gives for the others: a fake
plugs into it. It exposes a policy and a single `run(options?)` returning a report,
with the SQLite-backed adapter in `runner.ts`, a clock injection point, and a
`dryRun` mode that measures without deleting. The port file itself carries no
database import, so `WP-D1`'s stated criterion holds for this seam too.

The seam is worth recording here rather than only in [ADR-0012](adr-cd-10-scope-secrets-retention.md)
because it is the clearest case in the codebase of a port carrying a *policy*
distinction rather than only a *driver* distinction. Its report has a `configured`
flag whose whole purpose is to keep two very different facts apart: "retention ran
and found nothing to delete" and "retention is not configured at all." Collapsing
those into a single empty report would be the kind of plausible-looking summary this
project refuses to produce. The default policy makes every call a reported no-op, so
wiring the port up anywhere does not, by itself, delete anything — the mechanism
exists and the policy remains unset pending OPEN-1/2/3.

Nothing else in the port set has changed: `Normalizer`/`Projection`, `AlertSink`,
`HookSource`, `StoragePort`, `PricingProvider` and `CostEngine` still have no named
interface, and the second-runtime portability claim is still **unproven** — no
non-Claude-Code adapter has been attempted.

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
