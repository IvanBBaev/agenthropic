# agenthropic

<!-- badges:start -->

[![CI](https://img.shields.io/github/actions/workflow/status/IvanBBaev/agenthropic/ci.yml?branch=main&style=flat-square&logo=githubactions&logoColor=white&label=CI)](https://github.com/IvanBBaev/agenthropic/actions/workflows/ci.yml)
![Node](https://img.shields.io/badge/node-22-5FA04E?style=flat-square&logo=nodedotjs&logoColor=white)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue?style=flat-square)](LICENSE)

<!-- badges:end -->

A self-hosted, local-first dashboard for **Claude Code agent and subagent activity**:
which agents ran, who spawned whom, and what each one cost. It runs on your own machine,
with no cloud dependency and no telemetry.

It reads the JSONL transcripts under `~/.claude/projects` as the source of truth and
stores them in SQLite. On top of that it shows two things:

- the **persisted subagent DAG**: every subagent is a queryable row with its parent, not a
  tree rebuilt in the browser;
- **dollar-accurate cost**: tokens read from the transcripts (never estimated) × a dated
  price per model.

Lifecycle hooks are optional. They only report liveness (working, waiting, completed) and
can never create or re-parent a node.

## Quickstart

agenthropic is not on npm. You clone it and run it from source. It needs **Node 22**
(only 22) and pnpm through corepack.

```sh
git clone https://github.com/IvanBBaev/agenthropic.git && cd agenthropic
nvm use && corepack enable && pnpm install
mkdir -p ~/.config/agenthropic && (umask 077 && openssl rand -hex 32 > ~/.config/agenthropic/token)
echo 'export DASHBOARD_TOKEN="$(cat ~/.config/agenthropic/token)"' >> ~/.zshrc && source ~/.zshrc
pnpm start
```

Then open <http://127.0.0.1:7341> and paste the token (`echo "$DASHBOARD_TOKEN"`). The
browser keeps it in `sessionStorage` only, so you paste it again after closing the tab.
`pnpm start` builds the dashboard and serves it and `/api` from one loopback process.

The token is mandatory (at least 16 characters); the server refuses to start without it.
It lives in your shell profile because the hooks must see the same value as the server.
Otherwise every hook delivery gets a 401, and you are never told.

**Next steps:**

- [Running guide](docs/site/guide/running.md): every environment variable, the launchd
  service, the hot-reload developer path, and troubleshooting.
- Wire the hooks, so agents can show `completed`:
  `node hooks/install.mjs --out /path/to/project/.claude/settings.json` (`--dry-run` to
  preview). See [the hooks installer](docs/site/usage/hooks-installer.md).
- [Using the dashboard](docs/site/usage/dashboard.md) and the
  [API reference](docs/site/usage/api.md).

## Why hooks matter

Reading a transcript proves that activity happened. It never proves that the activity
stopped. So ingest only ever writes `working`. `SubagentStop` turns a subagent
`completed`, and `Stop` turns a main agent `waiting`. Without hooks, an agent ages to
`unknown` after the watchdog window (default 10 minutes). The dashboard does not claim an
ending that nobody observed.

## What it refuses to report

When a number is not known, agenthropic says nothing rather than zero:

- A health field that has no reading yet is **omitted**, not set to `0`.
- An unreadable transcript is counted as a skip, with its reason.
- A subagent whose spawn parent cannot be resolved stays an **orphan**. No parent is
  invented to make the tree look complete.
- Tokens for a model with no price row are counted as **unpriced**, not priced at `$0`.
- Delegation savings are marked as an estimate (`~`). Subagents that cannot be compared
  are excluded and counted next to the estimate.

## Status

**Pre-1.0, not released.** The version is `0.3.0`, and there are no tags and no published
packages. v1.0 is planned for 2026-12-01. The checklist it must pass is
[`RELEASE.md`](RELEASE.md), and the change log is [`CHANGELOG.md`](CHANGELOG.md).

What runs today:

- token-gated loopback server;
- SQLite in WAL mode, with daily backups and a verified restore;
- JSONL replay and tail-follow ingest;
- the subagent DAG;
- the cost engine, with dated pricing and an operator pricing CLI;
- the hook receiver and its installer;
- SSE live updates;
- the dashboard: live status, session tree, global DAG, cost flow.

An opt-in Telegram alerting core is in the tree. It is off unless
`DASHBOARD_ALERTS_CONFIG` is set.

Honest limits:

- Spike-derived accuracy numbers are **PROVISIONAL**. The hierarchy-accuracy gate is
  **NOT CERTIFIED**, because no session has been hand-labelled.
- "Under 30 seconds to understand a session" is the design goal. It has never been timed.
- CI requires the `ci` check on `main`. This blocks merges by contributors but not direct
  pushes by the sole maintainer
  ([why](docs/site/contributing/decisions/README.md#a-standing-correction-merge-blocking)).

## Security

- Binds `127.0.0.1` only; this cannot be configured.
- No browser-driven subprocess spawner.
- The auth token is mandatory and compared in constant time.
- The SSE stream checks the request origin.
- No outbound network calls, except the opt-in Telegram sink.
- Remote access only through an SSH or Tailscale tunnel.

agenthropic never writes to the transcripts: the filesystem port it reads them through has
no write operation at all.

Report vulnerabilities as described in [`SECURITY.md`](SECURITY.md). For the full model,
see [security/model.md](docs/site/security/model.md).

## Documentation

- Docs site: <https://ivanbbaev.github.io/agenthropic/>. The source is in
  [`docs/site/`](docs/site/).
- Contributing: [`CONTRIBUTING.md`](CONTRIBUTING.md).
- Design record: [`docs/analysis/`](docs/analysis/), entry point
  [`PROJECT-STATE-2026-07-06.md`](docs/analysis/PROJECT-STATE-2026-07-06.md).
- Tracker: [`TODO.md`](TODO.md). Milestones: [`DONE.md`](DONE.md).

## Support

agenthropic is built in my own time. If it is useful to you, you can support it:

- **[GitHub Sponsors](https://github.com/sponsors/IvanBBaev)**: preferred, no platform fee.
- **[Ko-fi](https://ko-fi.com/ivanbbaev)**: also accepts PayPal.
- **[Donatree](https://donatr.ee/ivanbbaev/)**: no account needed.

[![Sponsor on GitHub](https://img.shields.io/badge/Sponsor-GitHub-ea4aaa?style=flat-square&logo=githubsponsors&logoColor=white)](https://github.com/sponsors/IvanBBaev)
[![Support on Ko-fi](https://img.shields.io/badge/Ko--fi-Support-ff5e5b?style=flat-square&logo=kofi&logoColor=white)](https://ko-fi.com/ivanbbaev)
[![Donate via Donatree](https://img.shields.io/badge/Donate-Donatree-22c55e?style=flat-square&logo=liberapay&logoColor=white)](https://donatr.ee/ivanbbaev/)
