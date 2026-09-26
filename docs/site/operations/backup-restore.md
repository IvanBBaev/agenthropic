# Backup & restore

This page is the operations runbook for agenthropic's single persisted store: why it
runs in **SQLite WAL** mode, how a backup is taken, and — the part every other backup
story skips — how the restore path is actually **exercised**, not just assumed to
work because a file exists somewhere. It also covers the two data-lifecycle
controls that sit next to backup in the source material: a **retention** TTL and
**redaction at the ingest boundary**, so secrets and raw tool payloads never reach
disk in the first place. The key takeaway: a backup nobody has ever restored from is
not a real backup — this is why every gate below is phrased as **tested restore**,
never "backup exists" (`docs/ai/DESIGN.md` §8;
`docs/analysis/concept-analysis-v2.md` §6; `docs/analysis/development-plan.md`
`WP-F8`).

As with [the data model](../architecture/data-model.md), much of what follows was
written as a **decided requirement with an illustrative reference implementation**:
when this page was authored, the literal backup script, its schedule, and the exact
retention/redaction numbers were fixed by no source document, and `WP-F8`, `WP-D10`
and `WP-IN14` were all unmerged. Every command and path below was a placeholder for
the real operational procedure `WP-F8` would ship; §6 tallies precisely what is
decided versus still open. *(As built: `WP-F8` and `WP-IN14` are code, `WP-D10`
runs the v1.0 retention policy signed on 2026-09-08 (D3), and the schedule is an
in-process daily timer rather than the shell-plus-`launchd` shape sketched in §2.)*

> **Update — 2026-07 (as built; revised 2026-09).** Implementation began 2026-07-11
> and all three work packages above have since landed — though not all of them in the
> shape this page sketched.
>
> **Built and running:** WAL + `foreign_keys` asserted on every connection open, with
> a throw if either pragma did not take (`apps/server/src/db/connection.ts`, `WP-D2`);
> backup + restore as code (`apps/server/src/db/backup.ts`, `WP-F8`) — backup via
> better-sqlite3's **online backup API** (in-process, safe under WAL), restore via
> a copy to a staged `<dest>.restoring` file, a check of that file through the same
> pragma-asserting path plus `PRAGMA integrity_check`, and only on `ok` the removal of
> any stale `-wal`/`-shm` sidecars and the swap into place — a failed check leaves the
> destination untouched; the restore path is exercised by
> `apps/server/test/backup.test.ts` on every test run; **a daily backup schedule that
> actually fires** — an in-process, `unref`-ed `setInterval` started by the
> composition root (`scheduleDailyBackups`, `apps/server/src/index.ts`), not the
> `launchd` job sketched in §2; and redaction at the ingest boundary
> (`apps/server/src/hooks/redact.ts`, `WP-IN14`), applied **before** the idempotency
> key is computed, pending the OPEN-3 field-list sign-off.
>
> **Built, and running under a signed policy since 2026-09:** `WP-D10` retention
> (`apps/server/src/retention/`). The v1.0 policy was signed on 2026-09-08 (D3):
> `events` rows older than **90 days** are pruned, `token_usage` is **never** pruned,
> and backup files older than **30 days** expire behind a floor of the **7** newest.
> The runner is chained onto the daily backup timer and runs only after that cycle's
> backup succeeded; boot performs a dry run and logs the counts without deleting — see
> §4, which is the section that matters most for reading this page correctly.
>
> **Not built:** the operator-level release drill (`WP-X9`). The live database default
> is `data/agenthropic.db`, overridable via `DASHBOARD_DB_PATH` (not the
> `AGENTHROPIC_DB_PATH` placeholder this page originally used). The prose below is
> kept as the design record.

## 1. Why WAL mode

`docs/ai/DESIGN.md` §8 states the requirement in five words: **"SQLite
in WAL mode with backups."** `WP-D2` (the SQLite driver adapter) makes this a
connection-time assertion rather than a hopeful default: *"On open, `journal_mode==wal`
& `foreign_keys==ON` asserted"* (development-plan §5, Track D) — every connection the
server opens checks this, it does not merely configure it once and trust it stays set.

Why WAL specifically, given agenthropic's shape: the ingest side (the hook receiver and
the JSONL tail-follower) writes continuously while the read side (the REST/SSE read API
and the realtime hub) reads concurrently for live views — that concurrent
writer-plus-readers shape is exactly what WAL mode exists for. In SQLite's default
rollback-journal mode, a writer blocks all readers for the duration of a transaction;
in WAL mode, readers see a consistent snapshot and are never blocked by an in-progress
write, and a writer is never blocked by a slow reader. This is a structural
precondition for the architecture in [the overview](../architecture/overview.md), not
an optional tuning knob.

One consequence that matters directly for backups (§2): a WAL-mode database is not one
file. Alongside the main `.db` file, SQLite maintains a `-wal` file (recent writes not
yet folded into the main file) and a `-shm` file (shared-memory index over the WAL).
Copying just the main `.db` file while the server is running can silently omit
committed data still sitting in the `-wal` file, or copy a torn, inconsistent
snapshot. **Never `cp` the raw database file as a backup strategy** — the backup
mechanism must go through SQLite's own online-backup path (§2).

## 2. Backup approach

