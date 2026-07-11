# Getting started

> **Design-target documentation — pre-Phase-0.** This page documents agenthropic's
> *intended* behavior for installing and running the dashboard, as fixed by the design
> basis (docs/ai/DESIGN.md) and the build plan (docs/analysis/development-plan.md). **No
> application code is built yet** (see the [roadmap](../guide/roadmap.md)); installing
> and running the dashboard ships in **Phase 1 — Foundation, security spine, storage**.
> Values marked _(planned)_ or _(leaning — unconfirmed)_ may change; the **security
> invariants are binding and will not**. This replaces the earlier stub.

This page walks the designed install → configure → run → verify flow end to end, for a
single self-hoster standing agenthropic up on their own machine. The key takeaway: two
things about this flow are already **fixed** and will not change regardless of how the
open stack questions resolve — the server **refuses to start** without a
`DASHBOARD_TOKEN` set, and it **refuses to bind anywhere but `127.0.0.1`** — while
almost everything else below (the exact install command, the package manager, the
port) is a **leaning**, not yet a locked decision (`CLAUDE.md` current-state;
`ai/DESIGN.md` §10). Where a step names a concrete command or path, this page marks it
`(planned)` or `(leaning — unconfirmed)` rather than inventing one, per the same
sourcing discipline as every other page under `docs/site/`.

## Prerequisites

| Requirement | Status | Source |
|---|---|---|
| A macOS or Linux host | Fixed shape; no OS-specific dependency named in the design | `ai/DESIGN.md` §1 describes the reference deployment as "real sessions on a Mac Mini M4" |
| Node runtime + **pnpm** | _(leaning — unconfirmed)_ | `CLAUDE.md` current-state: "Leaning Fastify + better-sqlite3 + React/Vite/D3, pnpm monorepo (server + web), but unconfirmed" |
| A local Claude Code install already producing `~/.claude/projects/*.jsonl` | Fixed — this file is the system's **ground-truth** input, not optional tooling | `ai/DESIGN.md` §3, §8; [architecture overview](../architecture/overview.md) Invariant 1 |

