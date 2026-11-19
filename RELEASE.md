# RELEASE.md — the v1.0 merge/tag checklist (WP-X9)

This is the release checklist required by
[`docs/analysis/development-plan.md`](docs/analysis/development-plan.md) §5 (`WP-X9`:
"`RELEASE.md` enumerates every CD-7 build-failing gate + CD-9 provenance check with a
verification step each") and scheduled by
[`docs/analysis/roadmap-v1-v2-2026-07-06.md`](docs/analysis/roadmap-v1-v2-2026-07-06.md)
§5: **"`RELEASE.md` (X9) executed once for real. Tag v1.0."** The checklist must be
_executed_, on the exact commit that gets tagged.

Rules of this document:

- Every box is backed by a **real command or a real file in this repo**, or is marked
  **[HUMAN]**: an act only the owner can perform.
- Run everything from the repo root, on a clean checkout of the release commit.
- **Every box starts unticked and is ticked on the release commit only.** A note under a
  box records a decision or an earlier check. It does not tick the box.
- **Any red box = no tag.** There is no partial credit.
- No test counts, migration counts or file counts are written into this page. They change
  with every commit. Read them from the run on the release commit.

---

## 0. Preconditions and human ratifications

- [ ] **[HUMAN] KC calendar check.** Compare the tag date against the kill-checkpoint
      calendar at the top of [`TODO.md`](TODO.md) and roadmap §4. The v1.0 hard date is
      **2026-12-01 (KC-4)**. The record:
      - KC-0 (2026-07-13) and KC-1 (2026-07-27) **passed unmet**. Work continued only
        under the owner overrides recorded in `TODO.md`.
      - KC-2 (2026-09-14) was **met**. It was ticked on 2026-09-18.
      - KC-3 (2026-10-12) **condition met on the date**: the three P0 proofs were green
        and `ci` was required on `main`. The evidence is CI run `37306525655` on `2d85a71`,
        re-verified 2026-10-22. The tick is still Ivan's.
      - KC-5 cannot be met before the tag.

      Last checked **2026-11-14**: 17 days to KC-4. Redo this box on the tag day.
- [ ] **[HUMAN] LABEL-ME ratification.** Ivan hand-fills the five
      `spike/corpus/sessions/<short>/LABEL-ME.md` trees (224 per-edge blanks); see
      [`docs/analysis/phase0-verdict.md`](docs/analysis/phase0-verdict.md) §"what still
      needs Ivan". Until then every spike-derived number is **PROVISIONAL**.
      **Waiver recorded 2026-10-30 (D8).** No agent fills these trees, because that would
      launder the human gate. If they are still blank on the tag day, v1.0.0 ships with
      every spike-derived number **PROVISIONAL** and the hierarchy gate **NOT CERTIFIED**,
      and the release notes say both (§7). Agent evidence that does not replace this box:
      [`hierarchy-oracle-2026-10-30.md`](docs/measurement/hierarchy-oracle-2026-10-30.md).
- [ ] **[HUMAN] The two KC-0 physical acts**: open the friction log, and install at least one
      rival dashboard. Close them or waive them in writing before tagging.
      **2026-10-30 (D9):** the friction log is **waived as a tag criterion**. It needs
      Ivan's own daily use and remains the KC-5 evidence. The rival install waits for
      Ivan's permission to run `claude-code-templates --analytics` under
      `~/Development/_temp/rival-trial/`.
      _(D-numbers: [`10-synthesis.md`](docs/analysis/role-reviews-2026-10-29/10-synthesis.md) §6.1.)_
- [ ] **[HUMAN] Private vulnerability reporting enabled** (OSS-3). [`SECURITY.md`](SECURITY.md)
      sends reporters to GitHub's private reporting. Enable it under Settings → Code
      security → Private vulnerability reporting.
      Verify: `gh api repos/IvanBBaev/agenthropic/private-vulnerability-reporting --jq .enabled`
      → `true`. It was `false` when last checked on 2026-11-14. Until it is enabled, the
      SECURITY.md fallback applies: a public issue that names only the component.
- [ ] **Branch protection.** `main` requires the `ci` status check and refuses
      force-pushes and deletion (set 2026-08-25). `ci` is the job id; the workflow's
      display name is `CI`. `enforce_admins` is **deliberately off**, because there is
      one maintainer and his normal mode is a direct push. So a red run withholds a
      contributor's merge, not Ivan's push.
      Verify:
      `gh api repos/IvanBBaev/agenthropic/branches/main/protection --jq '{contexts: .required_status_checks.contexts, enforce_admins: .enforce_admins.enabled}'`
      → `{"contexts":["ci"],"enforce_admins":false}`
- [ ] **CI green on the release commit.** Verify:
      `gh api "repos/IvanBBaev/agenthropic/actions/workflows/ci.yml/runs?branch=main&per_page=1" --jq '.workflow_runs[0] | {head_sha, conclusion}'`
      → `conclusion` is `success` and `head_sha` is the commit to be tagged.
      *(Since 2026-11-19, OSS-11: pushing a `v*` tag also starts its own CI run. After the
      push, `gh run list --workflow ci.yml --branch v1.0.0 --limit 1` shows it; it must be
      green too.)*

## 1. Build-failing quality gates (CD-7)

CD-7 verbatim ([`docs/analysis/concept-analysis-v2.md`](docs/analysis/concept-analysis-v2.md) §3):
**"Security + the coverage gate are boundary conditions from commit one, CI-blocking:
loopback-or-fail bind; mandatory `DASHBOARD_TOKEN`-or-fail-startup (timing-safe
compare); SSE same-origin; no-spawner grep/static gate; no-SSRF (webhook targets
operator-configured, never dialed from a payload); WAL + tested restore; >90% coverage
blocks merges."**

Run each gate locally on the release commit. The six below plus the web production build
(`pnpm --filter @agenthropic/web build`) are the seven commands CI runs
([`.github/workflows/ci.yml`](.github/workflows/ci.yml)):

- [ ] `pnpm run typecheck`
- [ ] `pnpm run lint`
- [ ] `pnpm run format:check`
- [ ] `pnpm run test`: the full workspace suite. All five packages (`@agenthropic/server`,
      `@agenthropic/web`, `@agenthropic/core`, `@agenthropic/shared`,
      `@agenthropic/test-fixtures`) run `vitest run --coverage` against **100/100/100/100**
      thresholds, set in each package's `vitest.config.ts`. Record the totals in the release
      notes.
- [ ] **Read how the 100% was reached.** A test that executes a line without asserting
      on it satisfies the gate and proves nothing, and no threshold detects that. All five
      packages have tests that guard the three cheap ways to fake 100%: lowering a
      threshold, adding a coverage `exclude`, and an ignore pragma. `apps/web` legitimately
      excludes `src/main.tsx` and `src/vite-env.d.ts`, so it pins the exact exclude list and
      thresholds instead (`apps/web/test/honesty.test.tsx`). Re-read
      `apps/web/vitest.config.ts` on the release commit. The history is in
      [`docs/site/contributing/testing.md`](docs/site/contributing/testing.md)
      §"Three asymmetries".
- [ ] `pnpm run gate:spawner`: the WP-F5 static gate over `apps/`, `packages/`, `scripts/`
      and `hooks/` ([`scripts/check-no-spawner.mjs`](scripts/check-no-spawner.mjs)). It
      rejects a spawner, a wide bind, a WebSocket server, dynamic evaluation, and outbound
      network calls in server-process code. The allowlist is logged on every run.
      **Read it:** it must contain only the policy file itself.
- [ ] `pnpm run gate:licenses`: the CD-9 allowlist gate (see §4).

## 2. Security invariants re-verified on the release commit

Each invariant names where it is **enforced** (source) and where it is **proven** (a test,
green as part of the §1 `pnpm run test` box).

- [ ] **Loopback-only bind (`127.0.0.1`), never `0.0.0.0`.**
      - Enforced at runtime by `enforceLoopbackOrExit` in `apps/server/src/index.ts`, with
        `HOST` pinned in `apps/server/src/config.ts`.
      - Proven by `apps/server/test/security-contract.test.ts`.
      - Statically guarded by `gate:spawner`'s wide-bind patterns.
- [ ] **Mandatory `DASHBOARD_TOKEN` or the server refuses to start; timing-safe compare.**
      - Enforced in `apps/server/src/config.ts` (via `requireDashboardToken` in
        `packages/shared/src/security/index.ts`) and by the global `onRequest` gate in
        `apps/server/src/server.ts`.
      - Proven by `apps/server/test/config.test.ts` and
        `apps/server/test/security-contract.test.ts`.
- [ ] **All endpoints auth-gated.** Unauthenticated requests are rejected and nothing is
      stored. Proven by `apps/server/test/security-contract.test.ts` and the per-route suites
      (`apps/server/test/api-*.test.ts`, `apps/server/test/hooks-routes.test.ts`).
- [ ] **Security headers and Host allowlist** (R18). Proven by
      `apps/server/test/security-headers-host.test.ts` and
      `apps/server/test/static-site.test.ts`.
- [ ] **SSE same-origin (CD-5). SSE is the only realtime transport; there is no
      WebSocket.**
      - Proven by `apps/server/test/server-sse.test.ts` and
        `apps/server/test/realtime-stream.test.ts`.
      - `gate:spawner` fails the build on any WebSocket-server pattern.
- [ ] **No browser-driven subprocess spawner, anywhere.** Checked by `pnpm run gate:spawner`
      (§1). The only sanctioned subprocess is the fixed-argv `pnpm licenses list` in
      `scripts/check-licenses.mjs`. It is opted out line by line with audited inline
      markers, never per file.
- [ ] **No SSRF: no code path dials a payload-supplied URL.**
      - The only outbound call is the opt-in Telegram sink's `fetch`, at
        `apps/server/src/alerts/telegram-sink.ts`. It goes to the constant origin
        `https://api.telegram.org`, with `redirect: 'error'`.
      - The gate logs that line as `inline opt-out in force … [outbound fetch( call]`.
        **It must be the only outbound opt-out.**
      - The dynamic proof is `apps/server/test/alerts-ssrf-secret-corpus.test.ts` (WP-A10).
      - Cross-check: `grep -rnE "\bfetch\(|node:https?|\baxios\b|\bundici\b" apps/server/src packages/*/src`.
        Expect matches only in `telegram-sink.ts`: the marked `fetch` line and its header
        comment. Matches in `apps/web/src` do not count. They are the browser calling this
        server's own relative `/api` paths.
- [ ] **Secrets never in SQLite, never on the SSE stream, never in logs.**
      - Redaction at the ingest boundary is proven by
        `apps/server/test/hooks-redact.test.ts`.
      - Log hygiene is proven by `apps/server/test/server-logging.test.ts`.
      - The opt-in Telegram bot token is held by reference (`env:NAME` or `file:/abs/path`)
        and is never stored. `alerts-ssrf-secret-corpus.test.ts` proves it reaches no
        outcome, row or log line.
- [ ] **The corpus (`~/.claude/projects`) is read-only to this system.**
      - `apps/server/src/corpus/fs-port.ts` and `apps/server/src/corpus/node-corpus-fs.ts`
        import no write, rename, unlink or chmod symbol.
      - Spot-check:
        `grep -rnE "writeFile|createWriteStream|unlink|rename\(|chmod" apps/server/src/corpus/`.
        Expect matches only in the in-file comments.
      - Proven by `apps/server/test/ingest-corpus-watcher.test.ts`.
- [ ] **SQLite in WAL mode, enforced.** `apps/server/src/db/connection.ts` throws unless
      `journal_mode=wal` after open. Proven by `apps/server/test/db-connection.test.ts`.
      For the tested restore, see §5.
- [ ] **`events_raw` is append-only, with no UPDATE or DELETE path (CD-4).** Proven by
      `apps/server/test/events-raw.test.ts`.

## 3. The three P0 moat proofs — tag blockers

The canonical P0 set is in
[`docs/site/contributing/testing.md`](docs/site/contributing/testing.md) §4
(`WP-X3`/`WP-IN13`). It blocks the release, and no other feature work substitutes for
it. The test bodies live under `apps/server/test/p0/`, beside a fourth proof: the CD-10
five daily questions over real HTTP. Tick these boxes against the release commit's CI
run, not against a local run.

- [ ] **P0-1: Σ `token_usage` == JSONL exact, per session.** Zero drift, no silent
      rounding, no double count.
- [ ] **P0-2: double replay → byte-identical DB state.**
- [ ] **P0-3: DAG rebuild from JSONL alone, after a simulated outage.**
- [ ] All three are **green in CI on the release commit**. Through the §0 branch
      protection they block a contributor's merge, but not the owner's push
      (`enforce_admins: false`).
- [ ] **Real-corpus contract suite on the owner's machine (R17).** Run
      `AGENTHROPIC_REAL_CORPUS=~/.claude/projects pnpm test:real` on the release commit,
      with `AGENTHROPIC_REAL_CORPUS_CENSUS` pointing at the census file of the previous
      release run.
      - It asserts 0 failed sessions, P0-1 exact per message, 0 anchorable orphan
        subagents, and an edge census that has not regressed.
      - It is local-only by design: CI sees only the synthetic corpus (D14(a)).
      - Record the printed counts in the release notes.
      - An orphan whose spawn evidence is absent from the corpus is honest, not a bug. The
        suite proves this from the raw bytes and prints such orphans as
        `unanchorableOrphans` instead of failing (parser-spec §4.1, amendment 2026-11-19).
        Name each one in the release notes.
- [ ] **[HUMAN-dependent] Hierarchy correctness ≥95%** against the labelled corpus
      (testing.md §4). This bar only means something once the §0 LABEL-ME box is done.
      **Waived in writing 2026-10-30 (D8).** Unless Ivan labels the trees before the tag,
      this box stays unticked, and the release notes say the gate is **NOT CERTIFIED**.

## 4. CD-9 provenance / licensing checks

CD-9 ([`docs/analysis/concept-analysis-v2.md`](docs/analysis/concept-analysis-v2.md) §3,
with the source's strikethrough rendered inline):
**"Per-artifact licensing. COPY simple10 tree/ports + hoangsonww Telegram/webhook
schema (dropped — single better-sqlite3 driver per best-path §6.3) with attribution;
CLEAN-ROOM reimplement cast `controlGate` + delegation-savings and nirdiamant
checkpoint (never view their source while writing). Enforced by a CI provenance/license
scan."**

- [ ] `pnpm run gate:licenses`: an SPDX allowlist over **every** installed workspace
      dependency, with AND/OR expressions handled. It has exactly one documented
      per-package exception, `caniuse-lite` (CC-BY-4.0). See
      [`scripts/check-licenses.mjs`](scripts/check-licenses.mjs).
- [ ] **[HUMAN] COPY-with-attribution review.** Every artifact copied into the tree must be
      attributed in
      [`docs/site/contributing/licensing.md`](docs/site/contributing/licensing.md).
      **Reviewed 2026-10-30 on owner delegation (D9): nothing was copied.**
      - The Telegram sink records the hoangsonww idea as reimplemented.
      - The DAG layout was written from scratch.

      Re-read it on the tag day if the tree has changed.
- [ ] **[HUMAN] Post-1.0 code in the tagged tree.** **Decided 2026-10-29 (Ivan): ships
      dark.** v1.0.0 carries the v2.0 alerting core (Telegram sink, rules engine,
      dispatcher) unchanged. It is inert unless `DASHBOARD_ALERTS_CONFIG` is set. The
      release notes say "opt-in alerting core, off by default". The cast/nirdiamant
      clean-room reimplementations are still absent:
      `grep -rniE "controlGate|nirdiamant" apps/ packages/ --include='*.ts' -l | grep -v /dist/`
      → expected empty.
- [ ] **`LICENSE` (MIT) is on the remote.** Verify:
      `gh api repos/IvanBBaev/agenthropic --jq .license.spdx_id` → `MIT`.

## 5. Backup → restore drill (CD-7 "WAL + tested restore", WP-F8)

- [ ] **Automated proof**: `apps/server/test/backup.test.ts`, green in the §1 run. It takes
      a real online backup, restores it, reopens it through the pragma assertions, and
      requires `PRAGMA integrity_check` = `ok`
      ([`apps/server/src/db/backup.ts`](apps/server/src/db/backup.ts)).
- [ ] **Live drill on the database the release boots on.** The drill opens the database
      **read-only** and takes a verified 0600 backup with `backupDatabase()`. It then
      restores it into a scratch directory with `restoreDatabase()`, and fails unless every
      table's row count matches:

      ```bash
      DASHBOARD_DB_PATH=/absolute/path/to/the/release/agenthropic.db \
        pnpm --filter @agenthropic/server drill:restore
      ```

      - If you see `WARNING: the database is behind this build`, the drill ran on the wrong
        file or before the release's first boot.
      - The printed `restore drill OK: <backup>` is the pass. That path is the backup to
        keep.
      - Online backup is safe under WAL, so the server may stay up.
      - Last exercised 2026-10-31 on a copy of a real-corpus database. See
        [`real-corpus-boot-2026-10-31.md`](docs/measurement/real-corpus-boot-2026-10-31.md).
- [ ] **Keep the pre-tag backup file** produced above, and note its path in the release
      notes.

## 6. Product & docs truth pass

- [ ] **[HUMAN] The five daily questions are answerable, and time-to-understand < 30 s is
      measured** (roadmap §5, Phase-4 exit gate). A human times it with a stopwatch.
      **Waived as a tag criterion 2026-10-30 (D9).** If it is not run, the release notes
      must not claim "< 30 s", and must say that time-to-understand is **unmeasured**.
- [ ] **Every displayed dollar traces to ground-truth tokens × a dated price.** Proven by
      P0-1 (§3), `apps/server/test/api-cost.test.ts` and the `db-pricing` suites. There is
      no silent zero-cost default.
- [ ] **[HUMAN] Pricing page re-read and real-corpus boot, before every tag** (D13(a),
      D17(a); this is what `WP-C6` and the `WP-C1` refresh cadence mean).
      1. Re-read Anthropic's published pricing page, and compare it with the newest seeded
         `model_pricing` rows (`pnpm --filter @agenthropic/server pricing list`). A
         changed rate or a new model lands before the tag, as a new dated migration or an
         audited `pricing set`. It is never an edit to an applied migration.
      2. Boot the release commit against the owner's real corpus:
         - run `pnpm start` with `DASHBOARD_TOKEN` set;
         - leave `CLAUDE_PROJECTS_DIR` unset, so it reads `~/.claude/projects`;
         - point `DASHBOARD_DB_PATH` at a throwaway database.

         Then read the `corpus replay:` line. `0 failed` is the pass. It is a red box if
         you see a `corpus replay failure:` line with a `PricingError`, or a
         `corpus replay: N tokens have no price row in force` warning. Seed the rate and
         boot again.

      Last done 2026-10-31 on `dcf3aee`:
      [`real-corpus-boot-2026-10-31.md`](docs/measurement/real-corpus-boot-2026-10-31.md).
      This is not a CI job, because the CI corpus uses deliberately unpriced synthetic
      models.
- [ ] **README truth pass.** Re-read [`README.md`](README.md) on the release commit.
      - Its Status section must describe v1.0.0, not the pre-tag state.
      - The Quickstart block must work as pasted on a clean machine.
      - It must name no test or migration counts.
- [ ] **Docs-site truth pass** (OSS-6). Re-read the landing page
      [`docs/site/README.md`](docs/site/README.md) and every page it calls current:
      [`guide/running.md`](docs/site/guide/running.md),
      [`usage/configuration.md`](docs/site/usage/configuration.md),
      [`usage/api.md`](docs/site/usage/api.md) and
      [`security/model.md`](docs/site/security/model.md).
      - Nothing may describe a shipped feature as unbuilt, or the reverse.
      - No count may be stated as current.
      - The "pre-1.0" wording on the landing page becomes the v1.0.0 wording.

      Grep for leftovers:
      `grep -rnE "pre-code|not started|twenty-[a-z]+ migrations|[0-9]+ tests" docs/site/README.md docs/site/guide/running.md docs/site/usage/`.
      Every match is either history marked as such, or a fix.
- [ ] **GitHub Pages deploy green.** Pages was created once, on 2026-08-25. It needs owner
      rights; a workflow token cannot create a site. The record is in the
      [decisions index](docs/site/contributing/decisions/README.md).
      Verify: `gh api repos/IvanBBaev/agenthropic --jq .has_pages` → `true`, and
      `curl -sSI https://ivanbbaev.github.io/agenthropic/ | head -1` → `HTTP/2 200`.

## 7. Version, changelog, tag, GitHub Release

- [ ] **Version bump.** Set `1.0.0` in the root `package.json` and in the five workspace
      manifests, and confirm that all six agree:

      ```bash
      npm pkg set version=1.0.0 && pnpm -r exec npm pkg set version=1.0.0
      node -e 'const fs=require("fs");const v=["package.json","apps/server/package.json","apps/web/package.json","packages/core/package.json","packages/shared/package.json","packages/test-fixtures/package.json"].map(f=>JSON.parse(fs.readFileSync(f)).version);if(new Set(v).size!==1||v[0]!=="1.0.0")throw new Error(v.join(" "));console.log("versions OK",v[0])'
      ```

      The workspace packages stay `private` and unpublished. The root tarball is
      documentation only (see its `files` list). Between releases,
      `apps/server/test/workspace-version-parity.test.ts` keeps the six versions equal
      in every gate, and fails if this list stops matching `pnpm-workspace.yaml`
      (OSS-18).
- [ ] **Cut the CHANGELOG** (OSS-4).
      1. Condense `[Unreleased]` into user-level bullets. Move WP ids and internal
         reasoning to `DONE.md`.
      2. Rename the condensed section `## [1.0.0] - YYYY-MM-DD`, and open a new empty
         `## [Unreleased]` above it.
      3. Add the link references at the bottom of `CHANGELOG.md`:

         ```markdown
         [Unreleased]: https://github.com/IvanBBaev/agenthropic/compare/v1.0.0...HEAD
         [1.0.0]: https://github.com/IvanBBaev/agenthropic/releases/tag/v1.0.0
         [0.3.0]: https://github.com/IvanBBaev/agenthropic/tree/<0.3.0 commit>
         ```

         `v0.3.0` was never tagged. **[HUMAN]** Decide whether to tag it retroactively on
         its 2026-08-25 commit. If it is tagged, the `[0.3.0]` reference becomes
         `…/releases/tag/v0.3.0`, and `[1.0.0]` can become `…/compare/v0.3.0...v1.0.0`.
- [ ] **Write `release-notes.md`** (untracked, in the scratch area). Use the `[1.0.0]`
      section plus everything below.
      - What v1.0 is: the persisted subagent DAG and the dollar-accurate cost cockpit,
        answering the five daily questions.
      - The opt-in alerting core, off by default (`DASHBOARD_ALERTS_CONFIG`).
      - The security posture: loopback only, no spawner, auth mandatory, same-origin SSE,
        tunnel-only remote access.
      - The ground-truth rule: token counts are read from `~/.claude/projects/*.jsonl`,
        never inferred.
      - If §0 LABEL-ME is open: the **PROVISIONAL** label, and the sentence "the hierarchy
        gate is NOT CERTIFIED by human labels".
      - Unless the §6 stopwatch box was run: "time-to-understand is unmeasured".
      - The §1 test totals and the §3 real-corpus counts, including any honest orphan.
      - The §5 backup: its path and date.
      - Links to the docs site and the MIT license.
- [ ] Update `DONE.md` with the v1.0 milestone entry.
- [ ] **[HUMAN] Release commit, tag, push and GitHub Release.** Commits and pushes happen
      only on the owner's explicit ask. Use an English message and **no AI attribution**:

      ```bash
      git tag -a v1.0.0 -m "v1.0.0 - the DAG + cost cockpit"
      git push origin main v1.0.0
      gh release create v1.0.0 --verify-tag --title "v1.0.0" --notes-file release-notes.md
      ```

- [ ] **Post-tag:**
      - CI green on the tag commit;
      - Pages deploy green;
      - README badges still render green;
      - `gh release view v1.0.0` shows the notes.

---

## Appendix — the full command block

Everything scriptable above, in order (each must exit 0):

```bash
pnpm install --frozen-lockfile
pnpm run typecheck
pnpm run lint
pnpm run format:check
pnpm --filter @agenthropic/web build
pnpm run test
pnpm run gate:spawner
pnpm run gate:licenses
AGENTHROPIC_REAL_CORPUS=~/.claude/projects pnpm test:real   # owner's machine only
# then: §5 live restore drill, §6 pricing re-read + real-corpus boot [HUMAN],
#       §0/§4/§6/§7 gh api verifications
```

Last full rehearsal on a non-release tree: **2026-10-27, `7dcf795`**. Every command
exited 0. Earlier rehearsals and their figures are recorded in [`DONE.md`](DONE.md). A
rehearsal ticks no box.
