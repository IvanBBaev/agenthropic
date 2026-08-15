# Implementation Review — 2026-08-09 (owner-ordered)

Ordered explicitly by the owner in chat. This document reviews the **shipped
implementation at commit `2f8d103`** and is **not** design-analysis #10 — the
roadmap §8 design-analysis freeze (9 of 9) remains intact. All spike/bench numbers
quoted anywhere in this report are **PROVISIONAL** pending LABEL-ME ratification.

Review date: 2026-08-09 (between KC-1, passed under recorded owner override, and
KC-2 due 2026-09-14). Ten dimensions were reviewed; findings below carry one of
three verdict labels: **CONFIRMED** (adversarially verified in code),
**PLAUSIBLE** (credible from code, not settled by a verification pass), and
**UNVERIFIED-LOW** (low severity, not verified). REFUTED findings were removed
before synthesis.

---

## Executive summary

The implementation is **solid and unusually honest** — the verdict is positive.
The security invariants hold as coded, not just as documented; the cost engine
enforces "no silent $0" at every boundary with the halt gate ordered before any
DB write; and the honesty discipline (coverage-honesty guards, as-built doc
boxes, a UI that renders uncertainty instead of coercing it) is real and rare.
The three most important strengths: (1) defense-in-depth on the security
invariants — loopback bind enforced twice, auth on the routed path, TOCTOU-hard
read-only corpus access; (2) cost integrity end-to-end — token ground truth,
no stored dollars, idempotent replay proven byte-identical; (3) test quality —
mutation-killing negative suites on real infrastructure. The three most
important weaknesses: (1) **CONFIRMED**: migration 7 was edited in place after
being applied — the live DB at `data/agenthropic.db` still holds the old seed,
so under HEAD whole-corpus ingest sinks on that DB while a fresh DB works;
(2) **HIGH/PLAUSIBLE**: per-file skip diagnostics (`onWarning`) are never wired
in production — an oversize/EACCES transcript silently freezes a session's
dollars; (3) the composed system drops signals its parts emit (`ingest-failed`
SSE frames no client hears) and the synchronous watcher/read paths scale with
corpus size, not delta size. **Single highest-leverage improvement:** corrective
migration 11 repairing the `model_pricing` seed plus a migration checksum — it
un-sinks the operator's actual database today and prevents the divergence class.

---

## Disposition since this review (amendment, 2026-08-15)

This report is a **dated record of what the tree looked like on 2026-08-09**, and the
body below is left exactly as written — a review that quietly edits its own
findings once they are fixed stops being evidence of anything. What follows is
the delta: the tree has since moved, and a reader who acts on the findings
without this section will chase work that is already done.

The method here is narrow on purpose. A finding is marked **closed** only where
the code that implements the fix **names the finding** in a comment and the
mechanism was read and matched against the *Fix:* line recorded below — fourteen
of the twenty-seven weaknesses carry such a reference. Where a fix landed partly,
or where the shipped code addresses one half of a two-part finding, it says
**partial** and names which half. Everything else is marked **not re-verified**:
that is not a claim it is still broken, it is a statement that nobody looked
again. The Low block was not re-reviewed at all.

Both High findings are closed:

- **H-1** — migration **11** (`model-pricing-seed-convergence`) rewrites the seed
  rows, and `migrationChecksum` now hashes each migration's content into
  `schema_version` and re-verifies it on every start, so an in-place edit of an
  applied migration fails loudly instead of diverging in silence
  (`apps/server/src/db/migrations.ts`). One thing this amendment **cannot**
  assert: whether any particular operator database has actually been migrated. The
  repair exists in code; whether it has run on `data/agenthropic.db` is a runtime
  fact, not a tree fact.
- **H-2** — the composition root wires `onWarning` into a rate-limited
  `SkipReporter` (`apps/server/src/index.ts`), and its cumulative per-reason
  counters surface as `ingestSkips` on `/api/health`. A file the ingest declines
  to read is now reported rather than forgotten; parser-spec §4.3 documents the
  first consumer of that seam.

