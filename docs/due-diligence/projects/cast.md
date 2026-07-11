# ek33450505/claude-code-dashboard (CAST) — **C**

**Panel:** B− (v1) / 3.8 (v2) · **Independent:** **C** ▼ · **Role: harvest two
ideas, then walk away.**

Metrics: **3★**, single maintainer (`ek33450505`). The Tauri desktop app it advertises
lives in a **separate repo**. "MIT" appears only as a README badge — `package.json` has
`private:true`, **no `license` field, and no LICENSE file** = all-rights-reserved by
default.

## Two things genuinely worth stealing

### 1. The security shape — `controlGate.ts`
- Read-only by default: non-safe HTTP verbs return **404** unless
  `CAST_DASHBOARD_CONTROL=1` **and** `DASHBOARD_TOKEN` are set.
- Constant-time token compare (`timingSafeEqual`); mounted **before** the router.
- ~73 lines, dependency-free, drop-in. **Adopt this pattern regardless of base.**

### 2. The delegation-savings metric — `analytics.ts:233-310`
- Re-prices Haiku sessions at Sonnet rates and reports the conservative
  `max(0, sonnetEquiv − actualHaiku)` saving.
- Runs off `~/.claude` JSONL. ~50 LOC, portable.
- **Caveat:** the pricing table is hardcoded and likely stale — re-verify model rates
  before trusting dollar figures.

## Why it's still a C

- **Lock-in trap.** **37 of 51 route files** import `getCastDb`; the schema is "owned
  by CAST." Without the separate CAST agent OS running, ~72% of routes return 503 /
  empty. You cannot lift the dashboard cleanly away from its host product.
- **License-by-badge** (above) — a hard blocker for anything OPCⁿ-commercial.
- **Security theatre on reads.** Despite "localhost" framing, `index.ts:101` binds
  **0.0.0.0**, and unauthenticated GET routes dump every table. The write-gate is good;
  the read side is wide open.
- Self-published "security audit" ≠ third-party assurance.

## Verdict

A welded-in companion dashboard for a niche agent OS, not a portable base. Harvest
`controlGate.ts` and the delegation-savings formula; ignore the rest. **C.**
