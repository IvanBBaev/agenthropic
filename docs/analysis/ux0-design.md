# WP-UX0 — Design pre-work (IA, flows, wireframes, uncertainty language)

**Status:** Design pre-work only. This document introduces **no code, no schema
change, and no plan-of-record decision.** It is the deliverable proposed by
`corpus-audit-2026-07-06.md` **§9.5** (the first UX/UI senior-lens review) as
**WP-UX0**, dependency-ordered **before `WP-U5`** in the Phase-4 UI track. Per
**CD-8** no scaffolding happens until Gate A is signed **and** `WP-S7` reads GO;
accordingly this file contains **ASCII wireframes only** — no React/TS/CSS.

**Why this exists (the gap it fills).** Across the ~70-file corpus there were
**zero wireframes, zero user flows, zero information architecture, and zero visual
language** (corpus-audit §9.5). The project's actual UX thinking survived only in a
git-excluded `*.docx` and was catalogued as lost content **LOST-6**
(corpus-audit §4.3): *EXPANDED §15 — the 7-screen UX model + the honest-uncertainty
principle + PERF-01.* This document **recovers LOST-6 faithfully** from
`due-diligence/agenthropic_ideen_doklad_gap_holistic_implementation_EXPANDED.docx`
and turns it into buildable design pre-work for the four v1.0 views.

**Sources cited throughout:**
- **LOST-6** / EXPANDED §15 — recovered verbatim in §0 below.
- **corpus-audit §9.5** — the five concrete UX gaps this document closes.
- **corpus-audit OPEN-2** — `'unknown'` missing from the `agents.status` CHECK
  constraint; the UI depends on it existing (§4, §5).
- **D3** (`implementation-plan.md` §D3) — the five daily questions, verbatim (§2).
- **DESIGN.md §6** (view rendering models), **§4** (schema), **§2.1** (the moat).
- **`development-plan.md`** — the Phase-4 WP list `WP-U5…U9` and their Done-when.
- **`phase0-probe.md`** — empirical scale reality (sparse-DAG numbers, §3, §4).

---

## 0. Recovered source material (LOST-6)

Extracted from the EXPANDED docx via `textutil -convert txt`. Reproduced faithfully;
the docx prose is bilingual, so the "Must answer" column is translated to English
without altering meaning.

### 0.1 EXPANDED §15 — the 7-screen UX/product model (verbatim structure)

| Screen | Purpose | Must answer |
|---|---|---|
| **Home / Sessions** | Current and recent runs | What is running now? What is broken? What is expensive? |
| **Session detail** | One session flight recorder | Which agents took part, and in what order? |
| **Agent tree** | Hierarchy visualization | Which agent started whom? Where is the bottleneck? |
| **Event stream** | Forensic timeline | What exactly happened, and when? |
| **Cost panel** | Token/cost intelligence | Who spends tokens, and on which model? |
| **Alerts** | Operational attention | What requires intervention? |
| **Settings** | Safe local config | What are the security, retention and alert settings? |

### 0.2 EXPANDED §15 — the honest-uncertainty principle (verbatim, translated)

> *UX should not hide uncertainty. If a parent/child relation is inferred with low
> confidence, the UI must mark it. If a cost is estimated because pricing is missing,
> the UI must show it. Better honest uncertainty than confident nonsense.*

Reinforced by two other recovered items:
- **EXPANDED §3.2 / NFR-PERF-01 (= PERF-01):** *"The UI can render a session with
  500+ events and 50+ agents."* Proof: a synthetic performance test.
- **EXPANDED §16 / R-10 — "False confidence from inferred data"** (impact High):
  mitigation = *confidence labels, raw drill-down, anomaly state.*
- **EXPANDED §7.1 negative catalogue** — the three uncertainty-bearing rows:
  - `SubagentStop` before `SubagentStart` → *raw stored; normalized anomaly flagged;
    **UI shows an uncertain edge**.*
  - Missing parent id → *agent marked orphan / pending reparent; **no fake root**
    unless explicitly synthesized.*
  - Unknown model pricing → *token counts shown; cost marked **unknown/estimated,
    not silently zero**.*

### 0.3 How the recovered 7-screen model maps to the **v1.0** scope

The §15 model predates two later decisions and must be reconciled, not copied:

1. **Alerts is post-1.0** (best-path §6.1, applied to `development-plan.md` — v1.0 =
   DAG + cost cockpit answering the five daily questions, **no alerts**). So the
   §15 *Alerts* screen is **out of v1.0**.
2. **The moat view did not exist in §15.** The source model's *Agent tree* is
   session-scoped only. v1.0 adds a **Global, persistent, per-instance orchestration
   DAG** (`WP-U8`) — the moat (DESIGN §2.1) — which the §15 model has **no screen
   for**. This document adds it as a first-class v1.0 view and marks it as a
   deliberate extension of the recovered model.

| §15 screen | v1.0 fate | v1.0 view (WP) |
|---|---|---|
| Home / Sessions | **v1.0** | (a) Live status board — `WP-U6` |
| Agent tree | **v1.0** | (b) Session-scoped subagent tree — `WP-U7` |
| *(new — not in §15)* | **v1.0** | (c) Global persistent DAG — `WP-U8` |
| Cost panel | **v1.0** | (d) Cost / Sankey / delegation-savings — `WP-U9` |
| Session detail | **thin in v1.0** | folds into (b) as an agent drill-down panel |
| Event stream | **post-1.0** | forensic drill-down only in v1.0 |
| Alerts | **post-1.0** | cut from v1.0 per best-path §6.1 |
| Settings | **minimal / post-1.0** | token gate + range toggles only in v1.0 |

---

## 1. Information architecture (IA map)

The SPA is a **single loopback-only, token-gated, SSE-live** surface (DESIGN §8;
`WP-U5`). It renders **nothing** until it has proven possession of the mandatory
`DASHBOARD_TOKEN`. Every view is a **read-only projection over data already in
SQLite** — the session tree and the global DAG are **queries over the persisted
`orchestration_edges` table**, never a client-side walk of the event log
(DESIGN §6; `WP-U3`/`WP-U8` Done-when).

```
agenthropic SPA  (127.0.0.1 · DASHBOARD_TOKEN gate · SSE live · host = mac-mini-m4)
│
│  Persistent chrome on every view:
│    • SSE connection indicator (● live / ○ reconnecting — WP-U5 "resilient")
│    • host_id / instance label (per-instance is a moat invariant — DESIGN §2.1)
│    • ALWAYS-VISIBLE uncertainty legend (see §4)  ← honest-uncertainty, LOST-6
│    • time-range toggle (today / this week / all)
│
├─ (a) LIVE STATUS BOARD ............. WP-U6  [v1.0 · DEFAULT/HOME]   §15 "Home/Sessions"
│        working / unknown / done · <30s at-a-glance
│        └─(row click)─▶ (b) Session subagent tree
│
├─ (b) SESSION SUBAGENT TREE ......... WP-U7  [v1.0]                 §15 "Agent tree"+"Session detail"
│        one session, parent→child, D3 force+tree, live
│        ├─(node click)─▶ Agent drill-down panel (tokens, status, raw events)  ← §15 "Session detail" (thin)
│        └─(link)─▶ (d) Cost view filtered to this session
│
├─ (c) GLOBAL PERSISTENT DAG ......... WP-U8  [v1.0 · THE MOAT]      (added — not in §15)
│        spans every session for this instance · per-instance · persisted edges
│        └─(node click)─▶ (b) Session tree for that session
│
├─ (d) COST / SANKEY / SAVINGS ....... WP-U9  [v1.0]                 §15 "Cost panel"
│        token flow + $ + delegation-savings
│        └─(flow/row click)─▶ (b) Session tree / agent that spent it
│
├┄ Event stream (forensic) .......... [post-1.0]                    §15 "Event stream"
│        v1.0 exposes it only as the agent drill-down in (b)
├┄ Alerts ........................... [post-1.0 — cut, best-path §6.1]  §15 "Alerts"
└┄ Settings ......................... [minimal/post-1.0]            §15 "Settings"
```

**Navigation invariant:** the four v1.0 views form a **hub-and-spoke** around the
status board (the home/default). Every deep view has a one-click path back to the
board and cross-links to the cost view — so no daily question ever needs more than
**two clicks** from cold start (§2).

---

## 2. Five question-to-screen flows

The five daily questions are the **v1.0 exit gate** (best-path §6.1; Phase-4 exit in
`development-plan.md`: *all five answerable + time-to-understand a session <30s*).
Recorded verbatim as **D3** in `implementation-plan.md`:

> Q1 *What is the subagent tree of this session, and which branch is still running?*
> Q2 *Which agent/subagent burned the most tokens (and roughly what did it cost)?*
> Q3 *Did any session get stuck / error without me noticing?*
> Q4 *What did today/this week cost, and how much did Haiku/Sonnet routing save?*
> Q5 *Show me last night's sessions — persisted, after a restart.*

Each flow below states: **entry screen · above-the-fold answer · click budget ·
how the <30s target is met.**

### Flow Q1 — the running tree of a session
```
Home board ──click a RUNNING row──▶ (b) Session subagent tree
```
- **Above the fold:** the parent→child tree; **node color = status** (§4), so
  "which branch is still running" is answered by the ● working nodes without a
  second query.
- **Clicks:** 1 (board → tree).
- **<30s:** running sessions are pinned to the top of the board; the tree is a
  query over `orchestration_edges` (already persisted) so first-paint needs no
  reconstruction (`WP-U3`/`WP-U7`).

### Flow Q2 — the biggest token burner (and its cost)
```
Home board ──click [Cost] tab──▶ (d) Cost/Sankey ──read "TOP BURNERS" list──▶ answer
   (alt) (b) tree ──"cost for this session"──▶ (d) filtered
```
- **Above the fold:** the **TOP BURNERS** leaderboard (agents ranked by tokens, each
  with its ground-truth `$`); the widest Sankey band is the same agent, read
  visually.
- **Clicks:** 1 from home.
- **<30s:** the leaderboard is pre-sorted server-side; every `$` is
  `tokens × dated price` (no client math).

### Flow Q3 — did anything get stuck / error unnoticed  *(the flagship <30s flow)*
```
(open app) ──▶ (a) Live status board   [ default view — 0 clicks ]
```
- **Above the fold:** the **ATTENTION** band, sorted to the very top, showing every
  `▲ unknown` (watchdog) and `✕ error` agent. If the band is empty, nothing is
  stuck — answered at a glance.
- **Clicks:** 0 (it is the home screen).
- **<30s:** this is *the* view `WP-U6` is measured against — "a newly-stuck agent
  flips to `unknown` live via SSE within the window." The whole board is designed so
  the abnormal states draw the eye first (§4).

### Flow Q4 — today/this-week cost and delegation savings
```
Home board ──click [Cost] tab──▶ (d) Cost/Sankey ──read KPI header──▶ answer
```
- **Above the fold:** three KPI figures — **Today $**, **This week $**,
  **Delegation saved $** — with a today/week toggle.
- **Clicks:** 1 from home.
- **<30s:** the KPIs are the top strip of the cost view; savings =
  `Σ max(0, top-tier-equiv − actual)` (`WP-C5`), computed server-side.

### Flow Q5 — last night's sessions, after a restart
```
Home board ──scroll to RECENT / set range = "today"──▶ persisted session list
```
- **Above the fold:** the **RECENT** band lists completed sessions from SQLite
  (WAL-persisted), each with duration and ground-truth `$`.
- **Clicks:** 0–1 (already on home; optional range toggle).
- **<30s:** the list is backed by **persisted** `sessions`/`agents` rows, not a
  live-only in-memory buffer — so it is identical before and after a server restart
  (the explicit point of Q5; `WP-U6` reads the same persisted tables).

**Flow-to-view coverage matrix**

| Question | Primary view | Secondary |
|---|---|---|
| Q1 tree + running branch | (b) Session tree | (a) status colors |
| Q2 biggest burner | (d) Cost/Sankey | (b) per-session |
| Q3 stuck/error | **(a) Status board (default)** | — |
| Q4 today/week cost + savings | (d) Cost/Sankey | — |
| Q5 last night, persisted | (a) Status board list | SQLite WAL |

---

## 3. ASCII wireframes — the four v1.0 views

All four wireframes bake in the honest-uncertainty language of §4. Each carries a
`data:` footer stating the **source-of-truth invariant** it must honor. Legend:
`● working · ▲ UNKNOWN · ✓ done · ✕ error` — `— solid = observed edge · ┄ dashed =
inferred edge`.

