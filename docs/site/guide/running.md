# Running agenthropic

This page is the operator's run book: how to start agenthropic as a single local
product, what every environment variable actually does, how to wire the Claude Code
hooks, and what to check when something is wrong. The key takeaway up front: from a
checkout, **`pnpm start` is the whole thing** — it builds the SPA, then starts the
loopback server, which serves the dashboard **and** the API from one origin, so the
only URL an operator ever opens is <http://127.0.0.1:4317>. A
`DASHBOARD_TOKEN` of at least 16 characters must be exported first; without it the
process refuses to boot, by design.

> **Status of this page.** Unlike most of this corpus, this page was **not** written in
> the pre-code design era — it was authored against the running code in **2026-08**, so
> it carries no `Update — 2026-07 (as built)` box and no design-record prose. Every
> command, default, log line and error string below was read out of the repository. The
> one exception the first revision carried has since been retired: the static-file handler
> and its `DASHBOARD_WEB_ROOT` setting landed in the same change as this page and could
> only be quoted as a specification then, but both are now in the tree and were re-read
> for this revision — `DEFAULT_WEB_ROOT` in `apps/server/src/config.ts` and
> `registerStaticSite` in `apps/server/src/http/static-site.ts`. Two standing
> caveats stay load-bearing for anyone actually running this. The **retention policy is
> signed and wired as of 2026-09-10**: `events` rows older than 90 days and backup files
> older than 30 days (never below the newest 7) are pruned by a runner chained after each
> successful daily backup, boot logs a dry run and deletes nothing, and `0` switches a
> rule off (see [Configuration](../usage/configuration.md) and
> [backup & restore](../operations/backup-restore.md)) — but `token_usage` is **never**
> pruned in v1.0, by decision, so the cost ground truth still grows without bound while
> `events` is now bounded. And the hierarchy-accuracy
> exit gate reports **NOT CERTIFIED at n = 0**, so the subagent tree you are about to
> look at is covered by tests but its accuracy on real data is unmeasured.

## Two ways to run it, and which one is yours

| | **Operator path** | **Developer path** |
|---|---|---|
| Command | `pnpm start` | `pnpm --filter @agenthropic/server dev` **plus** `pnpm --filter @agenthropic/web dev` |
| Processes | one | two |
| Ports | `127.0.0.1:4317` only | `4317` (API) and `5173` (Vite, proxying `/api` → `4317`) |
| SPA source | the built bundle in `apps/web/dist` | Vite dev server, hot reload |
| Open | <http://127.0.0.1:4317> | the URL Vite prints (`http://127.0.0.1:5173` — Vite's default; `apps/web/vite.config.ts` pins the *host*, never the port, so read the printed line) |
| Use it when | you want to **use** the dashboard | you are **changing** the dashboard |

If you are here to observe your own Claude Code sessions, use the operator path. The
developer path is documented in full further down and is not going away — it is how the
SPA is worked on.

## The one-command run

Requires **Node 22, and only 22** (`.nvmrc`; `engines.node` is `>=22 <23` with
`engine-strict`, and `pnpm test` / `pnpm start` refuse any other major up front) and **pnpm** (the repo pins `pnpm@11.11.0` through the root
`package.json` `packageManager` field, so `corepack enable` is enough).

**AMENDED 2026-09-23 (J-1).** The guard's reach is wider than `pnpm test` / `pnpm start`
now, and naming only those two understates it. `scripts/check-node-version.mjs` currently
prefixes: the root `start`, `test` and `gate:node`; `apps/server`'s `dev`, `start`, `bench`
and `test`; `apps/web`'s `dev` and `test`; and the `test` script of `packages/shared`,
`packages/core` and `packages/test-fixtures`. The rule it follows is "every entry point that
loads the native binding, plus the root scripts". Deliberately **not** guarded, because none
of them loads `better-sqlite3`: the root `typecheck`, `lint`, `format`, `format:check` and
`hooks:install`, `apps/web`'s `build`, and `packages/test-fixtures`' `render-claims`. And the
guard is a package-script prefix, not a runtime hook, so a direct invocation still bypasses it
entirely - `npx vitest run --root apps/server` on Node 26 fails in the native-binding cascade
the guard exists to pre-empt. Two docs said "`pnpm test` / `pnpm start`" because that was the
whole wiring when they were written.

