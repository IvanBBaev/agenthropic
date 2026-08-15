# Getting started

> **How to read this page.** The flow below is **runnable today** — the summary box
> immediately after this one carries the real commands, and every step's own **As built**
> note says what that step resolved to. The surrounding prose is the design-era text this
> page was first written as, before any code existed, and it is kept rather than
> rewritten: a step marked _(planned)_ or _(leaning — unconfirmed)_ records what was
> still open when the plan was written. The **security invariants were binding then and
> are binding now.**

> **Update — 2026-07 (as built).** The code exists now (implementation began
> 2026-07-11), so the flow below is runnable, not aspirational. The real values, all
> verified against the repository:
>
> - **Install:** pnpm monorepo (`pnpm@11`, Node ≥ 22 per `package.json` `engines`),
>   workspaces `apps/server`, `apps/web`, `packages/shared`, `packages/core`,
>   `packages/test-fixtures`, plus `hooks/`. `pnpm install` with the committed
>   `pnpm-lock.yaml` is the real step 2.
> - **Run the server:** `DASHBOARD_TOKEN=<token> pnpm --filter @agenthropic/server dev`.
>   It binds `127.0.0.1:4317` by default — the bind host is a constant in
>   `apps/server/src/config.ts` (deliberately not configurable); the port is
>   `DASHBOARD_PORT` (default **4317**). Startup fails without `DASHBOARD_TOKEN`,
>   exactly as promised.
> - **Run the SPA:** `pnpm --filter @agenthropic/web dev` (Vite dev server; React +
>   D3, four real views). This is a **second process on a second port** — the server
>   serves no static bundle, so the API port is not where the UI lives. Open the URL
>   Vite prints and paste the same `DASHBOARD_TOKEN` into the SPA's gate.
> - **Install the hooks:** `node hooks/install.mjs` (`WP-X8`, shipped) — generates
>   four fail-silent hooks (`UserPromptSubmit`, `Stop`, `SubagentStop`, `PreCompact`)
>   that POST to the loopback receiver with `Authorization: Bearer ${DASHBOARD_TOKEN}`
>   expanded by the shell at fire time, never written to disk. See
>   [hooks installer](hooks-installer.md).
> - **Data flows without hooks too:** the ingest watcher polls
>   `~/.claude/projects/*.jsonl` directly (JSONL is the primary source, CD-1), so
>   step 4 alone already yields populated views; hooks add liveness freshness only.
>
> Every `(planned)` / `(leaning — unconfirmed)` tag below is design history — the
> per-section notes mark what each one resolved to.

This page walks the designed install → configure → run → verify flow end to end, for a
single self-hoster standing agenthropic up on their own machine. The key takeaway: two
things about this flow are already **fixed** and will not change regardless of how the
open stack questions resolve — the server **refuses to start** without a
`DASHBOARD_TOKEN` set, and it **refuses to bind anywhere but `127.0.0.1`** — while
almost everything else below (the exact install command, the package manager, the
port) is a **leaning**, not yet a locked decision (`CLAUDE.md` current-state;
`ai/DESIGN.md` §10). Where a step names a concrete command or path, this page marks it
`(planned)` or `(leaning — unconfirmed)` rather than inventing one, per the same
sourcing discipline as every other page under `docs/site/`. *(As built, the two fixed
things held exactly — token-or-exit and loopback-or-nothing — and the open ones
resolved: pnpm monorepo, Fastify, port 4317. See the update box above.)*

## Prerequisites

| Requirement | Status | Source |
|---|---|---|
| A macOS or Linux host | Fixed shape; no OS-specific dependency named in the design | `ai/DESIGN.md` §1 describes the reference deployment as "real sessions on a Mac Mini M4" |
| Node runtime + **pnpm** | _(leaning — unconfirmed)_ *(Resolved as built: Node ≥ 22 and `pnpm@11`, per the root `package.json` `engines` and `packageManager` fields)* | `CLAUDE.md` current-state: "Leaning Fastify + better-sqlite3 + React/Vite/D3, pnpm monorepo (server + web), but unconfirmed" |
| A local Claude Code install already producing `~/.claude/projects/*.jsonl` | Fixed — this file is the system's **ground-truth** input, not optional tooling | `ai/DESIGN.md` §3, §8; [architecture overview](../architecture/overview.md) Invariant 1 |

