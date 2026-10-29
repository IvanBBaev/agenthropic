# agenthropic — Senior Data Engineer / FinOps review (2026-10-29)

> Part of the [role reviews of 2026-10-29](README.md) — lens: **Senior Data Engineer / FinOps (DAT)**. Independent senior reviewer, read-only, on `main` at `db3f042`. Findings are de-duplicated and scheduled in [10-synthesis.md](10-synthesis.md).

Review was read-only. I modified no files. JSONL in `~/.claude/projects` was read only for structural facts; no prompt content is reproduced here.

## 1. Verdict and readiness score: 6.5 / 10

**The ledger itself is sound.** The storage-level dedup, the per-bucket-max reconciliation of streamed partials, canonical timestamps enforced by triggers, the dated pricing table guarded by checksums, the rollup keyed by `rate_effective_from`, the online backup and the append-only raw events are well above what a typical hobby observability tool has. The real corpus is clean today:

- 2,715 files, 5.5 GB.
- 0 malformed JSON lines, 0 torn trailing lines.
- 0 usage records without a `message.id`.
- 0 `message.id` values shared across sessions, out of 203,419 distinct ids.

**Ingest is where the risk sits, at three points:**

1. **The pricing halt gate is coupled to the DAG.** One unpriced model drops the whole session: agents, edges and tokens.
2. **The 64 MiB per-file cap is not configurable.** It now excludes the five largest main transcripts, which are by construction the most expensive sessions.
3. **Pricing can only be fixed with a code migration.** This has already gone reactive four times (m18, m19, m20, m24).

At least one of these is live right now. `claude-haiku-5-5` appears in the corpus (16 records in one transcript) and is deliberately unseeded, so that session halts. Meanwhile the migration comment that justifies leaving it unseeded says it "does not occur in the corpus".

None of this is a data-corruption risk. All of it is a completeness and trust risk for the headline number the product exists to show. The fixes are mostly small to medium in effort and fit before 2026-12-01.

## 2. What is strong

- **Dedup is in the storage engine.** `token_usage UNIQUE(message_id, bucket)` with upsert-MAX, and `INSERT OR IGNORE` on `orchestration_edges` (`apps/server/src/db/edges.ts:33`). Re-ingest is idempotent by construction, not by convention.
- **Streamed partials are reconciled correctly** (`packages/core/src/usage/dedupe.ts`):
  - per-bucket max for input, output and cache-read;
  - the 5m/1h cache-write pair is taken atomically from the larger partial;
  - an agentId mismatch or a model tie raises a hard `UsageConflictError` instead of guessing.
- **Pricing is dated** (`model_pricing(model, bucket, usd_per_mtok, effective_from)`) and enters only through checksummed migrations. The rollup PK includes `rate_effective_from`, so re-pricing history is possible without rewriting facts.
- **The halt gate never prices at $0** (`packages/core/src/cost/compute-cost.ts:102,113`). It refuses loudly. The intent is right; only the blast radius is wrong (DAT-2).
- **`getCostSummary` reads from the trigger-maintained rollup** (m16, WITHOUT ROWID). This closes impl-review M-19, which measured 15.6 s at 11x scale.
- **Tail cache:** O(new bytes) reads, a 4 KiB overlap check that detects rewrites and truncation, and a torn last line trimmed in `disk-substrate.ts:325–336`.
- **Watcher:** retry budget, quarantine, and a quarantine reset when pricing changes. A newly seeded rate self-heals halted sessions.
- **Retention is sensible:**
  - `token_usage` is never pruned, so the ledger is permanent;
  - `events_raw` is append-only;
  - events are pruned after 90 days;
  - backups are kept 30 days with a floor of 7.
- **Backup and restore:** backup uses the online `db.backup()`. Restore goes through a staging copy, runs `integrity_check`, then does an atomic rename.
- **Honest disclosure.** Partial sessions and the NN1/NN2 limits are documented in `docs/site/architecture/cost-model.md:133–149`. Measured edge coverage is 1855/1855.

## 3. Findings

