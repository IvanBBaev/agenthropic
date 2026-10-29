# agenthropic: release-mechanics review for v1.0 (OSS / DevEx lens)

> Part of the [role reviews of 2026-10-29](README.md) — lens: **Senior OSS Maintainer / Release Engineer (OSS)**. Independent senior reviewer, read-only, on `main` at `db3f042`. Findings are de-duplicated and scheduled in [10-synthesis.md](10-synthesis.md).

Reviewed read-only on 2026-10-29 at HEAD `db3f042`, which is 5 commits ahead of origin. Evidence comes from the repo files, `gh`, `npm`/`curl` against the live registry, and `pnpm outdated` / `pnpm audit` run under Node 22.23.2.

## 1. Verdict

The engineering gates are in unusually good shape. CI is green, coverage is pinned at 100%, the spawner and license gates are real, branch protection is verified, and the Pages site serves 200. The release *mechanics* around those gates are not ready yet:

- Two claims the project makes to the public are false: the npm package and the private security-reporting channel.
- The production dependency tree has 19 high-severity advisories.
- The checklist never says to cut the CHANGELOG section or create a GitHub Release.
- The restore drill points at a stale database.
- The docs corpus (355k words tracked) is now the main maintenance cost and the main source of drift. The public docs-site landing page already contradicts the code.

None of this is hard to fix. All of it is S/M effort, and roughly 2–3 focused days closes every P0/P1. **Release-mechanics readiness for v1.0: 5/10.**

## 2. What is strong

- **The CI gate is real and ordered by cost.** `.github/workflows/ci.yml` runs the security gate first, then typecheck, lint, format, the web production build, tests with coverage thresholds, and the license gate. It sets `permissions: contents: read`, caches pnpm through `setup-node` (`cache: pnpm`), and runs in about 1.5–2.5 min (`gh run list`). PR #2 ("D15 demo") turned red as intended, which proves the gate bites.
- **Branch protection is verified live.** `gh api …/branches/main/protection` returns `{"contexts":["ci"],"enforce_admins":false,"strict":false}`, which matches the docs exactly.
- **The Pages workflow is least-privilege.** `id-token: write` is granted only on the deploy job, with `concurrency: pages` and `cancel-in-progress: false`. The site and `/site/` both return HTTP/2 200.
- **The toolchain is reproducible.** `packageManager: pnpm@11.11.0`, `.nvmrc`, `engines >=22 <23`, `engine-strict=true` and `scripts/check-node-version.mjs` all pin it. `pnpm-workspace.yaml` allowlists only the `better-sqlite3`/`esbuild` build scripts.
- **The license gate is a real CD-9 SPDX allowlist** with exactly one documented exception (`caniuse-lite`).
- **Repo hygiene in git is good.** 507 tracked files, a 2.7 MiB pack, nothing big. `spike/` (about 66 MB of real transcripts), raw `/due-diligence/`, `*.docx`, `data/`, `*.db` and the AI-harness files are correctly excluded (`.gitignore` plus `.git/info/exclude`). Secret scanning and push protection are on.
- **Contributor scaffolding exists.** `CONTRIBUTING.md`, issue forms (`bug_report.yml`, `feature_request.yml`, blank issues off) and a PR template with gate and invariant checklists. The community profile scores 85%.
- **RELEASE.md is concrete.** Nearly every box carries an exact command and expected output, `[HUMAN]` acts are labelled honestly, and there have been four scripted rehearsals.
- **The CHANGELOG declares Keep a Changelog + SemVer,** and the `[0.3.0]` section is well written for users (Added/Changed/Fixed/Security/"Not yet shipped").

## 3. Findings

