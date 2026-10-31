# Real-corpus boot and restore drill — agent evidence, 2026-10-31

> ## ⚠ AGENT WORK, taken on owner delegation (D9)
>
> Decision D9 ([`10-synthesis.md`](../analysis/role-reviews-2026-10-29/10-synthesis.md)
> §6.1) hands the **drill** and **BENCH-SHAPE** to an agent. This file records what
> the agent ran and saw. These are the numbers of one run on one loaded machine, not a
> benchmark band. RELEASE §5 and §6 still need to be re-run on the release commit,
> because each of them is a "before every tag" box.

## 1. Real-corpus boot (RELEASE §6, item 2)

**Setup.**

- Commit `dcf3aee` on `main`, Node v22.23.2, run with `pnpm --filter @agenthropic/server start`.
- `CLAUDE_PROJECTS_DIR` unset, so the root is `~/.claude/projects`.
- A random 32-byte `DASHBOARD_TOKEN`.
- A throwaway `DASHBOARD_DB_PATH` under `~/Development/_temp/ops-2026-10-31/boot/`.
- Every session was replayed from an empty database.

**Corpus on disk (sizes only, via `find` and `stat`):**

| Files | Count | Size |
|---|---|---|
| Main transcripts | 362 | 2,938.5 MiB |
| Subagent transcripts | 2,490 | 2,894.8 MiB |
| **Total** | | **5.70 GiB** |

**Result line:**

```text
corpus replay: 360/362 sessions ok, 0 failed, 2 skipped, 2838 agents, 2433 edges, 982670 usage rows, 6 files skipped
agenthropic server listening on 127.0.0.1:4317
```

- **Pass: `0 failed`.** No `PricingError` and no `UsageConflictError` occurred. Every model
  id in the corpus has a seeded `model_pricing` row: `claude-sonnet-5-5` since migration 24
  and `claude-haiku-5-5` (≤100k base tier) since migration 25.
- **The fork-context fix is confirmed.** On the 2026-10-30 boot (commit `6cebc77`),
  sessions `ed0903af` and `b37d6254` failed with "conflicting agent attribution". Both
  ingest now; the fix is `dcf3aee`, parser-spec §5.3 amendment.
- **Loopback bind is confirmed** (`127.0.0.1`).
- **The 6 skipped files:**
  - **1 is empty-main:** `e7285e4a`, a main file with no records.
  - **5 are oversize** against the current 64 MiB cap (`DEFAULT_MAX_FILE_BYTES`):

    | Session | Size (bytes) |
    |---|---|
    | `d2fc3f32` | 83,233,021 |
    | `0488ae98` | 90,658,853 |
    | `be170017` | 166,002,362 |
    | `6dcc36df` | 170,134,077 |
    | `c46428b4` | 78,922,663 |

    All five fit under the 256 MiB default that R14 proposes.

  All six are main transcripts. The 2 skipped sessions are `e7285e4a` and `0488ae98`,
  which have no other file. The other four oversize sessions still ingest their subagent
  files (6, 752, 249 and 2 of them). Their main-agent tokens are **missing** from the
  totals, and that gap is R14's to close.

## 2. Cold replay on the real corpus (R25, BENCH-SHAPE)

| Mark | Time (UTC) |
|---|---|
| Process start (`tsx src/index.ts`) | 06:49:30.313 |
| Database open, retention line | 06:49:33.348 |
| `corpus replay:` line | 06:51:33.792 |

- **Cold replay is 120.4 s**, from database open to the replay line. It is 123.5 s from
  process start, for 5.70 GiB across 362 sessions.
- **Load.** The machine was heavily loaded by other work: the load average was
  67.33 / 91.44 / 70.55 at the start and 48.69 / 76.94 / 67.88 at the end. The figure is an
  **upper-side single sample**, not a band. An idle-machine run will be faster.
- **What it replaces.** The synthetic numbers in
  [`cold-replay-2026-09.md`](cold-replay-2026-09.md) are now **historical**:
  - the `34.87–39.92 s` band, at 7.04 MiB/session;
  - the `81.68–92.29 s` runs, at the September real shape.

  The corpus they modelled has since grown about 4×. The number that describes this machine
  today is the one above.

## 3. Backup → restore drill (RELEASE §5, R10)

The drill was run twice, each time on a **copy**. No live file was opened for writing.

| Source (copied via `sqlite3 .backup`) | Size | RELEASE §5 command (online backup + `integrity_check`) | Shipped `restoreDatabase()` | Row counts, source vs restored |
|---|---|---|---|---|
| `data/agenthropic.db` (the in-repo dev DB) | 94,208 B, schema v7, no sessions | `restore drill OK` | OK in 20 ms, `journal_mode wal`, `integrity_check ok` | identical |
| the §1 real-corpus DB | 341,868,544 B, schema v25 | `restore drill OK` (2,893 ms) | OK in 4,505 ms, `journal_mode wal`, `integrity_check ok` | identical across all 15 tables |

- **The real-corpus restore** holds 360 sessions, 2,838 agents, 2,433 edges,
  982,880 `token_usage` rows and 50 `model_pricing` rows.
- **The `token_usage` count differs from the replay line.** It is 982,880 against the
  replay line's 982,670 usage rows. The server ran about 10 s past the replay line and
  tailed live sessions in that window.
- **The in-repo `data/agenthropic.db` is stale.** It is at schema v7 and holds no data, so
  a drill against it alone proves little. The pre-tag drill must run against the database
  the release is booted on.

**Scripts and logs** are kept out of git under `~/Development/_temp/ops-2026-10-31/`:

- `boot/run.sh`, `boot/boot.log`, `boot/meta.txt`;
- `drill/drill.mjs`, which is the RELEASE §5 command with the paths taken as arguments;
- `drill/restore.ts`, `drill/counts.sh`, and the `*-src.txt` / `*-restored.txt` count files.
