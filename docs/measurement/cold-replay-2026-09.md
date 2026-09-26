# Cold replay at the real corpus shape — measurement 2026-09-09

> ## ⚠ UNRATIFIED — measured by an agent, not yet ticked by Ivan
>
> This file records five benchmark runs made on 2026-09-09 for the **BENCH-SHAPE** row
> in `TODO.md` (closing plan lane **L8**). It writes the numbers down next to the command
> lines that produced them. It does **not** replace the `34.87–39.92 s` band that
> `DONE.md`, `TODO.md` and the architecture pages still quote: the closing plan says
> _"Ivan ratifies by ticking, the agent only measures"_, so the band stays where it is
> until Ivan ticks the BENCH-SHAPE row, and §7 lists exactly which lines change when he
> does. Every number here comes from a **synthetic** corpus and is a **lower bound** on
> the real cost (§6.3).

---

## 1. The question

The `34.87–39.92 s` cold-replay band (2026-09-01) was measured over a synthetic corpus
whose per-session size is the harness's two defaults, `DEFAULT_RECORDS = 1800` ×
`DEFAULT_RECORD_BYTES = 4100` = **7.04 MiB**. The real corpus on this machine carries
roughly 3.7× more bytes per session, and BENCH-SHAPE asked whether the band transfers,
and along which axis: bytes per session, or records per session. The harness gained
`--records` and `--record-bytes` for exactly this, so the runs below keep everything
else at its default and move only the per-session shape.

## 2. Sizes-only census of the real corpus, 2026-09-09

The harness never reads `~/.claude/projects`, and neither did this measurement. The
shape was taken with `find`, `stat -f '%z'` and `wc`; the one `cat` below pipes bytes
into `wc -lc` to count newlines and is the only time transcript bytes left the disk —
nothing was displayed, parsed or kept. `wc -l` counts newlines, so a file without a
trailing newline is short by one record; at 217,962 records the error is below 0.03 %.

```sh
ls ~/.claude/projects | wc -l
find ~/.claude/projects -mindepth 2 -maxdepth 2 -name '*.jsonl' -exec stat -f '%z' {} + \
  | sort -n | awk '{a[NR]=$1; s+=$1} END{print "top-level sessions="NR, "total="s, "mean="s/NR, "p50="a[int(NR/2)+1], "p90="a[int(NR*0.9)], "max="a[NR]}'
find ~/.claude/projects -mindepth 3 -name '*.jsonl' | wc -l
find ~/.claude/projects -mindepth 3 -name '*.jsonl' -exec stat -f '%z' {} + | awk '{s+=$1} END{print "subagent total bytes="s, "n="NR}'
find ~/.claude/projects -mindepth 2 -maxdepth 2 -name '*.jsonl' -exec cat {} + | wc -lc | awk '{print "lines="$1, "bytes="$2, "bytes/record="$2/$1}'
```

| Quantity | 2026-09-09 | 2026-09-01 (closing plan) |
| --- | --- | --- |
| project directories | 21 | — |
| top-level session transcripts | **60** | 51 |
| top-level bytes | 598,775,361 B (571.0 MiB) | — |
| top-level bytes per session: mean / p50 / p90 / max | 9.98 MB / 5.10 MB / 28.4 MB / 56.2 MB | — |
| top-level records (newlines) | 217,962 → **3,633 per session** | — |
| bytes per top-level record | **2,747 B** | — |
| subagent transcripts (`agent-*.jsonl`, depth ≥ 3) | **2,861** (47.7 per session) | 2,477 |
| subagent bytes | 1,087,261,519 B (1,036.9 MiB) | — |
| all bytes | 1,686,036,880 B (1,607.9 MiB) | 1,335.5 MiB |
| **all bytes per session** | **26.80 MiB** | 26.19 MiB |

Two shape facts drive everything below. The real record is **2,747 B**, a third
smaller than the harness default of 4,100 B, so the real corpus has _more records per
byte_ than the default corpus. And **64 % of the real bytes live in subagent
transcripts**, which the harness folds into the main transcript (§6.3).