| ID | Sev | Finding | Evidence | Recommendation | Effort | Verdict |
|---|---|---|---|---|---|---|
| OSS-1 | P0 | **The npm package the docs describe does not exist.** README and CHANGELOG say the `agenthropic` npm package "publishes documentation only… exists to hold the name". | `README.md:23-26`, `README.md:128`, `CHANGELOG.md:863`, `:926`. `npm view agenthropic` gives E404; `curl registry.npmjs.org/agenthropic` gives 404 (control `fastify` gives 200). RELEASE.md has no publish step. | Pick one: (a) publish the docs-only tarball now with `npm publish --dry-run` checked first and add a §7 box, or (b) set root `"private": true`, drop `publishConfig`/`files`, and delete the claim. Option (b) is simpler and is my recommendation; a docs-only package holding a name gives users nothing. | S | CONFIRMED |
| OSS-2 | P0/P1 | **19 high-severity advisories in production dependencies.** `fastify` is at 5.10.0 while 5.12.7 is current. | `pnpm audit --prod`: 32 vulns (4 low / 9 moderate / 19 high). They sit in `fast-uri` (14 high), `fastify` (4 high, 3 moderate) and `find-my-way` (1 high). `pnpm outdated`: fastify 5.10.0 vs 5.12.7. Dependabot security updates are `disabled`; there is no `dependabot.yml` or `renovate.json`. | Bump fastify (which pulls in find-my-way/fast-uri) and re-run the gates. Add a `pnpm audit --prod --audit-level=high` box to RELEASE §1 (or to CI). Enable Dependabot security updates. The loopback-only bind lowers real-world exposure, but no v1.0 tag should ship with known-high advisories. | S | CONFIRMED (exploitability PLAUSIBLE-low because of the loopback bind) |
| OSS-3 | P1 | **SECURITY.md sends reporters to a disabled channel.** It says to use GitHub private vulnerability reporting, which is off. | `SECURITY.md:37-51`; `gh api …/private-vulnerability-reporting` returns `{"enabled":false}`. The fallback (SECURITY.md:44-48) asks the reporter to open a public issue requesting a private channel. | Enable it (Settings → Code security). Add a RELEASE §0 verify box. | S | CONFIRMED |
| OSS-4 | P1 | **RELEASE §7 does not cover the CHANGELOG or a GitHub Release.** There is no step to cut `[Unreleased]` into `[1.0.0] - date`, no step to add compare links, and no `gh release create`. Release notes are listed as required content but have no source file. `[Unreleased]` is about 850 lines (`CHANGELOG.md:10–859`). | `grep "CHANGELOG\|gh release" RELEASE.md` returns nothing. `gh release list` is empty, and `gh api …/tags` is empty: v0.3.0 was never tagged. The CHANGELOG has no `[x]: https://…/compare/…` link refs at the bottom. | Add steps: rename the section, add link refs, extract the section into `release-notes.md`, then `gh release create v1.0.0 --verify-tag --notes-file …`. Condense `[Unreleased]` into user-level bullets (see §4). Decide whether to tag `v0.3.0` retroactively on the 2026-08-25 commit. | M | CONFIRMED |
| OSS-5 | P1 | **The live restore drill targets the wrong database.** RELEASE §5 runs from the repo root with the default `data/agenthropic.db`. The server's default is cwd-relative, and `pnpm --filter` runs it in `apps/server/`, so the live DB lives at `apps/server/data/…`, as the README says. The root `data/agenthropic.db` is a 94 KB file from 2026-07-13, so the drill prints "OK" against a stale copy. | `RELEASE.md` §5 (`process.env.DASHBOARD_DB_PATH ?? "data/agenthropic.db"`); `apps/server/src/config.ts:25`; `README.md` dev path; `ls data/` shows a Jul 13 db; `apps/server/data` is absent here. | Make the drill *require* `DASHBOARD_DB_PATH` (fail if unset) and print the size and mtime of the source. | S | CONFIRMED |
| OSS-6 | P1 | **The public docs landing page is stale.** It says "twenty-one migrations" (the README says 24) and that "v2.0 alerting (Telegram) is not started and may never start", while the alerting core ships dark in v1.0.0. The amendment block says "refreshed… most recently on 2026-09-19". | `docs/site/README.md:16`, `:44`, `:57`; `CHANGELOG.md` Unreleased ("Opt-in Telegram alerts"); RELEASE §4 decision 2026-10-29. | Rewrite the landing page as a short, current index; see the §4 proposal. Add a RELEASE §6 box for a docs-site truth pass. | S | CONFIRMED |
| OSS-7 | P1 | **The README reads as a history log, not a first impression.** It is 280 lines and includes an "AMENDED 2026-09-23 (J-1)" paragraph in the Quickstart, a 10-date test-count chain (`README.md:240`), and "this paragraph used to say…" narratives for branch protection and Pages (about 40 lines). `corepack enable` is mentioned in prose but missing from the copy-paste block. | `README.md:30-39`, `:140-155`, `:238-247`, `:253-270`. | Cut it to about 120 lines: pitch, screenshot, 6-line Quickstart (with `corepack enable` + `nvm use`), status, security, links. Move the history to the decisions index. Clone to running is otherwise ~5 min and plausible. | S | CONFIRMED |
| OSS-8 | P1 | **RELEASE.md has stale, self-contradicting state.** It says "known open as of 2026-07-29" (line 18), and "KC-3 is 2026-10-12" (line 32) with no result recorded, although that date has passed. §4's LICENSE box reads "Resolved" but is unticked, while other boxes are pre-ticked `[x]`, despite the rule "every box… is ticked on the release commit only". The rehearsal appendix is about 30 lines of dated narrative. | `RELEASE.md:18`, `:32`, §4, §6, appendix. | Before the tag: untick everything, record the KC-3 outcome, move rehearsal history to DONE.md, and keep one "last rehearsal: date / sha / result" line. | S | CONFIRMED |
| OSS-9 | P1 | **There are about 7 `[HUMAN]` boxes, several of them open since July:** LABEL-ME (224 blanks), the KC-0 physical acts, the stopwatch measurement, the pricing re-read and the attribution review. Without an explicit waive path the release can stall on them. | RELEASE §0, §3, §6. | Ask the owner now whether each one is "do" or "waive in writing", and put the waiver text in the release notes. | S | CONFIRMED |
| OSS-10 | P2 | **Actions are pinned by major tag, not SHA,** and nothing updates them. | `actions/checkout@v7`, `setup-node@v7`, `configure-pages@v6`, `jekyll-build-pages@v1`, `upload-pages-artifact@v5`, `deploy-pages@v5`. | Pin by SHA with a version comment and add `dependabot.yml` for the `github-actions` and `npm` ecosystems (grouped, weekly). | S | CONFIRMED |
| OSS-11 | P2 | **CI is missing `timeout-minutes`, `concurrency` (cancel superseded PR runs) and a release/tag trigger.** | `ci.yml` | Add `timeout-minutes: 15` and a PR concurrency group. Optionally trigger on `push: tags: ['v*']` so "CI green on the tag ref" (§7 post-tag) actually produces a run. Today it does not: `on.push.branches: [main]` only. | S | CONFIRMED |
| OSS-12 | P2 | **The Node 22-only pin outlives Node 22.** Node 22 reaches EOL around April 2027, inside v1.x's life. `@types/node` is at 22.x vs latest 26. | `package.json` engines; `.nvmrc`. | Plan for v1.x: add Node 24 to a CI matrix, then widen engines. Document the support policy. | M | PLAUSIBLE (EOL date from memory) |
| OSS-13 | P2 | **Ordinary dependency drift, and no update policy.** | `pnpm outdated -r`: @vitest/coverage-v8 4→5, @vitejs/plugin-react 5→6, @eslint/js 9→10, @types/better-sqlite3 7→9, tsx 4.23.0→4.23.15, react 19.2→19.3. | Do minors before the tag, majors in v1.x through Dependabot groups. | M | CONFIRMED |
| OSS-14 | P2 | **The public repo ships agent-operations content.** `TODO.md` (1375 lines) quotes Bulgarian chat instructions to agents ("пускай Fable агенти…"), carries a "Context-free session?" header and a stale "No production code starts until WP-S7 reads GO". `docs/due-diligence/projects/*` publishes assessments of named third-party projects (disler, simple10, …). | `TODO.md:1-30`; `git ls-files docs/due-diligence`. | Move TODO/DONE to GitHub Issues/Milestones or `docs/project/` with a neutral header. Review the rival assessments for tone, or move them out of the published site. | M | CONFIRMED |
| OSS-15 | P2 | **Repo metadata gaps.** About `homepage` is `null` (the Pages URL is not set). No `.github/FUNDING.yml` although the README has 3 sponsor links. No CODE_OF_CONDUCT. `has_wiki: true`. | `gh api repos/…` | Set the homepage, add FUNDING.yml and a Contributor Covenant, and disable the wiki unless it is used. | S | CONFIRMED |
| OSS-16 | P2 | **The docs-site generator is still "deferred".** The site is Primer Jekyll with no navigation or search, and it publishes the internal analysis corpus too. About 60 lines of history live in `pages.yml` comments. | `pages.yml` header; `docs/site/README.md:1-6`. | Decide DOC-P1 (MkDocs Material or VitePress) in v1.x and publish `docs/site` only. Move the YAML histories into an ADR. | M | CONFIRMED |
| OSS-17 | P3 | **Local leftovers.** A local tag `backup/pre-deattribution-2026-10-05` (not on the remote, which is good). A stale remote-tracking ref `origin/claude/fervent-maxwell-2hmdro` (the remote has only `main`). A stale `data/agenthropic.db` from July. 5 unpushed commits. | `git tag -l`, `git branch -a`, `gh api …/branches`. | Run `git fetch --prune`, delete the backup tag once it is no longer needed, and push before the release window. | S | CONFIRMED |
| OSS-18 | P3 | **Version bumps are manual across 6 manifests.** | RELEASE §7 | Use a one-line `pnpm -r exec npm pkg set version=1.0.0` plus the root, or a check script asserting all six versions are equal. | S | CONFIRMED |

