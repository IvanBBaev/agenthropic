# agenthropic: Senior PM review (2026-10-29)

> Part of the [role reviews of 2026-10-29](README.md) — lens: **Senior Product Manager (PRD)**. Independent senior reviewer, read-only, on `main` at `db3f042`. Findings are de-duplicated and scheduled in [10-synthesis.md](10-synthesis.md).

## 1. Verdict

Engineering-wise, agenthropic is an unusually rigorous build: 195 test files and 3757 tests, 100% coverage in five packages, P0 moat proofs in CI, and a security posture that holds up. As a product it has **zero evidence of use by its one user**. The repo contains a 94 KB `data/agenthropic.db` last written 2026-07-13. No server is listening, no launchd unit exists, and agenthropic's hooks are not in `~/.claude/settings.json`. The model the owner used most heavily in the last 14 days (`claude-sonnet-5-5`, about 1,119 occurrences) was unpriced until 2026-10-28, so those sessions were refused at the pricing gate. Nobody noticed, which only makes sense if nobody was looking. The market has also moved. Claude Code's first-party OpenTelemetry now exports `agent_id`, `parent_agent_id` and per-request `cost_usd`, and agents-observe ships a parent/subagent hierarchy with persistence. So the "nobody has the DAG with dollars" premise is weaker than it was in July and has still never been tested hands-on. The governance (kill checkpoints KC-0…KC-5) is now theatre: every gate tied to demand evidence was overridden, and only gates the agents can satisfy were met.

**Product readiness for v1.0: 4/10.** Engineering readiness is about 9/10. Evidence of value is about 1/10.

## 2. What is strong