| ID | Sev | Finding | Evidence | Recommendation | Effort | Status |
|---|---|---|---|---|---|---|
| DAT-1 | P1 | `claude-haiku-5-5` occurs in the live corpus (16 assistant records, 1 transcript) but is unseeded, so that session halts. The m24 comment claiming it "does not occur in the corpus" is now false. The owner's "stays unseeded" decision (commit db3f042) rested on that premise. | `apps/server/src/db/migrations.ts:1512–1515`; corpus survey | Re-decide with the fact in hand. Either (a) seed it at the ≤100k tier and flag tier-2 tokens as unpriced, or (b) keep it unseeded but stop dropping the session (see DAT-2). Correct the comment either way. | S | CONFIRMED |
| DAT-2 | P1 | The halt gate runs before normalize/project. A `PricingError` drops the whole session: no session row, no agents, no edges and no tokens. The DAG, which is the product's moat, is held hostage by the pricing table. The read side already handles NULL rates as "unpriced". | `apps/server/src/ingest/ingest-session.ts:110–119`; `apps/server/src/api/queries.ts:45–77` | Always project agents, edges and tokens. Persist an unpriced tokens figure and a `pricing_status` on the session. Keep the gate as a loud UI and API banner and a metric, not as a write barrier. Quarantine should stay for substrate errors only. | M | CONFIRMED |
| DAT-3 | P1 | The 64 MiB per-file cap is hard-coded. The corpus now has 5 main transcripts over 64 MiB (largest about 170 MB and 166 MB), and all of them are ingested as partial lower bounds. The bias is systematic: the biggest sessions are the costliest. | `apps/server/src/corpus/fs-port.ts:206` (`DEFAULT_MAX_FILE_BYTES`); no matching env var in `config.ts` | Short term, make the cap configurable. Medium term, use streaming line-by-line parse and dedup so memory is bounded by the open message window, not the file size. | S / L | CONFIRMED |
| DAT-4 | P1 | Pricing can only be changed by shipping a migration. `upsertPricingRate` has no caller outside migrations. That makes four reactive migrations so far; before m18/m19, 52/60 and 27/61 sessions were halted. | `apps/server/src/db/pricing.ts:133`; m18–m20 and m24 | Add an operator path, either a CLI (`agenthropic pricing add …`) or an authenticated, loopback-only admin endpoint, writing dated rows plus an audit row. Keep migrations for the seed only. | M | CONFIRMED |
| DAT-5 | P2 | The docs disagree on whether a partial session is marked. `running.md` says "nothing on the session marks the gap". `cost-model.md` says partial is disclosed. | `docs/site/guide/running.md:462`; `docs/site/architecture/cost-model.md:133–149` | Verify against code and fix whichever is wrong. A partial session must carry a visible flag in the API and UI. | S | CONFIRMED (drift) |
| DAT-6 | P2 | On every change to a live session, the whole session string is re-parsed and re-deduped. Reads are O(new bytes), but parse is O(session). On a 150 MB session that means repeated full-JSON work per poll tick. | `apps/server/src/corpus/tail-cache.ts` (returns full content); `parse-session.ts` | Use incremental parse state per file (byte offset plus open-message dedup window), or at least debounce live re-parse by size. | L | CONFIRMED |
| DAT-7 | P2 | One malformed JSON line, or a transcript where no record has a timestamp, throws `SubstrateError` and fails the whole session. The corpus has 0 such lines today, but this is the main format-drift failure mode. | `packages/core/src/parser/parse-session.ts:176` (`JSON.parse` in the loop), `transcriptTimespan` | Skip and count unparseable lines (`skipped_lines` metric). Fail only on structural contradictions. Fall back to the file mtime for the timespan, with a flag. | S | CONFIRMED |
| DAT-8 | P2 | The usage fields actually present are not modelled. `mapUsageBuckets` reads only the four token counters and the `cache_creation` split, and ignores the fields listed below. Today the effect on cost is nil, because every observed value is standard or zero. That makes this a silent mispricing trap, not a halt. | `parse-session.ts` `mapUsageBuckets` (~l.833); survey | Persist `service_tier`, `speed` and `inference_geo` per message. Halt or flag when a non-standard value appears (cheap). Model web-search requests as a sixth, per-request bucket when first seen. | M | CONFIRMED (ignored) / PLAUSIBLE (cost impact) |
| DAT-9 | P2 | The dedupe deliberately settles a transient fast-mode label onto the standard model id. If fast mode is actually billed at a premium, that cost is under-reported with no signal. | `packages/core/src/usage/dedupe.ts` (model-settling comment) | Record `speed` as a dimension. Price fast mode explicitly or flag it as unpriced. | S | PLAUSIBLE |
| DAT-10 | P2 | 520 `cost-state` records exist in the corpus and are never used. They are a free external reconciliation signal against the computed cost. | survey; parser ignores the record type | Add a reconciliation report: computed vs `cost-state` per session, with a tolerance band. Use it as the drift alarm for pricing. | M | PLAUSIBLE (shape not fully probed) |
| DAT-11 | P3 | There is no drift census. Unknown record types (27 observed; many are unhandled, e.g. `api-request*`, `atis-latch`, `bridge-session`, `pr-link`, `tools-used`) and unknown usage keys pass silently. `claudeCodeVersions` is parsed but not persisted. | `parse-session.ts` (output field unused); survey | Persist the CC version per session plus a per-ingest census of unknown types and keys, exposed as a metric or health panel. This makes format drift visible on day one, not after a bug. | S | CONFIRMED |
| DAT-12 | P3 | Dollars are summed as floats: in JS, `totalUsd += tokens*rate/1e6` (`compute-cost.ts:122`); in SQL, as a REAL `SUM`. The gate and the dashboard sum in different orders and can differ in the last cents over long horizons. | `compute-cost.ts:122`; `queries.ts:91` | Store rates as integer micro-dollars per Mtok (or per-token nano-dollars), aggregate as integers, and format at the edge. Or define a documented rounding rule and a test that gate and API match. | M | CONFIRMED (mechanism) |
| DAT-13 | P3 | The `pricedCte` resolves the rate with a correlated subquery per `token_usage` row. That is fine per session, but O(rows × log) on any cross-session non-rollup query. At 1–2 years the table holds roughly 1M messages × 5 = 5M rows. | `apps/server/src/api/queries.ts:45–77` | Keep all aggregate paths on the rollup. Add a covering index `model_pricing(model, bucket, effective_from DESC)` if not present. | S | PLAUSIBLE |
| DAT-14 | P3 | Five rows are written per message, including zero-token buckets. In the corpus, `cache_write_1h` and `cache_write_5m` are often 0, so roughly 30–40% of rows are likely zeros. | `apps/server/src/db/token-usage.ts` | Skip zero buckets on insert, with readers treating a missing row as 0. Or accept the cost and document it. | S | PLAUSIBLE |
| DAT-15 | P3 | Cross-session ownership of a `message_id` is first-writer-wins, so attribution depends on order. Zero collisions are observed today; resumed or forked sessions (`fork-context-ref` records exist) could create them. | `token-usage.ts` (M-12 rule) | Use a deterministic rule (earliest timestamp, or the main transcript before a fork) and keep the collision metric. | S | CONFIRMED (rule) / PLAUSIBLE (impact) |
| DAT-16 | P3 | Only `journal_mode` and `foreign_keys` are set. `synchronous`, `busy_timeout` and the checkpoint policy are left at defaults. Restore does not check `schema_version` against the running binary's migrations. | `apps/server/src/db/connection.ts:23–24`; `apps/server/src/db/backup.ts` | Set `synchronous=NORMAL` (safe with WAL) and `busy_timeout=5000`, and run a periodic `wal_checkpoint(TRUNCATE)`. Refuse to restore a backup with a newer schema; migrate an older one forward. | S | CONFIRMED |
| DAT-17 | P3 | Stale figures in `parser-spec.md`: "≈ $345.91 over 206M tokens / 3,339 messages", and the cold-replay band of 34.87–39.92 s measured on a 1.6 GiB corpus. The corpus is now 5.5 GB, so cold replay likely scales to about 2 minutes or more. | `docs/analysis/parser-spec.md`; `docs/measurement/cold-replay-2026-09.md` | Re-measure on the current corpus before v1.0 and mark the old numbers as historical. | S | CONFIRMED |

