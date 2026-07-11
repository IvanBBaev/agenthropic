# What is agenthropic

agenthropic is a **self-hosted, local-first cockpit for observing and visualising
Claude Code agent and subagent activity** — real sessions, on your own machine, with
no cloud dependency and no telemetry egress. This page covers what the tool is, the
one-paragraph pitch, the moat that justifies building it instead of adopting an
existing dashboard, who it's for, and where the project actually stands today. The
key takeaway up front: **it observes, it never operates** — it ingests Claude Code's
own lifecycle hooks and the ground-truth `~/.claude/projects/*.jsonl` logs into a
SQLite database you own, and renders the resulting subagent tree, token cost, and
(post-1.0) Telegram alerts — and, as of this writing, it is still in the **bootstrap
phase**: the design is settled, the code is not yet scaffolded.

## The one-paragraph pitch

> A self-hosted, local-first cockpit for Claude Code agent/subagent activity on a Mac
> Mini M4 — persisted subagent DAG + dollar-cost/delegation-savings + Telegram alerts
> + owned persistence — differentiated from the 28.4k★ baseline
> (`claude-code-templates`) by the four things it lacks, and from the whole field by a
> **loopback-only, no-spawner, mandatory-token** security posture.

This is the idea-in-one-paragraph from the project's own concept analysis, reproduced
verbatim because it is the most precise summary available (see
[`docs/analysis/README.md`](../../analysis/README.md), "The idea in one paragraph").
Two things in it matter more than the rest: the phrase "**the four things it lacks**"
(the market gap the moat is carved from — see below) and "**Mac Mini M4**" — this is a real, personal-first tool built to
run one operator's actual subagent-heavy workflow, not a generic multi-tenant SaaS.

## What agenthropic actually does

At its core, agenthropic closes one loop: Claude Code emits lifecycle hook events as
agents and subagents run; those events (plus the JSONL transcripts Claude Code already
writes) are ingested into an owned, persisted store; a browser renders the resulting
orchestration graph and cost picture live. This is the **target architecture** — the
design of record, not yet built:

```
Claude Code (subagents)
  │  hooks (lifecycle events)
  ▼
hook-ingest  ──►  SQLite (persisted, WAL)  ──►  SSE  ──►  browser SPA
  ▲                 │                                    (DAG + Sankey)
  │                 └──►  webhook sink  ──►  Telegram relay (@baev_bot_bot)
  └── reads ~/.claude/projects/*.jsonl (ground-truth token counts)
```

Two invariants hold across every layer of that loop and are non-negotiable design
decisions, not implementation details:

- **Token counts are ground truth**, read from `~/.claude/projects/*.jsonl` — never
  inferred or estimated from tool-call heuristics.
- **Agents and subagents are first-class, persisted, queryable entities.** The
  subagent tree is a self-referential data fact (a `parent_agent_id` foreign key on
  an `agents` table), not something the browser reconstructs on the fly from a flat
  event log.

Ingestion listens for Claude Code's full lifecycle hook set (`PreToolUse`,
`PostToolUse`, `UserPromptSubmit`, `Notification`, `Stop`, `SubagentStart`/
`SubagentStop`, `SessionStart`/`SessionEnd`, `PreCompact`, `PermissionRequest`,
`PostToolUseFailure`), with `SubagentStart`/`SubagentStop` given dedicated handling
because they feed the hierarchy tables directly. One hedge applies to that list:
it is **12 hooks assumed, 9 documented** — `SubagentStart`, `PermissionRequest`,
and `PostToolUseFailure` are not in Claude Code's documented nine-event set, and
whether the runtime fires them is unconfirmed until the Phase-0 spike reports
(see [Hook ingestion](../architecture/hooks.md), "The `SubagentStart` hedge"). The full hook catalog and the
raw-substrate-plus-projection ingest design (`events_raw` → normalized `events`,
`orchestration_edges`, `token_usage`) are covered in depth in the architecture
section — see [Architecture overview](../architecture/overview.md),
[Hook ingestion](../architecture/hooks.md), and
[Ingest & reconciliation](../architecture/ingest-reconciliation.md).

## Local-first by design

"Local-first" is not a marketing label here — it is a set of hard constraints the
project holds itself to everywhere:

- **No cloud dependency, no telemetry egress.** Everything — hook events, the
  session/agent database, the JSONL read path — stays on the machine that runs
  Claude Code. There is no vendor backend agenthropic phones home to.
- **Runs on real hardware you own** — the reference deployment target is a Mac Mini
  M4 running a genuinely subagent-intensive Claude Code workflow, not a demo dataset.
- **Persistence you control.** History lives in a SQLite database on disk, in WAL
  mode with backups — not in a hosted dashboard's database, and not only for the
  duration of one terminal session.
- **A deliberately narrow security posture**, summarized here and covered in full on
  the flagship [Security model](../security/model.md) page:
  - Binds **`127.0.0.1` loopback only** — never `0.0.0.0`.
  - The auth token is **mandatory**, checked with `timingSafeEqual` — not opt-in, and
    never a no-op when unset.
  - It **never spawns `claude` or any subprocess driven by request input.** This is a
    deliberate, permanent line: one of the six dashboards surveyed during
    due diligence exposes exactly this as an RCE (`/api/run` accepts a
    `permission-mode` from the request body whose allow-list includes
    `bypassPermissions`) — agenthropic does not build this surface, ever.
  - **No SSRF** — it never dials a URL taken from an event payload.
  - **Remote access is tunnel-only** — SSH port-forward or a Tailscale tunnel, never
    a reverse proxy exposing the port.

