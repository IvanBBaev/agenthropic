# Due-Diligence Dossier — Claude Code Agent-Observability Dashboards

> **⚠️ SUPERSEDED (2026-07-04, banner added 2026-07-06).** The evidence and grades in
> this dossier remain valid and citable. The *recommendation* (fork simple10; graft
> cast `analytics.ts`) is superseded: the project is a **greenfield clean build** per
> [`../analysis/best-path-decision.md`](../analysis/best-path-decision.md), and
> cast/disler/nirdiamant code is clean-room-only per CD-9. Current entry point:
> [`../analysis/PROJECT-STATE-2026-07-06.md`](../analysis/PROJECT-STATE-2026-07-06.md).

**What this is:** an independent, source-level audit of the six candidate dashboards
evaluated for `agenthropic`, plus a meta-audit of the two vendor "Technical
Due-Diligence" reports (`v1`, `v2.0 extended`) that recommended one of them.

**Bottom line:** the vendor panel's own scoring model ranks `simple10` first, then
overrides itself to recommend `hoangsonww` on a tie-break that rests on a factual
error. Corrected, the recommendation flips. My independent grades diverge
systematically from the panel: it over-rated the flashy-but-fragile and under-rated
the disciplined.

> **Status: analysis only. No adopt/fork/build action has been taken.** The direction
> decision waits on Ivan.

## How to read this dossier

| File | What's in it |
|---|---|
| [methodology.md](methodology.md) | How the audit was run, sources, tools, limits, the verified GitHub fact base |
| [report-meta-audit.md](report-meta-audit.md) | The panel's self-contradiction, the fact-check table, the weighted scoring model dissected |
| [market-landscape.md](market-landscape.md) | Selection bias — the popular tools the panel never mentioned — and the real market gap |
| [security.md](security.md) | Cross-cutting security reality (0.0.0.0, no-op auth, RCE, SSRF) + Mac Mini hardening checklist |
| [recommendation.md](recommendation.md) | The decision, its rationale, the step plan, alternatives, and open questions |
| [projects/simple10.md](projects/simple10.md) | **A−** — my pick as base |
| [projects/hoangsonww.md](projects/hoangsonww.md) | **B−** — study, don't adopt blind |
| [projects/cast.md](projects/cast.md) | **C** — two ideas worth stealing, else lock-in |
| [projects/disler.md](projects/disler.md) | **C−** — teaching example, no tests, no license |
| [projects/nirdiamant.md](projects/nirdiamant.md) | **C+** — wrong shape (flat feed) |
| [projects/claude-code-templates.md](projects/claude-code-templates.md) | The 28.4k★ tool the panel missed — the baseline to differentiate against |

A one-page executive synthesis also lives at
[../independent-due-diligence.md](../independent-due-diligence.md).

## Grades at a glance

| Project (owner) | Panel v1 | Panel v2 (/5) | **Independent** | Move |
|---|---|---|---|---|
| **simple10/agents-observe** | B+ | **4.1 (highest)** | **A−** | ▲ |
| **hoangsonww/Claude-Code-Agent-Monitor** | A− | 4.0 | **B−** | ▼ |
| **ek33450505/claude-code-dashboard (CAST)** | B− | 3.8 | **C** | ▼ |
| **disler/…observability** | B+ | 2.7 | **C−** | ▼▼ |
| **NirDiamant/claude-watch** | C+ | 2.6 | **C+** | = |
| *davila7/claude-code-templates (missed)* | — | — | **C** *(for this need)* | new |

## The recommendation in one sentence

**Fork `simple10`, harden it (127.0.0.1 + token + `launchd`, no Docker), then graft
`hoangsonww`'s Telegram webhook provider and `cast`'s delegation-savings metric** —
with `hoangsonww` kept cloned only as a reference for its richer D3 graph. Full
rationale in [recommendation.md](recommendation.md).

---
*All figures verified at source on 2026-07-03. These repos move fast — re-verify
before any final commitment.*
