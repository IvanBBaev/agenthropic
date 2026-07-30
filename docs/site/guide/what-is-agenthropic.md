# What is agenthropic

agenthropic is a **self-hosted, local-first cockpit for observing and visualising
Claude Code agent and subagent activity** — real sessions, on your own machine, with
no cloud dependency and no telemetry egress. This page covers what the tool is, the
one-paragraph pitch, the moat that justifies building it instead of adopting an
existing dashboard, who it's for, and where the project actually stands today. The
key takeaway up front: **it observes, it never operates** — it ingests Claude Code's
own lifecycle hooks and the ground-truth `~/.claude/projects/*.jsonl` logs into a
SQLite database you own, and renders the resulting subagent tree, token cost, and
(post-1.0) Telegram alerts — and, when this page was written, it was still in the
**bootstrap phase**: the design settled, the code not yet scaffolded. *(That last clause
is no longer true — see the update immediately below.)*

> **Update — 2026-07 (as built).** This page was written pre-code. Implementation began
> **2026-07-11**, by explicit owner override of the CD-8 "no production code before the
> Phase-0 GO" gate. agenthropic is no longer a design; it is a running program, and the
> "bootstrap phase" framing below is design history.
>
> **What runs today**, all verified against the repository: the Fastify server bound to
> `127.0.0.1:4317` and gated by a mandatory `DASHBOARD_TOKEN`; the SQLite/WAL substrate
> with a forward-only migration runner; JSONL corpus ingest with replay-on-startup; the
> persisted subagent DAG (`orchestration_edges`, four structural join paths); the cost
> engine including compaction repricing and delegation savings; the hook receiver; the SSE
> realtime hub; the read API; and all four dashboard views — live status, session tree,
> global DAG, cost/Sankey. **72 test files / 879 tests pass**, coverage gated **>90%** in
> every shipped package (`packages/test-fixtures` is a deliberate, documented exclusion).
>
> **Three corrections to the prose below.** (1) **Four hooks, not twelve.** The installer
> registers `UserPromptSubmit`, `Stop`, `SubagentStop` and `PreCompact`; **`SubagentStart`
> does not exist**, and no hook contributes structure — hooks are **liveness only**. The
> subagent tree is built **entirely from the JSONL transcripts**. (2) **There is no
> separate Normalizer→Projection pipeline.** The parser reads a transcript and writes
> `sessions` / `agents` / `orchestration_edges` / `token_usage` in one transaction per
> session; `events_raw` holds **hook events only**. This is a deliberate, recorded
> divergence from the design sketch. (3) **Telegram alerting is not built and may never
> be.** It is v2.0 work, entered only via checkpoint KC-5 (14 consecutive days of real
> daily v1.0 use plus ≥3 friction-log entries asking for alerts); the operator-alerts API
> and UI were cut outright. The server currently makes **no outbound network request of
> any kind**.
>
> **Two caveats this page must not lose.** The Phase-0 spike numbers below (including the
> confidence-85 `CONDITIONAL-GO`) remain **PROVISIONAL** — they were scored against machine
> inventories, not a hand-labeled corpus, and the ratification act is still open. And the
> v1.0 "<30 seconds to understand a session" claim is **unmeasured**: nobody has sat in
> front of the running dashboard with a real corpus and timed it.

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
orchestration graph and cost picture live. This was the **target architecture** — the
design of record at the time of writing:

```
Claude Code (subagents)
  │  hooks (lifecycle events)
  ▼
hook-ingest  ──►  SQLite (persisted, WAL)  ──►  SSE  ──►  browser SPA
  ▲                 │                                    (DAG + Sankey)
  │                 └──►  webhook sink  ──►  Telegram relay (@baev_bot_bot)
  └── reads ~/.claude/projects/*.jsonl (ground-truth token counts)
```

> **As built, the loop is real but the emphasis is inverted, and one branch is missing.**
> JSONL is the load-bearing input, not the sidecar: the corpus watcher reads
> `~/.claude/projects/*.jsonl` and the parser writes `sessions` / `agents` /
> `orchestration_edges` / `token_usage` directly, in one transaction per session. The
> `hook-ingest` arrow is thinner than drawn — a hook delivery lands one raw row in
> `events_raw` plus one identifier-only liveness row in `events`, and never touches the
> hierarchy or token tables. The **webhook-sink → Telegram branch does not exist**: it is
> v2.0 work behind KC-5, and the server makes no outbound network request at all today.
> The SQLite → SSE → browser SPA path is built and running.

Two invariants hold across every layer of that loop and are non-negotiable design
decisions, not implementation details:

- **Token counts are ground truth**, read from `~/.claude/projects/*.jsonl` — never
  inferred or estimated from tool-call heuristics.
- **Agents and subagents are first-class, persisted, queryable entities.** The
  subagent tree is a self-referential data fact (a `parent_agent_id` foreign key on
  an `agents` table), not something the browser reconstructs on the fly from a flat
  event log.

The design assumed ingestion would listen for Claude Code's full lifecycle hook set
(`PreToolUse`, `PostToolUse`, `UserPromptSubmit`, `Notification`, `Stop`, `SubagentStart`/
`SubagentStop`, `SessionStart`/`SessionEnd`, `PreCompact`, `PermissionRequest`,
`PostToolUseFailure`), with `SubagentStart`/`SubagentStop` given dedicated handling
because they were expected to feed the hierarchy tables directly. One hedge applied to
that list even then: it was **12 hooks assumed, 9 documented** — `SubagentStart`,
`PermissionRequest`, and `PostToolUseFailure` are not in Claude Code's documented
nine-event set, and whether the runtime fires them was unconfirmed until the Phase-0 spike
reported (see [Hook ingestion](../architecture/hooks.md), "The `SubagentStart` hedge").

