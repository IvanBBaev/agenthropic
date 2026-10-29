# agenthropic — Day-2 Operations Review (SRE lens), 2026-10-29

> Part of the [role reviews of 2026-10-29](README.md) — lens: **Senior SRE / Platform Engineer (OPS)**. Independent senior reviewer, read-only, on `main` at `db3f042`. Findings are de-duplicated and scheduled in [10-synthesis.md](10-synthesis.md).

## 1. Verdict

The data-integrity core is unusually well engineered for a hobby-scale service. WAL is asserted on every open, migrations are checksummed, and their checksums are pinned in CI for both the vitest and the tsx executors. Backups use the online backup API, and restore stages the copy and runs `integrity_check` before it swaps anything. The docs are honest about their own gaps. What is missing is the operational layer:
- no process supervision of any kind;
- no signal handling;
- `/api/health` says `ok` regardless of what has failed;
- request and error logging is off and cannot be turned on;
- backups are only written after 24 h of continuous uptime, and they are written non-atomically;
- nothing models storage growth.

The server is not running on the machine today (nothing listens on :4317, there is no LaunchAgent, and the only DB is a stale 94 KB `data/agenthropic.db` from 13 July). So the "runs continuously on the Mac Mini" claim has never been tested in operation. The real corpus has also grown about 3.5× since the last measurement (5.6 GiB and 349 sessions today, against 1.6 GiB and 60 sessions on 2026-09-09). **Operational readiness for v1.0: 4/10.** The software is ready; running it as a service is not.

## 2. What is strong (evidence)

- **WAL and foreign keys are asserted, not hoped for.** The handle is closed on failure (`apps/server/src/db/connection.ts:19-53`).
- **Online backup, not a file copy.** `db.backup()` is used (`apps/server/src/db/backup.ts:14-17`). Restore stages to `.restoring`, re-asserts the pragmas, runs `integrity_check`, deletes the stale `-wal`/`-shm` so frames are not replayed into the restored image, and then renames (`backup.ts:34-59`).
- **Retention order is safe.** Pruning runs only after a backup succeeded. Boot runs only a dry run. There is a keep-7 floor, and symlinks are skipped (`index.ts:715-750`, `backup-restore.md` "Scheduling, as built").
- **The migration guard is real.** Edited migrations fail loudly (`migrations.ts:1947-1975`). The operator (tsx) checksums are pinned in CI by spawning tsx (`apps/server/test/migrations-checksum-stability.test.ts:203-262`), so a tsx/esbuild bump breaks CI rather than user databases.
- **Startup replay is chunked.** Passes are capped at 25 sessions with `setImmediate` yields between them. Replay checkpoints let a warm restart re-read only changed sessions. `/api/health` reports `replaying` (`index.ts:288-317`, `corpus-watcher.ts:153`).
- **SSE cannot exhaust memory.** Per-client backlog is capped at 1 MiB and slow readers are dropped (`server.ts:150-162`). Heartbeat is 15 s and there is a 256-frame replay ring (`hub.ts:47`). SSE is in memory and holds no DB read transactions, so **there is no WAL-checkpoint starvation from long SSE readers**. There is a single connection, so auto-checkpoint always succeeds.
- **Torn trailing JSONL lines are tolerated.** The tail cache cuts at the last newline (`tail-cache.ts:17,119`).
- **Skip logging is rate-limited** to one line per 5 min per key (`index.ts:538-600`). Tick-trouble logging is edge-triggered (`index.ts:392-441`).
- **Node 22 is pinned in several places:** `.nvmrc`, `engines >=22 <23` with `engine-strict=true`, and a `check-node-version.mjs` guard before `start`, `test` and `bench`.
- **Hooks fail open.** They use `curl --max-time 3 … || true`, `async: true` and `--noproxy '*'` (`hooks/install.mjs:293`).
- **The docs are candid.** For example, `running.md` "Stopping it" documents that pnpm does not forward SIGTERM, and `backup-restore.md` documents that the first backup only comes after 24 h.

## 3. Findings

