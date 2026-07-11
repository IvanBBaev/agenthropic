# Development Plan & Roadmap

**The build.** This decomposes the ten canonical decisions **CD-1 … CD-10** from
[`concept-analysis-v2.md`](concept-analysis-v2.md) into **75 agent-distributable work
packages** _(72 remain live after the best-path §6 amendments — `WP-A8`/`WP-A9` cut,
`WP-X11` deleted; see §2b)_ across eight tracks (76 from the decomposition + the added
`WP-U0`, less the two ids merged away — `WP-D9`, `WP-IN4`), arranged into a verified
dependency DAG (**17
topological waves**, acyclic), a **critical path**, and a **phase-by-phase roadmap with exit
gates**.

It exists so the work can be handed to **different agents in parallel**: each work package
(WP) is a self-contained unit one agent can own end-to-end — a single owner-agent type,
explicit inputs, concrete deliverables, hard dependencies, a testable Definition of Done,
and the CD decision(s) it implements.

> **Provenance.** Drafted by an 8-track decomposition workflow (one owner per track, Opus /
> high effort) and then **adversarially verified** by a ninth agent that reconciled
> cross-track dependencies, proved the graph acyclic, computed the parallel waves and
> critical path, checked that every CD-1…CD-10 is covered, and produced twelve corrections.
> **Those corrections are applied in this document** — the WP ids and dependencies below are
> the canonical, post-verification set, not the raw drafts. Status legend and open items
> live in [`../../TODO.md`](../../TODO.md); completed milestones in
> [`../../DONE.md`](../../DONE.md).

---

## 1. How to use this plan

### The distribution model
- **One WP → one agent → one PR.** A WP is sized S/M/L for a single agent's working session.
- **Owner-agent types** (assign the WP to an agent specialised for it): `ingest`, `data`,
  `backend`, `cost`, `frontend`, `devops`, `security`, `qa`, `docs`.
- **Dependencies are hard.** An agent may only start a WP once every id in its `deps` is
  merged. The **waves** in §4 are the schedule: every WP in wave _N_ can run concurrently
  once wave _N-1_ is complete.
- **The GO/NO-GO gate is absolute.** Wave 4 is `WP-S7` — the Phase-0 verdict. **No production
  code (not even the monorepo scaffold) starts until `WP-S7` reads GO** (CD-8). This is
  encoded as a real dependency: `WP-F1` depends on `WP-S7`.

### WP id scheme
`WP-<TRACK><n>` — tracks: **S** Phase-0 Spike · **F** Foundation/CI · **D** Data · **IN**
Ingest/Normalizer · **C** Cost · **U** Realtime+UI · **A** Alerts · **X** Delivery/Docs/QA.

### Reading order for an implementing agent
1. Read [`concept-analysis-v2.md`](concept-analysis-v2.md) §3 (the CD decisions) and §6
   (acceptance criteria).
2. Read [`../ai/DESIGN.md`](../ai/DESIGN.md) for the data model and hook set.
3. Read [`../../CLAUDE.md`](../../CLAUDE.md) — the non-negotiable security constraints apply
   to **every** WP.
4. Find your WP in §6, honour its deps, satisfy its Done-when.

---

## 2. Verifier corrections applied (canonical reconciliation)

The raw track drafts referenced ~20 placeholder cross-track ids and carried five duplicate
pairs. The verification pass reconciled them; the following are **applied** below so the ids
are canonical.

**One WP was added** — the drafts referenced a Fastify server bootstrap under four aliases
(`WP-SE1` / `WP-B2` / `WP-BE4` / a UI-track `WP-S1`) but no track defined it. Without it the
runtime half of CD-7 (loopback-or-fail bind + fail-startup-on-unset-token) is unimplemented
and `WP-F7`'s deliberately-red security contract tests can never go green:

- **`WP-U0` — Fastify server bootstrap** _(new, owner `backend`, Phase 1)_: loopback-or-fail
  bind · timing-safe `DASHBOARD_TOKEN` middleware · same-origin helper · TypeBox plugin
  registration · config loader. **deps:** `WP-F1, WP-F7, WP-D2`. **Gates:** `WP-IN3, WP-U1,
  WP-U2, WP-C7`, ~~`WP-A8`~~ _(cut per best-path §6.2, applied 2026-07-06)_. **Done-when:** `WP-F7`'s security contract tests turn **green**
  through this wiring (127.0.0.1-or-fail; fails startup when token unset; SSE cross-origin
  rejected).

**Placeholder → canonical id** (rewired in the deps below):

| Placeholder | Canonical | Placeholder | Canonical |
|---|---|---|---|
| `WP-O1`, `WP-DV1`, `WP-P5` | `WP-F1` (scaffold) | `WP-P1` | `WP-S2` |
| `WP-B1`, `WP-SH1` | `WP-D1` / `WP-F1` (shared) | `WP-P2` | `WP-S4` |
| `WP-DA1` | `WP-D4` (events_raw) | `WP-P4` | `WP-S7` |
| `WP-DA2` | `WP-D2`/`WP-D3` (storage) | `WP-QA1`, `WP-Q1` | `WP-X1` |
| `WP-SE1`, `WP-B2`, `WP-BE4`, UI-`WP-S1` | **`WP-U0`** (new) | `WP-CI1` | `WP-X5` |
| `WP-I3` | `WP-IN8`+`WP-IN12` | `WP-CO3` | `WP-C3` |
| `WP-FE3` | `WP-U5` | `WP-IN-precompact` | `WP-IN7` |

