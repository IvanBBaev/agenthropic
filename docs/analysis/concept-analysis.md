# agenthropic — Conceptual Brief Analysis (Idea Review)

> **⚠️ SUPERSEDED by [`concept-analysis-v2.md`](concept-analysis-v2.md)** (2026-07-04;
> banner added 2026-07-06). v2 re-runs all lenses folding in this document, the two
> external reports and their adversarial review, and resolves LB1/LB2 + CD-1…CD-10.
> Keep this file for the audit trail; **do not act on its recommendations directly.**
> Current entry point: [`PROJECT-STATE-2026-07-06.md`](PROJECT-STATE-2026-07-06.md).

> **What this is.** A merciless, multi-lens review of the **agenthropic conceptual
> brief** — the product idea as defined in [`docs/ai/DESIGN.md`](../ai/DESIGN.md),
> [`README.md`](../../README.md) and the project [`CLAUDE.md`](../../CLAUDE.md),
> which are themselves a synthesis of the vendor due-diligence (`*.docx` v1/v2) and
> the independent source-level audit (`docs/due-diligence/*`,
> `docs/independent-due-diligence.md`).
>
> **What this is NOT.** It is not another audit of the six candidate dashboards —
> that work is done and it is good. This document turns the same four senior lenses
> the vendor panel used (Architect · Developer · QA · Business Analyst) **onto our
> own idea**, then adds a brutal gap analysis and a holistic read. Companion:
> [`implementation-plan.md`](implementation-plan.md) re-runs the analysis in
> decision form and derives the build plan.
>
> **Author:** internal review · **Date basis:** 2026-07-03 sources · **Verdict:**
> _Build — the idea is sound and the security thinking is best-in-class — but three
> things are under-specified enough to sink it if left as prose: (1) the
> ingest source-of-truth / reconciliation model, (2) licensing hygiene on the
> "patterns to steal", and (3) ruthless MVP scoping against a 6-phase roadmap owned
> by one person._

---

## 0. Executive verdict (holistic, up front)

The agenthropic brief is **directionally excellent and unusually well-grounded** —
it is the rare greenfield idea that starts from a source-level audit of six rivals
instead of a blank page. Its **security model is the single strongest part of the
whole concept** and is genuinely differentiated: every audited competitor binds
`0.0.0.0` and/or ships no-op auth; agenthropic's loopback-only + mandatory-token +
no-spawner + tunnel-only stance is a real moat of correctness, not just features.

The idea's **weakness is not the vision but the connective tissue underneath it**:

1. **Ingest is under-specified where it matters most.** The brief declares two
   invariants — "token counts are ground truth from JSONL" and "agents/subagents
   are first-class persisted entities" — but never states **which source is
   authoritative when they disagree, or how the durable DAG survives the dashboard
   being offline mid-session.** Hooks are best-effort and ephemeral; JSONL is
   durable but may not carry the parent→child linkage the moat feature depends on.
   This is the highest-risk unknown and it is invisible in the current prose.

2. **"Steal these patterns" collides with licensing reality.** The brief's flagship
   grafts — cast's `controlGate.ts` and delegation-savings — come from a repo that
   is **all-rights-reserved** (MIT-by-README-badge only). With stated OPCⁿ commercial
   intent, "steal ~73 LOC" is a legal defect, not a shortcut. Only `simple10` and
   `hoangsonww` are cleanly MIT.

3. **Scope outruns the owner.** A five-feature moat + six-phase roadmap +
   cross-machine fleet + a Phase-3 vector-DB "observability becomes memory" leap is
   a multi-quarter program for a solo builder. Without a ruthless MVP cut, this
   stalls in Phase 2.

None of the three is fatal. All three are cheap to fix **on paper, now**, and
expensive to discover **in code, later**. The rest of this document is the evidence.

**Overall grade of the idea as currently specified: B+ / A−-capable.** The ceiling
is A once the three gaps are closed; the floor is C if they are carried into code
unresolved.

---

## 1. What the brief actually commits to (precise restatement)

Before critiquing, pin the idea down so the critique has a target.

**Product.** A self-hosted, local-first web dashboard that observes and visualises
Claude Code agent/subagent activity for one power-user on a Mac Mini M4, in a
subagent-intensive workflow. No cloud dependency, no telemetry egress.

**The five-feature moat** (§2 of DESIGN — confirmed absent across all six rivals):
1. Global, **persistent, per-instance** orchestration DAG (not session-scoped,
   render-time-derived edges).
2. Live **dollar-cost attribution + delegation-savings** (Haiku/Sonnet vs top-tier).
3. **Telegram** alert sink → `@baev_bot_bot`.
4. **Cross-machine / fleet** aggregation.
5. **Persistence you own** for historical / time-series analysis.

**Architecture.** `hooks → hook-ingest → SQLite (WAL) → WebSocket/SSE → browser SPA
(DAG + Sankey)`, plus a webhook sink → Telegram relay, and a reader of
`~/.claude/projects/*.jsonl` for ground-truth token counts.

