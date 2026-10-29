# agenthropic — Security Review (Senior AppSec, 2026-10-29)

> Part of the [role reviews of 2026-10-29](README.md) — lens: **Senior Application Security Engineer (SEC)**. Independent senior reviewer, read-only, on `main` at `db3f042`. Findings are de-duplicated and scheduled in [10-synthesis.md](10-synthesis.md).

Scope: read-only review of `/Users/ivanbaev/Development/agenthropic` (server, hooks installer, web SPA, alerts, CI). The only thing I ran was a local, offline timing harness against a copy of one regex, kept in the session scratchpad. I did not start the server and made no network calls.

## 1. Verdict

**Security readiness for v1.0: 6.5 / 10. Not ready to tag until two fixes land; both are small.**

Most of the design and code is solid:
- the loopback host is a compile-time constant
- token comparison is timing-safe
- auth is gated on the routed path
- the installer keeps the token out of argv and out of `settings.json`
- corpus reads are hardened against symlinks
- all SQL is parameterised
- the SPA has no innerHTML-class sinks

Two defects block the tag:
- **SEC-1, a confirmed ReDoS** in the hook-payload redactor. One long dotted or hyphenated token in a prompt or assistant message freezes the whole single-threaded server for minutes or more. Prompt injection from repository content can trigger it.
- **SEC-2, confidentiality downgrade.** The SQLite DB, its WAL/SHM files and the backups are created group- and world-readable (0644 in a 0755 directory). The source corpus they copy from is 0600 under a 0700 directory.

With both fixed and the security headers added (SEC-3), I would rate it 8.5/10.

## 2. What is strong (with evidence)

- **Loopback cannot be misconfigured.**
  - `apps/server/src/config.ts` hard-codes `HOST = '127.0.0.1'` with no env override.
  - `assertLoopbackHost` in `packages/shared/src/security/index.ts` is a second guard.
  - Vite dev and preview also bind `127.0.0.1` (`apps/web/vite.config.ts:10,20`).
- **Token comparison.** `timingSafeTokenEqual` (`packages/shared/src/security/index.ts`) SHA-256s both sides before calling `crypto.timingSafeEqual`, so token length does not leak. `requireDashboardToken` rejects tokens shorter than 16 characters and tokens with leading/trailing whitespace or control characters.
- **Auth is gated on the routed path, not the raw URL.**
  - The `onRequest` hook (`apps/server/src/server.ts:284–304`) keys on `request.routeOptions.url` starting with `/api/`, which closes percent-encoding bypasses such as `/%61pi/...`.
  - The Bearer scheme is matched case-insensitively.
  - `?token=` is accepted only on `/api/stream`, because EventSource cannot send headers.
  - `redactTokenInUrl` scrubs that token from logs.
  - The logger is off by default; when enabled, its request serializer redacts the token.
- **SSE.**
  - The origin check runs before the token check (403 vs 401) and uses exact-match origins.
  - `DASHBOARD_ALLOWED_ORIGINS` entries are validated with `new URL(e).origin === e`.
  - Each subscriber's backlog is capped at 1 MiB, there is a 15 s heartbeat, and HEAD returns 405.
- **Error hygiene.** The custom 404 handler (`server.ts:261–263`) does not echo the path or token. 5xx details are hidden (`server.ts:265–273`).
- **Corpus ingestion** (`apps/server/src/corpus/corpus-paths.ts`, `node-corpus-fs.ts`, `disk-substrate.ts`, `api/substrate-provider.ts:193–227`):
  - the corpus root is resolved with `realpath`
  - files are opened `O_RDONLY|O_NOFOLLOW`, then `fstat` requires a regular file and enforces a size cap (`OversizeError`)
  - `isRealDir` rejects symlinked directories
  - session ids must match a UUID regex before any `join`
  - `assertWithinRoot` is applied to every derived path
- **Static site** (`apps/server/src/http/static-site.ts`):
  - dotfile and NUL path segments are rejected
  - paths go through realpath and root containment, and files are opened `O_NOFOLLOW`
  - the `/api` namespace is refused case-insensitively
  - responses carry `X-Content-Type-Options: nosniff`, and HTML is served `no-store`
