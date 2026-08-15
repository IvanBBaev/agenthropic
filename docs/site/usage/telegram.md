# Telegram alerts

> **How to read this page.** Unlike the rest of the usage section, nothing described
> here is built. The dashboard around it is: the server, the ingest pipeline, the
> persisted DAG, the cost engine and the four dashboard views all exist and run. The
> **alerting core and the Telegram sink do not**, and — as the box below explains —
> they are not on the schedule either. So read this as a design contract to check a
> future pull request against, not as a feature you can configure. Values marked
> _(planned)_ or _(leaning — unconfirmed)_ are the state of the design when it was
> written; the **security invariants are binding and will not change**.

> **Update — 2026-07 (as built): nothing on this page exists, and it is not on the
> path to existing.** Read the whole page as a design record, not as a feature you
> can configure. Specifically:
>
> - **Alerting is v2.0, and v2.0 has no start date.** It is off the v1.0 critical
>   path entirely. v1.0 (hard date **2026-12-01**) is explicitly defined as the
>   persisted cross-session DAG plus dollar-accurate cost, **"no alerts"**.
> - **v2.0 is entered only through kill checkpoint KC-5**, which is earned rather
>   than scheduled: **14 consecutive days of real daily use of v1.0 by its own
>   author**, plus **≥3 dated friction-log entries** actually wishing for a
>   notification. There is no other entry path. If that evidence never materialises,
>   **v2.0 never starts — and the roadmap counts that as a success, not a failure**,
>   because it will have prevented building a notification system for a dashboard
>   nobody opens.
> - **`WP-A8` (operator alerts API) and `WP-A9` (alerts UI) were CUT outright.** They
>   stay dead even if KC-5 is passed: "a single operator does not need CRUD screens
>   for himself" — configuration would live in a file. Every _(planned, `WP-A8`)_
>   step in the setup flow below therefore describes something that will not be
>   built in that form. The reduced v2.0 scope is `WP-A1`–`WP-A7` plus `WP-A10`.
> - **Zero alerting code exists in the repository**: no `alert_rules`,
>   `alert_events`, `webhook_targets` or `webhook_deliveries` table, no rules engine,
>   no dispatcher, no Telegram adapter, and no `token_ref` resolver. There is nothing
>   to enable, no flag to flip, and no partial version running. The absence is
>   structural rather than merely unfinished: those four table names appear nowhere in
>   the source tree, and the server has **no outbound HTTP client of any kind** — its
>   runtime dependencies are Fastify, TypeBox and `better-sqlite3`, and nothing under
>   `apps/server/src` or `packages/*/src` calls `fetch`, imports `node:http`/`node:https`,
>   or pulls in an HTTP library. (`fetch` does appear twice in the repository, in
>   `apps/web/src/api.ts` — the browser bundle calling this server's own relative `/api`
>   paths — and in `scripts/time-to-understand.mjs`, a local measurement script. Neither
>   is the server process and neither takes a URL from ingested data.) Note also that
>   **no automated gate defends this**: `scripts/check-no-spawner.mjs` has no
>   outbound-HTTP pattern, so the absence is upheld by review, not by CI.
>
> The security *rules* on this page do hold today, because they are project-wide and
> not alerting-specific: the server dials nothing derived from an ingested payload,
> and secrets never reach SQLite, SSE or logs. They hold trivially, in the sense that
> the outbound-dispatch code path they constrain has never been written — the first
> rule holds because the server cannot dial *anything*.