**Data model.** Normalised base (`projects/sessions/agents/events/filters`) with a
self-referential `agents.parent_agent_id`; grafted `token_usage` (bucketed by
speed/geo/tier, with compaction baselines), `alert_rules`/`webhook_*`, and
`model_pricing`. Edges must be **persisted** and **per-instance**, carrying an
`instance/host` key for future fleet.

**Security invariants (non-negotiable).** Bind `127.0.0.1`; mandatory token
(`timingSafeEqual`); no browser-driven `claude` spawner (the deliberately-avoided
RCE); same-origin WS; no SSRF; tunnel-only remote; WAL + backups.

**Roadmap.** Phase 0 validation spike → 1 hardened cockpit → 2 Telegram → 3
context-layer/vector-DB feed → 4 delegation-savings tile → 5+ moat extensions (global
DAG, fleet).

**Stated-but-undecided.** Stack (leaning Fastify + better-sqlite3 + React/Vite/D3),
repo structure (pnpm monorepo vs single package), MVP schema scope.

**Newly-added acceptance rules (from Ivan, 2026-07-03, not yet in DESIGN.md):**
**>90% test coverage**, **README badges + a donation section**, and a **GitHub Pages
documentation site**.

---

## 2. Senior Architect review

**Bottom line:** the topology is proven and the invariants are right, but the
**ingest layer hides the two hardest problems in the system** — source-of-truth
reconciliation and event reliability — behind a single arrow (`hooks → hook-ingest`).

### 2.1 What's architecturally sound
- **The loop is a known-good pattern.** hook → HTTP → SQLite → WS → SPA is validated
  by four of the six audited projects. Choosing it is low-risk.
- **Ports & adapters + strategy-pattern agent classes** (borrowed from simple10's
  shape) is the correct backbone for a tool that may later ingest Codex/other
  runtimes. Good separation instinct.
- **First-class, persisted agents/edges** as a *data fact* (not a UI reconstruction)
  is the right call and is exactly what differentiates the moat from the rivals'
  render-time trees.
- **Loopback + WAL + single-writer SQLite** is a coherent, boring, correct choice
  for a single-host tool. No distributed-systems tax at v1.

### 2.2 The load-bearing gap: two sources of truth, no reconciliation contract
The brief asserts both:
- *"Token counts are ground truth from `~/.claude/projects/*.jsonl`, never inferred."*
- *"Agents & subagents are first-class, queryable, persisted entities … fed by hooks."*

These are **two independent ingest sources with different durability and different
coverage**, and the design never defines the contract between them:

| Property | Hooks (live signal) | JSONL logs (durable log) |
|---|---|---|
| Durability | Ephemeral — a missed/failed POST is gone | Written to disk by Claude Code regardless of dashboard |
| Liveness | Real-time | Tail-follow; slight lag |
| Carries parent→child subagent linkage? | **Assumed yes** (SubagentStart/Stop) — must be verified | **Unknown / must be verified** |
| Carries authoritative token counts? | Approximate/derived | **Yes — ground truth** |

**The unanswered question that governs the whole architecture:** if the dashboard is
down (or restarts) during a subagent-heavy session, can the **persistent DAG** be
reconstructed afterwards from JSONL alone — or is the hook stream load-bearing and
therefore the DAG has permanent holes on every outage?

- If **JSONL can reconstruct the tree** → make JSONL the *primary* ingest
  (tail-follow + replay-on-startup), and use hooks only for sub-second liveness. The
  system becomes crash-tolerant and backfillable. This is the robust design.
- If **only hooks carry the linkage** → the moat feature (persistent DAG) is
  hostage to best-effort delivery, and you need an explicit durability story
  (local spool/outbox for hook POSTs, at-least-once + idempotent upsert).

**This must be resolved in Phase 0**, and it is currently invisible. Recommend the
Phase-0 spike explicitly answer it (see implementation plan Gate G0).

### 2.3 Event reliability & ordering (unaddressed)
Beyond source-of-truth, the ingest must be robust to:
- **Missing terminal events** — a `SubagentStop` that never arrives leaves a "stuck"
  working agent. The brief nods at copying hoangsonww's watchdog (~15 s idle
  timeout) — good, but the watchdog is a *symptom* fix; the *state model* needs an
  explicit `working → (timeout) → unknown` transition, not just `working/completed`.
- **Out-of-order arrival** — child `SubagentStart` arriving before parent context
  (orphan). simple10 handles this with orphan-reparenting/root-synthesis; agenthropic
  must adopt the same, and **persist** the reparenting decision idempotently.
- **Duplicate delivery / replay** — every ingest write must be an **idempotent
  upsert keyed on a stable event id**, or restart/backfill double-counts tokens.
- **Verify the actual hook catalog.** The brief lists twelve events including
  `SubagentStart`, `PermissionRequest`, `PostToolUseFailure` — **not all of these are
  guaranteed to exist as Claude Code hooks.** The parenthetical "(+ SubagentStart)"
  signals the design's own uncertainty. Phase 0 must confirm the real hook set
  against the installed Claude Code version before the tree design is committed.