The `141 sessions` that `corpus-scale.ts` calls `REAL_CORPUS_SESSIONS` is the census of
record in `docs/analysis/parser-spec.md` §4.2 — a different, larger corpus. This
machine holds 60 sessions today; the harness's linear projections to 141 are printed in
§4 because the harness prints them, and are labelled there for what they are.

## 3. Method

- **Harness:** `apps/server/bench/corpus-scale.ts` via `pnpm --filter @agenthropic/server bench`,
  Node **v22.23.2**, darwin arm64, 10 cores (Mac Mini M4, 24 GiB), one sitting,
  runs strictly sequential. The synthetic corpus goes to `os.tmpdir()` and is ingested
  from disk through the real watcher → parser → projection path into a fresh SQLite
  file; nothing is inserted straight into the database. A run is quotable only when no
  1-minute load mark reaches the core count; every mark is in §5.
- **What the flags mean:** `--sessions=N` plants N _clones_ of the 8 in-repo fixtures;
  one fixture is sidechain-only, so 70 clones are 61 discoverable sessions and 60 clones
  are 53. `--records` and `--record-bytes` set the main transcript's record count and
  size; the fixture's own subagent files ride along unchanged.
- **The five runs.** A is the control at the harness defaults; B is the real _top-level_
  mean; C and C2 put **all** real bytes per session into the main transcript — the
  BENCH-SHAPE axis — C2 repeating C because C entered its ingest phase at a 1-minute
  load of 8.77; D is the closing plan's literal 2026-09-01 shape.

| Run | Purpose | Command line |
| --- | --- | --- |
| A | control: harness defaults, same clone count, same sitting | `pnpm --filter @agenthropic/server bench -- --sessions=70 --records=1800 --record-bytes=4100` |
| B | real top-level mean (9.52 MiB, 3,633 × 2,747 B) | `pnpm --filter @agenthropic/server bench -- --sessions=70 --records=3633 --record-bytes=2747` |
| C | all real bytes per session (26.80 MiB, 10,229 × 2,747 B) | `pnpm --filter @agenthropic/server bench -- --sessions=70 --records=10229 --record-bytes=2747` |
| C2 | C repeated at a quiet load | same as C |
| D | closing plan's 2026-09-01 shape (26.19 MiB, 9,997 × 2,747 B; 60 clones ≈ 51 sessions) | `pnpm --filter @agenthropic/server bench -- --sessions=60 --records=9997 --record-bytes=2747` |

