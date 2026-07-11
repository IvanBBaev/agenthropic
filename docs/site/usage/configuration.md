# Configuration reference

> **Design-target documentation — pre-Phase-0.** This page documents agenthropic's
> *intended* behavior for the configuration & environment surface, as fixed by the
> design basis (`docs/ai/DESIGN.md`) and the build plan
> (`docs/analysis/development-plan.md`). **No application code is built yet** (see the
> [roadmap](../guide/roadmap.md)); the configuration & environment surface ships in
> **Phase 1 — Foundation, security spine, storage** (the alerting-specific slice —
> webhook targets, alert rules, and the Telegram `token_ref` — follows later, in
> **Phase 5 — Alerting core**, per the same roadmap). Values marked _(planned)_ or
> _(leaning — unconfirmed)_ may change; the **security invariants are binding and will
> not**. This replaces the earlier stub.

This page is the complete reference for every configuration and environment option the
design basis and build plan have fixed for agenthropic, as a table plus per-option
detail. The key takeaway: **two values are non-negotiable and fixed today** — the
loopback bind (always `127.0.0.1`, never configurable to anything else) and the
`DASHBOARD_TOKEN` (mandatory, `timingSafeEqual`-checked, fail-startup-when-unset) — and
everything else on this page (the listen port, the SQLite path, the backup directory,
the exact config-file format) is either a **fixed requirement with an illustrative
shape** or **explicitly `(planned)`**, because `WP-U0`'s config loader is designed but
its concrete file format is not yet decided. Nothing below should be read as a value
you can put in a `.env` file today — this documents what the loader will accept once
`WP-U0` lands, so Phase 1 implements exactly this and nothing weaker.

## Reference table

| Option | Required? | Default | What it controls | Source |
|---|---|---|---|---|
| `DASHBOARD_TOKEN` | **Mandatory** | none — server **refuses to start** if unset | Bearer token, compared with `timingSafeEqual`, gating every read endpoint, every write endpoint, and the SSE stream | `WP-U0`, `WP-F7`; DESIGN §8 |
| Listen host | **Fixed** | `127.0.0.1` — `0.0.0.0` is never an accepted value, not even behind a flag | The bind address for every listener the server opens (read API, hook-ingest receiver, `/api/stream`) | `WP-U0`, `WP-F7`; DESIGN §8 |
| Listen port | _(planned — default undecided)_ | _(planned)_ | TCP port the Fastify server listens on, loopback-side only | `WP-U0` (stack itself leaning, unconfirmed per the project `CLAUDE.md`) |
| `~/.claude/projects` path | Fixed conventional location; an override mechanism, if any, is _(planned)_ | the standard Claude Code transcript directory | Ground-truth source of session/agent/token-usage JSONL, read by the `TokenReader`/`TokenSource` port | CD-6 (`concept-analysis-v2.md`); `WP-IN5` |
| SQLite database path | _(planned — exact path undecided)_ | _(planned)_ | Location of the single WAL-mode SQLite file (+ its `-wal`/`-shm` siblings) | `WP-D2`; [data model](../architecture/data-model.md) |
| WAL mode / `foreign_keys` | **Fixed**, not a toggle | asserted `ON` on every connection open | Journal mode and FK enforcement pragma-checked at connect time, not merely configured once | `WP-D2`; DESIGN §8 |
| Backup directory | _(planned)_ | _(planned)_ | Where `WP-F8`'s online-backup artifacts (`agenthropic-<ts>.db`) land | `WP-F8`; [backup & restore](../operations/backup-restore.md) §2 |
| Backup retention window | _(planned — no default days fixed)_ | _(planned)_ | How long backup files are kept before the pruning step deletes them | `WP-D10`; [backup & restore](../operations/backup-restore.md) §4 |
| `model_pricing` source | Fixed requirement; seed content/refresh mechanism _(planned)_ | seeded, versioned, dated (`effective_from`, `verified_on`) | Per-token rates keyed by `model` × `service_tier` × `speed` × `inference_geo`, driving every dollar figure shown | `WP-C1`; DESIGN §4; [data model](../architecture/data-model.md) |
| Alert rules (`alert_rules`) | Operator-configured | none by default | Cost-threshold, stuck-agent, and error trigger conditions | `WP-A2`, `WP-A5`; Phase 5, roadmap |
| Webhook targets (`webhook_targets`) | Operator-configured | none by default | Outbound delivery destinations (Telegram today); dialed **only** from this operator-set table, never from an event payload | `WP-A2`, `WP-A4`; [Telegram alerts](telegram.md) |
| Telegram bot token | **Mandatory when Telegram alerting is enabled** | none — held by reference only | The `@baev_bot_bot` bot token, resolved through `token_ref` (`launchd` env or a `chmod 600` dotfile), never a raw column value | `WP-A3`, `WP-A6`; CD-10 |