### 2.4 Cross-machine / fleet (deferred, but the schema hedge is right)
Fleet aggregation over SQLite is a genuine architectural fork (single-writer store,
push-vs-pull transport, inter-node auth, clock skew). The roadmap correctly parks it
at Phase 5+. The **cheap, correct hedge** — carry an `instance/host` key on rows from
day one — is already in the brief. Keep it; build nothing else fleet-related until a
second machine actually exists.

### 2.5 Scaling & DB growth (missing)
"Persistence you own" with no retention policy is **unbounded growth**. A
subagent-intensive workflow can emit large tool payloads (simple10 stores *full*
payloads). The brief mentions backups but **no retention/pruning/compaction/redaction
policy**. On a Mac Mini this is a slow leak, not a wall — but it is a real omission.

### 2.6 Architect's verdict
Topology **A−**; invariants **A**; ingest-robustness specification **C**. The gap is
narrow, well-understood, and Phase-0-resolvable — but it is the make-or-break of the
moat feature and must stop being implicit.

---

## 3. Senior Developer review

**Bottom line:** the stack lean is reasonable and the build is feasible, but the
brief systematically **understates integration cost** — "graft", "steal", and
"borrow ~50 LOC" describe cross-language, cross-license, cross-schema work as if it
were copy-paste.

### 3.1 Stack (Fastify + better-sqlite3 + React/Vite/D3) — endorse, with notes
- **kiko-aligned, arm64-native, boring in the good way.** Endorsed.
- **`better-sqlite3` is synchronous** — it blocks the event loop on every query.
  For a single-user local tool this is *fine and actually simpler* (no async race on
  writes), but heavy queries (the global DAG over a large history) must be kept
  cheap or moved off the hot path. Keep the `node:sqlite` fallback idea (hoangsonww's
  dual-driver) as portability insurance against native-binding churn.
- **SSE vs WebSocket** is presented as "WebSocket/SSE" — pick one. For a
  server→browser live feed with no client→server messaging, **SSE is simpler,
  auto-reconnects, and dodges the same-origin-WS handshake work**. Choose WS only if
  bidirectional control is actually needed (it is not, at v1). Decide it, don't
  slash it.

### 3.2 "Graft" is doing enormous work — cost the integration honestly
The brief's §7 / recommendation §"what to steal" table reads as low-effort lifts.
Source reality:

| Advertised graft | Real cost |
|---|---|
| hoangsonww `formatTelegram` + alert/webhook schema | Cleanest lift (same TS ecosystem, MIT). Still needs the whole `alert_rules`/`webhook_targets`/`webhook_deliveries`/`model_pricing` subschema wired into our base — **not one file, a subsystem.** |
| cast `controlGate.ts` (~73 LOC) | **Cannot be copied — cast is all-rights-reserved** (see §6.2). Reimplement the *shape* clean-room. Small, but it's engineering, not lifting. |
| cast delegation-savings (~50 LOC) | Same license bar; plus the **pricing table is hardcoded & stale** — you inherit a maintenance liability, not a finished metric. |
| disler `send_event.py` (~180 LOC) | **Teaching reference only** (no license; design already says so). Zero code reuse. |
| simple10 `buildAgentTree()`/`layoutTree()`/`physics.ts` | If greenfield (not forking simple10), this is **re-implemented from scratch** — the force graph + tree layout is the single largest UI build item, not a graft. |

**Net:** the "assemble from proven parts" framing is optimistic. In greenfield mode,
most "parts" are *ideas to reimplement*, and the only genuinely copyable code
(hoangsonww's Telegram/webhook subsystem, simple10's structures) still needs
substantial integration into a schema we define. Budget accordingly.

### 3.3 The token_usage / compaction-baseline graft is the sleeper
Bucketing `token_usage` by speed/geo/tier **and** preserving compaction baselines so
historical totals re-price correctly after a `PreCompact` context rewrite is **the
most subtle piece of the entire costing model.** Lifting it from hoangsonww's
12-table schema into a 5-table base is real schema-design work, and getting it wrong
means silently wrong dollar figures — which undermines the moat's credibility. Treat
this as a designed feature with its own tests, not a graft.

### 3.4 Hook installation & DX (under-discussed)
The system's input depends on **Claude Code hooks being installed and POSTing to a
local port.** That means: a hook-install step (shell/Python scripts under
`~/.claude/`), a stable local contract (port, auth for the loopback POST), graceful
behaviour when the dashboard is down (do hooks block the agent? time out? spool?),
and a zero-friction install DX to clear (claude-code-templates' `npx … --analytics`
zero-install bar is explicitly named as the UX to beat). None of this is specified.

### 3.5 The >90% coverage bar changes the build shape
The new rule (>90% coverage) is **not free** on a system whose inputs are lifecycle
events and whose outputs are a live graph. It forces: a synthetic event generator,
recorded real-session JSONL fixtures, deterministic tree-building tests, and
WS/SSE-flow tests. This is healthy but it is **weeks of test infrastructure** that
must be planned into the phases, not bolted on. simple10 having *no test-on-PR CI* is
exactly the failure mode to avoid.