Full harness output for every run is in [`runs/2026-09-09/`](https://github.com/IvanBBaev/agenthropic/tree/main/docs/measurement/runs/2026-09-09) —
`bench-A.log` … `bench-D.log` plus `runs.summary.txt` (start times, load averages, exit
codes, wall time). Nothing below is quoted from anywhere else.

**Concurrent activity, for the record.** A peer Claude session's verification agent ran
the full `vitest run --coverage` from 17:45:20 to 17:45:24 UTC. Run A started at 17:47:25
UTC, so no run overlapped it. The peer held all suite, coverage and build runs from
17:49 UTC until the last run finished. The 9.73 mark at the end of B and the 9.27 / 8.77
marks at the start of C (§5) are an unexplained load rise between 17:49:30 and 17:50:30
UTC; the B cold replay was already over (its next mark is 4.88), and C's replay ran under
it, which is why C2 exists.

## 4. Results

### 4.1 Shape of each run

| | **A** | **B** | **C** | **C2** | **D** |
|---|---|---|---|---|---|
| records per main transcript | 1,800 | 3,633 | 10,229 | 10,229 | 9,997 |
| bytes per record | 4,100 | 2,747 | 2,747 | 2,747 | 2,747 |
| MiB per session (main transcript) | 7.04 | 9.52 | 26.80 | 26.80 | 26.19 |
| clones planted / sessions discovered | 70 / 61 | 70 / 61 | 70 / 61 | 70 / 61 | 60 / 53 |
| records ingested (main transcripts) | 109,800 | 221,613 | 623,969 | 623,969 | 529,841 |
| synthetic corpus on disk | 431.1 MiB | 584.7 MiB | 1.61 GiB | 1.61 GiB | 1.37 GiB |
| started (UTC) | 2026-09-09T17:47:26.446Z | 2026-09-09T17:48:31.175Z | 2026-09-09T17:49:50.819Z | 2026-09-09T17:54:31.520Z | 2026-09-09T17:52:25.651Z |

### 4.2 Ingest

| | **A** | **B** | **C** | **C2** | **D** |
|---|---|---|---|---|---|
| 1-min load entering ingest (10 cores) | 6.32 | 5.63 | 8.77 | 4.10 | 4.62 |
| build synthetic corpus (harness) | 1.22 s | 1.71 s | 4.79 s | 6.20 s | 4.03 s |
| **cold replay (startup)** | **11.54 s** | **25.13 s** | **92.29 s** | **81.68 s** | **61.65 s** |
| cold replay per session | 189 ms | 412 ms | 1513 ms | 1339 ms | 1163 ms |
| cold replay throughput | 37.4 MB/s | 23.3 MB/s | 17.8 MB/s | 20.2 MB/s | 22.7 MB/s |
| cold replay per record (derived) | 105 µs | 113 µs | 148 µs | 131 µs | 116 µs |
| event-loop stall during replay (max) | 11.55 s | 25.15 s | 92.34 s | 81.74 s | 61.67 s |
| warm tick, nothing changed | 4.3 ms (0.14% of a 3000 ms poll) | 5.8 ms (0.19% of a 3000 ms poll) | 7.0 ms (0.23% of a 3000 ms poll) | 11.2 ms (0.37% of a 3000 ms poll) | 8.0 ms (0.27% of a 3000 ms poll) |
| warm tick stall (loop-delay max) | 12.0 ms | 12.1 ms | 16.1 ms | 16.1 ms | 16.0 ms |
| incremental tick, one record appended | 31.1 ms | 96.4 ms | 219.6 ms | 234.6 ms | 200.0 ms |
| correctness | discovered 61, ok 61, failed 0, skipped 0; failures 0 | discovered 61, ok 61, failed 0, skipped 0; failures 0 | discovered 61, ok 61, failed 0, skipped 0; failures 0 | discovered 61, ok 61, failed 0, skipped 0; failures 0 | discovered 53, ok 53, failed 0, skipped 0; failures 0 |

Every cold replay is one synchronous event-loop stall: the loop-delay max equals the
replay wall time in all five runs. Whatever the boot mode, nothing on the port is
answered for that long from a fresh database (`/api/health` reports `replaying`, M-16).

### 4.3 API reads on the quiescent server, then the cost-summary read

| | **A** | **B** | **C** | **C2** | **D** |
|---|---|---|---|---|---|
| `GET /api/sessions` | 226.0 ms | 585.0 ms | 1.90 s | 1.79 s | 1.48 s |
| `GET /api/sessions/:id` | 9.9 ms | 17.6 ms | 47.2 ms | 43.1 ms | 39.1 ms |
| `GET /api/sessions/:id/tree` | 13.3 ms | 16.2 ms | 29.0 ms | 30.8 ms | 27.0 ms |
| `GET /api/cost/summary` | 3.3 ms | 3.1 ms | 4.2 ms | 3.9 ms | 3.2 ms |
| `GET /api/dag/global` | 182.1 ms | 405.5 ms | 1.22 s | 1.38 s | 911.8 ms |
| cost summary after a fresh ingest, min / median / max (n=5) | 0.7 ms / 0.8 ms / 0.9 ms (spread 1.28x) | 0.8 ms / 1.0 ms / 1.0 ms (spread 1.38x) | 1.0 ms / 1.1 ms / 3.1 ms (spread 3.20x) | 0.9 ms / 1.0 ms / 1.1 ms (spread 1.17x) | 0.8 ms / 0.9 ms / 1.1 ms (spread 1.33x) |

### 4.4 Storage and the harness's own projection

| | **A** | **B** | **C** | **C2** | **D** |
|---|---|---|---|---|---|
| `token_usage` rows | 274,765 | 554,225 | 1,560,115 | 1,560,115 | 1,324,765 |
| `token_usage_rollup` rows | 660 | 660 | 660 | 660 | 575 |
| `agents` rows | 148 | 148 | 148 | 148 | 128 |
| database on disk | 111.4 MiB | 224.7 MiB | 633.7 MiB | 633.7 MiB | 540.7 MiB |
| db as % of corpus | 25.8 % | 38.4 % | 38.5 % | 38.5 % | 38.7 % |
| peak RSS | 277.0 MiB | 253.1 MiB | 582.8 MiB | 487.3 MiB | 476.6 MiB |
| harness's linear projection to 141 sessions (NOT measured) | 26.67 s over 996.5 MiB | 58.10 s over 1.32 GiB | 213.33 s over 3.72 GiB | 188.80 s over 3.72 GiB | 164.02 s over 3.63 GiB |

## 5. Contention record — 1-minute load average, 10 cores

| | **A** | **B** | **C** | **C2** | **D** |
|---|---|---|---|---|---|
| before the corpus was built | 6.32 | 5.63 | 9.27 | 3.84 | 4.33 |
| before the ingest phases | 6.32 | 5.63 | 8.77 | 4.10 | 4.62 |
| before the sequential API reads | 6.60 | 4.88 | 6.10 | 3.01 | 3.80 |
| before the concurrent read windows | 6.60 | 4.57 | 5.77 | 3.01 | 3.74 |
| before the cost + tick-vs-read phases | 5.42 | 9.73 | 4.36 | 3.40 | 3.70 |
| after every measured phase | 5.63 | 9.27 | 4.33 | 3.29 | 3.48 |
| any mark at or above the core count? | no | no | no | no | no |

## 6. Reading the numbers

### 6.1 The cost tracks records, not bytes

Going from A to B doubles the records per session (1,800 → 3,633) for a 35 % rise in
bytes, and cold replay rises 2.18× (11.54 → 25.13 s). Throughput in MB/s is the quantity
that moves with the shape — 37.4 (A) → 23.3 (B) → 22.7 (D) → 20.2 (C2) — while the derived
cost per record stays inside 105–148 µs across all five runs, and inside 105–131 µs on the
quiet ones. The 2026-09-01 band, re-expressed per record (253,800 records over 34.87–39.92 s),
is 137–157 µs, measured at 1-minute loads of 7.07 → 10.52 and 10.28 → 9.59. Per-record cost
drifts upward with the size of the ledger being written (105 µs at 275 k `token_usage`
rows, 131 µs at 1.56 M), so the scaling is mildly superlinear, not flat.

### 6.2 The band does not transfer by bytes

| Transfer of the 2026-09-01 band (247–283 ms/session at 7.04 MiB, 1,800 records) | to D's scale (53 × 26.19 MiB) | to C's scale (61 × 26.80 MiB) |
| --- | --- | --- |
| linear in **bytes** (×3.72 / ×3.81) | 48.7–55.8 s | 57.4–65.8 s |
| linear in **records** (×5.55 / ×5.68) | 72.7–83.3 s | 85.6–98.1 s |
| **measured** | **61.65 s** | **81.68 s** (C2, quiet) · 92.29 s (C, load 8.77) |

Scaling by bytes underestimates the measured replay by 1.10–1.27× at D's scale and by
1.24–1.61× at C's; scaling by records brackets it. Neither transfer is a substitute for
the measurement, which is why the rows above are the numbers to quote:

- **At this machine's real per-session shape and today's session count** (61 synthetic
  sessions ≈ 60 real, 26.80 MiB each, 2,747 B/record): cold replay **81.68–92.29 s**,
  1,339–1,513 ms per session, from an empty database.
- **At the closing plan's 2026-09-01 shape** (53 sessions × 26.19 MiB): **61.65 s**,
  1,163 ms per session.
- The `34.87–39.92 s` band describes 141 sessions × 7.04 MiB (996 MiB); it is a real
  measurement of a corpus this machine does not have. Per session it is 247–283 ms, and
  the real shape costs **4.1–6.1×** that per session.

The load effect is now measured too: C and C2 are the same command; the run that entered
ingest at load 8.77 replayed 13 % slower than the one that entered at 4.10.

### 6.3 What these runs do and do not establish

- **Synthetic, lower bound.** Record shapes repeat with a period of 8, so the parser
  never meets real-world variety; the harness itself labels every figure a lower bound.
- **Subagent bytes are folded into the main transcript.** The real corpus spreads 64 %
  of its bytes over ~48 `agent-*.jsonl` files per session; C/C2/D put those bytes into
  one file per session with the fixture's own handful of subagent files alongside. The
  per-file cost of discovering, opening and checkpointing ~2,900 files is therefore
  **not** in these numbers, and it can only push the real cost up.
- **Usage-row density is a fixture property.** Every record that carries `usage` becomes
  a `token_usage` row, and the rows-per-record ratio here (2.5) is that of the eight
  fixtures, not of the real corpus. This measurement never read a real record, so the
  direction of that error is unknown.
- **Fresh database only.** "Cold replay" here starts from an empty database. A restart
  over an existing database with replay checkpoints is a different path, not measured.
- **API reads scale with the corpus.** `GET /api/sessions` grows from 226 ms (A) to
  1.79–1.90 s (C2/C) and `GET /api/dag/global` from 182 ms to 1.22 s at the real shape;
  `GET /api/cost/summary` stays at 3–4 ms because it reads the rollup. These are
  sequential reads on a quiescent server, one sample each — a shape, not a benchmark.
- **One machine, one sitting, five runs.** No run was contended by the harness's rule
  (§5), but three of the five ran under a background load between 4 and 9 on 10 cores.

### 6.4 What it means for the open decisions

- **Retention (D3 / L9).** The replay cost is a property of the corpus on disk, not of
  the database; pruning `events` rows does not shorten it. The number that the retention
  policy is "informed by" is therefore the 82–92 s stall at today's corpus, growing with
  records, and the 634 MiB database it leaves behind (38.5 % of the corpus).
- **Boot.** At today's corpus a fresh start blocks the event loop for 82–92 s
  (synthetic lower bound). M-16's `replaying` health phase is what makes that visible.

## 7. When Ivan ticks BENCH-SHAPE — the lines that change

None of these were edited by this measurement. They are listed so the ratification is
one pass, not a hunt:

- `TODO.md` BENCH-SHAPE row (line 313 on 2026-09-09): tick, and replace "the measured
  `34.87-39.92 s` cold replay does not describe the real corpus" with the §6.2 numbers.
- `DONE.md` line 114 ("measured cold replay at 39.92 s and 34.87 s over 996.4 MiB / 141
  sessions") and line 404 (the retention-values bullet, "transfers as a lower bound rather
  than a figure (BENCH-SHAPE)").
- `docs/site/architecture/ingest-reconciliation.md` lines 315–316, 337 and 343 — the run
  A / run B block and the "transfer to the real corpus is not [measured]" sentence.
- `docs/analysis/impl-review-2026-08-09.md` lines 195, 276, 738 and 979.
- `CHANGELOG.md` `[Unreleased]` — the line that labels the band synthetic (line 49 on
  2026-09-09) gains the measured replacement.
- `README.md` does not quote the band (checked with `grep -rn "34\.87\|39\.92"`).

## 8. Reproduce

```sh
export PATH="$HOME/.nvm/versions/node/v22.23.2/bin:$PATH"   # Node 22, not the shell's 26
cd agenthropic
pnpm --filter @agenthropic/server bench -- --sessions=70 --records=10229 --record-bytes=2747
```

Take the sizes-only census of §2 first if the corpus has moved, and re-derive
`--records` as (all bytes per session) ÷ (bytes per top-level record). Quote the run
only if its contention record ends with "no mark exceeded the core count".
