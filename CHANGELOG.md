# Changelog

> Dates and content in this file are derived from the git history of `main`. The project targets v1.0 on 2026-12-01.

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Nothing has been released yet, so every change below is unreleased. There are no
version tags in this repository.

## [Unreleased]

### Added

- Local-first dashboard for Claude Code agent activity: a Fastify server on loopback, SQLite in WAL mode with versioned migrations, an SSE stream and a React single-page app, built as a pnpm workspace on Node 22.
- Session ingest reads `~/.claude/projects/*.jsonl` transcripts as the ground truth for token counts; nothing is inferred from message text.
- Replay on startup rebuilds the database from the transcripts alone, persisted checkpoints stop a restart from re-reading what it already ingested, and a second replay produces a byte-identical database.
- Persisted subagent DAG: parent and child orchestration edges are stored rows over a self-referential `parent_agent_id`, not reconstructed in the browser.
- Edge provenance is recorded and stays visible: `tool_use` is observed, while `directory`, `task_notification`, `queue_operation` and `legacy_explore` are inferred, drawn differently in the dashboard behind a permanent legend.
- Agent status lifecycle with five states (working, waiting, completed, error, unknown) written by ingest, `Stop`, `SubagentStop` and a missing-Stop watchdog; an observed terminal state is sticky, and `unknown` renders as its own bucket rather than being hidden.
- Cost engine over a seeded model-pricing table, with per-session, per-agent, per-model and per-day rollups; a model with no price halts that session's ingest before any row is written, instead of recording a silent $0.
- Compaction repricing across a `PreCompact` boundary, and a delegation-savings figure that is labelled an estimate everywhere it appears.
- Per-session cost analysis computed over a read-only transcript seam, opened on demand from the cost view rather than fetched for every row.
- Authenticated read API covering health, the session list and detail, a session's subagent tree, a session's hook events, per-session cost analysis, the global cost summary and the global DAG.
- Realtime stream at `/api/stream` carrying typed `session-ingested`, `agent-status-changed` and `ingest-failed` events, plus heartbeats and a reconnect hint.
- Hook receiver at `POST /api/hooks/event` that accepts any Claude Code hook event and appends it to an append-only raw store; hooks contribute liveness only and never change the DAG.
- Hooks installer that wires `UserPromptSubmit`, `Stop`, `SubagentStop` and `PreCompact` to the loopback receiver, merging non-destructively into an existing settings file and backing that file up first.
- Web dashboard with four views (live status board, session tree, global DAG, cost flow) behind a token screen that validates the token against the server before storing it.
- Cost windows for today and the last seven days, a top-burners ranking, and unpriced tokens carried as their own figure rather than folded into the dollar total.
- Daily online database backup on a timer, with backup-file expiry that always keeps a minimum number of copies, and a restore path that has been drilled and documented.
- Retention engine: a bounded, transactional prune of the events and token-usage projections with a dry-run mode, an fsync'd cost receipt written inside the delete transaction, and a static guard proving no delete ever targets the raw event, session, agent, edge or pricing tables.
- Ingest visibility on `/api/health`: per-reason skip counters, a `replaying` or `idle` phase, the duration of the last completed corpus poll, and the number of cross-session usage collisions.
- Corpus-scale benchmark against a synthetic corpus, and a hand-labelled hierarchy annotation format whose accuracy gate uses a one-sided Wilson lower bound (n >= 52 with zero errors) and reports "substrate unavailable" instead of passing vacuously.

### Changed

- Corpus polling costs O(new bytes) instead of re-reading each transcript in full; a tail cache stores only complete-line regions, so chunked decoding stays byte-equivalent to a whole-file read and any divergence falls back to a full read rather than serving a stale prefix.
- The server binds its loopback socket before the startup replay runs, so the dashboard answers immediately and `/api/health` names the warm-up window as `replaying` while `status` stays `ok`.
- The cost summary is computed as a single rollup with a filtered priced query instead of four scans; the benchmark's worst query dropped from 627 ms to 9 ms.
- Coverage thresholds are pinned at 100% statements, branches, functions and lines across all five packages, with per-package guard tests that fail the build if a threshold is lowered or a coverage-ignore pragma reappears.
- A replay pass that ingested nothing now states which of seven distinct outcomes applied, where it previously printed nothing and made "all current", "corpus root missing" and "corpus root unreadable" look identical.
- The cost-analysis route answers its three distinct absences with three distinct messages (not configured, unreadable corpus root, unknown session), carried through to the dashboard.
- Main-agent token usage is attributed to its own agent row, so a session's totals cover the main agent and not only its subagents.