Every non-fixed row above is either `(planned)` — a shape the design commits to but
without a literal default yet — or `(leaning — unconfirmed)`, tied directly to the
still-open stack decision (the project `CLAUDE.md`: pnpm monorepo, Fastify,
better-sqlite3, React/Vite/D3 are leaning, not confirmed). Nothing in this table is
invented to fill the gap.

## How configuration is supplied

`WP-U0`'s Definition-of-Done names a **config loader** explicitly, alongside the
loopback-or-fail bind, the timing-safe token middleware, the same-origin helper, and
TypeBox plugin registration — so a config-loading layer is a fixed part of the server
bootstrap, not a later addition. What is **not** fixed by any source document is the
loader's literal shape: whether it reads only process environment variables, layers a
config file (JSON/YAML/`.env`) underneath the environment, or does both with a defined
precedence. Treat the following as the *designed intent*, marked `(planned)` where the
concrete mechanism is still open:

- **Environment variables** — the mechanism every security-critical option (the table
  above) is expressed through in every source example, e.g. `DASHBOARD_TOKEN=<token>`
  ([security model](../security/model.md) rule 2). This is fixed for the security-gating
  values; whether *non*-secret options (listen port, DB path, backup directory) also
  read from the environment, from a config file, or from both is `(planned)`.
- **`launchd` env** — the reference operational pattern for running agenthropic
  continuously on its target host (a Mac Mini M4), following `simple10`'s
  `AGENTS_OBSERVE_RUNTIME=local`-under-`launchd` pattern named in DESIGN §7. Secrets
  held this way live in the launch agent's `EnvironmentVariables` dictionary, never in
  a file the server process itself reads and could accidentally echo.
- **A `chmod 600` dotfile** — the alternate secret-holding mechanism `WP-A3` names
  explicitly for the `token_ref` resolver (see below). A static gate rejects any
  secret-holding file with permissions wider than `0600` — this is a build-failing
  check, not a runtime warning.
- **Precedence between environment, launchd env, and a config file** is
  **`(planned)` — not fixed by any source document.** `WP-U0`'s own scope statement
  stops at "config loader" without specifying a resolution order; do not assume any
  particular layering (e.g. "env overrides file") until `WP-U0` actually ships and
  states one.

```
Operator sets values (DASHBOARD_TOKEN, TELEGRAM token_ref, …)
                │
                ▼
   ┌────────────────────────────┐        ┌────────────────────────────────┐
   │  launchd env (preferred)    │  or    │  chmod 600 dotfile              │
   │  EnvironmentVariables dict  │        │  (>0600 → rejected, WP-A3 gate) │
   └──────────────┬───────────────────────────────────┬────────────────────┘
                  │                                    │
                  ▼                                    ▼
              config loader (WP-U0) / token_ref resolver (WP-A3)
                                  │
                                  ▼
              held in server process memory only for the process lifetime
              never written to SQLite · never sent over SSE · never logged
```

## Security-critical options, in depth

### `DASHBOARD_TOKEN` — mandatory, timing-safe, fail-startup-when-unset

Every endpoint the server exposes — read, write, and the SSE stream — sits behind this
token, compared with Node's `crypto.timingSafeEqual`, never a naive `===` string
compare (which leaks timing information about how many leading bytes matched). If the
environment variable is unset, **the server refuses to start** rather than falling back
to "no auth needed" — there is no opt-in/opt-out toggle. This directly corrects
`hoangsonww`'s documented mistake: its `DASHBOARD_TOKEN` is opt-in and becomes a silent
no-op when unset, so a deployment that forgets to set it has *no* auth at all despite
shipping an auth feature (DESIGN §8; [security model](../security/model.md) rule 2).

`WP-F7` builds the `timingSafeEqual` primitive as a unit-tested, initially-failing
contract test; `WP-U0`'s Fastify bootstrap wires it in and is done-when that contract
test turns green, explicitly including "fails startup when token unset." Sample env
file — always a placeholder, never a real value:

```
DASHBOARD_TOKEN=<token>
```

### Listen host — fixed at `127.0.0.1`, never `0.0.0.0`

This is not a default that can be overridden — it is a fixed, loopback-or-fail bind.
`0.0.0.0` is never an accepted value, not behind a flag, not for convenience during
development. Three of the six audited rival dashboards (`simple10`, `cast`,
`claude-code-templates`) bind `0.0.0.0` by default and are LAN- or network-reachable
the moment the process starts regardless of what their auth layer does
([security model](../security/model.md) rule 1; DESIGN §8). `WP-U0` implements the
loopback-or-fail listen call; `WP-F7`'s contract tests assert the process refuses to
start bound to anything else, and the Phase 1 exit gate requires those tests green.

```
ANTI-PATTERN — never a real config value in this codebase, not even as an example:
  HOST=0.0.0.0
```

If you need to reach the dashboard from off the host, that is a tunnel problem, not a
bind-address problem — see [remote access](../security/remote-access.md): SSH
port-forward or Tailscale only, terminating at `127.0.0.1`, never a reverse proxy to a
widened bind.

### `token_ref` — secrets held by reference, never by value

The Telegram bot token (and any future webhook credential) is never stored as a raw
value anywhere the server writes to disk or sends over the wire. `WP-A3` owns a
`token_ref` **resolver**: the `webhook_targets` table stores a reference string, and the
resolver looks up the actual secret at delivery time from one of two operator-controlled
locations — `launchd` environment variables, or a file whose permissions are `chmod
600` and no wider. A static gate rejects any secret-holding dotfile with permissions
looser than `0600` as a build-failing condition, not a review-time reminder. CD-10
states the invariant directly: the token is held "via `token_ref` → launchd env /
chmod-600 (never in SQLite, never to the browser)." See
[Telegram alerts](telegram.md) for the delivery side of this, and
[data model](../architecture/data-model.md)'s `webhook_targets.token_ref` column for
the storage side — that column is a reference string, and no column in the alerting
schema ever holds the actual bot token.

## The ground-truth data source: `~/.claude/projects`

agenthropic's token counts are **ground truth**, read verbatim from
`~/.claude/projects/*.jsonl` — never inferred or estimated. This path is the standard
location Claude Code itself writes session transcripts to, and it is the source the
`TokenReader`/`TokenSource` port (CD-6) and the JSONL tail-follower (`WP-IN5`) read
from. No source document names an environment variable or config key for overriding
this location; whether one exists is `(planned)`. Treat the conventional path as fixed
today and any override mechanism as undecided.

## Storage: SQLite path and WAL mode

The single persisted store is SQLite, and it always runs in **WAL** journaling mode
with `foreign_keys` enforcement — both are pragma-asserted on **every connection open**
by `WP-D2`, not configured once and trusted to stay set. This is a structural
requirement (the ingest side writes continuously while the read side reads concurrently
for live views), not a tuning knob an operator can turn off. The exact filesystem path
the database lives at is `(planned)` — no source document fixes it; see
[data model](../architecture/data-model.md) for the schema this file holds and
[backup & restore](../operations/backup-restore.md) §1 for why WAL specifically.

```sql
-- Asserted on every connection open (WP-D2), not merely configured once:
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
```

## Backup directory and retention

`WP-F8` owns the backup routine (online-backup, safe against a live WAL database) and
its **tested-restore** proof; `WP-D10` owns the retention TTL sweeper and payload
redaction at the ingest boundary. Both the backup directory path and the retention
window (in days) are `(planned)` — no source document fixes either number. What *is*
fixed is the requirement itself: a backup exists, its restore path is actually
exercised (not assumed to work because a file exists), and CD-10 requires retention TTL
and payload redaction live from Phase 1, not deferred as later cleanup. Full detail,
including the tested-restore drill and the reference `launchd` scheduling shape:
[backup & restore](../operations/backup-restore.md).

## Cost engine: `model_pricing` source