| # | Status (2026-08-15) | What changed |
|---|---|---|
| H-1 | closed | Migration 11 + per-migration content checksum verified on start |
| H-2 | closed | `SkipReporter` wired to `onWarning`; `/api/health.ingestSkips` |
| M-1 | closed | Gate #7 defensive fallback with distinct `legacy_explore` provenance, CHECK-constrained by migration 13. Scope stays PROVISIONAL and the shape is **unwitnessed in the real corpus** — see parser-spec §3 |
| M-2 | closed | Watcher resolves pricing per tick and resets attempts when the pricing content changes |
| M-4 | closed | Restore removes a pre-existing `-wal`/`-shm` before opening |
| M-5 | closed | `usage_by_agent` restricted to the selected agent id-list; migration 12 adds the edge endpoint indexes |
| M-6 | closed | `SERVER_EVENT_TYPES` moved into `packages/shared` and imported by both sides |
| M-7 | closed | Root-scope `setErrorHandler` with 5xx message suppression |
| M-8 | closed | Top-burners table shipped (`apps/web/src/views/top-burners.ts`) |
| M-9 | partial | Today/this-week windows shipped (`cost-windows.ts`); an **aggregate delegation-saved figure was not verified** as existing |
| M-10 | open, acknowledged in code | `CostView.tsx` names M-10 and records that the fix is a shared clock tick, not a per-view workaround |
| M-11 | closed | Argv-free curl delivery (`--variable` / `--expand-header`), curl ≥ 8.3.0 floor, fail-closed below it |
| M-12 | closed | A first-ingested-session ownership rule, with skipped messages counted rather than silently dropped |
| M-13 | closed | Persisted-slug hint lets a late `SubagentStop` reconcile against the agent row |
| M-14 | closed | Duplicate session uuid across slugs recorded as a `duplicate-session` skip — parser-spec §4.3 |
| M-15 | partial | A tail-read path and a `lastTickDurationMs` health field shipped; **whether the synchronous full-fingerprint pass is gone was not verified** |
| M-16 | closed | Boot ingest moved after listen; `/api/health.ingest` reports `replaying` / `idle` |
| M-18 | partial | `crossSessionUsageCollisions` exposed on health under this item's number; the endpoint's re-enumeration cost was **not re-measured** |
| M-20 | closed | Daily backups wired in the composition root, not only as a manual drill |
| M-22 | partial | CI now runs a **web production build**; the production *run* path was not verified |
| M-23 | superseded | All five packages now pin 100% and all five carry an anti-pragma guard (four named `coverage-honesty.test.ts`; `apps/web`'s is the `coverage honesty` block of `test/honesty.test.tsx`) |
| M-3, M-17, M-19, M-21 | not re-verified | No code in the tree names them |
| M-24 | **still open, owner-only** | The hierarchy-accuracy gate remains **unmeasured**: the LABEL-ME hand-labelled corpus does not exist, so the ≥95% bar reports **NOT CERTIFIED** and every Phase-0 number stays PROVISIONAL. No agent can close this — producing ground truth is Ivan's act |
| M-25 | **still open, owner-only** | Branch protection on `main` is still not enabled, so no gate is merge-blocking; the KC calendar's owner-only acts are unchanged |
| Low (all) | not re-verified | The block was not re-reviewed |

The two items at the bottom of that table are the ones worth re-reading. Everything
above them was work an agent could do and did; M-24 and M-25 are the findings that
**cannot be closed by writing code**, and they are precisely the ones that gate the
project's honesty claims — an uncertified accuracy number and an unenforced quality
bar. Fourteen fixes have not moved them by one inch.

---

## Strengths

Merged and deduplicated across the ten dimensions. Every claim below was cited
against code by the dimension reviews.

### 1. Security invariants are enforced in code, not by convention

- **"Loopback bind only (`127.0.0.1`) — never `0.0.0.0`"** is enforced twice:
  `HOST = '127.0.0.1'` is a non-configurable constant
  (`apps/server/src/config.ts:14`) and `enforceLoopbackOrExit` re-checks the
  *actually bound* address after listen and process-exits on anything
  non-loopback (`apps/server/src/index.ts:135-150`). `apps/web/vite.config.ts`
  pins dev **and** preview to 127.0.0.1.
- The auth gate keys on the **routed** path (`request.routeOptions.url`), so
  percent-encoding tricks like `/%61pi/health` cannot dodge the `/api/` check
  (`apps/server/src/server.ts:143-163`, rationale in the comment). Same-origin
  runs before auth on `/api/stream` — honoring "Auth-gate all endpoints;
  same-origin check on the SSE stream (CD-5)".
- Token comparison is length-leak-free: both sides SHA-256-hashed before
  `timingSafeEqual` (`packages/shared/src/security/index.ts:47-51`). The one
  sanctioned `?token=` spot (EventSource cannot set headers) is scrubbed from
  the request-log serializer (`server.ts:77-93`, `security/index.ts:75-87`).
- Corpus access is TOCTOU-hard and structurally read-only: `O_RDONLY |
  O_NOFOLLOW`, `fstat` on the fd (isFile + size cap) before read, fd closed in
  `finally`; the adapter imports only read-family fs symbols
  (`apps/server/src/corpus/node-corpus-fs.ts:49-73`). Caller-supplied session
  ids are only ever *compared* against enumerated refs, never turned into paths
  (`apps/server/src/api/substrate-provider.ts:112`).
- SSE frame injection is blocked at the serializer — event names CR/LF-stripped,
  data JSON-single-line (`apps/server/src/realtime/hub.ts:32-35`); a dead writer
  is dropped without breaking fan-out (`hub.ts:62-73`).
- The hook receiver redacts secrets **before** building the envelope and the
  idempotency key, so secrets never reach storage and redacted redeliveries
  dedupe correctly (`apps/server/src/hooks/routes.ts:104-114`).
- The static gate against **"Never add a browser-driven subprocess/`claude`
  spawner (the RCE that this project deliberately walks away from)"** has an
  honest threat model (tripwire, not sandbox) and an auditable allowlist
  (`scripts/check-no-spawner.mjs:10-32`).

### 2. Cost integrity: "Token counts are ground truth … never inferred" holds end-to-end

- The unknown-model **halt gate runs before any DB write**: `computeCostUsd`
  throws `PricingError` before the projection transaction
  (`apps/server/src/ingest/ingest-session.ts:79-83`;
  `packages/core/src/cost/compute-cost.ts:100-121`), and the API surfaces it as
  an explicit 422 naming the model — never a silent $0 row
  (`apps/server/src/api/routes.ts:300-307`).
- **No stored dollars**: `tokens INTEGER NOT NULL` (`migrations.ts:195`) and
  every dollar is computed at read time from dated rates
  (`apps/server/src/api/queries.ts:36-64`) — a pricing correction retroactively
  fixes all history; float drift cannot accumulate in storage.
- Storage-level dedup convergence is monotonic and replay-idempotent: per-bucket
  MAX, model settle only on strictly greater output, zero UPDATEs on unchanged
  replay (`apps/server/src/db/token-usage.ts:65-79`); byte-identical double
  replay is machine-proven (`p0-double-replay.test.ts:104-123`).
- Estimates cannot masquerade as facts: `isEstimate` is the literal type `true`
  (`packages/core/src/cost/delegation-savings.ts:72-73,87`); the UI renders the
  badge, `~` prefixes, the named hypothetical model and disclosed exclusions
  (`SessionCostAnalysis.tsx:219-255`). `formatUsd` makes `$0.00`, `<$0.0001`
  and four-decimal sub-cent values string-distinguishable by construction
  (`apps/web/src/format.ts:22-27`).
- `unpricedTokens` is surfaced in every consumer (CostView, SessionsView,
  DagView, LiveView), and retention **prices what it deletes** before deleting
  it (`retention-queries.ts:103-129,168-207`).

### 3. Parser: 13 of the 14 normative gate items conform, with structural (not textual) joins

- Spawn indexing, dual-layout classification, sidecar-anchored parent
  resolution in exact spec-4.1 priority
  (`packages/core/src/parser/parse-session.ts:326-328, 87-91, 448-451`).
- Self-referential parents resolved across **all** transcripts; ids join via
  Map keys, with tag regexes confined to the two record types the spec allows —
  never prose-wide; session uuid keying throws on any cross-record
  contradiction (`parse-session.ts:304-344, 419-425, 179-201`).
- Per-transcript usage attribution and per-bucket-max dedup with the reconciled
  model-settle rule, keeping the two-models-tied collision loud
  (`parse-session.ts:544-568`; `dedupe.ts:123-149`).
- Compaction extraction throws on a boundary without a timestamp; sub-10 ms
  sibling waves are explicitly UNORDERED — no manufactured total order
  (`compaction.ts:92-114`; `waves.ts:44-53`).
- The WP-IN5 adapter reuses the parser's own classifier, enforcing the
  four-artifact-types MUST by construction (`disk-substrate.ts:212-218`).

The heading's "13 of the 14" was true on the review date and is kept for the
record; the fourteenth (gate #7) landed afterwards — see M-1 in the disposition
table. The count that replaced it is not "14 of 14" either: parser-spec §3 now
separates **implemented** (14) from **exercised by the real corpus** (11), and
gate #7 is one of the two shapes that exist only against fixtures.

### 4. Ingest is fail-safe in the correct direction: extra work, never wrong data

- Fingerprint captured **before** ingest reads, so a mid-pass append re-ingests
  next tick (over-ingest is free because projection is idempotent)
  (`corpus-watcher.ts:344-352`); tail-trimmed unterminated JSONL segments and
  empty-after-split guards keep live appends from poisoning a session parse.
- Commit-only-on-success with a bounded quarantine (3 attempts) and byte-change
  re-admission; failed sessions are never checkpointed
  (`corpus-watcher.ts:257-298`).
- Replay checkpoints change **work, never results**: revision stamp, scoped
  sha-256 key, EXISTS-row proof, degrade-to-full-replay on any doubt
  (`replay-checkpoints.ts:57, 90-115`).
- "Could not look" is never spelled "nothing there": UnreadableRoot vs
  ENOENT-empty is a typed distinction, and total loss reports **more** than
  partial loss (`fs-port.ts:128-141, 170-185`; `ingest-corpus.ts:119-121`).
- Honest status lifecycle: ingest asserts only `working` (transcripts cannot
  prove termination); terminals come only from hooks and stay sticky; the
  watchdog says `unknown`, never `completed`
  (`normalize-session.ts:32-55`; `db/agents.ts:98-105`).

### 5. Data layer: invariants live in the storage engine

- `events_raw` is append-only via BEFORE UPDATE/DELETE `RAISE(ABORT)` triggers
  (`migrations.ts:76-85`) — and retention issues no DML against it.
- **"Agents/subagents are first-class queryable entities with a
  self-referential `parent_agent_id`; the subagent tree is a data fact, not a
  UI reconstruction"** — implemented literally: indexed self-referential
  column, `orchestration_edges` with provenance CHECK under a UNIQUE logical
  key, served verbatim (`migrations.ts:134-171`; `api/queries.ts:318-377`).
- Prune is transactional, priced-before-delete and receipt-gated: assessment
  runs inside the delete transaction, the journal append too — a failed receipt
  rolls the deletion back (`prune.ts:168-201`). The windowed delete provably
  equals its measurement (`retention-queries.ts:77-95`).
- **"SQLite in WAL mode"** is asserted, not assumed: pragmas set and read back,
  throw on silent fallback (`connection.ts:18-47`).

### 6. API/HTTP honesty and measured performance work

- Cost-analysis distinguishes four no-substrate facts as different statuses
  (retryable 503 vs true 404 vs 422) instead of a blanket 404
  (`substrate-provider.ts:54-64`; `routes.ts:255-282`).
- Every list surface is capped and every cap **visible** (`truncated` flags,
  `total` counts) (`packages/shared/src/schemas/common.ts:55-66`;
  `queries.ts:598-609`).
- SSE lifecycle cleanup is complete on both ends; the SPA closes the no-replay
  gap by refetching persisted truth on reconnect (`server.ts:186-208`;
  `LiveView.tsx:92-108`).
- De-N+1 work is **measured and the measurements recorded in the code**
  (627 ms → 9 ms; 2.64 s → one rollup scan; `queries.ts:69-81, 473-494`) —
  future maintainers inherit numbers, not just shapes.

### 7. Frontend renders uncertainty instead of coercing it

- Total uncertainty vocabulary: `unrecorded` / `unknown` / `unrecognised
  (<raw>)` are three distinct rendered states; a missing bucket renders `?`,
  not 0 (`apps/web/src/views/status.ts:60-78`; `live-model.ts:23-28`).
- The SSE patch model refuses to invent state it cannot reconcile — unmatched
  events force a refetch of persisted truth (`live-model.ts:68-87`).
- The Sankey never apportions what no data supports; zero-cost models and
  remainders are listed, not hidden (`views/layout/cost-flow.ts:151-233`).
- Charts carry real text alternatives (visible prose, `aria-describedby`), and
  layout drops/cycles are surfaced (`chart-summary.ts`; `DagView.tsx:102-121`).
- Token hygiene matches the security model: sessionStorage only, Bearer header
  everywhere, the one query-string exception documented
  (`apps/web/src/token.ts`, `api.ts:2-7`, `sse.ts:5-8`).

### 8. Architecture and docs discipline

- Clean five-package dependency DAG verified in manifests **and** imports;
  `apps/web/src/dto.ts` is an `import type`-only bridge, so TypeBox never
  enters the browser bundle while the DTO contract stays single-sourced
  (`dto.ts:12-34`).
- Thin schema+dispatch routes; domain logic in `@agenthropic/core`.
- Docs honesty: dated "as built" update boxes, KC-0/KC-1 overrides recorded
  verbatim in README/TODO/DONE — rare and valuable.

### 9. Test quality: mutations killed on real infrastructure

- Mutation catalogue M1–M5 (cost boundary flip, dropped unknown-model guard,
  swapped origin/auth order, mislabeled edge source, dedupe last-wins) all
  killed by named assertions (`compute-cost.test.ts:76-114`;
  `security-stream.negative.test.ts:65-73`;
  `negative-catalogue.core.test.ts:229-299`; `dedupe.test.ts:112-142`).
- Negative suites run on real Fastify + real migrated SQLite temp DBs; the
  real-disk seam test plants a real out-of-root symlink and proves it is
  skipped with reason `symlink` on real macOS `lstat`/`O_NOFOLLOW`
  (`real-corpus.smoke.test.ts:245-258`).
- The coverage-honesty guard sweeps `src` as text (unmockable), fails on an
  empty sweep, pins all four thresholds at 100 and bans `exclude`
  (`apps/server/test/coverage-honesty.test.ts:53-101`).
- The annotation/scoring system refuses machine-authored truth and cannot
  launder synthetic entries into the human corpus
  (`hierarchy-gate.test.ts:157-171`).
- The bench harness refuses to run against a real corpus, labels its linear
  projection "NOT MEASURED" and a floor, and exercises the real pricing path
  (`apps/server/bench/corpus-scale.ts:638`).

---

## Weaknesses

Grouped by severity; cross-dimension duplicates merged (merge noted in the
entry). Format: title — dimension(s) · verdict · location; failure scenario;
suggestion. `(known, parked for owner)` marks items already on an owner list.

### High

**H-1. Migration 7 was edited in place after being applied; no checksum, no
repair migration** — data-layer · **CONFIRMED** ·
`apps/server/src/db/migrations.ts:40`
Migration id 7 changed between commits (`effective_from` '2026-07-11' →
'2026-01-01' **and** all four real model keys bare → `claude-`-prefixed), but
`runMigrations` skips by recorded id only. The live DB at `data/agenthropic.db`
has ids 1–7 applied with the **old** seed: under HEAD every real-model message
throws `PricingError`, fails the halt gate, and is quarantined — whole-corpus
ingest sinks on that DB while a fresh DB works, with nothing detecting the
divergence.
*Fix:* corrective migration id 11 rewriting the seed rows, plus a content
checksum recorded in `schema_version` so an edited applied migration fails
loudly.

**H-2. Per-file skip diagnostics are dead in production; an oversize/EACCES
main transcript silently freezes a session's dollars** — ingest-watcher +
performance-roadmap (merged) · **PLAUSIBLE** · `apps/server/src/index.ts:356`
The production watcher wiring never passes `onWarning` (the per-file skip
sink), and `logReplaySummary` omits `filesSkipped`. A main transcript crossing
the 64 MiB cap (PROVISIONAL value, itself parked) or chmod'd to EACCES is
skipped; the session ingests partially from subagent files, counts as ok, is
checkpointed — its persisted token totals and dollars freeze while the JSONL
ground truth grows, with zero signal in logs, SSE, health or UI. The entire
NoSubstrate/SkippedFile design is unreachable in the composed server.
*Fix:* wire `onWarning` to a rate-limited structured log and/or SSE diagnostic,
add `filesSkipped` to replay/tick log lines and a cumulative skip counter to
`/api/health`; consider a per-session partial-substrate flag rendered like
`unpricedTokens`.

### Medium — CONFIRMED

**M-1. Parser gate #7 (legacy 2.1.70 bare-Explore fallback) is the one
unimplemented gate item** — parser-core ·
`packages/core/src/parser/parse-session.ts:327`
A pre-2.1.71 transcript's legacy spawn shape never enters `toolUseOwner`, so a
flat child with no other anchor silently orphans — quiet edge loss in the moat
DAG when ingesting an older machine's corpus (the product's core use case);
meanwhile TODO.md:325 claims the 14-item gate is satisfied and parser-spec §3
records no waiver.
*Fix:* add the defensive fallback with distinct provenance, or record an
owner-signed waiver in the spec's §3 table so 14/14 stops overstating.

**M-2. Ingest prices against a boot-time pricing snapshot; seeding a new model
row does not unblock ingest** — cost-engine · `apps/server/src/index.ts:358`
`loadPricing(db)` is captured once at start; the operator follows the
PricingError's own advice, seeds the row, and the watcher still burns its 3
attempts on the stale snapshot and parks the session — while the cost-analysis
route (fresh `loadPricing` per request) works, a confusing split-brain. The
watcher's own comment says the retry budget exists for "a pricing row that
arrives", contradicting the snapshot.
*Fix:* reload pricing per tick (µs against a 3 s poll) and reset attempt
counters when the pricing table changes.

**M-3. Retention residue semantics inverted now that replay checkpoints are
wired** — data-layer (merges the ingest-watcher stale-doc finding) ·
`apps/server/src/retention/prune.ts:41`
The documented "restart replay puts pruned rows back" is false: checkpoints are
honored while the `sessions` row exists (retention never deletes sessions), so
idle sessions' pruned `token_usage` stays gone; a later append resurrects it,
and a subsequent prune journals the same dollars **again** — reconciliation by
summing receipts over-counts. Opt-in policy (defaults NO_RETENTION), so harm is
wrong operator documentation, not wrong live dollars.
*Fix:* at OPEN-1 ratification decide the interplay explicitly — invalidate
affected checkpoints inside the prune transaction, or exclude pruned windows on
re-ingest — and fix the prune.ts comment + journal note either way.

**M-4. `restoreDatabase` can replay a stale WAL from the pre-restore database
into the restored file** — data-layer · `apps/server/src/db/backup.ts:25`
`copyFileSync` then `openDatabase` with nothing removing a pre-existing
`destPath-wal`/`-shm`: after an unclean shutdown plus in-place restore, SQLite
recovers the OLD database's WAL frames into the restored copy — a refused
legitimate restore or a silent mix of two states, in exactly the disaster path
backups exist for.
*Fix:* delete (or refuse on) `${destPath}-wal`/`-shm` before the copy; document
that in-place restore requires the server stopped.

**M-5. `getGlobalDag` prices and groups the entire `token_usage` table on every
request** — data-layer · `apps/server/src/api/queries.ts:563`
`usage_by_agent` builds from the unfiltered priced CTE regardless of
`nodeLimit` (measured 432 ms over 752k rows; ~5 s projected at real corpus
scale), and the edge query full-scans `orchestration_edges` (no parent/child
index). Page cost grows with corpus size, not response size.
*Fix:* restrict `usage_by_agent` to the selected agent set (id-list injection,
as `sessionSummarySelect` already does); add edge indexes on
`(parent_agent_id)` / `(child_agent_id)`.

**M-6. `ingest-failed` SSE frames are published but no client ever listens —
the dashboard stays silent on quarantine** — api-realtime + tests-quality
(merged: the event-type list is hand-duplicated per package and has already
drifted) · `apps/server/src/realtime/bridge.ts:52`, `apps/web/src/sse.ts:65`
EventSource drops named events with no registered listener; `SERVER_EVENT_TYPES`
lists only two of the three emitted types, so a quarantined session produces
nothing in the UI — the exact silent-failure mode WP-IN5 claims fixed
("reaches BOTH the operator … and the dashboard"), and api.md's "Two typed
frames only" is stale.
*Fix:* move the event-type list into `packages/shared`, import it on both
sides, add a contract test that every published `type` is a member, subscribe
and render `ingest-failed` (e.g. LiveView banner); update api.md.

**M-7. Hook receiver escapes the uniform error contract: 5xx leaks raw
`error.message` via Fastify's default handler** — api-realtime ·
`apps/server/src/hooks/routes.ts:115`
`registerHookRoutes` sits on the root app, outside the apiRoutes plugin's
scoped `setErrorHandler`; a throwing `append`/`applyStatus` (SQLITE_BUSY/FULL,
I/O) returns the raw SQLite message and a shape matching neither
`ApiErrorSchema` nor the declared 202 — empirically reproduced. Bounded by
loopback+auth.
*Fix:* root-scope `setErrorHandler` with the uniform `{ error }` shape and 5xx
message suppression; declare 400/500 responses on the route.

**M-8. Q2 (biggest agent/subagent burner) is answerable only by hover-hunting**
— web-frontend · `apps/web/src/views/CostView.tsx:265`
No view lists agents by token count — per-agent tokens exist only in SVG
`<title>` hover tooltips, unreachable for keyboard/AT users; the ux0 TOP
BURNERS leaderboard is absent and TODO.md's "all 5 questions answerable" is
overstated for Q2. A material KC-4 exit-gate gap.
*Fix:* per-agent top-burners table (per-agent usage is already persisted; even
a client-side sort of served DAG nodes would be honest).

**M-9. Q4 today/this-week KPIs and any aggregate delegation-saved figure are
absent; only top-5 sessions are analysable** — web-frontend ·
`apps/web/src/views/CostView.tsx:91`
KPIs are all-time only; delegation savings is reachable solely by clicking one
of the top-5-by-cost sessions — no route or link makes any other session
analysable — so half of Q4 has no on-screen answer. Same overstated-gate
pattern as M-8; RELEASE.md's unchecked [HUMAN] daily-questions box would catch
it pre-tag.
*Fix:* today/this-week KPIs from the existing perDay rows; link SessionsView
rows into cost analysis; an aggregate savings figure needs a server endpoint
(cross-scope — flag it).

**M-10. Relative-time labels freeze: "just now" can persist for hours** —
web-frontend · `apps/web/src/views/LiveView.tsx:131`
`Date.now()` is captured per render and no timer exists anywhere in the web
app; on a quiet stream (heartbeats are comment frames that never reach
EventSource) the recency view presents a stale claim as current until the next
event or navigation.
*Fix:* a 30–60 s interval bumping a clock state; `formatRelativeTime` already
takes injected `nowMs`.

### Medium — PLAUSIBLE

**M-11. Installed hook command exposes the dashboard token in the process
table** — security · `hooks/install.mjs:119`
The generated shell command expands `${DASHBOARD_TOKEN}` into curl's argv; any
other OS account on the machine can harvest it from `ps` during the up-to-3 s
curl window — exactly the "local multi-user" attacker the threat model claims
the token defends against.
*Fix:* pass headers via a 0600 file (`curl --config`/`--header @file`) or a
wrapper reading the env var itself; at minimum document the residual exposure.

**M-12. Cross-session `message.id` collision (resume/fork) would silently
rewrite agent attribution across sessions** — cost-engine · verified in code,
trigger unproven on this machine's corpus · `apps/server/src/db/token-usage.ts:69`
`UNIQUE(message_id, bucket)` is global and the upsert rewrites `agent_id`
without touching `session_id`; if a CLI resume ever replays history into a new
file (the behavior that forces ccusage-class tools to dedupe globally), the
same agent shows different dollars in `/api/dag/global` vs the session tree and
attribution flip-flops with ingest order. A full scan of this machine's corpus
found zero colliding ids today.
*Fix:* decide the ownership rule explicitly (per-session uniqueness + parse-time
dedupe of replayed history, or refuse cross-session `agent_id` rewrites and
count the collision); add a resumed-session fixture either way.

**M-13. SubagentStop verdict lost for subagents shorter than one poll
interval** — ingest-watcher · `apps/server/src/db/agents.ts:150`
A hook arriving before the agent row exists is stored as raw liveness and never
replayed; every fast subagent (< 3 s, common for quick explores) ends `unknown`
instead of `completed`, degrading terminal-state accuracy for the most numerous
agent class.
*Fix:* on ingest of a newly inserted agent id, reconcile pending SubagentStop
rows from `events_raw` through `applyAgentStatus` (sticky-terminal CASE makes
this idempotent).

**M-14. Duplicate session uuid across two slug dirs causes perpetual re-ingest
and `project_slug` flapping** — ingest-watcher ·
`apps/server/src/ingest/corpus-watcher.ts:348`
The fingerprint map keys on sessionId alone (last ref wins) with no
duplicate-stem guard at enumeration; a copied project dir yields a permanent
3-second full re-read loop for that session plus UI-visible flapping project
attribution.
*Fix:* detect duplicates during enumeration, keep one ref, record the rest as
skipped with a `duplicate-session` reason through the (to-be-wired) onWarning
channel.

**M-15. Tail-follow never tails: any change triggers a synchronous full
re-read + re-parse on the event loop** — ingest-watcher + performance-roadmap
(merged) · `apps/server/src/ingest/corpus-watcher.ts:333`
An active session with a tens-of-MiB transcript costs a full re-read/re-parse
every 3 s tick — per-tick cost is O(session size), not O(delta); cumulative I/O
is quadratic in session size, and each tick blocks every API request and SSE
heartbeat. This degrades the dashboard exactly while the user watches a live
session — its core use case. Highest-leverage pre-KC-2 performance fix.
*Fix:* use the fingerprinted size as a byte offset and read only the appended
tail (full re-read on shrink/identity change), and/or parse off-thread; add a
tick-duration metric to health.

**M-16. Startup replay blocks before listen — minutes of no server at real
corpus scale** — performance-roadmap · `apps/server/src/index.ts:407`
`watcher.tick()` runs before `app.listen`; a first boot (or any
checkpoint-degrade) against the real ~1855-session corpus reads and parses
everything with no HTTP surface, no health endpoint and no progress output — a
health-checked supervisor may kill it into a loop.
*Fix:* listen first with a "replaying" status (replay is idempotent, partial
visibility is safe), emit periodic progress, or chunk replay across ticks.

**M-17. Steady-state fingerprint pass lstats every file of every session every
3 seconds** — performance-roadmap · `apps/server/src/corpus/fingerprint.ts:86`
No shortlist: at 10x corpus scale ~60–90k synchronous lstats per tick,
plausibly 0.3–1 s of blocked event loop with zero changes — permanent API/SSE
jitter. (Numbers PROVISIONAL, from the bench's floor-labeled projection.)
*Fix:* shortlist via `fs.watch` or a project-dir mtime cut; revisit the 3 s
PROVISIONAL interval with warm-tick numbers before v1.0.

**M-18. Cost-analysis endpoint re-enumerates the entire corpus and re-parses
the full session per request, synchronously** — performance-roadmap ·
`apps/server/src/api/substrate-provider.ts:106`
Every `loadSession` readdir+lstats every project dir to find one ref, then
re-reads up to 64 MiB — several hundred ms to ~1 s of frozen server per click.
*Fix:* resolve the ref directly from the DB's `project_slug` (keeping the same
containment vetting) or cache enumeration briefly; share the tail/worker fix
from M-15.

**M-19. `getCostSummary` scans all of `token_usage` on every request; no cache
or materialization** — performance-roadmap ·
`apps/server/src/api/queries.ts:473`
The one-scan rewrite fixed the 4x-scan shape, but each CostView load still
prices every row on the event loop; linear with corpus age forever (retention
of token_usage deliberately refused).
*Fix:* maintain the (session, model, day) rollup incrementally at ingest, or
cache the summary invalidated on `session-ingested`.

**M-20. Backups exist as capability + manual drill, but nothing in production
ever runs one — and `events_raw` is the only non-re-derivable table** —
performance-roadmap + data-layer (merged) · `apps/server/src/db/backup.ts:14`
`backupDatabase` is test-proven and never scheduled; a disk failure loses all
hook liveness history permanently. The invariant reads **"SQLite in WAL mode
with backups"** — the letter (WAL + tested restore) is met; the spirit (backups
actually happening) is not.
*Fix:* schedule `backupDatabase` in `start()` (e.g. daily) into `data/backups/`
with the retention module's keepMinimum-floored expiry; log each run. Small, no
owner decision needed.