DAT-8 detail: the fields `mapUsageBuckets` ignores, with how often each appears.

| Field | Records with it (of 395,947) | Observed values |
|---|---|---|
| `server_tool_use` | 240,401 | all zero |
| `service_tier` | 395,947 | `standard`, except 547 null |
| `speed` | 266,948 | always `standard` |
| `inference_geo` | 395,947 | not probed |
| `iterations` | 240,401 | not probed |
| `output_tokens_details` | 222,681 | not probed |
| `fallback_credit` | 168,198 | not probed |

## 4. Format-drift and pricing risk register

| Risk | Likelihood | Current behaviour | Impact | Mitigation |
|---|---|---|---|---|
| A new model id ships (this happens every few months) | High (4 times so far) | Session halts; DAG is lost until a migration ships | Dashboard blind to new work | DAT-2 + DAT-4 |
| Tiered pricing (haiku-5-5 over 100k; long-context premiums) | Medium–High | No tier dimension; unseeded model halts | Halts, or underprices if seeded naively | Add a `tier` column to `model_pricing` with a threshold (prompt tokens = input + cache read + cache write) |
| Fast mode / `speed` premium | Medium | Settled to the standard model; `speed` is ignored | Silent under-report | DAT-9 |
| Server-tool billing (web search per request) | Medium | Ignored (all zero today) | Silent under-report | DAT-8, a per-request bucket |
| Geo / data-residency multiplier | Low–Medium | `inference_geo` is ignored | Silent under-report | Persist it and flag non-default values |
| Batch / priority `service_tier` | Low (CLI) | Ignored | Silent mispricing | Halt on a tier other than standard |
| `iterations[]` semantics change (sum vs top-level) | Low | Ignored; one record has 2 iterations | Possible double or under count | Assert top-level = Σ iterations in a census check |
| New record types (27 today) | High | Silently ignored | Fine for cost; NN1/NN2 edges could be missed | DAT-11 census |
| A malformed line or one without timestamps | Low (0 today) | Whole session fails | Session lost | DAT-7 |
| Transcript grows past 64 MiB | Already happening (5 files) | Partial lower bound | Biggest spenders under-counted | DAT-3 |
| A rate changes mid-life | Medium | Dated rows handle it via a migration | Needs a release | DAT-4 |
| `<synthetic>` model (547 records) | Present | Assumed handled as zero or excluded; verify | None if all zero | Test fixture |