`WP-C1` owns the versioned `model_pricing` table and its authoritative, dated seed —
DESIGN §4 names it as the table that drives the dollar-cost and delegation-savings
tiles, and CD-4 fixes the versioning columns (`effective_from`, `verified_on`)
literally. The seed itself must be pricing that is genuinely dated and verified, not a
hardcoded snapshot quietly going stale: `WP-C6`'s staleness gate fails CI outright if
the golden fixture corpus contains a model+bucket combination with no matching priced
row — a cost can never silently compute to zero for an unpriced model. The refresh
cadence for keeping this table current after ship is `(planned)`. See
[data model](../architecture/data-model.md) `model_pricing` and
[cost model](../architecture/cost-model.md) for dated-price resolution and
delegation-savings mechanics.

## Alert rules and webhook targets

`alert_rules` and `webhook_targets` are entirely **operator-configured** — there is no
default rule and no default target. An operator creates a rule (`cost_threshold`,
`stuck_agent`, or `error`, per `WP-A5`) and a delivery target (Telegram today, per
`WP-A2`) through the authenticated operator alerts API that `WP-A8` builds in Phase 6.
The webhook dispatcher (`WP-A4`) only ever calls a target row from this
operator-configured table — it never constructs a delivery URL from data that arrived
inside an ingested event, closing the SSRF path `disler`'s dispatcher left open
(DESIGN §8; [security model](../security/model.md) rule 6). Configuring the Telegram
relay itself — the bot token's `token_ref`, the rule kinds, and the throttled delivery
behavior — is the dedicated subject of [Telegram alerts](telegram.md), which ships with
Phase 5 per the roadmap, after the read API and dashboard (Phase 4).

## Security defaults

Every default on this page, where one exists at all, resolves toward the more
restrictive option, never the more permissive one:

- **Loopback-only** — the listen host has no configuration surface at all; it is
  `127.0.0.1` or the process does not start.
- **Auth is mandatory** — `DASHBOARD_TOKEN` unset means the process does not start,
  never "auth is off until you set one."
- **Realtime transport is same-origin SSE** — no wildcard CORS, ever; a cross-origin
  `Origin` on `/api/stream` is rejected (CD-5).
- **Secrets are held by reference** — `token_ref` resolves to `launchd` env or a
  `chmod 600` file; a raw secret is never accepted as a config value that gets written
  to SQLite, sent over SSE, or logged.

The full nine-rule catalogue — rule → why → how each is enforced, with the CI gate
backing every one — lives in [the security model](../security/model.md); this page
only restates the subset that is directly configuration-shaped.

## What's decided vs. open

| Aspect | Status |
|---|---|
| `DASHBOARD_TOKEN` mandatory, `timingSafeEqual`, fail-startup-when-unset | **Fixed** (DESIGN §8, `WP-U0`, `WP-F7`) |
| Listen host `127.0.0.1`, `0.0.0.0` never accepted | **Fixed** (DESIGN §8, `WP-U0`, `WP-F7`) |
| WAL mode + `foreign_keys` asserted on connect | **Fixed** (`WP-D2`, DESIGN §8) |
| Secret handling via `token_ref` (`launchd` env / `chmod 600`, `>0600` rejected) | **Fixed mechanism** (`WP-A3`, CD-10) |
| Listen port default | **Planned** — undecided |
| Config loader's env-vs-file precedence | **Planned** — `WP-U0` names a "config loader," format/precedence undecided |
| SQLite database path | **Planned** — undecided |
| Backup directory + retention window (days) | **Planned** — requirement fixed (CD-10, `WP-F8`/`WP-D10`), numbers undecided |
| `~/.claude/projects` override mechanism | **Planned** — conventional path assumed fixed, override undecided |
| `model_pricing` seed refresh cadence | **Planned** — versioning columns fixed (CD-4), cadence undecided |
| Stack underneath all of the above (Fastify, better-sqlite3, pnpm monorepo) | **Leaning — unconfirmed** (the project `CLAUDE.md`) |

## See also

- [Security model](../security/model.md) — the full nine-rule invariant catalogue this
  page's security defaults are drawn from.
- [Data model](../architecture/data-model.md) — the schema `model_pricing`,
  `webhook_targets.token_ref`, and the WAL-mode store hold.
- [Backup & restore](../operations/backup-restore.md) — the tested-restore drill and
  retention/redaction mechanics behind the backup options above.
- [Telegram alerts](telegram.md) — configuring the alert rules and the Telegram
  delivery target this page only summarizes.
- [Getting started](getting-started.md) — installation and first run, once Phase 1
  ships.
- [Roadmap](../guide/roadmap.md) — where each configuration slice lands, phase by
  phase.
