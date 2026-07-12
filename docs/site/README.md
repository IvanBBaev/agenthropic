# agenthropic — documentation site (content root)

Tool-agnostic Markdown source for the public GitHub Pages docs site. The generator
(VitePress / Docusaurus / MkDocs) is **deferred** — content here is plain CommonMark so
it can be authored and reviewed before the generator is chosen (see
[`../DOCS-PLAN.md`](../DOCS-PLAN.md) `DOC-P1`). Assembly (nav, theme, publish) happens
later without touching page content.

> **The app binds `127.0.0.1` only. These docs are the sole public surface.** Nothing here
> may instruct a reader to bind `0.0.0.0`, expose the port, or add a spawner.

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
| Usage _(design-target — pre-Phase-0)_ | Getting started | [usage/getting-started.md](usage/getting-started.md) |
| Usage | Hooks installer | [usage/hooks-installer.md](usage/hooks-installer.md) |
| Usage | Configuration | [usage/configuration.md](usage/configuration.md) |
| Usage | Using the dashboard | [usage/dashboard.md](usage/dashboard.md) |
| Usage | API reference | [usage/api.md](usage/api.md) |
| Usage | Telegram alerts | [usage/telegram.md](usage/telegram.md) |

Authoring conventions: [`STYLE-GUIDE.md`](STYLE-GUIDE.md). Decomposition &
per-page scope: [`../DOCS-PLAN.md`](../DOCS-PLAN.md). Design basis:
`docs/ai/DESIGN.md` (internal, kept local-only — not published in this repo).