**Five duplicate pairs merged** (so two agents never write the same file):

1. **Pricing** — `WP-D9` (dropped, shown `WP-D9m`) folds into the cost track: `WP-C1` owns
   the `model_pricing` table + dated seed; the priceless-model guard lives in `WP-C6`.
2. **`events_raw` append** — `WP-D4` owns the table, triggers and append/getRaw repository;
   `WP-IN2` keeps only the `EventStore` **port** + monotonic-seq/`readSince` and consumes
   `WP-D4` (added to its deps).
3. **Redaction/retention** — `WP-D10` owns the storage-lifecycle redactor + TTL sweeper;
   `WP-IN14` reduces to invoking that redactor at the ingest write boundary.
4. **Hooks installer** — `WP-IN4` merges into `WP-X8` (one devops WP: `hooks/` scripts +
   install docs + leak-free token acquisition + end-to-end smoke).
5. **Storage substrate** — `WP-D2` owns WAL/pragmas/transactions; `WP-D3` owns the migration
   runner; `WP-F8` reduces to the **backup + tested-restore** routine only.

**Hard-stop fix** — `WP-F1` gains `deps: [WP-S7]` (CD-8: nothing scaffolds before GO).

**Phase-label fix** — trust the computed **waves** (§4) over any authored phase field:
`WP-U3/U6/U7` and `WP-X3/X4` genuinely land in Phase 3+ (they need the projection/watchdog),
not Phase 1 as some drafts tagged them.

### 2b. Best-path §6 amendments applied (2026-07-06)

**Best-path §6 amendments applied 2026-07-06 (AMEND-1…6 per
[`corpus-audit-2026-07-06.md`](corpus-audit-2026-07-06.md) §4.1).** The ruling memo
[`best-path-decision.md`](best-path-decision.md) §6 (decided 2026-07-04) sits above this
plan; its edits are now materialized in this document:

- **AMEND-1** (§6.1) — v1.0 = daily-driver DAG + cost cockpit answering the five daily
  questions, **no alerts**; Phases 5–6 and the alert-track WPs are post-1.0; the release
  critical path ends at the moat P0 proof (see §3, §4).
- **AMEND-2** (§6.2) — `WP-A8`/`WP-A9` (operator alerts CRUD API/UI) **CUT**; `WP-A10`
  kept (it is the SSRF/secret-leak negative corpus, not CRUD).
- **AMEND-3** (§6.3) — `WP-X11` (vector-DB EXPERIMENTAL stub) **DELETED** entirely.
- **AMEND-4** (§6.3) — single SQLite driver: **better-sqlite3 only, Node 22 pinned**
  (`WP-D2`; no dual-driver anywhere).
- **AMEND-5** (§6.6) — `WP-S1` slimmed (install-and-revert throwaway-hook block dropped
  from the gating path; pathology corpus + Ivan-labeled trees kept); `WP-S4` demoted to a
  liveness-only question.
- **AMEND-6** (§6.7) — `packages/core` (server/web-import-free) added to the `WP-F1`
  scaffold, with the canonical monorepo layout stated there.

Coverage wording is normalized throughout to **>90%** (the delivery bar is strictly above
90; the merge gate blocks at 90.0% or below). Cut/deleted WP rows are kept, struck
through, so WP numbering stays stable.

---

## 3. Roadmap — phases & exit gates

The app is bound to `127.0.0.1` throughout; the docs site is the only public surface.

