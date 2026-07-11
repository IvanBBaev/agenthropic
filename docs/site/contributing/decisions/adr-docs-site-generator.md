# ADR-0013: Docs-site generator choice

- **Status:** deferred — decision not yet made; recorded here as the candidate set and
  acceptance criteria so `DOC-P1` can execute against a fixed target
- **Date:** 2026-07-04
- **Deciders:** Ivan Baev (project owner) — to be finalized when `DOC-P1` runs
- **Source:** [`docs/DOCS-PLAN.md`](../../../DOCS-PLAN.md) §3 (`DOC-P1`), §1 (principles),
  §4 (wave schedule)

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