### 3.6 Developer's verdict
Feasible and well-chosen stack; **effort is under-budgeted by roughly the
integration + test-infra + hook-DX work the word "graft" hides.** Decide SSE-vs-WS
and monorepo-vs-single-package before scaffolding, or churn later.

---

## 4. Senior QA review

**Bottom line:** this system is **hostile to naive testing** (its input is an
external agent's lifecycle, its output is a live visual graph), which makes the
>90% coverage rule both correct and expensive — and it demands a fixtures strategy
the brief doesn't have yet.

### 4.1 The core testability problem
You cannot unit-test "the dashboard" by poking a function. The units are:
- **Ingest correctness** — given a stream of (possibly out-of-order, duplicated,
  incomplete) events, does the DB reach the right state?
- **Tree correctness** — does `buildAgentTree`-equivalent produce the right nesting
  for real, messy sessions (orphans, missing stops, re-parenting)?
- **Cost correctness** — do stored token totals match JSONL ground truth **exactly**,
  including across a `PreCompact` baseline rewrite?
- **Live-flow correctness** — does a hook POST propagate to a connected client?

Each needs a different harness. The brief's Phase-0 "confirm the tree renders your
nesting" is a **manual eyeball gate**, not a test. Good as a smoke gate; insufficient
as the quality bar.

### 4.2 The fixtures gap (the single most important QA investment)
The design's own strongest instruction — *"validate our own tree against one real
subagent-heavy session before committing"* — implies the asset that makes all of this
testable: **recorded real-session JSONL + hook-event captures.** These become golden
fixtures. Without a corpus of real sessions (including pathological ones: deeply
nested subagents, a crashed subagent with no Stop, a compaction mid-session, two
concurrent Claude Code instances), the >90% coverage will be *high-coverage tests of
synthetic happy paths* — a false sense of safety. **Building the fixture corpus is a
first-class task, not test overhead.**

### 4.3 Data-integrity tests are non-negotiable (this is the moat's credibility)
- **Reconciliation test:** sum of persisted `token_usage` == JSONL ground truth, per
  session, byte-for-byte on token counts. This is the test that protects the "never
  inferred" invariant.
- **Idempotency/replay test:** ingesting the same event log twice yields identical DB
  state (no double-count). Directly guards §2.3.
- **Compaction test:** a session that hits `PreCompact` still prices correctly against
  the preserved baseline.
- **Cost-accuracy test:** the delegation-savings figure is reproducible and the
  pricing table is under test (so a stale rate fails a test, not a user's trust).

### 4.4 Security tests as first-class citizens
The security invariants are the product's differentiator — so they must be
**enforced by tests that fail the build**, not by discipline:
- bind is `127.0.0.1` (assert the server refuses `0.0.0.0`);
- unauth request to a write endpoint → 401/404 (constant-time);
- WS/SSE rejects cross-origin;
- **there exists no route that spawns a subprocess from request input** (a grep-level
  test / lint rule that fails if a `claude` spawner is ever reintroduced);
- no outbound dial to a URL taken from an event payload (SSRF guard test).

### 4.5 CI is a stated gap in every rival — don't inherit it
Every audited project either has no tests (disler, nirdiamant) or **no test-on-PR CI**
(simple10). agenthropic's rule set now mandates >90% coverage; that rule is only real
if a **CI gate blocks merges below the threshold.** QA sign-off: coverage gate +
security-invariant tests + golden-fixture replay, all in CI, or the number is theatre.

### 4.6 QA's verdict
Testable, but only with a deliberate **fixtures + reconciliation + security-invariant**
strategy that currently doesn't exist on paper. The >90% rule is the right forcing
function; it must be planned as infrastructure (a phase-spanning workstream), and it
must gate CI from Phase 1.

---

## 5. Senior Business Analyst review

**Bottom line:** the value proposition is real and the positioning is honest (beat
claude-code-templates on the four things it lacks), but the brief carries an
**unresolved identity split** — *personal tool for one Mac Mini* vs *OPCⁿ commercial
product* — that silently inflates scope and must be decided before it distorts v1.

### 5.1 The value proposition is genuine and narrowly-defensible
- The market thesis survives in its **narrowed** form: no *persistent DAG cockpit
  with dollar cost + persistence + alerting* exists that is also popular/maintained.
  That is a real gap.
- The baseline is honestly named (claude-code-templates, 28.4k★): agenthropic must
  **beat a real incumbent's feature set**, not fill a vacuum. Healthy framing.
- **Defensibility caveat:** four of the five moat features (persistence, cost, alerts,
  DAG) are things claude-code-templates *could add.* The durable moat is the
  **persistent per-instance DAG + the security posture + fleet** — the parts that are
  architecturally hard to retrofit. Positioning should lead with those.

### 5.2 The identity split is the BA's central concern
The recommendation's open question #2 — *"does 'may commercialize later' harden into
a v1 constraint now?"* — is **load-bearing and unanswered**, and it changes
requirements today:

| If **personal tool** (one user, one Mac Mini) | If **OPCⁿ product** (commercial) |
|---|---|
| Fleet/cross-machine is speculative — **cut it** | Fleet + multi-tenant data model is a real requirement |
| License hygiene on grafts is low-stakes | License hygiene is **mandatory** (see §6.2) — no all-rights-reserved code, ever |
| Single-tenant schema is fine | Data isolation / tenancy must be designed in from the schema |
| Donation link = "buy me a coffee" | Donation vs pricing/licensing is a product decision |
| >90% coverage/badges/Pages = personal polish | Same, but now they're table-stakes credibility signals |

**BA recommendation:** declare v1 as **personal-first, commercial-clean** — build the
single-user tool, but adopt the *cheap* commercial hedges now (MIT-clean code only,
instance/host key, no data model that would block tenancy) and **defer every
expensive commercial feature (fleet, multi-tenant) explicitly.** This resolves the
split without paying for it prematurely.

### 5.3 Scope realism — the roadmap is a program, not a sprint
Six phases, five moat features, a vector-DB "observability becomes memory" leap
(Phase 3), and fleet (Phase 5+) is **multi-quarter work for a solo builder.** Two
BA red flags:
- **Phase 3 (context-layer/vector-DB feed) is scope creep wearing a roadmap hat.**
  "Observability becomes memory" is a *different product*. It introduces a vector DB,
  an embedding pipeline, and nightly jobs — a large undefined dependency. Recommend
  **moving it out of the core roadmap** into a clearly-labelled "future/experimental"
  track. It must not compete with shipping the cockpit.
- **The delegation-savings tile risks being a vanity metric.** "You saved $X by
  routing to Haiku" is satisfying but only *actionable* if it changes behaviour.
  Define the decision it informs, or it's dashboard candy. (It's cheap, so keep it —
  but label it honestly.)

### 5.4 Success criteria are undefined
There is no stated definition of success for v1. For a personal tool the honest metric
is *"Ivan uses it daily to answer a question he couldn't answer before"* — e.g. "which
subagent burned the most tokens last night," "did any session get stuck," "what did
last week cost." **Write the 3–5 questions the cockpit must answer**, and let those
drive MVP scope. Without them, scope is driven by feature-envy of the rivals.

### 5.5 BA's verdict
Sound value, honest positioning, **real risk of scope diffusion.** Resolve the
personal-vs-commercial identity (recommend personal-first/commercial-clean), cut
Phase 3 out of the core line, define the 3–5 questions v1 must answer, and the
business case is clean.

---

## 6. Brutal gap analysis

The sharpest, most decision-relevant holes — ranked by how much they'd hurt if
carried into code unresolved.

### 6.1 🔴 Ingest source-of-truth is unspecified (the make-or-break)
Covered in §2.2. The brief's two invariants describe two sources but no contract.
**The moat feature (persistent DAG) may or may not be reconstructable from the
durable log.** Until Phase 0 answers "can JSONL alone rebuild the tree?", the
architecture is undecided. *This is gap #1 because everything downstream depends on
it.*

### 6.2 🔴 Licensing hygiene — "steal" collides with all-rights-reserved sources
The brief's headline grafts are **legally uncopyable**:
- **cast** (`controlGate.ts`, delegation-savings `analytics.ts`): "MIT" is a
  **README badge only** — `private:true`, no `license` field, no LICENSE file =
  **all-rights-reserved.** Copying its code, even 73 lines, is infringement.
- **disler** (`send_event.py`): no license → all-rights-reserved. (Design already
  treats it as teaching-only — correct.)
- **nirdiamant**: MIT *declared* but **no LICENSE file** → murky; treat as non-copyable.
- **Cleanly copyable (MIT + real LICENSE):** only **simple10** and **hoangsonww**.

**Why it's brutal:** the design docs use "steal/graft/borrow ~50 LOC" uniformly, which
**blurs copy-the-code (legal only for simple10/hoangsonww) with reimplement-the-idea
(legal for all).** With OPCⁿ commercial intent, shipping all-rights-reserved code is a
latent legal defect. **Mitigation is cheap** (the cast/nirdiamant ideas are tiny and
trivially clean-room reimplementable) — but the constraint must be stated: *from
cast/disler/nirdiamant, reimplement ideas clean-room; never copy source.* This
finding is not in any current doc.

### 6.3 🟠 No durability/replay/backfill story for the live signal
If the dashboard is offline, are hook events lost forever (holes in history), or can
the system backfill from JSONL on startup? No spool/outbox, no replay-on-startup, no
idempotent-upsert contract is specified. Directly determines whether "persistence you
own" is trustworthy or full of gaps. (Tightly coupled to 6.1.)

### 6.4 🟠 Cost correctness depends on a hand-maintained, churn-prone pricing table
`model_pricing` + delegation-savings assume a pricing table that is, in the source,
**hardcoded and stale.** The model lineup is actively churning (Opus 4.8, Sonnet 5,
Haiku 4.5, Fable 5…). There is no stated source-of-truth for prices, no update
process, and no test that fails when a rate goes stale. A wrong dollar figure quietly
discredits the whole cost moat.

### 6.5 🟠 The new acceptance rules aren't in the design yet
Ivan's stated bar — **>90% coverage, README badges + donation, GitHub Pages docs
site** — appears in none of DESIGN.md/README/CLAUDE.md. Until reflected as
first-class acceptance criteria (coverage-gated CI, badge block, Pages pipeline,
donation section), they'll be remembered late and retrofitted. (This document + the
implementation plan close the gap; DESIGN.md should be updated to match.)

