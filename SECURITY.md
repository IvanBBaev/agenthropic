# Security Policy

agenthropic is a self-hosted, local-first dashboard that reads Claude Code transcripts
from `~/.claude/projects` and serves them over a loopback-bound HTTP server. It is a
personal project with a single maintainer.

This document states what is supported, what the security model actually is, what
counts as a vulnerability here, and how to report one.

## Supported versions

| Version | Supported |
| --- | --- |
| `main` | Yes |
| Anything else | No |

There is no released version. The root package is at version `0.3.0` (`package.json`) and
every workspace package is `private: true`; there is no tag, no published package and no
binary, and the only way
to run agenthropic is a checkout of `main` plus the Quickstart in `README.md`. v1.0 is
targeted for **2026-12-01** (`RELEASE.md`, kill checkpoint KC-4). Until then, fixes land
on `main` only, and "upgrade" means pulling `main`.

Node 22 is required (`.nvmrc`; `engines.node` is `>=22 <23`, enforced at install and, by
`scripts/check-node-version.mjs`, at `pnpm test` / `pnpm start`).

**AMENDED 2026-09-23 (J-1).** The guard reaches further than `pnpm test` / `pnpm start`, which
was its whole wiring when this was written: it also prefixes the root `gate:node`,
`apps/server`'s `dev`, `start`, `bench` and `test`, `apps/web`'s `dev` and `test`, and the
`test` script of `packages/shared`, `packages/core` and `packages/test-fixtures`. It is not on
`typecheck`, `lint`, `format`, `format:check`, `hooks:install`, `apps/web build` or
`render-claims`. Treat it as a footgun guard, not a security control: it is a package-script
prefix, so a direct `npx vitest` / `tsx` invocation runs on whatever Node is on PATH.

## Reporting a vulnerability

Use GitHub's private vulnerability reporting:

1. Open <https://github.com/IvanBBaev/agenthropic/security>.
2. Click **Report a vulnerability**.
3. Describe the issue, the affected file or endpoint, the preconditions an attacker
   needs, and a reproduction if you have one.

