# FAQ

This page answers the eight questions people ask first about agenthropic: whether it's
cloud software, whether it calls home, what it costs, where your data lives, whether you
have to install its hooks, why it isn't a fork of an existing tool, whether it spans
machines, and how alerts reach you.
**Short version:** agenthropic is a self-hosted, local-first dashboard that binds to
`127.0.0.1` on your own machine, never sends telemetry anywhere, has no cloud bill
because there is no cloud tier, and the only thing it ever sends outbound is an alert
*you* configured — *(as built: nothing at all, because the alert sink was never built)*.
Every answer below links to the deeper reference page for the full detail.

> **Update — 2026-07 (as built).** This page was written before any code existed. Four
> corrections, and one of them changes an answer above:
>
> - **agenthropic is no longer pre-code — and it is also not released.** Implementation
>   began **2026-07-11**. Running today: the loopback-bound, token-gated server; SQLite/WAL
>   with thirteen migrations and a daily backup timer; JSONL ingest with replay-on-startup
>   and tail-follow polling that re-reads only new bytes; the persisted subagent DAG; the
>   cost engine; the hook receiver and its installer; the status watchdog that ages an
>   unobserved agent to `unknown`; the SSE hub; the read API; and all four dashboard views
>   plus a per-session cost-analysis panel. There is still no tag and no published package —
>   the workspace is `private: true` at `0.1.0`, so a checkout is the only way to run it.
>   Test figures, re-measured **2026-08-15**: **106 test files / 1554 tests**, with **100%
>   statements, branches, functions and lines** enforced in **all five** packages. Two
>   things that figure does not mean: the thresholds fail the CI run but do not yet *block a
>   merge* (that needs a branch-protection rule on `main`, an owner action, still unset at
>   the last recorded check), and coverage of the code is not accuracy of the output — the
>   hierarchy-accuracy exit gate still reports **NOT CERTIFIED at n = 0** because no session
>   has been hand-labeled.
> - **"The only outbound traffic is a Telegram alert" is now simply "no outbound traffic."**
>   Alerting was not built and may never be: it is v2.0, entered only via **KC-5**, and the
>   operator-alerts API and UI were **cut outright**. The running server **makes no
>   outbound network request of any kind**. Read every "Phase 5, not yet built" below as
>   "not built, not scheduled, possibly never."
> - **Retention is half-built: mechanism yes, policy no.** Redaction *is* implemented
>   (`apps/server/src/hooks/redact.ts`, applied at the hook ingest boundary, before the
>   idempotency key is computed). The retention *mechanism* — pruning, an audit journal,
>   backup-file expiry, a runner — is implemented and tested as well, but the *policy*,
>   meaning how many days of what is kept, is deliberately unset pending the OPEN-1/2/3
>   decisions. The shipped default is a no-op that opens no transaction and reads no row,
>   and nothing starts the runner at boot. So nothing prunes the database today; plan disk
>   accordingly.
> - **Still no footprint numbers.** No CPU/RAM/disk footprint has been measured even now,
>   and the v1.0 usability target ("<30s to understand a session") is **unmeasured** too.
>   One narrow exception, so that "no benchmarks" is not read wider than it is true:
>   `apps/server/bench/corpus-scale.ts` measures replay and query latency against a
>   **synthesised** corpus in a throwaway directory — it never reads the real
>   `~/.claude/projects`, its volume figures are inflated fixtures rather than observed
>   sessions, and it reports nothing about CPU, memory or disk. Its one published result
>   (a summary query going from 627 ms to 9 ms) is a before/after on that synthetic
>   corpus, not a claim about your machine.
>
> Two standing caveats: the Phase-0 spike numbers remain **PROVISIONAL** until ratified
> against a hand-labeled corpus, and the roadmap's kill checkpoints **KC-0 and KC-1 both
> passed unmet** — work continues by explicit owner override, not because the gates were
> satisfied. Also note that **no rival dashboard was ever installed and run**: the
> comparisons on this page come from reading their source during due diligence, and the
> project's friction log was never opened.

## Quick answers