| ID | Sev | Finding | Evidence | Recommendation | Effort | Verdict |
|---|---|---|---|---|---|---|
| OPS-1 | P1 | **No process supervision.** No launchd plist ships or is installed. Nothing restarts the server after a crash, a `process.exit(1)` from a containment violation, or a reboot. It is not running today. | `backup-restore.md` §2 "No `launchd` plist ships"; `ls ~/Library/LaunchAgents` shows none; no listener on :4317 | Ship `ops/com.agenthropic.server.plist`:<br>• `RunAtLoad` + `KeepAlive{SuccessfulExit=false}`, `ThrottleInterval 30`;<br>• absolute Node 22 path calling `tsx` directly (not pnpm);<br>• `WorkingDirectory=apps/server`, `StandardOut/ErrorPath`;<br>• `ProcessType=Background` / `Nice`.<br>Add install/uninstall steps to `running.md`. | M | CONFIRMED |
| OPS-2 | P1 | **No SIGTERM/SIGINT handler.** `close()` exists but nothing calls it on a signal. Shutdown (launchd stop, logout, reboot) kills mid-transaction and mid-backup. The DB is not checkpointed and the `-wal` is left behind. SQLite stays consistent, but an in-flight backup is torn (OPS-3). | grep for `SIGTERM` in `apps/server/src` finds nothing; `index.ts:1062-1068` | Add `process.once('SIGTERM'/'SIGINT')` → `close()`, with a hard 10 s exit fallback. Run `wal_checkpoint(TRUNCATE)` before `db.close()`. | S | CONFIRMED |
| OPS-3 | P1 | **Backups are written directly to their final name and never verified.** A crash, kill or ENOSPC mid-backup leaves a partial `agenthropic-<ts>.db`. Retention counts it toward the keep-7 floor and treats it as a valid generation. Restore would find the damage only at disaster time. | `backup.ts:14-17`; `index.ts:731-733` | Write to `<name>.partial`, open it read-only and run `PRAGMA quick_check`, then `rename`. Retention should ignore `*.partial`. | S | CONFIRMED |
| OPS-4 | P1 | **The first backup is written only after 24 h of continuous uptime.** A server restarted more often than daily never backs up. `events_raw` (hook envelopes) cannot be re-derived from anything else. | `index.ts:745-748` (only `setInterval`); `backup-restore.md` "It is a timer, not a boot task" | Run `runOnce()` at boot when the newest backup is older than the interval (judged by file mtime). Back up before any pending migration (see OPS-9). | S | CONFIRMED |
| OPS-5 | P1 | **Health is `ok` forever.** It does not reflect a corpus read-error, a stopped watcher, a failing backup, DB write failures, or tick staleness. It reports `lastTickDurationMs` but no `lastTickAt`. The docs admit "`/api/health` reports neither backup nor retention state". | `server.ts:302-327`; `packages/shared/src/schemas/health.ts:15-45` | Add `lastTickAt`, `lastSuccessfulTickAt`, `tickTrouble`, `lastBackupAt`/`lastBackupError`, `dbBytes`/`walBytes`/`freeDiskBytes`, and a `degraded` status. Keep `status` backward-compatible, or add `/api/health/ready`. | M | CONFIRMED |
| OPS-6 | P1 | **Logging is off and cannot be enabled.** `buildServer` is called without `logger`, so `logger:false`. Every 5xx error goes to a no-op sink (`request.log.error`). There is no env switch, no log levels, and no rotation story for stdout under launchd. | `server.ts:186-191,246,262-268`; `index.ts:956-984` (no `logger` passed) | Add `DASHBOARD_LOG_LEVEL` (default `warn`, with the redacting serializer already in place). Document `newsyslog.d` rotation for the launchd log paths. | S | CONFIRMED |
| OPS-7 | P1 | **Unmodelled storage growth.**<br>• No VACUUM, `auto_vacuum` or `incremental_vacuum`, so the file never shrinks after pruning `events`.<br>• `token_usage` and `events_raw` are never pruned.<br>• The DB is 38.5 % of the corpus bytes (634 MiB DB for a 1.6 GiB corpus).<br>• The corpus is now 5.6 GiB, so a DB around 2 GiB is likely.<br>• Backup retention of 30 days means up to about 30 full copies (~60 GiB) on the same disk. | `cold-replay-2026-09.md` §4 (DB 633.7 MiB); `config.ts` defaults 30/7; grep for VACUUM finds nothing; `du ~/.claude/projects` = 5.6G | Measure the real DB size. Add a size and growth line to the boot log and to health. Consider weekly backups past 7 days (GFS rotation) or zstd-compressed backups. Add a monthly `VACUUM INTO` (which also yields a compacted backup). | M | PLAUSIBLE (projection) |
| OPS-8 | P1 | **The replay cost claim no longer holds at real shape.** The cap comment says a 25-session pass "stays well under the 3 s poll". Measured real shape is 1.34–1.51 s per session, so one pass blocks the event loop for about 33–38 s. That is longer at load average 60–145; load was 78 during this review.<br>A cold rebuild of 349 real sessions is about 8 min or more. While a pass blocks, the hook `curl --max-time 3` calls time out, so the only non-re-derivable data (`events_raw`) is lost exactly during replay. | `corpus-watcher.ts:141-153`; `cold-replay-2026-09.md` §4.2; `hooks/install.mjs:293` | Make the cap byte-budgeted (e.g. ≤ 64 MiB parsed per pass) instead of session-counted. Re-run the bench at the current shape. Consider a `worker_thread` for parsing. | M | CONFIRMED (math), PLAUSIBLE (hook loss) |
| OPS-9 | P1 | **There is no downgrade guard and no pre-migration backup.** An older build on a newer DB silently skips unknown `schema_version` rows and runs against the newer schema. A failed upgrade can only be rolled back by a manual restore, and no backup is taken automatically before migrating. | `migrations.ts:1955-1959`; `index.ts:928` | Refuse to boot when `max(schema_version.id)` exceeds the newest known migration. Before running pending migrations, write `backups/pre-migrate-v<N>-<ts>.db`. Add an UPGRADING section: stop → `git pull` → `pnpm install --frozen-lockfile` under Node 22 → start, plus "first boot after 1.0 re-reads the corpus" (CHANGELOG: checkpoint revision 2). | S | CONFIRMED |
| OPS-10 | P1 | **The RELEASE §5 "live drill" targets the wrong DB, and it is not a restore.**<br>• The drill defaults to `data/agenthropic.db` (repo root, stale, 94 KB). The server's default DB is `apps/server/data/agenthropic.db` (cwd-relative under `pnpm start`).<br>• The "verified 2026-07-29" run was against the stale file.<br>• The drill never exercises `restoreDatabase` (swap, sidecar deletion) and compares no content. | `RELEASE.md:265-296`; `config.ts` `DEFAULT_DB_PATH='data/agenthropic.db'`; `running.md` env table; `ls data/` | Make the DB path absolute or anchored to the repo, and log it at boot. Have the drill call `restoreDatabase` into a scratch path and compare row counts across `sessions`, `agents`, `token_usage` and `events_raw`. | S | CONFIRMED |
| OPS-11 | P1 | **Claude Code's transcript cleanup is not modelled.** Top-level transcripts on disk date only from 2026-09/10 (349 files), although the corpus held 2026-07 data earlier. That is consistent with Claude Code's `cleanupPeriodDays` (default 30). Consequences:<br>• "Projected tables are rebuildable from JSONL" (backup-restore §2) is false for older data.<br>• Losing the DB loses all history older than 30 days, not just `events_raw`.<br>• `cleanupPeriodDays` is mentioned nowhere in the repo. | `find ~/.claude/projects` mtime histogram; grep for `cleanupPeriodDays` finds nothing | Document it and recommend raising `cleanupPeriodDays`. Re-tier the backups as the system of record for older data. Confirm that a vanished transcript never deletes DB rows. | S | PLAUSIBLE |
| OPS-12 | P2 | **The runtime depends on dev tooling.** `start` needs `tsx` (a devDependency) and pnpm. `pnpm install --prod` breaks start. Under launchd, `PATH` lacks both node and pnpm. An `nvm` default of Node 26 plus `pnpm install` rebuilds `better-sqlite3` for the wrong ABI. | `apps/server/package.json` "//" + scripts; MEMORY note "shell defaults to 26" | In the plist, call `/abs/node22 node_modules/.bin/tsx src/index.ts` directly. Document the `pnpm rebuild better-sqlite3` recovery. | S | CONFIRMED |
| OPS-13 | P2 | **Infrastructure errors are treated as content errors.** A DB error (SQLITE_FULL/IOERR/BUSY) inside a session's ingest becomes `ok:false` and counts toward `MAX_INGEST_ATTEMPTS=3`, so a disk-full window quarantines healthy sessions. They are re-read only "on a change, at most every 32 passes"; idle sessions stay excluded. | `ingest-session.ts:145-149`; `corpus-watcher.ts:124,138` | Detect `SqliteError` codes. Stop the tick with a global `db-unavailable` trouble state and do not quarantine. Surface it in health. | M | PLAUSIBLE |
| OPS-14 | P2 | **Corrupted JSONL handling is all-or-nothing per session.** One invalid mid-file line fails the whole session, so every dollar of that session is excluded. This is visible in health counts but not in totals. | `packages/core/src/parser/parse-session.ts:168-182` | Keep fail-closed, but show excluded sessions with a cost "gap" banner in the UI. Add a runbook entry. | S | CONFIRMED |
| OPS-15 | P2 | **Transcripts over 64 MiB are skipped** (`DEFAULT_MAX_FILE_BYTES`). The largest real main transcript was 56.2 MB in September and is growing, so the long sessions that matter most will silently fall out of totals. | `corpus/fs-port.ts:206` | Raise the limit or make it configurable. Alert when a skip is `oversize`. | S | PLAUSIBLE |
| OPS-16 | P2 | **The incremental tick is O(session).** An append to an active long session costs about 200–235 ms of loop time per tick (it re-parses the whole session). With several active sessions on a 3 s poll at high load, ticks can approach the poll interval. | `cold-replay-2026-09.md` §4.2 (incremental tick) | Track `lastTickDurationMs / pollIntervalMs` and back off adaptively. Consider true incremental parsing post-1.0. | L | PLAUSIBLE |
| OPS-17 | P2 | **Backups live on the same disk.** There is no off-host copy and no backup-age signal outside the log. | `index.ts:929` | Add an optional `DASHBOARD_BACKUP_MIRROR_DIR` (Time Machine / NAS). Expose newest-backup age in health. | S | CONFIRMED |
| OPS-18 | P2 | **Secrets in a launchd plist.** The docs present "launchd env" as the preferred home for `DASHBOARD_TOKEN` and the Telegram token. Plists in `~/Library/LaunchAgents` are usually 0644 and get backed up and copied around. | `configuration.md:172-192` | Use a `chmod 600` env file sourced by a wrapper, or Keychain (`security find-generic-password`). Document a `chmod 600` plist at minimum. | S | CONFIRMED (doc), PLAUSIBLE (perm) |
| OPS-19 | P3 | **No `busy_timeout`.** Harmless with one connection, but an operator running `sqlite3 … .backup` or the RELEASE drill concurrently can make server writes fail immediately with SQLITE_BUSY. | `connection.ts:22-24` | `db.pragma('busy_timeout = 5000')`. | S | PLAUSIBLE |
| OPS-20 | P3 | **No self-observability.** There are no event-loop-lag, RSS, DB/WAL size or SSE-client metrics. Peak RSS measured 487–583 MiB at the old corpus size, against a 128 MiB tail-cache cap plus the parse working set. | `cold-replay-2026-09.md`; `tail-cache.ts:33` | Add `process.memoryUsage().rss`, `monitorEventLoopDelay` p99, and SSE client count to health. | S | CONFIRMED |
| OPS-21 | P3 | **Clock skew and sleep.** The watchdog compares wall clock to transcript timestamps. After Mac sleep or an NTP step, every `working` agent can flip to `unknown` at once. A late hook or JSONL final reverts it, so the effect is cosmetic. Backup retention uses mtime, so it is skew-safe. | `ingest/watchdog.ts:47-59` | Document it. Optionally suppress one sweep after a detected time jump (wall clock vs. monotonic delta). | S | PLAUSIBLE |
| OPS-22 | P3 | **Docs disagree with code on retention defaults.** The brief and older docs say NO_RETENTION, but the code runs signed D3 defaults: events 90 d, backups 30 d / keep 7. | `config.ts` defaults; `running.md` env table | Single-source the statement. | S | CONFIRMED |

