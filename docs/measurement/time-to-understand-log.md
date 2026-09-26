# Time-to-understand — measurement log

> ## ⚠ UNSIGNED — the `<30s to understand a session` gate is **NOT MET**
>
> This file is the recording artifact for
> [`time-to-understand-protocol.md`](./time-to-understand-protocol.md). It is
> **empty of measurements**. Nobody has yet sat in front of the dashboard with a real
> corpus and a stopwatch.
>
> An agent cannot sign a usability claim and must not fill this in. Until Ivan runs
> the protocol and signs §3 below, the v1.0 exit-gate clause stays ⏳ in `TODO.md` and
> `RELEASE.md` §6. A `PASS` here is the *only* thing that changes that — and a `FAIL`
> here is a perfectly good outcome that names what to fix.

---

## 0. Preparation

Added 2026-09-09 (closing plan, lane L11) so the run is a sit-down-and-press-start
job. **Nothing in this section is a measurement.** It contains a launch line that was
proven to boot once, a sizes-only way of naming five sessions, and the observed boot
figures of that one proof. The banner above stands; no trial was run and nothing is
signed.

### 0.1 Launch against the real corpus with a scratch database

The corpus is opened read-only (protocol §2). Everything agenthropic writes goes to
the database path you set, so pointing `DASHBOARD_DB_PATH` at a scratch location
means the run touches neither the corpus nor a production database.

```sh
# Node 22 is required (`node -v` → v22.x; with nvm: export PATH="$HOME/.nvm/versions/node/v22.23.2/bin:$PATH").
# Run from the repository root. The bind host is not configurable: 127.0.0.1 only.
export DASHBOARD_TOKEN="$(openssl rand -hex 32)"              # 16+ characters; you paste it on the token screen once
export DASHBOARD_DB_PATH=/tmp/agenthropic-ttu/agenthropic.db  # scratch; the server creates the directory, backups land next to it
export CLAUDE_PROJECTS_DIR="$HOME/.claude/projects"          # the real corpus (also the default when unset)
export DASHBOARD_PORT=4317                                    # the default; see the port note below

pnpm --filter @agenthropic/web build                          # once — the server serves apps/web/dist from the same origin
pnpm --filter @agenthropic/server start                       # = `tsx src/index.ts` in apps/server; prints "listening on 127.0.0.1:4317"
```

What was proven on 2026-09-09 (§0.4) is the server half of this: the same entry
file started as `node --import tsx src/index.ts` from `apps/server/`, with exactly
the four variables above (a throwaway token, a scratch `DASHBOARD_DB_PATH`, the real
`CLAUDE_PROJECTS_DIR`, a free port). The SPA build was not part of the proof; an
`apps/web/dist` from an earlier build was present. The two-dev-server path that
protocol §2 shows (`pnpm --filter @agenthropic/server dev` plus
`pnpm --filter @agenthropic/web dev` on 5173) takes the same variables.

**Port note.** Check `lsof -iTCP:4317 -sTCP:LISTEN -P -n` first. If something is
listening, set `DASHBOARD_PORT` to a free port and also
`export DASHBOARD_URL=http://127.0.0.1:<port>` so that
`scripts/time-to-understand.mjs` talks to the right server (it defaults to 4317 and
refuses any non-loopback host).

**Then, in the browser.** Open `http://127.0.0.1:4317` (or your port). The only
thing rendered is the token screen: paste `DASHBOARD_TOKEN` and submit. The token is
checked against `/api/health` before it is stored, lives in `sessionStorage` only,
and the shell opens on the default view `#/live` — the view protocol §3 rule 1
starts every timed item from.

**Let ingest settle before the clock exists.** Poll health, not the UI:

```sh
curl -s --max-time 8 -H "Authorization: Bearer $DASHBOARD_TOKEN" http://127.0.0.1:4317/api/health
```

`"ingest":"replaying"` is the boot replay; `"ingest":"idle"` is settled. While the
replay runs, the process is busy and a probe may simply get no answer within the
timeout — that is the same fact, not a failure. Do not start trial P before `idle`,
and write the answer into the run header's last row.