**M-21. Dated-price resolution is implemented twice (core TS epoch-ms vs SQL
lexicographic) with no reconciliation test** — architecture-dx + cost-engine
(merged; the lexicographic-timestamp sub-aspect is *(known, parked for
owner)*) · `apps/server/src/api/queries.ts:36`, `compute-cost.ts:70-80`
A pricing edge (e.g. `'Z'`-suffixed `effective_from` vs millisecond
`occurred_at` — ordered differently as strings, identically as ms) lets the API
present dollars the ingest halt gate never approved, undetected.
*Fix:* one property-style test asserting the two resolvers agree to the cent
across boundary timestamps; normalize `effective_from` at write time;
longer-term make SQL the single resolver.

**M-22. CI never builds the web app and there is no production run path for
the SPA** — architecture-dx · `.github/workflows/ci.yml`
A change that breaks the Vite production build merges green; the first
`vite build` may happen at v1.0 release time under the KC-4 hard date. The
server never serves `dist/`; the supported deployment topology is undeclared.
*Fix:* add `pnpm --filter @agenthropic/web build` to CI; decide and document
the production topology (server serves `dist/`, or two-process is declared
supported in RELEASE.md).

**M-23. The zero-pragma coverage guard exists only in apps/server and apps/web
— packages/core, shared and test-fixtures are unguarded** — tests-quality ·
`packages/core/vitest.config.ts:16`
A `/* v8 ignore */` above the unknown-model branch in core would keep 100%
green while untesting the code that owns the no-silent-$0 invariant — the
exact failure mode the server guard's own header documents.
*Fix:* extract the sweep into a shared helper and instantiate the guard test
(incl. threshold-pin and no-exclude assertions) in all three packages.