| Question | Short answer |
|---|---|
| Cloud / SaaS? | No — self-hosted, local-first. Runs on your own machine. |
| Phones home? | No telemetry egress. **As built: no outbound traffic at all** — the alert sink was never built, so the server makes no outbound network request of any kind. |
| Cost to run? | No cloud bill — it's a local process + SQLite on hardware you already own. **Still no published CPU/RAM/disk figures.** One benchmark does exist (`apps/server/bench/corpus-scale.ts`), but it measures query and ingest *latency* against a **synthetic** corpus, not resource footprint on a real one — so it answers a different question than this row asks. |
| Data safety / location? | Local SQLite (WAL) on your machine; tokens read from your own `~/.claude/projects/*.jsonl`; auth-gated writes; nothing leaves the box by default. *(As built: all four hold. Redaction is live; retention is **mechanism-built, policy-unset** — the default is a no-op, so nothing prunes the database yet.)* |
| Do I have to install the hooks? | Optional, but they are the only signal that an agent *stopped*. Without them nothing ever reads `completed` — agents age `working` → `unknown`. `node hooks/install.mjs --out <settings.json>` writes them; `--dry-run` shows the result first. |
| Why not fork simple10 / hoangsonww? | Neither ships the actual moat; greenfield lets us take the good parts of each without inheriting either's baggage (one's non-persisted edges, the other's RCE). *(Judged by reading their source in 2026-07 — neither was installed and run.)* |
| Works across machines? | Not yet — single-host by design for now; the schema is hedged (`instance`/`host_id`) so fleet aggregation doesn't require a rewrite later. *(As built: the hedge is on `orchestration_edges` only, not every table.)* |
| How do alerts reach me? | **They don't — nothing is built.** Telegram to a bot you own was the design; it is now v2.0 behind KC-5, may never start, and its API and UI were cut. Alerts reach you only as the dashboard UI updating over SSE. |

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

> **As built, delete the bottom branch.** There is no webhook sink and no Telegram relay —
> not a stub, not a disabled feature, nothing. The running system's outbound arrow count is
> **zero**. The rest of the diagram is accurate, with one refinement: the hook-ingest arrow
> carries *liveness only*. The load-bearing input is the JSONL read, which is what
> builds the DAG, the agents, and every token row.

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

No CPU/RAM/disk footprint has been benchmarked — when this answer was first written the
project was still pre-code (bootstrap phase), so there was no measured number to quote
here. Storage growth over time was to be bounded by a retention TTL + payload-redaction
policy planned from Phase 1. See [the cost model](../architecture/cost-model.md) for the
dollar-cost/delegation-savings design and [backup & restore](../operations/backup-restore.md)
for retention.

> **As built: the code exists, the footprint numbers still don't.** The "pre-code" reason
> is stale — the system has been running since 2026-07 — but the conclusion is unchanged:
> **no CPU/RAM/disk footprint has been measured**, so there is still no figure to quote.
> Treat any expectation you form as a guess. The corpus-scale benchmark that does exist
> (`apps/server/bench/corpus-scale.ts`) measures latency on a synthetic corpus and says
> nothing about CPU, memory or disk.
>
> The storage sentence needs a sharper correction. **Payload redaction is implemented**
> (`apps/server/src/hooks/redact.ts`, applied at the hook ingest boundary). **The retention
> TTL is built but switched off.** The mechanism — pruning, an audit journal, backup-file
> expiry, a runner — exists and is tested; the policy it would enforce does not, because
> deciding how a TTL coexists with an append-only substrate is an owner decision (OPEN-1)
> and a scheduled deleter has no business existing before the rule that tells it what to
> delete is signed. The shipped default therefore deletes nothing and nothing starts the
> runner at boot. So storage growth is currently **unbounded**: nothing prunes the
> database. On a single developer machine this is small, but it is not capped by anything,
> and no one has measured how fast it grows.

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
  inside SQLite, never shipped to the browser. *(As built: no Telegram bot token exists,
  because no alerting was built. The `ANTHROPIC_API_KEY` rule holds — the server never
  calls an LLM API, or any API.)*
- **Retention:** a retention TTL and payload-redaction rule for stored tool payloads
  is planned from Phase 1 (not yet implemented — this project has no code yet).
  *(As built: half done, and the "no code yet" reason is stale. **Payload redaction is
  implemented** at the hook ingest boundary (`apps/server/src/hooks/redact.ts`). **The
  retention TTL is built but unconfigured** — the pruning mechanism, its audit journal and
  its runner all exist and are tested, but the policy is unset pending the OPEN-1/2/3
  decisions, the default is a no-op and no runner starts at boot, so nothing currently
  expires or prunes stored data.)*
- **Remote access, if you ever want it, is tunnel-only** — SSH port-forward or a
  Tailscale tunnel (e.g. `--host <tailscale-host>`), never a reverse proxy exposing
  the port publicly.

Full detail: [security model](../security/model.md) (the flagship security page),
[threat model](../security/threat-model.md) (what every audited rival got wrong and
how agenthropic structurally avoids it), [backup & restore](../operations/backup-restore.md).

## Do I have to install the hooks?

**No — but if you skip them, nothing in the dashboard will ever say `completed`.** That
is worth understanding before you decide, because it is a design decision rather than a
missing feature.

Reading a transcript proves that activity *happened*. It never proves that it *stopped*:
a JSONL file that has stopped growing is indistinguishable from one whose next line has
not been flushed yet. So the ingest path only ever writes `working`. The terminal signal
has to come from Claude Code itself, and hooks are how Claude Code offers it —
`SubagentStop` is what marks a subagent `completed`, and `Stop` marks a session's main
agent `waiting` (not `completed`, because `Stop` fires at the end of every *turn*, so it
means "idle right now"). Without those events an agent ages `working` → `unknown` when
the watchdog window elapses (`DASHBOARD_WATCHDOG_MINUTES`, default 10), and `unknown` is
the honest word: the dashboard declines to claim an ending nobody observed.