The reference host throughout the design basis is Ivan's own **Mac Mini M4**, run as a
"real sessions… subagent-intensive workflow" testbed (`ai/DESIGN.md` §1) — nothing in
the design ties agenthropic to that specific hardware, but it is the machine every
capacity and workflow assumption in the design basis was written against. There is no
prerequisite step that installs or configures Claude Code itself: agenthropic is a
**read-only observer** of an already-running Claude Code install (per the architecture
overview's "single-writer pipeline" framing) — if `~/.claude/projects/*.jsonl` does not
yet exist for you, run at least one Claude Code session first.

## The flow, step by step

Each step below is tagged **fixed** (the design commits to this and it will not change)
or **planned** (the shape was decided, the exact command or value was not yet). The page
was drafted as five steps; the built flow has six, because opening the SPA and handing it
the token turned out to be a step of its own rather than a footnote to starting the
server.

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

> **As built:** the repository exists (github.com/IvanBBaev/agenthropic, first commit
> pushed 2026-07-11) and the open question resolved to a **pnpm monorepo** —
> `apps/server`, `apps/web`, `packages/shared`, `packages/core`,
> `packages/test-fixtures`, `hooks/`. Scaffolding proceeded under an explicit owner
> override of the CD-8 gate condition (recorded in the project's state documents);
> the security invariants were not relaxed by that override.

### 2. Install dependencies — *(planned, pnpm workspace)*

`WP-F1`'s Done-when is "clean install on Node 22 with a committed lockfile"
(`docs/analysis/development-plan.md` §5, Track F), which is the strongest signal the
plan gives about the install step — but it is a **work-package target for Phase 1**,
not a decision already exercised, and the monorepo-vs-single-package question it
assumes is still open per `ai/DESIGN.md` §10. The illustrative shape:

```bash
pnpm install     # (planned — pnpm monorepo is a leaning, unconfirmed choice; WP-F1)
```

> **As built:** exactly this command, no longer illustrative — `WP-F1`'s done-when
> is met: clean install on Node 22 against the committed `pnpm-lock.yaml`
> (`pnpm install --frozen-lockfile` is what CI runs).

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

> **As built:** both halves shipped and are contract-tested every run
> (`apps/server/test/security-contract.test.ts`): the server exits at startup when
> `DASHBOARD_TOKEN` is unset, and the comparison hashes both values to a fixed
> length before `timingSafeEqual` — slightly stronger than the sketch, since even
> the length of the correct token is not observable.

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
DASHBOARD_TOKEN=<token> pnpm --filter @agenthropic/server dev
# server binds 127.0.0.1:4317 only — refuses to start on 0.0.0.0, refuses to start
# with DASHBOARD_TOKEN unset (WP-U0 / WP-F7)
```

> **As built:** the command above is the real one, and the port question is settled —
> default **4317**, overridable with `DASHBOARD_PORT`. Note the script name: there is
> **only `dev`**. `apps/server/package.json` defines `dev`, `bench` and `test` and
> nothing else, so there is no `start` script and **no production run mode** — the
> server runs under `tsx watch` from source. An earlier draft of this page printed
> `pnpm --filter server start`, which is wrong twice over: the workspace is named
> `@agenthropic/server`, and that script does not exist.
>
> The bind host is **not** an environment variable at all: `127.0.0.1` is a constant in
> `apps/server/src/config.ts` with a comment saying it is intentionally not
> configurable, which is the strongest possible form of "refuses to start on
> `0.0.0.0`". The framework question resolved to Fastify (+ TypeBox). The
> security-contract test suite boots this exact composition root and asserts every
> bound address is `127.0.0.1`.

**Check it is alive before you go further.** The one endpoint that answers without any
session data is the health route:

```bash
curl -s -H "Authorization: Bearer <token>" http://127.0.0.1:4317/api/health
```

It is auth-gated like everything else, so a **401** means the token you sent is not the
token the server started with — not that the server is broken. A **200** carries
`status: "ok"`, a `schemaVersion`, and, while a first pass over the corpus is still
running, `ingest: "replaying"` (it reads `"idle"` afterwards). Read a *missing* field as
missing, never as zero: the handler omits optional fields when it has nothing to report
rather than emitting a fabricated `0`, so an absent `ingestSkips` means "no completed
pass yet", not "no files were skipped". [The API reference](api.md#liveness-and-ingest-visibility--get-apihealth)
lists the whole payload and what each omission means.

### 5. Open the dashboard and give it the token

The server hosts no UI. It serves the API and the SSE stream, and nothing else — there
is no static-file plugin anywhere in `apps/server`, so pointing a browser at port 4317
gets you JSON, not a dashboard. The SPA is a second process:

```bash
pnpm --filter @agenthropic/web dev
```

Open the URL Vite prints (port **5173** unless it is taken; the dev server binds
`127.0.0.1` by an explicit invariant in `apps/web/vite.config.ts`, never a wildcard) and
paste the same `DASHBOARD_TOKEN` into the gate. The shell renders **nothing** until a
token is present. Two things worth knowing about that token in the browser:

- It is held in **`sessionStorage` only** — never `localStorage`, never a cookie. Close
  the tab and it is gone; that is the intended trade, not an oversight.
- The dev server proxies `/api` to `http://127.0.0.1:4317`, so from the browser's point
  of view the API and the stream are same-origin. The stream's origin check accepts a
  request with no `Origin` header and otherwise only the server's own loopback origin —
  no wildcard CORS, ever. This documentation pass verified the check and the proxy
  config, not a live browser session; if API calls succeed while the connection chip
  sits at `reconnecting`, that check is the first place to look.

### 6. Install the Claude Code hooks, and reach the UI over a tunnel

Steps 1–5 already give you a working local dashboard if you only ever sit at the host's
own keyboard. This step is what makes it useful over time: liveness the transcripts alone
cannot prove, and (if you need it) a way to reach the UI from another machine. It has two
independent halves, each documented on its own dedicated page rather than duplicated
here:

- **Wiring Claude Code's lifecycle hooks** into the loopback ingest receiver so events
  actually flow into `events_raw` is a separate work package, `WP-X8` (owner `devops`),
  whose Done-when is "install → working end-to-end hook → loopback ingest →
  `events_raw` on a real session" (`docs/analysis/development-plan.md` §5, Track X).
  Per the [roadmap](../guide/roadmap.md), this ships in **Phase 2 — Ingest substrate**,
  one phase after the server itself. Full procedure:
  [hooks installer](hooks-installer.md). *(As built: shipped —
  `node hooks/install.mjs` installs four fail-silent hooks. Note also that hooks are
  optional for data: the server's polling watcher ingests
  `~/.claude/projects/*.jsonl` directly, so sessions, agents, edges and costs appear
  without any hook installed; hooks add interim liveness only.)*
- **Reaching the dashboard from a machine other than the host** is never done by
  widening the bind address — it is always an SSH local port-forward or a Tailscale
  tunnel terminating at the same unmoved `127.0.0.1` socket (`ai/DESIGN.md` §8; never
  a reverse proxy to the open port). Full procedure, including the
  `tailscale serve` vs `tailscale funnel` distinction: [remote access](../security/remote-access.md).

The design-era text expected step 6's hook half to be the thing that put data on the
board, and that turned out to be false: the watcher ingests transcripts on its own, so a
server started at step 4 fills up by itself. What it cannot do without hooks is claim an
ending — an agent moves `working` → `unknown` and stays there. That boundary is what
[what "running" looks like](#what-running-looks-like) describes next.

## What "running" looks like

Once every step is complete, one subagent turn in a locally-running Claude Code
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

> **As built, one structural correction to steps 2–4:** `events_raw` holds **hook
> events only**, and the projections are **not** derived from it. The JSONL
> transcript is parsed by the pure parser (`packages/core/src/parser`) and written
> straight into `sessions` / `agents` / `orchestration_edges` / `token_usage` in a
> **single transaction per session** (`apps/server/src/ingest/ingest-session.ts`),
> with the cost computation acting as a halt gate before any row is written. A hook
> envelope lands in `events_raw` plus one identifier-only liveness row in `events`
> in the same transaction. Replay stays idempotent and CD-1 (JSONL-primary) holds —
> hooks contribute liveness, never structure. The separate normalizer/projection
> stages the design sketched were never built as stages; see
> [ingest & reconciliation](../architecture/ingest-reconciliation.md) for the
> as-built pipeline.

The full walkthrough — including the webhook-sink side branch to Telegram *(as
built: not present — the server makes no outbound network request of any kind;
alerts are post-1.0, gated by KC-5)*, the component-responsibility table, and the
ports-&-adapters seams behind each stage — is the dedicated subject of
[architecture overview](../architecture/overview.md); this page stops at "here is
the loop your install produces," not "here is how each stage is built."

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

> **As built:** every "fixed" row held without exception, and every "leaning / open"
> row is now resolved — Fastify (+ TypeBox); React + Vite + D3 confirmed; pnpm
> monorepo confirmed; commands and port are real (`pnpm install`,
> `pnpm --filter @agenthropic/server dev`, default port 4317); ingestion resolved to
> **JSONL-primary** (no outbox — hooks are liveness only); and the hook-POST leg
> authenticates with the same mandatory Bearer token as every other endpoint, sent
> as `Authorization: Bearer ${DASHBOARD_TOKEN}` by the installed hook command with
> the variable expanded at fire time, never stored in the hook file.

## Next steps

- [Configuration](configuration.md) — every environment variable the server actually
  reads, including `DASHBOARD_TOKEN`, the `~/.claude/projects` path, the poll interval
  and the watchdog window, plus what the backup and retention machinery does and does
  not do yet.
- [API reference](api.md) — the ten routes, the health payload, and the response fields
  the four views are built on.
- [Hooks installer](hooks-installer.md) — installing the hook scripts, leak-free token
  acquisition, and verifying an end-to-end hook → loopback ingest → `events_raw` run
  (`WP-X8`).
- [Security model](../security/model.md) — the full rule → why → how-enforced
  catalogue behind every "fixed" row above.
- [Remote access](../security/remote-access.md) — the SSH and Tailscale tunnel
  procedures for reaching a loopback-bound dashboard from another machine.
- [Roadmap](../guide/roadmap.md) — where this flow's Phase 1 server and Phase 2 hooks
  installer sit in the overall, dependency-checked build sequence.