**Prerequisite found on 2026-09-09: pricing rows for the model ids the corpus
uses.** §0.4 shows why: with the shipped seed, 52 of 60 sessions on this machine are
refused by the cost engine's halt gate (`claude-opus-5`, `claude-fable-5-1` have no
`model_pricing` row) and never reach the database. The watcher's designed cure is a
row in `model_pricing`: it re-reads the table every pass and re-admits every parked
session the moment the row lands, without a restart. For the **scratch database
only**, after the first `"ingest":"idle"` and with the server still running:

```sh
sqlite3 "$DASHBOARD_DB_PATH" <<'SQL'
INSERT OR IGNORE INTO model_pricing (model, bucket, usd_per_mtok, effective_from)
  SELECT 'claude-opus-5',    bucket, usd_per_mtok, effective_from FROM model_pricing WHERE model = 'claude-opus-4-8';
INSERT OR IGNORE INTO model_pricing (model, bucket, usd_per_mtok, effective_from)
  SELECT 'claude-fable-5-1', bucket, usd_per_mtok, effective_from FROM model_pricing WHERE model = 'claude-fable-5';
SQL
```

Then poll health again until `"ingest":"idle"` with `sessionsExcluded` at 0 (or at a
number whose remainder the boot log explains). Three things to know before using
it: (1) the rates copied this way are **placeholders** — the nearest seeded model's
PROVISIONAL rates, not a price for these models; the run measures time to
understand, so the dollar figures it produces must be written into every trial's
Notes as "placeholder rates", never quoted as cost; (2) the block was **not
exercised** in the 2026-09-09 proof, which by its rules never opened the database;
(3) the real fix — a seed that names the corpus's model ids — is outside this file,
and it landed on 2026-09-10 as migration 18 in `apps/server/src/db/migrations.ts`, with
the official five-bucket rates for both ids at the seed's floor (PROVISIONAL like the
rest); migration 19 (2026-09-26) repeated it for `claude-opus-5-5`. A database created by
a build at the newest pricing migration needs none of the block above (confirmed on
2026-09-18 at schema 18, §0.5: 54 of 54 sessions admitted, `sessionsExcluded` 0; a boot on
2026-09-26 at schema 18 was refused 27 of 61 on `claude-opus-5-5`, §0.6, which is what
migration 19 cures); a scratch database that already ran the block is converged to the
official figures by the migration's upsert on the next boot. The block stays for a database
behind the newest pricing migration only, and it names ids, so a new id needs a new row.

### 0.2 Sizes-only session pre-selection

The binding selection rule is protocol §2, applied by
`node scripts/time-to-understand.mjs select` against the running server, because
it needs the agent count, cost and status that only the server computes. What can be
prepared without a server — and without reading a single transcript line — is a
**size-class inventory**: which real sessions are the smallest usable, the ~p25, the
median, the ~p90 and the largest. Those five are pre-registered as the *candidates*
for the slots in §1.1, used only where the rule cannot deliver (see there).

Generic procedure, sizes and counts only (`~/.claude/projects` is the corpus root;
one top-level transcript per session, subagent transcripts in a sibling directory):

```sh
# Corpus layout, by names only.
#   ~/.claude/projects/<project-dir>/<session-id>.jsonl                      top-level transcript
#   ~/.claude/projects/<project-dir>/<session-id>/subagents/**/agent-*.jsonl  subagent transcripts

# 1. Inventory: bytes, records, path — ascending by bytes. No content is displayed.
find ~/.claude/projects -mindepth 2 -maxdepth 2 -type f -name '*.jsonl' -print0 \
  | while IFS= read -r -d '' f; do
      printf '%s\t%s\t%s\n' "$(stat -f '%z' "$f")" "$(cat "$f" | wc -l | tr -d ' ')" "$f"
    done | sort -n > inventory.tsv

# 2. Usable population (≥ 50,000 bytes and ≥ 20 records) and nearest-rank picks.
awk -F'\t' '$1>=50000 && $2>=20' inventory.tsv > usable.tsv
N=$(wc -l < usable.tsv | tr -d ' ')
for rank in 1 $(( (N*25+99)/100 )) $(( (N*50+99)/100 )) $(( (N*90+99)/100 )) $N; do
  sed -n "${rank}p" usable.tsv        # smallest usable, ~p25, median, ~p90, largest
done

# 3. Subagent transcripts of one pick.
find ~/.claude/projects/<project-dir>/<session-id> -type f -name 'agent-*.jsonl' | wc -l
```