This page covers the designed alerting core — the rule engine, the no-SSRF webhook
dispatcher, the secret-handling contract, and the delivery guarantees — and its one
concrete delivery adapter, Telegram, relaying to `@baev_bot_bot`. The key takeaway:
alerts are a **security-sensitive dispatch path by construction** — the dispatcher only
ever dials operator-configured targets (never a URL taken from an event payload,
per [security model §6](../security/model.md#6-no-ssrf--never-dial-a-url-taken-from-an-event-payload)),
the bot token is held by reference and never touches SQLite, SSE, or logs, and a real
triggering condition is designed to produce **exactly one** throttled notification, not
a flood.

## What it is, and why it's a moat feature

Telegram alerting is one of the **five features confirmed absent across all six audited
rival dashboards** — see [the moat](../guide/the-moat.md) §2.3 and DESIGN §2, item 3:
"Telegram alert sink → `@baev_bot_bot`. Graft `hoangsonww`'s `formatTelegram` webhook
provider." `hoangsonww` is the one audited project with a ready-made Telegram bridge —
a `formatTelegram` webhook provider plus a full `alert_rules` / `webhook_targets` /
`webhook_deliveries` schema — and because it is MIT-licensed with a real `LICENSE` file,
that pattern is grafted **with attribution**, not clean-room reimplemented (the-moat §5;
concept-analysis-v2 CD-9). It is deliberately isolated from the rest of that codebase,
in particular its RCE spawner (`/api/run`) and its type-aggregated DAG cockpit — neither
of those is grafted, ever.

Turning the dashboard from "something you have to look at" into "something that tells
you when it needs attention" is the roadmap's own framing of Phase 5's goal (see the
[roadmap](../guide/roadmap.md)).

## Architecture at a glance

```
        projection (agents, sessions, token_usage — Phase 3 output)
                             │
                             ▼
              ┌───────────────────────────┐
              │   Alert rules engine       │   WP-A5
              │  cost_threshold / stuck_   │   reads the projection only —
              │  agent / error             │   never raw events_raw payloads
              └─────────────┬──────────────┘
                             │ rule fires → alert_events row (dedupe_key)
                             ▼
              ┌───────────────────────────┐
              │   AlertSink port           │   WP-A1 (packages/shared,
              │   pure interface           │   no server/driver import)
              └─────────────┬──────────────┘
                             ▼
              ┌───────────────────────────┐
              │  Webhook dispatcher        │   WP-A4 — dials ONLY rows in
              │  + no-SSRF guard           │   webhook_targets (operator-
              └─────────────┬──────────────┘   configured); never a payload URL
                             ▼
              ┌───────────────────────────┐
              │  Telegram AlertSink        │   WP-A6 — token resolved via
              │  adapter                   │   token_ref (WP-A3), never inline
              └─────────────┬──────────────┘
                             ▼
                    @baev_bot_bot (Telegram)
                             │
                             ▼
              ┌───────────────────────────┐
              │  Delivery log              │   WP-A7 — retry/backoff, dedupe,
              │  webhook_deliveries        │   rate-limit → exactly one
              └───────────────────────────┘   throttled notification per condition
```

Every box above is a named work package in `docs/analysis/development-plan.md`'s Track
A (`WP-A1…WP-A10`) — none of it is running code yet (see
[Current status](#current-status)).

## The three rule kinds

`WP-A5` ("Alert rules engine") fixes the rule taxonomy at exactly three kinds, evaluated
over the **projection** (Phase 3's `agents`/`sessions`/`token_usage` tables), never
directly over raw `events_raw`:

| Kind (`alert_rules.kind`) | What it observes | Operator configuration | Source |
|---|---|---|---|
| `cost_threshold` | A session's or agent's accumulated dollar cost (ground-truth tokens × dated price, per the [cost model](../architecture/cost-model.md)) crossing an operator-set dollar limit | A threshold amount, e.g. `{"threshold_usd": 5.00}` — set through the [operator alerts API](#the-designed-setup-flow-planned) once `WP-A8` ships | `WP-A5`'s Done-when states this boundary explicitly: "`cost_threshold` fires **exactly at** the operator limit (boundary tested)" |
| `stuck_agent` | An agent or session that has stopped making forward progress | No documented config shape yet — flagged open below | `WP-A5`'s Done-when names `stuck agent` as one of the three kinds; no further config schema is specified in any source in scope |
| `error` | An agent or session that resolves to an error condition | No documented config shape yet — flagged open below | `WP-A5`'s Done-when names `error` as the third kind |

Two of the three kinds are, honestly, thinly specified beyond their name — stated here
rather than papered over, per the project's own documentation style:

- **`stuck_agent`'s relationship to the watchdog is not settled.** DESIGN §6 names a
  general stuck-session watchdog pattern (a ~15 s transcript-interrupt marker +
  idle-timeout fallback, `fs.watch` with a polling safety net — see
  [troubleshooting §1](../operations/troubleshooting.md#1-stuck-session--the-watchdog-pattern)),
  and Phase 3's `WP-IN12` implements a **separate**, narrower missing-`SubagentStop` →
  `unknown`-state rule. [Troubleshooting](../operations/troubleshooting.md) is explicit
  that whether these two are the same underlying mechanism or two distinct ones is
  **not stated in any source document** — and neither source says which of them (if
  either) is what `WP-A5`'s `stuck_agent` alert rule actually keys off. Treat "a stuck
  agent triggers this alert" as the designed outcome, and the precise upstream signal
  as open pending Phase 3/5 implementation. *(As built: `WP-IN12` shipped, and it
  resolved the ambiguity in the narrow direction — one staleness sweep on every poll
  tick, moving an agent with no terminal signal and no recent activity from `working`
  to `unknown` after `DASHBOARD_WATCHDOG_MINUTES` (default **10**, **PROVISIONAL**).
  It is the only producer of `unknown`, and it deliberately never guesses `completed`.
  Nothing consumes it as an alert trigger, because there is no rules engine to consume
  it — see [the hooks installer](hooks-installer.md) for how the same signal reaches
  the dashboard's status column.)*
- **`error`'s exact trigger is likewise not spelled out beyond the enum name.** The
  closest fixed anchor is the `agents.status` `CHECK` constraint (DESIGN §4), whose four
  values include `'error'` — so the shape is plausibly "an agent whose status resolves
  to `error`," but no source states the rule's exact query. Do not read a specific
  implementation into this beyond the kind name itself.

## The no-SSRF dispatcher

This is the single most security-load-bearing piece of the alerting core, and it holds
regardless of anything else on this page: **the webhook dispatcher (`WP-A4`) only ever
dials operator-configured targets.** It never constructs an outbound URL from data that
arrived inside an ingested event.

- **Why this rule exists at all:** `disler`'s server dials an arbitrary
  `responseWebSocketUrl` taken straight from the incoming request body — a textbook
  server-side request forgery — and DESIGN §8 names it directly: "no SSRF (never dial a
  URL taken from an event payload — disler's bug)." [Security model rule
  6](../security/model.md#6-no-ssrf--never-dial-a-url-taken-from-an-event-payload) is the
  canonical statement of this rule for the whole project, not just alerting.
- **What "operator-configured" means concretely:** the only place a delivery target
  comes from is a row in `webhook_targets`, created through the authenticated operator
  alerts API (`WP-A8`) once it ships. No code path in the dispatcher ever reads a
  hostname, URL, or webhook path out of an `events_raw` payload, a hook event, or a
  JSONL transcript line.
- **How it's proven, not just asserted:** `WP-A4`'s Done-when is exactly this — "no
  code path reads a URL from a payload (test-proven)" — and `WP-A10`'s alerts
  negative-test corpus keeps a dedicated SSRF test green on every future change to the
  alerting surface: "SSRF test proves no payload-URL dial-out." The Phase 5 exit gate in
  `docs/analysis/development-plan.md` restates the same requirement as a release
  blocker, not a nice-to-have.
- **Belt-and-suspenders static gate:** the same build-failing static check that guards
  against a request-driven subprocess spawner also covers this — a static grep/AST gate
  (`WP-F5`) that turns CI red on an SSRF-shaped code path, independent of the dedicated
  negative test.

```
                    ┌──────────────────────────┐
   ALLOWED  ───────▶│ webhook_targets row       │──────▶ dial (Telegram, etc.)
                     │ (operator-configured,     │
                     │  created via WP-A8 API)   │
                     └──────────────────────────┘

                    ┌──────────────────────────┐
   NEVER   ─── ✗ ───│ a URL/host read out of an │        (disler's bug —
                     │ events_raw payload /      │         never built here)
                     │ hook event / JSONL line   │
                     └──────────────────────────┘
```

## Secret handling: `token_ref`, never the secret

The Telegram bot token is a secret, and the design treats it as one at every layer —
this is CD-10 in `docs/analysis/concept-analysis-v2.md`, stated verbatim: "Telegram
token via `token_ref` → launchd env / chmod-600 (never in SQLite, never to the
browser)."

- **The schema never has a column for the raw token.** The designed `webhook_targets`
  table (Phase 5, not yet built — reproduced from
  [the data model page](../architecture/data-model.md)) carries only a reference:

  ```sql
  CREATE TABLE webhook_targets (
    id          TEXT PRIMARY KEY,
    kind        TEXT NOT NULL CHECK(kind IN ('telegram')),
    token_ref   TEXT NOT NULL,   -- NEVER the secret itself
    enabled     INTEGER NOT NULL DEFAULT 1
  );
  ```

  `token_ref` is a **name**, not a value — it names where to resolve the actual secret
  from at runtime, and that name is the only thing ever written to SQLite.
- **`WP-A3` owns the resolver**, and it is scoped narrowly: "Secret handling: `token_ref`
  resolver (launchd env / chmod-600) + redaction + static gate. **A >0600 dotfile is
  rejected.**" Concretely, per CD-10 and the security model's placeholder convention,
  the two designed resolution sources are:
  - a `launchd`-supplied environment variable (held by the OS service manager, never
    written to a project file), or
  - a dotfile whose permissions are exactly `chmod 600` — anything looser (world- or
    group-readable) fails the resolver's static check rather than being silently
    accepted.
- **The secret never appears in SQLite, SSE, or logs** — this is the literal wording of
  Phase 5's exit gate in `docs/analysis/development-plan.md`: "the secret is never in
  SQLite/SSE/logs (0600 or launchd env only)." `WP-A10`'s negative-test corpus makes
  this a release-blocking test, not a review-time assumption: "secret-leak test proves
  no token in SQLite/browser."
- **The UI shows the `token_ref` name only, never the secret.** [The data model
  page](../architecture/data-model.md) states this directly, citing `WP-A9`'s alerts UI:
  it "shows `token_ref` name only, never the secret." No endpoint or view is designed to
  ever return the raw bot token once it is stored.
- **Any sample on this page (or anywhere else in the docs) uses a placeholder.**
  Consistent with the [security model](../security/model.md)'s convention for
  `DASHBOARD_TOKEN`, a Telegram bot token in a config example is written as a
  placeholder, never a real value:

  ```
  # illustrative only — WP-A3's resolver is not yet built
  TELEGRAM_BOT_TOKEN_REF=<token-ref-name>
  ```

See also [configuration](configuration.md) for how secrets fit into the broader config
surface — that page is no longer a stub: it enumerates the environment variables the
server actually reads, including the one secret that *is* live today, `DASHBOARD_TOKEN`,
which is held to the same never-in-SQLite, never-to-the-browser rule `token_ref` is
designed around.

## Delivery guarantees: exactly one throttled notification

`WP-A7` ("Delivery log with retry/backoff + dedupe & rate-limit") fixes the outcome a
real triggering condition must produce: **exactly one** throttled notification, not a
flood of duplicate pings every time the underlying condition is re-observed. This is
restated as a release-blocking exit gate for Phase 5 in
`docs/analysis/development-plan.md`: "a real error/stuck condition yields exactly one
throttled notification."

The designed `webhook_deliveries` table (Phase 5, not yet built) carries the columns
that make this mechanical, not aspirational:

```sql
CREATE TABLE alert_events (
  id           TEXT PRIMARY KEY,
  rule_id      TEXT NOT NULL REFERENCES alert_rules(id),
  session_id   TEXT,
  agent_id     TEXT,
  fired_at     TEXT NOT NULL,
  dedupe_key   TEXT NOT NULL   -- rate-limit/dedupe boundary, WP-A7
);

CREATE TABLE webhook_deliveries (
  id               TEXT PRIMARY KEY,
  target_id        TEXT NOT NULL REFERENCES webhook_targets(id),
  alert_event_id   TEXT NOT NULL REFERENCES alert_events(id),
  status           TEXT NOT NULL CHECK(status IN ('pending','sent','failed')),
  attempt_count    INTEGER NOT NULL DEFAULT 0,
  next_retry_at    TEXT,
  delivered_at     TEXT
);
```

- **`alert_events.dedupe_key`** is the boundary a repeated firing of the same
  condition collapses against, per the data model page's own rationale for this column.
- **`webhook_deliveries.attempt_count` / `next_retry_at`** carry the retry/backoff
  state machine — a failed delivery is retried on a backoff schedule rather than either
  being dropped silently or retried in a tight loop.
- **A delivery log is queryable, not just internal state.** `webhook_deliveries.status`
  (`pending` / `sent` / `failed`) is the durable record `WP-A9`'s alerts UI reads to show
  a delivery-log view to the operator, once Phase 6 ships that surface.

## The designed setup flow _(planned)_

No operator-facing setup flow exists yet — the operator alerts API (`WP-A8`) and alerts
UI (`WP-A9`) are Phase 6 work, not yet built. The shape below is the designed sequence,
marked planned throughout since exact endpoint paths, request/response shapes, and UI
copy are not fixed by any source:

> **As built: steps 3 and 4 will not happen in this form.** `WP-A8` and `WP-A9` were
> cut, so there is no API to register a target through and no UI to configure a rule
> in — the surviving intent is that configuration would live in a file. Read the
> numbered steps for the *contract* they fix (a target is operator-configured; the
> request carries a `token_ref` name, never a secret), not for the mechanism they
> name. Steps 1 and 2 are external to agenthropic and unaffected.

1. **Register a Telegram bot and obtain a chat id** _(planned; external to
   agenthropic)_ — done through Telegram's own bot-registration flow (e.g. BotFather),
   entirely outside agenthropic's own surface. agenthropic never talks to Telegram's
   bot-management API on the operator's behalf; it only ever sends messages once a
   target is configured.
2. **Store the bot token by reference, not by value** _(planned)_ — the operator places
   the token where `WP-A3`'s resolver expects it (a `launchd` environment variable, or a
   `chmod 600` dotfile), never inside a request body or a database row.
3. **Register a `webhook_targets` row through the authenticated operator alerts API**
   _(planned, `WP-A8`)_ — auth-gated, `timingSafeEqual`-protected, cross-origin
   rejected, same as every other write endpoint (see [security
   model](../security/model.md)). The request supplies the `token_ref` **name**, never
   the secret value.
4. **Configure an `alert_rules` row: a rule kind, its config, and the target to fire
   through** _(planned, `WP-A8`)_ — e.g. a `cost_threshold` rule with a dollar limit,
   pointed at the `webhook_targets` row created in step 3.
5. **A real condition fires the rule, producing exactly one throttled delivery**
   (§ [Delivery guarantees](#delivery-guarantees-exactly-one-throttled-notification)) to
   `@baev_bot_bot`.

Once `WP-A9`'s alerts UI ships, steps 3–4 are expected to move from raw API calls to UI
forms — but that UI does not exist yet, and no source specifies its exact fields beyond
"rule config, target registration, delivery-log view."

## Work packages behind this page

For traceability, every claim above maps to one of these ten work packages in Track A
of `docs/analysis/development-plan.md` (Phase 5–6):

| WP | Owner | Delivers |
|---|---|---|
| `WP-A1` | backend | `AlertSink` port + alert domain types (`packages/shared`) — pure interface, no server/driver import |
| `WP-A2` | data | Alert & webhook schema migration (clean-room-safe, hoangsonww-attributed); forward-only, idempotent |
| `WP-A3` | security | `token_ref` resolver (launchd env / chmod-600) + redaction + static gate; a >0600 dotfile is rejected |
| `WP-A4` | security | Webhook dispatcher + no-SSRF guard; no code path reads a URL from a payload |
| `WP-A5` | backend | Rules engine (cost threshold / stuck agent / error) over the projection |
| `WP-A6` | backend | Telegram `AlertSink` adapter (hoangsonww-attributed), token via `token_ref`, per `AlertKind` |
| `WP-A7` | backend | Delivery log + retry/backoff + dedupe & rate-limit → exactly one throttled notification |
| `WP-A8` | backend | Operator alerts API — auth-gated CRUD for rules + targets |
| `WP-A9` | frontend | Alerts UI — rule config, target registration, delivery-log view; `token_ref` name only |
| `WP-A10` | qa | Alerts negative-test corpus + coverage hardening — SSRF and secret-leak tests |

## Current status

The paragraph that stood here described a pre-Phase-0 project waiting on a feasibility
verdict. That is no longer where things are, and the change is worth stating precisely,
because it moves alerting *further* from being built rather than closer.

The Phase-0 spike returned **CONDITIONAL GO**, and the prerequisite phases this page said
had not landed have landed: the security spine, the ingest substrate, the persisted
projection and the read API all exist and run. Every dependency alerting was waiting on is
therefore satisfied. What changed at the same time is the schedule those dependencies were
supposed to feed. **v1.0 is defined as the persisted cross-session DAG plus dollar-accurate
cost, explicitly "no alerts"**, with a hard date of **2026-12-01**; alerting was moved
wholesale into v2.0, and v2.0 is entered only through kill checkpoint **KC-5** — fourteen
consecutive days of the author actually using v1.0 daily, plus at least three dated
friction-log entries wishing for a notification. Nothing schedules it; only evidence
admits it. Two of the ten work packages below, `WP-A8` (operator alerts API) and `WP-A9`
(alerts UI), were **cut outright** and stay cut even if KC-5 passes, on the reasoning that
a single operator does not need CRUD screens for himself.

So the old "longest tail of the whole graph" framing has inverted. Alerting is not the
last thing blocking a release; it is deliberately outside the release, and the honest
current status is that **it may never be built at all — and the roadmap counts that
outcome as a success**, since it would mean the project declined to build a notification
system for a dashboard nobody opens. Everything above this section remains a **binding
design commitment to check a future pull request against**, and none of it is a
description of running code.

## See also

- [Security model](../security/model.md) — the full nine-rule control catalogue,
  including rule 6 (no SSRF) and the secret-handling posture this page applies to
  Telegram specifically.
- [Troubleshooting](../operations/troubleshooting.md) — the stuck-session watchdog
  pattern the `stuck_agent` rule kind draws on, including what's still unresolved about
  its exact trigger.
- [The moat](../guide/the-moat.md) — why Telegram alerting is one of the five features
  no audited rival delivers, and the licensing mode (copy-with-attribution) that governs
  grafting `hoangsonww`'s webhook provider.
- [Configuration](configuration.md) — the broader environment/config surface, now built
  and documented, that `token_ref` resolution would sit inside.
- [Roadmap](../guide/roadmap.md) — Phase 5's exit gate and Phase 6's operator-UI
  follow-on, and how alerting's critical-path position was derived.
- [Data model](../architecture/data-model.md) — the full designed DDL for
  `alert_rules`, `alert_events`, `webhook_targets`, and `webhook_deliveries`.
