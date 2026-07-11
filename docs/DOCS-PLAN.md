# agenthropic — Documentation Plan

Decomposition of the **project documentation** (the public GitHub Pages docs site +
the durable in-repo reference/contributor docs) into **independent, agent-distributable
work packages** — one WP → one page → one agent → one PR, in the same spirit as
[`analysis/development-plan.md`](analysis/development-plan.md).

> **Status:** decomposition + first authoring pass **done**. This plan decomposes the docs
> deliverable so it can be written in parallel. It is **not** gated on the Phase-0 GO
> verdict — the design/analysis source material already exists, so all **conceptual**
> documentation (Tracks O/A/S/C) was writable **now**, before any code, and has been
> written. The **usage** docs (Track U) are now also written — as **design-target
> (pre-Phase-0)** reference, each re-validated against real behavior when its build phase lands.
>
> **Progress (2026-07-06):**
> - **Enablers** `DOC-P0` (IA freeze, §2) and `DOC-P3` (style guide) — **done**.
> - **Content fan-out** `DOC-O1…O5`, `DOC-A1…A7`, `DOC-S1…S5`, `DOC-C1…C5` — **written**
>   (22 pages) via a 22-writer + 22-reviewer parallel Workflow, each traced to its sources.
>   ADR set `DOC-C4` — **13 ADR files** (CD-1…CD-10, LB1, LB2, docs-generator).
> - **Usage** `DOC-U1…U6` — **written as design-target (pre-Phase-0)** via a second
>   6-writer + 6-reviewer Workflow (196–330 lines each), from the design/build-plan sources,
>   each carrying a prominent *pre-Phase-0* banner and marking undecided values `(planned)` /
>   `(leaning — unconfirmed)`. They no longer contradict the build; each is **validated
>   against real behavior** when its phase lands (getting-started/config P1, hooks P2/3,
>   dashboard/api P4, telegram P5).
> - **Deferred (need the generator / live CI):** `DOC-P1` (choose+scaffold generator),
>   `DOC-P2`≡`WP-X7` (Pages publish), `DOC-P4` (home/landing), `DOC-P5` (nav/theme/search).
> - **Verified:** 44 pages, **766 internal file-links, 0 broken**; 76 anchor deep-links, 0
>   broken under the github-slugger algorithm (VitePress/Docusaurus dialect — the one class
>   `DOC-P1`/`DOC-P5` must re-validate against the *chosen* generator, since MkDocs slugs
>   differently); every `0.0.0.0` is a labelled anti-pattern; no spawner/WebSocket-transport
>   guidance; secrets are placeholders only.

Source of truth for content: [`ai/DESIGN.md`](ai/DESIGN.md) (design basis),
[`analysis/`](analysis/) (concept-analysis-v2, development-plan, external review,
animated-room), [`due-diligence/`](due-diligence/) (the evidence base), and the root
[`README.md`](../README.md) / [`TODO.md`](../TODO.md) / [`DONE.md`](../DONE.md).

---

## 1. Principles (so parallel authors converge)

- **One page = one WP = one agent.** Every WP names its output slug, its source inputs
  (file + section), its dependencies, and a Done-when. No WP needs to read another WP's
  output to start — they read the *source docs*, not each other.
- **Content is tool-agnostic Markdown.** Pages are plain CommonMark so they can be
  authored before the site generator is chosen (see `DOC-P1`). Generator-specific
  frontmatter/components are added during assembly (`DOC-P4`/`DOC-P5`), not by content
  authors.
- **The app stays loopback-only; the docs are the *only* public surface.** Nothing in the
  docs may instruct a reader to bind `0.0.0.0`, expose the port, or add a spawner. The
  security posture (DESIGN §8) is a first-class, flagship doc, not an appendix.
- **No secret leakage in examples.** Tokens/paths in samples are placeholders
  (`DASHBOARD_TOKEN=<token>`), never real values.
- **Ground-truth framing.** Docs describe tokens as read-from-JSONL ground truth and the
  subagent tree as a persisted data fact — never "inferred/estimated".
- **Evidence, not marketing.** Claims about the moat and rivals cite the due-diligence
  (public-friendly summaries), matching the repo's tone.

## 2. Site map (information architecture)

Physical content root (`docs-site/` vs generator default) is fixed by `DOC-P1`; slugs
below are logical.

