# FAQ

This page answers the seven questions people ask first about agenthropic: whether it's
cloud software, whether it calls home, what it costs, where your data lives, why it
isn't a fork of an existing tool, whether it spans machines, and how alerts reach you.
**Short version:** agenthropic is a self-hosted, local-first dashboard that binds to
`127.0.0.1` on your own machine, never sends telemetry anywhere, has no cloud bill
because there is no cloud tier, and the only thing it ever sends outbound is an alert
*you* configured. Every answer below links to the deeper reference page for the full
detail.

## Quick answers

| Question | Short answer |
|---|---|
| Cloud / SaaS? | No — self-hosted, local-first. Runs on your own machine. |
| Phones home? | No telemetry egress. The only outbound traffic is an operator-configured Telegram alert (Phase 5, not yet built). |
| Cost to run? | No cloud bill — it's a local process + SQLite on hardware you already own. No published CPU/RAM/disk figures yet (pre-code). |
| Data safety / location? | Local SQLite (WAL) on your machine; tokens read from your own `~/.claude/projects/*.jsonl`; auth-gated writes; nothing leaves the box by default. |
| Why not fork simple10 / hoangsonww? | Neither ships the actual moat; greenfield lets us take the good parts of each without inheriting either's baggage (one's non-persisted edges, the other's RCE). |
| Works across machines? | Not yet — single-host by design for now; the schema is hedged (`instance`/`host_id`) so fleet aggregation doesn't require a rewrite later. |
| How do alerts reach me? | Telegram, to a bot you own (`@baev_bot_bot`) — a Phase 5 roadmap item, not yet built. |

---

## Is it cloud or SaaS?

**No.** agenthropic is a **self-hosted, local-first dashboard** — there is no hosted
version, no multi-tenant backend, and no account system. The reference deployment
target is Ivan's own Mac Mini M4; the server binds `127.0.0.1` (loopback) only and is
never widened to `0.0.0.0`. This bind rule is a non-negotiable security invariant, not
a configuration default you're expected to change.

The baseline it differentiates against, `davila7/claude-code-templates`, is *also*
self-hosted and zero-install (`npx claude-code-templates --analytics`), so "not SaaS"
is table stakes in this space — agenthropic's distinguishing bets are the persisted
orchestration DAG and dollar-cost attribution the baseline lacks (plus, post-1.0,
Telegram alerting), not the deployment model itself.

See [what is agenthropic](what-is-agenthropic.md) for the full pitch and
[the security model](../security/model.md) for the loopback/auth invariants.

## Does it phone home?

**No.** There is no analytics SDK, no crash reporter, no update-check ping, and no
vendor telemetry endpoint anywhere in the design. The only two things the running
system ever talks to are things *you* pointed it at:

```
                 ┌───────────────────────────────────────────┐
                 │              your machine                 │
                 │                                             │
Claude Code ──►  hook-ingest ──► SQLite (WAL) ──► SSE ──► browser SPA
(local hooks)        │                                        (loopback only)
                 reads ~/.claude/projects/*.jsonl (local file, ground-truth tokens)
                 │
                 └──► webhook sink ──► Telegram relay (@baev_bot_bot)   ← the ONE
                                                                            outbound
                                                                            hop, and
                                                                            only if
                                                                            you set
                                                                            up an
                                                                            alert rule
```

The Telegram relay (roadmap Phase 5, not built yet) is the sole outbound network call
in the whole design, and it only fires against `webhook_targets` you configured
yourself — the server never dials a URL taken from an incoming event payload (the
no-SSRF invariant: it does not repeat `disler`'s bug of dialing an
attacker-controlled `responseWebSocketUrl` from a request body). `ANTHROPIC_API_KEY`
is kept out of the dashboard's environment entirely unless a specific feature truly
needs it — the dashboard's job is to *read* your existing Claude Code logs, not to
call any LLM API on your behalf.

Details: [security model](../security/model.md) (loopback + no-SSRF), [remote
access](../security/remote-access.md) (how *you* reach the dashboard, never the
reverse), [telegram alerts](../usage/telegram.md).

## Roughly what does it cost to run?

**There is no metered service to pay for**, because there is no cloud tier — the
whole point of "self-hosted, local-first" is that agenthropic is a process (Fastify
leaning) plus a SQLite file running on hardware you already own. The incremental cost
is whatever your machine already costs to keep on, not a per-seat or per-event bill.

Two things keep that cost near zero in practice:

- **Docker is deliberately avoidable.** The base pattern agenthropic follows
  (`AGENTS_OBSERVE_RUNTIME=local`, the runtime mode singled out in the due-diligence
  recommendation) runs pure Node + native `better-sqlite3` under `launchd`, with no
  always-on container daemon competing for resources on a small box.
- **It ingests logs you're already generating.** Token counts come from
  `~/.claude/projects/*.jsonl`, which Claude Code writes regardless of whether
  agenthropic exists — there's no additional API usage caused by observing it.

What this question does **not** cover: what *Claude Code itself* costs you in
API/subscription usage. That's a separate number agenthropic exists to surface, not
to add to — the dollar-cost attribution and delegation-savings tile (Haiku/Sonnet
routing vs top-tier pricing) is one of the two features that make up the moat proper,
folded into Phase 3's cost engine (the reconciled build plan supersedes `DESIGN.md`'s
earlier standalone-Phase-4 sketch — see [the cost model](../architecture/cost-model.md)).

No CPU/RAM/disk footprint has been benchmarked yet — the project is pre-code
(bootstrap phase), so there is no measured number to quote here. Storage growth over
time is bounded by a retention TTL + payload-redaction policy planned from Phase 1,
not yet implemented. See [the cost model](../architecture/cost-model.md) for the
dollar-cost/delegation-savings design and [backup & restore](../operations/backup-restore.md)
for retention.

## Is my data safe? Where does it live?

**It lives in a SQLite database file on your own machine, in WAL mode, and it never
leaves that machine by default.** Concretely:

- **Storage:** SQLite in WAL mode, with backups — not a managed cloud database, not
  a third-party SaaS store.
- **Tokens are ground truth, read locally:** every token count comes from your own
  `~/.claude/projects/*.jsonl` files, never inferred and never uploaded anywhere to
  be computed.
- **Access control:** every write endpoint is auth-gated behind a mandatory
  `DASHBOARD_TOKEN` (e.g. `DASHBOARD_TOKEN=<token>`), compared with `timingSafeEqual`
  — not a token that's a silent no-op when unset. The SSE channel enforces a
  same-origin check.
- **No secret leakage:** `ANTHROPIC_API_KEY` is kept out of the dashboard's
  environment unless a feature genuinely requires it, and any Telegram bot token is
  planned to live behind a `token_ref` into `launchd` env / a chmod-600 file — never
  inside SQLite, never shipped to the browser.
- **Retention:** a retention TTL and payload-redaction rule for stored tool payloads
  is planned from Phase 1 (not yet implemented — this project has no code yet).
- **Remote access, if you ever want it, is tunnel-only** — SSH port-forward or a
  Tailscale tunnel (e.g. `--host <tailscale-host>`), never a reverse proxy exposing
  the port publicly.

Full detail: [security model](../security/model.md) (the flagship security page),
[threat model](../security/threat-model.md) (what every audited rival got wrong and
how agenthropic structurally avoids it), [backup & restore](../operations/backup-restore.md).

## Why not just fork simple10 or hoangsonww?

Short answer: **because neither ships the actual product** — and the one that looks
richer out of the box carries a real remote-code-execution hole. The due-diligence
evaluated six real, running rivals; `simple10/agents-observe` and
`hoangsonww/Claude-Code-Agent-Monitor` were the two serious fork candidates.

| | `simple10/agents-observe` | `hoangsonww/Claude-Code-Agent-Monitor` |
|---|---|---|
| Independent grade | **A−** | **B−** |
| Subagent tree | Real (`buildAgentTree()`), but **event-derived and session-scoped** — not persisted rows | Real, but the visible "DAG cockpit" is a **type-aggregated 3–4-layer diagram**; true nesting is a post-hoc indented tree |
| Tests | 78 test files, 1,985 `expect()` calls | 65 test files, ~1,900 assertions |
| License | MIT + real LICENSE (safe to copy with attribution) | MIT + LICENSE, but bus factor = 1 (all 208 files single-author) |
| Security as shipped | Binds `0.0.0.0`, no auth, wildcard CORS | Token is a **no-op when unset**; `/api/run` accepts `permission-mode` from the request body and its allow-list includes `bypassPermissions` → **remote code execution** |
| Docker | Avoidable (`AGENTS_OBSERVE_RUNTIME=local`) | N/A |
| Telegram / dollar-cost | Neither built | Has a genuinely reusable `formatTelegram` webhook provider + `alert_rules`/`webhook_targets` schema |

Two things matter more than the table:

1. **A first vendor pass tie-broke toward hoangsonww on a factual error** — it
   claimed simple10 "has no true DAG." That's false (simple10 ships
   `buildAgentTree()`); corrected, the vendor's own weighted model ranks simple10
   first. An earlier due-diligence recommendation accordingly proposed forking
   simple10 instead — flipping the vendor's pick.
2. **But forking either one still doesn't get you the product.** The five things
   *no* audited project delivers — a global, persisted, per-instance orchestration
   DAG; live dollar-cost attribution with delegation-savings; a Telegram alert sink;
   cross-machine/fleet aggregation; and persistence you fully control — have to be
   built regardless of which base you start from. Forking buys you someone else's
   architecture (and someone else's bugs: simple10's `0.0.0.0`/no-auth exposure, or
   hoangsonww's RCE spawner and bus-factor-1 support burden) to get most of the way
   to nothing you actually needed.

The final decision is therefore **greenfield**: build clean, ports-and-adapters, in
the spirit of a previous project (`kiko`), and *steal the individually best pieces*
from across the field rather than inherit any one project's baggage — simple10's
ports/adapters storage and tree-building pattern, hoangsonww's Telegram/webhook
schema, copied **with attribution** as MIT permits (the dual-SQLite-driver fallback
was dropped per best-path §6.3 — single `better-sqlite3` driver); `cast`'s
auth-gate shape and delegation-savings formula reimplemented
clean-room (its license is not compatible with copying); the `disler` hook-ingest
loop studied only as a teaching reference. If out-of-box speed ever matters more
than clean ownership later, the documented fallback is to fork **simple10**
specifically (hardened: loopback + mandatory token, `local` runtime under
`launchd`) — never hoangsonww, because of the spawner.

See [the moat](the-moat.md) for the five features that motivate building at all,
[comparison](comparison.md) for the full six-rival table, and the project's
due-diligence files (`recommendation.md`, `security.md`, and the per-project reports
under `projects/`) for the underlying evidence.

## Does it work across machines?

**Not yet — it's single-host by design for now, but the schema doesn't block adding
fleet support later.** Every one of the six audited rivals is single-host; the
project's own two load-bearing decisions explicitly **defer** fleet aggregation and
multi-tenancy in favor of a personal-first, single Mac Mini cockpit — that's a
scope decision, not a technical ceiling.

The cheap hedge that *is* taken now: every row that matters to the orchestration
graph — `orchestration_edges`, and the schema generally — carries a non-null
`instance`/`host_id` key from its very first migration, even though nothing reads or
aggregates across that key yet. That means a future "watch two Macs from one
dashboard" feature is an additive migration, not a data-model rewrite.

Cross-machine/fleet aggregation is explicitly listed as one of the five capabilities
no existing tool delivers, but it is **deferred until a second host physically
exists** ([ADR-0002](../contributing/decisions/adr-lb-2-personal-first-commercial-clean.md)/[ADR-0012](../contributing/decisions/adr-cd-10-scope-secrets-retention.md))
— a future decision, not a scheduled deliverable. See
[the DAG moat](../architecture/dag-moat.md)
for the persisted-edges design that carries the `instance`/`host_id` key, and
[the roadmap](roadmap.md) for why fleet aggregation is not in the phase sequence.

## How do alerts reach me?

**Telegram, to a bot you control (`@baev_bot_bot`) — this is a Phase 5 roadmap item
and is not built yet.** The design grafts `hoangsonww`'s `formatTelegram` webhook
provider and its `alert_rules` / `alert_events` / `webhook_targets` /
`webhook_deliveries` schema (copied with attribution, since that piece of
hoangsonww is MIT-licensed) onto the outbound side of the ingest pipeline: an alert
rule (cost threshold, stuck agent, or error) matches an event, and delivery to your
configured webhook target is recorded and retried like any other outbound
integration.

Two invariants apply here specifically:

- **No SSRF.** Webhook targets are operator-configured ahead of time; the server
  never dials a URL taken from an incoming event payload.
- **The bot token never touches the browser or the database.** It's planned to be
  referenced (`token_ref`) into a `launchd` environment variable or a chmod-600
  file, kept separate from `SQLite` and never returned by any API response.

Until Phase 5 ships, the only place alerts "reach you" is the dashboard UI itself
(SSE-pushed, loopback-only). Details: [telegram alerts](../usage/telegram.md)
(usage guide, filled once Phase 5 lands) and [the roadmap](roadmap.md) for the full
phase sequence.

---

**Still have a question this page doesn't answer?** Start from
[what is agenthropic](what-is-agenthropic.md) for the overall pitch, or
[the security model](../security/model.md) if the question is about safety and
exposure — that's the flagship security reference for this project.