The reference host throughout the design basis is Ivan's own **Mac Mini M4**, run as a
"real sessions… subagent-intensive workflow" testbed (`ai/DESIGN.md` §1) — nothing in
the design ties agenthropic to that specific hardware, but it is the machine every
capacity and workflow assumption in the design basis was written against. There is no
prerequisite step that installs or configures Claude Code itself: agenthropic is a
**read-only observer** of an already-running Claude Code install (per the architecture
overview's "single-writer pipeline" framing) — if `~/.claude/projects/*.jsonl` does not
yet exist for you, run at least one Claude Code session first.

## The five-step flow

Each step below is tagged **fixed** (the design commits to this and it will not change)
or **planned** (the shape is decided, the exact command/value is not yet).

### 1. Obtain the repository — *(planned)*

The repo itself, its URL, and its top-level layout are not yet fixed: `ai/DESIGN.md`
§10 lists "repo structure — pnpm monorepo (server + web) vs single package" as an open
decision, and `CLAUDE.md`'s current-state note is explicit that "Stack & repo structure
are an open decision — do not scaffold `package.json`, workspaces or `src/` until
decided." Concretely, nothing scaffolds before Phase 0's `WP-S7` GO/NO-GO verdict —
`WP-F1` (the monorepo scaffold work package) carries a hard dependency on `WP-S7`
precisely so "no production code (not even the monorepo scaffold) starts until
`WP-S7` reads GO" (`docs/analysis/development-plan.md` §1, CD-8). Once it exists:

```bash
git clone <repo-url> agenthropic     # (planned — exact URL not fixed pre-Phase-0)
cd agenthropic
```

### 2. Install dependencies — *(planned, pnpm workspace)*

`WP-F1`'s Done-when is "clean install on Node 22 with a committed lockfile"
(`docs/analysis/development-plan.md` §5, Track F), which is the strongest signal the
plan gives about the install step — but it is a **work-package target for Phase 1**,
not a decision already exercised, and the monorepo-vs-single-package question it
assumes is still open per `ai/DESIGN.md` §10. The illustrative shape:

```bash
pnpm install     # (planned — pnpm monorepo is a leaning, unconfirmed choice; WP-F1)
```

### 3. Set the mandatory `DASHBOARD_TOKEN` — **fixed: mandatory, never optional**

This is a security invariant, not a configuration nicety. `ai/DESIGN.md` §8: "Auth
token is mandatory, not opt-in — a `DASHBOARD_TOKEN` that is a no-op when unset
(hoangsonww's mistake) is not auth." The server bootstrap (`WP-U0`, gated by `WP-F7`'s
security-contract tests) is done-when it "fails startup when token unset"
(`docs/analysis/development-plan.md`, Track U; [security model](../security/model.md)
rule 2). There is no environment where an unset token silently falls back to "no auth
needed" — the process exits instead of listening.

```
DASHBOARD_TOKEN=<token>
```

`<token>` is a placeholder in every sample on this site, never a real value (per the
docs style guide). At runtime the token is compared with Node's
`crypto.timingSafeEqual`, not a plain `===`, specifically because a naive string
compare leaks timing information about how many leading bytes matched
([security model](../security/model.md) rule 2).

### 4. Start the server — **fixed: loopback-or-fail, never `0.0.0.0`**

`WP-U0` (Fastify server bootstrap, owner `backend`, Phase 1) implements a
**loopback-or-fail** listen call: the process refuses to start bound to anything other
than `127.0.0.1` (`docs/analysis/development-plan.md` §2, §5 Track U;
[security model](../security/model.md) rule 1). This is a corrective, not an
arbitrary default — the independent audit behind the design basis found three of six
real, already-shipping rivals bind `0.0.0.0` by default (`ai/DESIGN.md` §8). The exact
start command and the listening port are not yet fixed (`ai/DESIGN.md` §10 names the
backend framework itself, Fastify vs Express, as still open):

```bash
DASHBOARD_TOKEN=<token> pnpm --filter server start   # (planned — exact command/port TBD)
# server binds 127.0.0.1:<port> only — refuses to start on 0.0.0.0, refuses to start
# with DASHBOARD_TOKEN unset (WP-U0 / WP-F7)
```

If you are only ever going to sit at the host's own keyboard, step 4 already gets you a
working local dashboard. Step 5 is what makes it useful: real data flowing in, and (if
needed) a way to reach it from another machine.

### 5. Install the Claude Code hooks, and reach the UI over a tunnel

This step has two independent halves, each documented on its own dedicated page rather
than duplicated here:

- **Wiring Claude Code's lifecycle hooks** into the loopback ingest receiver so events
  actually flow into `events_raw` is a separate work package, `WP-X8` (owner `devops`),
  whose Done-when is "install → working end-to-end hook → loopback ingest →
  `events_raw` on a real session" (`docs/analysis/development-plan.md` §5, Track X).
  Per the [roadmap](../guide/roadmap.md), this ships in **Phase 2 — Ingest substrate**,
  one phase after the server itself. Full procedure:
  [hooks installer](hooks-installer.md).
- **Reaching the dashboard from a machine other than the host** is never done by
  widening the bind address — it is always an SSH local port-forward or a Tailscale
  tunnel terminating at the same unmoved `127.0.0.1` socket (`ai/DESIGN.md` §8; never
  a reverse proxy to the open port). Full procedure, including the
  `tailscale serve` vs `tailscale funnel` distinction: [remote access](../security/remote-access.md).

Until step 5's hooks half lands, step 4 gives you a running, authenticated, loopback
server with nothing in it yet — which is exactly the boundary [what "running" looks
like](#what-running-looks-like) describes next.

## What "running" looks like

Once steps 1–5 are all complete, one subagent turn in a locally-running Claude Code
session flows through the same single-writer pipeline the
[architecture overview](../architecture/overview.md) walks in full — this page only
summarizes the shape, not the diagram, to avoid drifting out of sync with it:

1. Claude Code fires a lifecycle hook and POSTs it to the loopback `hook-ingest`
   receiver, which is itself behind the same mandatory-token gate as every other
   endpoint (`ai/DESIGN.md` §5; [architecture overview](../architecture/overview.md)
   step 1).
2. The event lands in the immutable, append-only `events_raw` substrate regardless of
   whether its type has been seen before — an unrecognized hook must never crash the
   pipeline (`WP-D4`; [architecture overview](../architecture/overview.md) step 2).
3. In parallel, the same ingest loop reads `~/.claude/projects/*.jsonl` directly for
   ground-truth token counts — this file is never a side archive, it is a primary
   input the loop reconciles against (`ai/DESIGN.md` §3;
   [architecture overview](../architecture/overview.md) step 3).
4. A deterministic projection turns `events_raw` into the queryable state a self-hoster
   actually looks at: `sessions`, the self-referential `agents` tree,
   `orchestration_edges`, and `token_usage` — replaying the same log twice must
   reproduce byte-identical state (concept-analysis-v2 CD-2;
   [architecture overview](../architecture/overview.md) step 4).
5. The dashboard's realtime channel (SSE, same-origin) pushes the resulting delta to
   the browser SPA, which redraws the subagent DAG and the cost/token Sankey view
   ([architecture overview](../architecture/overview.md) steps 5–6).

The full walkthrough — including the webhook-sink side branch to Telegram, the
component-responsibility table, and the ports-&-adapters seams behind each stage — is
the dedicated subject of [architecture overview](../architecture/overview.md); this
page stops at "here is the loop your install produces," not "here is how each stage is
built."

## Honesty box — fixed vs. leaning-open

Consistent with the docs style guide's rule to say plainly when something is open
rather than gloss over it:

| Fixed by design (will not change) | Leaning / open (may change) |
|---|---|
| Bind `127.0.0.1` loopback only, never `0.0.0.0`, not even behind a flag (`ai/DESIGN.md` §8) | Backend framework — Fastify vs Express (`ai/DESIGN.md` §10) |
| `DASHBOARD_TOKEN` is mandatory; server fails startup when unset; compared with `timingSafeEqual` (`ai/DESIGN.md` §8; `WP-U0`/`WP-F7`) | ~~SQLite driver — `better-sqlite3` with a `node:sqlite` fallback~~ *(settled 2026-07-06: single `better-sqlite3` driver, no fallback — best-path §6.3, superseding `ai/DESIGN.md` §7, §10)* |
| Realtime transport is SSE, same-origin, no wildcard CORS — not WebSocket (concept-analysis-v2 CD-5, superseding `ai/DESIGN.md` §3's older wording) | Frontend stack — React + Vite + D3 (`ai/DESIGN.md` §10) |
| SQLite runs in WAL mode, with a backup routine whose restore is actually exercised (`ai/DESIGN.md` §8; `WP-D2`, `WP-F8`) | Repo structure — pnpm monorepo (server + web) vs a single package (`ai/DESIGN.md` §10; `CLAUDE.md` current-state) |
| Token counts are ground truth read from `~/.claude/projects/*.jsonl`, never inferred (`ai/DESIGN.md` §3; [architecture overview](../architecture/overview.md) Invariant 1) | Exact install/start commands, package names, and the listening port — none are named yet anywhere citable |
| No browser-driven subprocess/`claude` spawner is ever built (`ai/DESIGN.md` §8) | Whether ingestion is JSONL-primary or hooks-primary-with-outbox — Phase-0's `WP-S7` GO/NO-GO decides this (CD-1, CD-8) |
| Remote access only via SSH port-forward or Tailscale tunnel, never a reverse proxy to the open port (`ai/DESIGN.md` §8) | Exact hook-endpoint auth mechanics for the hook-POST leg specifically ([architecture overview](../architecture/overview.md) "What's undecided") |

## Next steps

- [Configuration](configuration.md) — every environment variable and config option
  once the server bootstrap defines them, including `DASHBOARD_TOKEN` and the
  `~/.claude/projects` path.
- [Hooks installer](hooks-installer.md) — installing the hook scripts, leak-free token
  acquisition, and verifying an end-to-end hook → loopback ingest → `events_raw` run
  (Phase 2, `WP-X8`).
- [Security model](../security/model.md) — the full rule → why → how-enforced
  catalogue behind every "fixed" row above.
- [Remote access](../security/remote-access.md) — the SSH and Tailscale tunnel
  procedures for reaching a loopback-bound dashboard from another machine.
- [Roadmap](../guide/roadmap.md) — where this flow's Phase 1 server and Phase 2 hooks
  installer sit in the overall, dependency-checked build sequence.