```sh
git clone https://github.com/IvanBBaev/agenthropic.git
cd agenthropic
pnpm install

# One line, one time: a real random token. Print it — you paste it into the SPA once.
export DASHBOARD_TOKEN="$(openssl rand -hex 32)"
echo "$DASHBOARD_TOKEN"

pnpm start
```

Then open <http://127.0.0.1:4317>, paste the token into the gate, and you are in.

### What `pnpm start` actually does

The root script is a plain three-step composition — no orchestration layer, nothing
clever: a Node-major guard (`scripts/check-node-version.mjs` exits non-zero on any Node
major other than 22, before anything is built), the SPA build, then the server:

```
"start": "node scripts/check-node-version.mjs && pnpm --filter @agenthropic/web build && pnpm --filter @agenthropic/server start"
```

1. **`pnpm --filter @agenthropic/web build`** runs `vite build` in `apps/web`. The Vite
   config declares no `build.outDir`, so the bundle lands in Vite's default
   `apps/web/dist` — an `index.html` plus hashed asset files.
2. **`pnpm --filter @agenthropic/server start`** runs `tsx src/index.ts` in
   `apps/server`. That is the composition root: it loads configuration (failing
   immediately if `DASHBOARD_TOKEN` is missing), opens the SQLite database in WAL mode,
   runs the forward-only migrations, binds `127.0.0.1:4317`, re-verifies that every
   bound address is loopback (and exits hard if one is not), serves the built SPA and
   the `/api/*` routes from that one origin, replays the JSONL corpus, and then starts
   the tail-follow poll loop.

The server announces itself on stdout once the bind succeeds:

```
agenthropic server listening on 127.0.0.1:4317
```

and the startup corpus pass prints one summary line, for example
`corpus replay: 41/41 sessions ok, 0 failed, 0 skipped, …`. A pass that ingested nothing
still prints a line naming the reason rather than staying silent (no corpus root, no
session changed since the last checkpoint, corpus unreadable this pass).

### Stopping it

`Ctrl-C` in the terminal that runs it stops everything: the signal reaches the whole
foreground process group. Stopping it by PID is different. `pnpm start` and
`pnpm --filter @agenthropic/server start` run the server as a `tsx` child of a `pnpm`
wrapper, and a `kill -TERM` sent to the wrapper's PID is not forwarded — the wrapper exits
and the child keeps listening (observed 2026-09-26: the child was still answering more
than 10 s after the wrapper got `SIGTERM`; `SIGTERM` to the child itself exited in 0.1 s).
Signal the server process, not the wrapper: find it by its port,

```sh
lsof -nP -iTCP:4317 -sTCP:LISTEN
```

and `kill -TERM` that PID. A launchd or systemd unit that runs the wrapper inherits the
same problem; point the unit at the server command itself.

### Why one origin is better than the dev proxy

The realtime stream is **SSE, never WebSocket**, and `/api/stream` enforces a
**same-origin** check before it even looks at the token: a request carrying a foreign
`Origin` header is refused with `403`. Serving the SPA from the same loopback origin
that serves `/api` means the browser sends the origin the check expects, with no proxy
in between and no CORS relaxation anywhere. The dev proxy works too — Vite forwards
`/api` to `127.0.0.1:4317`, so the browser still sees one origin — but the operator path
removes the proxy from the trust story entirely. See
[Security model](../security/model.md) for the full control catalogue.

### Where the token lives

The SPA *shell* — `index.html` and the hashed bundle — is the one unauthenticated
surface in the server, deliberately: a browser cannot present an `Authorization` header
for a page it has not loaded yet, so gating the HTML would leave no way to ever type the
token in. The bundle carries no secret and exposes no data; every `/api` route stays
behind the Bearer gate. See the header comment of `apps/server/src/http/static-site.ts`.