Reference layout as this page first sketched it (placeholders — the real paths were
expected to land with `WP-F1`'s monorepo scaffold and `WP-F8`'s backup routine):

```
/path/to/agenthropic/data/agenthropic.db        # live database (+ .db-wal, .db-shm)
/path/to/agenthropic/backups/                   # backup artifacts land here
/path/to/agenthropic/ops/backup.sh              # the backup script itself
/path/to/agenthropic/logs/backup.{out,err}.log  # launchd job output
```

> **As built:** the first two lines are real; the last two never came to exist. There
> is no `ops/backup.sh` and no `logs/backup.*.log` anywhere in this repository — the
> backup runs *inside* the server process, so its output goes to that process's own
> stdout/stderr, wherever you started it from. The backup directory is not separately
> configurable either: it is derived as `<dirname of the database path>/backups`, so
> the default `data/agenthropic.db` puts artifacts in `data/backups/`, and pointing
> `DASHBOARD_DB_PATH` somewhere else moves the backups along with it. You do not
> create that directory by hand — `backupDatabase` creates it on the first write.

The backup step must use SQLite's **online backup** mechanism, which is safe to run
against a live, being-written-to WAL database — either the `sqlite3` CLI's `.backup`
command (driver-agnostic, shown below) or, once the driver is fixed, the equivalent
call on the storage driver itself (`better-sqlite3` — the leaning driver per
`docs/ai/DESIGN.md` §10, still an open decision — exposes the same
SQLite online-backup API in-process).

