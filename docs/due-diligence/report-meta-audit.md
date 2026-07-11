# Meta-Audit — Auditing the Audit

This file grades the two vendor reports themselves: their internal consistency,
their factual accuracy, and their scoring model.

## 1. The self-contradiction that flips the decision

The v2.0 report contains its own weighted scoring model (§4.2). Its result:

| Project | Weighted score /5 |
|---|---|
| **simple10** | **4.1 — highest** |
| hoangsonww | 4.0 |
| cast | 3.8 |
| disler | 2.7 |
| nirdiamant | 2.6 |

**The model ranks `simple10` first.** Yet §11.1 recommends:

> "Adopt hoangsonww/Claude-Code-Agent-Monitor as your primary cockpit."

The report bridges the gap with a discretionary tie-break on **"Visualisation depth"**
(weight 20%), where it scores `hoangsonww` **5** and `simple10` **3**. That single
delta is what lifts hoangsonww past simple10 in the narrative.

**The tie-break rests on a false premise.** The report justifies simple10's low
visualisation score by asserting it has "no true DAG / subagent tree." It does — see
[projects/simple10.md](projects/simple10.md): `constellation/agent-tree.ts →
buildAgentTree()` builds a real parent→child tree with drawn edges, plus a bespoke
live force-directed graph. Re-score simple10's visualisation fairly and **the report's
own model recommends simple10.** The panel overrode its model on a refuted fact.

## 2. The weighted model (as the panel built it)

Weights (§4): Visualisation depth **20%**, Code quality & tests **18%**, Security
**16%**, Maintainability **14%**, Architecture **12%**, Install **10%**, Licence **6%**,
Community **4%**.

Two structural problems with the model as applied:

- **Visualisation depth is the single heaviest weight (20%)** and is exactly the axis
  the panel mis-scored for simple10. A 20%-weighted error is decision-changing by
  construction.
- **Security (16%) was scored too generously across the board.** The model treats
  "loopback by default" as a passing posture; in reality every viable option binds
  0.0.0.0 or ships no-op auth (see [security.md](security.md)). A stricter security
  column pulls hoangsonww *down* (its `/api/run` spawner is a live RCE), widening
  simple10's lead rather than narrowing it.

## 3. Fact-check table

| Claim in report | Reality (2026-07-03) | Verdict |
|---|---|---|
| simple10 metrics "blocked by rate-limiting"; last activity 5 Jun | 607★/58/MIT, pushed 29 Jun — returned first call | ⚠ The "verified fact base" wasn't verified |
| simple10 "no true DAG / subagent tree" | `buildAgentTree()` + live force-directed graph | ❌ **False — and it's the tie-break** |
| hoangsonww run-spawner risk = "concurrency cap 10,000" | Cap is a red herring; the lever is `bypassPermissions` mode | ❌ Wrong mechanism |
| disler "~1,400★ / 372 forks" | 1,475 / 385 | ⚠ Drift |
| disler hooks "protect .env / keys" | Guard commented out (`pre_tool_use.py:324-327`) | ❌ False as written |
| "No feature-rich AND multi-maintainer AND >1k★ option exists" | claude-code-templates: 28.4k★, MIT, active, live dashboard | ❌ Selection bias |
| cast "MIT licensed" | MIT is a **README badge only**; `private:true`, no `license`, no LICENSE file | ❌ Misleading |

## 4. What the report got right (credit where due)

- Raw LOC counts, table counts, and feature inventories are **accurate within noise**.
- The **market-gap thesis survives in narrowed form**: there is no *DAG cockpit* that
  is simultaneously multi-maintainer and popular. (As literally written — "no
  feature-rich + multi-maintainer + >1k★ tool at all" — it is false; see
  [market-landscape.md](market-landscape.md).)
- hoangsonww genuinely is the **most feature-complete out of the box**, and its
  Telegram provider is the best in the set — both real, both useful.
- The gap analysis (§10) correctly identifies the build backlog: Telegram sink,
  cross-machine aggregation, delegation-savings, persistence.

## 5. Net judgement on the reports

**Directionally useful, decisively wrong on the primary pick.** The reports are a
good *inventory* and a good *gap analysis*, undermined by (a) a 20%-weighted factual
error on simple10's visualisation, (b) an over-generous security column, and (c) a
survey blind spot. Use them for the feature map and the build backlog; do not use them
for the "adopt hoangsonww" conclusion.