None of this is aspirational polish added at the end; it is called out as
non-negotiable in the project's own instructions precisely because every rival
dashboard surveyed during due diligence got at least one of these wrong (see the
[Threat model](../security/threat-model.md) page for the per-project breakdown).

## The moat, in one paragraph

Six existing Claude Code observability dashboards were audited before deciding to
build agenthropic at all, plus the 28.4k-star zero-install baseline
(`davila7/claude-code-templates`), which already nails self-hosted, zero-install,
live token attribution — but ships as a flat leaderboard. Across all seven, five
capabilities are confirmed absent everywhere: a **global, persistent, per-instance
orchestration DAG** (every existing tool has at most a session-scoped tree with
event-derived, non-persisted edges); **live dollar-cost attribution and
delegation-savings** (quantifying what routing to Haiku/Sonnet instead of a top-tier
model actually saves); a **Telegram alert sink**; **cross-machine/fleet
aggregation**; and **persistence you control** for historical, time-series analysis.
That gap — not a wish list, but five things independently verified absent across the
whole surveyed field — is the reason to build greenfield rather than fork or adopt an
existing project; the tagline's "the four things it lacks" counts the four of those
five measured directly against the baseline (fleet aggregation is the fifth, absent
across the entire field, baseline included). The moat proper is narrower still:
**two** capabilities that are genuinely hard to retrofit — the **persistent
cross-session DAG** and **dollar-cost attribution**. Telegram alerting is planned as
a post-1.0 convenience, not a differentiator, and fleet aggregation is deferred until
a second host physically exists. The full breakdown, including which project each
idea is borrowed from and why forking was rejected, is on
[The moat — why build](the-moat.md).

## Who it's for

| | |
|---|---|
| **Built for** | A senior engineer running genuinely subagent-heavy Claude Code sessions on their own machine, who wants a queryable, persisted record of what every agent and subagent actually did — including cost — without sending anything to a third-party service. |
| **Identity** | **Personal-first, commercial-clean**: a single-user cockpit for one operator's own hardware, deliberately *not* a multi-tenant product today. The schema carries an `instance`/`host_id` key on every row from the first migration so fleet aggregation is possible later, but multi-tenancy and fleet views are explicitly deferred, not shipped. |
| **Not (yet) for** | Teams needing a shared, hosted, multi-tenant dashboard, or fleet-wide observability across many machines — that is an explicit later phase, not the MVP. |
| **Prerequisite mindset** | Comfortable self-hosting a small service, reading SQL, and treating "no telemetry egress" as a feature rather than friction. |

## Current status: bootstrap

As of this writing, agenthropic is in the **bootstrap phase**:

- The **design basis is established** — architecture, data model, hook set, security
  model, and roadmap are all written down and treated as the source of truth for the
  code once it exists.
- **No application code is scaffolded yet.** The stack is a *leaning*, not a decision:
  Fastify + `better-sqlite3` + React/Vite/D3 in a pnpm monorepo (server + web),
  aligned with a sibling project's pattern, but repo structure and the MVP schema
  scope are still open.
- **A Phase 0 feasibility spike gates everything.** Before any production code is
  written, the spike must confirm — against real, hand-labeled Claude Code sessions —
  that the subagent tree can be built reliably from the JSONL logs alone
  (JSONL-primary). That question has already been **empirically pre-answered
  `CONDITIONAL-GO` (confidence 85)** by a read-only probe of the real
  `~/.claude/projects` corpus on 2026-07-04: JSONL is a trustworthy, outage-surviving
  source, provided the parser walks **both** on-disk layouts (85% of agent files are
  nested) and sums tokens **from child transcripts**. Those two — **dual-layout
  parsing** and **child-transcript token summation** — are the proven load-bearing
  hedges; a hooks-primary ingest with a durable outbox is a deferrable, contingent
  fallback (JSONL self-reconciles by backfill), pulled off the v1 critical path unless
  a sub-second-liveness or hooks-only data need actually appears. The probe **de-risks
  but does not replace** the formal spike: the paired-capture corpus and the operator's
  tree sign-off still run, and this go/no-go decision stays empirical, not assumed —
  tracked in the repository's own `TODO.md` as Gate A (decision approval) and the
  Phase 0 feasibility spike's GO/CONDITIONAL-GO/NO-GO verdict (`WP-S7`).
- **The documentation you're reading is being written ahead of the code**, on
  purpose: the conceptual and design documentation does not depend on any
  implementation decision, so it is authored now while the stack and Phase 0 spike
  are still pending. Usage documentation (installation, configuration, the running
  dashboard) is explicitly blocked until the corresponding build phase ships.

> **The empirical basis for the `CONDITIONAL-GO` verdict** — the corpus census, the
> four CD-1 questions answered with real numbers, and the parser acceptance gate — is
> written up in [`docs/analysis/phase0-probe.md`](../../analysis/phase0-probe.md).

For the phase-by-phase build sequence once Phase 0 goes green, see the
[Roadmap](roadmap.md). For the open design questions this status section
intentionally does not resolve, see the [FAQ](faq.md).

## See also

- [The moat — why build](the-moat.md) — the five absent capabilities, in full, and
  why forking an existing project was rejected.
- [Comparison vs the field](comparison.md) — agenthropic against the baseline and the
  six audited rival dashboards.
- [Roadmap](roadmap.md) — the phase-by-phase build plan from the Phase 0 spike
  onward.
- [FAQ](faq.md) — self-hosting, cost, privacy, and "why not just fork X".
- [Architecture overview](../architecture/overview.md) — the ingest loop and
  ports-and-adapters structure in detail.
- [Security model](../security/model.md) — the flagship page on the loopback,
  mandatory-token, no-spawner, no-SSRF posture summarized above.