The token is typed into the SPA's gate screen and stored in **`sessionStorage` only** —
never `localStorage`, never a cookie. It is gone when the tab closes, so you paste it
again on the next browser session; that is the intended trade, not an oversight. Every
API call sends it as `Authorization: Bearer <token>`. The one exception is the SSE URL:
`EventSource` cannot set headers, so the stream is opened as `/api/stream?token=…`, and
the server redacts that query parameter from its request log so it never lands in a log
line.

## Environment variables

Everything the server reads, with the real defaults from `apps/server/src/config.ts` —
every row but the last one, whose value the composition root reads straight off the
environment (`apps/server/src/index.ts`) and resolves in
`apps/server/src/corpus/identity.ts`. **Nothing here is a file**: configuration is
environment-only, and there is no config file to leave a secret in.

| Variable | Meaning | Default | Required |
|---|---|---|---|
| `DASHBOARD_TOKEN` | Bearer token for every `/api/*` route and the SPA gate. Minimum **16 characters**. | none | **Yes — startup fails without it** |
| `DASHBOARD_PORT` | TCP port on the fixed loopback host. Integer 0–65535; an unparseable value is a startup error. | `4317` | No |
| `DASHBOARD_WEB_ROOT` | Directory the built SPA is served from. | `apps/web/dist`, resolved from the server module's own location — **not** from the working directory | No |
| `DASHBOARD_DB_PATH` | SQLite database file. Relative paths resolve against the server's working directory, which `pnpm start` makes `apps/server`. | `data/agenthropic.db` (so `apps/server/data/agenthropic.db`) | No |
| `DASHBOARD_INGEST` | Corpus ingest master switch. Accepts `1`/`true`/`0`/`false`; anything else is a startup error. | on | No |
| `CLAUDE_PROJECTS_DIR` | Corpus root to read transcripts from. An empty value counts as unset — it must never come to mean "the current directory". | `~/.claude/projects` | No |
| `DASHBOARD_POLL_INTERVAL_MS` | Tail-follow poll cadence, in milliseconds. Positive integer. **PROVISIONAL** — chosen, not measured. | `3000` | No |
| `DASHBOARD_WATCHDOG_MINUTES` | Inactivity window after which an unobserved agent ages `working` → `unknown`. Positive integer. **PROVISIONAL**. | `10` | No |
| `DASHBOARD_INSTANCE` | Logical instance name stamped onto orchestration edges, for a future multi-machine merge. Read directly by the composition root, not part of the config object. | the OS hostname | No |
| `DASHBOARD_RETENTION_EVENTS_DAYS` | Age window for normalized `events` rows; older rows are pruned after each successful daily backup. Non-negative integer; `0` switches the rule off; an unparseable value is a startup error. Signed v1.0 policy (D3, 2026-09-08). | `90` | No |
| `DASHBOARD_RETENTION_BACKUP_DAYS` | Age window for backup files in `<dirname(DASHBOARD_DB_PATH)>/backups`. Non-negative integer; `0` switches the rule off. | `30` | No |
| `DASHBOARD_RETENTION_BACKUP_KEEP_MIN` | Keep-minimum floor for backup files: the newest N always survive, whatever the window says. Positive integer, never below 1. | `7` | No |

There is deliberately **no host variable**. See the next section.

The three `DASHBOARD_RETENTION_*` rows are read by `loadRetentionValues` in
`apps/server/src/config.ts` and handed to `signedRetentionPolicy` by the composition
root (wired 2026-09-10). The wider set that `apps/server/src/retention/policy.ts` knows
(`…_TOKEN_USAGE_DAYS`, `…_RAW_EVENTS`, `…_BACKUP_DIR`, `…_MAX_ROWS_PER_RUN`,
`…_TOKEN_USAGE_ACK_COST_LOSS`) belongs to the library loader `loadRetentionPolicy`,
which the composition root still never invokes: setting one of those changes nothing —
except `DASHBOARD_RETENTION_TOKEN_USAGE_DAYS`, which the server **refuses at startup**
when set, because the signed v1.0 policy never prunes `token_usage`. The table above is
what the *running* server reads.

