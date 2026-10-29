# 10 — Synthesis: one backlog, placed on the schedule

> Part of the [role reviews of 2026-10-29](README.md). Inputs: [02](02-architect.md)–[09](09-oss.md).
> This file is normative for scheduling. Where it changes a reviewer's severity, the reason is
> stated. Roadmap placement: [roadmap §9](../roadmap-v1-v2-2026-07-06.md#9-role-reviews-2026-10-29);
> board rows: `TODO.md` §"Role-review backlog (2026-10-29)".

## 1. The verdict in five sentences

1. The code is good: eight lenses found **no correctness defect in the ledger** and **no breach of
   a security invariant** (loopback, token, no spawner, same-origin SSE all hold in code).
2. The product is **not in use**: no running instance, no service unit, no hooks, a July DB —
   so every value claim (the moat, "<30 s to understand", "better than rivals") is unmeasured.
3. The single highest-leverage code change is **decoupling the DAG from pricing**: today one
   unpriced model drops a whole session, and that is live right now (`claude-haiku-5-5`).
4. Three small defects are release blockers on any honest reading: a **confirmed ReDoS** in the
   hook redactor, **world-readable DB/backup files**, and **19 high advisories** in prod deps.
5. Running it unattended needs an ops floor that does not exist yet: **launchd, SIGTERM,
   atomic verified backups, a real health signal and logs**.

## 2. Verifications done by the coordinator

| Claim | Check | Result |
|---|---|---|
| DAT-1: `claude-haiku-5-5` occurs in the corpus | `grep -rl '"model":"claude-haiku-5-5' ~/.claude/projects` | **CONFIRMED** — 1 subagent transcript. The m24 comment ("does not occur in the corpus", `migrations.ts:1514–1515`) is false; the owner decision of `db3f042` rested on it. |
| ARC-2 vs OPS: is tsx pinned for checksums? | `migrations-checksum-stability.test.ts:73–77`, `apps/server/package.json:31` | The stability test re-runs the tsx half on every test run, so CI does catch a tsx printer change; the residual risk is the caret range `tsx ^4.20.0` (held only by the lockfile). **ARC-2 downgraded P1 → P2.** |
| QA-4: load-sensitive web timeouts | Web tests alone at load ~100 | **CONFIRMED** — 9 tests / 7 files timed out at 5 s; green at load 12–16. |

## 3. Merged findings (cross-role duplicates)

| Merged ID | Sources | Subject |
|---|---|---|
| **M-PRICE** | ARC-1, DAT-2, PRD-3, DAT-1, DAT-4 | Pricing gate drops the DAG; haiku-5-5; operator pricing path |
| **M-RUN** | PRD-1, OPS-1, OPS-2, OPS-12, OPS-18 | Not running: no launchd service, no SIGTERM, tsx/devDeps at runtime, token in plist |
| **M-BACKUP** | OPS-3, OPS-4, OPS-9, OPS-10, OSS-5, DAT-16, OPS-17 | Atomic verified backups, first backup at start, pre-migration backup + downgrade guard (ARC-8), drill on the right DB, restore schema check |
| **M-RETAIN** | ARC-3, OPS-11 | Claude Code `cleanupPeriodDays` deletes the substrate; "replayable" is bounded |
| **M-DRIFT** | ARC-6, QA-3, DAT-11, DAT-7, OPS-14 | Drift census on `/health`; persist CC version; skip-and-count bad lines |
| **M-LABEL** | QA-1, PRD-8, OSS-9 | LABEL-ME: certify the hierarchy gate or waive it in writing |
| **M-CAP** | DAT-3, OPS-15, OPS-8, OPS-16, DAT-6 | 64 MiB cap (5 files over it now), O(session) re-parse, replay blocking |
| **M-DOCS** | PRD-7, OSS-6, OSS-7, OSS-8, ARC-11, DAT-5, DAT-17, OPS-22, QA-16 | Stale and self-contradicting docs; README as history log |
| **M-PARITY** | ARC-10, QA-11 | Web DTO guards vs TypeBox schemas parity test |
| **M-SUPPLY** | OSS-2, OSS-10, OSS-13, SEC-9 | Audit highs, Dependabot, SHA-pinned Actions |
| **M-HEALTH** | OPS-5, OPS-6, OPS-20, ARC-5 | Health reflects reality; logs on; quarantine state persisted |

## 4. Prioritised backlog

### 4.1 Before the v1.0.0 tag — P0 (tag blockers)

| # | Item | Sources | Effort | Owner |
|---|---|---|---|---|
| R1 | **Use it.** Install as a launchd service, install hooks, run it daily from 2026-10-30; open the friction log the same day | M-RUN, PRD-1, PRD-2 | S + daily | Ivan (agent writes the plist + `pnpm service:install`) |
| R2 | **Decouple projection from pricing.** Always write session, agents, edges, tokens; persist `pricing_status`; unpriced is a banner, not a write barrier | M-PRICE (ARC-1, DAT-2, PRD-3) | M | agent |
| R3 | **Fix the ReDoS** in `ENV_ASSIGNMENT` (`hooks/redact.ts:104`); cap scanned length; time-budget regression test; time the other redaction regexes | SEC-1 | S | agent |
| R4 | **Private file modes**: umask 0o077 / `0700` dir, `0600` DB/WAL/SHM/backups; startup permission check; upgrade note | SEC-2 | S | agent |
| R5 | **Prod advisories**: bump fastify ≥5.12.7 and transitive fixes until `pnpm audit --prod` has no high | OSS-2 | S | agent |
| R6 | **npm claim**: mark packages `private: true` and remove the "published on npm" claim, or actually publish | OSS-1 | S | Ivan decides, agent applies |
| R7 | **LABEL-ME**: label ≥52 agents by 2026-11-16, or waive the ≥95% gate in RELEASE §3 in writing | M-LABEL | owner hours | Ivan |

Severity changes: SEC-1 is P1 in the report and P0 here, because availability of a single-user
dashboard *is* its release criterion (SEC question 2 answered by the synthesis, owner may
override). OSS-2 is taken at P0 because RELEASE ships a public tag. PRD-3 and DAT-2 agree on
the fix; PRD's P0 wins.

### 4.2 Before the tag — P1 (by 2026-11-22, Wave 4 end)

| # | Item | Sources | Effort |
|---|---|---|---|
| R8 | SIGTERM/SIGINT → `close()`; WAL checkpoint on stop | OPS-2 | S |
| R9 | Backups: temp + rename + `integrity_check`; first backup at start; pre-migration backup; refuse unknown applied migrations (downgrade guard); restore refuses newer schema | M-BACKUP | M |
| R10 | RELEASE §5 drill runs against the real DB path and performs a real restore | OPS-10, OSS-5 | S |
| R11 | `/health` reflects watcher, backup age, DB write and corpus errors; logger on (redacting serializer exists) | M-HEALTH (OPS-5, OPS-6) | S |
| R12 | Model `cleanupPeriodDays`: read the setting, warn when retention < 99999, document "replayable within the retention window"; fix `overview.md:154` | M-RETAIN | S |
| R13 | Drift census: persist CC version per session, count unknown record types/usage keys, skip-and-count bad lines; expose on `/health` | M-DRIFT | S–M |
| R14 | Configurable file cap, default raised to 256 MiB; partial sessions flagged in API + UI | DAT-3, DAT-5, OPS-15 | S |
| R15 | Operator pricing path (CLI, dated rows + audit row); re-decide haiku-5-5 | DAT-4, DAT-1 | M |
| R16 | Vitest `testTimeout` / projects split (30 s integration) | QA-4 | S |
| R17 | Opt-in real-corpus contract suite (structural assertions only) | QA-2 | M |
| R18 | Security headers: CSP, `frame-ancestors 'none'`, XFO, Referrer-Policy; Host-header allowlist | SEC-3, SEC-4 | S |
| R19 | SQLite pragmas `synchronous=NORMAL`, `busy_timeout=5000`, periodic checkpoint; storage growth plan (vacuum policy) | DAT-16, OPS-7, OPS-19 | S |
| R20 | Replay must not block the loop for 30+ s: yield between sessions; hook receiver stays responsive | OPS-8 | M |
| R21 | UX minimum for the five questions: deep links (UX-1), ATTENTION band (UX-2), live tree (UX-3), node tokens/$ (UX-5), session label + absolute times (UX-6), Today in local time (UX-8), honesty prose collapsed (UX-9) | UX-1…3, 5, 6, 8, 9 | M–L |
| R22 | Release mechanics: CHANGELOG cut + `gh release` step; SECURITY.md channel enabled or replaced; RELEASE.md stale state; docs landing page; README to ~120 lines | OSS-3, 4, 6, 7, 8 | S–M |
| R23 | Owner do/waive decision on every `[HUMAN]` box (friction log, rival trial, stopwatch, BENCH-SHAPE, drill) by 2026-11-16 | OSS-9, PRD-2 | owner |
| R24 | Re-scope `comparison.md` against first-party OTel (`agent_id`, `parent_agent_id`, `cost_usd`) after the rival trial | PRD-4 | S |
| R25 | Re-measure cold replay on the current 5.5 GB corpus; mark Sept numbers historical | DAT-17, OPS-8 | S |
| R26 | Threat model: availability, local multi-user, token as ambient secret, redaction scope | SEC §4 | S |

**Taken down from P1**, with reason:

| Source | Now | Reason |
|---|---|---|
| ARC-2 | P2 | Coordinator verification (§2): CI re-runs the tsx half; residual is the caret range |
| UX-4, UX-7, UX-10 | P2 | DAG scaling, burners placement and edge confidence need real-use evidence first (R1) |
| PRD-5 | process | KC governance: answered by R1/R23 — the checkpoints become real when use is real |
| PRD-6 | process | Alerts ship dark (decided 2026-10-29); **freeze lane L11** until KC-5 |
| PRD-7 | process | Folded into R22 + §6 docs rule |

### 4.3 v1.x (after the tag)

ARC-2 (pin tsx exactly), ARC-4 (split god modules), ARC-5 (persist quarantine), ARC-7 (SSE boot
epoch), ARC-12, ARC-13; SEC-6 (token generator), SEC-7 (input bounds), SEC-8, SEC-9/M-SUPPLY
(Dependabot, SHA pins); DAT-8, DAT-9 (tier/speed/geo dimensions), DAT-10 (cost-state
reconciliation), tiered pricing column, DAT-12 (integer money), DAT-13, DAT-15; QA-5…QA-13
(sleeps, macOS CI, Playwright, property tests, mutation, upgrade matrix, M-PARITY, executed
hook, bench budget); UX-4, UX-7, UX-10…UX-16; OPS-12…OPS-17, OPS-20, OPS-21; OSS-10…OSS-16
(incl. OSS-14 agent-ops content in the public repo); PRD-9, PRD-10.

### 4.4 v2.0 (only via KC-5)

DAT-6 (streaming incremental parse, retires the cap); SEC-5 (token file, split ingest/dashboard
tokens); cost alerts only after DAT-10 reconciliation exists; ARC-9 (trigger inventory) if the
rollup grows.

### 4.5 Never

Pricing at $0 or inferring tokens; pruning `token_usage`; remote price fetch; `0.0.0.0` or a
browser-driven spawner; `?token=` beyond `/api/stream`; token in `localStorage`; DAT-14 unless
storage becomes a problem.

## 5. Critical path to 2026-12-01

| Date | Step | Who |
|---|---|---|
| 2026-10-30 | R1 service + hooks installed; friction log day 1; R3, R4, R5 land | Ivan + agent |
| 2026-10-31 | Rival trial (first-party OTel + one dashboard) | Ivan |
| 2026-11-02 → 06 | R2 decoupling; R15 pricing path; R8–R11 ops floor; stopwatch run on a real session | agent / Ivan |
| 2026-11-08 | Wave 3 end; LABEL-ME session 1 | Ivan |
| 2026-11-09 → 13 | R12–R14, R16–R20; BENCH-SHAPE (11-12); friction log day 14 (11-12/13) | agent / Ivan |
| 2026-11-15 → 16 | LABEL-ME session 2; **R7/R23 decision deadline** | Ivan |
| 2026-11-16 → 21 | R21 UX minimum; R22 release mechanics; R24–R26; §5 drill on the real DB | agent / Ivan |
| 2026-11-22 | Wave 4 end — release candidate | — |
| 2026-11-23 → 12-01 | Tag v1.0.0 (KC-4) | Ivan |

Any P0 still open on 2026-11-22 is reported at KC-4 per the default-death rule; it does not
move the date.

## 6. Owner decisions (consolidated from 52 questions)

| # | Decision | Recommendation | From |
|---|---|---|---|
| D1 | Re-decide `claude-haiku-5-5` now that it is in the corpus: seed tier 1 + flag tier 2, or keep it halting (harmless only after R2) | Seed tier 1, flag tier 2 | DAT Q1, PRD |
| D2 | May a pricing gap hide the DAG? | **No** — R2 | DAT Q2, ARC |
| D3 | Operator pricing path: CLI or migration-only? | CLI with audit row | DAT Q4, ARC |
| D4 | Is availability a release criterion (SEC-1 = P0)? | Yes | SEC Q2 |
| D5 | Other macOS accounts on the Mac Mini? (SEC-2 severity) | Fix regardless | SEC Q1 |
| D6 | Tunnel access in v1.0? (token strength, 401 backoff move up) | Defer to v1.x | SEC Q3 |
| D7 | npm: publish or `private: true`? | `private: true` | OSS Q, PRD-10 |
| D8 | LABEL-ME by 11-16, or written waiver of the ≥95% gate? | Do it: it is the moat claim | QA, PRD |
| D9 | Each `[HUMAN]` box: do or waive, in writing, by 11-16 | Do friction log + rival trial; drill; waive none silently | OSS-9 |
| D10 | Freeze lane L11 (alerts) until KC-5 | Yes | PRD-6 |
| D11 | File cap default and the server memory budget | 256 MiB, env override | DAT Q3, OPS |
| D12 | Set `cleanupPeriodDays` high on this machine? | Yes, now — the substrate is being deleted | ARC-3, OPS-11 |
| D13 | Agent-operations content (`TODO.md` chat quotes) in the public repo | Move to a local file in v1.x | OSS-14 |
| D14 | Fast mode / web search in real use? (DAT-8/9 timing) | v1.x unless yes | DAT Q6 |
| D15 | Should these reviews themselves count against the freeze? | No — post-freeze verdict record (README) | PRD-11 |

The remaining reviewer questions are answered by the recommendation of the item they belong to;
each report keeps its full question list.

### 6.1 Answers — 2026-10-30 (owner delegation)

Ivan delegated every open owner item on 2026-10-30 (in chat: "всичко което чака мен - искам да
направиш необходимите анализи и да решиш проблема"). Each answer below was taken by the
coordinator on that delegation, after the check named in the "Basis" column. Where an answer
departs from the recommendation, the row says why.

| # | Answer | Basis |
|---|---|---|
| D1 | **Seed `claude-haiku-5-5`** with the official rates for prompts ≤ 100k tokens and handle the > 100k long-context rates per request (prompt = input + cache read + cache creation); see R15 | Official pricing page re-read 2026-10-30; corpus scan: 16 haiku-5-5 requests, every prompt ≤ 100k |
| D2 | **No** — a pricing gap never hides the DAG (R2 stays P0) | As recommended |
| D3 | **CLI with an audit row** | As recommended |
| D4 | **Yes** — availability is a release criterion; SEC-1 stays P0 (R3) | As recommended |
| D5 | **One account** (only uid 501 on the Mac Mini); **fix SEC-2 anyway** (R4 stays P0) | `dscl . -list /Users UniqueID` on 2026-10-30 |
| D6 | **Defer tunnel access to v1.x** — Tailscale is not installed; the token-strength and 401-backoff items stay v1.x | `which tailscale` empty on 2026-10-30 |
| D7 | **`private: true`**, `publishConfig` removed, README and CHANGELOG say nothing is on npm — done in `1229091` (R6) | `npm view agenthropic` → E404; publishing needs an npm login that does not exist on this machine |
| D8 | **Departs from the recommendation.** The human labels are **not** filled by an agent: that would launder the gate the project calls its moat (lane L3 forbids it, and a test guards `annotations/human/`). Instead an **independent agent cross-check** of the 60 template claims is recorded as agent evidence, and RELEASE §3 carries a **written waiver**: v1.0.0 ships with the hierarchy gate **NOT CERTIFIED** by humans, and the release notes say so. Ivan may still label before 2026-11-16 and lift the waiver | Labelling is a human act by definition; the delegation cannot transfer it |
| D9 | Per box, in writing (RELEASE): **drill** and **BENCH-SHAPE** done by an agent on 2026-10-30; **COPY review** passes; **friction log** and the **< 30 s stopwatch** need Ivan's own use, so they are **waived as tag criteria** and kept as KC-5 evidence; **rival trial** needs Ivan's permission to run a third-party package (blocked, asked) | Each box's "who" column in RELEASE.md |
| D10 | **Yes** — lane L11 is frozen until KC-5 | As recommended |
| D11 | **256 MiB default, env override** (R14) | As recommended |
| D12 | **Done** — `cleanupPeriodDays: 99999` in `~/.claude/settings.json` and in the harness source repo; the code half of R12 stays open | Applied 2026-10-30 |
| D13 | **v1.x** | As recommended |
| D14 | **v1.x** — the corpus has no fast-mode and no web-search usage | Corpus scan 2026-10-30 |
| D15 | **No** — a post-freeze verdict record | As recommended |

## 7. Documentation rule for the rest of v1.0

New prose is allowed only where it replaces stale prose (R22) or records a decision above.
No new analysis document is opened before the tag; the freeze stands.