**M-24. Hierarchy-accuracy exit gate is unmeasured: the human annotation
corpus ships empty** — tests-quality · *(known, parked for owner)* ·
`packages/core/test/hierarchy-gate.test.ts:244`
All parser ground truth is machine-authored (6 synthetic fixtures); the ≥95%
claim has never been measured against reality — the tooling honestly prints
NOT CERTIFIED, but honesty does not close the gap.
*Fix:* hand-label the minimum 52 claims from the local spike corpus before the
Phase-3 exit; treat NOT MEASURED as release-blocking.

**M-25. v1.0 critical path is pinched by owner-only acts: KC-3's
merge-blocking clause is unmeetable by agents** — performance-roadmap ·
*(known, parked for owner)* · `TODO.md:109`
KC-3 (2026-10-12) requires the three P0 proofs to be merge-blocking, but main
is not branch-protected — "a passing test that nothing gates on is a test, not
a gate" (RELEASE.md); LABEL-ME is unstarted, the `<30 s` measurement deferred.
The stay-alive condition can fail on a 10-minute Settings click.
*Fix:* put the two 10-minute owner acts (branch-protection click, LABEL-ME
start) in front of Ivan now with the KC-3 date attached; run the `<30 s`
stopwatch measurement in September, not November.

### Low (all UNVERIFIED-LOW)