## 5. Recommendations by horizon

**Before v1.0 (by 2026-12-01)**
- DAT-2: decouple projection from pricing, and add the unpriced banner. This is the single highest-value change.
- DAT-1: decide on haiku-5-5 with the corrected fact; fix the m24 comment.
- DAT-3: make the cap configurable (S) and raise the default to about 256 MiB. Fix the partial-flag doc drift (DAT-5).
- DAT-4: a minimal operator pricing CLI.
- DAT-7: skip-and-count bad lines.
- DAT-11: persist the CC version plus an unknown-type/key census.
- DAT-16: pragmas and the restore schema check.
- DAT-17: re-measure cold replay on the 5.5 GB corpus.

**v1.x**
- DAT-8 and DAT-9: persist the tier, speed and geo dimensions, and a server-tool bucket.
- DAT-10: cost-state reconciliation.
- Tiered pricing column.
- DAT-12: integer money.
- DAT-13: index or covering review with a 5M-row synthetic benchmark.
- DAT-15: deterministic ownership.

**v2.0**
- DAT-6: streaming, incremental parse with bounded memory, which also retires the cap.
- Cost alerts (KC-5) only after DAT-10 reconciliation exists, so alerts fire on trusted numbers.

**Never**
- Pricing at $0 or inferring tokens: keep the ground-truth invariant.
- Pruning `token_usage`.
- Moving pricing to a remote fetch (breaks local-first and auditability).
- DAT-14: optional, only if storage actually becomes a problem.

## 6. Questions for the owner

1. The "haiku-5-5 stays unseeded" decision (db3f042) rested on "does not occur in the corpus", which is no longer true. Seed it at tier 1 and flag tier 2, or keep it halting?
2. Is it acceptable for a pricing gap to hide agents and the subagent DAG? I recommend "no": project everything and mark the cost unpriced. Is that consistent with your reading of the halt-gate intent?
3. Should the 64 MiB cap be raised by default, or kept as is with an env override? What memory budget does the Mac Mini have for the server process?
4. Is an operator pricing path (CLI or loopback admin endpoint) acceptable under the security model, or must pricing stay migration-only for auditability?
5. Should `cost-state` records be treated as an authoritative reconciliation source, or only as an advisory check?
6. Is fast mode or web search in your actual usage plans? That decides whether DAT-8 and DAT-9 belong before v1.0 or in v1.x.

Note: a second background probe (task `bsj1jg6ar`: haiku-5-5 depth and tier, the `iterations` shape, `inference_geo` and the `cost-state` shape) had produced no output when the report was written. Rows marked PLAUSIBLE can be confirmed from that output: `/private/tmp/claude-501/-Users-ivanbaev-Development-agenthropic/41c2974a-1add-44d0-af20-59e58532fd33/tasks/bsj1jg6ar.output`.