## 4. Docs-corpus health

**Size.** There are 109 tracked Markdown files and **~355k words**, more than double the ~150k in the brief. `docs/site/` is 45 files and ~187k words, about 4,150 words per page; the largest are `data-model.md` (10.2k), `ingest-reconciliation.md` (10.1k) and `usage/api.md` (9.2k). `docs/analysis/` is ~86k words. The root files are TODO (127 KB), CHANGELOG (91 KB), DONE (62 KB), RELEASE (31 KB) and SECURITY (21 KB). For a single-maintainer, pre-1.0 app that is about the size of a book.

**Duplication and count chains.**
- The same test-count chain (195/3757 ← 3747 ← 3736 ← … ← 2428) appears in `README.md:240` and RELEASE §1, and a truncated copy in `docs/site/README.md:29`.
- The branch-protection story is told in at least 4 places: ci.yml, README, RELEASE §0, and the decisions index.
- The Pages-enablement story is told in 3: pages.yml, README, RELEASE §6.
- The Node-guard "AMENDED J-1" paragraph appears in both README and CONTRIBUTING.

**Banners.** Amendment/"used to say" markers concentrate in public pages: `usage/api.md` 17, `hooks/README.md` 11, `dashboard.md` 9, `ingest-reconciliation.md` 9, `cost-model.md` 7. Several pages still open with "pre-code" text and then an "Update — as built" block (`data-model.md:16-20`, `contributing/index.md:42`, `faq.md:18`).