## 4. Failure modes

| Failure | Current behaviour | Desired behaviour |
|---|---|---|
| Process crash / uncaught exception | Process dies and stays dead | launchd `KeepAlive` restarts it with throttling; crash count visible |
| Reboot / logout | Server not started | `RunAtLoad` LaunchAgent (or LaunchDaemon if it must run headless) |
| SIGTERM (launchd stop) | Immediate kill; `-wal` left behind; possible torn backup | Graceful `close()` → checkpoint → exit 0 within 10 s |
| Kill or ENOSPC during backup | Partial file kept under a valid name; counts toward keep-7 | `.partial` + `quick_check` + rename; partial ignored and deleted |
| Disk full during ingest | Sessions fail and get quarantined; health `ok` | Global `db-unavailable` state, no quarantine, health `degraded`, log once |
| Corpus unreadable (permissions/unmount) | Logged once (edge-triggered); health `ok` | Health `degraded` with `tickTrouble` and `lastSuccessfulTickAt` |
| One corrupt JSONL line | Whole session excluded; counted in health | Same, plus a UI gap banner and a runbook |
| Transcript over 64 MiB | File skipped, logged every 5 min | Configurable limit; alertable |
| Claude Code deletes transcripts older than 30 days | DB is the only copy; not documented | Documented; backups treated as the system of record; off-host mirror |
| Cold start on a fresh/restored DB at load 100 | ~8+ min of replay in 30+ s blocking chunks; hooks time out | Byte-budgeted passes and/or a parser worker; hooks not dropped |
| Upgrade with a new migration fails midway | Migration transaction rolls back and the server exits; no automatic backup | Pre-migration backup plus an UPGRADING runbook |
| Downgrade to an older build | Runs silently against a newer schema | Refuses to boot with a clear message |
| tsx/esbuild version drift | CI pin catches it; at runtime, boot fails on a checksum mismatch | Same; add a recovery note in troubleshooting |
| 5xx in an API route | Client gets a generic 500; no log anywhere | Logged at `error` with redaction |
| Mac sleep / clock step | Mass `working`→`unknown`, self-heals | Documented; optional one-sweep suppression |
| `tailscale funnel` misuse | Docs forbid it; bearer token still gates the API, but the SPA shell and token-guessing are exposed to the internet | Keep the docs; optionally refuse requests whose `Host` is not loopback or on an allowlist |