**What "integer" means in those rows (parsing hardened 2026-09).** Every numeric variable
goes through one helper, `parseDigits`: plain decimal digits (`/^\d+$/`) that also survive
`Number.isSafeInteger`. Anything else is a startup error rather than a coercion, because
`Number()` alone is far too lenient for configuration - it reads whitespace as `0` and
accepts hex, exponent, signed and decimal-point spellings. So `DASHBOARD_PORT=" 80"`,
`0x1F`, `+80`, `4e3` and `80.0` all fail loudly instead of quietly becoming a port.
`DASHBOARD_POLL_INTERVAL_MS` carries one extra bound: it is capped at **2147483647**, Node's
timer ceiling, because a larger `setInterval` delay is silently clamped to 1 ms - a value
meant as "poll once a month" would otherwise spin. `DASHBOARD_WATCHDOG_MINUTES` has no
ceiling beyond the safe-integer range. And `DASHBOARD_DB_PATH=` (set but empty) counts as
**unset**, the same house rule `CLAUDE_PROJECTS_DIR` and `DASHBOARD_WEB_ROOT` follow:
`better-sqlite3` opens `''` as an anonymous temporary database, so the empty value would
discard every row at exit and put the backups under a working-directory-relative path.

### `DASHBOARD_TOKEN` is mandatory, and why there is no anonymous mode

`loadConfig` calls `requireDashboardToken` before anything else, and that function
throws — the process exits non-zero with the message, never a stack trace — in two
cases:

- unset or empty:
  `DASHBOARD_TOKEN is not set. The dashboard refuses to start without an auth token: set DASHBOARD_TOKEN to a secret of at least 16 characters.`
- shorter than 16 characters:
  `DASHBOARD_TOKEN is too short (N characters). It must be at least 16 characters.`

The reason there is no opt-out is the failure mode this project was built against: a
dashboard whose auth "is optional" is a dashboard that ships unauthenticated, and this
one reads your entire Claude Code history — every session, every prompt-adjacent
artifact path, every dollar figure. An unauthenticated read of that on a shared machine
is the whole risk. Loopback binding is **not** a substitute: every other process and
every other OS account on the host can reach `127.0.0.1`. So the token is the boundary,
it is compared with `timingSafeEqual`, and a global `onRequest` hook applies it to every
`/api/*` route before any route handler runs.

The 16-character floor is a **chosen** number, not a measured one. Its practical effect
is that the value has to come from a generator rather than from typing:

```sh
openssl rand -hex 32
```

**Never commit the token.** It belongs in your shell profile, a `launchd`/`systemd`
unit, or a secret manager — not in the repository, not in a checked-in `.env`, not in a
`package.json` script, and not in a shell history file you sync. Rotating it is
"export the new value and restart": the environment is the only runtime source of truth,
the installer never writes the value to disk, and the server never logs, persists or
echoes it.

### The host is `127.0.0.1`, and it is not configurable

`HOST` is an exported **constant** in `apps/server/src/config.ts`, not a config field.
There is no environment variable, no CLI flag and no code path that widens it. After the
socket binds, the composition root re-reads every bound address and, if any of them is
not loopback, logs a `FATAL:` line and terminates the process — belt and braces for a
mistake that must never ship.

Since 2026-09 it terminates on an **empty** address list too. "No bound address is
non-loopback" is vacuously true of no addresses at all, so the earlier check passed in the
one case where it had verified nothing; the guard now treats an unverifiable invariant as a
violated one and exits non-zero with its own `FATAL:` line.

This is the single decision the project exists to hold. **Remote access is via an SSH
port-forward or a Tailscale tunnel only — never a reverse proxy, never a public port.**
The tunnel carries the transport; the token still applies on top of it, because a
tunnel authenticates the machine and not the request. Both recipes are on
[Remote access](../security/remote-access.md).