### 6.6 🟡 Secret management for the Telegram bot is unaddressed
Security §"don't hold `ANTHROPIC_API_KEY` in the dashboard env" is stated, but the
**Telegram bot token must live somewhere** to relay to `@baev_bot_bot`. Where, and
with what handling (env, keychain, file perms)? Unspecified. Small, but it's a live
secret in a security-forward product.

### 6.7 🟡 No data retention / DB-growth / payload-redaction policy
Covered in §2.5. "Persistence you own" without a retention/redaction policy is
unbounded growth of possibly-sensitive full tool payloads. simple10's "stores full
payloads" is flagged as a must-fix; agenthropic hasn't stated its own policy.

### 6.8 🟡 Hook catalog & install DX unverified
Not all twelve listed hooks are confirmed to exist (`SubagentStart`,
`PermissionRequest`, `PostToolUseFailure` need verification), and the hook-install /
loopback-POST-contract / dashboard-down behaviour is unspecified (§3.4). Phase-0 items.

### 6.9 🟢 Meta-gap: the dossier index points to files, links between docs are the record
The docs are strong, but `docs/due-diligence/README.md` historically promised
sub-files that arrived later; keep the cross-links honest as the doc set grows (this
analysis + the plan add two more nodes). Housekeeping, not risk — noted for
completeness because "merciless" was the mandate.

