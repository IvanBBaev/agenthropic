# agenthropic: architecture review (2026-10-29, read-only, HEAD `db3f042`)

> Part of the [role reviews of 2026-10-29](README.md) — lens: **Senior Software Architect (ARC)**. Independent senior reviewer, read-only, on `main` at `db3f042`. Findings are de-duplicated and scheduled in [10-synthesis.md](10-synthesis.md).

## 1. Verdict

The architecture is sound for a single-user, loopback-only tool, and most of what the docs claim is true in the code. `packages/core` is pure: it imports only `@agenthropic/shared`, with no node, sqlite or fastify imports. Dependency direction is clean: web → shared (type-only), server → core → shared. Ingest is idempotent, and the alerting core is properly isolated behind a config flag. The main risks are not in the layering. They come from **operational coupling**:

- **Pricing gates ingest.** A model id with no price row stops the whole session from being stored, its DAG included.
- **Migration integrity depends on the transpiler.** The checksum is taken over `up.toString()` as tsx produces it.
- **The JSONL corpus only covers a rolling window.** For older sessions the DB is the only copy, so "replay from source" does not reach them.

None of these blocks a personal v1.0 tag. The first two have already caused real incidents (pricing) or are one `pnpm up` away from one (checksums).

**Readiness for v1.0 from the architecture lens: 7.5 / 10.**

## 2. What is strong (with evidence)

- **Core purity is real.** `packages/core/package.json` depends only on `@agenthropic/shared`. A grep for `node:`/`better-sqlite3`/`fastify` in `packages/core/src` finds nothing. The halt gate (`computeCostUsd`) and the parser are pure and fully testable from fixtures.
- **Clean write path.** The pipeline is `parseSession → computeCostUsd (gate, before any write) → normalizeSession (pure) → projectSession (one txn)` (`apps/server/src/ingest/ingest-session.ts:1-25, 100-140`). `ingestSession` never throws, and re-running it is idempotent (upserts plus INSERT OR IGNORE).
- **Storage-level invariants.**
  - `events_raw` is append-only, enforced by triggers (`migrations.ts:88-93`).
  - `parent_agent_id ... ON DELETE SET NULL` is a self-referential foreign key (`migrations.ts:152`).
  - Retention cannot reach the substrate or the DAG (`retention/prune.ts:16-22`, `RETENTION_PROTECTED_TABLES`).
- **Prior review M-19 is fixed properly.** `getCostSummary` now reads a trigger-maintained `token_usage_rollup` (migration 16, `migrations.ts:786-1070`; cutover at `api/queries.ts:866`). Price changes rebuild the affected rollup slice idempotently.
- **M-16 is now mitigated, not only "closed but incomplete".** Startup replay runs in chunks of `REPLAY_MAX_SESSIONS_PER_PASS = 25` (`corpus-watcher.ts:153`) with a `setImmediate` yield before each pass (`index.ts:262-297`). A health probe during replay now waits at most one chunk instead of the whole replay.
- **Alerting (v2) is decoupled.**
  - It is built only when `DASHBOARD_ALERTS_CONFIG` is set (`alerts/index.ts:1-15`, `index.ts:1028-1044`).
  - It reads the projection by polling: no hooks into ingest, and v1 code has no import of alerts except the composition root.
  - Each alert subject fires at most once (UNIQUE dedupe key, `rules-engine.ts:11-15`), and each delivery is recorded in a `webhook_deliveries` table.
  - Delivery uses `fetch` to a constant host (`telegram-sink.ts:97`), so there is no spawner.
- **Realtime design is coherent.** SSE carries invalidation frames with a 256-frame `Last-Event-ID` replay ring (`realtime/hub.ts`). `/api/changes` is a cursor (`ingest_seq`) delta feed computed in one read transaction (`queries.ts:1812-1825`). The same-origin check runs before auth on the routed path (`server.ts:284-303`).
- **The docs are honest about the as-built shape.** ADR CD-6 openly records that only 5 of 10 ports were built (`adr-cd-6-ports-and-adapters.md`). The same goes for the D18(a) note that there will be no `PricingProvider` interface. This is pure-core plus a few real seams, not textbook hexagonal, and the docs say so.
- **The configuration surface is small:** about 15 `DASHBOARD_*` variables, and `HOST` is a constant (`config.ts:22`).

## 3. Findings

