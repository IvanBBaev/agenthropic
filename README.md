# agenthropic

<!-- badges:start -->

[![CI](https://img.shields.io/github/actions/workflow/status/IvanBBaev/agenthropic/ci.yml?branch=main&style=flat-square&logo=githubactions&logoColor=white&label=CI)](https://github.com/IvanBBaev/agenthropic/actions/workflows/ci.yml)
![Node](https://img.shields.io/badge/node-%3E%3D22-5FA04E?style=flat-square&logo=nodedotjs&logoColor=white)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue?style=flat-square)](LICENSE)

<!-- badges:end -->

A self-hosted, local-first dashboard for observing and visualising **Claude Code
agent and subagent activity** — real sessions, on your own machine, with no cloud
dependency and no telemetry egress.

It reads the JSONL transcripts under `~/.claude/projects` as the **primary source
of truth** (lifecycle hooks are a liveness signal, reconciled against the JSONL —
decision CD-1), appends everything into an immutable SQLite substrate, and renders
the **persisted subagent DAG** with **dollar-accurate cost attribution** (tokens ×
dated price — token counts are read from the JSONL, never inferred).

## Quickstart

Requires **Node 22+** and **pnpm** (the repo pins `pnpm@11.11.0` via `packageManager`,
so `corepack enable` is enough).

```sh
git clone https://github.com/IvanBBaev/agenthropic.git
cd agenthropic
pnpm install

# The auth token is mandatory (16+ characters); the server refuses to start without it.
DASHBOARD_TOKEN="replace-with-a-long-random-secret" pnpm --filter @agenthropic/server dev
```

The server binds `127.0.0.1:4317` (loopback only, not configurable), creates its
SQLite database at `apps/server/data/agenthropic.db`, runs migrations on boot, and
immediately starts ingesting the JSONL corpus from `~/.claude/projects`.

In a second terminal, start the dashboard:

```sh
pnpm --filter @agenthropic/web dev
```

Open <http://127.0.0.1:5173> and paste the same `DASHBOARD_TOKEN` on the token
screen (the Vite dev server proxies `/api` to the server). Optional environment
overrides: `DASHBOARD_PORT`, `DASHBOARD_DB_PATH`, `CLAUDE_PROJECTS_DIR` (corpus
root), `DASHBOARD_INGEST=0` (disable ingest), `DASHBOARD_WATCHDOG_MINUTES`
(inactivity window, default 10).

### Wiring the lifecycle hooks

```sh
node hooks/install.mjs --out /path/to/project/.claude/settings.json
```

This generates four fail-silent `curl` hooks — `UserPromptSubmit`, `Stop`,
`SubagentStop`, `PreCompact` — that POST their stdin JSON to the loopback ingest
endpoint. It backs up the settings file before touching it, preserves unrelated
keys, and `--dry-run` prints the result without writing anything. The token value
never enters any process's argv: curl reads the environment variable itself at
fire time (which needs curl ≥ 8.3.0; on an older curl the hook delivers nothing
rather than leaking).

Installing them is optional but consequential, because **hooks are the only
terminal signal this dashboard has.** Reading a transcript proves that activity
happened; it never proves that it stopped, since a file that has stopped growing
is indistinguishable from one whose next line has not been flushed yet. So ingest
only ever writes `working`. `SubagentStop` is what turns a subagent `completed`
and `Stop` is what turns a main agent `waiting`; without them an agent ages
`working` → `unknown` when the watchdog window elapses, and nothing in the UI
will ever read `completed`. That is the intended behaviour, not a gap: the
dashboard declines to claim an ending nobody observed. Hook events remain
liveness only — they can move an existing agent's `status` and nothing else, so a
hook can never create, delete or re-parent a node in the DAG.

## Status

🚧 **It works locally. It is not released.** There is no tag, no published package
and no binary: the workspace is `private: true` at version `0.1.0`, and the only way
to run it is the Quickstart above, from a checkout. Nothing below describes a
download.

What actually runs today — checked against the code, not against the plan — is the
loopback-bound, token-gated server; the SQLite substrate with thirteen migrations and
an append-only `events_raw` table; JSONL corpus ingest with replay-on-startup and
tail-follow polling that re-reads only new bytes; the persisted subagent DAG; the cost
engine, including dated per-model pricing, compaction repricing and a delegation-savings
estimate; the hook receiver and its installer; the SSE realtime hub; seven read
endpoints; and all four dashboard views (live status, session tree, global DAG, cost
flow) plus a per-session cost-analysis panel.

The three P0 reconciliation proofs run green in CI on every push and pull request — Σ
tokens against an independently-written reader, a byte-identical double replay, and the
DAG rebuilt from JSONL alone after a simulated outage — alongside a 12-scenario negative
catalogue. Calling them *merge-blocking* would be one word too strong: blocking a merge
takes a branch-protection rule on `main`, that rule is an owner action, and it was still
unset at the last check recorded in [`RELEASE.md`](RELEASE.md). The proofs fail the run;
they do not yet stop the button.

Retention is deliberately half-built. The mechanism — pruning, an audit journal,
backup-file expiry, a runner — is implemented and covered by tests, but the *policy*,
meaning how many days of what is kept, is unset pending a decision about how a
retention TTL can coexist with an append-only substrate. The shipped default is a
no-op and no runner is started at boot, so an unconfigured deployment keeps everything
and grows without bound.

The design spine came first and still governs: ten canonical decisions (CD-1…CD-10), a
75-work-package development plan, a 44-page docs corpus, and a Phase-0 feasibility spike
that returned **CONDITIONAL GO** (CD-8). Implementation began 2026-07-11 on the decided
stack — Fastify + TypeBox, better-sqlite3, React/Vite/D3, SSE, pnpm monorepo, Node 22.
What v1.0 still waits on is enumerated in [`RELEASE.md`](RELEASE.md); the honest short
version is that most of the remaining gates are human acts, not code.

Four honesty notes, kept here deliberately rather than buried in a footnote:

- The Phase-0 numbers remain **PROVISIONAL** until they are ratified against a
  hand-labeled corpus. Every figure derived from that spike inherits the label.
- The hierarchy-accuracy exit gate — ≥95% accuracy over at least 52 hand-labeled edges —
  currently reports **NOT CERTIFIED at n = 0**. No session has been labeled, so parser
  accuracy on real data is unmeasured rather than merely unproven, and the test run
  prints that sentence instead of a score it cannot compute.
- **"Under 30 seconds to understand a session"** is the goal the UI was drawn against.
  Nobody has ever timed it. It is an intention, not a result.
- The roadmap's kill checkpoints KC-0 and KC-1 both **passed unmet**. Work continues by
  explicit owner override, not because the gates were satisfied.

## What it refuses to report

The recurring design decision in this codebase is what to do when a number is not
known, and the answer is always the same: say nothing rather than say zero.

`GET /api/health` carries four optional fields — cumulative ingest skips, the boot
ingest phase, the duration of the last completed corpus pass, and the count of
cross-session usage collisions — and each of them is **omitted** when the underlying
seam is absent or has not yet produced a reading. A `lastTickDurationMs` of `0` would
read as "the poll is instant", which is the wrong fact, not a harmless placeholder; an
absent field says "no pass has finished yet", which is the right one. The response
schema is `additionalProperties: false`, so nothing can be quietly slipped in
alongside.

The same rule shapes ingest. A corpus file that cannot be read is counted as a skip
with its reason and its errno rather than dropped silently, because a skipped file
freezes that session's dollar totals and an operator comparing two sessions needs to
know it happened without going to the logs. A subagent with no resolvable spawn parent
becomes an orphan with no edge; a parent is never fabricated to make the tree look
complete. Delegation savings is rendered with a `~`, an explicit estimate badge and the
named hypothetical model, because it is a counterfactual about a run that never
happened, and the subagents with no resolvable top-tier model are excluded from it and
counted next to it rather than guessed at. A savings figure quietly computed over a
subset is the same class of lie as a silent `$0`.

## Where to read further

- Entry point for the full picture: [`docs/analysis/PROJECT-STATE-2026-07-06.md`](docs/analysis/PROJECT-STATE-2026-07-06.md)
- Decision spine: [`docs/analysis/`](docs/analysis/) · rival evidence: [`docs/due-diligence/`](docs/due-diligence/)
- Public docs corpus (44 pages, 13 ADRs): [`docs/site/`](docs/site/)
- Live tracker: [`TODO.md`](TODO.md) · milestones: [`DONE.md`](DONE.md)

## Security posture (non-negotiable)

Loopback-only bind (`127.0.0.1`) · no browser-driven subprocess spawner ·
mandatory auth token or the server refuses to start · same-origin SSE · no SSRF ·
remote access via SSH/Tailscale tunnel only · SQLite WAL, with a daily backup timer
(24 h, expiring at 14 days but never below the newest 7 files — all three numbers
PROVISIONAL) and a restore path that refuses any image failing
`PRAGMA integrity_check`.

The ingest side is read-only against `~/.claude/projects` by construction: the
filesystem port exposes no write, rename, unlink or open-for-write operation at all,
so the live corpus that Claude Code is actively appending to cannot be perturbed by
the dashboard even by accident.

## Delivery bar

**100% test coverage — statements, branches, functions and lines — pinned in all five
packages** (`packages/shared`, `packages/core`, `packages/test-fixtures`,
`apps/server`, `apps/web`), with zero coverage-ignore pragmas anywhere under `src/`
and guard tests that fail the build if one appears. Last local full run: **106 test
files, 1554 tests, 100% on all four axes in every package** (2026-08-15; the figure
moves as the tree does). CI runs the same command on every push and pull request, so a
regression turns the run red — though see the branch-protection caveat above for what
"gated" does and does not currently mean.

Badges are backed by real signals only, which is why there is no coverage badge here:
one would have to be generated from a run, and a hand-written 100% shield is exactly
the kind of decoration this project refuses.

The docs corpus is set up to publish to GitHub Pages from `docs/`, but **the site is
not live.** Turning Pages on is a one-time owner action (Settings → Pages → Source:
"GitHub Actions"); a workflow token can deploy to an existing Pages site but cannot
create one, and the workflow proved it twice with `Create Pages site failed. Error:
Resource not accessible by integration`. Until that click happens, every run of the
docs workflow fails at the Configure Pages step — loudly, rather than deploying
nowhere. Read the corpus in the repository under [`docs/`](docs/) meanwhile.

## Support

agenthropic is built and maintained in my own time. If it's useful to you, please
consider supporting its continued development — every tip is genuinely appreciated.

- **[GitHub Sponsors](https://github.com/sponsors/IvanBBaev)** — one-off or
  recurring, with no platform fee taken out (the preferred option).
- **[Ko-fi](https://ko-fi.com/ivanbbaev)** — quick one-off support; it also
  accepts **PayPal**, so it's the fallback for anyone without a GitHub account.
- **[Donate (Donatree)](https://donatr.ee/ivanbbaev/)** — a no-account donation
  page (card, PayPal and more) for a one-off tip.

[![Sponsor on GitHub](https://img.shields.io/badge/Sponsor-GitHub-ea4aaa?style=flat-square&logo=githubsponsors&logoColor=white)](https://github.com/sponsors/IvanBBaev)
[![Support on Ko-fi](https://img.shields.io/badge/Ko--fi-Support-ff5e5b?style=flat-square&logo=kofi&logoColor=white)](https://ko-fi.com/ivanbbaev)
[![Donate via Donatree](https://img.shields.io/badge/Donate-Donatree-22c55e?style=flat-square&logo=liberapay&logoColor=white)](https://donatr.ee/ivanbbaev/)
