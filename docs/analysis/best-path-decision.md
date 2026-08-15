# Best-Path Decision — what is actually best to build, and how

**Strategic decision memo.** Ivan asked, after the plan was authored: _"do a deep analysis
and tell me what is best."_ This is the answer, and the evidence behind it. It was produced
by an adversarial workflow — **six independent strategic theses**, each stress-tested by
**three diverse critics** (feasibility / evidence / constraints), then reconciled by a
deciding judge — and then its two load-bearing empirical claims were **re-verified by hand on
this machine**. Confidence: **76/100**.

> This memo sits **above** the mechanical plan. Where it and
> [`development-plan.md`](development-plan.md) disagree, this memo's re-sequencing wins; the
> plan is being amended to match (see §6). It refines — it does not replace — the ten
> canonical decisions in [`concept-analysis-v2.md`](concept-analysis-v2.md).

> **📎 Empirical update (2026-07-04) — the [Phase-0 probe](phase0-probe.md) ran and refines
> three claims in this memo. Read it as the newer evidence where they differ:**
> 1. **The spawn tool is `Agent` / `Workflow`, not `Task`** (verified: 0 `Task` blocks, 142
>    `Agent`, 29 `Workflow`). A `Task`-keyed parser reconstructs an **empty** DAG — the single
>    highest-impact correction. The moat's data-fact still holds; the join key was misnamed.
> 2. **Layout drift is spawn-mechanism-driven, not version-driven** — the "churns on
>    `2.1.198 → 2.1.199`" line in §2 is wrong; both layouts coexist within the same versions
>    (`Agent`-tool → flat, `Workflow`-tool → nested). The parser branches on **directory shape**.
> 3. **The durable outbox (`WP-IN11`) is now `YAGNI-leaning`, not load-bearing** — §1/§6/Risk-2
>    said "do not demote it." The evidence downgrades it: JSONL self-reconciles by backfill,
>    ~0 historical crashes, the outbox buys latency not correctness. **Still load-bearing:**
>    dual-layout parsing (85% of agents are nested) and child-transcript token summation
>    (0% parent rollup). CD-1 lands `CONDITIONAL-GO → build`, confidence 85.

---

## 1. Bottom line

**Best = a moat-first _greenfield_ build — but sequenced and de-risked far more honestly than
the 75-WP plan, and _not_ via the two seductive simplifications that dominated the debate.**

- **Greenfield the spine, copy the tree.** Build the security + persisted-substrate spine
  yourself (it is the moat and is _un-forkable_); **copy simple10's `buildAgentTree` /
  `layoutTree` / physics with attribution** (MIT, CD-9 already authorizes it). Do **not**
  fork simple10 wholesale, and do **not** reinvent the tree layout from a blank page.
- **The moat is the persistent cross-session DAG + dollar-cost — nothing else.** Alerts,
  SSE, the animated room, the vector-DB feed are not the moat and must come off the critical
  path.
- **LB1 is a `CONDITIONAL-GO`, not a clean GO** (this is the correction — see §2). That makes
  the durable-outbox + backfill hedge **load-bearing, not YAGNI**. The two theses that wanted
  to delete them were the most dangerous in the whole record.

---

## 2. The empirical correction (why this overrides the earlier "clean GO likely")

Earlier analysis assumed Phase-0 would probably return a clean GO. **Reading the real
`~/.claude/projects/` corpus on this machine says otherwise.** The following were
**re-verified by hand** for this memo:

| Finding | Verified value | Consequence |
|---|---|---|
| Two on-disk subagent layouts **coexist right now** | **148** flat `subagents/agent-*.jsonl` files · **18** nested `subagents/workflows/wf_*/` dirs · **33** `subagents` dirs total | Claude Code **churns the format** (already broke `2.1.198 → 2.1.199`). The reconstructor must parse **both** and pin the CC version. |
| Depth-1 parent→child edge is a **hard key** | `agentId` in the parent's spawn-tool result (`Agent`/`Workflow`, never `Task`) names the child transcript (present in the flat files) | JSONL is the authoritative substrate → **JSONL-primary is right**; tokens stay ground-truth. |
| Depth-1 join is **not universally clean** | ~**25–32 / 33** dirs join cleanly; `b24be30c` has `spawnDepth {1:14, 2:6}`; one dir showed **12 parent agentIds vs 11 child files** | **Depth-2+ nested edges are not recoverable** by the naive depth-1 join — an open gap (~30% orphaned nested children in one session). |
| Token rollup is **sparse** | ~**83%** of spawn-tool (`Agent`/`Workflow`) results carry **no** token rollup | For `Σ(token_usage) == JSONL` exact, you **must** sum child transcripts, not read a parent rollup. |

**Verdict on CD-1: `CONDITIONAL-GO / JSONL-primary-with-hedge.`** JSONL is the durable
substrate, but because the layout drifts and depth-2 edges + token attribution are not free,
you **must keep** (1) the durable-outbox + hooks-liveness fallback (WP-IN11 — do **not**
demote to YAGNI), and (2) CD-3's `token_usage.agent_id` backfill (it is an _intra-JSONL_
ordering/attribution problem that survives single-source — the "collapse to nothing" claim
was simply wrong). The only ceremony that genuinely retires is **cross-source merge
precedence**, not the immutable substrate and not the backfill.

> Why this matters: adopting "SQLite as a nuke-and-rebuild cache / JSONL sole writer" on a
> `CONDITIONAL-GO` would make the product's headline promise — _"the DAG survives an outage
> and is trustworthy"_ — **false**, manufacturing false trust, which is worse than no graph.

---

## 3. Build vs buy

**Greenfield the spine + attributed grafts.** Rejected alternatives, with why:

| Option | Verdict | Reason |
|---|---|---|
| **Greenfield spine + copy simple10 tree/physics (attributed)** | ✅ **chosen** | The persisted, outage-surviving `orchestration_edges` is the moat and is the _opposite_ of simple10's **render-time-derived** edges (`independent-due-diligence.md:54`). The spine is un-forkable; the tree layout is free to copy under MIT. |
| **Fork simple10 wholesale** | ❌ rejected (weakest surviving thesis, 58/100) | Foreign-code comprehension + a retro security audit (simple10 ships `0.0.0.0` + zero auth) + retrofitting the >90% gate onto code you didn't author is **harder**, not easier — and its render-time data model fights persistence. |
| **Reinvent the tree from a blank page** | ❌ rejected | `buildAgentTree`/`layoutTree`/physics are MIT and solved; copying with attribution is strictly cheaper. |
| **Adopt-only / don't build** | ⚠️ kept as falsifier (see §9) | Fails as a build path, but its _core_ (opportunity cost) survives and Ivan should hold it. |

One cheap hedge worth taking **only if the Phase-0 probe is ambiguous**: a same-session
fork-feasibility spike that _measures_ the persist-edges graft cost. The persisted-edge
invariant almost certainly settles it toward greenfield first.

---

## 4. The single highest-leverage decision

**The answer to LB1 / CD-1 — resolved at the _correct_ empirical scope.** Not the 3-directory
happy-path glance that produced a false "clean GO", and not the 7-WP paired-capture cathedral.
**A single-afternoon read-only probe over the full multi-layout corpus** that answers four
questions, not one:

1. **Depth-1 edge** — hard key `agentId → child transcript` (already GO).
2. **Depth-2+ nested edge recovery** — via `meta.json` / `toolUseId` / `spawnDepth` (**open
   gap** today).
3. **Version-layout drift** — flat vs nested handling (already broke on a patch bump).
4. **Per-agent token attribution completeness** — child-transcript summation for `Σ == JSONL`
   exact (~83% of spawn-tool results have no rollup).