| Phase | Goal | WPs | Exit gate |
|---|---|---|---|
| **0 — Feasibility spike** _(throwaway, hard stop)_ | Empirically **confirm CD-1** ingest primacy — **pre-answered `CONDITIONAL-GO` (conf 85)** by the 2026-07-04 desktop probe ([`phase0-probe.md`](phase0-probe.md)), which the formal spike re-confirms on the paired-capture corpus; verify the hook catalog _(liveness-only, non-gating per best-path §6.6, applied 2026-07-06)_, the token→agent join key, token reconciliation and human tree correctness **before any production code**. | `WP-S1…S7`, `WP-X10` | `WP-S7` reads **GO** (or CONDITIONAL-GO — the verdict the desktop probe already returned, conf 85: JSONL-primary with the four parser gates, the durable outbox deferred); CD-1 verdict recorded with evidence; hook catalog _(liveness-only per §6.6)_ + join key + Σtokens==JSONL + tree sign-off captured. **On NO-GO the moat feasibility is reconsidered before build.** |
| **1 — Foundation, security spine, storage, ports** _(security + coverage LIVE)_ | Monorepo; CI with a **merge-blocking >90% coverage gate**; build-failing security/license gates; SQLite/WAL substrate with tested restore; shared ports; the server bootstrap that makes loopback+token+SSE-origin real; golden fixture corpus. | `WP-F1…F8`, `WP-D1…D10`, `WP-U0`, `WP-X1,X2,X5,X6,X7,X10`, ~~`X11`~~ _(deleted per best-path §6.3, applied 2026-07-06)_, `WP-A1` _(post-1.0 per §6.1)_ | typecheck+lint+coverage(>90%) **green & blocking**; no-spawner/no-SSRF/license gates green; `WP-F7` security contract tests **green** via `WP-U0`; `events_raw` provably append-only; WAL on + backup **restore exercised**; badges green; Pages builds. |
| **2 — Ingest substrate** | Both sources into `events_raw` (idempotent, redacted): the envelope+idempotency key, append-only EventStore, authed loopback hook receiver, JSONL tail-follow with durable offsets, hooks installer. | `WP-IN1,IN2,IN3,IN4→X8,IN5,IN11,IN14`, `WP-C1,C2` | A hook event and a JSONL line for the same fact **collapse to one** `events_raw` row; kill+restart resumes JSONL at the persisted offset with **zero loss/dup**; an unknown event_type is stored, not crashed; redaction live; pricing table seeded. |
| **3 — Projection, the DAG moat, reconciliation, cost** _(P0 blockers)_ | Pure normalizer + projection; dual-path `orchestration_edges`; reconciliation + backfill; replay-on-startup; watchdog "unknown"; CostEngine with compaction repricing + delegation-savings. | `WP-IN6…IN10,IN12,IN13`, `WP-C3,C4,C5,C6,C7`, `WP-X3,X4` | **Three P0 tests green & merge-blocking** (Σ`token_usage`==JSONL exact; double-replay byte-identical DB; **DAG rebuild from JSONL alone** after a simulated outage); hierarchy **≥95%** vs the labeled corpus even without `SubagentStart`; missing-Stop→unknown; PreCompact reprices vs baseline; no priceless model; 12-scenario negative catalogue green. |
| **4 — Read API + SPA + the five daily questions** | Auth-gated read endpoints and the React/Vite views (status board, session tree, global DAG, cost/Sankey) over resilient SSE. | `WP-U1…U9` | All **5 daily questions** answerable; **time-to-understand a session < 30s**; tree and global DAG proven **served by a query over `orchestration_edges`** (not render-time reconstruction); every displayed dollar traces to ground-truth tokens × dated price; web package counts toward the >90% gate. **Phase 4 completes v1.0 together with the Phase-3 P0 proof (best-path §6.1, applied 2026-07-06).** |
| **5 — Alerting core** _(**post-1.0** per best-path §6.1, applied 2026-07-06 — v1.0 = DAG + cost cockpit answering the five daily questions, no alerts)_ | Alert schema, secret `token_ref`, no-SSRF webhook dispatcher, rules engine (cost/stuck/error), Telegram sink, throttled delivery loop. | `WP-A2…A7` | A real error/stuck condition yields **exactly one** throttled notification; SSRF test proves no payload-URL dial-out; the secret is never in SQLite/SSE/logs (0600 or launchd env only); delivery attempts recorded with retry/backoff. |
| **6 — Operator alerts API/UI + release hardening** _(**post-1.0** per best-path §6.1, applied 2026-07-06)_ | ~~Auth-gated CRUD for rules/targets; alerts UI (token_ref name only, never the secret);~~ _(WP-A8/WP-A9 cut per best-path §6.2, applied 2026-07-06)_ alerts negative corpus; release checklist + per-role DoD. | ~~`WP-A8,A9`~~ _(cut per §6.2)_, `WP-A10`, `WP-X9` | ~~Operator can manage rules/targets;~~ _(cut per §6.2)_ **no endpoint or view exposes a token**; alerts modules >90% covered; `RELEASE.md` enumerates every CD-7 build-failing gate + CD-9 provenance check + an exercised backup restore. |
| **Experimental** _(**DELETED** per best-path §6.3, applied 2026-07-06 — the vector-DB track is removed entirely; row kept for audit trail)_ | ~~Keep the vector-DB "observability-becomes-memory" feed a labeled, non-blocking stub with `ANTHROPIC_API_KEY` isolated out of the dashboard env.~~ | ~~`WP-X11`~~ _(deleted per §6.3)_ | ~~Stub labeled **EXPERIMENTAL**; no core package imports it (asserted); coverage scope excludes it.~~ |

---

## 4. Parallel waves (the distribution schedule)

Acyclic; each wave runs concurrently once the previous completes. `WP-U0*` = the added
bootstrap; `WP-D9m` = the merged/dropped pricing table.