- **Installer** (`hooks/install.mjs`):
  - the token is never written to `settings.json` and never appears in argv; curl gets it via `--variable`/`--expand-header` from the environment
  - curl runs with `--disable` (ignores `~/.curlrc`) and `--noproxy '*'`, against a hard-coded `127.0.0.1`
  - hooks are async
  - writes are atomic: a temp file opened with `wx`, then a rename that preserves the file mode
  - backups use `COPYFILE_EXCL`
  - symlink resolution is bounded at 40 hops
  - hook ownership across generations Gen1–Gen4 is classified by exact match, so foreign hooks are never touched
  - the port and the token env-var name are validated
- **Hook receiver** (`apps/server/src/hooks/routes.ts`, `envelope.ts`):
  - it is under `/api/`, so it is auth-gated
  - the delivery-id header is limited to 200 characters and must match `/^[^\s,]+$/`
  - hook names are capped at 200 characters
  - a request with no body returns 400
  - payloads are redacted before persisting, and appends are idempotent
- **Telegram sink** (`apps/server/src/alerts/`):
  - the host is the constant `https://api.telegram.org`, with `redirect: 'error'` (no SSRF through a redirect) and a 10 s timeout
  - messages are plain text with no `parse_mode`
  - only ids, cost and timestamps are sent, never prompt content
  - control and bidi characters are stripped and each field is truncated to 128 characters
  - `retry_after` is capped at 3600 s
  - error reasons go through `redactSecret`
- **Telegram token reference.** A `file:` reference must be an absolute path, not a symlink, owned by the server's uid, and have `mode & 0o077 == 0`.
- **SQL** (`apps/server/src/api/queries.ts`, `routes.ts`):
  - every value is bound with `?`
  - the only interpolations are constant fragments: `SESSION_PAGE_ORDER`, literal table names in `getGlobalDag` (lines 1077–1082), and placeholder lists
  - query strings are validated with TypeBox (bounded limits, an ISO pattern for `since`)
- **SPA**:
  - the token is kept in `sessionStorage`, not `localStorage`
  - grep finds no `dangerouslySetInnerHTML`, `innerHTML`, `.html(` or `eval`
  - D3 writes text through `.text()` and attributes, and the only dynamic `href` is the internal `viewHash(id)` (`Shell.tsx:694`)
- **CI** (`.github/workflows/ci.yml:34`, `pages.yml:66,76,144`): top-level `permissions: contents: read`, with per-job escalation only where needed. There is no `pull_request_target`.

## 3. Findings