```
/                       Home / overview                         (O1 → P4)
guide/
  what-is-agenthropic   Overview & the one-paragraph pitch      (O1)
  the-moat              Why build — the five absent features    (O2)
  comparison            vs the field (baseline + 6 rivals)      (O5)
  roadmap               Phases & waves, public-friendly         (O3)
  faq                   Self-hosted? cost? why not fork?        (O4)
architecture/
  overview              Ingest loop + ports & adapters          (A1)
  data-model            Schema, agent tree, token_usage, edges  (A2)
  hooks                 The twelve lifecycle events + catalog   (A3)
  ingest-reconciliation Source-of-truth, CD-1, JSONL vs hooks   (A4)
  dag-moat              Persisted per-instance DAG + projection (A5)
  cost-model            Dual-pricing + delegation-savings       (A6)
  glossary              Terms + hook-event reference tables     (A7)
security/
  model                 Loopback, token, no-spawner, no-SSRF    (S1)  ★ flagship
  threat-model          What the field got wrong; how we don't  (S2)
  remote-access         Tunnel only (SSH / Tailscale)           (S3)
operations/
  backup-restore        WAL, backup, tested restore, retention  (S4)
  troubleshooting       Stuck-session watchdog, missing-Stop    (S5)
contributing/
  index                 Dev setup, PR flow, one-WP-one-agent    (C1)
  testing               Fixtures, P0 tests, coverage >90% gate  (C2)
  licensing             Clean-room rule + provenance scan       (C3)
  decisions/            ADRs: CD-1…CD-10, LB1/LB2                (C4)
  governance            SECURITY.md, CoC, issue/PR templates    (C5)
usage/                  ── WRITTEN as design-target (pre-Phase-0) ──
  getting-started       Prerequisites, install, run             (U1)
  hooks-installer       Install the Claude Code hooks           (U2)
  configuration         Env vars & config reference             (U3)
  dashboard             The five daily questions + views        (U4)
  api                   Read API / SSE reference                (U5)
  telegram              Alerts → @baev_bot_bot                  (U6)
```

## 3. Work packages

Columns: **WP** · **Sz** (S≈½day / M≈1day / L≈2day of one agent) · **Deps** · **Page** ·
**Scope & source inputs**. Status is **NOW** unless a WP is tagged **BLOCKED**.

### Track P — Platform / site infrastructure

| WP | Sz | Deps | Page | Scope & source inputs |
|---|---|---|---|---|
| **DOC-P0** | S | — | — | **IA + site map sign-off.** Freeze §2 above (sections, slugs, nav order). Gate for all content WPs so slugs/links are stable. |
| **DOC-P1** | M | P0 | — | **Choose & scaffold the generator** (recommend **VitePress** — Vite-aligned with the leaning stack; alt: Docusaurus / MkDocs Material). Content root, local dev, `build`. Decision recorded as an ADR (feeds C4). |
| **DOC-P2** | M | P1 | — | **CI build & publish to GitHub Pages** on merge to `main`. Public docs only; app stays `127.0.0.1`. **≡ dev-plan `WP-X7`** — this fulfils it. |
| **DOC-P3** | S | P0 | — | **Docs style guide + page/ADR templates + terminology list.** The convergence enabler for parallel authoring: heading structure, admonition conventions, code-sample rules (placeholder secrets), term casing (subagent, DAG, WAL). |
| **DOC-P4** | M | P1, O1, O2 | `/` | **Home / landing page.** Hero, the one-paragraph pitch, the five moat bullets, quick-links. Align with root `README.md`. |
| **DOC-P5** | S | P1, P4 | — | **Nav, sidebar, search, theme (light/dark), 404, edit-links.** Final assembly polish once content lands. |

### Track O — Overview & narrative _(NOW)_

| WP | Sz | Deps | Page | Scope & source inputs |
|---|---|---|---|---|
| **DOC-O1** | S | P3 | `guide/what-is-agenthropic` | What agenthropic is; local-first, no telemetry egress. `README.md`; DESIGN §1. |
| **DOC-O2** | M | P3 | `guide/the-moat` | The five absent features & why greenfield. DESIGN §0, §2; concept-analysis-v2 §2. |
| **DOC-O3** | M | P3 | `guide/roadmap` | Phases 0–6 + the wave idea, public-friendly (no internal WP ids). DESIGN §9; development-plan §Phases/§Waves. |
| **DOC-O4** | S | P3 | `guide/faq` | Self-hosted? cost? privacy? why not fork simple10/hoangsonww? DESIGN §0, §8; due-diligence recommendation. |
| **DOC-O5** | M | P3 | `guide/comparison` | vs `claude-code-templates` baseline + the 6 rivals, public-friendly table. due-diligence `market-landscape.md` + `recommendation.md`. |

### Track A — Architecture & reference _(NOW)_