Everything downstream — whether to keep reconciliation/outbox, whether the "trustworthy DAG"
selling point is real, **whether to build the program at all** — hangs off this one
evidence-backed call. It is cheap, throwaway, and read-only.

---

## 5. Keep — untouched (no thesis credibly challenged these)

1. **CD-8 / Phase-0 as an absolute hard GO/NO-GO stop** before any production code
   (`WP-F1` deps `WP-S7`) — endorsed even by the kill-the-program thesis.
2. **All CD-7 security invariants** — loopback-or-fail, mandatory timing-safe
   `DASHBOARD_TOKEN`, no-spawner static gate, no-SSRF, same-origin.
3. **CD-9 licensing + the WP-F6 provenance/license CI gate** — three theses tried to drop it;
   every constraint-guardian flagged that as the LB2 trap: **infringement and missing
   attribution are baked at commit time and cannot be retrofitted "the day you sell."**
4. **CD-2 / CD-3 / CD-4 immutable substrate + deterministic projection + versioned dated
   pricing + `instance`/`host_id` on every row** — the persisted-edges data-fact _is_ the
   moat.
5. **The three P0 reconciliation tests** — `Σ(token_usage)==JSONL` exact · double-replay
   byte-identical · **DAG-rebuilds-from-JSONL-after-outage** — as the real release gate.
