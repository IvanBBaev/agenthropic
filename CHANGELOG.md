# Changelog

> Dates and content in this file are derived from the git history of `main`. The project targets v1.0 on 2026-12-01.

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- `GET /api/changes` reports what the corpus poll found since a given moment: each session is labelled `new`, `updated` or `unknown`, with a counter for each, so a client can tell "nothing changed" from "cannot tell" (`ChangesDto` in `packages/shared`).
- Failed agents are classified: migration 17 adds `agents.outcome_cause`, written from the transcript's terminal record with six causes (`concurrency_limit`, `user_interrupt`, `permission_failed`, `dispatch_unavailable`, `terminated_early`, `unclassified`); only `terminated_early` promotes an agent to `status: error`, a status that previously had no producer, and the cause travels on the session-tree and global-DAG wire as `outcomeCause`.
- The server serves the built dashboard from its own loopback port, so one origin carries both the API and the page; documented in the running guide.
- Hooks installer: entries are written with `async: true` and `timeout: 5` and call `curl --silent --show-error`; an existing entry is classified as ours, ambiguous or foreign, and an ambiguous one stops the installer without echoing the command it could not classify.
- Dashboard: an error boundary around every view, runtime guards on the DTOs a view renders, a snapshot-age stamp on the Sessions and DAG views that escalates aged provenance, a "Re-check server" button, and a stream-gap banner when the event stream's last event id shows that frames were missed.
- Cost view: the "Today (UTC)" tile distinguishes measured, not measured and lower bound (naming the UTC hour it was observed), the top-sessions table states in dollars what it covers and what it does not, the hub node's hover and prose carry both drawn sides and their gap when they disagree, and the sankey's text alternative lists its caveats first.
- Live view: a status frame dropped while the first snapshot was in flight triggers exactly one re-read of the snapshot once it lands, `lastActivityAt` never moves backwards, and per-session counts are capped at the served ceiling.
- Token screen: the token never appears in an error message, the three server verdicts (rejected, unreachable, malformed) are told apart, storage access is guarded, and an empty submit is handled.
- Tests: the five daily questions answered over HTTP in the P0 suite, dated pricing with two effective rates in the P0 harness, rollup equivalence, seed and trigger-order suites, migration checksum pins, and a static-site suite; the corpus benchmark takes `--records` and `--record-bytes` and no longer projects beyond what it measured.
- The connection chip counts consecutive failed reconnect attempts from the second one on:
  `○ reconnecting (attempt 2)`, or `○ connecting… (attempt 2)` for a stream that never opened.
  The count sits inside the label, so it reaches the polite live region; the SSE client exposes
  the ledger as `failedAttempts` and the state handler receives it as a second argument.
- The session tree lists each agent's observed outcome cause verbatim in an
  "observed agent outcomes" list beside the picture, for any agent whose `outcomeCause` is
  non-NULL whatever its status. NULL renders nothing, never "ok"; a value the client does not
  recognise renders as `unrecognised (<raw value>)` with the raw value kept.
- `GET /api/cost/summary` states the population its `topSessions` slice was cut from: two required
  fields, `sessionCount` (every session with usage in the rollup, priced or unpriced) and `hasMore`
  (`true` when the slice is shorter than that count), so a client can print "5 of 51 sessions"
  instead of hedging that five might be the whole corpus. The shared schema refuses the old shape.
- Measurement: `docs/measurement/cold-replay-2026-09.md` records five cold-replay runs at the real corpus's per-session shape (81.68–92.29 s at 61 sessions × 26.80 MiB; 61.65 s at the 2026-09-01 shape) with their command lines, a sizes-only census and the raw harness logs under `docs/measurement/runs/2026-09-09/`; the figures are marked unratified and the earlier synthetic band stays until the owner ticks BENCH-SHAPE.
- Migration 18 seeds explicit five-bucket rates for `claude-opus-5` and `claude-fable-5-1` at the seed's floor, copied from the platform pricing page (fetched 2026-09-10; PROVISIONAL like the rest of the seed). Fable 5.1's cache-read rate is 0.025× input, so the seed's 0.1× derivation was not reused; `model_pricing` now holds 35 rows for seven models, and the migration's upsert converges a hand-written row at the same instant instead of aborting.
- Retention is wired on the signed v1.0 policy: `events` rows older than `DASHBOARD_RETENTION_EVENTS_DAYS` (default 90) and backup files older than `DASHBOARD_RETENTION_BACKUP_DAYS` (default 30, never below the newest `DASHBOARD_RETENTION_BACKUP_KEEP_MIN`, default 7) are pruned by a runner chained after each successful daily backup; `0` disables a rule, `token_usage` is never pruned and a set `DASHBOARD_RETENTION_TOKEN_USAGE_DAYS` refuses to start; boot logs a dry run and deletes nothing.
- LABEL-ME labelling kit: `pnpm --filter @agenthropic/test-fixtures render-claims -- <template id>` renders one evidence page per hierarchy claim (both transcript records, the parser's own reading and the fields it matched) into a git-ignored `.render/` directory, read-only over the local `spike/` corpus, and exits 1 printing `substrate unavailable` (lowercase; the hierarchy gate's own line is the uppercase `SUBSTRATE UNAVAILABLE - not measured`) where that corpus is absent.
- Time-to-understand kit: `docs/measurement/time-to-understand-log.md` §0 holds a launch line proven to boot against the real corpus with a scratch database, a sizes-only session pre-selection and the observed boot figures; the gate stays UNSIGNED until the owner runs the protocol.
- Migration 19 seeds five-bucket rates for `claude-opus-5-5` (input 4, output 20, cache read 0.2,
  five-minute cache write 5, one-hour cache write 8 USD per MTok, effective 2026-01-01), copied
  from the platform pricing page on 2026-09-26 and PROVISIONAL like the rest of the seed. On the
  owner's corpus the schema-18 boot refused 27 of 61 sessions at the pricing halt gate, every one
  of them on this id; the schema-19 boot admits 61/61 with no `unknown model id` line
  (`docs/measurement/time-to-understand-log.md` §0.6–0.7). The gate itself is unchanged: the
  cure for an unknown id is a price row, never a relaxed check.

### Changed