| WP | Sz | Deps | Page | Scope & source inputs |
|---|---|---|---|---|
| **DOC-A1** | M | P3 | `architecture/overview` | The ingest loop diagram + ports/adapters. DESIGN §3; concept-analysis-v2 (arch lens). |
| **DOC-A2** | L | P3 | `architecture/data-model` | `agents`(self-ref), `sessions`, `events`/`events_raw`, `token_usage`, `orchestration_edges`. Annotated DDL. DESIGN §4; development-plan Track D. |
| **DOC-A3** | M | P3 | `architecture/hooks` | The twelve lifecycle events, SubagentStart/Stop handling, what we do post-ingest. DESIGN §5. |
| **DOC-A4** | L | P3 | `architecture/ingest-reconciliation` | Immutable substrate + deterministic projection; CD-1 (JSONL-primary — empirically pre-answered `CONDITIONAL-GO` (conf 85) by the 2026-07-04 desktop probe; the formal Phase-0 spike confirms it on the paired-capture corpus); the Phase-0 probe. concept-analysis-v2 CD-1/LB1; [`analysis/phase0-probe.md`](analysis/phase0-probe.md); development-plan Track IN. |
| **DOC-A5** | M | P3 | `architecture/dag-moat` | Persisted, per-instance, dual-path `orchestration_edges`; rebuild-from-JSONL. DESIGN §2.1, §6; development-plan Phase 3. |
| **DOC-A6** | M | P3 | `architecture/cost-model` | `token_usage` buckets, compaction baselines, dual-pricing, delegation-savings. DESIGN §4 grafts; development-plan Track C. |
| **DOC-A7** | S | P3 | `architecture/glossary` | Glossary + hook-event reference tables (statuses, fields). DESIGN §4/§5; A2/A3 terms. |

### Track S — Security & operations _(NOW)_

| WP | Sz | Deps | Page | Scope & source inputs |
|---|---|---|---|---|
| **DOC-S1** ★ | M | P3 | `security/model` | **Flagship.** Loopback-only, mandatory `timingSafeEqual` token, no spawner, no SSRF, same-origin WS/SSE, no key in env. DESIGN §8. |
| **DOC-S2** | M | P3 | `security/threat-model` | What each rival got wrong (0.0.0.0, no-op token, `/api/run` RCE, SSRF) and how we structurally avoid it. DESIGN §8; due-diligence `security.md`. |
| **DOC-S3** | S | P3 | `security/remote-access` | Tunnel-only (SSH port-forward / Tailscale); never a reverse proxy to the open port. DESIGN §8. |
| **DOC-S4** | M | P3 | `operations/backup-restore` | SQLite WAL, backup + tested restore, retention/redaction. DESIGN §8; development-plan `WP-F8`, `WP-D10`. |
| **DOC-S5** | S | P3 | `operations/troubleshooting` | Stuck-session watchdog, missing-Stop→unknown, PreCompact repricing. _(partial — deepens once code lands.)_ DESIGN §6; development-plan `WP-IN12`. |

### Track C — Contributor _(NOW)_

| WP | Sz | Deps | Page | Scope & source inputs |
|---|---|---|---|---|
| **DOC-C1** | M | P3 | `contributing/index` | Dev setup, PR flow, the one-WP-one-agent model, the coverage >90% bar. development-plan §Global-DoD; CLAUDE.md. |
| **DOC-C2** | M | P3 | `contributing/testing` | Golden fixture corpus, the three P0 tests, the 12-scenario negative catalogue, merge-blocking coverage. development-plan Track X (X1–X5). |
| **DOC-C3** | M | P3 | `contributing/licensing` | Clean-room rule (cast/disler/nirdiamant all-rights-reserved), attribution (simple10/hoangsonww MIT), CI provenance scan. concept-analysis-v2 LB2/CD-9; development-plan `WP-F5/F6`. |
| **DOC-C4** | L | P3, P1 | `contributing/decisions/*` | **ADR set:** CD-1…CD-10 + LB1/LB2 + the generator choice (from P1), one file each, in a standard ADR template. concept-analysis-v2 §2–§3. |
| **DOC-C5** | S | P3 | `contributing/governance` | `SECURITY.md` (private-report path), Code of Conduct, issue/PR templates. Standard OSS governance + DESIGN §8 for the security-report policy. |

### Track U — Usage _(WRITTEN as design-target pre-Phase-0 — re-validate on the named phase)_

Written now from the design/build-plan sources, each carrying a **pre-Phase-0 banner** and
marking undecided values `(planned)` / `(leaning — unconfirmed)`. "Re-validate after" is the
phase whose real behavior the page must be checked against (and corrected if it drifted).