## 5. Recommendations by roadmap

**Before the v1.0 tag (≤ 2026-12-01).** All are S/M effort, about 2–3 agent-days in total:
1. Graceful shutdown (OPS-2).
2. Atomic, verified backups (OPS-3).
3. Backup at boot and before migration (OPS-4, OPS-9).
4. Downgrade guard (OPS-9).
5. `DASHBOARD_LOG_LEVEL` (OPS-6).
6. Health fields: `lastSuccessfulTickAt`, `tickTrouble`, `lastBackupAt`, `dbBytes`, `degraded` (OPS-5).
7. A shipped LaunchAgent plist with an install runbook, absolute Node 22 and direct tsx (OPS-1, OPS-12).
8. Fix the RELEASE §5 drill path and make it a real restore with content compare (OPS-10).
9. Re-measure cold replay and DB size on today's 5.6 GiB corpus (OPS-7, OPS-8).
10. Document `cleanupPeriodDays` (OPS-11).
11. `busy_timeout` (OPS-19).

**v1.x:**
- Byte-budgeted replay passes or a parser worker (OPS-8).
- SqliteError classification (OPS-13).
- Configurable oversize limit (OPS-15).
- GFS / compressed backups, monthly `VACUUM INTO`, off-host mirror (OPS-7, OPS-17).
- Self-metrics (OPS-20).
- Secrets in a 0600 env file or Keychain (OPS-18).
- `newsyslog` rotation.