- **L-1. `check-no-spawner` evasion gaps** — security ·
  `scripts/check-no-spawner.mjs:42` — `.json` never scanned (a
  `"dev": "vite --host"` in package.json passes), no `node:vm` pattern,
  backtick `import(\`data:…\`)` evades. *Fix:* scan package.json scripts for
  the wide-bind patterns; add vm and template-literal patterns.
- **L-2. Unauthenticated route-existence oracle** — security ·
  `apps/server/src/server.ts:144` — unmatched paths skip the auth gate and
  fall to Fastify's default 404, letting a tokenless local client map the API
  surface (401 vs 404). *Fix:* uniform 401/detail-free 404 for unmatched
  `/api/` paths.
- **L-3. SSE writes ignore backpressure** — security + api-realtime +
  performance-roadmap (merged) · *(known, parked for owner: "SSE
  conn-cap/backpressure")* · `apps/server/src/server.ts:186`,
  `realtime/hub.ts:62` — a stalled consumer buffers frames and heartbeats
  without bound for the connection's lifetime. *Fix when picked up:* check
  `write()`'s return / `writableLength` against a cap and drop the stream
  (clients reconnect by design).
- **L-4. Derived sessionId never cross-checked against the filename uuid** —
  parser-core · `apps/server/src/corpus/ingest-corpus.ts:156` — a renamed copy
  quietly fuses onto the original session row and re-dispatches forever.
  *Fix:* assert `parsed.sessionId === ref.sessionId`, record a failure on
  mismatch.
- **L-5. Meta classification wider than the spec's `agent-<hex>.meta.json`** —
  parser-core · `parse-session.ts:81` — a stray `notes.meta.json` poisons its
  session's ingest. *Fix:* return `meta` only when `AGENT_META_RE` matches.
- **L-6. SubstrateError messages render record index as a line number after
  blank-line filtering** — parser-core · `parse-session.ts:192` — corpus
  forensics point at the wrong line. *Fix:* carry original 1-based line numbers
  through `parseFile`.
- **L-7. `is_compaction_baseline` is a dead column: always written 0, never
  read** — cost-engine · `apps/server/src/db/token-usage.ts:68` — the schema
  promises a fact never recorded. *Fix:* wire it from
  `extractCompactionBoundaries` or drop it in a migration.
- **L-8. Per-agent clamping makes the three savings KPIs arithmetically
  inconsistent on screen, unexplained** — cost-engine ·
  `packages/core/src/cost/delegation-savings.ts:183` — Saved can exceed
  (Without-delegation − Actual) with no note. *Fix:* one-line disclosure when
  any term was clamped, in the existing honesty idiom.
- **L-9. Fingerprint blind to metadata-only / mtime-preserving changes** —
  ingest-watcher · `apps/server/src/corpus/fingerprint.ts:78` — a chmod fix or
  `cp -p` restore is invisible until a byte change; undocumented. *Fix:*
  include `ctimeMs`, or document the two blind spots.
- **L-10. Checkpoint keyed on content-derived sessionId while fingerprints key
  on the filename stem** — ingest-watcher · `corpus-watcher.ts:375` — a
  renamed transcript is re-read on every boot forever (fail-safe, perf-only).
  *Fix:* settle checkpoints on the ref-side id.
- **L-11. `retention-queries.ts` header still claims `occurred_at` is
  unindexed; migration 10 added the indexes** — data-layer ·
  `retention-queries.ts:25` — plus the window SELECT's ORDER BY id sort is
  bounded by backlog, not `maxRowsPerRun`. *Fix:* update the paragraph; order
  by `(occurred_at, id)` to match the index.
- **L-12. `getSessionEvents` sorts a session's whole timeline per page** —
  data-layer · `queries.ts:415` — latency grows with session age. *Fix:*
  composite index `events(session_id, occurred_at, id)`.
- **L-13. `/api/sessions/:id/tree` is the one unbounded read endpoint** —
  api-realtime · `queries.ts:318` — response size proportional to data volume,
  no cap, no `truncated` flag. *Fix:* document the deliberate unboundedness
  with a measured worst case, or mirror the global-DAG cap idiom.
- **L-14. Frames carry `id:` but Last-Event-ID is never read; ids restart per
  process** — api-realtime · *(known, parked for owner: ADR-CD-5 open item)* ·
  `realtime/hub.ts:34` — advertised resumability that does not exist. *Fix
  when picked up:* key replay to `events_raw.seq`, or stop emitting `id:`.
- **L-15. Unmatched SSE frames trigger un-coalesced refetches** — web-frontend
  · `LiveView.tsx:74` — an event burst costs one aborted fetch per frame.
  *Fix:* ~250 ms debounce / pending-refetch flag.
- **L-16. Three of four views have no retry and never refresh after mount** —
  web-frontend · `DagView.tsx:58` — a transient blip dead-ends; afternoon-old
  figures carry no staleness signal. *Fix:* Retry buttons + refetch-on-ingest
  or a "new data" notice.
- **L-17. Full `d3` bundle declared but never imported** — web-frontend ·
  `apps/web/package.json:12` — dead supply-chain surface; only `d3-sankey` is
  used. *Fix:* drop `d3`/`@types/d3`.
- **L-18. A failed initial health probe pins the chip to "server unreachable"
  forever** — web-frontend · `Shell.tsx:56` — contradicts a visibly working
  dashboard. *Fix:* re-probe when SSE transitions to open.
- **L-19. `time-to-understand.mjs` IPv6 loopback check can never pass** —
  architecture-dx · `scripts/time-to-understand.mjs:30` —
  `url.host.split(':')[0]` yields `'['` for `[::1]`; fails closed. *Fix:*
  compare `url.hostname` against `'::1'`.
- **L-20. README has no quickstart; real run commands are buried in a
  design-history page** — architecture-dx · `README.md` — time-to-first-run
  measured in hours. *Fix:* 10-line Quickstart + an as-built-first
  development-setup page.
- **L-21. Hand-maintained `hooks/install.d.mts` can silently drift from
  `install.mjs`** — architecture-dx — stale types pass tsc; mismatch surfaces
  at runtime. *Fix:* generate the declaration in CI and diff, or assert export
  shapes in a test.
- **L-22. Package boundaries are convention-only — no lint-level
  dependency-direction enforcement** — architecture-dx · `eslint.config.mjs` —
  a value import in `dto.ts` or an upward import in core stays green. *Fix:*
  `no-restricted-imports` overrides + `consistent-type-imports`.
- **L-23. PROJECT-STATE's 2026-07-30 update box cites stale test/coverage
  numbers** — architecture-dx · `docs/analysis/PROJECT-STATE-2026-07-06.md` —
  the designated entry point says 879/>90% where the tree has 1318/100%.
  *Fix:* one-line touch deferring to DONE.md or refreshed counts.
- **L-24. Timing-safety of the token compare is asserted only functionally** —
  tests-quality · `hook-receiver.negative.test.ts:227` — a refactor to `===`
  passes every test. *Fix:* static assertion that the source contains
  `timingSafeEqual(` and `createHash(`.
- **L-25. Placeholder suites assert only a package-name constant** —
  tests-quality · `packages/core/test/placeholder.test.ts:6` — a green run on
  placeholders alone would still read as "tests passed". *Fix:* delete or fold
  into a real suite.
- **L-26. The bench never measures ingest/API contention — the primary UX risk
  stays unmeasured** — performance-roadmap · `bench/corpus-scale.ts:562` — no
  API request is ever issued while a tick executes; no event-loop-delay metric.
  *Fix:* add a `monitorEventLoopDelay` phase and a concurrent-inject phase;
  keep all numbers PROVISIONAL as the harness insists.

---

## Prioritized improvement plan

### Bucket 1 — quick wins (each under a day)

| # | What | Why now | Size |
|---|------|---------|------|
| 1 | **Migration 11**: rewrite `model_pricing` seed (keys + `effective_from`) and add a migration content checksum to `schema_version` (H-1) | CONFIRMED; the operator's live DB is sunk under HEAD today | S–M |
| 2 | Wire `onWarning` → structured log/SSE; `filesSkipped` in replay/tick summaries; skip counter on `/api/health` (H-2, enables M-14's reporting) | Restores the entire skip-diagnostics design the composed server currently discards | S |
| 3 | Reload pricing per watcher tick + reset attempts on pricing-table change (M-2) | CONFIRMED split-brain; the fix is microseconds per tick | S |
| 4 | Shared SSE event-type list + contract test + subscribe/render `ingest-failed`; update api.md (M-6) | CONFIRMED silent-failure mode; drift already shipped once | S |
| 5 | Root-scope error handler for hook routes (M-7) | CONFIRMED contract escape; a few lines | S |
| 6 | `restoreDatabase`: remove/refuse stale `-wal`/`-shm` before copy (M-4) | CONFIRMED disaster-path defect | S |
| 7 | Restrict `getGlobalDag` usage rollup to selected agents + edge indexes (M-5) | CONFIRMED; measured 432 ms → the only unfixed endpoint from that bench run | S |
| 8 | Schedule daily `backupDatabase` in `start()` (M-20) | Makes "SQLite in WAL mode with backups" an operating fact; no owner decision needed | S |
| 9 | LiveView clock interval (M-10); Retry buttons + refetch-on-ingest (L-16); health-chip re-probe (L-18) | CONFIRMED honesty defect on the recency view + cheap UX polish | S |
| 10 | SQL-vs-TS rate-resolver reconciliation test (M-21) | Guards the two authoritative dollar paths against divergence | S |
| 11 | CI web build step (M-22, CI half) | Catches a whole defect class before the KC-4 hard date | S |
| 12 | Coverage-pragma guard in core/shared/test-fixtures (M-23) | Protects the no-silent-$0 code's coverage denominator | S |
| 13 | Doc/consistency touches: prune.ts residue note (M-3 doc half), retention-queries header (L-11), PROJECT-STATE counts (L-23), README quickstart (L-20), drop `d3` (L-17), meta-classification tightening (L-5), sessionId cross-check (L-4) | All small, all reduce the honest-docs debt this project trades on | S |

### Bucket 2 — pre-v1.0, sequenced against KC-2 (2026-09-14) and the 2026-12-01 hard date

**Before KC-2 (performance and measurement, so numbers exist with runway):**

| # | What | Why now | Size |
|---|------|---------|------|
| 1 | Byte-offset tail-read for changed sessions (+ optional worker-thread parse); tick-duration metric on health (M-15) | Highest-leverage perf fix; the live-watch path is the core use case | M–L |
| 2 | Listen-before-replay with a "replaying" status and progress output (M-16) | Removes the minutes-long boot blackout at real corpus scale | M |
| 3 | Direct-ref lookup for cost-analysis (skip corpus enumeration) (M-18) | Removes a per-click whole-server freeze; pairs with #1 | S–M |
| 4 | Incremental (session, model, day) rollup or cached summary for `getCostSummary` (M-19) | The read grows with corpus age forever otherwise | M |
| 5 | Bench: event-loop-delay + concurrent-inject contention phases (L-26); then run the `<30 s` stopwatch measurement in **September** (M-25c) | Findings need two months of fix runway before 2026-12-01 | S–M |
| 6 | Fingerprint shortlist (`fs.watch` or mtime cut) **if** the contention numbers demand it (M-17) | Decide from measurement, not speculation; 3 s interval is PROVISIONAL | M |

**Owner-only acts — put in front of Ivan immediately (KC-3 is 2026-10-12):**

| # | What | Why now | Size |
|---|------|---------|------|
| 7 | Branch-protection click making the three P0 proofs merge-blocking (M-25a) | KC-3's stay-alive clause fails on this alone; agents cannot do it | 10 min (owner) |
| 8 | Start LABEL-ME: hand-label ≥52 claims from the spike corpus (M-24, M-25b) | The ≥95% hierarchy bar is unsignable and every number stays PROVISIONAL until this exists | M (owner) |

**Product/correctness before the KC-4 exit gate:**

| # | What | Why now | Size |
|---|------|---------|------|
| 9 | Q2 top-burners table + Q4 today/this-week KPIs + cost-analysis entry from SessionsView; aggregate-savings endpoint (M-8, M-9) | Two of the five daily questions are currently unanswerable as specified; the RELEASE.md [HUMAN] box will fail | M |
| 10 | Gate #7: defensive legacy fallback **or** owner-signed waiver in parser-spec §3 (M-1) | The 14/14 claim currently overstates; old-corpus ingest silently loses edges | S–M |
| 11 | Cross-session message.id ownership rule + resumed-session fixture (M-12) | Settle the rule while it is cheap; the trigger is external CLI behavior that may return | M |
| 12 | SubagentStop reconciliation on agent-row creation (M-13); duplicate-session detection at enumeration (M-14) | Systematic status inaccuracy for the most numerous agent class; a footgun loop | S–M each |
| 13 | Hook token out of argv (curl config file) or an honest threat-model amendment (M-11) | The threat model currently claims a mitigation the process table undermines | S |
| 14 | Retention/checkpoint interplay decision at OPEN-1 ratification (M-3) | The journal's reconciliation semantics are wrong in both directions until decided | S (decision) + S (code) |
| 15 | Production topology decision for the SPA: server serves `dist/` or two-process declared supported (M-22, topology half) | RELEASE.md cannot honestly describe a deployable artifact without it | S–M |

### Bucket 3 — later / v2 territory (alerts land only via KC-5)

- SSE backpressure/conn caps and Last-Event-ID replay keyed to
  `events_raw.seq` (L-3, L-14 — both known/parked; ADR-CD-5 open item).
- `is_compaction_baseline`: wire it during projection (would also let
  cost-analysis survive transcript retention) or drop it (L-7).
- Fingerprint `ctimeMs` + checkpoint/ref key unification (L-9, L-10).
- Boundary-enforcing lint rules; generated `install.d.mts` (L-21, L-22).
- Static timing-safety assertion; delete placeholder suites (L-24, L-25).
- Auth-gate uniformity for unmatched paths; spawner-gate pattern extensions
  (L-1, L-2).
- Un-coalesced refetch debounce; unbounded-tree cap decision (L-13, L-15).
- Savings-clamp disclosure note (L-8); `getSessionEvents` composite index
  (L-12); IPv6 check fix (L-19).
- Anything alerting-shaped stays out until KC-5 is **earned by real daily
  use** — nothing in this review changes that.

---

## Review coverage

**Dimensions run (10):** security, parser-core, cost-engine, ingest-watcher,
data-layer, api-realtime, web-frontend, architecture-dx, tests-quality,
performance-roadmap.

**Findings kept per dimension:** security 4 · parser-core 4 · cost-engine 5 ·
ingest-watcher 7 · data-layer 7 · api-realtime 5 · web-frontend 7 ·
architecture-dx 7 · tests-quality 5 · performance-roadmap 10 — **61 raw**,
merged to **53 entries** in this report (8 cross-dimension duplicates folded,
noted inline). After dedup: **2 high, 25 medium, 26 low**.

**Verification stats:** the adversarial verification pass was budget-capped at
14 findings. Of those 14: **11 CONFIRMED**, **1 remained PLAUSIBLE** after
inspection (M-12 — mechanism fully real in code; the triggering substrate
behavior was absent from this machine's entire corpus, so code alone cannot
settle it), and **2 were REFUTED** and removed before synthesis. **18 further
findings** were queued past the cap and ship as PLAUSIBLE — credible from code
reading, not adversarially verified. All low-severity findings are
UNVERIFIED-LOW by policy.

**What this review did NOT cover:**

- **No dynamic testing.** No fuzzing, no penetration testing, no load testing
  against a running server; all performance findings above the bench's own
  numbers are code-derived projections and remain PROVISIONAL.
- **No re-execution of the test suite or benchmarks** — coverage/test counts
  are taken from the repo's own records at `2f8d103`.
- **No review of the design corpus itself** (docs/analysis, DESIGN.md) beyond
  checking implementation claims against it — the design freeze stands and
  this is not analysis #10.
- **No verification of the owner's parked LOW/INFO security list contents** —
  two low findings note possible overlap with it that could not be confirmed
  in-repo.
- **External behaviors** (Claude Code CLI resume/fork substrate shapes, real
  pre-2.1.71 transcripts) were checked only against this machine's corpus;
  M-1 and M-12 depend on substrates not present locally.
- **Dependency supply-chain audit** limited to what the dimensions surfaced
  (the dead `d3` dependency); no full SBOM/CVE pass.
- The hierarchy-accuracy claim (≥95%) is **unmeasured by anyone**, including
  this review — the human annotation corpus is empty (M-24).
