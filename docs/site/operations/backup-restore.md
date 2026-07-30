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

As with [the data model](../architecture/data-model.md), some of what follows is a
**decided requirement with an illustrative reference implementation** — the literal
backup script, its schedule, and the exact retention/redaction numbers are not fixed
by any source document and are not yet built (`WP-F8`, `WP-D10`, `WP-IN14` are all
unmerged). Every command and path below is a placeholder for the real operational
procedure `WP-F8` will ship; §6 tallies precisely what is decided versus still open.

> **Update — 2026-07 (as built).** Implementation began 2026-07-11 and two of the
> three work packages above are now merged. **Built:** WAL + `foreign_keys` asserted
> on every connection open, with a throw if either pragma did not take
> (`apps/server/src/db/connection.ts`, `WP-D2`); backup + restore as code
> (`apps/server/src/db/backup.ts`, `WP-F8`) — backup via better-sqlite3's **online
> backup API** (in-process, safe under WAL), restore via copy + reopen through the
> same pragma-asserting path + a hard refusal to return a database that fails
> `PRAGMA integrity_check`; the restore path is exercised by
> `apps/server/test/backup.test.ts` on every test run; and redaction at the ingest
> boundary (`apps/server/src/hooks/redact.ts`, `WP-IN14`) — applied **before** the
> idempotency key is computed, pending the OPEN-3 field-list sign-off. **Not built:**
> the `WP-D10` retention-TTL sweeper, the scheduled (`launchd`) backup job, and the
> operator-level release drill (`WP-X9`) — those sections below remain the target
> procedure. The live database default is `data/agenthropic.db`, overridable via
> `DASHBOARD_DB_PATH` (not the `AGENTHROPIC_DB_PATH` placeholder used below).

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

Reference layout used throughout this page (placeholders — the real paths land with
`WP-F1`'s monorepo scaffold and `WP-F8`'s backup routine):

```
/path/to/agenthropic/data/agenthropic.db        # live database (+ .db-wal, .db-shm)
/path/to/agenthropic/backups/                   # backup artifacts land here
/path/to/agenthropic/ops/backup.sh              # the backup script itself
/path/to/agenthropic/logs/backup.{out,err}.log  # launchd job output
```

The backup step must use SQLite's **online backup** mechanism, which is safe to run
against a live, being-written-to WAL database — either the `sqlite3` CLI's `.backup`
command (driver-agnostic, shown below) or, once the driver is fixed, the equivalent
call on the storage driver itself (`better-sqlite3` — the leaning driver per
`docs/ai/DESIGN.md` §10, still an open decision — exposes the same
SQLite online-backup API in-process).

> **As built:** the driver decision landed on `better-sqlite3`, and the shipped
> backup (`apps/server/src/db/backup.ts`) takes the in-process branch —
> `db.backup(destPath)` on the live connection — not the `sqlite3` CLI. The shell
> script below remains an illustrative operator-side shape; the scheduled `launchd`
> job has not been set up.

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

