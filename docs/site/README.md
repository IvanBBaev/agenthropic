# agenthropic — documentation site (content root)

Tool-agnostic Markdown source for the public GitHub Pages docs site. The generator
(VitePress / Docusaurus / MkDocs) is **deferred** — content here is plain CommonMark so
it can be authored and reviewed before the generator is chosen (see
[`../DOCS-PLAN.md`](../DOCS-PLAN.md) `DOC-P1`). Assembly (nav, theme, publish) happens
later without touching page content.

> **The app binds `127.0.0.1` only. These docs are the sole public surface.** Nothing here
> may instruct a reader to bind `0.0.0.0`, expose the port, or add a spawner.

> **Update — 2026-07 (as built).** This corpus was written **before any application code
> existed**. Implementation began **2026-07-11** (by explicit owner override of the CD-8
> no-code-before-Phase-0 gate), so pages that describe agenthropic as "pre-code" or
> "bootstrap phase" are design history, not current truth. What runs today: the
> loopback-bound, token-gated Fastify server; the SQLite/WAL substrate with a migration
> runner; JSONL corpus ingest with replay-on-startup; the persisted subagent DAG; the cost
> engine (compaction repricing + delegation savings); the hook receiver; the SSE realtime
> hub; the read API; and all four dashboard views (live status, session tree, global DAG,
> cost/Sankey). **72 test files / 879 tests pass**, with coverage gated >90% in every
> shipped package (`packages/test-fixtures` is a deliberate, documented exclusion).
>
> Three things are **not** true of the running system, and every affected page below now
> says so: there are only **four real hooks** (`UserPromptSubmit`, `Stop`, `SubagentStop`,
> `PreCompact`) rather than twelve, and `SubagentStart` does not exist; there is **no
> separate Normalizer→Projection pipeline** — JSONL parses straight into the projections in
> one transaction per session, and `events_raw` holds hook events only; and **v2.0 alerting
> (Telegram) is not started and may never start** — it is entered only via KC-5, and its
> operator-alerts API and UI (WP-A8/A9) were cut outright.
>
> Two honesty caveats stand across the whole corpus: the Phase-0 spike numbers remain
> **PROVISIONAL** until ratified against a hand-labeled corpus, and the v1.0 "<30s to
> understand a session" usability claim is **unmeasured**. Kill checkpoints **KC-0 and KC-1
> both passed unmet** — work continues by explicit owner override, not because the gates
> were satisfied. See [`guide/roadmap.md`](guide/roadmap.md) for the full checkpoint record.
>
> Amendment convention (how pages are corrected without erasing the design record):
> [`STYLE-GUIDE.md`](STYLE-GUIDE.md) § "As-built amendments".

> **On the generator.** Still deferred (`DOC-P1` / ADR-0013) — but the corpus **does**
> publish: `.github/workflows/pages.yml` renders it with the stock GitHub Pages Jekyll
> builder, adding zero dependencies. Its source root is `docs/`, not `docs/site/`, because
> the site tree cross-links heavily into `../analysis/` and `../due-diligence/`. **Pages is
> not yet enabled on the repository** (Settings → Pages → Source: "GitHub Actions" — an
> owner action), so the deploy job fails by design rather than pretending to succeed.

## Site map

| Section | Page | File |
|---|---|---|
| Guide | What is agenthropic | [guide/what-is-agenthropic.md](guide/what-is-agenthropic.md) |
| Guide | The moat — why build | [guide/the-moat.md](guide/the-moat.md) |
| Guide | Comparison vs the field | [guide/comparison.md](guide/comparison.md) |
| Guide | Roadmap | [guide/roadmap.md](guide/roadmap.md) |
| Guide | FAQ | [guide/faq.md](guide/faq.md) |
| Architecture | Overview | [architecture/overview.md](architecture/overview.md) |
| Architecture | Data model | [architecture/data-model.md](architecture/data-model.md) |
| Architecture | Hook ingestion | [architecture/hooks.md](architecture/hooks.md) |
| Architecture | Ingest & reconciliation | [architecture/ingest-reconciliation.md](architecture/ingest-reconciliation.md) |
| Architecture | The DAG moat | [architecture/dag-moat.md](architecture/dag-moat.md) |
| Architecture | Cost model | [architecture/cost-model.md](architecture/cost-model.md) |
| Architecture | Glossary & reference | [architecture/glossary.md](architecture/glossary.md) |
| Security | Security model | [security/model.md](security/model.md) |
| Security | Threat model | [security/threat-model.md](security/threat-model.md) |
| Security | Remote access | [security/remote-access.md](security/remote-access.md) |
| Operations | Backup & restore | [operations/backup-restore.md](operations/backup-restore.md) |
| Operations | Troubleshooting | [operations/troubleshooting.md](operations/troubleshooting.md) |
| Contributing | Overview | [contributing/index.md](contributing/index.md) |
| Contributing | Testing & quality | [contributing/testing.md](contributing/testing.md) |
| Contributing | Licensing & provenance | [contributing/licensing.md](contributing/licensing.md) |
| Contributing | Decisions (ADRs) | [contributing/decisions/README.md](contributing/decisions/README.md) |
| Contributing | Governance | [contributing/governance.md](contributing/governance.md) |
| Usage _(written pre-code; amended as-built)_ | Getting started | [usage/getting-started.md](usage/getting-started.md) |
| Usage | Hooks installer | [usage/hooks-installer.md](usage/hooks-installer.md) |
| Usage | Configuration | [usage/configuration.md](usage/configuration.md) |
| Usage | Using the dashboard | [usage/dashboard.md](usage/dashboard.md) |
| Usage | API reference | [usage/api.md](usage/api.md) |
| Usage _(**not built** — v2.0, entered only via KC-5)_ | Telegram alerts | [usage/telegram.md](usage/telegram.md) |

Authoring conventions: [`STYLE-GUIDE.md`](STYLE-GUIDE.md). Decomposition &
per-page scope: [`../DOCS-PLAN.md`](../DOCS-PLAN.md). Design basis:
`docs/ai/DESIGN.md` (internal, kept local-only — not published in this repo).
