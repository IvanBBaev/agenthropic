# Market Landscape & Selection Bias

## The panel's blind spot

The reports frame the market as "only tiny single-maintainer projects; no Grafana of
Claude Code exists." That framing is broken by popular, MIT-licensed, actively
maintained tools the reports **never mention**:

| Missed tool | Stars | What it is | Why it still isn't the answer |
|---|---|---|---|
| **davila7/claude-code-templates** | 28.4k, MIT | Real `npx claude-code-templates --analytics` live web dashboard; reads `~/.claude` JSONL; zero-install; no Docker | Flat subagent **leaderboard, no DAG**; no dollar cost; **no persistence** (in-memory TTL cache); no Telegram; binds 0.0.0.0 |
| **jarrodwatts/claude-hud** | 26.1k, MIT | Literally "see which **subagents** are running" | In-terminal statusline HUD; single-session; not a historical web cockpit |
| **ccusage** | 16.8k, MIT | The de-facto token/cost tool for Claude Code | CLI report, not a cockpit — but it undercuts the report's praise of cast as capturing cost "no one else does" |

See [projects/claude-code-templates.md](projects/claude-code-templates.md) for the
full deep-dive on the most relevant of these.

## Honest reading of the thesis

- **As literally written** — "no feature-rich AND multi-maintainer AND >1k★ option
  exists" — the thesis is **false**. claude-code-templates is all three.
- **Narrowed** — "no *DAG cockpit* (per-instance orchestration graph + dollar cost +
  persistence + alerting) that is also multi-maintainer and popular" — the thesis
  **survives**. That is the real, defensible gap.

## The market gap that justifies building

No tool in the surveyed set — including the popular ones the panel missed — delivers
all of:

1. **Global, persistent, per-instance subagent orchestration DAG** (not a
   session-scoped, render-time-derived tree).
2. **Dollar-cost attribution + delegation-savings**, surfaced live.
3. **Telegram alert sink** (→ @baev_bot_bot).
4. **Cross-machine / fleet aggregation.**
5. **Persistence you own** for historical/time-series analysis.

claude-code-templates is the honest **baseline to differentiate against**: it already
nails self-hosted + zero-install + live token attribution. The OPCⁿ moat is precisely
the DAG + dollar-cost + persistence + Telegram it lacks. Building `agenthropic` is
justified — but the pitch is "the persistent DAG cockpit," not "the first Claude Code
dashboard."

## Implication for `agenthropic`

- Don't position against a vacuum; position against claude-code-templates' feature set
  and beat it on the five gaps above.
- Reuse its proven pattern (chokidar watch over `~/.claude` JSONL, zero-install DX) as
  a UX bar to clear.
