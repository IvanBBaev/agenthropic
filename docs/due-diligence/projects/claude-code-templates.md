# davila7/claude-code-templates — **C** (for this need)

**Panel:** not mentioned · **Independent:** **C** *(for Ivan's need)* · **Role: the
baseline to differentiate against.**

**The tool the reports missed.** At **28.4k★ / MIT / actively maintained**, its very
existence refutes the panel's "no feature-rich + multi-maintainer + >1k★ tool exists"
thesis as literally written (see [../market-landscape.md](../market-landscape.md)).

## What it actually is

- A real **`npx claude-code-templates --analytics`** live web dashboard (Express, port
  **:3333**).
- Reads `~/.claude` JSONL directly, watched live with **chokidar**.
- **Zero-install, no Docker** — the best developer-experience bar in the set.
- **MIT + real LICENSE.**

## Why it still isn't the answer

- **No subagent DAG.** Subagent view is a **flat leaderboard / timeline**
  (`AgentAnalyzer.js`) — no parent→child graph.
- **No persistence.** In-memory TTL cache only; nothing survives a restart, so no
  historical / time-series analysis.
- **No dollar-cost attribution.**
- **No Telegram / alerting.**
- Binds **0.0.0.0**, no auth.

## Why it matters anyway

It is the honest **market baseline**: it already nails self-hosted + zero-install +
live token attribution — the table stakes. `agenthropic`'s moat is precisely the four
things it lacks: the **persistent per-instance DAG + dollar cost + persistence +
Telegram alerting**. Position and benchmark `agenthropic` against this tool's feature
set, not against an imaginary vacuum.

## Verdict

Not a base and not a competitor to fork — but the reference UX/feature bar to clear,
and proof the market gap is narrow-but-real. **C** for Ivan's specific need.
