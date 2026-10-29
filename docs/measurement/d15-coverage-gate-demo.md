# D15 — coverage gate demonstration (WP-X5)

**Date:** 2026-10-29 · **Decision:** D15 (a), 2026-09-30 · **Go-ahead:** Ivan, 2026-10-29.

WP-X5 requires that "a PR dropping below the threshold is blocked (demonstrated)". This page
records the one throwaway PR that demonstrated it. The PR was never merged.

| Item | Value |
|---|---|
| PR | [#2](https://github.com/IvanBBaev/agenthropic/pull/2) — closed unmerged, branch `lane/d15-coverage-drop` deleted locally and on GitHub |
| Change | one commit, `ef4de10`: deletes `packages/shared/test/in-memory-event-store.test.ts` |
| `ci` run | [40945826253](https://github.com/IvanBBaev/agenthropic/actions/runs/40945826253) — conclusion `failure` |
| Failing step | `Test (coverage thresholds enforce the coverage gate)`; every earlier step green, the license gate skipped |
| Tests | all passed (`@agenthropic/shared`: 8 test files passed) — the failure is the threshold alone |
| Merge state while open | `BLOCKED` (`gh pr view 2 --json mergeStateStatus`) |
| Branch protection | `{"contexts":["ci"],"enforce_admins":false}` |

The failing threshold lines, verbatim from the run log:

```text
ERROR: Coverage for lines (95.74%) does not meet global threshold (100%)
ERROR: Coverage for functions (87.5%) does not meet global threshold (100%)
ERROR: Coverage for statements (95.86%) does not meet global threshold (100%)
ERROR: Coverage for branches (95.34%) does not meet global threshold (100%)
[ERR_PNPM_RECURSIVE_RUN_FIRST_FAIL] @agenthropic/shared@0.3.0 test
```

**What this shows, and what it does not.** A contributor's PR that drops a package below its
Vitest thresholds fails the required `ci` check and cannot be merged. Because `enforce_admins`
is off by design, the sole maintainer can still push to `main` directly; this demonstration
does not cover that path (see the note at the top of `.github/workflows/ci.yml`).
