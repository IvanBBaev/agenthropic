# agenthropic documentation

agenthropic is a self-hosted, local-first dashboard for Claude Code agent and subagent
activity. It shows the persisted subagent DAG and the dollar cost of each agent, computed
from token counts in the JSONL transcripts under `~/.claude/projects`.
[What is agenthropic](guide/what-is-agenthropic.md) explains the idea, and
[Running agenthropic](guide/running.md) gets it running.

> **The app binds `127.0.0.1` only. These docs are its only public surface.** No page here
> may tell a reader to bind `0.0.0.0`, expose the port, or add a subprocess spawner.

## Where things stand

agenthropic is **pre-1.0**. It has no tag and no published package, and v1.0 is planned
for 2026-12-01. The repository's [`RELEASE.md`](https://github.com/IvanBBaev/agenthropic/blob/main/RELEASE.md) lists what still has to
pass, and [`CHANGELOG.md`](https://github.com/IvanBBaev/agenthropic/blob/main/CHANGELOG.md) lists what changed.

What runs today:

- the loopback-only, token-gated server;
- SQLite in WAL mode, with daily backups and a verified restore;
- JSONL replay and tail-follow ingest;
- the persisted subagent DAG;
- the cost engine, with dated per-model pricing, compaction repricing, delegation savings
  and an operator pricing CLI;
- four lifecycle hooks (`UserPromptSubmit`, `Stop`, `SubagentStop`, `PreCompact`) and
  their installer;
- the SSE live stream;
- the read API;
- the dashboard: live status, session tree, global DAG, cost flow.

Retention runs under the signed v1.0 policy. Event rows expire after 90 days and backups
after 30 days, always keeping the newest 7. `token_usage` is never pruned.

An **opt-in alerting core** with a Telegram sink is in the tree. It is off unless
`DASHBOARD_ALERTS_CONFIG` is set; see [Telegram alerts](usage/telegram.md). There is no
alerts API or UI. Configuration is a JSON file.

Caveats that apply to the whole corpus:

- Phase-0 spike numbers are **PROVISIONAL**.
- The hierarchy-accuracy gate reports **NOT CERTIFIED**, because no session has been
  hand-labelled.
- The "under 30 seconds to understand a session" goal has **never been timed**.
- Kill checkpoints KC-0 and KC-1 passed unmet. Work continued by explicit owner override;
  see [Roadmap](guide/roadmap.md).

Test and migration counts are not repeated here. They change with every commit, and the
CI log is the only place where they are always current.

Many pages were written before any code existed. Where the build turned out differently,
a page keeps its design text and carries an "as built" note on top of it. The note
convention is in [`STYLE-GUIDE.md`](STYLE-GUIDE.md).

## Site map

| Section      | Page                    | File                                                                                  |
| ------------ | ----------------------- | ------------------------------------------------------------------------------------- |
| Guide        | What is agenthropic     | [guide/what-is-agenthropic.md](guide/what-is-agenthropic.md)                          |
| Guide        | Running agenthropic     | [guide/running.md](guide/running.md)                                                  |
| Guide        | The moat — why build    | [guide/the-moat.md](guide/the-moat.md)                                                |
| Guide        | Comparison vs the field | [guide/comparison.md](guide/comparison.md)                                            |
| Guide        | Roadmap                 | [guide/roadmap.md](guide/roadmap.md)                                                  |
| Guide        | FAQ                     | [guide/faq.md](guide/faq.md)                                                          |
| Usage        | Getting started         | [usage/getting-started.md](usage/getting-started.md)                                  |
| Usage        | Hooks installer         | [usage/hooks-installer.md](usage/hooks-installer.md)                                  |
| Usage        | Configuration           | [usage/configuration.md](usage/configuration.md)                                      |
| Usage        | Using the dashboard     | [usage/dashboard.md](usage/dashboard.md)                                              |
| Usage        | API reference           | [usage/api.md](usage/api.md)                                                          |
| Usage        | Telegram alerts (opt-in) | [usage/telegram.md](usage/telegram.md)                                              |
| Architecture | Overview                | [architecture/overview.md](architecture/overview.md)                                  |
| Architecture | Data model              | [architecture/data-model.md](architecture/data-model.md)                              |
| Architecture | Hook ingestion          | [architecture/hooks.md](architecture/hooks.md)                                        |
| Architecture | Ingest & reconciliation | [architecture/ingest-reconciliation.md](architecture/ingest-reconciliation.md)        |
| Architecture | The DAG moat            | [architecture/dag-moat.md](architecture/dag-moat.md)                                  |
| Architecture | Cost model              | [architecture/cost-model.md](architecture/cost-model.md)                              |
| Architecture | Glossary & reference    | [architecture/glossary.md](architecture/glossary.md)                                  |
| Security     | Security model          | [security/model.md](security/model.md)                                                |
| Security     | Threat model            | [security/threat-model.md](security/threat-model.md)                                  |
| Security     | Remote access           | [security/remote-access.md](security/remote-access.md)                                |
| Operations   | Backup & restore        | [operations/backup-restore.md](operations/backup-restore.md)                          |
| Operations   | Troubleshooting         | [operations/troubleshooting.md](operations/troubleshooting.md)                        |
| Contributing | Overview                | [contributing/index.md](contributing/index.md)                                        |
| Contributing | Testing & quality       | [contributing/testing.md](contributing/testing.md)                                    |
| Contributing | Licensing & provenance  | [contributing/licensing.md](contributing/licensing.md)                                |
| Contributing | Decisions (ADRs)        | [contributing/decisions/README.md](contributing/decisions/README.md)                  |
| Contributing | Governance              | [contributing/governance.md](contributing/governance.md)                              |

## How this site is built

This page and the rest of `docs/site/` are plain CommonMark.
[`.github/workflows/pages.yml`](https://github.com/IvanBBaev/agenthropic/blob/main/.github/workflows/pages.yml) publishes them at
<https://ivanbbaev.github.io/agenthropic/> with the stock GitHub Pages Jekyll builder,
which adds no dependency to the repository. The workflow's source root is `docs/`, so
links into `../analysis/` and `../due-diligence/` resolve on the site too. Choosing a
dedicated generator (`DOC-P1`, ADR-0013) is deferred.

Authoring conventions: [`STYLE-GUIDE.md`](STYLE-GUIDE.md). Per-page scope:
[`../DOCS-PLAN.md`](../DOCS-PLAN.md).
