# Hooks installer

> **Design-target documentation — pre-Phase-0.** This page documents agenthropic's
> *intended* behavior for installing the Claude Code lifecycle hooks, as fixed by the
> design basis (docs/ai/DESIGN.md) and the build plan (docs/analysis/development-plan.md).
> **No application code is built yet** (see the [roadmap](../guide/roadmap.md)); installing
> the Claude Code lifecycle hooks ships in **Phase 2 — Ingest substrate**. Values marked
> _(planned)_ or _(leaning-unconfirmed)_ may change; the **security invariants are binding
> and will not**. This replaces the earlier stub.

This page documents how the Claude Code lifecycle hooks are designed to be installed and
verified end to end: where the hook scripts live, how they're registered in Claude Code's
own settings, the authed loopback receiver they POST to, how a hook acquires
`DASHBOARD_TOKEN` without leaking it, and how to confirm a real session actually produced
an `events_raw` row. The key takeaway: **there is no installer yet** — this is the target
contract one devops-owned work package, `WP-X8`, has to satisfy, and its own Done-when is
exactly the phrase the title of this page describes: *"Install → working end-to-end hook →
loopback ingest → `events_raw` on a real session"* (`docs/analysis/development-plan.md`).
Background on what the hooks carry and why two of them get special treatment is
[hook ingestion](../architecture/hooks.md) — this page does not duplicate that catalogue,
it covers getting the scripts onto disk, wired into Claude Code, and proven to work.

## What the hooks are, and why `SubagentStart`/`Stop` are first-class

agenthropic wires all **twelve Claude Code lifecycle events** to a single hook-handler,
which forwards every event, unmodified, to one authed loopback receiver (`DESIGN.md` §5;
[hook ingestion](../architecture/hooks.md)):

`PreToolUse` · `PostToolUse` · `PostToolUseFailure` · `UserPromptSubmit` · `Notification` ·
`Stop` · `SubagentStop` · `SubagentStart` · `SessionStart` · `SessionEnd` · `PreCompact` ·
`PermissionRequest`