6. **The >90% merge-blocking coverage bar** — Gap #8 _prescribes_ it; resolve only its open
   **scope** question honestly (don't exempt the shipped UI), don't drop it.
7. **CD-9's existing "copy simple10 with attribution, emulate its ports" instruction** — the
   plan already is "greenfield spine + attributed grafts."

## 6. Change — concrete edits to the plan

1. **Pull the entire Alerts track off the release critical path.** `development-plan.md`
   line 149's schedule-limiting chain terminates at `WP-A10` (a non-moat convenience) while
   the moat's P0 proof lands at wave 16. **Redefine v1.0 = daily-driver DAG+cost cockpit
   answering the five daily questions, _no alerts_.** Ship alerts post-1.0 (A1–A7 core).
2. **Cut the alerts operator CRUD UI (`WP-A8`/`WP-A9`)** — near-zero value for a single
   operator. **Keep `WP-A10`** — it is the SSRF/secret-leak negative corpus, not CRUD.
3. **Delete the vector-DB track (`WP-X11`) entirely**; **drop the dual SQLite driver** (one
   `better-sqlite3`, pinned Node 22); **defer the animated room.**
4. **Do _not_ demote `WP-IN11` (durable outbox)** and do not adopt the nuke-and-rebuild-cache
   framing. The active layout drift + depth-2 gap make the outbox/backfill load-bearing.
5. **Add to Track S / the reconstructor spec:** multi-layout parsing (flat + nested), a
   per-layout golden regression fixture, depth-2 recovery via `meta.json`/`toolUseId`, and
   Claude Code version detection.
6. **Right-size Track S:** drop `WP-S1`'s install-and-revert throwaway-hook block from the
   _gating_ path (linkage needs no hooks); demote `WP-S4`/`SubagentStart` enumeration to a
   liveness-only question. Keep the pathology corpus and hand-labeled trees.
7. **Make explicit a server/web-import-free `packages/core`** (events_raw + Normalizer +
   Projection + edge derivation) so the moat IP is independently testable and later
   extractable.
8. **Do not build** multi-user / RBAC / tenancy / hosted infra (the enterprise-cosplay trap).
   Freeze a "a second consumer/host physically exists" rule before any such code.
9. **Treat the tokenless public demo as post-1.0 and _not_ free** — it needs purpose-built
   **synthetic** fixtures (WP-X1/X2 are _redacted real_ sessions) and must never introduce an
   unauth build mode.

## 7. Do this now (this week)

1. **Run the full-corpus read-only Phase-0 probe** against `~/.claude/projects` — both
   layouts, the four pathologies, a `Σ(token_usage)==JSONL` reconciliation. Write the CD-1
   verdict as an evidence-backed `CONDITIONAL-GO` with the depth-2 and drift findings
   explicit. **No production code before this lands.** _(This memo's companion "new analysis"
   — see [`phase0-probe.md`](phase0-probe.md).)_
2. **Start a parallel 2-week baseline-friction log** — run the free
   `claude-code-templates --analytics` as the daily driver and record concrete moments the
   flat leaderboard fails your subagent-heavy workflow. Zero cost; decides whether the moat is
   a felt need or a cool engineering problem.
3. **Amend the plan docs** (before any build) with the §6 changes.

> **Two of three, six weeks later (note added 2026-08-15).** Action 1 ran within a day and
> produced [`phase0-probe.md`](phase0-probe.md); action 3 was applied and is recorded in
> [`development-plan.md`](development-plan.md) §2b. **Action 2 has never been started.** No
> friction log exists anywhere in the repository, and no rival dashboard has been installed
> and lived with. That is not an oversight that time has healed — it is the one item on this
> list that could not be delegated to an agent, and it is the only one that would have
> produced evidence about demand rather than feasibility. The build proceeded without it,
> by owner override of CD-8 on 2026-07-11. Everything the program has learned since is
> about whether the thing can be built, which was already the question this memo was least
> worried about.

## 8. Risk register

| # | Risk | Mitigation |
|---|---|---|
| 1 | **Undocumented Claude Code churn silently breaks the reconstructor** — flat vs nested layouts already coexist; a patch bump changed the shape. | Parse both layouts; per-layout golden regression fixtures in CI; detect/record the CC version; keep the hooks-liveness + durable-outbox hedge; the 3 P0 tests catch drift every run. |
| 2 | **Over-simplifying on a `CONDITIONAL-GO`** — single-source/no-outbox would make the "survives an outage" promise false; depth-2 edges unrecoverable by the naive join. | Keep CD-2/CD-3 + `WP-IN11`; collapse only cross-source precedence; build depth-2 recovery via `meta.json`/`toolUseId`; gate on the DAG-rebuild-after-outage test. |
| 3 | **Solo spare-time burnout / scope creep (Gap #9)** — a 75-WP program with the P0 proof at wave 16 is program-sized for one owner. | Alerts off the critical path; delete vector-DB/room/dual-driver; v1.0 = cockpit only; the 3 P0 tests (not a coverage number) are the psychological finish line. |
| 4 | **Felt need ~80% met by the free baseline** — months of build may not clear opportunity cost vs `kiko`/`servicenow-mcp` (real external audiences). | The 2-week baseline log runs in parallel at zero cost; if it can't fill a page **and** the probe is messy, ship standalone cost+Telegram scripts instead of the program. |
| 5 | **Licensing contamination** — clean-room ideas copied while reading all-rights-reserved source, baking infringement into git history. | Keep `WP-F6` from commit one; never open cast/disler/nirdiamant source while authoring; copy only simple10/hoangsonww with attribution. |
| 6 | **Cost pillar is a commodity** (ccusage 16.8k★ owns token/cost); the pricing table is churn-prone toil. | Ship cost as table-stakes; tie delegation-savings to the named routing decision (`WP-C5`) so it isn't vanity; keep the resolver dated/small; don't over-invest — the singular differentiator is the persistent cross-session DAG. |

## 9. Honest dissent (hold this even if you proceed)

The kill-the-program thesis, stripped of its errors (it misread `CONDITIONAL-GO` as death, and
its "weekend simple10 fork" is the _least_ feasible option in the record — simple10 ships
`0.0.0.0` + zero auth), has a **surviving core I cannot fully refute**: your only user is you,
observing your own runs; the everyday value (token/cost attribution) is already **free and
maintained**; the singular true differentiator — the persistent cross-session DAG — rests on
an **undocumented Anthropic internal that provably churns under you**; and the same hours could
compound on `kiko`/`servicenow-mcp`, which have external audiences and career leverage.

**If the 2-week log cannot fill a page of genuine recurring pain _and_ the Phase-0 probe comes
back messy → the wisest move is genuinely to _not_ build the program** — ship standalone
cost + Telegram hook scripts against `~/.claude` and redirect the hours.

**But** if the real objective is the **craft / portfolio value** of building a
security-hardened ports-and-adapters system end to end — that is a legitimate reason, only say
so, because it changes what "best" means and makes the opportunity-cost argument a _category
error_ rather than a refutation.

> **The dissent is intact (note added 2026-08-15).** Nothing built since has touched it.
> The user count is still one, the cost pillar is still free elsewhere, and the DAG still
> rests on undocumented internals. The conditional kill test in the paragraph above can no
> longer fire on its own terms — the probe came back clean, and the test is an AND — so what
> remains is not a test but a judgement, and it is Ivan's. The one thing the six weeks did
> settle is the final paragraph: the program has in fact been built as a security-hardened
> ports-and-adapters system end to end, which is exactly the craft objective this section
> said would change the meaning of "best" if it were ever stated out loud. It still has not
> been stated. Until it is, the honest reading is that the project proceeded without
> resolving which of the two reasons it was proceeding for.

---

## Appendix — the six theses and how they survived

Method: each thesis was argued as strongly as the evidence allowed, then attacked by three
diverse critics. **Every thesis came back `weakened`** (none `fatal`, none `survives`
untouched) — i.e. each held a real insight but over-reached. The synthesis grafts the
surviving core of each and discards the over-reach.

| Thesis | Conf. | Surviving core (kept) | Over-reach (rejected) |
|---|---|---|---|
| **1. Moat-first, JSONL-first, ultra-thin** | 72 | Cut alerts/SSE/room off the critical path; v1.0 = DAG+cost. | "SQLite as nuke-and-rebuild cache / no outbox / no reconciliation" — false on a `CONDITIONAL-GO`; also over-claims cost as a co-equal moat pillar. |
| **2. De-risk / kill-early** | 73 | Run a cheap read-only probe **this week**; right-size the 7-WP spike. | "Clean GO, demote outbox to YAGNI" — an over-read from a 3-dir sample; the full-corpus join is not universally clean (depth-2, drift). |
| **3. Solo minimalism** | 72 | Delete vector-DB/dual-driver/room; keep security + Phase-0; a solo owner must shed scope. | Deletes CD-3 backfill (it survives single-source) and the events_raw substrate (needed for the outage-proof); cuts the cheap backend end, not the expensive tail. |
| **4. Buy/adopt (fork simple10)** | 58 | Copy simple10's MIT tree/physics with attribution; measure graft cost if ambiguous. | Fork wholesale — its render-time edge model is the _opposite_ of persisted edges; foreign-code + retro-audit + retrofitting the gate is harder. |
| **5. Commercial-optionality** | 57 | Optionality is already bought cheaply (license gate, ports, portable substrate); stop at personal-first. | Polices multi-user/RBAC nobody proposed; overstates that `WP-F6` (dependency-license scan) enforces the clean-room _copying_ rule (it doesn't — that's discipline). |
| **6. Don't build now (devil)** | 57 | Opportunity cost is real; run the free baseline as a 2-week falsifier before the heavy build. | "Ship a weekend loopback-hardened simple10 fork" — least feasible option in the record; misreads `CONDITIONAL-GO` as a stop signal. |

---
_Produced by the `best-path-decision` adversarial workflow (6 theses × 3 critics + 1 judge,
25 agents, ~1.4M tokens, Opus / high effort); the two load-bearing empirical claims re-verified
by hand against `~/.claude/projects/`. Refines [`concept-analysis-v2.md`](concept-analysis-v2.md)
CD-1…CD-10 and re-sequences [`development-plan.md`](development-plan.md). Companion empirical
analysis: [`phase0-probe.md`](phase0-probe.md). Open work: [`../../TODO.md`](../../TODO.md)._