---

## 7. Holistic analysis (the system as one thing)

Step back from the parts.

**Coherence.** The idea is internally coherent and, unusually, *earned* — it descends
from a real audit, and every moat feature maps to a confirmed rival gap. The security
model is not bolted on; it's the spine, and it's the one dimension where the concept
is unambiguously ahead of the entire field. That coherence is the concept's biggest
asset.

**The central tension** is **ambition vs. ownership.** One person is proposing to
out-build a 28.4k★ incumbent on five axes, with best-in-class security, >90%
coverage, a docs site, *and* a vector-DB memory layer. Each piece is reasonable; the
sum is a program. The holistic risk is not that any part is wrong — it's that the
*whole* is sized for a team and owned by one. The rivals' failure modes are
instructive here: hoangsonww is "enterprise cosplay over a solo project" (bus factor
1, 70 badges, 92k LOC) — the exact trap of a solo builder over-scoping. agenthropic's
antidote is **ruthless sequencing**: ship the smallest thing that answers a real daily
question, under real security, with real tests, *then* extend.

**Where the concept is strongest → weakest, as a gradient:**
1. **Security posture** — A (differentiated, correct, tested-able).
2. **Positioning / market read** — A− (honest baseline, narrow-but-real gap).
3. **Architecture topology & invariants** — A− (proven loop, right data-fact stance).
4. **Data model ambition** — B+ (right shape; the token/compaction graft is the risk).
5. **Ingest robustness spec** — C (the load-bearing gap; §2.2/6.1/6.3).
6. **Scope discipline** — C+ (roadmap is a program; Phase 3 is a different product).
7. **Licensing hygiene of grafts** — C (§6.2; cheap to fix, currently wrong).

**The holistic through-line:** agenthropic's *vision* is A-grade and its *security
thinking* is best-in-class; its *connective specifications* (how data reliably gets
in, stays correct, and stays legal) and its *scope discipline* are where the grade is
lost. All the lost grade is recoverable **on paper, before code** — which is precisely
what this review and the implementation plan exist to do.

**One-sentence holistic verdict:** _Build it — but resolve ingest source-of-truth,
fix the licensing framing, and cut scope to a daily-usable core, before writing the
first line of the server._

---

## 8. Strengths & weaknesses (consolidated)

### Strengths
| # | Strength | Why it matters |
|---|---|---|
| S1 | **Best-in-class security model** | Every rival fails here (0.0.0.0, no-op auth, RCE, SSRF). This is a genuine, hard-to-copy moat and a credibility signal. |
| S2 | **Grounded in a real source-level audit** | The idea isn't speculative; each moat feature maps to a *confirmed* gap across six rivals. |
| S3 | **Right architectural instincts** | Proven ingest loop; first-class *persisted* agents/edges as a data fact; ports & adapters; strategy-pattern extensibility. |
| S4 | **Honest positioning** | Names the real baseline (claude-code-templates, 28.4k★) instead of claiming a vacuum. |
| S5 | **Docker-optional, arm64-native, local-first** | Fits the Mac Mini M4 constraint exactly; no always-on daemon tax. |
| S6 | **Clear non-negotiables** | Loopback, mandatory token, no spawner, tunnel-only — decisiveness where the field is sloppy. |
| S7 | **Cheap commercial hedges already present** | instance/host key + MIT-clean intent set up a later OPCⁿ pivot without paying for it now. |