| Wave | Theme | WPs (hand to N agents in parallel) |
|---|---|---|
| 1 | Phase-0 corpus kickoff (the only dep-free work under CD-8) | `WP-S1`, `WP-X10` |
| 2 | Phase-0 probes off the corpus | `WP-S2`, `WP-S3`, `WP-S4` |
| 3 | Human tree smoke gate + token-reconciliation probe | `WP-S5`, `WP-S6` |
| 4 | **GO/NO-GO — decides CD-1, hard stop** | `WP-S7` |
| 5 | Monorepo scaffold (gated on GO) | `WP-F1` |
| 6 | Toolchain, coverage config, shared ports, corpus promotion, Pages, ~~experimental stub,~~ alert port | `WP-F2`, `WP-F3`, `WP-D1`, `WP-X1`, `WP-X5`, `WP-X7`, ~~`WP-X11`~~ _(deleted per best-path §6.3, applied 2026-07-06)_, `WP-A1` |
| 7 | CI spine, storage/WAL, driver, labeled fixtures, badges, secret resolver | `WP-F4`, `WP-F8`, `WP-D2`, `WP-X2`, `WP-X6`, `WP-A3` |
| 8 | Security static gates + primitives+RED contract tests, migration runner | `WP-F5`, `WP-F6`, `WP-F7`, `WP-D3` |
| 9 | **Server bootstrap (F7 RED→green)**, pricing+seed, events_raw, sessions/agents, alert schema | `WP-U0*`, `WP-C1`, `WP-D4`, `WP-D6`, `WP-A2` |
| 10 | Envelope+idempotency, events/edges/token_usage tables, RealtimeHub+ReadAPI, PricingProvider, webhook dispatcher | `WP-IN1`, `WP-D5`, `WP-D7`, `WP-D8`, `WP-U1`, `WP-U2`, `WP-C2`, `WP-A4` |
| 11 | EventStore append, pure Normalizer, SPA shell, CostEngine, pricing guard, redaction, Telegram sink | `WP-IN2`, `WP-IN6`, `WP-U5`, `WP-C3`, `WP-D9m`, `WP-D10`, `WP-A6`, `WP-C6` |
| 12 | HookSource receiver, JSONL tail-follow, projection, cost/DAG read endpoints, delegation-savings | `WP-IN3`, `WP-IN5`, `WP-IN7`, `WP-U4`, `WP-C5` |
| 13 | Hook installer, **dual-path edge derivation (moat)**, deferrable outbox, watchdog, compaction repricing, cost API, DAG+cost views | `WP-IN4→X8`, `WP-IN8`, `WP-IN11`, `WP-IN12`, `WP-C4`, `WP-C7`, `WP-U8`, `WP-U9` |
| 14 | Reconciliation/backfill, session/tree endpoints, alert rules engine, negative catalogue | `WP-IN9`, `WP-U3`, `WP-A5`, `WP-X4` |
| 15 | Replay-on-startup, status+tree views, delivery log/retry/dedupe | `WP-IN10`, `WP-U6`, `WP-U7`, `WP-A7` |
| 16 | **P0 reconciliation suite**, three release-blocker tests _(**v1.0 release endpoint** — the moat P0 proof, per best-path §6.1, applied 2026-07-06)_, ~~operator alerts API+UI~~ _(cut per §6.2)_ | `WP-IN13`, `WP-X3`, ~~`WP-A8`, `WP-A9`~~ _(cut per §6.2)_ |
| 17 | Alerts negative/coverage hardening _(post-1.0 per §6.1)_ + release checklist & per-role DoD | `WP-A10` _(post-1.0)_, `WP-X9` |

> **Post-1.0 marking (best-path §6.1, applied 2026-07-06):** the alert-track WPs shown in
> the waves above (`WP-A1…A7`, `WP-A10`; `WP-A8`/`WP-A9` cut per §6.2) are **post-1.0** —
> they are kept in their waves for dependency bookkeeping, not renumbered, but they do not
> gate the v1.0 release.

**Critical path (schedule-limiting chain):**
`WP-S1 → WP-S2 → WP-S5 → WP-S7 → WP-F1 → WP-D1 → WP-D2 → WP-D3 → WP-D4 → WP-IN1 → WP-IN6 →
WP-IN7` ~~`→ WP-IN12 → WP-A5 → WP-A8 → WP-A9 → WP-A10`~~ `→ WP-IN8 → WP-IN9 → WP-IN10 →
WP-IN13/WP-X3`.

> _(Amended per best-path §6.1, applied 2026-07-06.)_ The **release critical path no longer
> terminates at `WP-A10`** — the alerts tail is post-1.0 (`WP-A8`/`WP-A9` cut per §6.2). The
> v1.0 release critical path now ends at the **moat P0 proof**: the sub-chain
> `…D4 → IN1 → IN6 → IN7 → IN8 → IN9 → IN10`, landing the three P0 reconciliation tests
> (`WP-IN13`/`WP-X3`) at wave 16 — protect *that* on schedule.
> ~~The absolute-longest tail is the alerts track, which is Phase 5-6 by design. The alerts
> owner should start `WP-A1/A2/A3` early (they need only `WP-F1/D3`).~~ _(obsolete — alerts
> no longer block release; post-1.0 per §6.1)_

---

## 5. Work-package catalog

Deps shown are the **canonical** (post-reconciliation) ids. Done-when is the headline
acceptance criterion; full criteria per WP follow the CD acceptance set in
[`concept-analysis-v2.md`](concept-analysis-v2.md) §6.

### Track S — Phase-0 feasibility spike _(throwaway; hard GO/NO-GO stop, CD-8)_

