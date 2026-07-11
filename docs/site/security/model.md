# Security model

This page enumerates every security control agenthropic commits to, as a **rule → why
→ how enforced** table for each one: bind loopback-only (never `0.0.0.0`), gate every
endpoint behind a mandatory `timingSafeEqual` token (never a no-op-when-unset one),
build **no** browser-driven subprocess/`claude` spawner ever, enforce same-origin on
the realtime channel, allow no unauthenticated write endpoint, dial no URL out of an
event payload (no SSRF), reach the dashboard only through an SSH or Tailscale tunnel,
keep `ANTHROPIC_API_KEY` out of the dashboard's own environment, and run SQLite in WAL
mode with a backup routine that is actually exercised, not assumed. **Key takeaway:**
none of this is aspirational hardening bolted on later — it is the corrective response
to a source-level audit that found every real-world rival binds `0.0.0.0` and/or ships
auth that is a no-op in practice, one of them with a live remote-code-execution
spawner, and the design basis (`ai/DESIGN.md` §8, digesting that audit) calls this
"non-negotiable." The build plan backs every rule with a CI gate that is meant to turn
the build **red** on violation, not a review-time reminder — see
[CI gates enforcing this](#ci-gates-enforcing-this) below. As of this writing
(pre-Phase-0, see the [roadmap](../guide/roadmap.md)) these gates are **designed, not
yet implemented** — this page states the target contract precisely so Phase 1
implements exactly this and nothing weaker.

## Why a flagship page: the field failed at exactly this

The independent due-diligence audit behind the design basis checked six real,
already-running dashboards against the same bar agenthropic sets for itself, and found
every one of them short on at least one axis:

| Project | Bind | Auth | Worst finding |
|---|---|---|---|
| `hoangsonww` | configurable | `DASHBOARD_TOKEN` — **no-op when unset** | **RCE**: `/api/run` spawns `claude --permission-mode bypassPermissions` from browser-supplied input |
| `simple10` | **`0.0.0.0`** | **none** | LAN-exposed dashboard, wildcard CORS, stores full tool payloads |
| `cast` | **`0.0.0.0`** | write-gate good, **GET reads unauth** | Unauth GETs dump every table despite a solid write-gate pattern |
| `disler` | — | **none** | **SSRF**: dials an arbitrary `responseWebSocketUrl` taken from the request body |
| `nirdiamant` | — | **none** | **Command injection** via `execSync` in the snapshot name, plus an `ANTHROPIC_API_KEY`-gated feature that ships local files to Anthropic |
| `claude-code-templates` | **`0.0.0.0`** | **none** | LAN-exposed analytics, no auth at all |

Source: `ai/DESIGN.md` §8 ("Every audited option binds `0.0.0.0` and/or ships no-op
auth in practice"); the full posture matrix with file/line citations is
`../../due-diligence/security.md`. This table is condensed context for *why* each rule
below exists — the systematic anti-pattern catalogue and how agenthropic structurally
avoids each one is the dedicated subject of [the threat model](threat-model.md).

## The trust boundary, in one picture

```
                         Mac Mini M4 — bind 127.0.0.1 only, never 0.0.0.0
        ┌───────────────────────────────────────────────────────────────────┐
        │                                                                    │
remote  │   SSH port-forward / Tailscale tunnel                              │
client ─┼──────────────┐          (never a reverse proxy to the open port)   │
        │              ▼                                                    │
        │   ┌────────────────────────────────────────────────────────┐      │
        │   │ timingSafeEqual(DASHBOARD_TOKEN) — every endpoint       │      │
        │   │ mandatory: fails startup if unset, not a no-op          │      │
        │   └───────────────────────┬────────────────────────────────┘      │
        │                           ▼                                       │
        │            Fastify server (apps/server)                           │
        │   ┌─────────────┬──────────────────┬───────────────────────┐      │
        │   │ read API    │ hook-ingest       │ /api/stream (SSE)     │      │
        │   │ auth-gated  │ receiver          │ auth + same-origin    │      │
        │   │             │ auth-gated        │ (no wildcard CORS)    │      │
        │   └─────────────┴──────────────────┴───────────────────────┘      │
        │                           │                                       │
        │                           ▼                                       │
        │            SQLite (WAL mode) ── backup ── tested restore          │
        │                           │                                       │
        │                           ▼                                       │
        │            webhook sink → operator-configured targets only        │
        │            (never a URL read from an event payload)               │
        │                           │                                       │
        │                           ▼                                       │
        │            Telegram relay (@baev_bot_bot), secret via token_ref   │
        │            (launchd env / chmod-600 — never in SQLite, never      │
        │             sent to the browser)                                  │
        └───────────────────────────────────────────────────────────────────┘

NEVER, anywhere inside this box: a 0.0.0.0 bind · a /api/run-shaped
`claude`/subprocess spawner driven by request input · a dial-out to a
payload-supplied URL.
```

Everything inside the box is untrusted-by-default until it crosses the token gate;
nothing inside the box is reachable from outside the box except through the tunnel.
This is the same ingest-loop diagram as [the architecture overview](../architecture/overview.md)
with the trust boundary drawn explicitly around it.

## The control catalogue

Nine rules, each stated as **rule → why → how enforced**. Sources: `ai/DESIGN.md` §8
(the non-negotiable list itself) and `docs/analysis/development-plan.md` (the work
packages and Definition-of-Done that turn each rule into CI-blocking code).

### 1. Bind loopback only (`127.0.0.1`), never `0.0.0.0`

- **Rule.** Every listener the server opens — the read API, the hook-ingest receiver,
  the realtime stream — binds `127.0.0.1` exclusively. `0.0.0.0` is never an option,
  not even behind a flag.
- **Why.** Three of the six audited rivals bind `0.0.0.0` by default
  (`simple10`, `cast`, `claude-code-templates`) and are LAN- or network-reachable the
  moment the process starts, regardless of what their auth layer does or doesn't do.
  `ai/DESIGN.md` §8 calls out `0.0.0.0` as the first thing every audited project got
  wrong and states the corrective directly: "Bind loopback only — `127.0.0.1`. Never
  widen to `0.0.0.0`."
- **How enforced.** The Fastify server bootstrap (`WP-U0`, owner `backend`) implements
  a **loopback-or-fail** listen call — the process refuses to start bound to anything
  else. `WP-F7`'s security-contract tests assert this and are written to fail red
  until `WP-U0` wires the real bootstrap; the Phase 1 exit gate in
  `docs/analysis/development-plan.md` requires these contract tests **green**. The
  canonical decision recording "loopback-or-fail bind" as a CI-blocking condition from
  commit one is CD-7 in `docs/analysis/concept-analysis-v2.md`.

### 2. Auth token is mandatory — `timingSafeEqual`, not a no-op-when-unset

- **Rule.** Every endpoint (read and write, see rule 5) sits behind a
  `DASHBOARD_TOKEN` compared with Node's `crypto.timingSafeEqual`. If the token
  environment variable is unset, **the server refuses to start** — it does not fall
  back to "no auth needed."
- **Why.** `hoangsonww`'s `DASHBOARD_TOKEN` is opt-in and becomes a silent no-op when
  unset — on `0.0.0.0` without ever setting it, that dashboard has no auth at all
  despite shipping an auth *feature*. `ai/DESIGN.md` §8 names this precisely:
  "Auth token is mandatory, not opt-in — a `DASHBOARD_TOKEN` that is a no-op when
  unset (hoangsonww's mistake) is not auth. Use `timingSafeEqual`." A naive `===`
  string compare is also explicitly ruled out — it leaks timing information about how
  many leading bytes matched, which is why the rule names the constant-time primitive,
  not just "check a token."
- **How enforced.** `WP-F7` builds the `shared/security` primitives — loopback check,
  token compare, SSE-origin check — as unit-tested (>90% coverage) building blocks and
  as **initially-failing** contract tests; `WP-U0`'s Fastify bootstrap wires the
  timing-safe middleware in and is done-when those contract tests turn green,
  including "fails startup when token unset." `WP-U2` (Read API foundation) then
  requires *every* read route to carry the auth guard, not only the ones an author
  remembers to gate.

  ```ts
  // apps/server/src/security/token-guard.ts — illustrative shape, not yet built (WP-F7/WP-U0)
  import { timingSafeEqual } from 'node:crypto';

  export function verifyToken(provided: string | undefined, expected: string): boolean {
    if (!provided) return false;
    const a = Buffer.from(provided);
    const b = Buffer.from(expected);
    // guard the length mismatch *before* timingSafeEqual — it throws on unequal
    // buffer lengths rather than returning false, and constructing a throw path
    // from attacker-controlled input is itself worth avoiding.
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
  }
  ```

  ```ts
  // apps/server/src/bootstrap.ts — illustrative shape, not yet built (WP-U0)
  const token = process.env.DASHBOARD_TOKEN;
  if (!token) {
    throw new Error('DASHBOARD_TOKEN is required — refusing to start without auth.');
  }
  await app.listen({ host: '127.0.0.1', port }); // loopback-or-fail — never '0.0.0.0'
  ```

  Sample env file for local operation always uses a placeholder, never a real value:

  ```
  DASHBOARD_TOKEN=<token>
  ```

  The pattern this generalizes — read-only-by-default, non-safe verbs gated,
  constant-time compare, mounted before the router — is `cast`'s ~73-line
  `controlGate.ts`, named as the auth-gate shape worth stealing in `ai/DESIGN.md` §7
  and `docs/analysis/development-plan.md`'s track notes. It is **clean-room
  reimplemented**, not copied: `cast` carries no OSS license (`package.json` sets
  `private: true`, no `LICENSE` file), so it is all-rights-reserved by Berne default
  per CD-9 — see [licensing & provenance](../contributing/licensing.md). Note also
  that stealing the *pattern* is not enough on its own: `cast` itself still binds
  `0.0.0.0` and leaves GET reads unauthenticated despite that same gate existing —
  rule 1 and rule 5 close exactly the gap that example leaves open.

### 3. Never a browser-driven subprocess / `claude` spawner

- **Rule.** agenthropic never builds an endpoint that spawns `claude` (or any other
  subprocess) driven by request input. There is no `/api/run`-shaped route anywhere in
  the design, now or on the roadmap.
- **Why — the precise mechanism, not just "a rival had an RCE."**
  `hoangsonww`'s `/api/run` accepts a `permission-mode` field from the **browser
  request body**, and its server-side allow-list (`ALLOWED_PERMISSION_MODES`)
  includes `bypassPermissions`. `bypassPermissions` is a Claude Code permission mode
  that skips the tool-use confirmation prompts a normal session would show — so a
  request that reaches this endpoint runs `claude --permission-mode bypassPermissions`
  in an attacker-chosen working directory, and every tool Claude Code can invoke
  (shell execution among them) then executes **unconfirmed, as the host user**. This
  is not a theoretical weakness in "how much request data an endpoint trusts" — it is
  a direct, one-hop path from an HTTP body field to host-level code execution.
  `ai/DESIGN.md` §8 states the conclusion plainly: "`/api/run` accepts
  `permission-mode` from the request body and its allow-list includes
  `bypassPermissions` → arbitrary host-user code exec. We never build this surface."
  The due-diligence report also notes the concurrency-cap mitigation `hoangsonww`'s
  own vendor review credited was a red herring — the permission mode is the actual
  lever, not request volume (`../../due-diligence/projects/hoangsonww.md`).

  ```js
  // ANTI-PATTERN — illustrative reconstruction of the documented flaw in
  // hoangsonww's server/routes/run.js (per due-diligence, run.js:96 /
  // security.js:133), not a copy of the source. agenthropic never builds this.
  app.post('/api/run', (req, res) => {
    const { cwd, permissionMode } = req.body;               // attacker-controlled
    // ALLOWED_PERMISSION_MODES includes 'bypassPermissions'
    spawn('claude', ['--permission-mode', permissionMode], { cwd }); // RCE
  });
  ```

- **How enforced.** `WP-F5` (owner `security`, Phase 1) is a **static grep/AST gate**:
  planting a `child_process` import anywhere in `apps/server` makes CI red. This is a
  build-failing check, not a code-review convention — CD-7 in
  `docs/analysis/concept-analysis-v2.md` names the "no-spawner grep/static gate" as
  one of the boundary conditions live from commit one, and the global
  Definition-of-Done in `docs/analysis/development-plan.md` §8 restates it for every
  single work package: "No security invariant is weakened: … no subprocess spawner."
  Because the spawner in `hoangsonww` is architecturally isolated (~6 files, one mount
  line, one table per the due-diligence), the corrective for anyone ever tempted to
  graft `hoangsonww` patterns is equally simple: that surface is never mounted here in
  the first place.

### 4. Same-origin check on the realtime channel

- **Rule.** The server→browser realtime feed rejects any request whose `Origin` header
  is not the dashboard's own origin, and it never sends a wildcard CORS header.
- **Why.** `ai/DESIGN.md` §8 states this as its own line item ("Same-origin check on
  the WebSocket") because a same-origin-only realtime channel is what keeps an
  arbitrary web page — one you merely have open in another tab — from silently
  attaching to your dashboard's live feed if it ever guessed or leaked the token.
  `disler`'s unauth `POST /events` plus wildcard `*` CORS is the negative example: no
  origin check at all (`../../due-diligence/security.md`).
- **How enforced.** The transport itself is a canonical, already-resolved decision:
  CD-5 in `docs/analysis/concept-analysis-v2.md` settles it as **SSE**, not
  WebSocket — "server→browser-only feed; revisit WebSocket only if bidirectional
  control is ever needed (it is not)." `ai/DESIGN.md` §8's original wording predates
  that resolution and still says "WebSocket"; this page follows the later, canonical
  decision. `WP-U1` (`RealtimeHub SSE endpoint`) is done-when "a cross-origin `Origin`
  on `/api/stream` is rejected; no wildcard CORS," and the same-origin **helper** used
  to implement that check is one of the three `shared/security` primitives `WP-F7`
  builds and unit-tests before `WP-U0` wires it into the bootstrap.

### 5. No unauthenticated endpoints — read or write

- **Rule.** Every endpoint, not only the ones that mutate state, sits behind the
  same-origin + token gate. There is no "reads are safe to leave open" carve-out.
- **Why.** `ai/DESIGN.md` §8's literal wording is "no unauthenticated write
  endpoints" — echoing the minimum bar the field itself failed: `cast`'s
  `controlGate.ts` gates writes well (404s non-safe verbs unless
  `CAST_DASHBOARD_CONTROL=1` **and** the token are set) but its GET routes are left
  open, and combined with its `0.0.0.0` bind, "unauthenticated GET reads that dump
  every table" is the exact finding the due-diligence records
  (`../../due-diligence/security.md`; `../../due-diligence/projects/cast.md`).
  agenthropic closes that gap rather than reproduce it.
- **How enforced.** `WP-U2` (Read API foundation) states its Done-when as "every read
  route auth-guarded (timing-safe)" — stricter than the DESIGN wording's write-only
  framing, precisely because `cast`'s read-side gap is documented and known. `WP-A8`
  (operator alerts API) carries the same requirement forward for the CRUD surface:
  "all write endpoints token-guarded, cross-origin rejected."

### 6. No SSRF — never dial a URL taken from an event payload

- **Rule.** The webhook/alert dispatcher only ever calls **operator-configured**
  targets (`webhook_targets`, set up through the authenticated operator UI/API). It
  never constructs an outbound request URL from data that arrived inside an ingested
  event.
- **Why.** `disler`'s server dials an arbitrary `responseWebSocketUrl` taken straight
  from the incoming request body — a textbook server-side request forgery, letting
  whatever sent the event make the server connect anywhere the attacker chooses
  (`ai/DESIGN.md` §8: "no SSRF (never dial a URL taken from an event payload —
  disler's bug)"; `../../due-diligence/security.md`, `index.ts:198-201`).
- **How enforced.** `WP-F5` covers this alongside the no-spawner check as a
  build-failing static gate (CD-7). At the feature level, `WP-A4` (webhook dispatcher)
  states its Done-when as "no code path reads a URL from a payload (test-proven)" —
  a dedicated negative test, not only a lint rule, and Phase 5's exit gate in
  `docs/analysis/development-plan.md` restates it: "SSRF test proves no payload-URL
  dial-out." `WP-A10`'s alerts negative-test corpus keeps this proven on every future
  change to the alerting surface, not just at first ship.

### 7. Remote access via tunnel only

- **Rule.** The only way to reach the dashboard from off the Mac Mini is an SSH
  port-forward or a Tailscale tunnel terminating at the loopback address. There is no
  reverse proxy to the open port and no public exposure, ever.
- **Why.** Loopback-only binding (rule 1) is only a real guarantee if nothing else on
  the network path widens it back open. `ai/DESIGN.md` §8: "Remote access via tunnel
  only (SSH port-forward / Tailscale) — never a reverse proxy to the open port." The
  root `CLAUDE.md` non-negotiable constraints restate the same rule for anyone
  touching this codebase.
- **How enforced.** This is an operational rule rather than a unit-testable one — it
  is enforced by never building a reverse-proxy configuration, a `0.0.0.0` bind (rule
  1 catches this), or any TLS/ingress feature that would imply public exposure. The
  operator-facing procedure for setting this up (SSH vs Tailscale, port choices) is
  the dedicated subject of [remote access](remote-access.md).

### 8. `ANTHROPIC_API_KEY` stays out of the dashboard's own environment

- **Rule.** The dashboard's runtime process does not hold `ANTHROPIC_API_KEY` unless a
  specific, explicitly-scoped feature genuinely requires it — and today, none does.
- **Why.** `ai/DESIGN.md` §8: "Don't hold `ANTHROPIC_API_KEY` in the dashboard's env
  unless a feature truly requires it." The concrete cautionary example is `nirdiamant`:
  its only "AI" feature requires `ANTHROPIC_API_KEY` and ships local files to Anthropic
  to classify them (`../../due-diligence/projects/nirdiamant.md`) — exactly the shape of
  feature this rule keeps opt-in and isolated rather than baked into the core process's
  environment. The one place on the roadmap this key would ever have mattered — the
  experimental vector-DB "observability becomes memory" feed (`ai/DESIGN.md` §9, Phase
  3) — was **deleted from the plan outright** (`WP-X11` removed per best-path §6.3,
  applied 2026-07-06), so the *core* dashboard process never needs the key at all.
  `docs/analysis/concept-analysis-v2.md`'s CD-10 states this more strongly:
  the key "stays out of the dashboard env entirely."
- **How enforced.** By construction since 2026-07-06: with `WP-X11` deleted there is no
  experimental stub for a core package to import and no code path that reads the key.
  The rule stands as a standing constraint on any future experimental work — if such a
  track ever returns, it must re-satisfy "no core package imports it" as an assertable,
  tested condition with its coverage explicitly scoped.

### 9. SQLite in WAL mode, with a backup routine that is actually exercised

- **Rule.** The single persisted store runs in WAL journaling mode, and a backup
  routine exists whose **restore path has actually been run**, not merely assumed to
  work because a file gets written somewhere.
- **Why.** `ai/DESIGN.md` §8: "SQLite in WAL mode with backups." A backup nobody has
  ever restored from is not a real backup — this is why the plan phrases the gate as
  "tested restore," not "backup exists."
- **How enforced.** `WP-D2` (SQLite driver adapter) asserts `journal_mode == wal` and
  `foreign_keys == ON` on every connection open. `WP-F8` (Backup + tested-restore)
  states WAL as asserted and a restore as *exercised* — this is the Phase 1 exit gate
  in `docs/analysis/development-plan.md` ("WAL mode is on and a restore has been
  exercised for real") and it recurs at release: `WP-X9`'s `RELEASE.md` enumerates
  "an exercised backup restore" as one of the checklist items closing out the release.
  Retention and payload redaction (never storing raw tool payloads unredacted, unlike
  `simple10`) are the adjacent hardening step, owned by `WP-D10` and covered in depth
  in [backup & restore](../operations/backup-restore.md).

## CI gates enforcing this

None of the nine rules above rely on a reviewer remembering to check for them. Each
has a named work package, in `docs/analysis/development-plan.md`, whose Done-when is a
CI-observable condition:

| Rule | Work package(s) | Gate mechanism | Phase |
|---|---|---|---|
| 1. Loopback-only bind | `WP-U0`, `WP-F7` | Contract test: loopback-or-fail; red until `WP-U0` wires it | 1 |
| 2. Mandatory `timingSafeEqual` token | `WP-F7`, `WP-U0`, `WP-U2` | Contract test: fails startup when token unset; every route auth-guarded | 1/4 |
| 3. No subprocess spawner | `WP-F5` | Static grep/AST gate: any `child_process` import in `apps/server` → CI red | 1 |
| 4. Same-origin realtime channel | `WP-F7`, `WP-U0`, `WP-U1` | Contract test + `shared/security` origin helper; cross-origin `Origin` on `/api/stream` rejected | 1/4 |
| 5. No unauthenticated endpoints | `WP-U2` | Every read/write route wrapped by the auth guard; asserted per-route (`WP-A8` was cut per best-path §6.2) | 1/4 |
| 6. No SSRF | `WP-F5`, `WP-A4`, `WP-A10` | Static gate + dedicated negative test proving no payload-URL dial-out | 1/5/6 |
| 7. Tunnel-only remote access | *(operational — no code gate)* | Never build a reverse proxy / public-bind path; rule 1's gate is the backstop | — |
| 8. `ANTHROPIC_API_KEY` isolation | *(none needed — `WP-X11` deleted per best-path §6.3)* | No experimental stub exists; the key never enters the dashboard env (CD-10) | — |
| 9. WAL + tested restore | `WP-D2`, `WP-F8`, `WP-X9` | Pragma assertion on connect; restore actually exercised; release-checklist line item | 1/6 |
| License/provenance for any borrowed pattern | `WP-F6` | Non-allowlisted dependency license → CI red | 1 |
| Coverage floor for all of the above | `WP-F3`, `WP-X5` | Merge-blocking **>90%** coverage gate, live from Phase 1 | 1 |

The canonical decision tying all of this together is **CD-7** in
`docs/analysis/concept-analysis-v2.md`: "Security + the coverage gate are boundary
conditions from commit one, CI-blocking… >90% coverage blocks merges," explicitly
rejecting any plan that would defer security to a later phase or treat backup/restore
as end-of-project polish. The global Definition-of-Done that closes
`docs/analysis/development-plan.md` restates the same list as a condition every one of
the 75 work packages must satisfy, not just the security-owned ones: "No security
invariant is weakened: loopback-only bind; mandatory-token-or-fail-startup; SSE
same-origin; no subprocess spawner; no SSRF; secrets never in SQLite/SSE/logs."

One sequencing detail worth stating plainly because it looks alarming out of context:
`WP-F7`'s security-contract tests are *written to fail* from the wave they land in
(wave 8) until `WP-U0`'s server bootstrap wires the real primitives in (wave 9). That
is by design — `docs/analysis/development-plan.md` §7 flags explicitly "do not merge
`WP-F7` as 'passing'; its DoD is jointly owned with `WP-U0`." A red security test at
that specific, short-lived point in the build is the gate working as intended, not a
regression.

## Current state

As of this writing, agenthropic is **pre-Phase-0** (see the [roadmap](../guide/roadmap.md)):
the design and build plan above are finished, but no application code is scaffolded
yet, and CD-8's hard stop means none of it can start until the Phase-0 feasibility
spike returns a GO or CONDITIONAL-GO verdict. Every control on this page is therefore
a **binding design commitment**, verifiable against `docs/analysis/development-plan.md`
today, and something to hold Phase 1's actual pull requests to — not a description of
code that already runs.

## See also

- [Architecture overview](../architecture/overview.md) — the ingest loop this
  boundary wraps around, and the ports (`RealtimeHub`, `HookSource`) the security
  primitives attach to.
- [Threat model](threat-model.md) — the full rival-by-rival anti-pattern catalogue
  this page only summarizes.
- [Remote access](remote-access.md) — the SSH/Tailscale tunnel setup procedure for
  rule 7.
- [Backup & restore](../operations/backup-restore.md) — WAL, backup, tested restore,
  and retention/redaction in depth (rule 9).
- [Licensing & provenance](../contributing/licensing.md) — the clean-room-vs-attribution
  rule (CD-9) behind the `cast` pattern note in rule 2.
- [Testing & quality](../contributing/testing.md) — the merge-blocking coverage gate
  and the negative-test catalogue that backs rules 3, 5, and 6.
- [Roadmap](../guide/roadmap.md) — where Phase 0's hard stop and Phase 1's security
  spine sit in the overall build sequence.