### Weaknesses
| # | Weakness | Severity | Fix cost |
|---|---|---|---|
| W1 | **Ingest source-of-truth / reconciliation unspecified** (§2.2, §6.1) | 🔴 make-or-break | Low (Phase-0 spike + a written contract) |
| W2 | **Licensing framing conflates copy vs. reimplement; flagship grafts are all-rights-reserved** (§6.2) | 🔴 legal, given OPCⁿ | Low (state the rule; reimplement clean-room) |
| W3 | **No durability/replay/backfill/idempotency story** (§6.3) | 🟠 correctness of history | Medium (design + tests) |
| W4 | **Cost correctness rests on a stale, hand-maintained pricing table** (§6.4) | 🟠 discredits the moat | Medium (source-of-truth + tests) |
| W5 | **Scope outruns a solo owner; Phase 3 is a different product** (§5.3, §7) | 🟠 stall risk | Low (cut/defer decisions) |
| W6 | **Integration cost hidden behind "graft/steal"** (§3.2–3.3) | 🟡 schedule risk | Low (re-budget) |
| W7 | **New acceptance rules (coverage/badges/Pages/donation) not in the design** (§6.5) | 🟡 retrofit risk | Low (this doc + plan) |
| W8 | **No retention/redaction/DB-growth policy; Telegram secret home; hook-catalog/DX unverified** (§6.6–6.8) | 🟡 operational | Low–Medium |

---

## 9. Deep mandatory analysis (dimension-by-dimension)

The exhaustive pass. Each dimension: what the brief says, what's missing, the risk,
the mitigation.

### 9.1 Ingestion & data flow
- **Says:** hooks → hook-ingest → SQLite; JSONL read for ground-truth tokens.
- **Missing:** the reconciliation contract; durability/replay; idempotency;
  out-of-order handling; the real hook catalog; dashboard-down behaviour.
- **Risk:** the persistent DAG (the moat) has silent holes; token double-counting on
  replay; stuck agents on missed Stop.
- **Mitigation:** Phase-0 spike answers "JSONL-primary vs hooks-primary"; adopt
  **idempotent upsert keyed on stable event id**; **local outbox/spool** for hook
  POSTs if hooks are load-bearing; explicit `working→unknown` state via watchdog;
  golden-fixture replay tests (§4).

### 9.2 Data model & schema
- **Says:** normalised base + self-ref `parent_agent_id`; grafted `token_usage`
  (speed/geo/tier + compaction baselines), `alert_*`/`webhook_*`, `model_pricing`;
  persisted per-instance edges with instance/host key.
- **Missing:** the **edge table definition** (the persisted-DAG's core is only
  described in prose, not sketched); migration tooling; retention columns; redaction.
- **Risk:** the moat's central artefact (persisted edges) is the least-specified
  table; compaction-baseline modelling is subtle and easy to get wrong.
- **Mitigation:** design the `agent_edges` (or equivalent) table explicitly —
  `(parent_agent_id, child_agent_id, session_id, instance, derived_from_event_id,
  created_at)` with an idempotent upsert; treat token_usage/compaction as a
  first-class designed feature with its own reconciliation tests; pick a migration
  tool (e.g. a simple forward-only migration runner) at scaffold time.

