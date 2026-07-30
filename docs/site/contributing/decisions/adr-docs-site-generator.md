# ADR-0013: Docs-site generator choice

- **Status:** deferred — **still deferred as of 2026-07-30**; `DOC-P1` has not run. The Pages
  publish pipeline (`DOC-P2`/`WP-X7`) shipped on the stock Jekyll builder with zero new
  dependencies precisely so it does **not** decide this (see the as-built update below)
- **Date:** 2026-07-04
- **Deciders:** Ivan Baev (project owner) — to be finalized when `DOC-P1` runs
- **Source:** [`docs/DOCS-PLAN.md`](../../../DOCS-PLAN.md) §3 (`DOC-P1`), §1 (principles),
  §4 (wave schedule)

## As-built update — 2026-07-30

**Verdict: still deferred — deliberately, and the publish pipeline was built without
deciding it.**

`DOC-P1` has not run. No generator has been chosen. VitePress, Docusaurus and MkDocs
Material are all still on the table, exactly as recorded below.

What *did* ship is `DOC-P2` / `WP-X7`: `.github/workflows/pages.yml` builds and
publishes the docs tree to GitHub Pages on merge to `main`. It does so with the
**stock `actions/jekyll-build-pages` builder**, which adds **zero dependencies** to
the repository, specifically so that shipping a publish pipeline does not quietly
decide the thing this ADR defers. The workflow says so in its own header. When
`DOC-P1` picks a generator, the build job is replaced wholesale; nothing authored
under `docs/site/` has to change, because the content stayed plain CommonMark as the
fourth acceptance criterion requires.

Two operational notes:

- The workflow's source root is `docs/`, not `docs/site/`, because 129 relative links
  point outward from `docs/site/` into the analysis and due-diligence trees at the
  time of writing. Narrowing the root would break them.
- **GitHub Pages is not yet enabled on this repository** (`has_pages: false`).
  Enabling it is a one-time owner action in *Settings → Pages → Source: "GitHub
  Actions"*. Until Ivan does that, the workflow builds and publishes into a Pages
  environment that is not serving — so "CI builds & publishes on merge" is true of
  the CI half and not yet true of the published half.

One note on the Context below: it quotes `CLAUDE.md`'s bootstrap-phase wording ("no
code scaffolded yet"), which was accurate on 2026-07-04 and is not accurate now —
implementation began 2026-07-11 ([ADR-0010](adr-cd-8-phase-0-spike.md)). The quote is
left as written because it records what was true when the deferral was decided; the
deferral itself does not depend on it.

## Context

The agenthropic docs site (Tracks O/A/S/C content, per `docs/DOCS-PLAN.md`) needs a static-site
generator to build and publish to GitHub Pages. Per the repo's own bootstrap-phase state
(`CLAUDE.md`: "Stack & repo structure are an open decision... no code scaffolded yet"), no
generator has been scaffolded. `docs/DOCS-PLAN.md` §1 makes the sequencing deliberate:
**"Content is tool-agnostic Markdown... authored before the site generator is chosen"** — so
choosing the generator does not gate the 22-WP content fan-out (`docs/DOCS-PLAN.md` §4, wave D1).

## Decision

**Not yet decided.** `docs/DOCS-PLAN.md` `DOC-P1` names the leaning candidate and the named
alternatives, but the choice itself is explicitly deferred to `DOC-P1`'s execution:

- **Leaning candidate: VitePress** — "Vite-aligned with the leaning stack" (`docs/DOCS-PLAN.md`
  `DOC-P1`), consistent with `docs/ai/DESIGN.md` §10's own leaning stack (React + Vite for the
  application frontend).
- **Named alternatives:** Docusaurus, MkDocs Material.

This ADR exists to record the criteria and candidate set now, per `docs/DOCS-PLAN.md`'s own
instruction that `DOC-C4` capture "the generator choice (from P1)... in a standard ADR
template" — while being explicit that no commitment has actually been made. **This ADR's status
should move to `accepted` (or be superseded by a new ADR) once `DOC-P1` runs.**

## Acceptance criteria

From `docs/DOCS-PLAN.md` §6 ("Definition of Done") and §3 (`DOC-P2`):

- Docs **build clean** under the chosen generator; **no broken-link warnings**.
- CI **builds & publishes** the docs site to GitHub Pages on merge to `main`
  (`docs/DOCS-PLAN.md` `DOC-P2`, which fulfils `development-plan.md` `WP-X7`: "CI builds &
  publishes on merge.").
- The application **stays bound to `127.0.0.1`** throughout — the docs site is the *only*
  public surface (`docs/DOCS-PLAN.md` §1, §3 roadmap header).
- Content pages remain **plain CommonMark**, with generator-specific frontmatter/components
  added only at assembly (`DOC-P4`/`DOC-P5`), never authored into content pages directly
  (`docs/DOCS-PLAN.md` §1; [`STYLE-GUIDE.md`](../../STYLE-GUIDE.md) "Mechanics").

## Consequences

- **Positive:** deferring this choice let the entire D1 content fan-out
  (`docs/DOCS-PLAN.md` §4 — `DOC-O1`…`O5`, `DOC-A1`…`A7`, `DOC-S1`…`S5`, `DOC-C1`…`C5`, up to
  22 agents in parallel) proceed without waiting on tooling.
- **Negative / costs:** some retrofitting risk at assembly time (`DOC-P4`/`DOC-P5`) if the
  eventually-chosen generator's conventions (sidebar config, admonition syntax, anchor slugs)
  require light rework of already-written content pages.
- **Follow-ups:** `docs/DOCS-PLAN.md` `DOC-P1` (choose & scaffold the generator), `DOC-P2` (CI
  build & publish, ≡ `development-plan.md` `WP-X7`), `DOC-P4`/`DOC-P5` (home page + nav/sidebar/
  search/theme assembly polish once content lands).

## Alternatives considered

- **VitePress** — leaning candidate; Vite-aligned with the application's own leaning frontend
  stack (`docs/ai/DESIGN.md` §10).
- **Docusaurus** — named alternative; React-based, larger plugin ecosystem.
- **MkDocs Material** — named alternative; Python-based, a lighter non-Node toolchain option if
  that is ever preferred over a JS-native generator.

No selection has been made among these; `DOC-P1` is the gate that decides.