### Fixed

- Streaming turns are upserted by convergence instead of `INSERT OR IGNORE`, so a turn that grows after its first ingest is updated rather than frozen at the first value seen.
- A sender-minted delivery id separates a genuinely repeated hook firing from a redelivery of the same one, so real recurrences are no longer deduplicated away.
- Ingest failures are retried within bounds and surfaced as an `ingest-failed` event instead of being swallowed, so a quarantined session is visible in the dashboard.
- Status reconciliations produced during ingest, such as a `SubagentStop` that arrives before its agent row exists, are published to connected clients, so the interface no longer shows the stale status until a full reload.
- A session UUID appearing under more than one project slug is resolved deterministically at enumeration (the smallest slug wins) and the loser is reported as a `duplicate-session` skip, instead of being dropped by whichever file happened to have the newer mtime.
- The DAG and cost endpoints scope every identifier to the session that owns it and declare truncation with real counts, so a capped list is never presented as a complete one.

### Security

- Loopback-only bind: the host is a module constant with no configuration path, and a post-listen check terminates the process if any bound address is not loopback.
- The dashboard token is mandatory: startup fails when `DASHBOARD_TOKEN` is unset, empty, or shorter than 16 characters.
- Bearer tokens are compared in constant time, with both sides hashed to fixed-length digests first so a length difference cannot leak through timing.
- Every `/api/*` route is gated by a hook registered before any route, authorizing on the routed pattern rather than the raw URL, so a percent-encoded path cannot slip past the prefix check.
- The SSE stream enforces same origin: a foreign `Origin` is rejected with 403 before authentication is even attempted, and there is no wildcard CORS.
- Hook payloads are redacted at the ingest boundary, before the envelope and before the idempotency key is computed, by secret-bearing key name and by credential shape, so persistence never sees a raw body. Token-count fields are allowlisted so observability data survives.
- The `?token=` query parameter that `EventSource` requires on the stream URL is redacted in request logs.
- The corpus filesystem port is read-only by construction, with `O_NOFOLLOW` opens, an fstat re-check against TOCTOU, symlinks observed rather than followed, and a per-file read cap that a tail read cannot bypass; a containment violation stops the server rather than being skipped.
- Two gates run in CI: a static scan that rejects any subprocess spawner, wide bind, WebSocket server or dynamic evaluation across `apps/`, `packages/`, `scripts/` and `hooks/`, and a dependency license allowlist scan over every installed workspace package.
- The hooks installer never places the token in any process's argv (curl reads the environment at fire time), never spawns a process, and never touches the network.

### Not yet shipped

Things a reader might reasonably expect here and will not find:

- No released version and no git tag. The root `package.json` still reads `0.1.0`; the release checklist bumps it to `1.0.0` at release time.
- No npm package. Every workspace package is marked `private` and unpublished.
- No published documentation site. The GitHub Pages workflow exists and uses only official actions, but Pages has never been enabled on the repository, so every run has failed at `configure-pages`. Turning it on is a one-time owner action in the repository settings.
- No alerting and no webhooks. The alert port, rules engine and notification sinks are deliberately v2 work and are not on the v1.0 path.
- Retention is implemented but nothing runs it. There is no timer and no HTTP entry point, on purpose, until the retention policy values are signed off; the default policy is a byte-identical no-op that opens no transaction.
- The subagent-hierarchy accuracy claim is not signed off. The annotation loader and the Wilson-bound gate are built, but the hand-labelled corpus they measure against does not exist yet, so the gate reports "substrate unavailable" rather than a passing number.
