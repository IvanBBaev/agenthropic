# hoangsonww/Claude-Code-Agent-Monitor — **B−**

**Panel:** A− (v1) / 4.0 (v2) · **Independent:** **B−** ▼ · **Role: study &
harvest, don't adopt blind.**

The panel's primary pick. Genuinely the most feature-complete out of the box — and the
most dangerous, most oversold, and least maintainable of the serious options.

Metrics: **92,163 LOC** (exact), **MIT + LICENSE file**. README is **2,137 lines with
70 badges** — inflation confirmed.

## The real, well-built core (credit due)

- **12-table schema**; **dual SQLite driver** — `better-sqlite3` with a `node:sqlite`
  fallback.
- **65 real test files**: 1,478 server + 427 client assertions.
- **Nested subagent tree is real**: `SessionDetail.tsx:676-810` recursively renders
  `renderAgentNode`, backed by an `agents.parent_agent_id` column. Issue **#200**
  (nested-hierarchy fix) is the current HEAD merge.

## But the "DAG cockpit" is oversold

- `OrchestrationDAG.tsx` is a **type-aggregated, 3–4-layer** diagram — categories of
  agents, not a per-instance orchestration graph.
- The *true* nesting is a collapsible **indented tree**, reconstructed post-hoc on
  `SubagentStop`. Impressive, but not the live per-instance DAG the report's prose
  implies.

## The RCE — real, and the report mis-diagnosed it

- `/api/run` (`server/routes/run.js`) accepts a `permission-mode` from the **browser
  request body**, and `ALLOWED_PERMISSION_MODES` includes **`bypassPermissions`**
  (`run.js:96`).
- Result: a browser request spawns `claude --permission-mode bypassPermissions` in an
  attacker-chosen absolute cwd → **code execution as the host user**.
- `DASHBOARD_TOKEN` auth is **opt-in and a no-op when unset** (`security.js:133`). On
  0.0.0.0 without a token, this is a self-hosted RCE box.
- The report blamed a "concurrency cap of 10,000" — a **red herring**; the lever is the
  permission mode.
- **Good news:** the spawner is **cleanly excisable** — ~6 files + one mount line +
  one table. Delete it and the RCE is gone.

## Its genuine edge for Ivan

- **First-class `formatTelegram` provider** (`webhook-providers.js:177`) plus
  `alert_rules` / `webhook_targets` / `webhook_deliveries` schema — the easiest Telegram
  bridge in the whole set. **This is the piece worth harvesting** into the simple10
  base.

## Maintainability red flag

- **Bus factor = 1.** All 208 source files carry `@author Son Nguyen`.
- 70 badges, a 207 KB `ARCHITECTURE.md`, a 202 KB landing page — enterprise cosplay
  over a solo project. Adopting 92k LOC from a single author is a real support burden.

## Verdict

Feature-rich and genuinely capable, but oversold on the DAG, carrying a live RCE, and
maintained by one person. **B−.** Keep it cloned as a reference for its D3 graph polish
and harvest its Telegram provider; adopt wholesale only if out-of-box richness today
outweighs clean ownership — and only after deleting the spawner. See
[../recommendation.md](../recommendation.md).