| ID | Sev | Finding | Evidence | Recommendation | Effort | Verdict |
|---|---|---|---|---|---|---|
| ARC-1 | **P1** | **The pricing gate holds the moat hostage.** An unknown model id makes `computeCostUsd` throw before any write. The whole session is then refused, including agents, DAG edges and token rows, and is quarantined after 3 attempts. Prices can only be changed by shipping a new schema migration; `upsertPricingRate` has no production caller outside migrations. This has hit the real corpus three times: migration 18 (52/60 sessions refused), migration 19 (27/61 refused) and migration 24 (1119 records unpriced). Dollars are already computed **at read time** from stored tokens and there are no stored dollars, so refusing at write time protects nothing the read path couldn't disclose. | `ingest/ingest-session.ts:106-109`; `corpus-watcher.ts:124`; `migrations.ts:1104-1160` (mig 18 rationale); `docs/site/architecture/cost-model.md:296-317`; `api/routes.ts:478-503` | Split the gate. Always persist tokens and the DAG, and mark unpriced (model, bucket) pairs. Make the "no silent $0" rule a **read-side** refusal (the API already has `skippedSessions` / unpriced disclosure). Separately, add an operator-side price path (a pricing file merged at boot, or a CLI using `upsertPricingRate`) so a new model doesn't need a release. | M | CONFIRMED |
| ARC-2 | **P1** | **Migration checksums hash transpiler output.** `migrationChecksum` hashes `normalise(migration.up.toString())`, which is esbuild/tsx output, not the bytes on disk. vitest and tsx already disagree on migrations 7, 11, 14, 15 and 16. `tsx` is a caret range (`^4.20.0`). CI never runs the tsx path: the steps are spawner gate, typecheck, lint, format, web build, vitest, licenses. A tsx/esbuild printer change would make **every existing user DB refuse to boot**, with a misleading error ("was edited after being applied"). | `db/migrations.ts:1608, 1876-1878, 1970-1976`; `apps/server/package.json:12, 31`; `.github/workflows/ci.yml:44-82`; `test/migrations-checksum-stability.test.ts:11-40` (tsx values measured by hand) | Before v1.0, at minimum: pin `tsx` to an exact version, and add a CI step that computes checksums under `tsx` and compares them to a committed table. Longer term, freeze today's tsx checksums as a committed `{id: checksum}` table of accepted values, and checksum future migrations over stable source text (SQL string constants or `.sql` files). | S (pin + CI) / M (redesign) | CONFIRMED |
| ARC-3 | **P1** | **"Replayable projection" is true only within Claude Code's transcript retention window.** The repo's own measurement saw main transcripts fall from 141 to 51 within weeks. Past that window the SQLite DB is the only record of the DAG and spend. Any future parser or projection fix can't be back-applied to aged-out sessions. `cleanupPeriodDays` is not mentioned anywhere in code or docs. `overview.md:154` still claims "replayable from `events_raw` alone", but the DAG is projected from JSONL, not `events_raw`. | `docs/analysis/impl-review-2026-08-09.md:291-334`; `docs/site/architecture/overview.md:154`; grep for `cleanupPeriodDays` returns nothing | Decide on one of: (a) an optional compressed, read-only archive of ingested transcripts under `data/`, or (b) document raising Claude Code's `cleanupPeriodDays` as an install step. Also treat restore-tested backups as part of the moat, and correct the overview claim. | M (a) / S (b) | CONFIRMED (gap); purge mechanism PLAUSIBLE |
| ARC-4 | P2 | **God modules, and history written into code.** `api/queries.ts` is 2003 lines (646 comment lines, 14 read models: sessions, tree, events, cost, global DAG, savings, changes). `db/migrations.ts` is 2005 lines (815 comment lines). The `index.ts` composition root is 1118 lines; `start()` alone is about 300, and the file also holds the skip reporter, backup scheduler, tick-trouble state machine and retention reporting. Comment density is 30-52%, much of it dated "AMENDED …" narrative that belongs in ADRs or git. | `wc` / grep counts; `index.ts:540-788`; `routes.ts:478-503` | v1.x: split `queries.ts` by read model (`sessions`, `cost`, `dag`, `changes`), and move ops policy out of `index.ts` into `ops/`. Keep the WHY comments and move the dated narrative into ADRs. Freeze `migrations.ts` and put new migrations in per-file modules. | M | CONFIRMED |
| ARC-5 | P2 | **Ingest-failure and quarantine state lives only in memory.** It is held in an in-process `Map`. After a restart the server forgets which sessions are parked. `/api/cost/summary` coverage therefore has to say "lower bound, can't tell which", and its own comment admits this. | `corpus-watcher.ts:422`; `api/routes.ts:478-503` | Persist an `ingest_failures(session_id, reason, attempts, last_committed_extent)` table. That makes coverage precise and survives restarts. | S-M | CONFIRMED |
| ARC-6 | P2 | **Format drift is detected late.** `claudeCodeVersions` is computed but "not persisted — no reader needs it yet". Unknown record types are silently ignored. One malformed interior line throws `SubstrateError` and loses the **whole** session. Torn tails are handled by `tail-cache.ts`. | `parse-session.ts:20-33, 1000-1012`; `parser-spec.md:89` | Persist the version set per session. Expose counters for unknown record types and fields on `/api/health`, so drift shows up before numbers go wrong. Consider skipping and disclosing malformed interior lines instead of failing the session (owner decision; the spec currently says "loud"). | S | CONFIRMED (code) / impact PLAUSIBLE |
| ARC-7 | P2 | **SSE ids have no boot epoch.** The hub counter restarts at 1 on every process start. A client that reconnects with an old `Last-Event-ID` gets no replay. The client treats a smaller id as "restart" and counts no gap. Frames published between the restart and the reconnect are lost. On reopen, Shell only re-probes `/health`; whether every view refetches its data was not verified. | `realtime/hub.ts` (`nextId = 1`); `web/src/sse.ts:293-315`; `web/src/Shell.tsx:560-570` | Send a `bootId` frame (or ids prefixed with an epoch) and refetch everything on a bootId change. | S | CONFIRMED (mechanism) / data-loss impact PLAUSIBLE |
| ARC-8 | P2 | **Downgrades pass silently.** `verify` skips applied migration rows the running build doesn't know about. An older build therefore boots against a newer schema and writes with old assumptions. | `db/migrations.ts:1955-1959` | Refuse to boot, or warn loudly, when `MAX(schema_version.id)` is greater than the build's highest known id. | S | CONFIRMED |
| ARC-9 | P3 | **Business logic lives in more than 20 SQL triggers.** They maintain the rollup (usage I/U/D, pricing I/U/D), canonicalise timestamps (BEFORE guard + AFTER rewrite pairs) and stamp `ingest_seq` on four tables. They are correct and tested, but each `token_usage` insert fires several triggers. A pricing insert rebuilds a whole (model, bucket) slice with no index, which was declined deliberately. Behaviour is hidden from the TS code paths. | `migrations.ts:554-602, 754-780, 988-1070, 1325-1405` | Keep, but add a trigger inventory to `data-model.md` and a per-row ingest cost bench line. | S | CONFIRMED |
| ARC-10 | P3 | **Web DTO guards have no parity test.** `web/src/dto-guards.ts` (608 lines) hand-mirrors the TypeBox schemas (a deliberate bundle-size choice), but nothing tests it against `@agenthropic/shared` schemas. | `web/src/dto-guards.ts:1-40`; `web/test/dto-guards*.ts` (fixture-based only) | Add a test-only parity check: `Value.Check(schema, x) === guard(x)` over fixtures and mutated payloads. TypeBox in tests does not reach the bundle. | S | CONFIRMED |
| ARC-11 | P3 | **Doc drift: alerts.** `overview.md:28, 119` and ADR CD-6 `:35` say the alert sink is "post-1.0 and unbuilt / no adapter". The code has `AlertSinkPort`, `telegram-sink.ts` and migration 23 `alerts-core`, shipped dark. The overview also names a concrete bot handle. | the listed doc lines vs `apps/server/src/alerts/*`, `packages/shared/src/ports/alert-sink.ts` | Add an as-built update ("built, dark by default"). | S | CONFIRMED |
| ARC-12 | P3 | **The `shared` barrel exports test fakes and node-only code.** It exports `InMemoryEventStore` / `InMemoryAlertSink` and `node:crypto` security helpers, in a package the browser consumes (type-only today). | `packages/shared/src/index.ts:3-5`; `shared/src/security/index.ts:13` | Add subpath exports `@agenthropic/shared/testing` and `/node`. | S | CONFIRMED |
| ARC-13 | P3 | **The production run path is "tsx from source".** Workspace packages export `./src/index.ts`, `tsx` is a devDependency, and the `start` script runs it. This is fine for a private checkout-run tool but blocks any packaged distribution. It is locked in because of ARC-2. | root `package.json` `"//"`; `apps/server/package.json:12-15` | Fixing ARC-2 removes the reason. Revisit only if distribution is ever wanted. | — | CONFIRMED |