**v2.0** (alerting is already built and ships dark):
- Route "backup stale", "health degraded" and "tick > poll interval" through the existing Telegram sink. This makes the observer observe itself.
- True incremental parsing (OPS-16).

**Never:**
- Public exposure or Funnel.
- A non-loopback bind.
- A browser-triggered restart/restore endpoint. Restart stays launchd's job and restore stays an offline CLI action.

## 6. Questions for the owner

1. Where is the real production DB? None exists at `apps/server/data/`, and `data/agenthropic.db` is from 13 July. Has the dashboard ever run continuously? KC-5 ("14 days of daily use") depends on this.
2. Should it start at login (LaunchAgent) or at boot without a login session (LaunchDaemon, which also needs access to `~/.claude/projects`)?
3. Do you want to raise Claude Code's `cleanupPeriodDays` so the JSONL corpus stays a rebuild source? Or do you accept that the agenthropic DB plus its backups are the only long-term history?
4. Backup budget: is ~30 full daily copies on the internal SSD acceptable, or should it be GFS (7 daily + 4 weekly) and/or mirrored to an external disk or NAS?
5. Is losing hook events during a cold replay acceptable, since `events_raw` is supplementary? Or should hook ingest be protected (a parser worker or a larger curl timeout)?
6. Is a `degraded` health status acceptable to the SPA and token screen, given the 2026-10-01 decision that `status` is only `ok` or `replaying`?
7. Where should the dashboard and Telegram tokens live: launchd env, a `chmod 600` env file, or Keychain?
