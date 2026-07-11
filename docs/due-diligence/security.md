# Security Reality — Cross-Cutting

The reports' "loopback by default" framing is too generous. **Every viable candidate
binds 0.0.0.0 and/or ships auth that is a no-op in practice.** Treat the whole category
as beta software you must harden before it touches a network.

## Posture matrix (verified at source)

| Project | Bind | Auth | CORS | Worst finding | Location |
|---|---|---|---|---|---|
| **hoangsonww** | configurable | `DASHBOARD_TOKEN` — **no-op when unset** | — | **RCE**: `/api/run` accepts `permission-mode` from browser; `ALLOWED_PERMISSION_MODES` includes `bypassPermissions` → spawns `claude --permission-mode bypassPermissions` in any cwd | `run.js:96`, `security.js:133` |
| **simple10** | **0.0.0.0** | **none** | wildcard | LAN-exposed dashboard, no token; stores full tool payloads | server bind + CORS config |
| **cast** | **0.0.0.0** | write-gate good, **GET reads unauth** | — | Read-gate 404s writes without `CAST_DASHBOARD_CONTROL=1`+token, but unauth GETs dump every table | `index.ts:101`, `controlGate.ts` |
| **disler** | — | **none** | `*` | **SSRF**: server dials arbitrary `responseWebSocketUrl` from the request body; unauth `POST /events`; `.env` guard commented out | `index.ts:198-201`, `pre_tool_use.py:324-327` |
| **nirdiamant** | — | none | — | **Command injection** in snapshot name via double-quoted `execSync` `$(...)`; `ANTHROPIC_API_KEY` path ships files to Anthropic | snapshot handler |
| **claude-code-templates** | **0.0.0.0** | **none** | — | LAN-exposed analytics, no auth | analytics server |

## The two standouts (opposite directions)

- **Worst:** `hoangsonww`. On 0.0.0.0 with no token set, `/api/run` is a remote code
  execution box — a browser request runs `claude` with `bypassPermissions` as the host
  user in an attacker-chosen directory. The concurrency cap the report flagged is
  irrelevant; the permission mode is the lever. **Good news:** the spawner is cleanly
  excisable (~6 files + one mount line + one table) — delete it and this drops away.
- **Best pattern (steal it):** `cast`'s `controlGate.ts` — read-only by default,
  non-safe verbs 404 unless `CAST_DASHBOARD_CONTROL=1` **and** `DASHBOARD_TOKEN` set,
  `timingSafeEqual` comparison, mounted before the router. ~73 lines, dependency-free,
  drop-in. Adopt this shape regardless of which base wins.

## Non-negotiable hardening for the Mac Mini M4

Per `agenthropic`'s own security invariants, before anything is exposed:

1. **Bind `127.0.0.1` only** — never `0.0.0.0`. Patch this first in whatever base is
   forked.
2. **Add a real token** on every write endpoint (constant-time compare); same-origin
   check on the WebSocket.
3. **No browser-driven `claude` spawner, ever** — the RCE this project deliberately
   walks away from. If forking hoangsonww, delete `run.js`/`run-spawner.js` before
   first run.
4. **Reach it only over Tailscale/SSH** — never a reverse proxy to the open port,
   never public exposure.
5. **SQLite in WAL mode with backups.**
6. Store **redacted** tool payloads if payloads are stored at all (simple10 currently
   stores full payloads).