| SEC-n | Sev | Finding | Evidence file:line | Exploit scenario | Recommendation | Effort | Verdict |
|---|---|---|---|---|---|---|---|
| SEC-1 | **P1** (P0 if you count availability as a release blocker) | Catastrophic backtracking in `ENV_ASSIGNMENT`. It runs on every string of every hook payload. | `apps/server/src/hooks/redact.ts:104` (regex), `:126` (applied in `maskCredentialShapes`). Measured on Node 22.23.2: see the table after this one. | The installed hooks (UserPromptSubmit, Stop with `last_assistant_message`, SubagentStop, PreCompact) POST content with the user's valid token. A long dotted or hyphenated token reaches the regex: a minified bundle, a long FQDN or package path, a base64url blob, or text a hostile repo file induces the model to emit (prompt injection). The single event loop then blocks, freezing the API, SSE and ingest. curl's 3 s timeout does not stop the server, and repeated Stop events queue up more work. | Drop the leading `\b` and anchor with a lookbehind `(?<![A-Za-z0-9_.-])`; bound the name, e.g. `[A-Za-z_][A-Za-z0-9_.-]{0,127}`; cap the length of each scanned string, e.g. 64 KiB, and redact the rest wholesale. Add a regression test with a time budget (e.g. `'a.'.repeat(50_000)` in under 50 ms). Audit the other credential regexes the same way; they looked linear to me, but I did not time them. | S | CONFIRMED |
| SEC-2 | **P1** | The DB, WAL, SHM and backups are created with umask defaults (0644 files, 0755 directory). The source corpus is 0600 files in 0700 directories. | `apps/server/src/db/connection.ts:20–21` (`mkdirSync` and `new Database` with no mode); `apps/server/src/db/backup.ts:15–16,35` (no mode/chmod). Observed: `data/` is `drwxr-xr-x`; `agenthropic.db`, `-wal` and `-shm` are `-rw-r--r--`. Home is `drwxr-x---+` with group `staff`. | Another local account on the Mac Mini in group `staff`, such as the bot account, can read `events_raw.payload`. Those payloads are redacted, but they still hold prompts, assistant messages, project paths and costs that were private (0600) in `~/.claude`. Backups widen exposure the same way, and on Time Machine or other media. | `mkdirSync(dir, {recursive:true, mode:0o700})`. Set `process.umask(0o077)` at startup, or `chmodSync(0o600)` the DB, WAL, SHM and backup files. Add a startup check that refuses or warns if the DB directory is group- or world-accessible. Document migrating existing installs (one-time chmod). | S | CONFIRMED |
| SEC-3 | P2 | The SPA ships no CSP, no `frame-ancestors` / `X-Frame-Options`, and no `Referrer-Policy`. | `apps/server/src/http/static-site.ts` sets only `nosniff` and `no-store`. | Any page the user visits can frame `http://127.0.0.1:4317` and clickjack the token-entry screen. With no CSP, a future XSS (from an unescaped D3 label, a dependency, etc.) could read the `sessionStorage` token and send it out. | `Content-Security-Policy: default-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'; object-src 'none'`, plus `X-Frame-Options: DENY` and `Referrer-Policy: no-referrer`. Apply them to API responses too. | S | CONFIRMED (headers absent) |
| SEC-4 | P3 | No Host-header allowlist (DNS rebinding). | No Host validation in `apps/server/src/server.ts`; grep found none anywhere in `apps/server/src`. | `evil.example` rebinds to 127.0.0.1. Its script can then load the unauthenticated static SPA and probe that the service exists. The API stays token-gated, and the token sits in `sessionStorage` for the real origin only, so the rebinding origin cannot read it. The impact is reconnaissance plus a weaker defence-in-depth posture. | Return 421/403 unless `Host` is `127.0.0.1:<port>`, `localhost:<port>`, or the host of an entry in `DASHBOARD_ALLOWED_ORIGINS` (needed for the tunnel case). | S | CONFIRMED (absence); impact low |
| SEC-5 | P3 | `DASHBOARD_TOKEN` must be exported in Claude Code's environment, so every Bash tool call, subprocess and MCP server inherits it. | `hooks/install.mjs`: curl reads the token from env via `--variable`; the installer requires the env var. | A prompt-injected agent runs `env`/`echo $DASHBOARD_TOKEN`, or a third-party MCP server reads `process.env`. The token is leaked, though only to loopback. An attacker who is already the same user can read the corpus anyway, so the marginal gain is write access (forging hook events) and read access to the aggregated DB. | Document this in the threat model. Consider a token file (0600, same owner and mode checks as `token-ref`) read by curl via `--variable @file`, so the token is not inherited. Separately, consider splitting the ingest token from the dashboard token. | M | CONFIRMED (design property) |
| SEC-6 | P3 | Token policy checks length only (16 characters); there is no entropy check and no generator. | `packages/shared/src/security/index.ts` (`requireDashboardToken`) | A user sets `DASHBOARD_TOKEN=passwordpassword`. Over a tunnel, or to a co-resident process, it can be guessed or brute-forced; I found no rate limiting. | Provide `agenthropic token generate` (32 random bytes, base64url) and the docs one-liner `openssl rand -base64 32`. Optionally reject low-diversity tokens and raise the minimum to 32. | S | CONFIRMED (policy); exploitability PLAUSIBLE |
| SEC-7 | P3 | Unbounded string and recursion inputs. | `api/routes.ts`: `id` and `topTierModel` are `Type.String({minLength:1})` with no `maxLength`. `hooks/envelope.ts`: `sessionId` has no length cap; `canonicalJsonStringify` and `redactSecrets` recurse. I found no explicit `bodyLimit` (Fastify's 1 MiB default applies). | Deeply nested JSON, e.g. 100k levels of `[`, fits under 1 MiB. Recursive canonicalisation or redaction could throw `RangeError` (stack overflow), which the error handler turns into a generic 500. Only authenticated callers can do this. | Add `maxLength` (e.g. 256) to id-like params. Add a depth limit (e.g. 64) in redact/canonicalise. Set an explicit `bodyLimit` so it is visible and tested. | S | PLAUSIBLE (not executed) |
| SEC-8 | P3 | Same-user TOCTOU edges. | Corpus: `lstat` then `open` lets a FIFO block before `fstat` (`node-corpus-fs.ts`). Alerts: `load-config` uses `statSync`, which follows symlinks, and does not check whether the parent directory is writable. `token-ref` has an `lstat` → read gap. | Needs write access to a 0700 directory owned by the same user, an attacker who has already won. A FIFO could hang one ingest pass. | Open with `O_NONBLOCK` and then `fstat`, or `fstat` the fd before reading. Use `lstat` plus fd-based checks in `load-config`. Low priority. | S | PLAUSIBLE |
| SEC-9 | P3 | Supply chain: Actions are pinned to major tags, not commit SHAs, and I saw no Dependabot/Renovate config. | `.github/workflows/ci.yml:41,46` (`actions/checkout@v7`, `setup-node@v7`); `pages.yml:81–154` (`configure-pages@v6`, `jekyll-build-pages@v1`, `upload-pages-artifact@v5`, `deploy-pages@v5`). `.github/` contains no `dependabot.yml`. | A compromised or retagged action runs in CI. The blast radius is limited: `contents: read`, `pages: write` only on the build/deploy jobs, and no secrets I could see. | Pin to SHAs with a version comment and add `dependabot.yml` for `github-actions` and `npm`. Confirm CI uses `pnpm install --frozen-lockfile`; I did not check this. | S | CONFIRMED (tags); risk low |

Timing measurements for SEC-1 (`ENV_ASSIGNMENT`, Node 22.23.2):

| Input | Size | Time |
|---|---|---|
| `'a.'` repeated | 20 000 chars | 6.2 s |
| `'a.'` repeated | 40 000 chars | 35.0 s |
| `'a.'` repeated | 80 000 chars | killed after more than 120 s |
| `'ab-'` repeated | 10 000 chars | ~0.7 s |
| base64url-like `[A-Za-z0-9_-]` | 10 000 chars | ~0.5 s |
| plain `'a'` | 10 000 chars | ~0 ms |

Growth is superquadratic, and the default body limit is 1 MiB.

Root cause of SEC-1: `\b` matches at every `.`/`-` boundary. The greedy `[A-Za-z0-9_.-]*` then backtracks across the whole tail looking for `=`, so cost is roughly O(n²), and worse once `\s*` and the alternation are involved.

## 4. Threat-model gaps

1. **Availability is not modelled.** The model covers the RCE that the design walks away from, plus auth, origin and loopback, but not "authenticated but hostile content". Hook payloads are attacker-influenced, through prompt injection or simply by whatever the user pastes. Every parser and regex on that path needs a linear-time requirement and a size/depth budget. SEC-1 is the concrete result of this gap.
2. **Local multi-user confidentiality.** The Mac Mini hosts other accounts, such as the bot. The model should say "data at rest is no more readable than its source (0600/0700)" and verify that at startup (SEC-2).
3. **The token as an ambient secret in the agent's environment** (SEC-5). The model should state who can read the token: the same user, every tool subprocess and every MCP server. It should also say what a leaked token grants: forging hook events and reading the aggregated DB, beyond what the raw corpus already gives.
4. **Browser-side attacker.** CD-5 covers the SSE origin. Clickjacking, DNS rebinding of non-API routes, and the CSP posture are not written down (SEC-3, SEC-4).
5. **Tunnel mode.** I found no rate limiting or lockout on 401s. Over SSH or Tailscale, the token is the only control, so token strength (SEC-6) matters more there than on pure loopback.
6. **Redaction scope.** Redaction applies only to hook payloads. Rows ingested from JSONL are stored as-is, by design (ground truth). The model should say explicitly that the DB holds raw transcript-derived data and therefore needs the same protection as `~/.claude` (ties to SEC-2). The redaction field list is still marked "PENDING Ivan's ratification" (OPEN-3).

## 5. Recommendations mapped to the roadmap

**Before the v1.0 tag (all S, roughly half a day in total):**
- SEC-1: fix the regex, cap string length, add a time-budget regression test, and fuzz-time the other redaction regexes.
- SEC-2: umask 0o077 or explicit modes on the DB directory, DB, WAL, SHM and backups; add a startup permission check; add an upgrade note to `chmod` existing installs.
- SEC-3: CSP, `frame-ancestors 'none'`, `X-Frame-Options: DENY` and `Referrer-Policy: no-referrer`.
- SEC-4: Host-header allowlist. It is one hook, and it closes rebinding for the whole surface.
- Add threat-model gaps 1–3 and 6 to `docs/site/security/threat-model.md` / `SECURITY.md`.

**v1.x:**
- SEC-6: token generator, and stronger minimum length and diversity checks.
- SEC-7: `maxLength` on id-like params, a depth limit in redact/canonicalise, an explicit `bodyLimit`.
- SEC-9: SHA-pin the Actions and add Dependabot for Actions and npm.
- 401 rate limiting or backoff for tunnel mode.
- SEC-8: hardening for FIFOs and symlink-following stat calls.

**v2.0 (alerts / KC-5):**
- SEC-5: token file instead of env inheritance, and separate ingest and dashboard tokens with distinct scopes. This becomes worth doing once alerts make the server more stateful and valuable.
- Re-review the Telegram path whenever message content beyond ids and cost is considered. Today's content-free design is the right default; keep it.

**Never:**
- A browser-driven `claude` spawner, a `0.0.0.0` bind, or public exposure. Current code holds all three lines; keep `HOST` a constant.
- Accepting `?token=` on anything other than `/api/stream`.
- Moving the token to `localStorage`.

## 6. Questions for the owner

1. Do other macOS accounts exist on the Mac Mini, such as the bot account, and are they in group `staff`? That decides whether SEC-2 is P1 (yes) or P2 (single-user box). I recommend fixing it either way.
2. Should availability of the dashboard count as a v1.0 release blocker? If yes, SEC-1 is P0.
3. Will tunnel access (SSH/Tailscale) be used in v1.0? If so, SEC-6 and 401 rate limiting move up to "before tag".
4. Is the hook-redaction field list (OPEN-3) ratified? The SEC-1 fix is a good moment to finalise it.
5. Is it acceptable that `DASHBOARD_TOKEN` is visible to every MCP server you run (SEC-5), or should v1.x already use a 0600 token file?
6. Which Vite version runs in dev? The lockfile shows `vite@7.3.6`, whose dev server has a default `allowedHosts` rebinding guard, and `fastify@5.10.0`. Is the dev server ever run against the real corpus? If so, it inherits the same SEC-3/SEC-4 considerations.

Not verified, flagged so nobody assumes it was:
- whether CI uses `--frozen-lockfile`
- the actual runtime behaviour of SEC-7 (the deep-JSON 500)
- the fix status of findings in earlier review docs (`docs/analysis/impl-review-2026-08-09.md`); I did not cross-check them
- timing of the redaction regexes other than `ENV_ASSIGNMENT`

The timing scripts are at `/private/tmp/claude-501/-Users-ivanbaev-Development-agenthropic/41c2974a-1add-44d0-af20-59e58532fd33/scratchpad/redos.mjs` and `/private/tmp/claude-501/-Users-ivanbaev-Development-agenthropic/41c2974a-1add-44d0-af20-59e58532fd33/scratchpad/redos2.mjs`. I made no repository changes.