- `/api/cost/summary` is served from the `token_usage_rollup` materialization rather than computed over `token_usage` on every request; an equivalence suite pins both paths to the same answer.
- `packages/shared` drops its unused `*Row` interfaces; `types/rows.ts` becomes `types/enums.ts` with named exports.
- `formatUsd` floors sub-cent amounts symmetrically on both signs and prints `cost unreadable` for a non-finite figure; `formatRelativeTime` tolerates 90 s of clock skew and names anything further ahead as `ahead of this clock` instead of `just now`.
- The spawner gate refuses symlinks, checks every manifest for forbidden direct dependencies and reports its denominators; the licence gate reports the `caniuse-lite` CC-BY-4.0 exception as not allowlisted rather than folding it into the allowlist.
- The realtime contract test asserts which schema arm accepted each event, not only that one did.
- The realtime event union is closed: `ingest-failed` has its own typed arm (`IngestFailedEventSchema`,
  `payload: { sessionId, reason, attempt ≥ 1, willRetry, occurredAt }`, no extra properties on
  either level) and the generic `{ type: string, payload }` catch-all arm is removed along with
  its `GenericRealtimeEvent` type. The bytes on the wire do not change; the SPA re-exports the
  new type and pins its hand-written narrowing to it, so the envelope can no longer drift
  silently.
- Documentation retires the `~137 s` startup projection (wrong by 3.4-3.9x against a measured run) and labels the 34.87-39.92 s replay band as synthetic: the benchmark corpus averages 7.04 MiB per session where the real one averages 26.19 MiB.
- Documentation re-synced with the code on 2026-09-18/19: the data-model page names eighteen
  migrations and ten built tables, every summary blurb carries the signed retention policy, the
  API page lists twelve routes with `/api/cost/delegation-savings`, `/api/changes`,
  `outcomeCause` on tree nodes and the optional `coverage` block on the cost summary, the
  governance open item is closed, stale counts are re-dated and `SECURITY.md` names 0.3.0. On
  the docs site, fifteen `.md` links whose text wrapped onto a second source line are joined
  onto one line (`jekyll-relative-links` 0.6.1 does not rewrite a wrapped link, so the live
  pages carried raw `.md` hrefs), thirty-five links from `docs/` to repo-root files
  (`README.md`, `CONTRIBUTING.md`, `TODO.md`, `DONE.md`, `RELEASE.md`, `SECURITY.md`,
  `CHANGELOG.md`, `LICENSE`) and two directory links point at GitHub instead of a Pages 404,
  and the Pages workflow pins `github.source` to `/docs` in the generated `_config.yml` so the
  Primer footer's "Improve this page" link carries the `docs/` segment on every page (before,
  all 82 edit links opened `edit/main/<page>` and 404ed); the pin is validated with a local build
  of the pinned github-pages 232 stack (Jekyll 3.10.0, jekyll-github-metadata 2.16.1), where all
  84 rendered pages carry `edit/main/docs/<page>`. The same build showed that Liquid swallowed the
  `{{DASHBOARD_TOKEN}}` curl template on the live hooks-installer, running and hooks pages, so
  the copyable hook command read `Authorization: Bearer ` with an empty value; the five spots are
  wrapped in `{% raw %}` tags hidden inside HTML comments (invisible on GitHub, honoured on Pages)
  and render the template verbatim. A third docs-truth sweep (four agents, every finding verified against the code) corrected the
  remaining drift: the security pages state that the auth gate covers `/api/*` with the SPA
  carve-out and that retention is signed and running (D3, 2026-09-08); the hook pages show the
  generated entries as built (`--silent --show-error --fail --max-time 3`, `timeout: 5`, `"async":
  true`), name the per-firing `deliveryId` in the idempotency key and withdraw the claim that a
  `Stop` body is byte-identical on every turn (amended 2026-09-02); the getting-started page no
  longer says the server hosts no UI or has no `start` script — `pnpm start` builds the SPA and the
  server serves it on the API's own origin, and `DASHBOARD_WEB_ROOT` (default `apps/web/dist`,
  resolved from the server module's own location) is documented on the configuration page as the
  eleventh variable; the route count is twelve (nine read endpoints), `GET /api/health` carries six
  optional fields, backup files expire at 30 days but never below the newest 7, CI runs on every
  push to `main` and on every pull request, the root package is publishable (`publishConfig.access:
  public`, no `private` flag) but never published, the migration count is eighteen, and the
  cost-model page states the attribution order (parser hard join for subagent rows, the writer
  resolving `null` to the session id for main-transcript rows, migration 8 back-filling only
  pre-resolution rows) and that migration 11 iterates the module-level seed constants folded into
  every migration's checksum.
  A fourth docs-truth sweep (five agents, 2026-09-22) corrected the architecture, usage, guide,
  contributing and ADR pages against the code: the as-built parent-resolution order and the
  five-valued `orchestration_edges.source` (migration 13), compaction boundaries read from
  `compactMetadata` rather than the `PreCompact` hook, a late `Stop` / `SubagentStop` hook
  reverting a watchdog `unknown`, migration 18 writing ten pricing rows, the six optional
  health fields wherever they are listed, the three-step `pnpm start`, eight typed fixtures,
  four P0 proofs, the seven CI commands in `RELEASE.md`, the signed retention policy wherever
  it was still called unset, the community files' commit and the four registered hooks in
  `governance.md`, and dated as-built addenda on seven ADRs.
  A fifth docs-truth sweep (six agents, 2026-09-23) re-verified the architecture glossary and
  overview, the security threat model and remote-access pages, the backup/restore run book,
  six ADRs, the hooks README, the analysis entry point, the parser spec and the docs plan
  against the code: eighteen migrations, the `enums.ts` home of `TokenBucket`, migration 18's
  ten explicit pricing rows, the signed retention values, the M-13 `SubagentStop` replay, the
  fourth P0 proof, the shipped Pages pipeline and the `guide/running` page are now stated
  where the pages had kept their 2026-07/08 reading.
  A sixth truth sweep (five agents, 2026-09-23) turned to code comments, fixture annotations
  and the time-to-understand protocol: 51 comment and annotation corrections across 40 files
  now state the per-turn `Stop`, the five edge sources, main-agent usage on the main node,
  the real `UsageConflictError` conditions, the signed retention policy that never prunes
  `token_usage`, the `Agent` (never `Task`) spawn blocks and the `/api/*` scope of the auth
  gate. No behaviour changed. A follow-up the same day settled nine of the sweep's open
  comment items (the `parse-session.ts` path numbering now follows `resolveParent`, the
  slug hint in `index.ts` is credited to review M-18, the hook sender is stated not to
  retry, the `Shell.tsx` notice says every `/api/*` route is gated).