| ID | Owner | Sz | Deps | Title & Done-when |
|---|---|---|---|---|
| WP-S1 | ingest | M | — | **Paired-capture harness + hand-labeled corpus** _(slimmed per best-path §6.6, applied 2026-07-06)_. ≥3 real sessions incl. crashed-no-Stop, deep nesting, mid-session PreCompact, two concurrent instances; each captured as ~~paired JSONL + hook log~~ JSONL; Ivan-labeled expected tree per session; ~~throwaway hook block reverted after capture~~ _(install-and-revert throwaway-hook block **dropped from the gating path** — linkage needs no hooks; pathology corpus + Ivan-in-the-loop labeling kept)_. |
| WP-S2 | ingest | L | S1 | **G0.1 ingest-primacy probe.** Reconstruct the subagent tree from **JSONL alone** (no hook input) and diff vs hook-derived + labeled trees → emits the CD-1 verdict rule (JSONL-alone edge accuracy ≥95% survives outage → JSONL-primary; else hooks-primary+outbox; else NO-GO). |
| WP-S3 | data | M | S1 | **G0.1b join-key probe.** State & demonstrate the exact field path from a JSONL token row to an `agent_id`; report % resolvable by a hard key vs heuristic → decides whether CD-3 backfill is a hard join or a confidence-scored inference. |
| WP-S4 | ingest | M | S1 | **G0.2 hook-catalog enumeration** _(demoted to a **liveness-only** question per best-path §6.6, applied 2026-07-06 — "does `SubagentStart` fire" is nice-to-know, **not gating**)_. Confirm/deny which hooks actually fire (esp. `SubagentStart`, PreCompact markers) from ≥1 subagent-heavy + 1 compaction session. |
| WP-S5 | qa | S | S1, S2 | **G0.3 tree smoke gate.** Render the reconstructed nesting legibly for the subagent-heavy session; Ivan signs off correctness. |
| WP-S6 | cost | M | S1, S3 | **G0.4 token-reconciliation probe.** Σ per-record token usage == the session's JSONL ground-truth total **exactly** (zero drift) for every corpus session; capture the PreCompact baseline. |
| WP-S7 | docs | S | S2, S3, S4 _(liveness-only, non-gating per §6.6)_, S5, S6 | **GO/NO-GO report.** Single GO / CONDITIONAL-GO / NO-GO verdict with the CD-1 rule applied and the driving evidence. **Gates all of Phase 1.** |

### Track F — Foundation / CI spine _(Phase 1)_