> **As built:** the driver decision landed on `better-sqlite3`, and the shipped
> backup (`apps/server/src/db/backup.ts`) takes the in-process branch —
> `db.backup(destPath)` on the live connection — not the `sqlite3` CLI. The shell
> script below is kept as an illustrative operator-side shape and is **not** what
> runs. What runs is described under [Scheduling, as built](#scheduling-as-built).

```bash
#!/usr/bin/env bash
# agenthropic backup script — illustrative reference implementation.
# Not yet built; the real script and its schedule are WP-F8's scope.
set -euo pipefail

DB_PATH="/path/to/agenthropic/data/agenthropic.db"
BACKUP_DIR="/path/to/agenthropic/backups"
TIMESTAMP="$(date -u +%Y%m%dT%H%M%SZ)"
BACKUP_FILE="${BACKUP_DIR}/agenthropic-${TIMESTAMP}.db"

mkdir -p "${BACKUP_DIR}"

# Online backup: safe against a live WAL-mode database. A plain file copy is not.
sqlite3 "${DB_PATH}" ".backup '${BACKUP_FILE}'"

# Fail loudly if the artifact itself is not structurally sound — an unverified
# backup file is worth nothing (see §3, the tested-restore drill).
sqlite3 "${BACKUP_FILE}" "PRAGMA integrity_check;"

# Prune backups older than the retention window (§4) — the shipped default is 30
# days behind a keep-7 floor; this illustrative script has no floor at all.
find "${BACKUP_DIR}" -name 'agenthropic-*.db' -mtime "+<days>" -delete
```

**Scheduling, as first designed.** agenthropic's target host is a Mac Mini M4, and the
design already leaned on `launchd` rather than cron elsewhere — `simple10`'s
`AGENTS_OBSERVE_RUNTIME=local` pattern under `launchd` (no Docker daemon) is named
explicitly as a pattern to steal (`docs/ai/DESIGN.md` §7). A backup job was expected
to fit the same operational model: a `launchd` user agent, not a browser-triggered
endpoint (see the callout below). *(As built: the scheduler moved into the server
process instead — the plist below ships with nothing and is installed by nothing.)*

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.agenthropic.backup</string>
  <key>ProgramArguments</key>
  <array>
    <string>/path/to/agenthropic/ops/backup.sh</string>
  </array>
  <key>StartCalendarInterval</key>
  <dict>
    <key>Hour</key><integer>3</integer>
    <key>Minute</key><integer>0</integer>
  </dict>
  <key>StandardOutPath</key>
  <string>/path/to/agenthropic/logs/backup.out.log</string>
  <key>StandardErrorPath</key>
  <string>/path/to/agenthropic/logs/backup.err.log</string>
</dict>
</plist>
```

> **The schedule (daily at 03:00), the retention window, and even the choice of
> `launchd` over some other scheduler are illustrative, not sourced.** No document
> fixes a backup cadence. What *is* fixed is that a backup exists and its restore
> path is exercised (§3) — the mechanism above is a reference shape for that
> requirement, matching the pattern used for undecided schema/DDL elsewhere on this
> site (see [data model](../architecture/data-model.md)). *(Still true as built: the
> cadence that shipped is a code default, not a ratified number — see below.)*

> **Never a backup/restore HTTP endpoint.** Backup and restore are operator-run or
> timer-run, out-of-band, filesystem-level operations — a scheduled job and a manual
> drill (§3), never an authenticated API route that shells out to `sqlite3` based on a
> request. Building a "restore" button that spawns a subprocess from request input is
> exactly the [`security model`](../security/model.md)'s no-spawner invariant in a
> different costume — the same shape as the `hoangsonww` `/api/run` RCE this project
> deliberately walks away from (`docs/ai/DESIGN.md` §8). Moving the schedule inside
> the server process (below) does not soften this in the slightest: the trigger is a
> clock the process owns, no route reaches it, no request parameter influences it, and
> the server still contains no subprocess surface at all — `pnpm gate:spawner` is the
> first step of CI and fails the build if one appears.

### Scheduling, as built

No `launchd` plist ships in this repository, and nothing installs the one above. The
schedule that actually runs lives **inside the server process**: `scheduleDailyBackups`
(`apps/server/src/index.ts`) is started by the composition root next to the database it
protects, and each tick writes one backup and then — only if that write succeeded —
runs the retention pass under the signed policy (§4): expired `events` rows first,
then old backup files.

| Property | Value | Where it comes from |
| --- | --- | --- |
| Interval | 24 hours | `BACKUP_INTERVAL_MS` (code constant) |
| Backup-file expiry window | 30 days; `0` switches it off | `DASHBOARD_RETENTION_BACKUP_DAYS` (default `DEFAULT_RETENTION_BACKUP_DAYS`) |
| Keep-minimum floor | the 7 newest files, always | `DASHBOARD_RETENTION_BACKUP_KEEP_MIN` (default `DEFAULT_RETENTION_BACKUP_KEEP_MIN`); never below 1 |
| `events` row window | 90 days; `0` switches it off | `DASHBOARD_RETENTION_EVENTS_DAYS` (default `DEFAULT_RETENTION_EVENTS_DAYS`) |
| Destination directory | `<dirname of DASHBOARD_DB_PATH>/backups/` | wired in `start()` |
| Filename | `agenthropic-<ISO timestamp>.db`, e.g. `agenthropic-2026-08-15T03-00-00-000Z.db` (`:` and `.` become `-`) | — |

The three retention numbers are the **signed v1.0 policy (D3, 2026-09-08)**, read from
the environment by `loadConfig` and validated at startup (a non-integer or negative
value is a startup error, not a fallback — see
[Configuration](../usage/configuration.md)); the interval is a code constant. The
keep-minimum floor is what makes a wrong window survivable rather than fatal: however
badly the age window is set, the seven newest backups are never deleted.

Four properties of this scheduler matter before you rely on it:

- **It is a timer, not a boot task.** The first backup is written one full interval
  after start — roughly 24 hours — not at startup. A server restarted daily therefore
  never takes one. If you need a backup *now*, take it out of band; §3's drill works
  against any copy. Boot does run the retention pass in **dry-run** mode and logs what
  it *would* remove, so the first real prune happens after the first backup, never
  before it.
- **The timer is `unref`-ed.** A pending backup never keeps an otherwise-finished
  process alive, and server shutdown calls `stop()` on the scheduler before closing the
  database.
- **A failed run logs and waits for the next tick** rather than crashing the server:
  `database backup failed: <message>` on stderr, **and the retention pass of that
  cycle is skipped**: nothing is ever pruned in a cycle whose backup did not land. The
  trade is deliberate — the server outliving its backup beats the reverse — but it
  means that log line, plus the age of the newest file in the backup directory, is the
  *only* signal that backups have stopped working. Nothing else surfaces it;
  `/api/health` reports neither backup nor retention state.
- **A failed retention pass logs and never crashes.** `retention failed: <message>`
  on stderr; the backup of that cycle is already on disk, and the next tick retries.
- **Overlapping runs are refused, not queued.** The online backup yields between pages,
  so a manual `runOnce()` could otherwise collide with a timer-fired one; a
  re-entrancy flag makes the second call a no-op, so there are never two writers in the
  same directory.

A successful pass logs two lines to stdout — one per step:

```
database backup: wrote <path>.
retention: events: pruned <n> row(s) older than <cutoff>; backup files: expired <n> older than <cutoff> (<k> kept by the floor); receipt <journal path>.
```

The `receipt` suffix appears only when rows were actually deleted (the journal writes
one entry per deleting run, §4); `<n>+` means the per-run row budget was hit and the
next tick continues; a backup directory that does not exist yet reads `backup files:
directory <dir> absent, nothing to expire`; and with both windows set to `0` the line
is `retention: no rule configured, nothing to prune.` The boot dry run logs the same
shape, prefixed with the policy in words:
`retention policy: events: prune after 90 day(s); token_usage: never pruned; backup
files: expire after 30 day(s), always keeping the newest 7. retention dry run (nothing
deleted): events: would prune <n> row(s) older than <cutoff>; ...`.

**Why any of this exists.** Every projected table (`sessions`, `agents`,
`orchestration_edges`, `token_usage`) can be rebuilt by re-reading
`~/.claude/projects/*.jsonl` — that is precisely what replay-on-startup does.
`events_raw` cannot: hook envelopes arrive over HTTP once and are re-derivable from
nothing. Losing the database file loses that table permanently, which is why a backup
capability that nothing ever ran was treated as a defect to fix rather than a
nice-to-have to schedule later.

## 3. The tested-restore drill

This is the part of the requirement that actually matters: `WP-F8`'s done-when is not
"a backup file is written," it is **"WAL asserted; a restore is exercised"**
(development-plan §5, Track F). `concept-analysis-v2.md` §6 states the cadence
directly: *"a backup is taken and a restore is exercised at least once per release
candidate."* Two distinct moments implement this, per the source documents:

1. **Phase 1 — built and proven once.** `WP-F8` lands the backup routine and proves
   the restore path works as part of its own Definition of Done; the Phase 1 exit
   gate lists it alongside the other CI-observable conditions: *"WAL on + backup
   restore exercised"* (development-plan §3, Phase 1).
2. **Every release candidate — re-verified, not assumed to still work.** `WP-X9`'s
   `RELEASE.md` closes out Phase 6 by enumerating *"every CD-7 build-failing gate +
   CD-9 provenance check + **an exercised backup restore**"* (development-plan §3,
   Phase 6) as a release-blocking checklist line item — one that must be re-run, not
   ticked off once and forgotten.

Neither source document specifies whether this restore check is automated in CI, a
scripted job, or a manual runbook step performed by the operator before tagging a
release — that automation detail is open (§6). The drill itself, however, is
concrete enough to write down as a runbook regardless of who or what runs it:

> **As built:** moment 1 shipped stronger than promised — the restore path is not
> proven "once" but on **every test run**: `apps/server/test/backup.test.ts` backs up
> a live database, restores it through `restoreDatabase()` (which checks a staged copy via the
> pragma-asserting `openDatabase` and throws, before touching the destination, unless
> `PRAGMA integrity_check` returns `ok`), and compares content. Moment 2 — the operator-level drill re-run per release
> candidate and recorded in `RELEASE.md` (`WP-X9`) — remains a manual checklist
> obligation; a CI-exercised restore is necessary but not sufficient for it, and this
> page cannot attest it has been performed against real production data.

```
┌────────────────────────────┐
│  agenthropic.db (WAL)      │
│  + agenthropic.db-wal      │
│  + agenthropic.db-shm      │
└──────────────┬─────────────┘
               │  online backup (§2)
               ▼
┌────────────────────────────┐
│ backups/agenthropic-<ts>.db │
└──────────────┬─────────────┘
               │  PRAGMA integrity_check  ──── fail ⇒ backup routine is broken, fix before trusting it
               ▼
┌────────────────────────────┐
│  scratch restore instance   │  ← loopback + mandatory token, same invariants as production
│  DB_PATH=<scratch-copy>     │     (never relax security to make a drill convenient)
└──────────────┬─────────────┘
               │  row-count / checksum compare vs. the live DB at backup time
               ▼
        record the outcome in RELEASE.md (WP-X9)
```

Step by step:

1. **Pick a backup artifact** — the most recent one, or a specific dated one from
   inside the retention window (§4).
2. **Copy it to a scratch path** for the drill. Restoring over the live database is
   the real-recovery case only, and needs the server stopped first (no open handle on
   the file).
   `cp /path/to/agenthropic/data/backups/agenthropic-<ts>.db /path/to/scratch/restore-test.db`
3. **Delete any `-wal`/`-shm` sidecars at the destination first.** In the drill the
   scratch path is usually fresh and has none; in the real recovery case — restoring
   *over* a path that already held a database — this step is the whole difference
   between a restore and a corruption, and `restoreDatabase()` does it for you, after
   the staged copy has passed its check and just before the swap. A leftover `-wal`/`-shm` pair belongs to the database being **replaced**
   (typically left behind by an unclean shutdown, which is exactly the situation you
   are restoring from). SQLite's recovery-on-open would replay those frames *into* the
   restored image, silently mixing two database states in precisely the disaster path
   restores exist for. Note the symmetry with §1: a plain `cp` is wrong on the way out
   because WAL data lives outside the `.db` file, and wrong on the way back in for the
   same reason, from the other direction.
4. **Integrity-check the artifact itself**, independent of anything the backup
   routine already asserted at write time:
   ```sql
   PRAGMA integrity_check;   -- must return exactly "ok"
   ```
   `restoreDatabase()` runs this check on the staged `<dest>.restoring` copy and
   **throws before touching the destination** if the answer is not `ok` — a restore
   that hands back a subtly-broken database would be worse than one that fails. The
   rejected staged copy is kept for inspection.
5. **Boot a scratch instance of the server against the restored file** — a second,
   throwaway process pointed at the copy with `DASHBOARD_DB_PATH=<scratch-copy>` and
   its own `DASHBOARD_PORT`, since the live instance still holds 4317. This scratch
   instance still binds `127.0.0.1` and still fails startup without a token — the
   drill proves the backup restores into a *working, still-secure* server, not into
   a database file that merely opens. Be aware that the scratch instance starts its
   own backup timer and will, if left running for a day, write into
   `<dirname of the scratch copy>/backups`; point it somewhere disposable.
6. **Compare content, not just structure** — row counts (or a checksum) for the
   core projected tables (`sessions`, `agents`, `orchestration_edges`, `token_usage`;
   see [data model](../architecture/data-model.md)) against the live database at the
   moment the backup was taken. A structurally valid but silently truncated backup is
   exactly the failure mode `PRAGMA integrity_check` alone cannot catch. Pay
   particular attention to `events_raw`: it is the one table a replay cannot rebuild,
   so it is the one whose absence a working-looking dashboard would not reveal.
7. **Record the outcome** — date, backup file, and pass/fail — as the `RELEASE.md`
   line item `WP-X9` requires. A restore drill that isn't written down is
   indistinguishable, at the next release, from one that never happened.

## 4. Retention policy

CD-10 in `concept-analysis-v2.md` §3 states the requirement as a Phase-1 boundary
condition, not a later cleanup task: *"retention TTL + payload redaction from Phase
1."* `WP-D10` owns the mechanism: *"Retention TTL sweeper + payload redaction at
ingest. Redaction deterministic; redacted re-ingest byte-identical + idempotent"*
(development-plan §5, Track D). `WP-D10` is scheduled in **Phase 1** alongside the
rest of the storage foundation (development-plan §3, Phase 1 WP list: `WP-D1…D10`).

What is **not** yet decided is the actual policy numbers. `concept-analysis-v2.md` §7
lists this explicitly as an open Phase-0 input, not a fixed value:

> **Policy numbers:** retention window + payload-redaction rule (which fields, at
> ingest or at query), "huge payload" reject-vs-truncate threshold, and the
> coverage-gate scope... (`concept-analysis-v2.md` §7, open question 6.)

Concretely: no source document states a retention window in days, which specific
payload fields the redactor strips, or the size threshold above which a "huge"
payload is rejected outright versus truncated. Any number quoted elsewhere for these
(including the `-mtime "+<days>"` placeholder in the backup script above, which
governs *backup-file* pruning, not row-level TTL) is illustrative, operator-set
scaffolding — not a sourced default.

**An unresolved tension, not invented here, worth restating on this page.**
[The data model](../architecture/data-model.md) already flags it: `WP-D10`'s
retention TTL sweeper implies eventual row removal, but `events_raw` is required to
have **no UPDATE/DELETE path at all**, enforced by triggers and by test
(`concept-analysis-v2.md` §6: *"`events_raw` exposes no UPDATE/DELETE path (enforced
by test)"*). Neither `ai/DESIGN.md` nor `development-plan.md` states how a TTL
sweeper's row removal is reconciled with that append-only guarantee — whether the
sweeper only ever targets the normalized/projected layer, uses an archive-and-
truncate strategy on `events_raw` specifically (which would need to be a documented,
narrowly-scoped exception to the no-delete triggers), or something else. This page
does not invent a resolution; it is tracked as an open issue against `WP-D10`.

> **As built (2026-08, mechanism; 2026-09, policy):** `WP-D10` shipped first as a
> **mechanism with no policy** (`apps/server/src/retention/`), and the row-level runner
> stayed wired into nothing until the policy that tells it what to delete was signed.
> That happened on **2026-09-08 (decision D3)**, and the numbers this section's design
> record calls open are now fixed for v1.0:
>
> | Target | Policy | Environment variable | Default | Off switch |
> |---|---|---|---|---|
> | `events` rows | prune rows older than the window | `DASHBOARD_RETENTION_EVENTS_DAYS` | 90 | `0` |
> | `token_usage` rows | **never pruned** | none — the policy has no input for it | — | — |
> | backup files | expire files older than the window, always keeping the newest `keep-min` | `DASHBOARD_RETENTION_BACKUP_DAYS` / `DASHBOARD_RETENTION_BACKUP_KEEP_MIN` | 30 / 7 | `0` days |
>
> The wiring (`apps/server/src/index.ts`): `start()` builds the policy from
> `loadConfig` with `signedRetentionPolicy`, logs the policy in words together with a
> **dry run** at boot (counts only — boot never deletes), and hands the runner to the
> daily backup timer, which calls it **only after that cycle's backup succeeded**. A
> runner failure is logged as `retention failed: <message>` and never crashes the
> server. Every deleting run still writes its receipt through the append-only journal
> (`<DASHBOARD_DB_PATH>.retention-journal.jsonl`, next to the database), inside the
> delete transaction. The mechanism's own safety shape is unchanged: with both
> windows set to `0` the policy is `NO_RETENTION`, the runner short-circuits before
> opening a transaction, reading a row or touching the filesystem, and behaviour is
> byte-identical to a build without the module. Pruning `events` rows does not shorten
> the startup replay, which reads the JSONL corpus, not the `events` table
> (`docs/measurement/cold-replay-2026-09.md` §6.4).
>
> Two as-built facts narrow the append-only tension rather than resolve it:
> `events_raw` holds **hook envelopes only** (JSONL transcripts are parsed straight
> into the projections and their raw payloads never land in the database at all), so
> the append-only table grows only with redacted hook events; and the no-UPDATE/
> no-DELETE triggers are live and test-enforced. The mechanism does not argue with
> them — `events_raw` is simply not addressable by any rule (see below).

### What the mechanism refuses to do

The retention module is mostly a catalogue of refusals, and reading them is the
fastest way to understand what a future signed policy will and will not be able to do:

- **`RETENTION_PROTECTED_TABLES` is a hard list, not a convention.** `events_raw`,
  `sessions`, `agents`, `orchestration_edges`, `model_pricing` and `schema_version`
  cannot be named by any rule. The append-only tension above is therefore not settled
  by argument but by construction. `agents` is on the list for a second, subtler
  reason: deleting an agent row would fire `parent_agent_id ON DELETE SET NULL` and
  silently re-parent its subtree — retention would quietly rewrite the DAG, which is
  the one artifact the project treats as a data fact.
- **`archive-segments` is declared in the types and deliberately not implemented.**
  It is the audit's recommended OPEN-1 resolution (detach a closed period to an
  archive file, so removal is a file operation and never row DML), so the type system
  gives the decision a home. Configuring it does not silently degrade to a delete or
  to a no-op: it is rejected with an error that says it needs a migration and a
  ratification. A named-but-unbuilt strategy that quietly did something *else* would
  be worse than not having the name.
- **Pruning `token_usage` requires an explicit acknowledgement of cost loss.** Those
  rows are the ground truth behind every dollar the dashboard reports, so deleting
  them permanently lowers the totals for the pruned window. The library policy loader
  refuses the rule unless `DASHBOARD_RETENTION_TOKEN_USAGE_ACK_COST_LOSS` is set, and
  the **signed v1.0 policy never sets it at all**: `signedRetentionPolicy` has no input
  for a `token_usage` window, a test proves the wired policy cannot name that table
  whatever the `events` window is, and `loadConfig` refuses to start if
  `DASHBOARD_RETENTION_TOKEN_USAGE_DAYS` is set. There is no way to prune spend data
  by accident, and under v1.0 no way to prune it at all.
- **A prune that cannot write its receipt does not happen.** A real run appends an
  `fsync`-ed JSONL entry — dollars, tokens and sessions removed — inside the delete
  transaction, immediately before commit, so a failed journal write rolls the deletion
  back. The residual window is a written entry followed by a failed commit, which
  makes the journal claim slightly *more* was deleted than really was. That is the
  safe direction on purpose: the receipt may over-report a prune, never under-report
  it, so reconciling from it can never hide spend.
- **Every run is bounded and reversible-by-inspection.** A run is one transaction with
  a per-table ceiling (`DEFAULT_MAX_ROWS_PER_RUN = 10 000`) that keeps the write lock
  short; a run that fills its budget reports `budgetExhausted` and the next one
  continues from there. `dryRun` performs every measurement, including the dollar
  impact, and deletes nothing.
- **A typo is an error, not a generous guess.** A `DASHBOARD_RETENTION_*` variable
  that is set but unparseable throws at load time rather than falling back to a
  default. A deletion policy is the last place to be forgiving about input.

One honesty note about the mechanism, stated because a future policy change would
otherwise discover it the hard way: **a pruned `token_usage` window could come back.**
`token_usage` is re-derived from the JSONL corpus, and a restart does not re-read
*unchanged* transcripts (the WP-IN10 replay checkpoint is honoured while the session
row exists, and retention never touches that table). So a session that stayed idle
after such a prune would keep its rows gone and its totals permanently lower —
explainable only through the journal receipt — while a session whose transcript
changed later would be re-read in full, which **resurrects** the pruned rows from the
corpus, and the next prune would remove and journal the same dollars again. The
signed v1.0 policy sidesteps this entirely by never pruning `token_usage`; the
`events` rows it does prune are projected from hook envelopes, not from the corpus,
so they do not come back.

### Backup-file retention

Backup-file pruning is the second half of the daily retention pass: the runner applies
the policy's backup-file rule right after the row rule, over the directory the
scheduler writes into, with the window and floor listed under
[Scheduling, as built](#scheduling-as-built). `DASHBOARD_RETENTION_BACKUP_DAYS` and
`DASHBOARD_RETENTION_BACKUP_KEEP_MIN` are the two knobs; `0` days switches the rule
off, and the floor cannot be set below 1. (Before 2026-09 the scheduler called
`pruneBackupFiles` directly with compiled-in constants and none of this was
configurable; that path is gone.)

The filename convention is **normative, not cosmetic**: `pruneBackupFiles` recognizes
candidates with an anchored `^agenthropic-.+\.db$` pattern, whose source comment names
this page as the convention's home. Three consequences follow, and they are the reason
a stray file in the backup directory is safe:

- **Nothing that does not match is ever considered.** A `notes.txt`, a
  `agenthropic-2026-08-15T03-00-00-000Z.db-wal` sidecar, or a hand-made
  `pre-upgrade-copy.db` is invisible to the pruner. If you rename backups to some other
  scheme, they stop being pruned — they do not become unprunable *and* unprotected;
  they simply accumulate.
- **The keep-minimum floor wins over the age window.** Files are ordered newest-first
  and the first `keepMinimum` of them are kept regardless of age. A pass that could
  leave zero backups is a data-loss mechanism, not a retention one, so the floor is
  never below 1 and is 7 in the shipped schedule.
- **A missing directory is reported, never created and never thrown over.** The report
  carries `directoryPresent: false` and the run is a no-op. "There is no backup
  directory" is a fact an operator needs to see, not an error to crash on and not a
  condition to paper over by creating an empty directory that then looks healthy.

The report a run returns (`directory`, `directoryPresent`, `dryRun`, `cutoff`, `found`,
`deleted`, `keptByMinimum`, `bytesReclaimed`) is what the retention log line's
`backup files: expired <n> older than <cutoff> (<k> kept by the floor)` fragment
summarizes. Nothing surfaces it over HTTP.

## 5. Redaction at the ingest boundary — secrets never persisted

The mechanism split follows the development plan's own merge reconciliation
(development-plan §2, merge #3): **`WP-D10` owns the redactor**, and **`WP-IN14`
reduces to invoking that redactor at the ingest write boundary** once the ingest
paths exist in Phase 2 (development-plan §3, Phase 2 WP list includes `IN14`). The
sequencing is deliberate — the mechanism is built in Phase 1 with the rest of
storage, then wired onto the live write path once there is a write path to wire it
onto. The Phase 2 exit gate names the observable result: *"redaction live"*
(development-plan §3, Phase 2).

> **As built:** redaction is live, but the mechanism split landed differently than
> the plan's merge #3 assumed: the redactor shipped **with** the ingest boundary as
> `WP-IN14` (`apps/server/src/hooks/redact.ts`), invoked in the hook receiver
> *before* the idempotency key is computed — so a redelivered event redacts
> identically and still deduplicates, and unredacted material never reaches the
> stored envelope or its hash. `WP-D10` shipped separately as the retention
> mechanism (§4) with its policy numbers still blank, and this redactor's field list
> implements the *recommended* resolution of OPEN-3, pending sign-off — the code says
> so in its own header. The "before the row exists" property below shipped exactly as
> stated.

The load-bearing property, already stated on [the data model](../architecture/data-model.md)
page and worth repeating here because it is the whole point of this page's title:

> Redaction happens at the ingest boundary, **before the row exists** — not as a
> later mutation of an already-written row. That is how payload redaction (CD-10)
> coexists with `events_raw`'s append-only invariant without ever violating it.

Put plainly: nothing enters `events_raw` unredacted and gets cleaned up afterward.
There is no "redact on read" path and no background job that rewrites rows — the
redactor sits in front of the write, not behind it. This matches the due-diligence
finding that motivated it: `simple10` "stores full tool payloads (redact)"
([`due-diligence/projects/simple10.md`](../../due-diligence/projects/simple10.md));
agenthropic's own hardening list is explicit — *"Store redacted tool payloads if
payloads are stored at all"* ([`due-diligence/security.md`](../../due-diligence/security.md)).

**Two distinct "secrets never persisted" mechanisms — do not conflate them.** This
page's redaction (`WP-D10`/`WP-IN14`) is about *event and tool-call payload content*
landing in `events_raw`. A separate mechanism governs *webhook delivery credentials*
(the Telegram bot token, Phase 5): CD-10 requires it held via a `token_ref` resolved
from `launchd` env or a `chmod 600` file, **"never in SQLite, never to the browser"**
(`concept-analysis-v2.md` §3, CD-10), owned by `WP-A3` and enforced by a static gate
rejecting an over-permissioned dotfile. Both mechanisms share the same principle —
raw secret material never reaches the database or the wire — but they are two
different work packages at two different boundaries. See
[security model](../security/model.md) for the token-handling rule and rule 8
(`ANTHROPIC_API_KEY` kept out of the dashboard's own environment entirely).

## 6. What's decided vs. open

| Aspect | Status |
|---|---|
| SQLite runs in WAL mode, pragma-asserted on every connection open | **Decided** (`docs/ai/DESIGN.md` §8; `WP-D2`) |
| A backup exists and its restore path is exercised, not merely assumed to work | **Decided** (`ai/DESIGN.md` §8; `concept-analysis-v2.md` §6; `WP-F8`) |
| Restore is re-verified at least once per release candidate, tracked in `RELEASE.md` | **Decided** (`concept-analysis-v2.md` §6; `WP-X9`) |
| A retention TTL and payload redaction exist, live from Phase 1 | **Decided at the requirement level** (CD-10; `WP-D10`) — *as built: redaction is live; retention runs the signed v1.0 policy after every successful daily backup (§4)* |
| Redaction runs at the ingest write boundary, before the row exists | **Decided** (`WP-D10` owns the redactor; `WP-IN14` invokes it; development-plan §2 merge #3) |
| Retention window (days) | **Signed** — D3, 2026-09-08: `events` 90 days, `token_usage` never, backup files 30 days behind a keep-7 floor (§4) |
| Exact redacted field list, "huge payload" reject-vs-truncate threshold | **Open** — named Phase-0 policy inputs, not fixed as numbers (`concept-analysis-v2.md` §7, open question 6) |
| How the TTL sweeper's row removal reconciles with `events_raw`'s no-UPDATE/DELETE trigger enforcement | **Open tension**, flagged on [data model](../architecture/data-model.md), not resolved in any source document |
| Literal backup tool, script, and schedule (this page's `sqlite3 .backup` + `launchd` shape) | **Superseded** — the illustrative shape was never built; the real mechanism is the in-process online backup plus the in-process daily timer described under [Scheduling, as built](#scheduling-as-built) |
| Whether the exercised-restore drill runs in CI, a scheduled job, or a manual runbook step | **Open** — `WP-F8` proves it once in Phase 1; `WP-X9` requires it again per release; the automation detail is unspecified |
| Webhook credential handling (`token_ref`, distinct from payload redaction) | **Decided**, different mechanism, different WP (`WP-A3`, CD-10) — see §5 |

> **As-built delta to this table (2026-07; revised 2026-09):** rows 1-2 are now
> **built and test-proven** (pragma assertion in `connection.ts`; backup/restore in
> `backup.ts`, with the restore — including the stale `-wal` / `-shm` removal —
> exercised on every test run). Row 3 (`WP-X9` per-release re-run) is an obligation
> that has not yet had a release to bind to. Row 4 is **built on both halves**:
> redaction is live, and retention runs the signed v1.0 policy after each successful
> daily backup (§4). Row 5 is **built** with the OPEN-3 field list pending sign-off.
> Row 6 is **signed** (D3, 2026-09-08) and wired; row 7 (the field list and the
> huge-payload threshold) stays **open**, as does row 8's append-only tension, which
> the code still refuses to resolve by fiat: `events_raw` cannot be named by any rule,
> and the signed policy prunes only the `events` projection. Row 9's real mechanism is the
> in-process better-sqlite3 online backup driven by an in-process daily timer, not a
> CLI script under `launchd`. Row 10 is now partially answered: a restore runs in the
> test suite automatically; the release-time drill remains manual. Row 11's `WP-A3` is
> not built (alerts are post-1.0).

## 7. Roadmap positioning

| Phase | WP | Lands |
|---|---|---|
| 1 — Foundation, security spine, storage | `WP-D2` | WAL + foreign-key pragma asserted on every connection open |
| 1 — Foundation, security spine, storage | `WP-F8` | Backup + tested-restore routine built; restore exercised once as Phase-1 proof |
| 1 — Foundation, security spine, storage | `WP-D10` | Storage-lifecycle redactor (live) + retention sweeper (live under the signed v1.0 policy, chained onto the daily backup — §4) |
| 2 — Ingest substrate | `WP-IN14` | Redaction invoked at the ingest write boundary; "redaction live" is the Phase 2 exit-gate wording |
| 6 — Operator alerts + release hardening | `WP-X9` | `RELEASE.md` requires an exercised backup restore as a release-blocking checklist line, every release candidate |

(development-plan §3, §5.) See the [roadmap](../guide/roadmap.md) for how this fits
alongside the rest of each phase.

## Current state

This page was written **pre-Phase-0**, when none of `WP-F8`, `WP-D10`, or `WP-IN14`
existed. Implementation began 2026-07-11 (explicit owner override of CD-8, after the
Phase-0 spike's CONDITIONAL GO). As built today:

- **`WP-D2` and `WP-F8` are code** (`apps/server/src/db/connection.ts`,
  `apps/server/src/db/backup.ts`), with the restore path — stale-sidecar removal
  included — exercised on every test run.
- **The backup schedule runs.** It is an in-process daily timer inside the server,
  not a `launchd` job; see [Scheduling, as built](#scheduling-as-built). The interval
  (24 h) is a code constant; the expiry numbers (30 days, keep 7) are the signed v1.0
  policy, configurable through `DASHBOARD_RETENTION_BACKUP_DAYS` and
  `DASHBOARD_RETENTION_BACKUP_KEEP_MIN`.
- **`WP-IN14` redaction is live** at the hook-ingest boundary, before the
  idempotency key, pending the OPEN-3 sign-off.
- **`WP-D10` is live.** The retention runner runs after every successful daily
  backup under the policy signed on 2026-09-08 (D3): `events` rows older than 90 days
  are pruned, `token_usage` is never pruned, backup files expire at 30 days behind a
  keep-7 floor (§4). Boot logs a dry run; every deleting run writes a journal receipt.
- **`WP-X9` has not run**, because there has been no release candidate to run it
  against.

The illustrative script and the `launchd` plist above remain reference shapes — read
them as the design's first sketch, not as shipped operational procedure.

## See also

- [Security model](../security/model.md) — rule 9 (WAL + tested restore) and rule 8
  (`ANTHROPIC_API_KEY` isolation) in the full nine-rule security invariant set; the
  no-spawner rule this page's "never a restore HTTP endpoint" callout restates.
- [Data model](../architecture/data-model.md) — the `events_raw` append-only DDL and
  the retention-vs-no-delete tension this page restates rather than resolves.
- [Ingest & reconciliation](../architecture/ingest-reconciliation.md) — replay-on-startup
  and the durable JSONL offset mechanism that make the projected tables reconstructible
  independent of any backup.
- [Threat model](../security/threat-model.md) — why `simple10` storing full tool
  payloads unredacted is the anti-pattern this page's §5 exists to avoid.
- [Troubleshooting](troubleshooting.md) — the missing-`Stop` watchdog and other
  operational failure modes, adjacent to but distinct from backup/restore.
- [Testing & quality](../contributing/testing.md) — the golden fixture corpus and
  coverage gate that `WP-F8`'s own tests run under.
- [Decisions (ADRs)](../contributing/decisions/_adr-template.md) —
  [`adr-cd-7-security-and-coverage-boundary.md`](../contributing/decisions/adr-cd-7-security-and-coverage-boundary.md)
  and
  [`adr-cd-10-scope-secrets-retention.md`](../contributing/decisions/adr-cd-10-scope-secrets-retention.md)
  are the filed ADRs for the security/backup boundary and retention/redaction
  decisions this page implements.
- [Roadmap](../guide/roadmap.md) — where `WP-F8`, `WP-D10`, `WP-IN14`, and `WP-X9`
  each land in the overall build sequence.