- `scripts/time-to-understand.mjs` accepts the `[::1]` loopback (it read `host` split on
  `:`, which left `[`), pages through every session instead of the newest 200, and takes
  the fleet-scoped Q4 savings truth from `/api/cost/delegation-savings` rather than one
  session's cost analysis.
- Linting ignores `.claude/**`.
- Node is pinned to major 22: `.nvmrc` = `22`, `engines.node` tightened from `>=22` to
  `>=22 <23` with `engine-strict` in `.npmrc`, CI reads `.nvmrc`, and `pnpm test` / `pnpm start`
  run `scripts/check-node-version.mjs` first, which refuses any other major with a pointed
  message. Before, a v26 `node` first on PATH passed the install (pnpm checks `engines` against
  the Node that runs pnpm, not the one that runs the scripts) and then faked a whole-suite
  failure when the `better-sqlite3` binding refused to load.
  The guard was then wired wider than those two scripts: it also prefixes the root
  `gate:node`, `apps/server`'s `dev`, `start`, `bench` and `test`, `apps/web`'s `dev` and
  `test`, and the `test` script of `packages/shared`, `packages/core` and
  `packages/test-fixtures` - every entry point that loads the native binding, plus the root
  scripts. `typecheck`, `lint`, `format`, `format:check`, `hooks:install`, `apps/web build` and
  `render-claims` are deliberately left unguarded, and a direct `npx vitest` / `tsx`
  invocation bypasses the guard because it never goes through a package script.
- Ingest parses transcript timestamps strictly. The accepted grammar is `YYYY-MM-DDTHH:mm:ss[.fraction]` (1–9 fraction digits, truncated to milliseconds) followed by `Z` or `±hh:mm`. Anything else is rejected rather than coerced, including:
  - zone-less datetimes, which were read in the host's local time;
  - date-only values;
  - non-ISO spellings;
  - rolled-over dates such as `2026-02-30` or `T24:00`;
  - leap seconds (`:60`).
  A session carrying such a timestamp now fails ingest visibly and by name in the replay summary instead of being stored at a shifted instant. A bare `YYYY-MM-DD` is still accepted as UTC midnight, but only for a pricing row's `effectiveFrom`.
- `DailyCostSchema.day` states on the wire that it is the UTC calendar day of the row's
  `occurred_at` and not the viewer's local day, or the literal `'unknown'`. Documentation only;
  the bytes are unchanged.
- The shared `HealthSchema` (`packages/shared/src/schemas/health.ts`) now describes the
  `/api/health` body the server serves — `status` and `schemaVersion` required, the ingest
  fields optional — and the server route validates against it instead of a private copy, so the
  exported `HealthDto` type can no longer drift from the wire. Bytes unchanged.
- The corpus skip log line speaks per file, not per session: `corpus ingest: skipped <path>
  (<reason>) - this file's records are NOT in the dashboard totals (the session's other files, if
  any, still are)`. The old line said "this session's records", which was false for a session whose
  main transcript is oversize but whose subagent transcripts ingested (observed 2026-09-26: a
  151 MiB main transcript skipped, its 367 agents served and the session listed with a dollar
  figure and nothing marking the gap). The running guide and the troubleshooting page say the same.