| ID | Owner | Sz | Deps | Title & Done-when |
|---|---|---|---|---|
| WP-F1 | devops | M | **S7** | **pnpm monorepo scaffold + TS project refs.** Canonical layout _(best-path §6.7, applied 2026-07-06)_: `apps/server` · `apps/web` · `packages/shared` · `packages/core` · `packages/test-fixtures` · `hooks/` — pnpm workspaces, Node 22. `packages/core` is **server/web-import-free** (events_raw + Normalizer + Projection + edge derivation) so the moat IP is independently testable and later extractable. Clean install on Node 22 with a committed lockfile. |
| WP-F2 | devops | S | F1 | **Lint + format** (ESLint flat + Prettier + editorconfig). `pnpm run lint` passes with zero errors. |
| WP-F3 | qa | M | F1 | **Vitest coverage harness + >90% gate config** (scope defined). Produces lcov + json-summary. |
| WP-F4 | devops | M | F2, F3 | **CI pipeline skeleton** (GitHub Actions) with the coverage gate **blocking merges**. |
| WP-F5 | security | M | F4 | **Static no-spawner + no-SSRF gate.** Planting a `child_process` import in `apps/server` makes CI red. |
| WP-F6 | security | M | F4 | **License/provenance scan (CD-9).** A non-allowlisted dependency license makes CI red. |
| WP-F7 | security | L | F1, F3, F4 | **Security-invariant contract tests + `shared/security` primitives** (loopback, token, SSE origin) as failing gates until `WP-U0` wires them. Primitives >90% unit-covered. |
| WP-F8 | data | L | F1, F3 | **Backup + tested-restore** (reduced per merge #5). WAL asserted; a restore is exercised. |

### Track D — Data foundation _(Phase 1)_

| ID | Owner | Sz | Deps | Title & Done-when |
|---|---|---|---|---|
| WP-D1 | data | M | F1 | **Storage port contracts + shared row types + in-memory fake.** Ports compile with no DB imports; consumable across server/web/cost. |
| WP-D2 | data | M | D1 | **SQLite driver adapter + WAL connection** (~~dual-driver~~ **single driver — better-sqlite3 only, Node 22 pinned** _(best-path §6.3, applied 2026-07-06)_). On open, `journal_mode==wal` & `foreign_keys==ON` asserted. |
| WP-D3 | data | M | D2 | **Idempotent ordered migration runner + `schema_version`.** Running twice yields identical schema, no error. |
| WP-D4 | data | L | D3 | **`events_raw` immutable substrate + append-only enforcement + `EventStore.append`.** UPDATE/DELETE raises and leaves the row unchanged (test-proven). |
| WP-D5 | data | M | D4 | **`events` normalized/queryable table.** `events.raw_event_id` FK enforced. |
| WP-D6 | data | M | D3 | **`sessions` + `agents` projection tables** (self-ref hierarchy). `parent_agent_id` self-FK; orphan-safe. |
| WP-D7 | data | M | D6, D4 | **`orchestration_edges` persisted table** (the moat artifact). Duplicate logical edge → exactly one row (UNIQUE + INSERT OR IGNORE). Non-null `instance`/`host_id`. |
| WP-D8 | data | L | D6, D4 | **`token_usage` table** (fine-grained buckets, compaction baseline, **nullable `agent_id`**). Backfill deterministic, no double-count/misattribution. |
| WP-D9m | data | — | — | **Merged into `WP-C1`** (pricing owned by the cost track). |
| WP-D10 | data | M | D4, D5 | **Retention TTL sweeper + payload redaction at ingest.** Redaction deterministic; redacted re-ingest byte-identical + idempotent. |

### Track IN — Ingest + Normalizer + Reconciliation _(Phase 2-3, the core)_

| ID | Owner | Sz | Deps | Title & Done-when |
|---|---|---|---|---|
| WP-IN1 | backend | S | D1, S1, S2, D4 | **Raw event envelope + cross-source idempotency-key contract.** A hook payload and the JSONL line for the same fact produce **byte-identical** idempotency keys. |
| WP-IN2 | ingest | M | IN1, D4, D2 | **`EventStore` port + append-only idempotent upsert** (consumes `WP-D4`). Appending the same envelope twice → exactly one row. |
| WP-IN3 | ingest | M | IN1, IN2, **U0**, S2 | **HookSource adapter** — authed loopback POST receiver, **accept-any-event**. Never-seen `event_type` → 202 + a row lands (audit-preserving). |
| WP-IN4 | devops | — | — | **Merged into `WP-X8`** (hooks installer). |
| WP-IN5 | ingest | L | IN1, IN2, S1, S4 | **TokenReader/TokenSource** — JSONL tail-follow with durable offsets. One envelope per line, tokens copied **verbatim** (no inference). |
| WP-IN6 | backend | M | IN1, D4, S2 | **Pure Normalizer** — `events_raw` → normalized `events`. Identical input → identical output (deterministic). |
| WP-IN7 | backend | L | IN6 | **Projection** — `events` → sessions/agents/`token_usage` (precedence-aware). Σ `token_usage` per session == JSONL exact. |
| WP-IN8 | backend | L | IN7, S1, S2, S3 | **Dual-path edge derivation → persisted `orchestration_edges`** (moat core). Correct parent→child tree via the JSONL Agent/Workflow spawn chain **even if `SubagentStart` never fires** (the spawn tool is `Agent`/`Workflow`, **not** `Task` — [`phase0-probe.md`](phase0-probe.md) §4a). |
| WP-IN9 | backend | M | IN7, IN8 | **Reconciliation precedence + deterministic `token_usage.agent_id` backfill.** After backfill every row attributed to exactly one agent; session-sum invariant holds. |
| WP-IN10 | backend | M | IN2, IN6, IN7, IN8, IN9 | **Replay-on-startup + deterministic full projection rebuild.** Double-replay → **byte-identical** `events_raw` and projected DB. |
| WP-IN11 | ingest | M | S5, IN2, IN3 | **Durable outbox/spool** (CONTINGENT — hooks-primary fallback only; **deferrable, pulled off the v1 critical path** — JSONL self-reconciles by backfill and historical crashes are ≈0, so add it only on a real trigger: a sub-second-liveness requirement or a hooks-only data source; [`phase0-probe.md`](phase0-probe.md) §4c/§5). Events buffered while the DB is down, flushed at-least-once on recovery. |
| WP-IN12 | backend | M | IN7, S5 | **Missing-Stop watchdog + unknown-state rule.** A missing `SubagentStop` → **"unknown"** within the window, never a permanent "working". |
| WP-IN13 | qa | M | IN10, IN9, X1 | **Reconciliation / idempotency / DAG-rebuild suite (P0 blockers).** All three P0 tests green in CI and **blocking**. |
| WP-IN14 | data | S | IN2, D10 | **Redaction at the ingest boundary** (invokes `WP-D10` redactor, per merge #3). |

### Track C — Cost engine _(Phase 3)_

| ID | Owner | Sz | Deps | Title & Done-when |
|---|---|---|---|---|
| WP-C1 | cost | M | D3 | **Versioned `model_pricing` table + authoritative dated seed + refresh cadence** (absorbs `WP-D9`). Multiple `effective_from` rows per bucket without conflict. |
| WP-C2 | cost | M | C1, D1 | **PricingProvider port + timestamp-aware dated-price resolver.** An event resolves to the OLD rate before a change, the new rate at/after. |
| WP-C3 | cost | M | C2, D2 | **CostEngine** — ground-truth tokens × dated bucketed price. Cost matches a hand-computed value from JSONL tokens × seed. |
| WP-C4 | cost | M | C3, IN7 | **Compaction-baseline preservation + RE-pricing across PreCompact.** A PreCompact session reprices to baseline + post-compaction spend, matching the oracle. |
| WP-C5 | cost | M | C3 | **Delegation-savings metric** (clean-room, tied to the model-routing decision). Savings = Σ max(0, top-tier-equiv − actual), matching a hand check. |
| WP-C6 | qa | S | C2, C1, X1, X5 | **Staleness-fails-CI gate.** A model+bucket in the golden corpus with no priced row → **red build**. |
| WP-C7 | backend | M | C3, C5, **U0** | **Cost query API** — TypeBox-validated, loopback+token-gated cost/savings endpoints. Figures match direct engine calls (no drift). |

### Track U — Realtime + Web UI _(Phase 1/4)_

| ID | Owner | Sz | Deps | Title & Done-when |
|---|---|---|---|---|
| WP-U0 | backend | M | F1, F7, D2 | **Fastify server bootstrap** (added, §2). Loopback-or-fail + timing-safe token + same-origin + TypeBox + config. Turns `WP-F7` contract tests green. |
| WP-U1 | backend | M | U0 | **RealtimeHub SSE endpoint** (server→browser, same-origin, auth-gated, resumable). A cross-origin `Origin` on `/api/stream` is rejected; no wildcard CORS. |
| WP-U2 | backend | M | U0 | **Read API foundation** — Fastify plugin, TypeBox contracts, auth guard, shared DTOs. Every read route auth-guarded (timing-safe). |
| WP-U3 | backend | M | U2, D7, IN8, IN12 | **Session/agent/subagent-tree endpoints** (daily Q1/Q3/Q5). `GET /sessions/:id/tree` built from a **query over `orchestration_edges`** (proven, not reconstruction). |
| WP-U4 | backend | M | U2, D7, C3 | **Cost, delegation & global-DAG endpoints** (daily Q2/Q4). Cost matches JSONL × versioned pricing; no API-side inference. |
| WP-U5 | frontend | M | F1, U1 | **React/Vite SPA shell + token auth + resilient SSE client.** Loads only behind the token gate; no token → no data/stream. |
| WP-U6 | frontend | M | U5, U3, IN8, IN12 | **Live status view** (working/unknown/done) — the **<30s at-a-glance**. A newly-stuck agent flips to "unknown" live via SSE within the window. |
| WP-U7 | frontend | L | U5, U3 | **Session-scoped subagent tree view** (D3 force+tree, live). From a real fixture the tree matches the labeled hierarchy (**≥95%**). |
| WP-U8 | frontend | L | U5, U4 | **Global persistent per-instance orchestration DAG view** (the moat). Spans multiple sessions, sourced from a query over persisted edges. |
| WP-U9 | frontend | L | U5, U4 | **Cost / Sankey / delegation-savings view** (daily Q2/Q4). Every displayed dollar traces to ground-truth tokens × dated price. |

### Track A — Alerts _(Phase 5-6 — **post-1.0** per best-path §6.1, applied 2026-07-06; ship A1–A7 core after v1.0)_

| ID | Owner | Sz | Deps | Title & Done-when |
|---|---|---|---|---|
| WP-A1 | backend | S | F1 | **AlertSink port + alert domain types** (`packages/shared`). Pure interface, no server/driver import. |
| WP-A2 | data | M | A1, D3 | **Alert & webhook schema migration** (clean-room-safe, hoangsonww-attributed). Forward-only, idempotent. |
| WP-A3 | security | M | A1 | **Secret handling: `token_ref` resolver** (launchd env / chmod-600) + redaction + static gate. A >0600 dotfile is rejected. |
| WP-A4 | security | M | A1, A2 | **Webhook dispatcher + no-SSRF guard** (operator-configured targets only). No code path reads a URL from a payload (test-proven). |
| WP-A5 | backend | L | A2, C3, IN5 | **Alert rules engine** (cost threshold, stuck agent, error) over the projection. `cost_threshold` fires exactly at the operator limit (boundary tested). |
| WP-A6 | backend | M | A1, A3, A4 | **Telegram AlertSink adapter** (hoangsonww-attributed, token via `token_ref`). Delivers correctly-formatted messages per `AlertKind`. |
| WP-A7 | backend | M | A4, A5, A6 | **Delivery log with retry/backoff + dedupe & rate-limit.** A real condition → **exactly one** throttled notification. |
| WP-A8 | backend | M | A2, A5, A3, **U0** | **CUT (best-path §6.2, applied 2026-07-06)** — ~~**Operator alerts API** (auth-gated CRUD for rules + targets). All write endpoints token-guarded, cross-origin rejected.~~ _(near-zero value for a single operator; row kept for WP-numbering stability)_ |
| WP-A9 | frontend | M | A8, U5 | **CUT (best-path §6.2, applied 2026-07-06)** — ~~**Alerts UI** — rule config, target registration, delivery-log view. Operator manages all three rule kinds from the UI.~~ _(near-zero value for a single operator; row kept for WP-numbering stability)_ |
| WP-A10 | qa | M | A4, A6, A7, ~~A8, A9~~ _(cut per §6.2)_ | **Alerts negative-test corpus + coverage hardening** _(**kept** per best-path §6.2 — this is the SSRF/secret-leak negative corpus, not CRUD)_. SSRF test proves no payload-URL dial-out; secret-leak test proves no token in SQLite/browser. |

### Track X — Delivery, docs & QA substrate _(Phase 1 continuous + 7)_

| ID | Owner | Sz | Deps | Title & Done-when |
|---|---|---|---|---|
| WP-X1 | qa | L | S2, S4, F1 | **Golden real-session fixture corpus** (raw, redacted, manifested). ≥3 real sessions; all four pathologies each represented (manifest self-test). |
| WP-X2 | qa | L | X1, D1 | **Labeled ground-truth annotations + typed fixture loader.** Every session has an `expected/*.json`; a test fails if any lacks one. |
| WP-X3 | qa | M | X2, IN10, IN7, D1 | **Three P0 reconciliation release-blocker tests.** Σ`token_usage`==JSONL exact; double-replay byte-identical; DAG-rebuild-from-JSONL-alone. |
| WP-X4 | qa | L | X2, IN6, C4 | **Expanded negative-test catalogue (12 scenarios).** Each maps to a CD/acceptance criterion. |
| WP-X5 | devops | M | F1, S7 | **CI coverage gate (>90%, blocking) live from Phase 1.** A PR dropping below the threshold is blocked (demonstrated). |
| WP-X6 | docs | S | X5, X7 | **README with green-only badges + donation.** Every badge renders green/true (via the badges skill). |
| WP-X7 | docs | M | F1 | **GitHub Pages docs site build** (docs public, app stays 127.0.0.1). CI builds & publishes on merge. |
| WP-X8 | devops | M | S4, IN1, S7, IN3 | **`hooks/` installable scripts + install docs** (absorbs `WP-IN4`). Install → working end-to-end hook → loopback ingest → `events_raw` on a real session. |
| WP-X9 | docs | S | X3, X5 | **Release checklist + per-role DoD.** `RELEASE.md` enumerates every CD-7 build-failing gate + CD-9 provenance check with a verification step each. |
| WP-X10 | docs | S | — | **WORKLOG discipline** — template + presence check. Exists locally, follows the worklog skill format, git-excluded. |
| WP-X11 | docs | S | F1 | **DELETED (best-path §6.3, applied 2026-07-06)** — ~~**Vector-DB EXPERIMENTAL stub** (labeled, off critical path). Unambiguously labeled; documented as non-blocking.~~ _(vector-DB track removed entirely; row kept for WP-numbering stability)_ |

---

## 6. CD coverage matrix

Every canonical decision is implemented by ≥1 WP (verifier-confirmed `ok:true` for all ten).

| Decision | Implemented by |
|---|---|
| **CD-1** Ingest primacy (Phase-0-decided) | S2, S7, IN5, IN10, IN11 |
| **CD-2** Immutable substrate + projection | D4, D5, D6, D7, IN1, IN2, IN6, IN7, IN10 |
| **CD-3** Reconciliation precedence + backfill | S3, S6, D8, IN7, IN9, C3 |
| **CD-4** Schema (events_raw/events/edges/token_usage/pricing) | D4, D5, D7, D8, C1, C2 |
| **CD-5** SSE + same-origin | U1, U5, C7, ~~A8~~ _(cut per best-path §6.2, applied 2026-07-06)_ |
| **CD-6** Ports & adapters | D1, IN1, IN2, IN3, IN6, C2, C3, U0, U1, U2, A1 |
| **CD-7** Security + coverage from commit one | F3, F4, F5, F6, F7, F8, U0, D10, A3, A4, X5 |
| **CD-8** Phase-0 hard-stop spike | S1–S7, X10 |
| **CD-9** Per-artifact licensing | F6, X8, U7, C5, A2, A6 |
| **CD-10** Scope + secrets + retention | D10, A2, A3, A6, IN14, U8, ~~X11~~ _(deleted per best-path §6.3, applied 2026-07-06)_ |

---

## 7. Sequencing notes & risks (from the verify pass)

- **Phase-0 is the single chokepoint.** `WP-S7` gates everything via `WP-F1`. On NO-GO, no
  scaffold proceeds — the moat feasibility is reconsidered, not worked around.
- **Security + coverage go live at Phase 1, never deferred.** `WP-F3…F7` + `WP-U0` land
  before any ingest feature code. `WP-F7`'s contract tests are **intentionally red** from
  wave 8 and turn green only when `WP-U0` wires the primitives at wave 9 — **do not merge
  `WP-F7` as "passing"**; its DoD is jointly owned with `WP-U0`.
- **`WP-U1` (RealtimeHub) needs a projection change-notifier** that only exists after
  `WP-IN7`. Build it against an in-memory fake in Phase 1, rewire to the real projection
  emitter in Phase 3 — otherwise it cannot satisfy its "fans projection deltas" criterion.
- **Trust the waves over authored phase fields** — several UI/QA WPs were mis-tagged Phase 1
  but genuinely depend on the Phase-3 projection/watchdog.
- **The five merges (§2) prevent two agents writing the same file** — enforce them before
  fan-out (pricing, `events_raw` append, redaction, hooks installer, storage substrate).
- ~~**Alerts is the longest tail** (Phase 5-6 by design); its owner starts `WP-A1/A2/A3` early
  (they need only `WP-F1/D3`) so the track isn't the last thing blocking release.~~
  _(Amended per best-path §6.1, applied 2026-07-06: the alerts track is **post-1.0** and no
  longer blocks release; the release critical path ends at the moat P0 proof — see §4.)_

---

## 8. Global Definition of Done (applies to every WP)

- Touched code passes **typecheck + lint + tests**; coverage stays **>90%** (the gate is
  merge-blocking from Phase 1; it blocks at 90.0% or below).
- No security invariant is weakened: loopback-only bind; mandatory-token-or-fail-startup;
  SSE same-origin; no subprocess spawner; no SSRF; secrets never in SQLite/SSE/logs.
- Ground-truth tokens are **read, never inferred**; every displayed dollar traces to
  (tokens × a dated priced model).
- No all-rights-reserved code copied (clean-room for cast/disler/nirdiamant; attribution for
  simple10/hoangsonww), verified by the CI provenance scan.
- A `WORKLOG.md` entry is appended for each meaningful WP; AI-harness files stay git-excluded.

---
_Decomposition + adversarial verification workflow (8 track owners + 1 verifier), Opus /
high effort, ~452k subagent tokens. Implements [`concept-analysis-v2.md`](concept-analysis-v2.md)
CD-1…CD-10 against the design of record in [`../ai/DESIGN.md`](../ai/DESIGN.md). Open work:
[`../../TODO.md`](../../TODO.md) · completed: [`../../DONE.md`](../../DONE.md)._