Two of the twelve — **`SubagentStart`** and **`SubagentStop`** — get dedicated handling
because they are the only events that can directly assert a parent→child relationship, and
`agents.parent_agent_id` / `orchestration_edges` (the hierarchy tables — "the subagent tree
is a data fact, not a client-side UI reconstruction," `DESIGN.md` §3) are built from them.
Everything else lands as an interim liveness/state signal that the projection later
reconciles against JSONL (`CD-3`). The installer's job is purely mechanical relative to
that distinction — it wires all twelve the same way; the *dedicated handling* happens
downstream in the Normalizer/Projection, not in the hook script itself.

One caveat that directly affects what the installer can register: `SubagentStart` is
listed in parentheses in `DESIGN.md` §5 — `` `SubagentStop` (+ `SubagentStart`) `` —
because the source-level pass behind the build plan flags it as "probably not a real
hook" (`concept-analysis-v2.md` §4.2). Confirming or denying it is Phase-0's **G0.2**
probe (`WP-S4`), and `WP-X8` (the installer) **depends on `WP-S4`** for exactly this
reason — the installer can't finalize which event names it registers until the hook
catalog itself is confirmed. If `SubagentStart` turns out not to fire, the installer still
registers the other eleven; edge derivation falls back to the JSONL `Agent`/`Workflow`
spawn chain plus `SubagentStop` (`WP-IN8`, dual-path derivation), with no change to what
gets installed.
Full treatment of the hedge is the dedicated `SubagentStart` section in
[hook ingestion](../architecture/hooks.md).

## The designed install procedure

`WP-X8` (`devops`, size `M`) is scoped as *one* work package covering four things
together: `hooks/` scripts, install docs, leak-free token acquisition, and an
end-to-end smoke test (`development-plan.md` §2, merge note 4 — it absorbs the earlier,
separately-tracked `WP-IN4`). It depends on `WP-S4` (hook catalog confirmed), `WP-IN1`
(envelope/idempotency contract), `WP-S7` (the Phase-0 GO/CONDITIONAL-GO verdict — no
production code before it, `CD-8`), and `WP-IN3` (the receiver has to exist before there's
anything to install against). None of those four have landed as of this writing, which is
exactly why this page is design-target, not a runbook you can follow today.

```
~/.claude settings                              Mac Mini M4 — 127.0.0.1 only
(hook registration — planned shape below)                │
        │ Claude Code fires a lifecycle event             │
        ▼                                                 │
single hook-handler script (hooks/, planned)              │
  reads DASHBOARD_TOKEN by reference — never argv/log     │
        │ HTTP POST, one event per call                   │
        ▼                                                 │
loopback-or-fail bind · timingSafeEqual(DASHBOARD_TOKEN)  │
        │ 202 Accepted — accept-any-event (WP-IN3)         │
        ▼                                                 │
HookSource adapter → envelope + idempotency key (WP-IN1)  │
        │                                                  │
        ▼                                                 │
events_raw  (append-only, WP-D4) ◄── verify this row lands
```

### Where the scripts live: `hooks/` _(planned)_

The repo-structure decision itself is open (`CLAUDE.md`: "Stack & repo
structure are an open decision"), but the leaning shape already names a home for
installable hook scripts: a top-level **`hooks/`** directory in a pnpm monorepo
(`implementation-plan.md`, D4: `hooks/` alongside `packages/server`/`packages/web`/
`packages/shared`; `concept-analysis-v2.md` §4.2 reconciles the deployables naming to
`apps/server` + `apps/web` — "reconciles BASE `packages/*` vs EXPANDED `apps/*`" — while
keeping `hooks/` as the installable-scripts home and adding `packages/test-fixtures`).
`apps/server`/`apps/web` is the naming used consistently elsewhere on this site
([security model](../security/model.md), [development plan](../../analysis/development-plan.md)).
Mark this `hooks/` path _(leaning-unconfirmed)_ — it is not fixed until `WP-X8` ships.

The structural pattern the scripts are meant to follow — not copy — is `simple10`'s
strategy-pattern separation, `hooks/scripts/lib/agents/<class>.mjs`, which cleanly
isolates the Claude-Code-specific ingestion shape from everything downstream (`DESIGN.md`
§3, §7; [architecture overview](../architecture/overview.md)). The single-hook-handler
design (one script every event calls into, per the diagram above) is exactly this
separation applied at the installer level: twelve registrations, one implementation.

What the scripts are explicitly **not**: a copy of `disler`'s `send_event.py`.
`DESIGN.md` calls that ~180-line script "the clearest teaching example of hook→HTTP→
SQLite→WS" but is equally explicit that agenthropic does **not** build on it — "no
license, no tests, dead subagent path — its server *drops* `agent_id`/`agent_type`"
(`DESIGN.md` §3, §7). `disler` carries no license file and is classified **clean-room,
teaching-reference-only** under `CD-9` ([licensing & provenance](../contributing/licensing.md)),
which is exactly why `WP-X8` appears in the `CD-9` coverage list
(`development-plan.md` §6) alongside the other clean-room-authored work packages: the
loop's *shape* is instructive, its code is never read while writing agenthropic's own
`hooks/` scripts.

### Registering the hooks in Claude Code settings (`~/.claude`) _(planned)_

Claude Code reads its own hook configuration from settings under `~/.claude`. The exact
keys and matcher shape the installer writes into that file are **not yet fixed** — this
is precisely the "hook-POST auth mechanics" open question's sibling: item 8 in
`concept-analysis-v2.md` §7 asks *how* the token is obtained (next section); the
registration shape itself is simply undesigned until `WP-X8`. The design intent, per the
single-hook-handler principle above, is one dispatcher entry point that every registered
event name invokes — not twelve bespoke integrations:

```jsonc
// ILLUSTRATIVE ONLY — not a fixed shape; keys, matcher syntax, and the script path
// are all (planned), pending WP-X8. Shows intent: one dispatcher, all twelve events.
{
  "hooks": {
    "PreToolUse":        [{ "hooks": [{ "type": "command", "command": "hooks/dispatch.sh PreToolUse" }] }],
    "PostToolUse":       [{ "hooks": [{ "type": "command", "command": "hooks/dispatch.sh PostToolUse" }] }],
    "SubagentStop":      [{ "hooks": [{ "type": "command", "command": "hooks/dispatch.sh SubagentStop" }] }]
    // ... remaining nine events, same shape (SubagentStart included opportunistically —
    // see the G0.2 hedge above; its absence must not break the other eleven)
  }
}
```

`hooks/dispatch.sh` above is a placeholder name, not a fixed filename — the point the
sketch makes is structural: every entry calls into the same shared script, which reads
the event payload, attaches the token (next section), and POSTs to the loopback receiver.
Because `WP-S4` hasn't confirmed the final hook catalog yet, the installer's own registered
event list is provisional until that probe reports — consistent with the ingest boundary
itself being **accept-any-event** (below), a hook name the installer doesn't yet know
about is still safe to leave registered.

### The receiver they POST to: `HookSource` _(WP-IN3)_

Every hook script POSTs to the same server every other agenthropic client talks to — not
a separate, less-guarded ingest port. `WP-IN3` defines it precisely: *"authed loopback POST
receiver, **accept-any-event**. Never-seen `event_type` → 202 + a row lands
(audit-preserving)"* (`development-plan.md`). Concretely:

- **Loopback-only.** The receiver binds `127.0.0.1`, never `0.0.0.0`, under the same
  Fastify bootstrap (`WP-U0`) that makes loopback-or-fail real for every other endpoint
  ([security model](../security/model.md) rule 1).
- **Token-gated, not a separate credential.** Every POST is checked with the same
  `timingSafeEqual(DASHBOARD_TOKEN)` gate the read API and realtime stream use — there is
  no weaker, hook-specific auth path ([security model](../security/model.md) rule 2).
- **Accept-any-event.** An event type the receiver has never seen still gets a `202` and
  a stored row; it is not validated against a fixed allowlist and never crashes the
  pipeline ([hook ingestion](../architecture/hooks.md#accept-any-event-stored-not-crashed)).
- **Idempotent by construction.** `WP-IN1`'s envelope contract guarantees a hook payload
  and the JSONL line describing the *same fact* produce a **byte-identical**
  idempotency key, so re-registering a hook, a Claude Code retry, or the later JSONL
  tail-follower reading the same fact never double-counts it in `events_raw`.
- **No spawner, no SSRF.** The receiver only ever stores payloads — it never executes
  anything derived from a payload and never dials a URL taken from one
  ([security model](../security/model.md) rules 3 and 6).

## Leak-free token acquisition _(security-critical)_

This is explicitly part of `WP-X8`'s scope, not an afterthought — the work package is
defined as *"`hooks/` scripts + install docs + **leak-free token acquisition** +
end-to-end smoke"* (`development-plan.md` §2, merge note 4). It is also, as of this
writing, an **open, unresolved question**: `concept-analysis-v2.md` §7, item 8, asks
directly — *"is the loopback hook endpoint itself authenticated, and how does the hook
script obtain the token without leaking it into `~/.claude` scripts?"* —
[hook ingestion](../architecture/hooks.md#open-items-not-yet-built) names `WP-X8`/this page
as exactly where that gets settled. The *mechanism* is therefore not fixed yet; the
*shape* it must take is already constrained by invariants this project holds everywhere
else, and `implementation-plan.md`'s **D7** decision fixes that shape for the closest
analogous secret today (the Telegram bot token): *"via a `launchd`-injected env var (or a
`chmod 600` dotfile the service reads at boot); never stored in SQLite, never sent to the
browser."* `WP-X8`'s hook-token acquisition is designed to follow the same pattern for
`DASHBOARD_TOKEN` — held **by reference**, never embedded as a literal value anywhere
persisted, logged, or transcribed.

Concretely, what "leak-free" rules out, and why each one matters specifically for a hook
(a process Claude Code itself invokes, whose command line and output Claude Code's own
machinery can observe):

| Never | Why it matters here |
|---|---|
| A literal token baked into the `~/.claude` hook-command string | That settings file is plaintext on disk, and the command string is exactly what an installer would write in the (planned) registration shape above |
| A literal token passed as a CLI argument | `argv` is visible to any other process on the host via `ps`/`/proc` — a classic local-secret leak vector, independent of anything Claude Code does |
| A token printed to the hook script's stdout/stderr | Claude Code's own transcript (`~/.claude/projects/*.jsonl`) is the same ground-truth log this project treats as authoritative elsewhere ([DESIGN.md](../../ai/DESIGN.md) §3) — anything the hook prints risks ending up captured in it |
| A token committed inside the versioned `hooks/` scripts themselves | The scripts are installable artifacts meant to be copied into `~/.claude`; a secret baked into them travels with every copy |

Instead, the intended shape is that the shared dispatcher script reads the token at
runtime from a reference already present in its own process environment — the same
`launchd env / chmod-600` pattern fixed for the Telegram token by D7, and named directly
in the project's non-negotiable constraints as how every secret here is held ("never in
SQLite, never in SSE, never in logs"). Any sample this page or the eventual install docs
show uses a placeholder only, per the project's own convention:

```
DASHBOARD_TOKEN=<token>
```

Never a real value — consistent with [configuration](configuration.md) and
[security model](../security/model.md) rule 2. Until `WP-X8` actually ships this
mechanism, treat the *exact* env var name, file path, or permission bits the hook script
reads from as **unresolved**, not merely unconfirmed detail — this page states the intent
precisely so `WP-X8` implements exactly this and nothing weaker, not to imply the design
is finished.

## End-to-end verification

`WP-X8`'s Done-when is the same phrase this page opened with: *"Install → working
end-to-end hook → loopback ingest → `events_raw` on a real session"*
(`development-plan.md`). The Phase 2 exit gate restates the system-level version of the
same check: *"a hook event and a transcript line describing the same fact collapse to
exactly one `events_raw` row… an unrecognized event type is stored, never fatal"*
([roadmap](../guide/roadmap.md)). The designed verification sequence — every step below
marked _(planned)_ since no installer or receiver exists yet:

1. **Install.** Register the hooks in a real `~/.claude` settings file per the (planned)
   shape above, pointing at the shared dispatcher script under `hooks/`.
2. **Start the server with the invariant enforced.** Start the dashboard bound to
   `127.0.0.1` with `DASHBOARD_TOKEN` set — the server is designed to refuse to start at
   all if the token is unset ([security model](../security/model.md) rule 2). See
   [getting started](getting-started.md) and [configuration](configuration.md) once those
   land.
3. **Run a real Claude Code session.** Exercise at least one of the twelve events — a
   prompt that invokes a tool fires `PreToolUse`/`PostToolUse`; a subagent-heavy session
   also exercises `SubagentStart`/`SubagentStop`, the pair the hierarchy tables depend on.
   This mirrors the same kind of session Phase 0's own spike captures for its tree
   validation ([roadmap](../guide/roadmap.md), Phase 0).
4. **Confirm a row landed.** Check `events_raw` for a row with `source = 'hook'`, an
   `event_type` matching what fired, and a well-formed `idempotency_key`
   ([data model](../architecture/data-model.md) — the reference DDL (not yet built;
   only `agents` is fixed verbatim by the design basis): `id`,
   `idempotency_key` `UNIQUE`, `source IN ('hook','jsonl')`, `event_type`, `seq`,
   `payload`, `received_at`). The exact query surface (an admin CLI, a debug endpoint, or
   a raw `sqlite3` check) is not designed yet — mark as _(planned)_.
5. **Confirm idempotency once the JSONL path also exists.** Once the transcript
   tail-follower ships alongside the hook receiver (both are Phase 2), the same fact
   arriving via both paths must still collapse to **one** `events_raw` row, not two — the
   `WP-IN1` contract this whole ingest boundary rests on
   ([ingest & reconciliation](../architecture/ingest-reconciliation.md)).

## What this is not

- **Not a `/api/run`-shaped spawner.** The receiver stores hook payloads; it never
  invokes `claude` or any other subprocess derived from request input. There is no
  command-execution surface anywhere in this design, now or planned
  ([security model](../security/model.md) rule 3).
- **Not reachable beyond loopback.** The receiver binds `127.0.0.1` only, never
  `0.0.0.0` — not even behind a flag, and not even because the hook script happens to run
  on the same machine as a locally-installed Claude Code. Remote operators reach it only
  through an SSH port-forward or Tailscale tunnel terminating at loopback, never a reverse
  proxy to an open port ([security model](../security/model.md) rules 1 and 7).
- **Not a general ingest sink.** Accept-any-event means unrecognized payloads are stored
  for later interpretation, not executed, and the receiver never dials a URL taken from a
  payload — no SSRF surface ([security model](../security/model.md) rule 6).

## See also

- [Hook ingestion](../architecture/hooks.md) — the full twelve-event catalogue, the
  `SubagentStart` hedge, and accept-any-event in depth.
- [Ingest & reconciliation](../architecture/ingest-reconciliation.md) — the `WP-IN1`
  idempotency contract and JSONL-vs-hook precedence this installer's output feeds into.
- [Data model](../architecture/data-model.md) — the `events_raw` DDL used for
  verification in step 4 above.
- [Security model](../security/model.md) — the loopback, token, and no-spawner
  invariants the receiver and this installer must never weaken.
- [Configuration](configuration.md) — `DASHBOARD_TOKEN` and the other environment
  variables the installed hooks and the server share.
- [Getting started](getting-started.md) — installing and starting the dashboard itself,
  a prerequisite for step 2 above.
- [Roadmap](../guide/roadmap.md) — Phase 0's hard GO/NO-GO gate and Phase 2's exit
  criteria that this installer must satisfy.