**If that button is not there**, the maintainer has not enabled private reporting on
this repository yet. In that case, do **not** open an issue containing the exploit.
Open a normal issue that names only the affected component (for example "the SSE origin
check" or "corpus path resolution") and asks for a private channel, then wait for one to
be opened. Keep the details out of the public thread until then.

There is no security email address, no phone number and no PGP key published for this
project. Do not send exploit details through any channel other than the private report
above.

### What to expect

agenthropic is maintained by one person in their own time. Concretely:

- **No response-time commitment.** There is no SLA, no triage rota and no guarantee
  that any particular report is looked at within any particular window.
- **No bug bounty.** There is no money, no swag and no reward program of any kind.
- **No CVE process.** No CNA relationship exists; nothing here is going to be assigned
  an identifier by this project.

What a valid report does get is a fix on `main`, and acknowledgement of the reporter in
the fix if the reporter wants to be named.

## Threat model

The server binds `127.0.0.1` only and every `/api/*` route is Bearer-token gated (the static
SPA shell, which holds no secret, is the one thing served without a token). That shapes
both halves of the scope below.

### Out of scope

**An attacker who already has local shell access as the user running the dashboard is
outside the threat model.** Such an attacker can already read `~/.claude/projects`
directly, read the SQLite database directly, read `DASHBOARD_TOKEN` out of the
environment or the running process, and execute anything the user can execute. Nothing
in agenthropic is designed to stand up to that, and a report whose precondition is
"given local code execution as the user" will be closed as out of scope. So will:

- Findings against a deployment that deliberately widened the bind or put a reverse
  proxy in front of the port. That is not a supported configuration (see rule 5).
- Missing rate limiting, resource exhaustion or denial of service against a
  loopback-only, token-gated port.
- Vulnerabilities in Claude Code itself, or in the content of your own transcripts.
- Anything requiring physical access to the machine.
- Dependency advisories with no demonstrated path to one of the in-scope items below.
  Those are welcome as a normal issue instead.

### In scope

Anything that:

- widens the bind beyond loopback, or lets a request reach the server from a
  non-loopback address;
- weakens or bypasses the auth gate: an ungated route, a path that reaches a handler
  before the global `onRequest` hook, or a token comparison that leaks;
- reintroduces a subprocess spawner or dynamic code evaluation reachable from request
  input;
- leaks the dashboard token anywhere it should not be, including a log line, an error
  body, a response payload, the database, or a process argv;
- escapes the read-only corpus path: a traversal, a followed symlink, or any write,
  rename or unlink against `~/.claude/projects`;
- defeats redaction, so a credential present in a hook payload reaches storage or the
  browser;
- introduces an outbound request whose URL comes from ingested data (SSRF).

## The security model, as built

Every item below is enforced in code, not by convention. File references are to `main`.

### 1. Loopback bind only, or the process dies

The bind host is the constant `HOST = '127.0.0.1'` in `apps/server/src/config.ts`, and
there is no configuration path that changes it. The port is configurable
(`DASHBOARD_PORT`); the host is not. After `listen`, `enforceLoopbackOrExit` in
`apps/server/src/index.ts` re-reads every bound address and calls `process.exit(1)` if
any of them is not loopback, so a wide bind terminates the process instead of serving.
The static gate additionally fails the build on `0.0.0.0`, `host: true`, `host: ''` and
`host: '::'` / `host: '::0'` anywhere in the scanned trees, and on any `package.json`
`scripts` entry that passes the wide address or a `--host` flag without an explicit
loopback value (a CLI flag would override the config file's loopback host).

Since 2026-09 that check also fails **closed** on an empty address list. If the server
reports no bound address at all, the loopback invariant could not be verified, and an
unverifiable invariant is treated as a failure: the process logs `FATAL: the server reported
no bound address, so the loopback-only invariant could not be verified; shutting down.`,
runs its cleanup and exits non-zero. The earlier form passed vacuously in that case, because
"none of the addresses is non-loopback" is trivially true of an empty list.

### 2. No browser-driven subprocess or `claude` spawner, ever

This is the most important line in this document, because it describes a surface
agenthropic deliberately does not have. There is no `/api/run`, no endpoint that spawns
a process, and no path from request input to a shell. The refusal is guarded statically
rather than left to review: `scripts/check-no-spawner.mjs` fails the build on
`child_process`, `execa`, `.spawn(`, `spawnSync`, `execSync`, `execFile*`, `fork(`,
bracket-form access to any of those, `eval(`, indirect eval, `Function(`, the `vm`
module, `data:` dynamic imports, concatenated dynamic-import specifiers, and imports of
subprocess-wrapper packages (`cross-spawn`, `cross-spawn-async`, `shelljs`, `node-pty`,
`tinyexec`, `zx`, `nano-spawn`, `spawndamnit`). It scans `apps/`,
`packages/`, `scripts/`, `hooks/` and the repo-root config files, sources and tests
alike, and it also opens the root and every workspace `package.json` and fails on a
direct dependency named for a subprocess or WebSocket package (`execa`, the wrapper
packages above, `ws`, `socket.io`, anything containing `websocket`) - direct
dependencies only; a transitive one is the lockfile review's job. It runs as the
**first** CI step, before typecheck (`.github/workflows/ci.yml`) - it is the cheapest
check in the workflow and guards the one invariant the project cannot walk back.

The gate's own header is honest about its limit: a regex scanner stops the idiomatic
reintroduction paths, not a developer who is deliberately obfuscating. If you find a way
to get a process spawned, obfuscated or not, that is a valid and high-severity report.

The gate has exactly two escape hatches, both auditable: a whole-file allowlist that
contains only the policy file itself (and logs on every run), and a per-line
`spawner-gate-allow` marker that is visible in any diff. As of 2026-09-09 the marker
covers three sanctioned exceptions, none reachable from a request: the license gate's
fixed-argv `pnpm licenses list` call (`scripts/check-licenses.mjs`), a server test that
runs `tsx` once at test time to re-measure the migration checksums it pins
(`apps/server/test/migrations-checksum-stability.test.ts`), and a shared test asserting
the loopback guard rejects `0.0.0.0` (`packages/shared/test/security.test.ts`).

AMENDED 2026-09-23: this paragraph used to say the marker "sits on three sites", which
reads as a line count and is not one. Those three exceptions are carried on **five**
marked lines, because two of them need the marker on the `import` as well as on the
call. Since the gate started reporting its own hatches it prints each of those lines and
totals them as `5 line(s) inline-exempt`, so audit the gate's output against the line
count, not against the number of exceptions. Two further mentions of the marker sit in
prose - comments explaining why a file carries it - and suppress nothing; the gate names
them as dead markers and does not fail on them.

### 3. Mandatory token, timing-safe, on every route

`requireDashboardToken` in `packages/shared/src/security/index.ts` throws when
`DASHBOARD_TOKEN` is unset, empty, or shorter than `MIN_TOKEN_LENGTH` (16 characters),
so the server refuses to start rather than defaulting to open. Comparison is
`timingSafeTokenEqual`: both sides are hashed to fixed-length SHA-256 digests before
`crypto.timingSafeEqual`, so neither the value nor its length leaks through timing or
through that function's equal-length precondition.

The gate itself is a single global `onRequest` hook registered before any route in
`apps/server/src/server.ts`, so a route added tomorrow is token-gated by construction
instead of by someone remembering a per-route guard. It authorizes on Fastify's routed
path (`request.routeOptions.url`), not the raw request URL, so a percent-encoded path
such as `/%61pi/health` cannot slip past it. `/api/health` and the hook receiver
(`POST /api/hooks/event`) are gated exactly like everything else - reading health
requires the token.

### 4. SSE, with same-origin checked before auth

The realtime transport is server-sent events, never WebSocket. The static gate fails the
build on `WebSocketServer`, any import or require whose specifier contains `websocket`,
the `ws` and `socket.io` packages, and the `{ websocket: true }` Fastify route option.

On `/api/stream` the same-origin check runs *before* the token check, so a request
carrying a foreign `Origin` is rejected with 403 even when it presents a valid token. A
present `Origin` must be exactly `http://127.0.0.1:<port>` or `http://localhost:<port>`
(`isAllowedOrigin`); no wildcard CORS header is ever sent. A request with **no** `Origin`
header is allowed through to the token check on purpose: that means a non-browser client,
which is not the attack this rule closes, and it still has to present the credential.

Because the browser `EventSource` API cannot set headers, `/api/stream` also accepts the
token as `?token=`. That is the one place a token can legitimately appear in a URL, so it
is the one place logging scrubs it: the Fastify request serializer
(`redactedRequestSerializer` in `apps/server/src/server.ts`) runs `redactTokenInUrl` on
every request line, and the root not-found handler logs nothing, so an unrouted request
such as `POST /api/stream?token=...` cannot write its URL into a log message either
(Fastify's default 404 handler logs the raw URL as a plain message, bypassing the
serializer).

### 5. Remote access via tunnel only

Reach the dashboard from another machine with an SSH port-forward or a Tailscale tunnel
terminating at the loopback address. This repository contains no TLS termination, no
reverse-proxy configuration and no public-exposure path, and none will be added. If you
put agenthropic behind a proxy on a public address, that is outside the supported
configuration and outside this policy.

### 6. The corpus read surface is read-only by construction

The filesystem port that the entire ingest side depends on (`CorpusFs` in
`apps/server/src/corpus/fs-port.ts`) exposes `readDirNames`, `lstat`, `realpath`,
`readFileConfined` and `readFileTailConfined` - and nothing else. There is no write,
rename, unlink, chmod or open-for-write operation on the interface at all, so the live
transcripts Claude Code is actively appending to cannot be perturbed by the dashboard,
even by accident.

The reads are hardened as well as narrow: the walk uses `lstat` rather than `stat` so a
symlink is observable *as* a symlink and skipped instead of silently followed, and files
are opened `O_RDONLY | O_NOFOLLOW` (`apps/server/src/corpus/node-corpus-fs.ts`) so a
symlink swapped in after the check cannot be followed either. A path that resolves
outside the canonical corpus root raises `ContainmentError`, which is the one error the
ingest loop never swallows: `exitOnCorpusFatal` in `apps/server/src/index.ts` logs it and
exits non-zero, on the grounds that a crafted or compromised corpus is a stop-everything
signal rather than something to skip past.

Note that the corpus is treated as **untrusted input**, not as trusted local data - it is
whatever an agent session happened to write. Corpus-driven parsing findings are in scope.

### 7. Redaction at the ingest boundary

Hook payloads are scrubbed by `redactSecrets` (`apps/server/src/hooks/redact.ts`)
*before* the envelope is built and before the idempotency key is computed
(`apps/server/src/hooks/routes.ts`), so a raw secret never reaches the stored envelope or
its hash, and a redelivered event redacts identically and still dedupes. Two independent
rules apply. Field names that normalize to a secret-bearing fragment (`token`, `secret`,
`password`, `passwd`, `credential`, `apikey`, `authorization`, `bearer`, `privatekey`,
`accesskey`, `sessionkey`, `cookie`) are replaced wholesale, with an explicit allowlist so
token *count* fields such as `input_tokens` survive as the observability data they are.
String values are then scanned for credential shapes - `sk-` keys, GitHub `ghp_`/`gho_`/
`ghu_`/`ghs_`/`ghr_` and `github_pat_` tokens, `xox`-prefixed Slack tokens, `AKIA` access
key ids, JWTs, and inline `Bearer` fragments - and each match is masked in place.

Redaction is defence in depth, not a promise that your database holds no sensitive text:
the JSONL corpus is ingested for token counts and structure, and it is your own prompt
content. Treat the SQLite file and its backups as sensitive.

### 8. Storage

SQLite through better-sqlite3, opened in WAL mode with `foreign_keys = ON`. Both pragmas
are read back after being set and a connection that did not take them throws rather than
being handed to the rest of the app (`apps/server/src/db/connection.ts`). Backups are
written by an in-process daily timer next to the database, and the restore path refuses
any image that fails `PRAGMA integrity_check`.

### 9. No outbound network requests

The server makes no outbound request of any kind today: no telemetry, no update check,
no webhook dispatcher (alerting is post-1.0 and not built). `ANTHROPIC_API_KEY` appears
nowhere under `apps/`, `packages/`, `hooks/` or `scripts/` - the dashboard process does
not hold it and no code path reads it. The SSRF class of bug therefore currently has no
surface to land on; a change that introduced one would be in scope. Since 2026-09-26 the
absence is also enforced: `pnpm run gate:spawner` fails CI on an outbound network
primitive or HTTP client in `apps/server/src/` or `packages/*/src/`, or an HTTP client
package in those manifests.

## Operator responsibilities

None of the above helps if the deployment undoes it.

- Use a long, random `DASHBOARD_TOKEN`. The 16-character minimum is an enforced floor,
  not a recommendation. Keep it out of shell history and out of version control.
- Do not expose port 4317 (or your `DASHBOARD_PORT`) to a network. Tunnel instead.
- The SQLite database and its backups contain your session content. Protect them the way
  you protect the transcripts they were built from.
- The hooks installer (`hooks/install.mjs`) generates a `curl` command that reads the
  token from the environment at fire time using curl's `--variable` / `--expand-header`,
  so the token never enters any process's argv. That mechanism requires curl 8.3.0 or
  newer; on an older curl the hook delivers nothing rather than falling back to a form
  that would leak. If you hand-edit those hooks, do not put the literal token on the
  command line.
- The same command starts with `curl --disable` and passes `--noproxy '*'`: a `~/.curlrc`
  cannot add tracing or a proxy, and an `http_proxy` / `ALL_PROXY` in the environment
  cannot route the loopback POST (token and prompt) through a proxy. Hooks written by an
  earlier installer version are recognised and upgraded in place on the next install.

## Verifying the invariants yourself

```sh
pnpm run gate:spawner   # static: no spawner, no wide bind, no eval, no WebSocket
pnpm run test           # includes apps/server/test/security-contract.test.ts
```

The security contract suite boots the real composition root and asserts that only
`127.0.0.1` is bound; that `/api/health` is 401 without a token and 401 with a wrong
token; that a foreign `Origin` on `/api/stream` is 403 token or not; that a
percent-encoded `/api` path cannot bypass the gate; that the origin check fails closed
when the local port cannot be determined; that a 401 body never echoes the token; and
that constructing the config without `DASHBOARD_TOKEN` throws.

One caveat, stated plainly because the workflow file states it too: CI runs these gates
on every push and pull request, and since **2026-08-25** a red gate also withholds the
merge button, because `main` requires the `ci` status check - the job id in
`.github/workflows/ci.yml`, lowercase, not the workflow's display name. Until that date
this paragraph ended "making a red gate *block a merge* requires a GitHub branch-protection
rule. That is an owner setting on github.com and is not something this repository can
attest." The rule now exists; force-pushes to `main` and deletion of `main` are refused for
everyone.

The one exemption is deliberate, and it travels with every "merge-blocking" claim in this
repository: `enforce_admins` is off, so a red run withholds the merge button from a
*contributor* and not from the repository owner. agenthropic has exactly one maintainer
whose normal working mode is a direct push to `main`, and turning admin enforcement on would
lock the sole maintainer out of their own repository. That is a stated design choice, not an
oversight and not something still to be done. Verify:

```sh
gh api repos/IvanBBaev/agenthropic/branches/main/protection \
  --jq '{contexts: .required_status_checks.contexts, enforce_admins: .enforce_admins.enabled}'
# -> {"contexts":["ci"],"enforce_admins":false}
```

The standing write-up lives in
[the decisions index](docs/site/contributing/decisions/README.md#a-standing-correction-merge-blocking).