The session id the `run` command wants is the transcript file name without
`.jsonl`. The real names behind the five candidates are **not** in this file — they
sit in the local-only `docs/ai/time-to-understand-picks-2026-09-09.md`, which
`.git/info/exclude` keeps out of the repository.

### 0.3 How to sign

Signing is §3 of this file and nothing else, under the rule in protocol §7: only a
human who personally ran every trial as written signs, only after every trial is in
§4, and `Result` is whatever the gate arithmetic at the end of §2 gives — `MET` needs
all three `yes`. No agent and no script fills §3 in; this section was written by
an agent and therefore signs nothing. Until §3 carries a name, the banner at the top
is the state of the gate.

### 0.4 Observed boot — observed on 2026-09-09

One boot of the server half of §0.1: `node --import tsx src/index.ts` from
`apps/server/` under Node v22.23.2, a throwaway token, a scratch
`DASHBOARD_DB_PATH` outside the repository, `CLAUDE_PROJECTS_DIR=$HOME/.claude/projects`,
and port 4399 (chosen because it was certainly free). The process was polled on
`/api/health` only, every 10 s, then stopped with `SIGTERM` to that one PID: it
exited within 2 s, no listener was left on the port, and the scratch database was
left in place with its `-wal` / `-shm` siblings. Every figure below is a count or a
timing from the health body and the boot summary line; no other endpoint was called
and the database was not opened.

