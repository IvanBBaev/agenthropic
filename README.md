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

## Status

🚧 **Pre-1.0, under active construction.** The design spine came first: ten canonical
decisions (CD-1…CD-10), a 75-work-package development plan, a 44-page docs corpus, and
a Phase-0 feasibility spike that returned **CONDITIONAL GO** (CD-8). Implementation
began 2026-07-11 on the decided stack — Fastify + TypeBox, better-sqlite3,
React/Vite/D3, SSE, pnpm monorepo, Node 22.

What runs today: the server (loopback-bound, token-gated), the SQLite substrate and
migrations, JSONL corpus ingest with replay-on-startup, the persisted subagent DAG,
the cost engine (including compaction repricing and delegation savings), the hook
receiver, the SSE realtime hub, the read API, and all four dashboard views (live
status, session tree, global DAG, cost flow). The **three P0 reconciliation proofs
are green and merge-blocking** — Σ tokens against an independently-written reader, a
byte-identical double replay, and the DAG rebuilt from JSONL alone after a simulated
outage — alongside a 12-scenario negative catalogue. What v1.0 still waits on is in
[`RELEASE.md`](RELEASE.md); the honest short version is that the remaining gates are
human ones, not code ones.

Two honesty notes, kept here deliberately rather than in a footnote: the Phase-0
numbers remain **PROVISIONAL** until they are ratified against a hand-labeled corpus,
and the roadmap's kill checkpoints KC-0 and KC-1 both passed unmet — work continues by
explicit owner override, not because the gates were satisfied.

- Entry point for the full picture: [`docs/analysis/PROJECT-STATE-2026-07-06.md`](docs/analysis/PROJECT-STATE-2026-07-06.md)
- Decision spine: [`docs/analysis/`](docs/analysis/) · rival evidence: [`docs/due-diligence/`](docs/due-diligence/)
- Public docs corpus (44 pages, 13 ADRs): [`docs/site/`](docs/site/)
- Live tracker: [`TODO.md`](TODO.md) · milestones: [`DONE.md`](DONE.md)

## Security posture (non-negotiable)

Loopback-only bind (`127.0.0.1`) · no browser-driven subprocess spawner ·
mandatory auth token or the server refuses to start · same-origin SSE · no SSRF ·
remote access via SSH/Tailscale tunnel only · SQLite WAL with tested backups.

## Delivery bar

>90% test coverage, CI-gated in every shipped package (`packages/shared`,
`packages/core`, `apps/server`, `apps/web`; `packages/test-fixtures` is a deliberate,
documented exclusion) · README badges backed by real signals only · GitHub Pages docs
site — the workflow is committed, but Pages is not yet enabled on the repository, so
that job fails by design rather than pretending to succeed.

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
