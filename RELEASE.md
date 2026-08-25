# RELEASE.md — the v1.0 merge/tag checklist (WP-X9)

This is the release checklist required by
[`docs/analysis/development-plan.md`](docs/analysis/development-plan.md) §5 (`WP-X9`:
"`RELEASE.md` enumerates every CD-7 build-failing gate + CD-9 provenance check with a
verification step each") and scheduled into the v1.0 tail by the schedule of record,
[`docs/analysis/roadmap-v1-v2-2026-07-06.md`](docs/analysis/roadmap-v1-v2-2026-07-06.md)
§5: **"`RELEASE.md` (X9) executed once for real. Tag v1.0."** — the checklist must be
*executed*, not merely exist, on the exact commit that gets tagged.

Rules of this document:

- Every box is backed by a **real command or a real file in this repo**, or is
  explicitly marked **[HUMAN]** — an act only the owner can perform and that cannot be
  automated. No aspirational steps.
- Run everything from the repo root, on a clean checkout of the release commit.
- **Any red box = no tag.** There is no partial credit.
- Boxes marked **[BLOCKER — not true today]** describe a gap that is known open as of
  2026-07-29 and must be closed (and this file updated) before the tag.

---

## 0. Preconditions and human ratifications

- [ ] **[HUMAN] KC calendar check.** Compare today's date against the kill-checkpoint
      calendar at the top of [`TODO.md`](TODO.md) and roadmap §4. The v1.0 hard date is
      **2026-12-01 (KC-4)**. Note honestly: KC-0 (2026-07-13) and KC-1 (2026-07-27)
      both passed unmet and work continued only under the owner overrides recorded in
      `TODO.md`; the tag decision is the owner's, made with that record in view.
- [ ] **[HUMAN] LABEL-ME ratification.** The five
      `spike/corpus/sessions/<short>/LABEL-ME.md` trees (224 per-edge blanks) are
      hand-filled by Ivan ([`docs/analysis/phase0-verdict.md`](docs/analysis/phase0-verdict.md)
      §"what still needs Ivan"). Until then every spike-derived number is
      **PROVISIONAL** and the release notes must say so. By definition this cannot be
      automated.
- [ ] **[HUMAN] The two KC-0 physical acts** — friction log opened; ≥1 rival dashboard
      installed — recorded open in `TODO.md` as of 2026-07-29. Close or consciously
      waive them in writing before tagging.
- [ ] **[HUMAN] Branch protection.** CD-7 says coverage **"blocks merges"**; the CI
      workflow itself notes that blocking requires a branch-protection rule
      ([`.github/workflows/ci.yml`](.github/workflows/ci.yml) header). As of 2026-07-29
      `main` is **not protected** (`gh api repos/IvanBBaev/agenthropic/branches/main/protection`
      → 404). Enable: Settings → Branches → require the `CI` check. Verify:
      `gh api repos/IvanBBaev/agenthropic/branches/main/protection --jq '.required_status_checks.contexts'`
- [ ] **CI green on the release commit.** Verify:
      `gh api "repos/IvanBBaev/agenthropic/actions/workflows/ci.yml/runs?branch=main&per_page=1" --jq '.workflow_runs[0] | {head_sha, conclusion}'`
      — `conclusion` must be `success` and `head_sha` must equal the commit to be tagged.

## 1. Build-failing quality gates (CD-7)

CD-7 verbatim ([`docs/analysis/concept-analysis-v2.md`](docs/analysis/concept-analysis-v2.md) §3):
**"Security + the coverage gate are boundary conditions from commit one, CI-blocking:
loopback-or-fail bind; mandatory `DASHBOARD_TOKEN`-or-fail-startup (timing-safe
compare); SSE same-origin; no-spawner grep/static gate; no-SSRF (webhook targets
operator-configured, never dialed from a payload); WAL + tested restore; >90% coverage
blocks merges."**

Run each gate locally on the release commit; all six are the same commands CI runs
(`.github/workflows/ci.yml`):

- [ ] `pnpm run typecheck`
- [ ] `pnpm run lint`
- [ ] `pnpm run format:check`
- [ ] `pnpm run test` — the full workspace suite (**106 test files / 1554 tests** on a
      local run of 2026-08-15; the figure moves as the tree does, so re-measure on the
      release commit rather than trusting this line). Coverage: **all five** packages —
      `@agenthropic/server`, `@agenthropic/web`, `@agenthropic/core`,
      `@agenthropic/shared` and `@agenthropic/test-fixtures` — run `vitest run --coverage`
      against **100/100/100/100** thresholds (each package's `vitest.config.ts`).
- [ ] **Read the coverage headroom before tagging — the gate passing is not the same as
      the gate being comfortable.** At a 100% global threshold there is no per-file
      headroom left to read: every file is at 100% or the run is red, so the "thin file
      hiding behind a fat one" failure this box was written to catch can no longer
      happen. What is worth reading instead is *how* the 100% was reached — a test that
      only executes a line without asserting on it satisfies the gate and proves nothing,
      and no threshold can detect that. Three cheap ways to manufacture a 100% are
      guarded by tests that read the configs and sources as text — lowering a threshold,
      adding a coverage `exclude`, and reintroducing an ignore pragma — but **the guard
      is not uniform across the five packages, so read this before ticking the box.**
      `apps/server`, `packages/core`, `packages/shared` and `packages/test-fixtures`
      assert all three. `apps/web` asserts only the pragma sweep: it cannot assert the
      absence of an `exclude`, because it legitimately carries one (`src/main.tsx`,
      `src/vite-env.d.ts`), and it does not assert its four thresholds either. So a
      change that widened the web exclude list or lowered the web thresholds would pass
      CI silently. Diff `apps/web/vitest.config.ts` by hand on the release commit;
      `docs/site/contributing/testing.md` §"Three asymmetries" records this as a real gap
      in the mechanism rather than a technicality.
      _(Historical notes: until 2026-07-30 `apps/web` ran `vitest run` without
      `--coverage`, so its configured thresholds silently never executed;
      `packages/test-fixtures` was outside the gate scope entirely until it was pulled
      in. The bar was raised from the CD-7 floor of >90% to 100% across all five packages
      after that. Earlier revisions of this box quoted 90/90/90/90 thresholds, a
      four-package scope, and per-package figures below 100% — all three are superseded.)_
- [ ] `pnpm run gate:spawner` — WP-F5 static no-spawner / no-wide-bind / no-WebSocket /
      no-eval gate over `apps/`, `packages/`, `scripts/`, `hooks/`
      ([`scripts/check-no-spawner.mjs`](scripts/check-no-spawner.mjs)). The allowlist is
      logged on every run — **read it**; it must contain only the policy file itself.
- [ ] `pnpm run gate:licenses` — the CD-9 allowlist gate (see §4).

## 2. Security invariants re-verified on the release commit

Each invariant below names where it is **enforced** (source) and where it is **proven**
(test — green as part of the §1 `pnpm run test` box; the file paths are the audit
trail).

- [ ] **Loopback-only bind (`127.0.0.1`), never `0.0.0.0`** — enforced at runtime by
      `enforceLoopbackOrExit` in `apps/server/src/index.ts` (post-listen address
      check) with `HOST` pinned in `apps/server/src/config.ts`; proven by
      `apps/server/test/security-contract.test.ts`; statically guarded by
      `gate:spawner`'s wide-bind patterns.
- [ ] **Mandatory `DASHBOARD_TOKEN` or the server refuses to start; timing-safe
      compare** — enforced in `apps/server/src/config.ts` + the auth layer under
      `apps/server/src/api/`; proven by `apps/server/test/config.test.ts` and
      `apps/server/test/security-contract.test.ts`.
- [ ] **All endpoints auth-gated** — proven by `apps/server/test/security-contract.test.ts`
      and the per-route suites (`apps/server/test/api-*.test.ts`,
      `apps/server/test/hooks-routes.test.ts`): unauthenticated requests are rejected,
      nothing is stored.
- [ ] **SSE same-origin (CD-5); SSE is the only realtime transport, no WebSocket** —
      proven by `apps/server/test/server-sse.test.ts` /
      `apps/server/test/realtime-stream.test.ts`; `gate:spawner` also fails the build
      on any WebSocket-server pattern.
- [ ] **No browser-driven subprocess spawner — anywhere** — `pnpm run gate:spawner`
      (§1). The sole sanctioned subprocess in the repo is the fixed-argv
      `pnpm licenses list` inside `scripts/check-licenses.mjs`, opted out line-by-line
      with audited inline markers, never whole-file.
- [ ] **No SSRF — no code path dials a payload-supplied URL.** v1.0 ships **no**
      webhook/alert dispatcher at all (the A-track is post-1.0, roadmap §6), so the
      strongest form holds: there is no outbound-dial feature to misuse. **Verified by
      review and by the grep below — not by `gate:spawner`,** which carries no
      outbound-HTTP pattern at all and would pass a newly added `fetch()` without
      comment. Run:
      `grep -rnE "\bfetch\(|node:https?|\baxios\b|\bundici\b" apps/server/src packages/*/src`
      — expect empty (matches in `apps/web/src` are the browser bundle calling this
      server's own relative `/api` paths, and are not the server process). The full
      no-SSRF negative corpus is a v2.0 gate (`WP-A10`).
- [ ] **Secrets never in SQLite, never on the SSE stream, never in logs** — redaction
      at the ingest boundary proven by `apps/server/test/hooks-redact.test.ts`; log
      hygiene by `apps/server/test/server-logging.test.ts`. v1.0 stores no third-party
      secret at all (`token_ref` / Telegram is post-1.0, CD-10).
- [ ] **The corpus (`~/.claude/projects`) is read-only to this system** — the corpus
      fs-port is read-only **by construction**: `apps/server/src/corpus/fs-port.ts` and
      `apps/server/src/corpus/node-corpus-fs.ts` import no write/rename/unlink/chmod
      symbol (stated in-file; spot-check with
      `grep -rnE "writeFile|createWriteStream|unlink|rename\(|chmod" apps/server/src/corpus/`
      — expect matches only in those comments). Proven by
      `apps/server/test/ingest-corpus-watcher.test.ts`.
- [ ] **SQLite in WAL mode, enforced** — `apps/server/src/db/connection.ts` **throws**
      unless `journal_mode=wal` after open; proven by
      `apps/server/test/db-connection.test.ts`. Tested restore: §5.
- [ ] **`events_raw` is append-only — no UPDATE/DELETE path (CD-4: "enforced by
      test")** — proven by `apps/server/test/events-raw.test.ts`.

## 3. The three P0 moat proofs — tag blockers

The canonical P0 set ([`docs/site/contributing/testing.md`](docs/site/contributing/testing.md)
§4; `WP-X3`/`WP-IN13`): release-blocking, and no other feature work substitutes for
them. Test bodies live under `apps/server/test/p0/`.

> **Status honesty (updated 2026-08-07):** the three P0 test bodies now exist and pass
> (`apps/server/test/p0/`, 3 files / 13 tests green). What is still missing is the half
> that makes them *blockers*: CI is **not merge-blocking**, because `main` is not
> branch-protected (§0). A passing test that nothing gates on is a test, not a gate — so
> these boxes stay **unticked**, and they are ticked on the release commit, against that
> commit's CI run, not by pointing at a local run.

- [ ] **P0-1 — Σ `token_usage` == JSONL exact, per session** — the ground-truth-tokens
      invariant holds in the projected data; zero drift, no silent rounding, no double
      count.
- [ ] **P0-2 — double-replay → byte-identical DB state** — replay-on-startup is
      deterministic and safe on every process start.
- [ ] **P0-3 — DAG-rebuild from JSONL alone, after a simulated outage** — the persisted
      `orchestration_edges` tree survives the exact failure mode it exists to survive.
- [ ] All three are **green in CI on the release commit and merge-blocking** (via the
      §0 branch-protection box), per `WP-IN13`'s Done-when.
- [ ] **[HUMAN-dependent] Hierarchy correctness ≥95%** vs. the labeled corpus
      (testing.md §4) — this bar is only meaningful once the §0 LABEL-ME box is done,
      because it is scored against Ivan's hand-labeled trees, not self-check.

## 4. CD-9 provenance / licensing checks

CD-9 ([`docs/analysis/concept-analysis-v2.md`](docs/analysis/concept-analysis-v2.md) §3,
the source's strikethrough rendered inline):
**"Per-artifact licensing. COPY simple10 tree/ports + hoangsonww Telegram/webhook
schema (dropped — single better-sqlite3 driver per best-path §6.3) with attribution;
CLEAN-ROOM reimplement cast `controlGate` + delegation-savings and nirdiamant
checkpoint (never view their source while writing). Enforced by a CI provenance/license
scan."**

- [ ] `pnpm run gate:licenses` — SPDX allowlist over **every** installed workspace
      dependency, AND/OR expressions handled, with exactly one documented per-package
      exception (`caniuse-lite` / CC-BY-4.0) — [`scripts/check-licenses.mjs`](scripts/check-licenses.mjs).
- [ ] **[HUMAN] COPY-with-attribution review.** For every artifact actually copied into
      the v1.0 tree (the simple10 tree/ports patterns), attribution is present in
      [`docs/site/contributing/licensing.md`](docs/site/contributing/licensing.md).
      This is a judgment review of code vs. attribution page — a human read, not a
      script.
- [ ] **Nothing post-1.0 leaked in:** the hoangsonww Telegram/webhook schema and the
      cast/nirdiamant clean-room reimplementations belong to the post-1.0 A-track.
      Confirm none of them ships in v1.0 (nothing to attribute / attest yet):
      `grep -rniE "telegram|controlGate|nirdiamant" apps/ packages/ --include='*.ts' -l`
      — expected empty.
- [ ] **`LICENSE` (MIT) committed and pushed.** **Resolved 2026-07-30** — tracked in
      commit `9b6c6b3`; `gh api repos/IvanBBaev/agenthropic --jq .license.spdx_id`
      now returns `MIT`, not `null`. Re-verify with that same command at tag time.
      *(It was an open blocker from 2026-07-29 until that push: the file existed
      locally but was untracked, so the public repository carried no grant.)*

## 5. Backup → restore drill (CD-7 "WAL + tested restore", WP-F8)

- [ ] **Automated proof** — `apps/server/test/backup.test.ts` (green in the §1 run):
      real online backup via better-sqlite3, restore, reopen through the WP-D2 pragma
      assertions, `PRAGMA integrity_check` must read `ok`
      ([`apps/server/src/db/backup.ts`](apps/server/src/db/backup.ts)).
- [ ] **Live drill on the real database** — actually exercised once for real, per the
      Phase-6 exit-gate wording "an exercised backup restore" (development-plan §3).
      The command below uses the same better-sqlite3 online-backup API that
      `backupDatabase`/`restoreDatabase` wrap (the wrappers themselves are proven by
      `backup.test.ts` above; the repo build is declaration-only, so the drill drives
      the underlying API directly). It opens the live DB **read-only**, backs it up,
      reopens the copy and fails unless `PRAGMA integrity_check` reads `ok`:

      ```bash
      node --input-type=module -e '
      import { createRequire } from "node:module";
      import { mkdirSync } from "node:fs";
      const require = createRequire(process.cwd() + "/apps/server/");
      const Database = require("better-sqlite3");
      const src = process.env.DASHBOARD_DB_PATH ?? "data/agenthropic.db";
      mkdirSync("data/backups", { recursive: true });
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      const backupPath = `data/backups/pre-v1.0-${stamp}.db`;
      const live = new Database(src, { readonly: true });
      await live.backup(backupPath);
      live.close();
      const restored = new Database(backupPath);
      const result = restored.pragma("integrity_check", { simple: true });
      restored.close();
      if (result !== "ok") { console.error("integrity_check FAILED:", result); process.exit(1); }
      console.log("restore drill OK:", backupPath);
      '
      ```

      "restore drill OK" printed **is** the drill passing. (Online backup is safe
      under WAL — the server may stay up. Verified working against the live
      `data/agenthropic.db` on 2026-07-29.)

- [ ] **Keep the pre-tag backup file** produced above; note its path in the release
      notes.

## 6. Product & docs truth pass

- [ ] **[HUMAN] The five daily questions are answerable and time-to-understand < 30s is
      measured, not asserted** (roadmap §5, Phase-4 exit gate) — a human sits in front
      of the dashboard with a stopwatch. Record the measurement.
- [ ] **Every displayed dollar traces to ground-truth tokens × a dated price** — proven
      by P0-1 (§3) plus `apps/server/test/api-cost.test.ts` / `db-pricing` suites; no
      silent zero-cost default (CD-3/CD-4 cost-trust chain).
- [ ] **README truth pass.** **Resolved 2026-07-30** — the "Pre-code… no application
      code yet" Status section was replaced with what actually runs, and the CI badge
      now attests to the full build: CI is `success` on `9b6c6b3`, the first pushed
      commit that contains Waves 1–4 (before it, the badge described only the Phase-1
      foundation). Re-read the section at tag time; it must describe v1.0, not this
      pre-tag state.
- [ ] **[HUMAN] Enable GitHub Pages, then confirm the deploy.** The
      `Docs site (GitHub Pages)` workflow
      ([`.github/workflows/pages.yml`](.github/workflows/pages.yml)) must be green on the
      release commit — but it cannot go green until the owner turns Pages on once.
      **An earlier revision of this checklist claimed otherwise and was wrong.** It said
      that passing `enablement: true` to `configure-pages` lets the workflow turn Pages
      on through the API with the `pages: write` permission it already holds, and struck
      the [HUMAN] tag on that basis. `pages: write` authorises _deploying_ to an existing
      Pages site; it does not authorise _creating_ one. Creation needs repo
      administration rights, which the default `GITHUB_TOKEN` deliberately never has.
      Three runs prove it, all dead in `configure-pages`:
      `30528892265` (on `9b6c6b3`, input still `false`) with
      `Get Pages site failed … Not Found`, then `31318246506` and `31879212583` with
      `enablement: true` and `Create Pages site failed. Error: Resource not accessible by integration`.
      The owner action is one of:
      Settings → Pages → Source: "GitHub Actions", or
      `gh api -X POST repos/IvanBBaev/agenthropic/pages -f build_type=workflow` with an
      admin-scoped token. Only the owner can do either; the repository cannot do it for
      itself. Once Pages exists, the workflow deploys on its own and the step fails
      loudly rather than deploying nowhere, so this box is ticked by a green run, never
      by assumption.
      Verify: `gh api repos/IvanBBaev/agenthropic --jq .has_pages` → `true`.

## 7. Version, tag, release notes

- [ ] Bump `version` in the root [`package.json`](package.json) from `0.3.0` to
      `1.0.0`, and keep the five workspace `package.json` files on the same number
      (they are `private` and unpublished; the root version is the release version,
      and the root tarball is documentation only - see its `files` list).
- [ ] Update `DONE.md` with the v1.0 milestone entry (it is the milestone record the
      release notes derive from).
- [ ] **[HUMAN] Release commit and tag** — commits and pushes happen only on the
      owner's explicit ask (repo rule). English commit message, **no AI attribution**:

      ```bash
      git tag -a v1.0.0 -m "v1.0.0 - the DAG + cost cockpit"
      git push origin main --tags
      ```

- [ ] **Release notes must contain, verbatim honesty included:**
  - what v1.0 is: the persisted subagent DAG + dollar-accurate cost cockpit answering
    the five daily questions — and that alerts are explicitly **not** in v1.0;
  - the security posture paragraph (loopback-only, no spawner, auth-mandatory,
    same-origin SSE, tunnel-only remote access);
  - the ground-truth rule: token counts read from `~/.claude/projects/*.jsonl`, never
    inferred;
  - the **PROVISIONAL** label on all spike-derived accuracy numbers if the §0 LABEL-ME
    box is still open at tag time;
  - the backup drilled in §5 (path + date);
  - a link to the GitHub Pages docs site and the MIT license.
- [ ] **Post-tag:** CI green on the tag ref; Pages deploy green; badges in `README.md`
      still render green.

---

## Appendix — the full command block

Everything scriptable above, in order (each must exit 0):

```bash
pnpm install --frozen-lockfile
pnpm run typecheck
pnpm run lint
pnpm run format:check
pnpm run test
pnpm run gate:spawner
pnpm run gate:licenses
# then: §5 live restore drill, §0/§4/§6 gh api verifications
```