| Figure | Observed 2026-09-09 |
| --- | --- |
| `schemaVersion` | 17 |
| Replay duration by the server's own timer (`lastTickDurationMs`) | 12,069 ms |
| Wall-clock to `"ingest":"idle"` | the first probe, sent at +10 s, was answered `idle` after the replay had finished — i.e. between ~12 s and ~18 s from launch (10-s poll granularity plus the probe's own wait; the replay is synchronous and blocks the event loop) |
| Boot summary line | 8/60 sessions ok, 52 failed, 0 skipped; 24 agents, 16 edges, 2,895 usage rows, 0 files skipped |
| Health counters at idle | `sessionsExcluded` 52, `sessionsQuarantined` 0, `crossSessionUsageCollisions` 0, `ingestSkips` `{}` |

**Why 52 of 60 sessions failed.** All 52 failures carry the same reason, the cost
engine's halt gate: `unknown model id … — refusing to price at $0; seed an explicit
pricing row instead` — 48 sessions on the model id `claude-opus-5`, 4 on
`claude-fable-5-1`. The pricing seed the migrations ship
(`apps/server/src/db/migrations.ts`, marked PROVISIONAL) has rows for
`claude-opus-4-8`, `claude-sonnet-5`, `claude-fable-5`, `claude-haiku-4-5-20251001`
and `<synthetic>`; model ids are matched as exact strings, so the two ids the corpus
actually uses price nothing and their sessions are refused whole. The mechanism is
documented (`docs/site/usage/configuration.md`, cost engine section); what this boot
adds is its outcome on the real corpus of this machine: **8 sessions and 24 agents in
the database**, the other 52 parked by the watcher (retried twice more, then
quarantined until their file or the pricing table changes). On this build, without
the pricing prerequisite in §0.1, protocol §2's `select` would choose from those 8
sessions and every size-class candidate in §1.1 is likely to be among the refused.
The seed itself is not this file's to change; it was listed as open in the lane
report and closed on 2026-09-10 by migration 18. §0.5 is the rerun of this proof on
schema 18; the figures above stand as observed on their day.

### 0.5 Rerun on schema 18 — observed 2026-09-18

The same boot as §0.4, eight days later, on the build that carries migration 18: the same
entry file the same way (`node --import tsx src/index.ts` from `apps/server/`, Node
v22.23.2), a fresh throwaway token, a **new** scratch `DASHBOARD_DB_PATH` outside the
repository, `CLAUDE_PROJECTS_DIR=$HOME/.claude/projects`, port 4399 again. Health was
polled every 10 s with an 8-s probe timeout, the process was stopped with `SIGTERM` to that
one PID (it exited within 1 s; no listener was left on the port), the database was not
opened, no other endpoint was called. The sqlite3 block of §0.1 was neither needed nor run.

| Figure | Observed 2026-09-18 |
| --- | --- |
| `schemaVersion` | 18 |
| Replay duration by the server's own timer (`lastTickDurationMs`) | 28,017 ms |
| Wall-clock to `"ingest":"idle"` | the first probe, sent at +10 s, got no answer inside its 8-s timeout (the replay was still running — the same fact §0.1 describes); the second, sent at +29 s, was answered `idle` at once — i.e. between ~28 s and ~29 s from launch |
| Boot summary line | 54/54 sessions ok, 0 failed, 0 skipped; 2,897 agents, 2,843 edges, 635,405 usage rows, 0 files skipped |
| Health counters at idle | `sessionsExcluded` 0, `sessionsQuarantined` 0, `crossSessionUsageCollisions` 0, `ingestSkips` `{}` |
| `unknown model id` lines in the boot log | 0 (the boot log was three lines: the retention dry run, the replay summary, the listening line) |

**What it proves and what it does not.** Every session the corpus held on 2026-09-18
reached the database; the halt gate refused nothing. A sizes-only census taken the same
minute (`find … -name '*.jsonl' | wc -l`) counted 54 top-level transcripts in 22 project
directories with 2,843 `agent-*.jsonl` files — the server's 54 sessions and 2,843 edges
are that corpus, not a subset of it. The corpus itself had moved since §0.4 (60 → 54
top-level transcripts, 21 → 22 project directories, 2,855 → 2,843 subagent files), so the
two boots are not comparable session for session and were never meant to be: §0.4 showed
the seed refusing the corpus of its day, §0.5 shows migration 18 admitting the corpus of
its day. The replay took 2.3× longer because it now ingested every session instead of 8
(635,405 usage rows against 2,895). The dollar figures such a database shows are the
seed's official-but-PROVISIONAL rates (WP-C1); nothing here ratifies them. The dashboard
itself was not opened, so the time-to-understand gate stays **UNMEASURED**.

### 0.6 Rerun on schema 18 — observed 2026-09-26

The same protocol as §0.5, eight days later, on a build still at schema 18 (migration 19
was written the same day, after this boot, because of it): `pnpm --filter
@agenthropic/server start` from the repository root under Node v22.23.2, a fresh throwaway
token, a **new** scratch `DASHBOARD_DB_PATH` outside the repository,
`CLAUDE_PROJECTS_DIR=$HOME/.claude/projects`, port 4317. Health was polled every 10 s with
an 8-s probe timeout from the launch instant (06:12:53 UTC); the process was stopped with
`SIGTERM` to its own PID; the database was not opened.

| Figure | Observed 2026-09-26 |
| --- | --- |
| `schemaVersion` | 18 |
| Replay duration by the server's own timer (`lastTickDurationMs`) | 189,056 ms |
| Wall-clock to `"ingest":"idle"` | every probe through +184 s timed out (the replay is synchronous and the listener does not answer while it runs); the probe at +202 s was answered `idle` at once |
| Boot summary line | 34/61 sessions ok, 27 failed, 0 skipped; 1,210 agents, 1,176 edges, 273,255 usage rows, 1 files skipped |
| Health counters at idle | `sessionsExcluded` 27, `sessionsQuarantined` 0, `crossSessionUsageCollisions` 0, `ingestSkips` `{ "oversize": 1 }` |
| `unknown model id` lines in the boot log | 27, all `"claude-opus-5-5"` |
| Later passes | `sessionsQuarantined` rose to 18 and then 23 as the three-attempt budgets ran out (`lastTickDurationMs` 17,598 then 9,683 ms); one live session's budget reset to attempt 1/3 because its transcript grew between passes, so a session that keeps being written is re-read on every poll while the id stays unpriced |

**What it proves and what it does not.** The halt gate did on this day exactly what it did
on 2026-09-09: it refused every session whose transcript names a model id the table does
not carry, and it named the id. The corpus had moved again since §0.5 (54 → 61 top-level
transcripts, 22 → 23 project directories, 2,843 → 2,703 `agent-*.jsonl` files by the same
sizes-only census), and the model it now uses most, `claude-opus-5-5`, was released after
migration 18 was written. The 34 sessions that were admitted are the ones whose every
priced message names an id the table already carried; a spot check of one of them
(b975807e) against its own transcript matched token for token. The one skipped file is the
main transcript of the session doing this measurement (150.97 MiB, over the 64 MiB
`maxBytes` cap), which is why `filesSkipped` is 1 and not 0; its session is on disk and
not in the database. Migration 19 is the cure for the 27, written the same day from the
platform pricing page; §0.7 below is the rerun that shows it does. The
189-s dark window before the first answered probe is a finding of its own: a replay this
long runs inside the event loop, and `/api/health` cannot report `replaying` while it
does. The dashboard was not opened, so the gate stays **UNMEASURED**.

### 0.7 Rerun on schema 19 — observed 2026-09-26

The same protocol as §0.6, the same day, on the source as of 09:53:04 UTC (migration 19
in place): `pnpm --filter @agenthropic/server start` from the repository root under Node
v22.23.2, a fresh throwaway token, a **new** scratch `DASHBOARD_DB_PATH` outside the
repository, `CLAUDE_PROJECTS_DIR=$HOME/.claude/projects`, port 4317. Health was polled from
the launch instant; the database was not opened. Raw artifacts are in the session
scratchpad (`ss2-boot/`), not in the repository.

| Figure | Observed 2026-09-26 (schema 19) |
| --- | --- |
| `schemaVersion` | 19 |
| Boot summary line | 61/61 sessions ok, 0 failed, 0 skipped; 2,794 agents, 2,733 edges, 774,565 usage rows, 1 file skipped |
| `unknown model id` lines in the boot log | 0 (27 on schema 18, §0.6) |
| Wall-clock to `"ingest":"idle"` | about +42 s from launch (+202 s on schema 18); the probes inside that window timed out |
| `lastTickDurationMs` | 392 ms idle, 815 ms on the final pass |
| Health at idle | `{"status":"ok","schemaVersion":19,"ingestSkips":{"oversize":1},"ingest":"idle","lastTickDurationMs":392,"crossSessionUsageCollisions":0,"sessionsExcluded":0,"sessionsQuarantined":0}` |
| Sessions served | 61 |
| Session 3e90370e | 43 agents, 42 edges, 113,483,127 tokens, `claude-opus-5-5` cost 73.099235 USD |
| Session be170017 (the one doing the measurement) | 367 agents, 1,219,441,204 tokens, 1,283.8126291 USD — served as complete although its main transcript (158,297,347 B) is the one skipped file |
| `/api/cost/summary` | 11,764,203,910 tokens, 12,897.4776221 USD, 0 unpriced, 8 models, 55 days |
| Sizes-only census | 61 top-level transcripts, 23 project directories, 2,734 `agent-*.jsonl` files |
| Stopping | `SIGTERM` to the `pnpm` wrapper left the `tsx` child listening for more than 10 s; `SIGTERM` to the child itself exited in 0.1 s |

**What it proves and what it does not.** Migration 19 admitted all 27 sessions §0.6
refused: the boot log carries no `unknown model id` line and `sessionsExcluded` is 0, so
the halt gate is now silent on this corpus for the right reason (every id is priced), not
because it was relaxed. The time to idle fell from about 202 s to about 42 s, almost all
of it the 27 sessions that no longer fail and retry; the remaining ~40 s is still a
synchronous replay during which `/api/health` does not answer, so the dark-window finding
of §0.6 stands, shorter. Two new findings are the owner's: the oversize session is served
as complete (367 agents, a dollar figure) with nothing on the session marking that its
main transcript was skipped, only the corpus-wide `ingestSkips` counter; and a `SIGTERM`
sent to the `pnpm` wrapper does not reach the server, so an operator who stops it by the
wrapper's PID leaves the port held. The `claude-opus-5-5` rates that priced the 27 are
PROVISIONAL like the rest of the seed. The dashboard was not opened, so the gate stays
**UNMEASURED**.

## 1. Run header

Fill this in once per run, by hand, before the first trial.

| Field | Value |
| --- | --- |
| Date | _(YYYY-MM-DD)_ |
| Operator | _(name — a human, not an agent)_ |
| Build | _(`git rev-parse --short HEAD`)_ |
| Corpus | _(`~/.claude/projects`, N sessions / M projects — on 2026-09-09 the root held 60 top-level transcripts in 21 project directories with 2,855 subagent transcripts, on 2026-09-18 54 in 22 with 2,843, on 2026-09-26 61 in 23 with 2,703; re-count on the day)_ |
| Server | _(`pnpm --filter @agenthropic/server start` per §0.1, or `… dev`; write the actual port)_ |
| UI | _(served by the server on the same port, or `pnpm --filter @agenthropic/web dev`, port 5173)_ |
| Ingest settled before first trial? | _(yes / no — "no" voids the run; `"ingest":"idle"` on `/api/health`, §0.1)_ |

### 1.1 Session picks

The five size-class candidates, named so that nothing here identifies a real
session; the real identity of each row is in the local-only
`docs/ai/time-to-understand-picks-2026-09-09.md`. Figures are rounded; "subagent
files" counts `agent-*.jsonl` under the session's sibling directory.

**Precedence.** `node scripts/time-to-understand.mjs select` (protocol §2) decides
the session for every slot. A candidate below fills its slot **only** when `select`
reports "no such session" for it, or when the rule's session is burnt (protocol §3
rule 7) or the trial is voided — and the trial's Notes must say which. The size
class of the session actually used is written into the last column by hand, from
sizes only.

| Slot | Size-class candidate (rounded) | Protocol §2 slot rule | Session id used | Size class of the session used |
| --- | --- | --- | --- | --- |
| S1 | largest — ~56 MB, ~21,000 records, ~850 subagent files (~110 directly under `subagents/`) | most recent session with ≥ 5 agents | | |
| S2 | ~p90 — ~32 MB, ~8,000 records, ~100 subagent files | highest-cost session in the last 7 days | | |
| S3 | median — ~5.5 MB, ~2,000 records, ~20 subagent files | a session with an `error` or `unknown` agent | | |
| S4 | ~p25 — ~1.7 MB, ~300 records, no subagent files | the oldest session still in the database | | |
| S5 | smallest usable — ~50 KB, ~35 records, no subagent files | a session with exactly one agent | | |

The practice trial P uses any session not in S1…S5 (one of the six transcripts
below the usable threshold is a natural choice).

## 2. Summary

One row per trial. `T_session` = Q1 + Q2 + Q3s, in seconds, one decimal.
Verdict vocabulary: `PASS · FAIL(time) · FAIL(wrong) · FAIL(unanswerable) ·
FAIL(discipline) · VOID` (protocol §4).

| Slot | Session id | Q1 s | Q2 s | Q3s s | **T_session** | Verdict | Note |
| --- | --- | --- | --- | --- | --- | --- | --- |
| P (practice, excluded) | | | | | | | |
| S1 | | | | | | | |
| S2 | | | | | | | |
| S3 | | | | | | | |
| S4 | | | | | | | |
| S5 | | | | | | | |

Fleet questions (scored separately — the "all five answerable" clause):

| Item | Trial | Seconds | Verdict | Note |
| --- | --- | --- | --- | --- |
| Q3f (anything stuck fleet-wide) | | | | |
| Q4 (today / week / savings) | | | | |
| Q5 (persisted across restart) | | | | |

**Gate arithmetic** (protocol §4 — do not adjust after seeing the numbers):

- Every session-scoped answer in S1…S5 correct? _(yes / no)_
- `T_session < 30.0 s` in ≥ 4 of 5 trials? _(yes / no)_
- No trial above 45.0 s? _(yes / no)_
- **Gate met** = all three `yes`. → _(MET / NOT MET)_

## 3. Signature

> Signing means: I personally ran the protocol as written, the numbers above are what
> the stopwatch said, and the verdict is what the numbers give — not what I hoped for.

```
Result:     ______________________   (MET / NOT MET)
Signed by:  ______________________   (human name)
Date:       ______________________
Build:      ______________________
```

Unsigned = unmeasured = the gate is open. There is no third state.

## 4. Trial records

`node scripts/time-to-understand.mjs run <sessionId> --label <slot>` appends one block
per trial below, verbatim and append-only. Hand-written blocks are fine too — the
format is the point, not the tool. Nothing here is ever edited after the fact; a
correction is a **new** block that says what it corrects.

The shape of a block, for reference:

Every value below is a `<placeholder>` on purpose. This block is a SHAPE, not a
reading — no real timestamp, no real session id, no verdict word, so that nothing
in this file can ever be skimmed, grepped or quoted as if a trial had happened.

AMENDED 2026-09-23 (finding C-8 wave, item C-4 follow-through). The heading used to
read `session <session id>`. After C-4 the script writes `short(sessionId)` - the
first 8 characters - so the template was inviting a hand-runner to paste a full real
session UUID from `~/.claude/projects` into a public repository, which is exactly the
disclosure the rest of this file is built to prevent. It now reads `<session id
prefix>`, matching both what the script writes and the `<id prefixes | none>` cells
already used inside the rows.

```
### Trial <slot> — <ISO timestamp> — session <session id prefix>
build: <short sha> | corpus: <corpus path>

| Item | Seconds | Answer given | Ground truth | Correct |
| --- | --- | --- | --- | --- |
| Q1  | <s> | <what you typed> | <what the API says> | <y/n> |
| Q2  | <s> | <what you typed> | <what the API says> | <y/n> |
| Q3s | <s> | <what you typed> | <what the API says> | <y/n> |
T_session: <sum of the three> s → <PASS | FAIL(time) | FAIL(wrong) | FAIL(unanswerable) | FAIL(discipline) | VOID>
Notes: <what was slow, what misled, what was missing>
```

### 4.1 Hand-run shells

Pre-filled 2026-09-09 for the hand-written path, one per trial in the order the
protocol runs them (P, then S1…S5). Every cell is still a `<placeholder>`: no
timestamp, no session id, no seconds, no verdict word — these are empty forms, not
readings. The script path ignores them and appends its own blocks after the marker
at the end of the file; if you use the script, leave these as they are. The six
rows match what the script writes: Q1, Q2 and Q3s sum into `T_session`; Q3f, Q4 and
Q5 are recorded in the same block but scored in the fleet table of §2.

```
### Trial P (practice, excluded) — <ISO timestamp> — session <session id prefix>
build: <short sha> | corpus: ~/.claude/projects

| Item | Seconds | Answer given | Ground truth | Correct |
| --- | --- | --- | --- | --- |
| Q1  | <s> | <N> agents; running: <id prefixes | none> | <what the API says> | <y/n> |
| Q2  | <s> | <agent id prefix | unattributed>; $<amount> | <what the API says> | <y/n> |
| Q3s | <s> | clean | stuck: <id prefixes> | <what the API says> | <y/n> |
| Q3f | <s> | none | <session id prefixes> | <what the API says> | <y/n> |
| Q4  | <s> | today $<x>; week $<y>; savings $<z | not shown> | <what the API says> | <y/n> |
| Q5  | <s> | <N> sessions from <date>, ids <prefixes> | <what the API says> | <y/n> |
T_session: <Q1 + Q2 + Q3s> s → <verdict, protocol §4 vocabulary>
Notes: <what was slow, what misled, what was missing>
```

```
### Trial S1 — <ISO timestamp> — session <session id prefix>
build: <short sha> | corpus: ~/.claude/projects
slot rule: most recent session with ≥ 5 agents | candidate row: §1.1 S1 (largest) | used the candidate because: <no such session | burnt | void | not used>

| Item | Seconds | Answer given | Ground truth | Correct |
| --- | --- | --- | --- | --- |
| Q1  | <s> | <N> agents; running: <id prefixes | none> | <what the API says> | <y/n> |
| Q2  | <s> | <agent id prefix | unattributed>; $<amount> | <what the API says> | <y/n> |
| Q3s | <s> | clean | stuck: <id prefixes> | <what the API says> | <y/n> |
| Q3f | <s> | none | <session id prefixes> | <what the API says> | <y/n> |
| Q4  | <s> | today $<x>; week $<y>; savings $<z | not shown> | <what the API says> | <y/n> |
| Q5  | <s> | <N> sessions from <date>, ids <prefixes> | <what the API says> | <y/n> |
T_session: <Q1 + Q2 + Q3s> s → <verdict, protocol §4 vocabulary>
Notes: <what was slow, what misled, what was missing>
```

```
### Trial S2 — <ISO timestamp> — session <session id prefix>
build: <short sha> | corpus: ~/.claude/projects
slot rule: highest-cost session in the last 7 days | candidate row: §1.1 S2 (~p90) | used the candidate because: <no such session | burnt | void | not used>

| Item | Seconds | Answer given | Ground truth | Correct |
| --- | --- | --- | --- | --- |
| Q1  | <s> | <N> agents; running: <id prefixes | none> | <what the API says> | <y/n> |
| Q2  | <s> | <agent id prefix | unattributed>; $<amount> | <what the API says> | <y/n> |
| Q3s | <s> | clean | stuck: <id prefixes> | <what the API says> | <y/n> |
| Q3f | <s> | none | <session id prefixes> | <what the API says> | <y/n> |
| Q4  | <s> | today $<x>; week $<y>; savings $<z | not shown> | <what the API says> | <y/n> |
| Q5  | <s> | <N> sessions from <date>, ids <prefixes> | <what the API says> | <y/n> |
T_session: <Q1 + Q2 + Q3s> s → <verdict, protocol §4 vocabulary>
Notes: <what was slow, what misled, what was missing>
```

```
### Trial S3 — <ISO timestamp> — session <session id prefix>
build: <short sha> | corpus: ~/.claude/projects
slot rule: a session with an error or unknown agent | candidate row: §1.1 S3 (median) | used the candidate because: <no such session | burnt | void | not used>

| Item | Seconds | Answer given | Ground truth | Correct |
| --- | --- | --- | --- | --- |
| Q1  | <s> | <N> agents; running: <id prefixes | none> | <what the API says> | <y/n> |
| Q2  | <s> | <agent id prefix | unattributed>; $<amount> | <what the API says> | <y/n> |
| Q3s | <s> | clean | stuck: <id prefixes> | <what the API says> | <y/n> |
| Q3f | <s> | none | <session id prefixes> | <what the API says> | <y/n> |
| Q4  | <s> | today $<x>; week $<y>; savings $<z | not shown> | <what the API says> | <y/n> |
| Q5  | <s> | <N> sessions from <date>, ids <prefixes> | <what the API says> | <y/n> |
T_session: <Q1 + Q2 + Q3s> s → <verdict, protocol §4 vocabulary>
Notes: <what was slow, what misled, what was missing>
```

```
### Trial S4 — <ISO timestamp> — session <session id prefix>
build: <short sha> | corpus: ~/.claude/projects
slot rule: the oldest session still in the database | candidate row: §1.1 S4 (~p25) | used the candidate because: <no such session | burnt | void | not used>

| Item | Seconds | Answer given | Ground truth | Correct |
| --- | --- | --- | --- | --- |
| Q1  | <s> | <N> agents; running: <id prefixes | none> | <what the API says> | <y/n> |
| Q2  | <s> | <agent id prefix | unattributed>; $<amount> | <what the API says> | <y/n> |
| Q3s | <s> | clean | stuck: <id prefixes> | <what the API says> | <y/n> |
| Q3f | <s> | none | <session id prefixes> | <what the API says> | <y/n> |
| Q4  | <s> | today $<x>; week $<y>; savings $<z | not shown> | <what the API says> | <y/n> |
| Q5  | <s> | <N> sessions from <date>, ids <prefixes> | <what the API says> | <y/n> |
T_session: <Q1 + Q2 + Q3s> s → <verdict, protocol §4 vocabulary>
Notes: <what was slow, what misled, what was missing>
```

```
### Trial S5 — <ISO timestamp> — session <session id prefix>
build: <short sha> | corpus: ~/.claude/projects
slot rule: a session with exactly one agent | candidate row: §1.1 S5 (smallest usable) | used the candidate because: <no such session | burnt | void | not used>

| Item | Seconds | Answer given | Ground truth | Correct |
| --- | --- | --- | --- | --- |
| Q1  | <s> | <N> agents; running: <id prefixes | none> | <what the API says> | <y/n> |
| Q2  | <s> | <agent id prefix | unattributed>; $<amount> | <what the API says> | <y/n> |
| Q3s | <s> | clean | stuck: <id prefixes> | <what the API says> | <y/n> |
| Q3f | <s> | none | <session id prefixes> | <what the API says> | <y/n> |
| Q4  | <s> | today $<x>; week $<y>; savings $<z | not shown> | <what the API says> | <y/n> |
| Q5  | <s> | <N> sessions from <date>, ids <prefixes> | <what the API says> | <y/n> |
T_session: <Q1 + Q2 + Q3s> s → <verdict, protocol §4 vocabulary>
Notes: <what was slow, what misled, what was missing>
```

<!-- trial records are appended below this line -->