## Installing the Claude Code hooks

The hooks are optional and consequential. Install them with:

```sh
node hooks/install.mjs --out /path/to/project/.claude/settings.json
```

or, equivalently, through the root script (`pnpm hooks:install` runs
`node hooks/install.mjs`, and extra arguments are forwarded):

```sh
pnpm hooks:install --out /path/to/project/.claude/settings.json
```

What the installer actually does, read out of `hooks/install.mjs`:

- It writes **one file**, the `--out` path you name (plus a timestamped
  `<file>.backup-<timestamp>` copy of it beforehand, if it already existed). Without
  `--out` it prints the configuration to stdout and writes nothing. It never touches
  `~/.claude` unless you explicitly point `--out` there.
- It registers the **four real** lifecycle hooks — `UserPromptSubmit`, `Stop`,
  `SubagentStop`, `PreCompact`. `SubagentStart` is not a real Claude Code hook and is
  not registered.
- Each one is a single fail-silent `curl` POST of the hook's stdin JSON to
  `http://127.0.0.1:<port>/api/hooks/event` — `--silent --show-error --fail --max-time 3` with a
  trailing `|| true`, so a dead dashboard can never block a Claude Code session.
- **The token value never enters any process's argv.** The command hands curl the
  variable *name* (`--variable '%DASHBOARD_TOKEN'`) and a single-quoted header template
  (<!-- {% raw %} Liquid on GitHub Pages would otherwise render the {{…}} curl template as an empty string -->`--expand-header 'Authorization: Bearer {{DASHBOARD_TOKEN}}'`<!-- {% endraw %} -->), so curl reads the
  environment itself after argv parsing. This needs **curl ≥ 8.3.0**; an older curl
  rejects the unknown option and sends nothing, degrading to zero telemetry rather than
  to a leaked token.
- The merge is non-destructive: unrelated settings keys and unrelated hook entries are
  preserved verbatim, and re-running never duplicates agenthropic's own entries.
  `--dry-run` shows the result without writing; `--remove` strips only agenthropic's
  entries; it refuses to touch a file it cannot parse as JSON.
- Useful flags: `--port <n>` (default `4317` — set it if you changed `DASHBOARD_PORT`)
  and `--token-env <NAME>` (default `DASHBOARD_TOKEN`).

**Hooks contribute liveness only, never structure.** The JSONL transcripts under
`~/.claude/projects` are the primary source of truth: the parser builds the sessions,
the agents, the `orchestration_edges` and the token counts entirely from them. A hook
delivery can move an existing agent's `status` column and nothing else — it can never
create, delete or re-parent a node in the DAG, and a hook naming an agent the parser has
never seen changes no row at all.

What they buy you is the **only terminal signal the dashboard has**. Reading a
transcript proves activity happened; it never proves it stopped, because a file that has
stopped growing is indistinguishable from one whose next line has not been flushed. So
ingest only ever writes `working`; `SubagentStop` is what makes a subagent `completed`
and `Stop` is what makes a main agent `waiting`. **Without the hooks, nothing in the UI
will ever read `completed`** — agents age `working` → `unknown` when
`DASHBOARD_WATCHDOG_MINUTES` elapses. That is the designed behaviour, not a gap: the
dashboard declines to claim an ending nobody observed.

`hooks/README.md` is the full runbook, and [Hooks installer](../usage/hooks-installer.md)
is the long-form page.

## Why there is no compiled server build

`pnpm --filter @agenthropic/server start` is `tsx src/index.ts` — the server runs from
**TypeScript source**, deliberately, and there is no `tsc` emit, no bundler and no
`node --experimental-strip-types` path.

The reason is the migration guard. Every applied migration's checksum is recorded in
`schema_version` and re-verified on every boot, and the checksum hashes the migration's
own `up` source — `migration.up.toString()` — together with the module-level seed
constants, because a historical in-place edit went through a constant outside any `up()`
body.