- **The engineering bar is real.** It is not just a coverage number. The P0 proofs are Σ-token reconciliation against an independent reader, a byte-identical double replay, a DAG rebuilt from JSONL alone, and the five questions answered over real HTTP. The D15 demo (PR #2, red CI, closed unmerged) shows the gate actually bites.
- **The security posture is a true differentiator:** loopback-only bind, a mandatory timing-safe token, no spawner, no SSRF, and SSE same-origin. claude-code-templates offers `--tunnel` through Cloudflare, so this contrast holds.
- **The project is honest with itself.** The red-team doc, the "NOT CERTIFIED at n = 0" label, the PROVISIONAL tags, and `comparison.md` admitting "No rival was ever installed" are rare self-candour.
- **The data model choice was right.** JSONL as the ground truth, agents as first-class rows with `parent_agent_id`, and dated pricing.
- **The remaining work is cleanly cut** (`branch-lanes-2026-10-28.md`). Every open item is clearly named as needing Ivan's own act. Nothing is hidden.

## 3. Findings

| ID | Sev | Finding | Evidence | Recommendation | Effort | Verdict |
|---|---|---|---|---|---|---|
| PRD-1 | P0 | **The product is not being used.** No running instance, no service unit, no hooks installed. The only DB is 94 KB, written in July. "Code-complete" has been confused with "delivering value". | `ls data/` (mtime Jul 13; shm Aug 30); `lsof :4317` empty; `~/.claude/settings.json` hooks list only `usage-monitor.js` and `secret-guard.js`; `docs/site/guide/running.md` mentions launchd but nothing ships | Before anything else: run it as an always-on launchd service on the Mac Mini against the real corpus and a real DB, install the hooks, and bookmark it. That is the precondition for every measurement below. | S | CONFIRMED |
| PRD-2 | P0 | **The friction log, rival trial and stopwatch run were all never done.** Templates exist; all three files carry EMPTY or UNSIGNED banners. These are the only evidence that v1.0 answers the five daily questions. | `docs/measurement/friction-log.md`, `rival-dashboard-2026-10.md`, `time-to-understand-log.md`; red-team §6 "Still never run" | Do them in the next 14 days (§5). If one is not done, write a dated waiver in RELEASE §0 and say "unmeasured" in the release notes. | M | CONFIRMED |
| PRD-3 | P0 | **The moat is held hostage by the price table.** An unknown model id halts the session at the cost gate, so the DAG and tokens for that session disappear too, not just the dollars. Every Anthropic model launch blanks the dashboard until a migration ships. It happened in Sept (52 of 60 sessions refused: opus-5, fable-5-1) and again in Oct (sonnet-5-5). `claude-haiku-5-5` is deliberately unseeded, yet "how much did Haiku routing save" is daily question Q4. | `time-to-understand-log.md` §0 prerequisite; WORKLOG 2026-10-28 L7 entry; commit `db3f042`; `cost-model.md` | Decouple: ingest tokens and the DAG always, and show cost as "unpriced model X" instead of refusing the session. Allow a user-local pricing override file without needing a migration. Seed Haiku 5.5's base tier, flagged for prompts over 100k. | M | CONFIRMED (the mechanism is documented; Haiku 5.5 usage is PLAUSIBLE) |
| PRD-4 | P1 | **The value proposition is unvalidated against today's alternatives.** First-party OTel now carries `agent_id`, `parent_agent_id`, `agent.name`, `query_source`, and per-request `cost_usd` and tokens. The comparison page dates from 2026-07-03 and admits it is source-reading, not use. | code.claude.com monitoring-usage; `docs/site/guide/comparison.md` "Update — 2026-07" note 2 | Re-scope the claim to what only agenthropic does: zero-infrastructure, loopback-only, persisted across restarts, built from JSONL ground truth, and works without enabling telemetry. Re-date the comparison page after the L2 trial. | S | CONFIRMED |
| PRD-5 | P1 | **Governance is theatre.** KC-0 and KC-1 were overridden. KC-5 was overridden to build v2 alerts with no v1 use. The analysis freeze held, but the four overrides were all "keep building". Every gate that needed the owner's own act failed; every gate agents could satisfy passed. | `TODO.md` override blocks (07-11, 07-18, 07-29, 10-24); KC table | Keep KC-4 as the only gate that matters, and make it about use, not code (§6). Retire default-death wording that is never executed, or keep it and actually honour it. Either is fine; the mix is not. | S | CONFIRMED |
| PRD-6 | P1 | **Scope creep: v2 alerting** (a Telegram sink, migration 23, about 220 tests, four hardening commits) was built before one day of v1 use. It now ships dark and is ongoing maintenance and attack surface (the only outbound exception in the spawner gate). | WORKLOG 2026-10-24 → 10-28; RELEASE §4; roadmap §6 "Entry = KC-5, and KC-5 only" | Freeze it: no further alert work (lane L11) until the friction log records ≥3 "wanted an alert? yes" entries. | S | CONFIRMED |
| PRD-7 | P1 | **Effort goes to documentation upkeep, not use.** About 299k words of docs against about 33k lines of non-test TypeScript. Test-count "truth passes" ripple through 7+ pages per change. The README quickstart carries "AMENDED 2026-09-23 (J-1)" archaeology. | `find docs -name '*.md' \| xargs wc -w`; commits `ba4aaa8` and `a5e3197`; README lines 25–40 | Stop the count chains: one generated number in one place. Strip the amendment history from user-facing pages (README, guide) into CHANGELOG or decision docs. | M | CONFIRMED |
| PRD-8 | P1 | **LABEL-ME (60 claims) is still unfilled.** The hierarchy accuracy, which is the headline moat, is "NOT CERTIFIED at n = 0". Lane L4 (dropping PROVISIONAL across 62 files) waits on it and needs an exclusive window. | `branch-lanes` L3/L4; `comparison.md` | Block 2 × 2 h for it. If not done by 11-16, ship with "hierarchy accuracy unmeasured" and skip L4. | M | CONFIRMED |
| PRD-9 | P2 | **The cost framing may not match the owner's real pain.** His own hook (`usage-monitor.js`) targets rate limits and concurrency (ITPM/RPM), not dollars. If he is on a subscription, "$ per agent" is a notional number. | `~/.claude/hooks/usage-monitor.js` header | Ask the owner (Q2). If rate limits are the pain, a "tokens per minute by concurrent agents" view is a v1.x candidate with a real ticket. | S | PLAUSIBLE |
| PRD-10 | P2 | **The OSS posture is unclear.** The repo is public with MIT, a Pages site and an npm name-holder, but it is run-from-source with Node 22 only. There are no adopters and no launch plan. Rivals already have hundreds of stars (agents-observe 712) and 28k+ (claude-code-templates). | README Quickstart; `comparison.md` | Stay personal for v1.0. Revisit a launch only after 30 days of own use and a hands-on rival trial. If launched, ship a one-command install (`npx`, plugin, or brew service) first. | — | PLAUSIBLE |
| PRD-11 | P3 | **`main` is 5 commits ahead of origin**, and an untracked `docs/analysis/role-reviews-2026-10-29/` exists. That folder adds analysis volume despite the §8 freeze. | `git status -sb` | Push on Ivan's ask. Keep role reviews out of the corpus, or explicitly label them post-freeze verdict records. | S | CONFIRMED |

## 4. Competitive snapshot (2026-10-29)

| Alternative | Subagent tree | $ per agent | Persisted | Local / no infra | Security note |
|---|---|---|---|---|---|
| **Claude Code native OTel** (metrics, events, beta traces) | Yes, via `agent_id` and `parent_agent_id` (CC ≥ v2.1.310) | Yes, `cost_usd` per `api_request`, tagged with `agent.name` (custom names masked to "custom") | Depends on the backend | No: needs a collector plus Prometheus/Loki/Grafana or a SaaS | First-party data; opt-in env vars |
| **agents-observe** (simple10, MIT, about 712★, v0.9.7) | Yes, "which subagent was spawned by which parent" | Token and cost breakdowns since 0.9.7 (whether shown in $ is unclear) | Yes, SQLite DB kept across upgrades | Yes, local (Docker or local runtime) | Bind and auth not documented |
| **claude-code-templates** `--analytics/--agents/--chats` | Agent usage stats; no persisted DAG documented | Token tracking | Weak | Yes, `npx` | `--tunnel` (Cloudflare) public exposure |
| **ccusage** | No | Yes: daily, monthly, session and 5-hour-block cost | Reads JSONL, so effectively yes | Yes, offline CLI | Minimal surface |
| **Anthropic Console / Analytics API** | No (per user or key) | Yes, billing-grade | Yes | No (cloud) | n/a |
| **LiteLLM gateway** | Subagent attribution via IDs | Yes, budgets | Yes | Self-hosted proxy in the request path | Proxy risk |

The take: the "DAG + dollars" pair is no longer unique. OTel plus Grafana reaches it with first-party data, and agents-observe reaches most of it in one install. What remains defensible: works on historical JSONL with no telemetry enabled, persisted ground-truth reconciliation, loopback-only with no spawner and no tunnel, and zero infrastructure on a Mac Mini. That is a narrower, honest moat, good enough for a personal tool. It is not a launch story.

## 5. Critical path to v1.0.0 (owner actions, minimal)

The KC-4 deadline, 2026-12-01, is 33 days away. Nothing below is engineering except item 2.

| Date | Owner act | Time |
|---|---|---|
| **Thu 10-30** | Run agenthropic as a launchd service against the real corpus and a real DB (not the repo-relative `data/` file). Install the hooks. Write friction-log **Day 1**. | 1 h |
| **Fri 10-31** | Lane L2: install agents-observe *or* `claude-code-templates --analytics`, ask it the five questions, fill the table. (Optional: 15 min to enable OTel to a console exporter and see `parent_agent_id` for yourself.) | 1.5 h |
| **11-02 → 11-06** | Agent work, decided by you: PRD-3 (unpriced model → "cost unknown", session not refused) and seed Haiku 5.5's base tier. Lane L5: stopwatch run on five sessions, using the real always-on instance. | 1 h (you) |
| **11-08, 11-15** | Lane L3, LABEL-ME: 30 claims per sitting. If the gate is not met by 11-16, waive it in writing. | 2 × 2 h |
| **11-12** | Lane L6 BENCH-SHAPE: accept the 2026-09-09 runs (one decision). | 10 min |
| **11-12 → 11-13** | Friction-log **day 14** reading. Count the "wanted an alert" entries; that is the real KC-5 evidence. | 20 min |
| **11-16 → 11-18** | Lane L4 PROVISIONAL drop (agent, exclusive window) if LABEL-ME passed; otherwise skip it. Integrator count pass. | 0 |
| **11-19 → 11-21** | Execute RELEASE.md R3 for real on the release commit, tick the [HUMAN] boxes or write dated waivers, CHANGELOG [1.0.0]. | 2 h |
| **Mon 11-23** | **Tag v1.0.0**, then push. That leaves 8 days of buffer before KC-4. | 15 min |

**The minimum unlock** if time collapses: an always-on install, the rival trial, the stopwatch run, and written waivers for LABEL-ME and the friction log. Skipping the first three is not acceptable: tagging v1.0 of a dashboard its only user has never run against real data for two weeks would make the tag meaningless.

## 6. Recommendations mapped to the roadmap

**Before the v1.0 tag**
- PRD-1: always-on install.
- PRD-3: an unpriced model must not hide the DAG or tokens; seed Haiku 5.5's base tier.
- PRD-2: the rival trial, stopwatch run and friction log, or dated waivers.
- Re-date and re-scope `comparison.md` and `the-moat.md` against OTel `parent_agent_id` and agents-observe.
- Release notes state plainly: accuracy PROVISIONAL or unmeasured; alerts dark; KC-0 and KC-1 overridden.
- Freeze lane L11 (alert hardening).

**v1.x (each item needs a friction-log entry as its ticket)**
- A user-local pricing override file.
- Optional OTel ingest as a second source, to cross-check `cost_usd` against your own table.
- A rate-limit / concurrency view, if Q2 says that is the pain.
- A one-command service install.
- Collapse the test-count chains into one generated badge.

**v2.0**
- Only via KC-5 on real friction-log data. If the 14-day log shows fewer than 3 alert wishes, **remove** the dark alerting core in v1.1, not just leave it dark.

**Never**
- A browser-driven spawner, a public bind or tunnel, multi-user, alert CRUD UI.
- Analysis document #10 and further role reviews outside the measurement files.
- Raising coverage targets or adding gates before there is a usage gate.

**Success metrics after v1.0 (use, not code):**
- Days opened per week, at least 4 of 7 for 4 weeks.
- Questions answered by agenthropic vs by raw JSONL or rivals, from the friction log.
- Median time-to-understand under 30 s.
- Zero sessions refused for pricing.
- One decision changed by what the dashboard showed (for example, a routing change). If none happens in 60 days, go to maintenance mode.

**Stop doing:**
- Test-count truth passes across 7 pages.
- Dated "AMENDED" archaeology in user-facing docs.
- Building ahead of evidence (alerts).
- Overrides recorded as governance when they are really the default path.

## 7. Questions for the owner

1. Why has the dashboard not been run daily since July? Friction (setup, Node 22, token paste), no real need, or no time? The answer decides whether v1.0 is the right milestone at all.
2. Are you billed per API token or on a subscription plan? Your `usage-monitor.js` targets rate limits, not dollars. Which number would change your behaviour?
3. Have you looked at Claude Code's OTel `parent_agent_id` and `cost_usd`? If a 15-minute OTel setup answers 4 of the 5 questions, what is agenthropic still for?
4. Is the goal of v1.0 a personal tool or an OSS launch? If personal: drop the Pages site upkeep and star-oriented polish. If a launch: an install path and a hands-on rival comparison come first.
5. Will you commit to the 14 consecutive friction-log days starting 10-30? Or write the waiver now, so KC-4 is not decided by a streak broken on day 11?
6. If the friction log shows no alert wishes, will you remove the alerting core rather than keep it dark?
7. Should overridden KC failures be published honestly in the v1.0 release notes? The KC-4 failure branch promises a "public write-up".

Sources:
- [Claude Code docs: Monitoring usage (OpenTelemetry)](https://code.claude.com/docs/en/monitoring-usage)
- [simple10/agents-observe (GitHub)](https://github.com/simple10/agents-observe)
- [agents-observe write-up, BrightCoding (2026-08-07)](https://blog.brightcoding.dev/2026/08/07/simple10agents-observe-real-time-dashboard-for-claude-code-sessions)
- [Torii: 5 Claude Code Usage Dashboards and Monitoring Tools for 2026 (2026-06-12, updated 2026-08-19)](https://www.toriihq.com/articles/five-claude-code-usage-dashboards-and-monitoring-tools)
- [claude-code-templates analytics docs](https://docs.aitmpl.com/cli/analytics)
- [disler/claude-code-hooks-multi-agent-observability](https://docsearch.algolia.com/mcp/docs/repo/disler/claude-code-hooks-multi-agent-observability)
- [Claude-Code-Agent-Monitor (hoangsonww)](https://www.sourcepulse.org/projects/29195119)
- [What is CC Usage (ccusage)](https://www.claudelog.com/faqs/what-is-cc-usage/)
- [Better Stack: Observe Claude Code with OpenTelemetry](https://betterstack.com/docs/logs/claude-code/)

*Caveats: `gh` is not on PATH in this shell, so GitHub stars and CI state for agenthropic were not re-verified. The fresh corpus model-id scan was stopped after it timed out, so the sonnet-5-5 ×1,119 figure comes from the WORKLOG entry for 2026-10-28. Rival feature claims come from their docs and pages, not hands-on use (PLAUSIBLE where noted). No files were written or changed.*