**Status of prior-review items:**

| Item | Status | Evidence |
|---|---|---|
| H-1, H-2 | closed | — |
| M-19 | closed (rollup) | — |
| M-16 | substantially mitigated (chunked replay) | — |
| M-15, M-18 | closed (shared tail cache) | `index.ts:839-871` |
| M-24 (LABEL-ME) | still open, owner-only | — |
| M-3, M-17, M-21 offset-form residual | not re-verified by me | — |

## 4. Risks over the next 6 months

| Risk | Likelihood | Impact | Notes |
|---|---|---|---|
| A new Claude model id appears, sessions are refused, and the DAG and tokens are lost if the transcript ages out before a pricing migration ships | **High** (3 incidents in about 7 weeks; `claude-haiku-5-5` left unseeded on purpose) | High (moat data loss, not only $) | ARC-1 + ARC-3 compound |
| A tsx/esbuild bump (Renovate or a manual `pnpm up`) changes migration checksums and every existing DB refuses to boot | Medium | High (total lockout, misleading error) | ARC-2. Recovery means editing `schema_version` by hand. |
| Claude Code JSONL format drift (new record types, layout change) goes unnoticed until figures are wrong | Medium | Medium-High | ARC-6. The parser tolerates by ignoring, and there is no drift telemetry. |
| DB corruption or loss after transcripts aged out means unrecoverable history | Low-Medium | High | ARC-3. Daily backups exist (M-20). Restore is tested in code, but whether the owner has done a real restore drill was not verified. |
| Maintenance drag from 2k-line modules and narrative comments slows v1.x | High | Medium | ARC-4. Agent sessions spend context on history, not logic. |
| The dark alerting schema (migration 23) has to change in v2 and can't be edited | Medium | Low | Immutable migrations mean only forward-fixes. Acceptable. |

