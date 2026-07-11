# Animated-Room View — Multi-Lens Analysis (Phase 1.5)

> **Status:** Analysis only — recorded, **not** approved and **not** actioned.
> **Date:** 2026-07-03 · **Scope:** the "animated office/room" feature idea for
> `agenthropic` (agents rendered as animated characters), earmarked by Ivan as a
> post-MVP "version 1.5" want.
> **Reviews:** [`../ai/DESIGN.md`](../ai/DESIGN.md) §6 (visualisation) and §9
> (roadmap, Phase 1.5). Sits beside [`concept-analysis.md`](concept-analysis.md)
> (the whole-concept review) and [`implementation-plan.md`](implementation-plan.md)
> (Part A decisions this analysis stays consistent with).

## The idea

Show each Claude Code agent/subagent as an **animated character in a virtual
office**: the character's activity reflects the agent's live state (typing when
writing code, reading when searching, waiting when it needs attention), a subagent
spawn adds a character, and the room becomes an ambient, glanceable view of the
session. Inspired by three existing tools:

- **[claw3d.ai](https://www.claw3d.ai/)** — 3D virtual office; walk-around camera,
  camera-follow a member, PR diffs on agents' screens, conference-table standups.
  Positioned as "your OpenClaw HQ in 3D." Managed hosting upsell ($29/mo/team).
- **[pixel-agents](https://github.com/pixel-agents-hq/pixel-agents)** — pixel-art
  characters in an office; VS Code extension + standalone CLI.
- **[my-virtual-office](https://github.com/eliautobot/my-virtual-office)** — 2D
  office, A\* pathfinding, 100 FPS canvas; office pet, meetings.

## Verdict (TL;DR)

**Adopt, don't build. Gate behind the moat. Keep it read-only.**
The idea is legitimate for a *single-user* tool as an ambient-awareness / joy layer,
but it is **not a differentiator** (it is a solved, crowded space) and it must not
outrank the roadmap's genuine moat (§2). The economically correct shape is to
**fork/embed `pixel-agents`' renderer** (MIT, nearly our exact stack) fed from
**our** live feed — writing glue + subagent-depth adaptation, **not** a sprite
pipeline from scratch — and to ship it only **after** the moat phases exist.
`my-virtual-office` and `claw3d` are rejected (reasons below).

---

## Reference facts (source-verified 2026-07-03)

These facts flip the naive "just build a cute room" instinct — especially licensing
and the observer-vs-driver integration model.

| | pixel-agents | my-virtual-office | claw3d |
|---|---|---|---|
| **License** | **MIT** (copy/fork-clean) | **AGPL-3.0-or-later + paid keys** (copyleft; premium features gated) | "open source" (not source-audited) |
| **Stack** | TS core + **Fastify v5** + **React 19 / Canvas 2D**; Vitest + Playwright | JS front + **Python** back; Docker | 3D engine; OpenClaw-bound |
| **Integration model** | **Observer** — Hooks API POST (`SessionStart`, `PreToolUse`, `Notification`, `Stop`) + **JSONL fallback** | **Driver** — spawns `claude -p --output-format stream-json --include-partial-messages` | OpenClaw HQ |
| **Subagent depth** | **Single-level** parent→child (Task spawns a linked character) | n/a to us | n/a to us |
| **Network bind / auth** | Not documented → **must audit** | `127.0.0.1:8090/8091`, Tailscale-recommended, **no built-in auth** | not audited |
| **Maturity** | 8.4k★, 1.3k forks, v1.3.0 (2026-04-14), 146 commits, actively maintained | 217★, v0.6.31 (2026-07), 38 releases | managed-hosting product |
| **Fit for us** | **High** — same stack, same read-only inputs | **Rejected** — copyleft + paywall + spawner | **Rejected** — OpenClaw/3D, off-stack |

**Two decisive facts:**
1. **`pixel-agents` is an observer** (hooks + JSONL) — the *same* posture as
   `agenthropic`. **`my-virtual-office` is a driver** — it *runs* `claude -p …`,
   i.e. it is a **claude-spawner**, exactly the surface DESIGN §8 forbids.
2. **Licensing hygiene** ([concept-analysis.md](concept-analysis.md), Part A
   `personal-first / commercial-clean`): MIT (`pixel-agents`) is clean to
   fork/copy; **AGPL** (`my-virtual-office`) is copyleft and would contaminate any
   future non-personal distribution — it fails the commercial-clean bar.

---

## 1. Architect

**Fit with the current design.** Clean **iff** it stays what DESIGN §6 declares: a
**second front-end over the same live feed** (SSE per Part A decision D — one-way,
which is *exactly right* for a read-only renderer), with **zero new server
surface**. The data model already supports it 1:1:

| Data fact (schema §4) | Room mapping |
|---|---|
| `agent` row | a character |
| `status` ∈ `working`/`waiting`/`completed`/`error` | its animation state |
| `parent_agent_id` (self-ref) | a spawned child character |
| tool-use event (`PreToolUse`/`PostToolUse`) | its activity animation |

No schema change, no ingest change. Add-only on the client.

**Where the real work is.** Not the data wire (trivial), but the **frontend
art-pipeline**: sprites, animation state machines, isometric/2D layout, optional
A\* pathfinding, sprite atlas, sound. That is weeks of *game-loop* frontend work —
a different skill-set from the D3/data cockpit. This is precisely why building from
scratch is irrational when `pixel-agents` (MIT, ~our stack) already ships it.

**Two integration models; only one is compatible.**
- `pixel-agents` = **observer** (hooks POST + JSONL fallback) → matches our posture.
- `my-virtual-office` = **driver** (`claude -p … stream-json`) → *starts and steers*
  agents → violates §8 (no claude-spawner), drags in AGPL + Python. **Rejected.**

**Risk A1 — subagent depth.** `pixel-agents` renders **single-level** parent→child.
Our moat (§2.1) is a **multi-level persistent per-instance DAG**. Adopting the
renderer as-is would flatten a hierarchy we otherwise sell as deep → either a
mismatch between views (graph says 4 levels, room shows 1) or adaptation work inside
a third-party renderer to teach it depth.

**Risk A2 — screen density.** The tool targets *subagent-intensive* work: 15–30
parallel subagents = 30 characters. An isometric office with 30 figures is
unreadable; DAG/Sankey scales, a "room" does not. This is a soft cap on usefulness
in the exact scenario the tool exists for.

**Verdict (Architect):** low-risk *as an isolated read-only layer*, medium-to-high
effort *if hand-built*, incompatible *if it takes the `my-virtual-office` path*.
Correct shape: adopt the renderer, feed it from our SSE stream, isolate the route so
it can be deleted without touching the cockpit.

## 2. Business Analyst

**Value thesis — three candidates:**
- **(a) Differentiator / moat → No.** `pixel-agents` already does this at 8.4k★. The
  "animated agents" space is taken. Our declared differentiators (§2: persistent
  DAG, dollar-cost, Telegram, fleet, owned persistence) are the unclaimed ground.
  The room competes with them **for Ivan's attention**, not with rivals for a market.
- **(b) Ambient awareness → Real but narrow.** For peripheral "who's working / who's
  stuck," a room beats a graph on glance-ability. But a stuck-session watchdog
  (§6) + a plain status strip cover the same need for ~1% of the effort.
- **(c) Joy / aesthetics → Legitimate here.** Single-user tool; "I enjoy looking at
  it" is a valid criterion in a way it would not be for a product.

**Opportunity cost — the decisive number.** The roadmap has four undelivered moat
phases (Telegram, context-feed, delegation-savings, global DAG). Every frontend day
spent on the room is a day not spent on something *uniquely ours*. For a single-user
tool, cosmetic-before-moat is negative ROI **until the moat exists**.

**Buy-vs-build economics.** MIT + near-identical stack means "build" here is close to
an economic error: the value created by writing a sprite pipeline from scratch is
~0 over forking `pixel-agents`. Investment is justified only in **glue** (our feed →
their renderer) and **subagent-depth** adaptation.

**Verdict (BA):** keep it as a *reward/cosmetic*, **strictly after the moat**. Do not
treat "1.5" as arriving before Phase 2. Adopt, don't build. Budget: days of glue,
not weeks of pipeline.

## 3. QA

**Testability.** The data layer is trivial to test (`status`→animation is a pure
function). The hard part is that **visual correctness isn't unit-tested** —
game-loop/timing/sprite-state regressions need manual or Playwright snapshot testing
(which `pixel-agents` already uses — a plus of adopting it).

**Edge cases that break a naive implementation:**

| # | Edge case | Failure if ignored |
|---|---|---|
| Q1 | Fast spawn/stop (<200 ms Task) | Character appears and vanishes before its animation starts → flicker / ghosts |
| Q2 | Orphan / reparent (`parent_agent_id` is `ON DELETE SET NULL`) | Where does a parent-less character "sit"? Must survive reparenting without teleporting |
| Q3 | Lost hook → status never updated | Character stuck "working" forever → the room **lies**, more convincingly than a table |
| Q4 | Density > N (20–30 agents) | FPS, overlap, unreadability → needs graceful degrade (grouping / open-plan) |
| Q5 | WS/SSE reconnect | Must re-hydrate from snapshot, not accumulate duplicate characters |
| Q6 | Tab backgrounded (rAF paused) | On return must not "catch up" 10 000 frames |

**Mapping granularity.** `pixel-agents` drives "typing/reading/running" from only ~4
events. We plan 12 (§5) → we have **more than enough** signal; the real risk is
*over*-mapping (too many twitchy animation states).

**Verdict (QA):** data layer easy; visual layer needs snapshot tests + inheritance
of the watchdog/idle-timeout (Q3), else the room becomes a prettier liar than the
table it replaces.

## 4. Gap analysis (current state → Phase 1.5)

| # | Gap | Current state | Needed for 1.5 | Severity |
|---|---|---|---|---|
| G1 | **No code at all** | Bootstrap; nothing scaffolded | Phase 0 + Phase 1 must exist (feed + persisted agents) | Blocker (precondition) |
| G2 | **Subagent depth** | Moat = multi-level DAG | `pixel-agents` renderer is single-level → adaptation required | High |
| G3 | **No sprite/art assets** | — | Sprites + their license (MIT covers `pixel-agents` **code**; verify **asset** license separately) | Medium |
| G4 | **Density strategy** | subagent-intensive = many agents | Grouping / degrade at 20+ | Medium |
| G5 | **Idle / lost-hook honesty** | watchdog planned (§6), not built | Room must read the watchdog so it doesn't lie (Q3) | Medium |
| G6 | **Visual test harness** | none | Playwright snapshot pipeline | Low (`pixel-agents` ships one) |
| G7 | **Security of adopted code** | `pixel-agents` bind/auth undocumented | Audit: force `127.0.0.1` + mandatory token, strip any spawner/editor-write path | High |
| G8 | **`status` enum ↔ animation map** | 4 states, N animations | Defined, stable mapping + fallback | Low |

**Hardest gap = G1 + G2:** no room before a stable Phase-1 feed exists, and once it
does, the third-party renderer doesn't understand our depth. That alone says: *not
before Phase 1, and expect adaptation work — not plug-and-play.*

## 5. Devil's advocate (the "don't do it" case)

1. **Solving an already-solved problem, worse.** 8.4k★ `pixel-agents`. Weeks of work
   to own an inferior version of something you can run as-is in an hour.
2. **Undercuts your own narrative.** The whole DESIGN doc differentiates `agenthropic`
   from "oversold DAG cockpits" by *substance* (persistent per-instance graph,
   dollar-cost, honesty). The room is the **eye-candy** you position *against*. Risk
   of becoming what you audit.
3. **Cosmetic-before-moat = the classic solo death-march.** The fun part (sprite toys)
   crowds out the boring moat (Telegram relay, costing). Solo projects die exactly
   here — at an 80%-done room and a 0%-done differentiator.
4. **Density paradox.** The tool is *for* subagent-intensive work; that is precisely
   where the room breaks visually (30 figures). Weakest in its core case.
5. **Honesty risk.** Pretty animation makes a lost hook / stuck agent look alive.
   Prettier = a more convincing liar. For an observability tool, an anti-feature.
6. **AGPL temptation.** If ever tempted by `my-virtual-office` for "richer" — you
   import copyleft + a spawner + Python. One wrong adopt and §8 falls.

**Fair counter:** for a *single-user personal* tool, "joy of watching" and
"peripheral awareness" are real, not vain. If it makes you open the tool daily, the
ambient value is real. But that argues for a **cheap adopt, late**, not an
**expensive build, early**.

---

## Decision

**Yes — keep it, under three hard conditions:**

1. **Adopt, don't build.** Start from a **fork/embed of `pixel-agents`' renderer**
   (MIT, ~our stack), fed from **our** SSE feed. Write glue + subagent-depth
   adaptation (G2), not a sprite pipeline from scratch. Effort: days, not weeks.
2. **After the moat, not before it.** Reframe from "version 1.5 (before 2)" to an
   **optical layer, forked cheaply once Phase-1 data is stable, and after at least
   Telegram (Phase 2) + delegation-savings (Phase 4) exist.** The cosmetic waits for
   the differentiators. (The "1.5" label stays in the roadmap, explicitly
   *optional / cosmetic / gated behind the moat*.)
3. **Read-only, honest, isolated.** Zero spawner (rules out the `my-virtual-office`
   path), inherit `127.0.0.1` + mandatory token (G7), inherit the watchdog /
   idle-timeout (G5) so it never lies, degrade gracefully at 20+ agents (G4).
   Separate route, deletable without touching the cockpit.

## Rejected alternatives

| Option | Why rejected |
|---|---|
| **`my-virtual-office` as base** | Triple §8/policy violation: **AGPL-3.0** (fails commercial-clean, Part A), **paid-key paywall** on the good features (editor/unlimited agents), and a **`claude -p` spawner** integration (no-spawner rule). Python back-end also off-stack. |
| **`claw3d` as base** | OpenClaw-bound, 3D engine, off-stack; managed-hosting product shape; not source-audited. Different universe from a loopback-only TS cockpit. |
| **Build sprite/animation pipeline from scratch** | Economic error given MIT `pixel-agents`; weeks of game-loop frontend for ~0 marginal value over adopting. |
| **Ship it as literal Phase 1.5 (before Telegram/cost)** | Cosmetic outranking moat = negative ROI for a single-user tool; solo death-march risk (§5.3). |

## Spike plan (when unlocked — adopt-first)

A timeboxed spike, **not** a phase. Precondition: Phase 1 shipped (stable persisted
agents + live SSE feed) **and** the moat phases (≥ Phase 2, ideally Phase 4) exist.

1. **Vendor the renderer.** Fork/vendor `pixel-agents`' client renderer (canvas/room
   + sprites). Confirm the **asset** license separately from the MIT **code** license
   (G3). Strip the VS Code extension host and any server/editor-write path.
2. **Feed adapter.** Map our SSE events → the renderer's expected agent-event shape:
   `agent`→character, `status`→animation state (G8), `parent_agent_id`→spawn,
   tool-use→activity. One pure adapter module; unit-tested.
3. **Honesty wiring.** Bind the character's liveness to the watchdog / idle-timeout
   (G5, Q3) — a "stuck" agent must visibly read as stuck, not busy.
4. **Depth decision (G2).** Either (a) accept single-level in the room and keep the
   DAG as the depth view, or (b) extend the renderer to nest. Prefer (a) for the
   spike — cheapest, and the DAG already owns depth.
5. **Density degrade (G4).** Define behaviour at 20+ agents before it's a problem.
6. **Security audit (G7).** Force `127.0.0.1` + mandatory token; assert no spawner,
   no unauthenticated write, same-origin on the stream. Isolated, deletable route.

**Timebox:** ~2–4 days. **Acceptance:** one real subagent-heavy session renders
honestly (stuck reads as stuck), stays readable at load, adds zero server surface.
**Decision gate:** if adaptation balloons past the timebox, ship the plain status
strip instead and drop the room — it is cosmetic, not load-bearing.

## Open questions / follow-ups

- **Asset licensing (G3):** are `pixel-agents`' sprites MIT too, or a separate/CC
  license? Decide before vendoring.
- **Depth (G2):** single-level room + separate DAG, or teach the room to nest?
  Recommendation: single-level for v1.
- **`pixel-agents` bind/auth (G7):** confirm from source before trusting; assume
  hostile until audited.
- **Trigger:** what concretely unlocks the spike — "Phase 2 shipped" or "Phase 4
  shipped"? Recommendation: not before Phase 2; ideally after Phase 4.

  > **Phase-scheme note (2026-07-06).** The phase numbers in this document use the
  > **old design-sketch scheme** (DESIGN.md §9: Phase 2 = Telegram, Phase 4 =
  > delegation-savings). Translated to the **canonical** scheme
  > ([`development-plan.md`](development-plan.md) §3), the intent is: **not before
  > the realtime UI exists; ideally after the five-questions UI ships** — i.e.
  > post-Phase-4 (canonical). Since alerts/Telegram are post-1.0 per
  > [`best-path-decision.md`](best-path-decision.md) §6.1, this gate is effectively
  > **post-1.0** — consistent with best-path §6.3 "defer the animated room".

---

_Recommendation-only. No code, no adoption, no commits until Ivan approves the
decision above and its gating. Consistent with Part A decisions in
[implementation-plan.md](implementation-plan.md) (JSONL-primary ingest, SSE over WS,
personal-first / commercial-clean licensing)._