**Cost.** 23 of 58 commits are `docs:` commits, and 5 are explicitly "truth pass / test-count". Every test added forces edits in 2–3 files, and drift is already visible (OSS-6). The corpus has crossed from asset into liability: its main effect on a new reader is to make the current truth harder to find.

**Simplification proposal (one pass, about 1 day):**
1. **One canonical number, zero chains.** Test counts and migration counts live in exactly one generated place: a `pnpm run stats` → `docs/site/_stats.md`, or just the CI log. Everywhere else says "see CI" and never names a figure. Delete every dated history chain.
2. **Current-truth pages only in `docs/site/`.** Rewrite each "written pre-code; amended as-built" page to its as-built text and drop the amendment banners. History belongs in git and in ADRs; the STYLE-GUIDE's "As-built amendments" convention should be retired after v1.0.
3. **Split public from internal.** Publish `docs/site/` only. Move `docs/analysis/` and `docs/due-diligence/` under `docs/archive/` with a one-line "historical design record, frozen 2026-07" header, and exclude them from Pages.
4. **Root files:**
   - README about 120 lines.
   - CHANGELOG: user-facing bullets only. `[1.0.0]` should be about 60–100 lines; move WP ids and internal reasoning to DONE.
   - RELEASE.md: checklist only, about 200 lines, no rehearsal narrative.
   - TODO/DONE: move to Issues/Milestones after v1.0, or freeze them.
