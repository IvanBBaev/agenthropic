# Independent Due-Diligence — Claude Code Agent-Observability Dashboards

**Author:** independent source-level audit (not the vendor "review panel")
**Date:** 2026-07-03
**Purpose:** Verify — and where warranted, overturn — the two "Technical Due-Diligence" reports (`v1`, `v2.0 extended`) prepared for Ivan Baev / OPCⁿ, before any adopt/fork/build decision on `agenthropic`.
**Method:** All six candidate repos were shallow-cloned and read at source by six parallel auditors. Every metric was re-pulled from the GitHub API on 2026-07-03. Where the report's claims and the source diverged, the source wins. This document does not trust the report; it grades the report.

---

## 0. TL;DR — the one finding that changes the decision

**The report's own weighted scoring model ranks `simple10` first (4.1) and `hoangsonww` second (4.0). The report then overrides its own model** with a discretionary tie-break on "Visualisation depth" (scored `hoangsonww` 5 vs `simple10` 3) to recommend `hoangsonww` as primary.

That tie-break rests on **a contestable judgment call**: the report treats `simple10` as lacking a real orchestration graph (scoring it "~" partial on "Orchestration DAG / graph" and 3-vs-5 on visualisation depth). Yet `simple10` ships `constellation/agent-tree.ts → buildAgentTree()` — a real parent→child subagent tree with drawn edges — plus a bespoke live force-directed graph. Score that axis on this evidence and the report's *own* model recommends `simple10`. *(Wording softened 2026-07-06 per the corpus audit, finding LOST-8: the "no true DAG" phrase attributed to the vendor is not verbatim in either source docx, so the earlier "factual error" characterization was stronger than the source warrants; the core argument — 4.1 vs 4.0 on the vendor's own weighted model, with a contestable override — stands.)*

Combined with independent security and code-quality findings, my recommendation **diverges from the panel**:

> **Primary base: `simple10` (fork + harden), not `hoangsonww`.** Study `hoangsonww` for its richer D3 Sankey/aggregate-DAG and its first-class Telegram provider, and graft those in. Steal `cast`'s ~50-LOC delegation-savings metric. Treat the whole category as *beta software you will own*, not adopt.

---

## 1. Fact base — what checked out, what didn't

The report's **raw facts are largely accurate** (LOC counts, table counts, feature inventories all verified within noise). Credit where due. But three cracks:

| Claim in report | Reality (2026-07-03) | Verdict |
|---|---|---|
| `simple10` metrics "blocked by API rate-limiting"; last activity 5 Jun | Returned on first call: **607★ / 58 forks / MIT**, pushed **29 Jun** | ⚠ Lazy + stale — the "verified fact base" wasn't |
| `disler` "~1,400★ / 372 forks" | **1,475★ / 385** | Minor drift |
| `disler` hook scripts "protect .env/keys" | The `.env`/key guard is **commented out** (`pre_tool_use.py:324-327`) | ❌ False as written |
| `hoangsonww` run-spawner risk = "concurrency cap 10,000" | Cap is a red herring; the real RCE lever is `bypassPermissions` mode | ❌ Wrong mechanism |
| "No feature-rich AND multi-maintainer AND >1k★ option exists" | `davila7/claude-code-templates`: **28.4k★, MIT, active, live `--analytics` dashboard** | ❌ Selection bias (see §4) |

---

## 2. Independent grades vs the panel

| Project (owner) | Panel letter (v1) | Panel weighted /5 (v2) | **My independent grade** | Move |
|---|---|---|---|---|
| **simple10/agents-observe** | B+ | **4.1 (highest)** | **A−** | ▲ upgrade |
| **hoangsonww/Claude-Code-Agent-Monitor** | A− | 4.0 | **B−** | ▼ downgrade |
| **ek33450505/claude-code-dashboard (CAST)** | B− | 3.8 | **C** | ▼ |
| **disler/…observability** | B+ | 2.7 | **C−** | ▼▼ |
| **NirDiamant/claude-watch** | C+ | 2.6 | **C+** | = |
| *davila7/claude-code-templates (missed)* | — | — | **C** *(for this need)* | new |

The panel's grades are **systematically biased toward the flashy-but-fragile** (`hoangsonww`, `disler`) and **against the disciplined** (`simple10`).

---

## 3. Per-project verdicts (source-level)