*(As built, since **2026-08-29**: the normalisation is no longer the whitespace-only
`replace(/\s+/g, '')` formula this page described when it was first written. `normalise`
in `apps/server/src/db/migrations.ts` now also cancels comments, whitespace inside string
and template literals, and separators that are redundant before a closing `)`, `]` or
`}`. The `"//"` note in `apps/server/package.json` still quotes the older formula and is
stale on that one detail; the code is the authority.)*

That normalisation narrowed the executor gap without closing it, and the residual is
**measured, not argued**. Measured on 2026-08-29 across the three executors this repo can
reach — `tsx` (what `pnpm start` runs, so the value a real `schema_version` row holds),
vitest, and `node --experimental-strip-types`: before, all three disagreed on all sixteen
migrations; after, vitest and node each agree with `tsx` on eleven of the sixteen, and
every `tsx` value is byte-identical to what it was. The five that still differ are not
about comments at all — they are printer differences the transforms simply spell
differently (`.1` vs `0.1`, `new Map` vs `new Map()`, a statement separator one printer
keeps, and esbuild's `keepNames` `__name` wrapper). For the vitest transform that set is
pinned as data — migrations 7, 11, 14, 15 and 16 in
`apps/server/test/migrations-checksum-stability.test.ts` — so it cannot widen unnoticed.
The `node --experimental-strip-types` count comes from the same dated measurement and is
recorded in the source docstring rather than pinned by a test, so treat *which* five it is
as unverified here.

Every checksum in every existing database was produced under the `tsx` transform.
Switching executor, or adding a real build, therefore flips those checksums and makes
`runMigrations` fail loudly on every database that already exists. Canonicalising the
remaining differences away is not an escape either: re-printing literals into some
canonical form changes the bytes `tsx` produces *today*, which invalidates every checksum
already sitting in an operator's database.

So the constraint is not stylistic and not a performance opinion: a build step here is a
data-migration incident. The SPA is built (it has to be — a browser cannot run TSX); the
server is not.

## The developer path (two processes)

Unchanged and still supported for anyone working on the code:

```sh
# terminal 1 — API, with reload on save
DASHBOARD_TOKEN="$DASHBOARD_TOKEN" pnpm --filter @agenthropic/server dev

# terminal 2 — Vite dev server with hot module replacement
pnpm --filter @agenthropic/web dev
```

`pnpm --filter @agenthropic/server dev` is `tsx watch src/index.ts`; the Vite dev server
sets `server.host: '127.0.0.1'` and proxies `/api` to `http://127.0.0.1:4317`. Open the
URL Vite prints and paste the same token. `vite preview`, which serves the production
bundle, pins the same host. Wide binds are not merely a convention here: `pnpm
gate:spawner` scans the whole tree and rejects `0.0.0.0`, `host: true`, `host: ''` and
`host: '::'`, so a dev-config slip fails the gate rather than shipping.

Use this path when you are editing the SPA and want hot reload. Use `pnpm start` when
you want to run the product.

## Troubleshooting

### The port is already in use

The bind fails and the process exits non-zero with the driver's `EADDRINUSE` message.
Find the holder and either stop it or move agenthropic:

```sh
lsof -nP -iTCP:4317 -sTCP:LISTEN
DASHBOARD_PORT=4400 pnpm start
```

If you move the port, **re-run the hooks installer with the matching `--port`** — the
generated `curl` command has the old port baked in and will otherwise post into a closed
socket, silently, because the hooks are fail-silent by construction.

### It refuses to start: no token, or too short a token

You get one of the two messages quoted above and a non-zero exit. This is the intended
behaviour and there is no flag that relaxes it. Export a generated value
(`openssl rand -hex 32`) and start again. A common variant on the operator path: the
token was exported in the shell that ran `pnpm start` but a *different* value was pasted
into the browser — the SPA then reports the gate as unauthorized while the server is
perfectly healthy. `echo "$DASHBOARD_TOKEN"` in the server's own shell is the
disambiguator.

### The SPA has not been built yet

If `apps/web/dist` does not exist — for instance because the server was started directly
with `pnpm --filter @agenthropic/server start` instead of `pnpm start` — the API is fine
but there is no dashboard to serve at `/`. The server says so rather than pretending: `/`
answers **503** (not 404, not 500 — the URL is right and the API is up; only the optional
asset is absent) with the actionable, path-free body

```
The dashboard UI is not built yet. Run `pnpm start` (which builds it first), or `pnpm --filter @agenthropic/web build`, then reload this page.
```

Run the build, or just use the composed script:

```sh
pnpm --filter @agenthropic/web build   # or simply: pnpm start
```

The `/api/*` routes are unaffected either way; a missing bundle never takes the API
down. You can confirm the server itself is healthy with a direct probe:

```sh
curl -s -H "Authorization: Bearer $DASHBOARD_TOKEN" http://127.0.0.1:4317/api/health
```

### The dashboard is up but empty

Nothing has been ingested yet. In rough order of likelihood:

- **The corpus root is somewhere else.** The default is `~/.claude/projects`; a resolved
  root that does not exist is reported as `corpus replay: no corpus root resolved -
  nothing to replay.` Point `CLAUDE_PROJECTS_DIR` at the real directory.
- **Ingest is switched off.** `DASHBOARD_INGEST=0` disables the watcher entirely; the
  server then serves an empty database quite happily.
- **The replay is still running.** On a large corpus the startup pass takes seconds.
  `GET /api/health` reports `ingest: "replaying"` until it finishes, then `"idle"` —
  that field is how you tell "warming up" from "startup pass finished". `"idle"` does
  not mean the pass succeeded: a replay that could not read the corpus also ends in
  `"idle"`, and says why in the log. With `DASHBOARD_INGEST=0` the field is absent.
- **Files were skipped.** A transcript that is oversize, unreadable or otherwise
  declined is counted and logged (`corpus ingest: skipped … - this file's records are
  NOT in the dashboard totals (the session's other files, if any, still are).`) and
  shows up as `ingestSkips` on `/api/health`. The skip is per file, not per session:
  when a main transcript is declined, the session's subagent transcripts are still
  ingested, so the session still appears in `/api/sessions` and in the totals with
  whatever those files carried (observed 2026-09-26: a 151 MiB main transcript skipped
  as oversize, 367 agents served under it), and nothing on the session marks the
  gap. A skipped file freezes what it would have contributed, so it is reported
  rather than dropped silently.
- **A session failed or was quarantined.** `sessionsExcluded` / `sessionsQuarantined` on
  `/api/health` count sessions whose spend is in *no* total. Both fields are **omitted**
  rather than zeroed when the underlying seam is absent — an absent field means "not
  measured", never "none".

### Nothing ever says `completed`

That is the no-hooks state described above, not a bug. Install the hooks, or read the
status column as "observed working, then unobserved".

[Troubleshooting](../operations/troubleshooting.md) goes much deeper — reading
`/api/health` field by field, reading the ingest log, the watchdog pattern, and what
retention is and is not deleting today.

## See also

- [What is agenthropic](what-is-agenthropic.md) — what the tool is and what it refuses
  to do.
- [Getting started](../usage/getting-started.md) — the longer install→configure→verify
  walkthrough, kept with its design-era annotations.
- [Configuration](../usage/configuration.md) — every setting in depth, including storage,
  backups and the signed retention policy.
- [Using the dashboard](../usage/dashboard.md) — the four views and how to read them.
- [Hooks installer](../usage/hooks-installer.md) — the installer in full.
- [Security model](../security/model.md) · [Remote access](../security/remote-access.md)
  — the loopback/token/no-spawner posture and the two tunnel recipes.
- [Troubleshooting](../operations/troubleshooting.md) ·
  [Backup & restore](../operations/backup-restore.md).
- [API reference](../usage/api.md) — the read endpoints behind the views.