5. **Workflow YAML comments:** at most 5 lines each, linking to an ADR.

## 5. Recommendations mapped to the roadmap

**Before the v1.0 tag (by 2026-12-01):**
- OSS-1: resolve the npm claim.
- OSS-2: fastify bump, audit box, Dependabot security updates.
- OSS-3: enable private vulnerability reporting.
- OSS-4: CHANGELOG cut, compare links, `gh release create`.
- OSS-5: fix the drill path.
- OSS-6, OSS-7: landing-page and README rewrite.
- OSS-8: RELEASE.md cleanup.
- OSS-9: get waive/do decisions on the `[HUMAN]` boxes.
- OSS-11: tag trigger and timeouts.
- OSS-15: About homepage and FUNDING.yml.
- Docs steps 1, 2 (for the README/landing page) and 5.
- Push the 5 local commits well before the release commit so CI history is continuous.

**v1.x:**
- OSS-10: SHA pinning plus Dependabot.
- OSS-12: Node 24 matrix and support policy.
- OSS-13: major dependency bumps.
- OSS-14: TODO/DONE to Issues, due-diligence review.
- OSS-16: choose the docs generator, publish `docs/site` only.
- OSS-18: version script.
- The rest of the docs simplification.
- Optionally a tag-triggered release workflow with build provenance attestation; low priority for a clone-and-run app.

**v2.0:** reconsider distribution (a `npx agenthropic` bin or a container image) only if real users ask; it would need a server build step, which conflicts with the deliberate tsx/migration-checksum choice.

**Never:**
- An npm package that exists only to hold a name.
- A coverage badge written by hand (the README is right).
- `enforce_admins` on with a single maintainer (the documented choice is sound).

## 6. Questions for the owner

1. **npm:** should `agenthropic` be published at all (docs-only placeholder), or should the root become `private: true` and the claims be removed? Right now the docs say something that is not true.
2. Will you tag **v0.3.0** retroactively (on the 2026-08-25 commit) so the CHANGELOG's released section has a tag and a compare base?
3. For each `[HUMAN]` box (LABEL-ME 224 edges, KC-0 physical acts, the <30s stopwatch measurement, the attribution review): do it, or waive it in writing in the release notes?
4. May `docs/analysis/` and `docs/due-diligence/` (assessments of named third-party projects) leave the published Pages site?
5. Should TODO.md/DONE.md stay as public root files after v1.0, or move to GitHub Issues/Milestones?
6. Should GitHub Release notes be written by hand or extracted from the `[1.0.0]` CHANGELOG section? I recommend extraction, with a CHANGELOG condensed to user level.
7. Which Node line does v1.x support after Node 22's EOL (about April 2027)?