## 5. Recommendations mapped to the roadmap

**Before the v1.0 tag (≤ 2026-12-01), agent-doable and small:**
1. ARC-2 minimum: pin `tsx` exactly, and add a CI job that runs the checksum dump under `tsx` against a committed table.
2. ARC-8: refuse or warn on a schema newer than the build.
3. ARC-11: correct the alerts doc drift and the `overview.md:154` replay claim (part of ARC-3).
4. ARC-3(b): document `cleanupPeriodDays` in the install guide, plus a "restore drill" [HUMAN] box in `RELEASE.md`.
5. ARC-1, if the owner agrees: an operator pricing file loaded at boot (S-M). That alone removes "a release per model launch".

**v1.x:**
- ARC-1 full: write-always ingest with read-side unpriced disclosure.
- ARC-5: a persisted `ingest_failures` table.
- ARC-6: drift telemetry.
- ARC-7: an SSE `bootId`.
- ARC-4: split `queries.ts` and `index.ts`, and use per-file migrations from 25 onward.
- ARC-10: a guard/schema parity test.
- ARC-2 redesign: a frozen accepted-checksum table, with source-text hashing for new migrations.

**v2.0:**
- ARC-3(a): an optional transcript archive. This matters more once alerting history is in use.
- Revisit pricing tiers (Haiku 5.5 long-context tier): add a `tier` dimension only together with ARC-1, so a tiered model doesn't halt ingest.

**Never:**
- Build the unbuilt CD-6 ports (`StoragePort`, `PricingProvider` interface, `HookSource` strategy classes) without a second implementation.
- Replace SSE with WebSocket.
- Move ingest off the main thread before measured need. At about 141 sessions the chunked replay is adequate.

## 6. Questions for the owner

1. **ARC-1:** should a session with an unknown model still have its DAG and tokens stored, with its dollars shown as "unpriced"? This would replace refusing the whole session. It reverses the reading of "no silent $0" from write-time to read-time; the invariant itself is kept.
2. **ARC-1:** is a local operator pricing file (outside git, merged at boot) acceptable, or must every price stay a dated, checksummed migration (D13/D17)?
3. **ARC-2:** pin `tsx` and accept today's checksums as the frozen baseline, or keep the current "measured by hand at each append" practice?
4. **ARC-3:** should agenthropic archive raw transcripts (disk cost, about 1 GiB today), or is raising `cleanupPeriodDays` plus backups the accepted recovery story?
5. **ARC-6:** should a single malformed interior JSONL line keep failing the whole session ("loud"), or be skipped and disclosed?
6. Is a restore drill from a real daily backup a [HUMAN] box you want in `RELEASE.md` §6 for v1.0?