### (a) Live status board — `WP-U6` — the <30s at-a-glance
```
┌────────────────────────────────────────────────────────────────────────────┐
│ agenthropic  ● live(SSE)  host: mac-mini-m4    [ Status ] Tree  DAG  Cost    │
│ Legend: ● working ▲ UNKNOWN ✓ done ✕ error   — observed  ┄ inferred  ~ est. $ │
├────────────────────────────────────────────────────────────────────────────┤
│  ⚠ ATTENTION  (sorted first — answers Q3 at a glance)                        │
│  ▲ 9f3a  "refactor-auth"   agent Explore#3   UNKNOWN   no Stop · 4m12s  ▸    │
│  ✕ 12bd  "docs-sweep"      agent main        ERROR     exit 1           ▸    │
│ ──────────────────────────────────────────────────────────────────────────  │
│  ● RUNNING                                                                   │
│  ● a071  "build-plan"      3 agents working  ▸ tree                          │
│  ● 55e2  "kiko-digest"     main only                                         │
│ ──────────────────────────────────────────────────────────────────────────  │
│  ✓ RECENT — persisted · survives restart (answers Q5)     [ range: today ▾ ] │
│  ✓ 7c10  "snake-skins"     12 agents  done   02:14   $0.0431                 │
│  ✓ 3ff9  "tetris-ci"       main only  done   01:02   <$0.01                  │
│  ✓ e5a8  "body-psy"        main only  done   00:41   $0.0088                 │
└────────────────────────────────────────────────────────────────────────────┘
  data: reads persisted agents.status (incl. 'unknown' — OPEN-2 §5) + SSE deltas;
        no render-time inference. $ = ground-truth tokens × dated price.
```
Empty/first-run state (no sessions yet — §9.5 gap #5): the board shows a single
neutral panel *"No sessions recorded yet on this host. Run a Claude Code session;
it will appear here."* — never a blank screen or a fake row.

### (b) Session-scoped subagent tree — `WP-U7`
```
┌────────────────────────────────────────────────────────────────────────────┐
│ Session 9f3a "refactor-auth"   started 14:02  ● live       [ → cost: sess ]  │
│ Legend: — observed edge   ┄ inferred edge(~conf)   ▲ unknown  ● working      │
├────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│   ● main (Opus)                                                              │
│   ├── ● Explore#1 (Sonnet)   1.2M tok   $0.41                                │
│   ├── ▲ Explore#3 (Sonnet)   0.4M tok   $0.14   UNKNOWN · no Stop  [details] │  ← amber node
│   │     └┄┄~ Grep#7 (Haiku)  12k tok   <$0.01   ┄ inferred edge ~78% [why?]  │  ← dashed depth-2
│   └── ✓ Workflow wf_22                                                       │
│         ├── ✓ agent-a1   0.8M tok   $0.27                                    │
│         └── ✓ agent-b4   0.6M tok   $0.19                                    │
│                                                                              │
│   ┌── Common case — 72% of sessions (phase0-probe: 84/117 have 0 subagents)─┐│
│   │  ✓ main (Opus)   4.1M tok   $1.38     — no subagents spawned            ││
│   └────────────────────────────────────────────────────────────────────────┘│
└────────────────────────────────────────────────────────────────────────────┘
  data: tree = query over persisted orchestration_edges (WP-U3), NOT a client
        walk of the event log. Edge style comes from a persisted edge-provenance
        field (§4/§5). Tokens copied verbatim from JSONL; $ = tokens × dated price.
```
`[why?]` on an inferred edge opens the **raw drill-down** (R-10 mitigation): it shows
what the edge was derived from (`derived_from_event_id`) and the confidence score.
The common 72% case is drawn deliberately (§9.5 gap #2 — design the sparse/empty
state, not just the dense showcase).

### (c) Global, persistent, per-instance orchestration DAG — `WP-U8` — the moat
```
┌────────────────────────────────────────────────────────────────────────────┐
│ Global orchestration DAG — host mac-mini-m4 · ALL sessions    [ range: 7d ▾ ]│
│ Legend: — observed  ┄ inferred   ● working ▲ unknown ✓ done   1 node=1 agent │
├────────────────────────────────────────────────────────────────────────────┤
│  a071 ─● main ─┬─● Explore                                                   │
│                └─✓ Workflow ─┬─✓ agent          (all edges persisted)        │
│                              └─✓ agent                                       │
│  9f3a ─● main ─┬─● Explore                                                   │
│                └─▲ Explore ┄┄~ Grep    ┄ inferred ~78%                       │
│  7c10 ─✓ main ─… (12 agents, collapsed for perf)              [ expand ]     │  ← virtualization
│ ──────────────────────────────────────────────────────────────────────────  │
│  ▸ 84 / 117 sessions have NO subagents — shown as flat roots      [ show ]   │  ← sparse case
└────────────────────────────────────────────────────────────────────────────┘
  data: query over orchestration_edges WHERE host_id = … with NO session filter
        (WP-U8). Per-instance: one node = one real agent run, NEVER type-aggregated
        (contrast hoangsonww's 3–4-layer type diagram — DESIGN §6).
  perf: NFR-PERF-01 (500+ events / 50+ agents) → collapse + virtualize + filter;
        R-06 "UI graph performance collapse" mitigation. First-paint = collapsed.
```
Because 72% of sessions are flat, the **default frame collapses subagent-free
sessions into a roster** and expands only the graph-bearing ones — the graph is the
exception, not the rule (phase0-probe §Q, §9.5 gap #2).

### (d) Cost / Sankey / delegation-savings — `WP-U9`
```
┌────────────────────────────────────────────────────────────────────────────┐
│ Cost / Sankey / delegation-savings              [ today ▾ ] [ this week ]     │
├────────────────────────────────────────────────────────────────────────────┤
│  Today  $2.4187        This week  $18.66        Delegation saved  $6.12       │  ← Q4 KPIs, above fold
│  every $ = ground-truth tokens × dated price · never inferred                 │
│ ──────────────────────────────────────────────────────────────────────────   │
│  TOKEN FLOW  (band width ∝ tokens)          TOP BURNERS  (answers Q2)         │
│  Opus        ████████████████ 6.1M $1.41    1. main / 9f3a    6.1M  $1.41     │
│  Sonnet      ████████ 3.0M $0.62            2. wf_22 / a071   2.2M  $0.54     │
│  Haiku       ██ 0.4M $0.0312                3. Explore#1      1.2M  $0.41     │
│  new-model-x ▒▒ 0.2M  ~est ⚠ price unknown  4. Grep#7          12k  <$0.01    │  ← estimated chip
│ ──────────────────────────────────────────────────────────────────────────   │
│  Delegation savings = Σ max(0, top-tier-equiv − actual) = $6.12  (Q4, WP-C5)  │
│  (Haiku/Sonnet re-priced at Opus rates; tied to the routing decision)         │
└────────────────────────────────────────────────────────────────────────────┘
  data: CostEngine = token_usage (ground truth, verbatim from JSONL) × model_pricing
        (dated, versioned). An unpriced model in a FIXTURE = red build (WP-C6);
        at RUNTIME a brand-new model shows "~est ⚠" with tokens still displayed —
        NEVER a silent $0 (honest-uncertainty, LOST-6). <$0.01 shown, never $0.00.
```

---

## 4. The uncertainty / honesty visual language

This is the direct build-out of LOST-6's honest-uncertainty principle and §9.5's
gap #1: *"inferred/estimated is always visible, never silent" is a **design system**,
not a footnote.* Three dimensions must **always** be visibly distinguished; a fourth
row records the invariants they must not violate.

| Dimension | Ground-truth / observed encoding | Uncertain encoding | Rule |
|---|---|---|---|
| **Edge provenance** (tree §b, DAG §c) | **solid line** `—`, full opacity, no badge | **dashed line** `┄` + `~conf%` chip + `[why?]` drill-down | An edge from the hard join (Agent/Workflow spawn → child `sessionId` → parent ref, phase0-probe §Q) is *observed*; an edge from the self-referential parent index / orphan-reparent heuristic is *inferred*. Never render an inferred edge identically to an observed one. |
| **Cost** (cost §d, tree/DAG node `$`) | plain figure, e.g. `$0.0431` | `~est ⚠` chip; **tokens still shown**; `<$0.01` for non-zero sub-cent | If a model/bucket has no priced row at runtime, mark the cost estimated — **never a silent `$0.00`**. Tokens are ground truth and are always shown even when the price can't be resolved. |
| **Agent status** (all views) | `● working` (blue) · `✓ done` (green) · `✕ error` (red) · `waiting` (grey) | **`▲ unknown` (amber hazard)** — the watchdog state | `unknown` = a missing `SubagentStop` inside the watchdog window (`WP-IN12`), never a permanent "working." It **sorts to the top** of the board and **draws the eye first** — it is exactly the "stuck without me noticing" case of Q3. |
| **Tokens** (invariant, not a badge) | ground truth, no decoration | absent count → `—` / `pending`, never `0` | Tokens are read from JSONL, **never inferred** (DESIGN §4). A genuinely-absent count is shown as pending, not zeroed. |

**Cross-cutting rules:**

1. **A persistent legend chip lives in the chrome of every view** (see the IA map
   and each wireframe header) — the vocabulary is never hidden behind a tooltip.
2. **Raw drill-down is mandatory for every uncertain mark** (R-10 mitigation): a
   dashed edge exposes `[why?]` → the `derived_from_event_id` and confidence; an
   estimated cost exposes which bucket lacked a price; an `unknown` node exposes the
   last observed event and the watchdog deadline.
3. **No fake structure** (EXPANDED §7.1): an orphan agent is drawn as an
   orphan/pending-reparent node, **never grafted onto a synthesized fake root**.
4. **Anomaly, not silence** (EXPANDED §7.1): a `SubagentStop`-before-`SubagentStart`
   contradiction renders the edge as *uncertain*, it does not drop or fabricate it.
5. **Estimated ≠ zero, unknown ≠ working, inferred ≠ observed** — the three cardinal
   confusions the visual language exists to prevent. *"Better honest uncertainty than
   confident nonsense."*

---

## 5. Schema/plan dependencies this design surfaces (feed back before Phase 4)

The visual language cannot be built from the current schema — the distinctions it
draws must exist as **data** before the UI can render them. Per §9.5 gap #1 these
belong **before** Phase 4, not inside it. UX0 does not decide them (owned elsewhere);
it flags the dependency:

1. **`'unknown'` must be added to the `agents.status` CHECK constraint** — this is
   **OPEN-2** (corpus-audit §4.2): the reference DDL allows
   `('working','waiting','completed','error')` but `WP-IN12`'s watchdog assigns
   `'unknown'`, and the status board (§3a) and every node badge (§4) depend on that
   value existing and persisting. Owned by `WP-D4`'s migration DDL; flagged here as a
   hard UI dependency. Also open: the documented `unknown → revert` rule
   (concept-analysis-v2 §7 q5) — the UI must know whether `unknown` can flip back to
   `working`/`done` when a late `Stop` arrives.
2. **An edge-provenance field on `orchestration_edges`** — the observed-vs-inferred
   distinction (§4, dimension 1) requires a persisted marker (a `confidence` and/or
   `derived_from`/`derived_from_event_id` column). §9.5 states this feeds back into
   the schema; it must be present when `WP-D7` defines the table, or the inferred/
   observed rendering has no column to read.
3. **PERF-01 as a first-class NFR** — LOST-6 carries NFR-PERF-01 (render 500+ events
   / 50+ agents). It should be transplanted into the plan of record as a testable
   requirement (the same treatment §9.5 and corpus-audit action #8 recommend), so the
   global-DAG virtualization/collapse policy (§3c) has an acceptance target and R-06
   (UI graph performance collapse) has a gate.

These three are the concrete "invisible design debt" §9.5 warns Phase 4 would
otherwise start with: without them, the `<30s` target and the honest-uncertainty
principle have no data to stand on.

---

## 6. What UX0 deliberately leaves open

Consistent with design pre-work (not a decision):

- **Exact colors / dark-mode default.** §9.5 notes the terminal-native user implies a
  dark default, stated nowhere. UX0 fixes the *semantics* (amber = unknown, dashed =
  inferred) not the hex values; the palette is a `WP-U5`/`WP-U6` implementation
  choice.
- **The D3 layout for the global DAG** beyond "query over persisted edges" — DESIGN
  §6 names ELK/Graphviz as a *later* extension "when needed," not v1.0.
- **SSE reconnect/backoff mechanics** behind "resilient" (`WP-U5`) — named as a
  requirement, not specified here.
- **The forensic Event-stream and Settings screens** (§15) — post-1.0; only their
  v1.0 stubs (agent drill-down, token gate + range toggle) are in scope above.

---

_Design pre-work for WP-UX0. Recovers LOST-6 (corpus-audit §4.3 / EXPANDED §15) and
implements the recommendation of corpus-audit §9.5. No code, no schema change, no
plan-of-record decision — ASCII wireframes only, per CD-8. Feeds §5's three
dependencies back to `WP-D4`/`WP-D7` and the plan of record for decision by their
owners; introduces WP-UX0 as design-only, dependency-ordered before WP-U5._