- A quarantined session's log verdict reads `quarantined: re-read on a change, at most every 32
  passes` instead of `will retry`, and the retry budget counts consecutive failed passes whether
  or not the transcript grew between them (the fix is under Fixed below).
- The running guide has a "Stopping it" note: `Ctrl-C` stops everything, but `kill -TERM` sent to
  the `pnpm` wrapper's PID is not forwarded to the `tsx` child, which keeps listening (observed
  2026-09-26); signal the server process found by its port.
- Tests: the restore-staged corrupt-backup case carries a 20 s timeout (about 3 s of real work
  that brushed the 5 s default under coverage load, observed 2026-09-25); a test pins the global
  DAG's node cap (a parent older than its children falls outside the cap, and every returned edge
  has both ends among the returned nodes), and the `getGlobalDag` docstring now names the edge
  filter as the mechanism, not the cap.

### Fixed

- Server-side served-honesty audit (2026-09-23): a stored rate that is negative, non-finite or
  non-numeric no longer prices tokens on the session, tree and DAG routes or 500s the cost summary
  (the tokens are served as unpriced), and `upsertPricingRate` now refuses such a rate at write
  time; an expanded-year `since` no longer inverts the `/api/changes` window; the global DAG no
  longer attributes one session's usage to an agent of another; config refuses whitespace, hex,
  exponent and fractional numbers, treats `DASHBOARD_DB_PATH=''` as unset instead of opening a
  temporary database, and caps the poll interval below Node's timer ceiling; a non-numeric token
  count fails loudly instead of counting as zero; an unreadable project or agent directory is
  recorded as a skip instead of vanishing; a session with an unreadable file is no longer
  checkpointed; a failed backup prune reports the files it had already deleted.
- Real-corpus ingest halted on two unpriced model ids: with the shipped seed, 52 of 60 sessions on the owner's machine were refused by the `PricingError` gate (`claude-opus-5` ×48, `claude-fable-5-1` ×4) and never reached the database. Migration 18 prices them, and the corpus watcher re-admits parked sessions on its next pass without a restart. Confirmed on 2026-09-18 by a boot at schema 18 over the same corpus: 54 of 54 sessions admitted, `sessionsExcluded` 0.
- The `✕ error 0` status bucket was structurally always zero because nothing produced `status: error`; the outcome classifier above is its producer.
- The Cost tile printed a calendar-guaranteed `$0.00` for today after UTC rollover, before any transcript could have been written.
- One-sided formatter guards let `$-0.0000` and `$NaN` reach the page, and a future-dated timestamp read as `just now`.
- The connection chip stayed on `server unreachable` after a single failed boot-time probe, and never said `reconnecting` while the stream was reconnecting.
- A session whose only status was null was counted under the unrecognised-status glyph.
- The cost sankey's hub hover printed d3-sankey's larger side as a single unexplained figure, and the layout labelled a hub "all cost" when only its entering side matched the served total.

- The SSE client's state guard compared the state word alone, so the second and every later
  failure of an already-reconnecting stream produced no notification at all; every attempt now
  reaches the chip.
- The gate documentation (`SECURITY.md`, the site's security-model and licensing pages) still
  quoted the spawner and licence gates' 2026-08-15 output, said nothing about the manifest scan
  for forbidden direct dependencies, and claimed the licence scanner was the only
  `spawner-gate-allow` site; all three now match the gates' 2026-09-09 output and name the
  three marker sites.
- Server behavioural follow-up:
  - Retention `DASHBOARD_RETENTION_*` values accept plain digits only, as the other variables already did.
  - The post-listen loopback check fails closed when the server reports no bound address, instead of passing over an empty list.
  - A retention run that fails part-way logs what it had already pruned.
  - The realtime hub counts the subscribers it drops.
  - A corpus directory deeper than the walk limit is recorded as a `too-deep` skip instead of vanishing.
  - A pass that could not read an agent's parent transcript no longer erases the stored `parent_agent_id`.
  - A `SubagentStop` whose agent id is the session id no longer marks the main agent and its session `completed`.
- The gate documentation said the `spawner-gate-allow` marker sits on "three sites". Three is the
  number of sanctioned exceptions, not a line count: they are carried on five marked lines, because
  two of them need the marker on the `import` as well as on the call. The gate now reports its own
  hatches - one line per exempt line, a non-fatal line per marker that suppresses nothing, and a
  `N line(s) inline-exempt` total - so the prose contradicted the tool's own output. `SECURITY.md`
  and the site's security-model and licensing pages now state both numbers and the reason, and the
  gate output quoted on the licensing and testing pages matches the line the gate prints today.
  This supersedes the "name the three marker sites" claim in the entry above.
- The cost summary's `coverage` block no longer claims more than it knows. Its comment read "by
  construction, a session that failed to ingest left none behind", and that holds only for a
  session that NEVER ingested. One that ingests cleanly and only later grows transcript lines
  naming a model with no price row halts at the pricing gate before any transaction opens, spends
  its retry budget and is quarantined - while the rows of its last good pass stay committed, stay
  summed into `totals`, and stay listed by `/api/sessions`, with nothing in either body marking
  them as the older extent they are. So `sessionsExcluded` does not mean "this much usage is
  missing from the number above"; it means "these sessions are either absent from it or present in
  it at an older extent than the corpus now holds", and the route cannot yet tell the reader which.
  `apps/server/test/ingest-quarantine-coverage.test.ts` pins the case end to end, measuring $1.00
  and 1,000,000 tokens inside `totals` for the very session reported alongside as excluded and
  quarantined. Ingest behaviour is deliberately unchanged - the halt gate is correct - and the
  Cost view's banner already said "incomplete or absent ... a lower bound", so it needed no edit.
  The four prose sites that gave the false reason (`sse.ts`, the `LiveView` docblock and its two
  gap banners) now give the true one, which is the stronger claim: such a session reaches the
  dashboard looking healthy, so the `ingest-failed` banner is not standing in for an absence, it is
  the only thing contradicting a session that looks current.
- Served strings that render as nothing are named instead of leaving a hole. `dto-guards.ts`
  checks containers and load-bearing numbers and deliberately not strings, so `''` and whitespace
  reach the views as legitimately as any word - and they produced an empty `<code></code>` where a
  session id belongs, an empty project column, an `unrecognised ()` whose parenthesis promised a
  value and exhibited none, and a banner reading `Could not load sessions: ` that announced a
  failure and named none. A blank `subagentType` additionally SHADOWED a good `type`, turning a
  recorded fact into a hole. `format.ts` grows one shared vocabulary for this - `hasVisibleText`
  (whitespace counts as nothing, because three spaces are pixel-identical to none), `quoteRawValue`
  and `nameOrBlank` - and `shortId`, `projectLabel`, `agentTypeLabel`, the status labels, the skip
  and outcome-cause labels, the model cells and the API error copy all route through it. The raw
  value is quoted rather than paraphrased away, so `blank id ("")` and `unrecognised ("  ")` carry
  their own evidence; a condition this build wrote itself stays unquoted, because the quotes are
  what mark the server's own bytes. The shell legend explains the quoting, and is still generated
  from the status constants so no glyph can be painted without appearing in it.
- Hook deliveries: three ways the append path could lose evidence without saying so. A POST with no
  body reached the handler as `payload: undefined`, whose `payload TEXT NOT NULL` violation
  `INSERT OR IGNORE` swallowed exactly as it swallows a duplicate key - so a dropped delivery was
  answered `202 {"stored": false}`, the reply that means "already held". The two are opposites and
  nothing logged, counted or 5xx'd the difference; such a request is now a 400, and `stored: false`
  again means only what it says. The redaction scrub copied fields with `scrubbed[key] = ...`, so a
  `__proto__` field named an accessor on `Object.prototype` and was never copied: it vanished from
  the returned structure and its value became that structure's prototype, while every id reader on
  the path uses `record[key]` and walks the chain - leaving a liveness row and a status transition
  that no bytes in `events_raw` could account for. And the session-status mirror sat behind an
  early return on the AGENT row moving, so a `Stop` that found its agent already `waiting` skipped
  the mirror with it, leaving the session asserting `working` after a hook had just observed its
  main agent idle, and never re-converging. The mirror now runs on every resolved target.
- The Live board can show a seam for an interruption the frame sequence cannot prove. The stream
  gap notice is derived from the server's `id:` sequence, so it cannot exist until a frame arrives
  AFTER the loss - and the ordinary shape of an interruption on a local machine is a drop, a
  reconnect, and then quiet, which delivers no such frame. The board repainted a refetched snapshot
  as unbroken continuity over a feed it knew had a hole. The client's own connection state now
  proves the hole exists while the id sequence proves what was in it, and neither claims the
  other's evidence.
- **Transient read failures now heal without a byte change.** A session whose last ingest read incomplete (a file that was briefly unreadable) used to keep its fingerprint, so the watcher never read it again until the files changed on disk. The watcher now re-reads such sessions on an exponential backoff of 1, 2, 4, … passes, capped at 32. A clean read clears the schedule, and a byte change still triggers an immediate re-read. Quarantine and the attempt limit are unchanged.
- **`agents.last_seen_at` and `sessions.last_activity_at` never move backwards.** A pass that reads less than an earlier one (a duplicate-slug dedupe picking a shorter copy, or a skipped subagent transcript) used to overwrite both anchors with an earlier time. That misordered the lists, and the next unchanged replay could flip a stopped session from `waiting` back to `working`. Both columns are now monotonic (`MAX`), and a NULL no longer erases a known value. An identical replay still writes byte-identical rows.
- **A `SubagentStop` can no longer change an agent in another session.** A stop hook naming an agent id that belongs to a different session (or carrying no session id) is now refused before any status write or session mirror. The raw event is still stored. This applies on both the live and the replay path.
- **Status writes are scoped to the owning session at the SQL layer.** `applyAgentStatus` and `reconcileAgentStatus` now read and update with `WHERE id = ? AND session_id = ?`. A caller that bypasses the hook-layer check still cannot move another session's agent. The id-only `setAgentStatus` stays for the watchdog, whose ids come from the table itself.
- **The watchdog no longer calls an agent `unknown` because of one corrupt stamp.** A corrupt `last_seen_at` used to force `unknown` without ever looking at `first_seen_at`. The anchor is now the first parseable stamp of the two, and `unknown` is reserved for rows where neither parses.
- **Transcript timestamps are stored in one canonical ISO form.** Agent and session start/last-activity values are rewritten to `toISOString` form at the ingest boundary. Offset and no-millisecond spellings used to be stored verbatim and then compared as text by the monotonic `MAX` and the status CASE, which could order them wrongly. A transcript whose first or last record timestamp is not a zoned ISO datetime now fails that session's ingest with a named error instead of storing it.
- **Recent-first lists order by instant, not by stored text.** `/api/sessions` (and its page boundaries), the session tree and the global DAG's node cap and order now compare canonical instants. Rows stored earlier in mixed spellings no longer put an older session first or keep an older agent over the newest one under `limit`.
- **The retention prune's cost receipt no longer prices invalid rates.** A negative, infinite or non-numeric `usd_per_mtok` is treated as unpriced there too, matching every dashboard route. It used to produce negative, infinite or text-coerced dollars in the receipt.
- **A usage timestamp whose UTC form would need an expanded year is rejected.** `token_usage.occurred_at` values such as `9999-12-31T23:00:00-05:00` used to canonicalize to `+010000-…`, which does not order as text. They now halt the write like any other ambiguous timestamp.
- **An edge whose `source` word this build has not learned is no longer drawn as `inferred`.** Both
  graphs classified an edge by `source === 'tool_use' ? observed : inferred`, so any word outside the
  five the parser emits took the dashed stroke and the title `inferred (<word>)`. `inferred` is a
  positive claim that the server DERIVED the parent-child link, and it was being made on the sole
  evidence that the word was not the observed one - while an unlearned source could equally be a new
  OBSERVATION, in which case the same dash understated the graph. A third vocabulary entry
  (`apps/web/src/views/provenance.ts`, the mirror of `status.ts` for this enum) now gives such an
  edge its own dotted stroke and quotes the raw word: `unrecognised ("mcp_spawn")`, and
  `unrecognised (no source word sent)` where no string arrived at all - the two renderings this
  codebase has already removed twice elsewhere, `inferred (undefined)` and `inferred ()`. The
  accessible census is three-way for the same reason, and the legend is generated from the new
  module, so no stroke is drawn that the legend does not explain. Also amended: the runtime-guard
  exemption in `apps/web/src/dto-guards.ts` named `source` among the fields it skips because "the
  views already funnel an unrecognised value into an explicit bucket" - for this field no such
  renderer existed.
- **The DAG caption no longer prints the corpus edge count as the number of edges drawn.**
  `totalEdges` counts the whole `orchestration_edges` table while the returned `edges` keep only
  those whose both endpoints are among the returned agents, and the table carries no foreign key to
  agents - so an edge naming an agent id with no stored row is counted forever and returned never,
  giving `returnedEdges 0` against `totalEdges 1` with `truncated` false. That fell to the
  untruncated caption, which qualifies nothing. The caption now reads `1 of 3 edges` whenever the
  two counts disagree, a notice states how many were counted but not returned, and
  `describeAgentGraph` carries the same sentence so the diagram's text alternative is not poorer
  than the prose beside it. The notice rules out the node limit (provable: the answer is not marked
  truncated) and declines to name what the cause is, which is a fact about the server's join that
  the client does not hold.

- **A session's start and an agent's first sighting no longer move forward.** This closes the
  residual left by the `last_activity_at` / `last_seen_at` monotonic fix: `sessions.started_at` and
  `agents.first_seen_at` were still overwritten on every pass. A pass whose earliest record is later
  than one already observed (compaction evicted the head, a skipped file, a duplicate-slug copy that
  starts later) now keeps the earlier stored start, and a NULL no longer erases a known one.
- **An observed error outcome now sets the agent's status to `error` even when its transcript has
  stopped growing.** The outcome (e.g. `terminated_early`) is read from the parent transcript, but
  the status CASE applied a new status only when the child's own `last_seen_at` advanced. A killed
  child therefore stayed `working` (later `unknown`) next to an `outcome_cause` that contradicted
  it, and was never counted as an error. An already-observed `completed` stays sticky.
- **A retention day window above 100 years is now refused at startup.** `DASHBOARD_RETENTION_EVENTS_DAYS`
  and `DASHBOARD_RETENTION_BACKUP_DAYS` had no upper bound, and neither did the policy's `maxAgeDays`.
  A window of about 1e8 days loaded fine, then produced an invalid cutoff date, so every daily
  retention run failed. The row prune runs first, so its failure also stopped the backup-file rule,
  which was valid, and backups piled up behind one logged error a day. Windows are now capped at
  36500 days, both in the config and in `assertRetentionPolicy`.
- **A retention journal receipt is now written in full or not at all.** The append ignored the
  byte count `writeSync` returned, so after a short write it `fsync`ed a truncated receipt and the
  prune committed as if the receipt were whole. It now loops until every byte is written, and a
  write that makes no progress throws, which rolls the deletion back.
- **A retention run no longer reports "more remain" when exactly the budget had expired.**
  `budgetExhausted` was `rowsMatched >= limit`, so a run that deleted the last `maxRowsPerRun`
  rows printed `N+` and the next run found nothing. The window query now checks whether another
  expired row lies past the budget.
- **A restore no longer damages the destination before it has checked the backup.**
  `restoreDatabase` deleted the destination's `-wal`/`-shm` pair and copied the backup over it,
  and only then ran `integrity_check`. A missing backup therefore failed after the live WAL was
  gone, and a corrupt one after the live file was overwritten. The backup is now copied to
  `<dest>.restoring`, checked there, and swapped in only when the check passes. On failure the
  destination is untouched and the staged copy is kept for inspection.
- **`openDatabase` closes the handle when its own setup throws.** A file that is not a database,
  or a connection that failed the WAL / foreign-key assertion, threw with the handle still open
  and unreachable.
- **`/api/health` no longer reports ingest fields when ingest is off.** With `DASHBOARD_INGEST=0`
  it still answered `ingest: "idle"`, `ingestSkips: {}` and `crossSessionUsageCollisions: 0`,
  describing a pass that never ran. Those fields and `lastTickDurationMs` are now omitted, as
  `sessionsExcluded` already was. The docs also now say that `"idle"` means the startup pass
  finished, not that it succeeded.
- **Hook commands ignore `~/.curlrc` and proxy settings.** The generated `curl` now starts with
  `--disable` and passes `--noproxy '*'`, so a curlrc cannot add tracing or a proxy and an
  `http_proxy` / `ALL_PROXY` cannot route the token and prompt away from loopback. Hooks from the
  previous installer are recognised and upgraded in place.
- **The hooks installer refuses a non-object `hooks` value and writes atomically.** An existing
  `"hooks": []` was silently replaced; it is now refused before any backup or write. The settings
  file is written to a temporary sibling and renamed over the target, following a symlinked
  `--out` and keeping the file mode; a failed write leaves the original bytes and names the backup.
- **The spawner gate covers more ways around it.** It now fails on a `package.json` script that
  binds wider than loopback (the wide address or a `--host` without a loopback value), on imports
  and direct dependencies of more subprocess-wrapper packages (`tinyexec`, `zx`, `nano-spawn`,
  `spawndamnit`, `cross-spawn-async`, besides the existing ones), and on the `vm` module.
- **A restore closes its check handle when `integrity_check` throws.** An I/O error during the
  check left the staged copy open with its `-wal` / `-shm` pair until the process exited.
- **The hooks installer keeps a dangling symlinked `--out`, and its temp file is exclusive.** A
  link whose target did not exist yet was replaced by a regular file; the target is now created
  and the link kept, and a missing target directory is refused. The temporary sibling is created
  exclusively, so a file or link already at that name is removed rather than written through. A
  failed write that followed a directory creation now names that directory instead of saying
  nothing was written.
- **Two dashboard texts no longer overstate.** The missed-frames detail no longer says a
  quarantined session is absent from the read API (it may still show its last good pass), and the
  empty live board no longer promises that the watcher will fill it, since ingest may be off.
- **The gate scripts no longer pass silently through a symlinked path.** Each compared
  `import.meta.url` (symlinks resolved) with `process.argv[1]` (not resolved), so running a gate by
  an absolute path through a symlink skipped it and exited 0. They now compare real paths.
- **The license gate counts unique package names.** A name installed at two versions under two
  licenses was counted twice; the same tree now reads 407 packages, not 412.
- **The Pages workflow scopes its token per job.** Only the deploy job can mint an OIDC token;
  the build job keeps `contents: read` and `pages: write`.
- **An unrouted request no longer writes its token into a log line.** Fastify's default 404
  handler logged `Route <METHOD>:<url> not found` as a plain message, bypassing the redacting
  request serializer, so `POST /api/stream?token=...` put the token in the log (and echoed it in the
  body). A root not-found handler now answers `{ error: 'Not found.' }` and logs nothing.
- **The cycle notice counts only agents in a cycle.** Agents below a cycle were counted as sitting
  in it (A->B, B->A, B->C, C->D read "4 agents"); the DAG and sessions views now name the cycle
  members and the agents below it separately.
- **The graph summaries disclose unreadable unpriced counts.** A negative or non-finite unpriced
  count was summed away, so +100 and -100 read as "no unpriced tokens"; each such agent is now
  named with its value and a readable total next to it is stated as a minimum. The cost sankey's
  hover text and prose follow the same rule, and its folded "other models" node reads as unreadable
  instead of summing +100 and -100 to 0.
- **The burners ranking no longer claims completeness when the counts disagree.** An untruncated
  answer whose returned agents differ from the served total now gets a banner, and a partial list
  never reads "All N".
- **The cost page states its age and can be refreshed.** A "Read ... ago" line, a Refresh costs
  button and a Retry on the error state replace a tile that told the reader to reload.
- **The Today tile no longer misfiles a new day just after UTC midnight.** The day boundary is the
  later of the clock tick and the read time, so a lagging tick no longer marks the new day's rows
  future-dated and warns that the corpus and the browser disagree.
- **The per-session analysis says when the difference is unreadable, and can retry.** A
  non-finite difference used to hide the mispricing signal silently; it now shows its own notice,
  and the error state has a Retry.
- **The live board's gap and reconnect banners no longer claim a refetch that has not happened.**
  They say the cards were refetched only once a refetch started after the gap has succeeded, and
  say it failed when it did. The reconnect banner no longer promises that a later frame will
  reveal what was missed: frame ids restart at 1 on every server boot, so after a reconnect a gap
  count is shown as a lower bound.
- **A legacy task-notification no longer links a child to a parent from quoted prose.** The
  parser read the first `<tool-use-id>` anywhere in a message that merely mentioned the tag; it now
  accepts only a message that starts with a closed task-notification element and reads the id
  inside it, so an unanchored child stays an orphan instead of getting an invented edge.
- **Token redaction in logged URLs leaves the rest of the URL byte-for-byte.** The docstring
  promised the path and other parameters were kept verbatim, but the URL was re-serialized
  (`%20` became `+`, a bare flag gained `=`). Only the `token` value is now rewritten, in place.
- **Read-API docs no longer overstate what the coverage counters mean or how `since` parses.**
  Excluded or quarantined sessions may still be in the totals at an older extent (not "counted
  nowhere"); `savingsUsd` is documented as a sum of per-subagent floored savings, not the
  difference of the two totals; `since` accepts zone offsets and `T24:00` (the 400 message now says
  so); unknown query parameters are ignored and numeric ones are coerced, as documented behaviour.
- **The web client's status and number texts claim only what it observed.** A frame with several
  failing handlers is counted as one dropped frame, and the dropped-frames note names no single
  cause; a server-error health answer no longer asserts the dashboard server is running (a proxy
  may have answered); token counts round before choosing a unit (`999,950` shows `1.0M`, with a `B`
  tier) and `-0` shows `0`; a health `schemaVersion` must be a safe non-negative integer; and the
  root error boundary no longer blames the server's data for a failure it cannot attribute.
- **A live session the pricing gate keeps refusing is no longer re-read on every poll.** The
  retry budget restarted whenever the transcript grew, so a session still being written while its
  model id was unpriced (12 of the 27 on 2026-09-26) was parsed in full on every tick: 10–18 s
  ticks that blocked the event loop and made every API call take 20–37 s. Consecutive failed passes
  now count whatever the bytes did; at three the session is quarantined, and a byte change re-reads
  it on a doubling schedule (1, 2, 4… passes apart, capped at 32) instead of at once. A successful
  read, a pricing-table change, the session leaving the disk or a corpus-root change clear it, and
  `sessionsQuarantined` on `/api/health` still counts it.
- **An unreadable slug or transcript no longer forgets the sessions it hides.** A slug directory
  whose listing or probe fails (EACCES, EIO, EMFILE under load), or a main transcript whose probe
  fails, made its sessions absent from the pass, and the watcher read that absence as "left the
  disk": it pruned their fingerprints and retry budgets, and the checkpoint commit dropped their
  persisted rows, so one transient fault cost a full re-read of every session under the slug the
  moment it recovered, or a from-scratch replay after a restart. Known sessions the enumeration
  reported as unreadable are now held, by the slug they were last enumerated under or by their own
  transcript path; a session hydrated from a checkpoint and never yet enumerated is held whenever
  anything at all was unreadable; a session that really vanished under a readable slug is still
  pruned on the same pass.
- **Corpus reader: an `lstat` that fails with anything other than ENOENT/ENOTDIR** (EACCES, EPERM,
  EIO) on a slug directory, a main transcript, a session directory or a subagent artifact is now
  recorded as an `unreadable` skip with its errno code instead of being mistaken for a vanished
  entry, so an affected session is no longer ingested main-only, silently checkpointed as complete
  and never re-read; enumeration reports it under `ingestSkips` on `/api/health` and the watcher
  keeps it on the re-read schedule until the probe recovers.
- **The hooks installer reports the write failure even when its cleanup fails too.** When the
  settings write failed and removing the temporary sibling threw as well (a directory sitting at
  the temp path, `EISDIR`), the bare cleanup error surfaced and the "Failed to write … a backup was
  taken at …" message was lost; the cleanup is now guarded, and the write failure is always the
  error reported, with the original as its `cause`.
- **Web, DAG view: a count that runs the other way is no longer reported as a slice or a negative
  gap.** Both disagreement checks were inequalities, but the sentences they gated described only
  "fewer returned than counted", and the edge banner subtracted the two raw. A read that drew three
  agents while counting two printed "3 of the 2 agents … are drawn … so this picture is a slice",
  and one that returned three edges while counting two printed "-1 of the 2 edges … were not
  returned … They are not in the picture below". The page, the caption and the accessible summary
  now name the direction ("3 agents are drawn, but this same read counts only 2", "3 edges returned
  against 2 counted") and say the answer and its own count disagree, without claiming a slice or a
  missing edge they cannot see.

## [0.3.0] - 2026-08-25

First versioned release of the source tree. agenthropic is run from a clone, not
installed from a registry: no code ships on npm, and the package published under
this name carries documentation only. v1.0 remains the target for 2026-12-01.

### Added

- Local-first dashboard for Claude Code agent activity: a Fastify server on loopback, SQLite in WAL mode with versioned migrations, an SSE stream and a React single-page app, built as a pnpm workspace on Node 22.
- Session ingest reads `~/.claude/projects/*.jsonl` transcripts as the ground truth for token counts; nothing is inferred from message text.
- Replay on startup rebuilds the database from the transcripts alone, persisted checkpoints stop a restart from re-reading what it already ingested, and a second replay produces a byte-identical database.
- Persisted subagent DAG: parent and child orchestration edges are stored rows over a self-referential `parent_agent_id`, not reconstructed in the browser.
- Edge provenance is recorded and stays visible: `tool_use` is observed, while `directory`, `task_notification`, `queue_operation` and `legacy_explore` are inferred, drawn differently in the dashboard behind a permanent legend.
- Agent status lifecycle with five states (working, waiting, completed, error, unknown) written by ingest, `Stop`, `SubagentStop` and a missing-Stop watchdog; an observed terminal state is sticky, and `unknown` renders as its own bucket rather than being hidden.
- Cost engine over a seeded model-pricing table, with per-session, per-agent, per-model and per-day rollups; a model with no price halts that session's ingest before any row is written, instead of recording a silent $0.
- Compaction repricing across a `PreCompact` boundary, and a delegation-savings figure that is labelled an estimate everywhere it appears.
- Per-session cost analysis computed over a read-only transcript seam, opened on demand from the cost view rather than fetched for every row.
- Authenticated read API covering health, the session list and detail, a session's subagent tree, a session's hook events, per-session cost analysis, the global cost summary and the global DAG.
- Realtime stream at `/api/stream` carrying typed `session-ingested`, `agent-status-changed` and `ingest-failed` events, plus heartbeats and a reconnect hint.
- Hook receiver at `POST /api/hooks/event` that accepts any Claude Code hook event and appends it to an append-only raw store; hooks contribute liveness only and never change the DAG.
- Hooks installer that wires `UserPromptSubmit`, `Stop`, `SubagentStop` and `PreCompact` to the loopback receiver, merging non-destructively into an existing settings file and backing that file up first.
- Web dashboard with four views (live status board, session tree, global DAG, cost flow) behind a token screen that validates the token against the server before storing it.
- Cost windows for today and the last seven days, a top-burners ranking, and unpriced tokens carried as their own figure rather than folded into the dollar total.
- Daily online database backup on a timer, with backup-file expiry that always keeps a minimum number of copies, and a restore path that has been drilled and documented.
- Retention engine: a bounded, transactional prune of the events and token-usage projections with a dry-run mode, an fsync'd cost receipt written inside the delete transaction, and a static guard proving no delete ever targets the raw event, session, agent, edge or pricing tables.
- Ingest visibility on `/api/health`: per-reason skip counters, a `replaying` or `idle` phase, the duration of the last completed corpus poll, and the number of cross-session usage collisions.
- Corpus-scale benchmark against a synthetic corpus, and a hand-labelled hierarchy annotation format whose accuracy gate uses a one-sided Wilson lower bound (n >= 52 with zero errors) and reports "substrate unavailable" instead of passing vacuously.
- Published documentation site at <https://ivanbbaev.github.io/agenthropic/>, built from `docs/` by the stock GitHub Pages Jekyll builder and deployed by a workflow that uses only official actions and adds no dependency to the repository.

### Changed

- Corpus polling costs O(new bytes) instead of re-reading each transcript in full; a tail cache stores only complete-line regions, so chunked decoding stays byte-equivalent to a whole-file read and any divergence falls back to a full read rather than serving a stale prefix.
- The server binds its loopback socket before the startup replay runs, so the dashboard answers immediately and `/api/health` names the warm-up window as `replaying` while `status` stays `ok`.
- The cost summary is computed as a single rollup with a filtered priced query instead of four scans; the benchmark's worst query dropped from 627 ms to 9 ms.
- Coverage thresholds are pinned at 100% statements, branches, functions and lines across all five packages, with per-package guard tests that fail the build if a threshold is lowered or a coverage-ignore pragma reappears.
- A replay pass that ingested nothing now states which of seven distinct outcomes applied, where it previously printed nothing and made "all current", "corpus root missing" and "corpus root unreadable" look identical.
- The cost-analysis route answers its three distinct absences with three distinct messages (not configured, unreadable corpus root, unknown session), carried through to the dashboard.
- Main-agent token usage is attributed to its own agent row, so a session's totals cover the main agent and not only its subagents.

### Fixed

- Streaming turns are upserted by convergence instead of `INSERT OR IGNORE`, so a turn that grows after its first ingest is updated rather than frozen at the first value seen.
- A sender-minted delivery id separates a genuinely repeated hook firing from a redelivery of the same one, so real recurrences are no longer deduplicated away.
- Ingest failures are retried within bounds and surfaced as an `ingest-failed` event instead of being swallowed, so a quarantined session is visible in the dashboard.
- Status reconciliations produced during ingest, such as a `SubagentStop` that arrives before its agent row exists, are published to connected clients, so the interface no longer shows the stale status until a full reload.
- A session UUID appearing under more than one project slug is resolved deterministically at enumeration (the smallest slug wins) and the loser is reported as a `duplicate-session` skip, instead of being dropped by whichever file happened to have the newer mtime.
- The DAG and cost endpoints scope every identifier to the session that owns it and declare truncation with real counts, so a capped list is never presented as a complete one.

### Security

- Loopback-only bind: the host is a module constant with no configuration path, and a post-listen check terminates the process if any bound address is not loopback.
- The dashboard token is mandatory: startup fails when `DASHBOARD_TOKEN` is unset, empty, or shorter than 16 characters.
- Bearer tokens are compared in constant time, with both sides hashed to fixed-length digests first so a length difference cannot leak through timing.
- Every `/api/*` route is gated by a hook registered before any route, authorizing on the routed pattern rather than the raw URL, so a percent-encoded path cannot slip past the prefix check.
- The SSE stream enforces same origin: a foreign `Origin` is rejected with 403 before authentication is even attempted, and there is no wildcard CORS.
- Hook payloads are redacted at the ingest boundary, before the envelope and before the idempotency key is computed, by secret-bearing key name and by credential shape, so persistence never sees a raw body. Token-count fields are allowlisted so observability data survives.
- The `?token=` query parameter that `EventSource` requires on the stream URL is redacted in request logs.
- The corpus filesystem port is read-only by construction, with `O_NOFOLLOW` opens, an fstat re-check against TOCTOU, symlinks observed rather than followed, and a per-file read cap that a tail read cannot bypass; a containment violation stops the server rather than being skipped.
- Two gates run in CI: a static scan that rejects any subprocess spawner, wide bind, WebSocket server or dynamic evaluation across `apps/`, `packages/`, `scripts/` and `hooks/`, and a dependency license allowlist scan over every installed workspace package.
- The hooks installer never places the token in any process's argv (curl reads the environment at fire time), never spawns a process, and never touches the network.

### Not yet shipped

Things a reader might reasonably expect here and will not find:

- No git tag. The version is `0.3.0` across the workspace; the release checklist bumps it to `1.0.0` at release time, and tagging has not been done for any version.
- No code on npm. The root package is publishable so that the name is held, but its tarball is `README`, `LICENSE`, `CHANGELOG` and `SECURITY` only - there is no `bin`, no build output and nothing to run. Every `@agenthropic/*` workspace package stays `private` and unpublished.
- Merge blocking is not total. `main` requires the `ci` check as of 2026-08-25, and refuses force-pushes and deletion, but `enforce_admins` is deliberately off: a red run withholds a contributor's merge and not the sole maintainer's direct push.
- No alerting and no webhooks. The alert port, rules engine and notification sinks are deliberately v2 work and are not on the v1.0 path.
- Retention is implemented but nothing runs it. There is no timer and no HTTP entry point, on purpose, until the retention policy values are signed off; the default policy is a byte-identical no-op that opens no transaction.
- The subagent-hierarchy accuracy claim is not signed off. The annotation loader and the Wilson-bound gate are built, but the hand-labelled corpus they measure against does not exist yet, so the gate reports "substrate unavailable" rather than a passing number.