> **As built, the hedge was right and then some.** The spike confirmed **`SubagentStart` is
> not a real hook**, and the installer registers exactly **four**: `UserPromptSubmit`,
> `Stop`, `SubagentStop`, `PreCompact`. More importantly, **no hook has dedicated
> structural handling — not even `SubagentStop`.** Hooks are **liveness only, never
> structure**: no hook creates an agent row, asserts a parent→child edge, or writes a token
> row. The hierarchy comes entirely from the JSONL transcripts, via the parser's four
> structural join paths (`tool_use`, `directory`, `queue_operation`, `task_notification`).
> The `events_raw` → normalized `events` → projection chain below was likewise never built
> as separate stages — `events_raw` holds hook events only, and JSONL is parsed straight
> into the projections. Both divergences are deliberate and recorded.

The full hook catalog and the ingest design (`events_raw`, `events`,
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

> **As built, the moat proper is real; the two conveniences are not.** Both hard
> capabilities ship: the persistent cross-session DAG (`agents` +
> `orchestration_edges`, the latter keyed by `instance`/`host_id`) and
> dollar-cost attribution including delegation savings. Three P0 proofs guard them and
> block merges: Σ `token_usage` equals the JSONL as checked by an independently written
> reader inside the test; a double replay produces a byte-identical database; the DAG
> rebuilds from JSONL alone after a simulated outage, with hooks proven liveness-only
> (appending them leaves the DAG dump unchanged). **Telegram alerting is not built** —
> it is v2.0, entered only via KC-5, and its operator-alerts API and UI were cut
> outright. **Fleet aggregation is not built** either; only the schema key exists, and
> no second host does. One caveat on the survey itself: the six rivals and the baseline
> were assessed by **reading their code and docs during due diligence** — none was
> installed and run head-to-head, and the project's friction log was never opened, so
> nothing here rests on lived comparative use.

## Who it's for

| | |
|---|---|
| **Built for** | A senior engineer running genuinely subagent-heavy Claude Code sessions on their own machine, who wants a queryable, persisted record of what every agent and subagent actually did — including cost — without sending anything to a third-party service. |
| **Identity** | **Personal-first, commercial-clean**: a single-user cockpit for one operator's own hardware, deliberately *not* a multi-tenant product today. The schema carries an `instance`/`host_id` key on every row from the first migration so fleet aggregation is possible later, but multi-tenancy and fleet views are explicitly deferred, not shipped. *(As built: the hedge is narrower than this promised — `instance` and `host_id` are `NOT NULL` on `orchestration_edges` only, not on every table. Fleet views remain unbuilt, as stated.)* |
| **Not (yet) for** | Teams needing a shared, hosted, multi-tenant dashboard, or fleet-wide observability across many machines — that is an explicit later phase, not the MVP. |
| **Prerequisite mindset** | Comfortable self-hosting a small service, reading SQL, and treating "no telemetry egress" as a feature rather than friction. |

## Current status: bootstrap

> **Update — 2026-07 (as built). The bootstrap phase is over.** This section describes
> the project as it stood before 2026-07-11. Each bullet below now carries an
> `*(As built: … )*` note with what it resolved to. The heading is kept because other
> pages link to it.

As of this writing, agenthropic is in the **bootstrap phase**:

- The **design basis is established** — architecture, data model, hook set, security
  model, and roadmap are all written down and treated as the source of truth for the
  code once it exists. *(As built: still true, and it held — with two recorded
  divergences the code chose deliberately over the design: four real hooks instead of
  twelve, and no separate Normalizer→Projection stage.)*
- **No application code is scaffolded yet.** The stack is a *leaning*, not a decision:
  Fastify + `better-sqlite3` + React/Vite/D3 in a pnpm monorepo (server + web),
  aligned with a sibling project's pattern, but repo structure and the MVP schema
  scope are still open. *(As built: no longer true. The leaning became the decision and
  shipped unchanged — `apps/server`, `apps/web`, `packages/shared`, `packages/core`,
  `packages/test-fixtures`, `hooks/`, on Node 22, with **72 test files / 879 tests
  passing** and coverage gated >90% in every shipped package.)*
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
  *(As built: the gate did not hold as written. Implementation began **2026-07-11** by
  explicit owner override of CD-8, before the paired-capture corpus and the operator's
  tree sign-off were completed. Both load-bearing hedges — dual-layout parsing and
  child-transcript token summation — are implemented and covered by the three P0
  proofs, but **the spike numbers themselves remain PROVISIONAL** until ratified
  against the hand-labeled corpus. Treat the confidence figure above as an estimate,
  not a measurement.)*
- **The documentation you're reading is being written ahead of the code**, on
  purpose: the conceptual and design documentation does not depend on any
  implementation decision, so it is authored now while the stack and Phase 0 spike
  are still pending. Usage documentation (installation, configuration, the running
  dashboard) is explicitly blocked until the corresponding build phase ships.
  *(As built: the block is lifted — the usage pages document a running system, and this
  whole corpus has been amended against the code. See
  [`STYLE-GUIDE.md`](../STYLE-GUIDE.md) § "As-built amendments" for how.)*

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