# Prune backups older than the retention window (§4) — <days> is an operator-set
# value; no default is fixed by any source document yet.
find "${BACKUP_DIR}" -name 'agenthropic-*.db' -mtime "+<days>" -delete
```

**Scheduling.** agenthropic's target host is a Mac Mini M4, and the design already
leans on `launchd` rather than cron elsewhere — `simple10`'s
`AGENTS_OBSERVE_RUNTIME=local` pattern under `launchd` (no Docker daemon) is named
explicitly as a pattern to steal (`docs/ai/DESIGN.md` §7). A backup
job fits the same operational model: a `launchd` user agent, not a browser-triggered
endpoint (see the callout below).

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
> site (see [data model](../architecture/data-model.md)).

> **Never a backup/restore HTTP endpoint.** Backup and restore are operator-run,
> out-of-band, filesystem-level operations — a `launchd` job and a manual drill (§3),
> never an authenticated API route that shells out to `sqlite3` based on a request.
> Building a "restore" button that spawns a subprocess from request input is exactly
> the [`security model`](../security/model.md)'s no-spawner invariant in a different
> costume — the same shape as the `hoangsonww` `/api/run` RCE this project
> deliberately walks away from (`docs/ai/DESIGN.md` §8).

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
> a live database, restores it through `restoreDatabase()` (which reopens via the
> pragma-asserting `openDatabase` and throws unless `PRAGMA integrity_check` returns
> `ok`), and compares content. Moment 2 — the operator-level drill re-run per release
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
2. **Copy it to a scratch path**, never restore in place over the live database.
   `cp /path/to/agenthropic/backups/agenthropic-<ts>.db /path/to/scratch/restore-test.db`
3. **Integrity-check the artifact itself**, independent of anything the backup
   script already asserted at write time:
   ```sql
   PRAGMA integrity_check;   -- must return exactly "ok"
   ```
4. **Boot a scratch instance of the server against the restored file** — a second,
   throwaway process pointed at `restore-test.db` via whatever config surface the
   server exposes (placeholder: `AGENTHROPIC_DB_PATH=<scratch-copy>`). This scratch
   instance still binds `127.0.0.1` and still fails startup without a token — the
   drill proves the backup restores into a *working, still-secure* server, not into
   a database file that merely opens.
5. **Compare content, not just structure** — row counts (or a checksum) for the
   core projected tables (`sessions`, `agents`, `orchestration_edges`, `token_usage`;
   see [data model](../architecture/data-model.md)) against the live database at the
   moment the backup was taken. A structurally valid but silently truncated backup is
   exactly the failure mode `PRAGMA integrity_check` alone cannot catch.
6. **Record the outcome** — date, backup file, and pass/fail — as the `RELEASE.md`
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
(including a `RETENTION_DAYS=<days>` placeholder in the backup script above, which
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

> **As built:** `WP-D10` is **not built** — there is no TTL sweeper, so the tension
> above remains open but is not yet load-bearing. Two as-built facts narrow it:
> `events_raw` holds **hook envelopes only** (JSONL transcripts are parsed straight
> into the projections and their raw payloads never land in the database at all), so
> the append-only table grows only with redacted hook events; and the no-UPDATE/
> no-DELETE triggers are live and test-enforced, so any future sweeper will have to
> resolve the exception explicitly rather than quietly.

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
> stored envelope or its hash. `WP-D10` (the sweeper and the fuller
> retention/redaction policy) is not built and the field list implements the
> *recommended* resolution of OPEN-3, pending sign-off — the code says so in its own
> header. The "before the row exists" property below shipped exactly as stated.

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
| A retention TTL and payload redaction exist, live from Phase 1 | **Decided at the requirement level** (CD-10; `WP-D10`) |
| Redaction runs at the ingest write boundary, before the row exists | **Decided** (`WP-D10` owns the redactor; `WP-IN14` invokes it; development-plan §2 merge #3) |
| Retention window (days), exact redacted field list, "huge payload" reject-vs-truncate threshold | **Open** — named Phase-0 policy inputs, not fixed as numbers (`concept-analysis-v2.md` §7, open question 6) |
| How the TTL sweeper's row removal reconciles with `events_raw`'s no-UPDATE/DELETE trigger enforcement | **Open tension**, flagged on [data model](../architecture/data-model.md), not resolved in any source document |
| Literal backup tool, script, and schedule (this page's `sqlite3 .backup` + `launchd` shape) | **Illustrative reference implementation** — no source document fixes the mechanism; `WP-F8` builds the real one |
| Whether the exercised-restore drill runs in CI, a scheduled job, or a manual runbook step | **Open** — `WP-F8` proves it once in Phase 1; `WP-X9` requires it again per release; the automation detail is unspecified |
| Webhook credential handling (`token_ref`, distinct from payload redaction) | **Decided**, different mechanism, different WP (`WP-A3`, CD-10) — see §5 |

> **As-built delta to this table (2026-07):** rows 1-2 are now **built and
> test-proven** (pragma assertion in `connection.ts`; backup/restore in `backup.ts`
> with the restore exercised on every test run). Row 3 (`WP-X9` per-release re-run)
> is an obligation that has not yet had a release to bind to. Rows 4 and 6-7
> (`WP-D10` retention TTL, the policy numbers, the append-only tension) remain
> **open** — no sweeper exists. Row 5 is **built** with the OPEN-3 field list pending
> sign-off. Row 8's real mechanism is the in-process better-sqlite3 online backup,
> not the CLI script. Row 9 is now partially answered: a restore runs in the test
> suite automatically; the release-time drill remains manual. Row 10's `WP-A3` is
> not built (alerts are post-1.0).

## 7. Roadmap positioning

| Phase | WP | Lands |
|---|---|---|
| 1 — Foundation, security spine, storage | `WP-D2` | WAL + foreign-key pragma asserted on every connection open |
| 1 — Foundation, security spine, storage | `WP-F8` | Backup + tested-restore routine built; restore exercised once as Phase-1 proof |
| 1 — Foundation, security spine, storage | `WP-D10` | Storage-lifecycle redactor + retention TTL sweeper (the mechanism, not yet wired to a live write path) |
| 2 — Ingest substrate | `WP-IN14` | Redaction invoked at the ingest write boundary; "redaction live" is the Phase 2 exit-gate wording |
| 6 — Operator alerts + release hardening | `WP-X9` | `RELEASE.md` requires an exercised backup restore as a release-blocking checklist line, every release candidate |

(development-plan §3, §5.) See the [roadmap](../guide/roadmap.md) for how this fits
alongside the rest of each phase.

## Current state

This page was written **pre-Phase-0**, when none of `WP-F8`, `WP-D10`, or `WP-IN14`
existed. Implementation began 2026-07-11 (explicit owner override of CD-8, after the
Phase-0 spike's CONDITIONAL GO). As built today: **`WP-D2` and `WP-F8` are code**
(`apps/server/src/db/connection.ts`, `apps/server/src/db/backup.ts`) with the restore
path exercised on every test run; **`WP-IN14` redaction is live** at the hook-ingest
boundary, before the idempotency key, pending the OPEN-3 sign-off; **`WP-D10` and the
scheduled backup job are not built**, and the per-release operator drill (`WP-X9`)
has not yet had a release to run against. The illustrative script, `launchd` plist,
and policy numbers above remain reference shapes, not shipped operational procedure.

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
