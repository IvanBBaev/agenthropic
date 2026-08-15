# Remote access

This page covers the only two ways `agenthropic` is ever reached from a machine other
than the one it runs on — an SSH local port-forward, or a Tailscale tunnel — with
step-by-step setup for each, and why every other route (widening the bind address,
or fronting the dashboard with a reverse proxy) is out of bounds. **The key takeaway:
the dashboard's own listening socket never changes.** It binds `127.0.0.1` and nothing
else, in every deployment, on every machine, whether you are sitting at the Mac Mini's
own keyboard or connecting from a laptop on the other side of the world. A tunnel is a
private pipe that carries bytes from a remote client into that one loopback socket; it
never asks the application to listen anywhere else, and it never weakens the mandatory
auth check that gates every request arriving on that socket (`DESIGN.md` §8).

> **Status (updated 2026-07, as built).** This page was written pre-Phase-0; the
> server it describes now exists. Implementation began 2026-07-11: the server binds
> `127.0.0.1` with **no configuration path to any other host** (the bind host is a
> constant in `apps/server/src/config.ts`, deliberately not an environment variable),
> refuses to start without `DASHBOARD_TOKEN` — or with one shorter than 16
> characters, see [below](#the-token-requirement-does-not-relax-over-a-tunnel) — and
> listens on port **4317** by default
> (`DASHBOARD_PORT` overrides it). Substitute `4317` for `<port>` in every command
> below and the procedures apply as written. The token travels as an
> `Authorization: Bearer <token>` header — with one accommodation: the SSE stream
> (`/api/stream`) also accepts `?token=`, because the browser `EventSource` API
> cannot set headers (the server redacts that query value from its own logs).

## Why the bind never moves

`DESIGN.md` §8 states the rule with no carve-out: *"Bind loopback only — `127.0.0.1`.
Never widen to `0.0.0.0`."* This is not a default that gets relaxed once you need
remote access — it is unconditional, and remote access is solved a different way (the
tunnels below), never by opening the socket itself. The reason the rule holds even for
a single-operator dashboard on a home network is the audit finding that motivated it in
the first place — every comparable, already-shipping project got this wrong:

| Project | Bind | Auth | What that combination let happen |
|---|---|---|---|
| `simple10` | `0.0.0.0` | none | Any device on the LAN reaches the dashboard directly, no credential needed |
| `cast` | `0.0.0.0` | write-gate good, GET reads unauthenticated | Any LAN device can passively read every table with a plain `GET` |
| `hoangsonww` | configurable | `DASHBOARD_TOKEN` is a no-op when unset | Combined with its `/api/run` spawner (`bypassPermissions` in the allow-list), a network-reachable remote-code-execution box |

(`DESIGN.md` §8: *"Every audited option binds `0.0.0.0` and/or ships no-op auth in
practice... We do not repeat any of it."*)

The reason this is a bind-level rule and not just an auth-level one: the bind address
is enforced by the kernel's socket layer before a single line of application code runs.
An auth check can be skipped by a bug, a missing environment variable, a future
contributor forgetting to wrap a new route, or — as `hoangsonww` shows — a token that
silently becomes a no-op when unset. A socket that was told to listen only on
`127.0.0.1` has no such failure mode: there is no packet from any other interface for
the kernel to hand to the process in the first place. Binding loopback-only removes an
entire attacker model — the **LAN peer**, anyone sharing your network segment without
holding any credential — structurally, rather than relying on the application to
recognize and reject them.

## Why never a reverse proxy either

`DESIGN.md` §8's remote-access clause has two halves, and the second is stated just as
firmly as the first: *"Remote access via tunnel only (SSH port-forward / Tailscale) —
never a reverse proxy to the open port."* A reverse proxy (nginx, Caddy, Traefik, a
cloud tunnel service with a public endpoint — anything that terminates connections on
an interface other than the dashboard's own loopback socket) reintroduces exactly the
exposure the bind rule exists to prevent, one hop removed:

- **It has to listen somewhere routable for a remote client to reach it.** Whether that
  address is your own LAN, a port forwarded on your router, or a public VPS, it is a
  network-reachable listener carrying dashboard traffic that is not the loopback
  socket — the precise shape the bind rule forbids, just relocated to a second process.
- **It adds a second place for auth to be gotten wrong.** The dashboard's own
  `timingSafeEqual` token check (`DESIGN.md` §8) is designed to gate the loopback
  socket directly. A proxy in front of it introduces its own access rules, its own TLS
  termination, and header-trust boundaries (`X-Forwarded-For`, `X-Forwarded-Host`) that
  are easy to spoof and that the same-origin check on the realtime channel
  (`DESIGN.md` §8) is not designed to be evaluated behind.
- **It adds a second thing to patch and audit**, for no offsetting benefit — the two
  tunnel mechanisms below already solve "reach it from another machine" without ever
  moving the application's bind address.

So: no nginx/Caddy/Traefik config, and no tunnel product whose default mode publishes a
public endpoint, ever sits in front of this dashboard. The only two approved carriers
are the ones `DESIGN.md` §8 names by name — an SSH local port-forward, or a Tailscale
tunnel — and both leave the dashboard listening on `127.0.0.1` and nowhere else.

## The tunnel model, in one picture

```
 Remote client (laptop/phone)                    Mac Mini M4
 ────────────────────────────                    ─────────────────────────────
 browser → http://127.0.0.1:<port>                dashboard process
   │       (SSH) or https://<tailscale-host>        listens 127.0.0.1:<port> ONLY
   │       (Tailscale)                                        ▲   never 0.0.0.0
   ▼                                                           │
 ssh client ── encrypted SSH channel ──────────► sshd ─────────┘
   (or)                                           (or)
 tailscaled ── WireGuard tunnel (private tailnet)► tailscaled ── `tailscale serve` ──┘
                                                    forwards tailnet:<port> → 127.0.0.1:<port>
```

In both cases the dashboard process itself never binds anything but `127.0.0.1:<port>`
(`<port>` was an open stack decision when this page was written; as built the default
is **4317**, overridable via `DASHBOARD_PORT`). What differs between the two options is which
already-trusted system service — `sshd` or `tailscaled` — is allowed to hand bytes to
that socket on the app's behalf, and over what authenticated channel. Neither option
asks the dashboard to change how or where it listens.

## SSH local port-forward

Prerequisite: SSH access to the Mac Mini (key-based, not password) — this is an
existing OS-level control you already manage independently of the dashboard's own
token.

1. On the Mac Mini, confirm the dashboard is listening on loopback only, e.g.
   `lsof -iTCP -sTCP:LISTEN -n -P | grep <port>` should show `127.0.0.1:<port>`, never
   `*:<port>`.
2. From the remote client, open a local port-forward:

   ```bash
   ssh -N -L <port>:127.0.0.1:<port> <user>@<host>
   ```

   - `-L <port>:127.0.0.1:<port>` binds `<port>` on the client's own loopback
     interface and tunnels it, through the encrypted SSH connection, to
     `127.0.0.1:<port>` as seen from the Mac Mini's side — the dashboard's real,
     unmoved socket.
   - `-N` opens the forward without starting a remote shell.
   - `<user>@<host>` is a placeholder for the Mac Mini's SSH account and its reachable
     address (a LAN hostname, a dynamic-DNS name, or its Tailscale hostname — SSH
     riding over a Tailscale tunnel is a legitimate combination of both options below).
3. Leave the command running, or background/persist it (`ssh -f -N -L ...`, or a
   `~/.ssh/config` alias):

   ```
   Host agenthropic-tunnel
       HostName <host>
       User <user>
       LocalForward <port> 127.0.0.1:<port>
       ServerAliveInterval 60
   ```

   then `ssh -N agenthropic-tunnel`.
4. On the remote client, browse to `http://127.0.0.1:<port>` exactly as you would at
   the Mac Mini itself, and supply the dashboard token as configured
   (`DASHBOARD_TOKEN=<token>`) — the tunnel changes nothing about that step; see
   [the token requirement does not relax](#the-token-requirement-does-not-relax-over-a-tunnel)
   below.
5. Kill the `ssh` process (or `Ctrl-C` the foreground session) when done. Nothing is
   left listening on the client once it exits.

## Tailscale tunnel

Prerequisite: both the Mac Mini and the remote client joined to the same private
tailnet (`tailscale up` on each, once).

Joining the tailnet is not, by itself, enough: Tailscale gives the Mac Mini a separate
virtual address (its tailnet IP / MagicDNS name), which is a different interface than
`127.0.0.1`. A dashboard bound loopback-only is unreachable at that address until you
explicitly bridge the two — the command for that, run on the Mac Mini, is
`tailscale serve` (exact flag syntax varies by installed Tailscale client version;
check `tailscale serve --help` on your machine):

```bash
tailscale serve --bg <port>
```

- This tells the already-running Tailscale daemon to accept connections arriving over
  the tailnet's encrypted WireGuard mesh and forward them to `127.0.0.1:<port>` — the
  dashboard's real, unmoved socket. The dashboard itself never learns it is being
  reached this way.
- The forwarded listener is reachable only from devices approved onto your tailnet (or
  further restricted with Tailscale ACLs) — never from the public internet, and never
  from other clients on your home LAN who are not on the tailnet.
- **Never run `tailscale funnel` for this.** Funnel is Tailscale's explicit
  *public-internet* exposure feature — the opposite of a private tunnel, and exactly
  the "public exposure" this design rules out (`DESIGN.md` §8's tunnel-only clause;
  the root `CLAUDE.md` non-negotiable constraints restate the same rule for anyone
  touching this codebase). `tailscale serve` (tailnet-only) is the one to use;
  `tailscale funnel` is not.

From the remote client, browse to the Mac Mini's MagicDNS hostname on the tailnet
(placeholder: `<tailscale-host>`), and supply the dashboard token as usual. When remote
access is no longer needed, turn the forward off (`tailscale serve --bg off`, or the
equivalent reset for whatever mode you started) — the dashboard keeps running,
loopback-bound, unaffected either way.

## The token requirement does not relax over a tunnel

Whichever carrier you use, the tunnel is transport only. It does not touch, weaken, or
bypass the mandatory token check (`DESIGN.md` §8: *"Auth token is mandatory, not
opt-in... Use `timingSafeEqual`."*). Every request that reaches the dashboard — whether
it originated at the Mac Mini's own keyboard or arrived over an SSH forward or a
Tailscale tunnel — is the same HTTP request to the same loopback socket, checked the
same way. There is no "trusted because it came through the tunnel" bypass, and there
must never be one.

Framed against the attacker models the field's own failures established: an SSH
port-forward or Tailscale peer reaching `127.0.0.1:<port>` on the Mac Mini is, from the
dashboard's point of view, indistinguishable from the **local multi-user** case — a
second account reaching the loopback socket directly. Bind-only defenses do not stop
that case at all; only the mandatory, constant-time-compared token does. `hoangsonww`
is the cautionary precedent for what happens when that backstop is missing: its token
becomes a no-op the moment it is unset, and that single gap is what turns its
(also mis-bound) listener into a reachable RCE once combined with its `/api/run`
spawner. Tunnel-plus-mandatory-token is defense in depth, not either/or — removing
either half reopens a path the other half was specifically there to close.

The wire mechanics of *how* a browser presents that token were open when this page
was written; as built they are: `Authorization: Bearer <token>` on every request,
plus `?token=` accepted on `/api/stream` only (the `EventSource` API cannot set
headers; the server redacts the query value from its logs). See
[security model](model.md) rule 2's as-built note. This page's guarantee is
unchanged: the outcome is identical regardless of which tunnel option carried the
request.

> **As built — the token has a minimum length.** "Mandatory, not opt-in" turned out
> to be too weak a bar on its own, because `DASHBOARD_TOKEN=x` satisfies it while
> offering roughly the protection of the no-op the rule was written against. The
> server therefore refuses to start unless the token is at least **16 characters**
> (`MIN_TOKEN_LENGTH` in `packages/shared/src/security/index.ts`), and the failure
> is a startup refusal rather than a warning, so a too-short token cannot be
> discovered later by an attacker instead of sooner by the operator. Sixteen is a
> chosen floor, not a measured one — it is long enough that a token has to come from
> a generator rather than from typing, which is the actual behaviour being enforced.
> Generate one with `openssl rand -hex 32` or equivalent; this matters more, not
> less, once a tunnel is in play, since the tunnel widens who can attempt the
> guess.

## Choosing between the two

Both are named explicitly in `DESIGN.md` §8; neither is "more secure" than the other,
since both terminate at the same unmoved loopback socket behind the same mandatory
token. Pick based on operational fit:

| | SSH local port-forward | Tailscale tunnel |
|---|---|---|
| Setup | Existing SSH access + key; one `ssh -L` command or a `~/.ssh/config` alias | One-time `tailscale up` on each device, plus `tailscale serve` on the Mac Mini |
| Persistence | Lives only as long as the `ssh` process — needs a wrapper (`autossh`, a `launchd`/systemd unit) or a manual reconnect to survive drops | The Tailscale daemon runs continuously as a background service; the `serve` forward persists across reconnects once set |
| Reachability across NAT / a dynamic home IP | Needs a way to reach the Mac Mini's SSH port from outside — a LAN, a forwarded router port, or dynamic DNS | Tailscale's own relay/NAT-traversal handles this with no router configuration |
| New surface exposed | Only the `sshd` you already run for OS administration | The Tailscale client plus the `tailscale serve` forward — scoped to tailnet-approved devices only, never Funnel |
| Fits best | Ad hoc access from a machine you already SSH into for other reasons | Recurring access from a phone or a second laptop, or once more than one remote device needs it |

## What's not yet decided

Consistent with the [style guide](../STYLE-GUIDE.md)'s rule to say plainly when
something is open rather than gloss over it:

- **The dashboard's listening port** is a placeholder (`<port>`) throughout this page —
  the concrete default is one of `DESIGN.md` §10's undecided stack questions.
  *(Resolved as built: default **4317**, `DASHBOARD_PORT` overrides.)*
- **The token transport mechanics** (header vs. cookie vs. query parameter) are not yet
  fixed — see [security model](model.md). *(Resolved as built: `Authorization: Bearer`
  header everywhere; `?token=` accepted on `/api/stream` only, redacted from logs.)*
- **Whether an installer or `launchd` unit ever wraps the SSH/Tailscale setup above**
  (to save re-typing the tunnel command) is not on the roadmap as of this writing; today
  this page describes the manual procedure only. *(Still open — the built installer,
  `usage/hooks-installer.md`, installs hooks, not tunnels.)*
- No server exists yet to actually tunnel to — see the
  [roadmap](../guide/roadmap.md) for when Phase 1 ships the loopback-bound,
  token-gated listener this page assumes. *(Resolved 2026-07: the server exists —
  loopback-bound, token-gated, test-proven by the security-contract suite.)*

## See also

- [Security model](model.md) — the full rule → why → how-enforced catalogue for every
  control this page assumes (loopback bind, mandatory token, same-origin realtime
  channel); its rule 2 as-built note now records the token-transport mechanics
  (Bearer header, `?token=` on the SSE stream only).
- [Threat model](threat-model.md) — the rival-by-rival breakdown of what happens when
  bind and auth are gotten wrong, including the LAN-peer and local-multi-user attacker
  models referenced above.
- [Architecture overview](../architecture/overview.md) — where the loopback boundary
  sits in the ingest loop this page's tunnels carry traffic to.
- [Roadmap](../guide/roadmap.md) — when the hardened, loopback-and-token cockpit this
  page's procedures apply to actually ships.
- [Backup & restore](../operations/backup-restore.md) — SQLite WAL backup, the
  tested-restore discipline, and retention/redaction for the same Mac Mini this page's
  tunnels reach.
