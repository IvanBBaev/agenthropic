# agenthropic

A self-hosted, local-first dashboard for observing and visualising **Claude Code
agent and subagent activity** — real sessions, on your own machine, with no cloud
dependency and no telemetry egress.

It reads the JSONL transcripts under `~/.claude/projects` as the **primary source
of truth** (lifecycle hooks are a liveness signal, reconciled against the JSONL —
decision CD-1), appends everything into an immutable SQLite substrate, and renders
the **persisted subagent DAG** with **dollar-accurate cost attribution** (tokens ×
dated price — token counts are read from the JSONL, never inferred).

## Status

🚧 **Pre-code.** The design, ten canonical decisions (CD-1…CD-10), a 75-work-package
development plan and a 44-page docs corpus exist; **no application code yet** — by
design, production code is gated on the Phase-0 feasibility spike's GO verdict
(CD-8). The stack is decided pending final sign-off: Fastify + TypeBox,
better-sqlite3, React/Vite/D3, SSE, pnpm monorepo, Node 22.

- Entry point for the full picture: [`docs/analysis/PROJECT-STATE-2026-07-06.md`](docs/analysis/PROJECT-STATE-2026-07-06.md)
- Decision spine: [`docs/analysis/`](docs/analysis/) · rival evidence: [`docs/due-diligence/`](docs/due-diligence/)
- Public docs corpus (44 pages, 13 ADRs): [`docs/site/`](docs/site/)
- Live tracker: [`TODO.md`](TODO.md) · milestones: [`DONE.md`](DONE.md)

## Security posture (non-negotiable)

Loopback-only bind (`127.0.0.1`) · no browser-driven subprocess spawner ·
mandatory auth token or the server refuses to start · same-origin SSE · no SSRF ·
remote access via SSH/Tailscale tunnel only · SQLite WAL with tested backups.

## Delivery bar

>90% test coverage (CI-gated) · README badges + donation · GitHub Pages docs site.