Installing them is one command:

```sh
node hooks/install.mjs --out /path/to/project/.claude/settings.json
```

It writes four fail-silent `curl` hooks — `UserPromptSubmit`, `Stop`, `SubagentStop`,
`PreCompact` — that POST their stdin JSON to the loopback ingest endpoint. The settings
file is backed up before it is touched and unrelated keys are preserved; `--dry-run`
prints the result without writing anything and `--remove` strips the agenthropic entries
again. The auth token never enters any process's argv: the generated command hands curl
the *name* of the environment variable and curl expands it itself at fire time, which
needs curl ≥ 8.3.0 — on an older curl the hook delivers nothing rather than leaking. A
dashboard that is down or unreachable never blocks your session either; the command runs
`--silent --fail --max-time 3` with a trailing `|| true`.

What hooks explicitly cannot do is change the shape of the graph. A hook event may move
an existing agent's `status` and nothing else — it can never create, delete or re-parent
a node in the DAG. Structure comes from the JSONL alone, which is why an outage in the
hook path costs you liveness, not history.

Details: [hooks installer](../usage/hooks-installer.md) and
[hook ingestion](../architecture/hooks.md).

## Why not just fork simple10 or hoangsonww?

Short answer: **because neither ships the actual product** — and the one that looks
richer out of the box carries a real remote-code-execution hole. The due-diligence
evaluated six real, running rivals; `simple10/agents-observe` and
`hoangsonww/Claude-Code-Agent-Monitor` were the two serious fork candidates.

> **How this was judged, honestly.** "Evaluated" here means **their source and
> documentation were read**, at commit state as of 2026-07-03. Neither project was
> installed, run, or used alongside agenthropic, and the project's friction log — the
> mechanism that was supposed to capture lived comparison — was never opened. The
> security findings below (the `0.0.0.0` bind, the no-op token, the `/api/run`
> permission-mode allow-list) are code-reading results, which is a fair basis for those
> specific claims; the usability and "what it feels like to live with" judgements are not
> claims this project has earned. Those repositories may also have changed since.

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
loop studied only as a teaching reference.
*(As built: **nothing was ever taken from `hoangsonww`** — its Telegram/webhook schema was
the only scheduled graft and alerting was never built. The `cast` auth-gate shape and
delegation-savings formula were clean-room reimplemented as required. The CD-9 licensing
rule is enforced in CI by `scripts/check-licenses.mjs`.)*
If out-of-box speed ever matters more
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

> **As built, the hedge is narrower than that sentence promises.** `instance` and `host_id`
> are `NOT NULL` columns on **`orchestration_edges` only** — not on "the schema generally,"
> and not on `agents`, `sessions`, `events` or `token_usage`. The moat artifact is
> fleet-keyed; the rest of the tables are not. A future fleet rollup is still an additive
> migration rather than a rewrite, but it would be a larger one than this paragraph
> implies. Nothing reads the key today, and no second host exists.

Cross-machine/fleet aggregation is explicitly listed as one of the five capabilities
no existing tool delivers, but it is **deferred until a second host physically
exists** ([ADR-0002](../contributing/decisions/adr-lb-2-personal-first-commercial-clean.md)/[ADR-0012](../contributing/decisions/adr-cd-10-scope-secrets-retention.md))
— a future decision, not a scheduled deliverable. See
[the DAG moat](../architecture/dag-moat.md)
for the persisted-edges design that carries the `instance`/`host_id` key, and
[the roadmap](roadmap.md) for why fleet aggregation is not in the phase sequence.

## How do alerts reach me?

> **As built: they don't, and this may never change.** No Telegram sink, no `alert_rules`,
> no `webhook_targets`, no dispatcher, no bot token — none of it was built, and the server
> makes no outbound network request of any kind. Alerting is **v2.0**, entered only via
> **KC-5**, a checkpoint earned by sustained real daily use and deliberately given no date;
> the operator-alerts API and UI (WP-A8/A9) were **cut outright**. The description below is
> the design record for work that has not started. If you need to be notified away from
> your desk, agenthropic does not do that today — watch the dashboard.

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
(SSE-pushed, loopback-only). *(As built: that is the current and only answer — the SSE
live view is built and working, and there is no "until" with a date attached to it.)*
Details: [telegram alerts](../usage/telegram.md)
(usage guide, filled once Phase 5 lands) and [the roadmap](roadmap.md) for the full
phase sequence.

---

**Still have a question this page doesn't answer?** Start from
[what is agenthropic](what-is-agenthropic.md) for the overall pitch, or
[the security model](../security/model.md) if the question is about safety and
exposure — that's the flagship security reference for this project.