### simple10/agents-observe — **A−** (my pick as base)
- **Refutes the report's core knock:** real subagent hierarchy graph — `constellation/agent-tree.ts` `buildAgentTree()`/`layoutTree()` (parent→child, orphan-reparenting, root synthesis), plus a dependency-free N-body live graph (`physics.ts`). Session-scoped drill-in, edges derived from events (not persisted) — extend if a global orchestration DAG is wanted.
- **Tests are real:** 78 test files, **1,985 `expect()`** calls; `agent-tree.test.ts` asserts nesting/reparenting. (Report said "76"; also **no test-on-PR CI** — tests run only via `just check` — and "semantic-release" is **false**, it's a hand-rolled `release.sh`.)
- **Docker is avoidable** (the decisive trade-off the report overweighted): the *plugin* happy-path is hard-Docker, but `AGENTS_OBSERVE_RUNTIME=local` / `just start-local` runs pure Node + native `better-sqlite3`, no daemon. Run it under `launchd` next to Ollama/Telegram.
- **Clean:** MIT + real LICENSE, ports/adapters storage, strategy-pattern agent classes (Claude Code + Codex + `hermes`), arm64 multi-arch image. Highest forkability for an OPCⁿ product.
- **Must fix before exposure:** binds **0.0.0.0**, wildcard CORS, **zero auth**, stores full tool payloads. Bind 127.0.0.1 + add a token first.

### hoangsonww/Claude-Code-Agent-Monitor — **B−** (study, don't adopt blind)
- **Real, well-tested core:** 92,163 LOC (exact), 12-table schema, dual SQLite driver (`better-sqlite3` + `node:sqlite` fallback), 1,478 server + 427 client assertions. Nested subagent tree is real (`SessionDetail.tsx:676-810` recursive `renderAgentNode`, backed by `agents.parent_agent_id`); issue #200 nested-hierarchy fix is the HEAD merge.
- **But the "DAG cockpit" is oversold:** `OrchestrationDAG.tsx` is a **type-aggregated 3–4 layer** diagram, not a per-instance orchestration graph; the true nesting is a collapsible **indented tree**, reconstructed post-hoc on `SubagentStop`.
- **The RCE is real and the report mis-diagnosed it:** `/api/run` (`server/routes/run.js`) accepts `permission-mode` from the browser body and `ALLOWED_PERMISSION_MODES` includes **`bypassPermissions`** (`run.js:96`) → spawns `claude --permission-mode bypassPermissions` in any absolute cwd = code exec as the host user. `DASHBOARD_TOKEN` auth is **opt-in and a no-op when unset** (`security.js:133`). On 0.0.0.0 without a token this is a self-hosted RCE box. Good news: the spawner is **cleanly excisable** (≈6 files + 1 mount line + 1 table).
- **Its genuine edge for Ivan:** first-class **`formatTelegram`** provider (`webhook-providers.js:177`) + `alert_rules`/`webhook_targets`/`webhook_deliveries` schema — the easiest Telegram bridge in the set.
- **Bus factor = 1:** all 208 source files `@author Son Nguyen`. 70 badges, 207 KB `ARCHITECTURE.md`, 202 KB landing page — enterprise cosplay over a solo project.

### ek33450505/claude-code-dashboard (CAST) — **C**
- **Best security *pattern* (steal it):** `controlGate.ts` — read-only by default, non-safe verbs 404 unless `CAST_DASHBOARD_CONTROL=1` + `DASHBOARD_TOKEN`, `timingSafeEqual`, mounted before the router. 73 lines, dependency-free, drop-in.
- **Best cost idea (steal it):** delegation-savings — `analytics.ts:233-310` re-prices Haiku sessions at Sonnet rates, conservative `max(0, sonnetEquiv − actualHaiku)`, runs off `~/.claude` JSONL. ~50 LOC, portable. (Pricing table is hardcoded/stale — re-verify.)
- **But it's a lock-in trap:** **37 of 51 route files** import `getCastDb`; schema is "owned by CAST"; without the separate CAST agent OS ~72% of routes 503/empty. The "MIT" is a **README badge only** — `package.json` has `private:true`, no `license` field, no LICENSE file = all-rights-reserved. And despite "localhost", `index.ts:101` binds **0.0.0.0** with unauth GET reads that dump every table. Self-published "audit" ≠ third-party assurance. 3★, one maintainer.

### disler/…observability — **C−** (the emperor has no tests)
- **Its subagent data is a dead path:** the hook *sends* `agent_id`/`agent_type`, but the **server drops them** (`db.ts:127`) — they survive only inside a JSON blob. Schema is a single `events` table; **no parent column, no graph library anywhere** (no d3/cytoscape/dagre/reactflow). "Trace every task handoff across the swarm" is flat swim-lanes keyed on an app label.
- **Zero tests. No license** (`private:true`, no `license` field → all-rights-reserved = hard OPCⁿ blocker). **Stalled 8 Feb 2026.** Effectively **1 real runtime dep** (Vue) + two dead deps.
- **Security unfit for exposure:** unauth `POST /events`, CORS `*`, and an **SSRF** vector (server dials an arbitrary `responseWebSocketUrl` from the payload, `index.ts:198-201`); the `.env` guard is commented out.
- **Value:** its ~180-line `send_event.py` hook→HTTP→SQLite→WS loop is the clearest *teaching* example of the ingest pattern. Learn from it; do not build on it.

### NirDiamant/claude-watch — **C+** (wrong shape)
- Genuinely ingests live tool-calls (hook→`/api/events`→SQLite→WS), but renders them as a **flat feed** behind a gimmicky static-config "brain-scanner" (regex keyword classifier). **No parent→child nesting, no `SubagentStop`.** Its only AI feature needs `ANTHROPIC_API_KEY` and ships your files to Anthropic. Zero tests; a command-injection in the snapshot name (`execSync` double-quoted `$(...)`). Complement at best. Worth stealing: the git-`stash`+tag non-destructive **run-checkpoint** pattern.

---

## 4. Selection bias — the report's survey blind spot

The report frames the market as "only tiny single-maintainer projects; no Grafana of Claude Code." That thesis is **broken by tools it never mentions**:

| Missed tool | Stars | Relevance | Why it still isn't the answer |
|---|---|---|---|
| **davila7/claude-code-templates** | 28.4k, MIT | Real `npx --analytics` live dashboard, reads `~/.claude` JSONL, zero-install, no Docker | Flat subagent **leaderboard, no DAG**; no dollar cost; **no persistence** (in-memory only); no Telegram. Binds 0.0.0.0. |
| **jarrodwatts/claude-hud** | 26.1k, MIT | Literally "see which **subagents** are running" | In-terminal statusline HUD, single-session, not a historical web cockpit |
| **ccusage** | 16.8k | The de-facto token/cost tool | CLI report, not a cockpit — but it undercuts the report's "cost tracking no one else captures" praise of CAST |

**Fair reading:** the panel's thesis *survives* only if narrowed to "no *DAG cockpit* that is also multi-maintainer + popular" — which is true. As literally written, it's false. And `claude-code-templates` is the honest **baseline to differentiate against** for an OPCⁿ product: it already nails self-hosted + zero-install + live token attribution. Your moat is the DAG + dollar-cost + persistence + Telegram it lacks.

---

## 5. Security reality — worse than the report implies

Every viable option **binds 0.0.0.0 and/or ships no-op auth in practice** — `simple10` (0.0.0.0, no auth), `cast` (0.0.0.0 GET reads despite the write-gate), `hoangsonww` (token is a no-op when unset; spawner = RCE). The report's "loopback by default" framing is too generous. **Non-negotiable for the Mac Mini:** bind 127.0.0.1, add a token, reach it only over Tailscale/SSH — never a reverse proxy to the open port.

---

## 6. What no one delivers — your build backlog (the real OPCⁿ surface)

Confirmed gaps, true across all six:
1. **Global, persistent, per-instance orchestration DAG** — everyone has at most a session-scoped tree with event-derived (non-persisted) edges.
2. **Dollar-cost attribution + delegation-savings** surfaced live (borrow `cast`'s formula).
3. **Telegram alert sink → @baev_bot_bot** (graft `hoangsonww`'s webhook provider).
4. **Cross-machine / fleet aggregation** — all are single-host.
5. **Persistence you control** for historical/time-series analysis.

---

## 7. Recommendation & next step

**Fork `simple10` as the base.** Rationale: highest independent grade (A−), wins the report's own model, genuine subagent graph, real tests, MIT + LICENSE, Docker-optional, most forkable for OPCⁿ. Then:

1. **Harden immediately:** bind `127.0.0.1`, add a `DASHBOARD_TOKEN`, run via `AGENTS_OBSERVE_RUNTIME=local` under `launchd` (no Docker daemon on the box).
2. **Graft the two best ideas from rivals:** `hoangsonww`'s `formatTelegram` webhook provider (→ @baev_bot_bot) and `cast`'s ~50-LOC delegation-savings metric.
3. **Validate the graph** against one real subagent-heavy session before committing — confirm `buildAgentTree` renders your nesting the way you expect. If you need a *global* top-down DAG, that's the first extension (ELK/Graphviz over the persisted tree).
4. **Keep `hoangsonww` cloned** purely as a reference for its D3 Sankey/aggregate-DAG polish.

**If instead the priority is out-of-box richness today over clean-ownership:** adopt `hoangsonww` loopback-only, delete `run.js`/`run-spawner.js` first, and accept the bus-factor-1 support burden on 92k LOC.

**Do not** base anything commercial on `disler` (no license) or `cast` (CAST-OS lock-in + license-by-badge).

---

*All figures verified at source on 2026-07-03; these repos move fast — re-verify before final commitment.*