| WP | Sz | Deps | Page | Re-validate after |
|---|---|---|---|---|
| **DOC-U1** | M | P3 | `usage/getting-started` | Phase 1 (scaffold + server bootstrap `WP-U0`). |
| **DOC-U2** | M | P3 | `usage/hooks-installer` | Phase 2 hooks installer (`WP-X8`). |
| **DOC-U3** | S | P3 | `usage/configuration` | Phase 1 config surface (`WP-U0`). |
| **DOC-U4** | M | P3 | `usage/dashboard` | Phase 4 SPA + the five daily-question views (`WP-U5…U9`). |
| **DOC-U5** | M | P3 | `usage/api` | Phase 4 read API / SSE (`WP-U1…U4`). |
| **DOC-U6** | S | P3 | `usage/telegram` | Phase 5 Telegram sink (`WP-A6`). |

## 4. Wave schedule (parallelism)

| Wave | What runs | WPs | Agents |
|---|---|---|---|
| **D0** | IA freeze + authoring enablers (must precede content) | `DOC-P0`, `DOC-P3` | 1–2 |
| **D1** | **The big fan-out** — every writable-now content page, fully independent | `DOC-O1…O5`, `DOC-A1…A7`, `DOC-S1…S5`, `DOC-C1…C5` | up to **22** |
| **D2** | Site infra + assembly (can overlap D1 — content is tool-agnostic) | `DOC-P1`, `DOC-P2`, `DOC-P4`, `DOC-P5` | 2–4 |
| **D3** | Usage docs — deferred; each fills when its build phase lands | `DOC-U1…U6` | as phases ship |

Critical path: `DOC-P0 → DOC-P3 → {content} → DOC-P4 → DOC-P5 → DOC-P2 (publish)`.
The 22 content WPs in **D1** have **no inter-dependencies** — that is the whole point of
the decomposition: hand each to its own agent.

## 5. Reconciliation with the development plan

To avoid double-tracking against [`analysis/development-plan.md`](analysis/development-plan.md):

| Dev-plan WP | Relationship |
|---|---|
| `WP-X7` (GitHub Pages build) | **Fulfilled by `DOC-P2`.** Same deliverable. |
| `WP-X6` (README green badges + donation) | Stays in the dev plan (needs live CI). `DOC-P4` aligns the home page with the README; badges land via the `badges` skill once CI is green. |
| `WP-X9` (`RELEASE.md` + per-role DoD) | Stays in the dev plan (release track). Track C links to it. |
| `WP-X10` (WORKLOG discipline) | Harness-local, git-excluded — **not** part of the public docs. |
| `WP-X11` (vector-DB EXPERIMENTAL stub) | ~~Stays; docs reference it as clearly EXPERIMENTAL, off the critical path.~~ **Deleted per best-path §6.3 (applied 2026-07-06)** — docs must not schedule or bless it. |

New surface this plan adds: the **content** of the docs site (Tracks O/A/S/C/U) — the
dev plan only carried the *build/publish* infra (`WP-X7`), never the pages themselves.

## 6. Definition of Done (per docs WP)

- [ ] Output page exists at its slug; front-loads the answer, then detail.
- [ ] Every claim traces to a source input (DESIGN §, analysis §, or due-diligence file);
      no invented facts, no marketing.
- [ ] All internal links resolve to slugs in §2 (or a tracked stub).
- [ ] Code/config samples use placeholder secrets and never bind `0.0.0.0` or spawn.
- [ ] Follows `DOC-P3` style guide (headings, admonitions, terminology).
- [ ] English throughout (per repo convention).
- [ ] Builds clean under the chosen generator (once `DOC-P1` lands); no broken-link warnings.
- [ ] `WORKLOG.md` entry appended for the WP.

## 7. Assembly caveats (resolve at `DOC-P1` / `DOC-P5`)

Two things the pre-generator authoring cannot settle; both are verified-clean *locally* but
need a decision when the generator lands:

- **Source-pointer links into `docs/ai/`.** 8 `docs/site/` pages cite `ai/DESIGN.md` as their
  evidence source. `docs/ai/` is **git-excluded** (harness-local), so those links resolve on
  this machine but would dangle in the published site. At assembly, either (a) inline the
  quoted spans and drop the hyperlink, (b) vendor the cited sections into a published
  `architecture/` page and repoint, or (c) publish a redacted DESIGN excerpt. Links into
  `docs/analysis/` are fine — that tree **is** tracked. *(Do not commit `docs/ai/` to fix this.)*
- **Anchor slug dialect.** The 76 in-page `#anchor` deep-links validate under the
  **github-slugger** algorithm (VitePress/Docusaurus). **MkDocs / python-markdown slug
  differently** (e.g. emphasis handling, stop-word stripping). If `DOC-P1` picks a
  non-github-slugger generator, re-run the anchor check against the *chosen* renderer.

---
_Plan of record for content decomposition. Design basis: [`ai/DESIGN.md`](ai/DESIGN.md).
Build decomposition: [`analysis/development-plan.md`](analysis/development-plan.md)._