### 9.3 Visualisation
- **Says:** session-scoped tree (match simple10's buildAgentTree/layoutTree/physics),
  study hoangsonww's D3 Sankey/aggregate polish; global persistent per-instance DAG
  as first extension (ELK/Graphviz).
- **Missing:** greenfield means **re-implementing** the force graph/tree layout — the
  largest single UI item — not grafting it. No perf budget for the global DAG over a
  large history.
- **Risk:** UI effort under-budgeted; global DAG query gets expensive.
- **Mitigation:** treat the graph as the flagship build item; validate against real
  fixtures (Phase 0 gate); keep global-DAG queries cheap or precomputed.

### 9.4 Cost & delegation-savings
- **Says:** dual-price token_usage (actual vs top-tier); borrow cast's ~50-LOC formula.
- **Missing:** pricing source-of-truth & update process; tests; clean-room reimpl
  (license); the *decision* the savings figure informs.
- **Risk:** stale/wrong dollar figures; vanity metric.
- **Mitigation:** single, dated pricing constant with a test that asserts model
  coverage; reimplement the formula clean-room; label the metric's purpose (§5.3).

### 9.5 Alerting / Telegram
- **Says:** graft hoangsonww's `formatTelegram` + alert/webhook schema →
  `@baev_bot_bot`; rules for error/complete/quota.
- **Missing:** bot-token secret home; delivery reliability (retries in
  `webhook_deliveries` — is that modelled?); rate-limiting alerts (a stuck-loop could
  spam).
- **Risk:** secret sprawl; alert storms.
- **Mitigation:** define secret storage (env/keychain, tight file perms), dedupe/
  rate-limit alerts, use the `webhook_deliveries` table for retry/backoff.

### 9.6 Security (the strong suit — verify it stays strong)
- **Says:** loopback, mandatory token (timingSafeEqual), no spawner, same-origin WS,
  no SSRF, tunnel-only, WAL+backups.
- **Missing:** the invariants must become **tests that fail the build** (§4.4), not
  prose; payload redaction; the loopback-POST auth for hooks themselves.
- **Risk:** drift — a future feature reintroduces a spawner or a 0.0.0.0 bind.
- **Mitigation:** security-invariant test suite + a lint/grep gate for spawners in CI;
  redact stored payloads; document the threat model as living tests.

### 9.7 Reliability & operations
- **Missing:** meta-monitoring (how do you know the dashboard itself died?); backup
  verification (a backup you never restore is a hope); retention/pruning; log rotation.
- **Risk:** silent observer failure; unbounded DB.
- **Mitigation:** a liveness heartbeat (even a Telegram "I'm alive" / "I died via
  launchd KeepAlive" signal); tested restore; retention policy.

### 9.8 Testing & CI (see §4)
- **Says:** validate the tree against one real session (Phase 0).
- **Missing:** everything between a manual smoke gate and >90% coverage — fixtures,
  reconciliation/idempotency/compaction/security tests, and a **CI coverage gate**.
- **Mitigation:** the §4 strategy as a phase-spanning workstream; CI gate from Phase 1.

### 9.9 Delivery hygiene (Ivan's new rules)
- **Missing from design:** >90% coverage gate, README badges (green/true only, via the
  `badges` skill) + donation section, GitHub Pages docs site.
- **Mitigation:** first-class acceptance criteria in the plan; keep the app loopback
  even though the docs site is public.

### 9.10 Risk register (consolidated)
| ID | Risk | Likelihood | Impact | Mitigation | Owner phase |
|---|---|---|---|---|---|
| R1 | JSONL can't reconstruct the tree → DAG has holes on outage | Med | High | Phase-0 spike; JSONL-primary if possible; outbox if not | P0 |
| R2 | Token double-count on replay/restart | Med | High | Idempotent upsert on stable id; replay test | P1 |
| R3 | All-rights-reserved code copied → legal defect | Med (if unflagged) | High (commercial) | Clean-room reimpl rule; MIT-only copy | P0 (policy) |
| R4 | Stale pricing → wrong dollar figures | High | Med | Dated pricing const + coverage test | P4 |
| R5 | Scope diffusion → stall in Phase 2 | High | High | Cut Phase 3 to experimental; MVP by "daily questions" | P0 (scoping) |
| R6 | Missed SubagentStop → stuck agents | High | Low–Med | Watchdog + explicit unknown state | P1 |
| R7 | Unbounded DB / full-payload storage | Med | Med | Retention + redaction policy | P1 |
| R8 | Security drift (spawner/0.0.0.0 reintroduced) | Low | High | Security-invariant tests + CI grep gate | P1 |
| R9 | Hook catalog assumptions wrong | Med | Med | Verify against installed Claude Code | P0 |
| R10 | Coverage rule is theatre without CI gate | Med | Med | CI blocks merges <90% | P1 |

---

## 10. Open questions that must be answered before build

These are the decisions that unblock the implementation plan (companion doc turns
them into resolved recommendations):

1. **Ingest primacy** — is JSONL the primary durable source (tail-follow + replay),
   with hooks for liveness? *(Phase-0 spike decides; the plan assumes JSONL-primary
   as the robust default.)*
2. **Identity** — personal-first/commercial-clean (recommended), or full OPCⁿ product
   scope now? *(Governs fleet, tenancy, license strictness.)*
3. **v1 daily-questions** — what 3–5 questions must the cockpit answer on day one?
   *(Drives MVP scope over feature-envy.)*
4. **Stack finalisation** — Fastify + better-sqlite3 + React/Vite/D3 (endorsed);
   **SSE vs WebSocket** (recommend SSE); **monorepo vs single package**.
5. **Phase 3 disposition** — move the vector-DB/context-memory feed to an
   experimental track (recommended)?
6. **Pricing source-of-truth** — where do model rates come from and how are they kept
   fresh + tested?
7. **Secret home** — where does the Telegram bot token live?

---

## 11. Verdict

**Build agenthropic.** The idea is sound, the market gap is narrow-but-real, and the
security model is a genuine, differentiated moat that the entire competitive field
fails. The concept's grade is held below A only by *specification gaps in the
connective tissue* — ingest source-of-truth, licensing hygiene, durability/replay,
cost correctness, and scope discipline — **every one of which is cheap to resolve on
paper and expensive to discover in code.**

Proceed to the [implementation plan](implementation-plan.md), which re-runs this
analysis in decision form and turns these findings into a sequenced, testable,
coverage-gated build — starting with the Phase-0 spike that resolves the single
make-or-break unknown (R1) before any architecture is committed.
