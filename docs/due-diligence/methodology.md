# Methodology

## Mandate

Ivan's instruction was explicit: *before any action, produce a very detailed,
holistic, merciless analysis.* The two vendor reports (`Claude-Code-Agent-Dashboards_Due-Diligence.docx`
and its `v2.0 extended`) are treated here as an **input to be audited, not a
conclusion to be trusted.** Where the report's claims and the source code diverge,
**the source wins.**

## Scope

Six candidates were audited:

1. `simple10/agents-observe`
2. `hoangsonww/Claude-Code-Agent-Monitor`
3. `ek33450505/claude-code-dashboard` (aka "CAST")
4. `disler/claude-code-hooks-multi-agent-observability`
5. `NirDiamant/claude-watch`
6. `davila7/claude-code-templates` — **not in the reports; added because the panel
   missed it** (see [market-landscape.md](market-landscape.md)).

## Process

1. **Report extraction.** Both `.docx` files were unzipped and their `word/document.xml`
   parsed to clean text (split on `</w:p>`, extract `<w:t>` runs). The v1 report
   carried the A−/B+/B+/B−/C+/F grades and the "adopt hoangsonww" call; v2.0 added
   §4 the scoring model, §9 per-project deep dives, §8.5 OPCⁿ fit, §10 gap analysis,
   §11 recommendations.
2. **Source audit.** Each repo was shallow-cloned and read at source by an independent
   auditor, in parallel. Auditors were told to verify — not assume — every headline
   claim: subagent hierarchy, DAG reality, test depth, security posture, license,
   maintenance, extractable value.
3. **Fact verification.** Every quantitative claim (stars, forks, last-push, LOC,
   table count, test/assertion count) was re-pulled from the GitHub API on
   **2026-07-03** via `gh`. Graph libraries and security patterns were confirmed by
   grep (`d3`, `cytoscape`, `dagre`, `reactflow`; auth/CORS/bind/spawn).
4. **Grading.** Independent letter grades were assigned from the source findings,
   then compared against both the panel's letters (v1) and its weighted /5 scores (v2).

## Tools

- `gh` CLI for live repo metadata and issue/PR verification
- shallow `git clone` + LOC counting + test-file / `expect()` (assertion) counting
- grep sweeps for graph libraries, `bind`/`0.0.0.0`, auth guards, `execSync`, spawners
- `.docx` → text extraction (Python, `zipfile` + regex over `word/document.xml`)

## The verified fact base (2026-07-03)

| Project | Stars | Forks | Last push | License (real) |
|---|---|---|---|---|
| hoangsonww | (per report, verified in range) | — | active | MIT + LICENSE file |
| disler | **1,475** | **385** | **stalled 2026-02-08** | **none** (`private:true`, no `license`) |
| simple10 | **607** | **58** | **2026-06-29** | MIT + LICENSE (© 2025 Joe Johnston) |
| cast | 3 | — | active | **README badge only**, no LICENSE file |
| nirdiamant | — | — | active | MIT declared, no LICENSE file |
| claude-code-templates | **28.4k** | — | active | MIT + LICENSE |
| *(context)* claude-hud | **26.1k** | — | active | MIT |
| *(context)* ccusage | **16.8k** | — | active | MIT |

### Where the report's "verified fact base" cracked
- **simple10** was reported as "blocked by API rate-limiting, last activity 5 Jun."
  It returned on the first call: 607★/58/MIT, pushed 29 Jun. The report's numbers
  were stale and its "no true DAG" claim (built on that stale read) is false.
- **disler** was reported at "~1,400★ / 372 forks" — real is 1,475 / 385.
- **disler** hook scripts were reported to "protect .env/keys" — the guard is
  commented out (`pre_tool_use.py:324-327`).

## Limits & caveats

- These repos move fast; star counts and last-push dates drift. Re-verify before a
  final commitment.
- Pricing tables inside cost features (e.g. `cast`'s delegation-savings) are
  hardcoded and may be stale — re-check model rates before trusting dollar figures.
- Subagent edges are, in every candidate, **derived from the event stream at render
  time, not persisted** as first-class rows. This matters for a global/historical DAG
  and is called out per-project.
- The audit reads code, not running instances; runtime behaviour (esp. arm64 native
  bindings) should be smoke-tested on the actual Mac Mini before commitment.
