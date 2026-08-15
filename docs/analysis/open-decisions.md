# Open decisions — sign-off form for Ivan

**Status:** Decision form. This file changes nothing on its own — it collects the nine
open decisions catalogued in the 2026-07-06 corpus audit (`corpus-audit-2026-07-06.md`
§4.2, its ranked actions §10.4/§10.10, and the C5/C6/C7/C13/C17/C18 rows of the
inconsistency table §6) into checkboxes you can sign. **This is not a new analysis** — the
roadmap §8 analysis freeze is in force; no findings are added here, only existing IDs are
cited.

**How to use.** Each decision states the question in one sentence, the resolution the
audit already recommended (or, where the audit deliberately left the choice open, the
catalogued options), the consequence of leaving it open, and a checkbox. Deciding is
yours. When you tick a box, the audit's landing rule (§10.4) is: **one dated decision note
lands in `concept-analysis-v2.md` §7 (or a new ADR), and `architecture/data-model.md` /
ADR-0006 are updated to match.** No file is edited by ticking here.

**Blocker legend.** 🟥 = blocks a WP track from starting. The three schema collisions
**OPEN-1, OPEN-2, OPEN-3 must all be resolved before Track D begins** (audit §10.4) — they
are ordered first below.

> **Read this before signing anything (amendment, 2026-08-15).** This form was written when
> the repository held documentation and no code. Since implementation began on 2026-07-11,
> six of the nine items have acquired a **shipped implementation** — OPEN-1's mechanism half,
> OPEN-2, OPEN-3, OPEN-4, OPEN-5 and OPEN-7. That changes what a tick *means*, and the
> distinction is worth being pedantic about:
>
> - **Implemented** = code exists and is tested. It is a fact about the tree.
> - **Ratified** = you have chosen it. It is a fact about the project's intent.
>
> Implementation never produces ratification. Where an agent had to pick something in order
> to write working code, it picked the resolution this form already recommended, wrote down
> that the pick is provisional, and left the box unticked. **A shipped default is a question
> still waiting for an answer, not an answer.** Each affected item below carries an
> "implemented, awaiting ratification" note naming the file, so you can read the code before
> you sign for it — and so nobody mistakes the tick for a design decision that was actually
> made here. One item, **OPEN-6, turns out to rest on a false premise** and is re-asked
> rather than answered.

---

## A. Track-D blockers — resolve these before the data track starts

### OPEN-1 — Retention TTL vs `events_raw` immutability 🟥 blocks Track D

**Question.** Given that ADR-0004/0006/0009 enforce no-UPDATE/no-DELETE on `events_raw` by
trigger + test, while ADR-0012/WP-D10 mandate a retention-TTL sweeper, how does retention
free space without violating the append-only substrate? (docs-consistency view: **C6**.)

**Recommended resolution (audit §4.2 / §9.2, architect lens).** Retention **deletes
projections only**; `events_raw` ages out via **segment-level archival** — a closed period
is detached into an archive file, so deletion is a file operation, never row DML. The
no-UPDATE/no-DELETE triggers and the replay P0 test (rebuild the DB from JSONL) both
survive intact.

**If left open.** Genuine design collision that surfaces as a **red build in Track D** the
moment WP-D10 (the TTL sweeper) meets the immutability triggers. *(Amended 2026-08-15: the
collision itself is resolved — see below — so Track D was not, in the end, blocked from
starting. What remains blocked is WP-D10's **completion**.)*

**Split into two halves (2026-08-15).** This decision turned out to contain a design
question and a numbers question, and only one of them is yours.

**(a) MECHANISM — built, resolved exactly as recommended.** `apps/server/src/retention/`
(`policy.ts`, `prune.ts`, `journal.ts`, `runner.ts`, `backup-files.ts`) plus
`apps/server/src/db/retention-queries.ts` implement a bounded transactional prune of
**projections only**. `events_raw` is never a delete target under any policy: a static source
guard proves no DML in the tree targets `events_raw`, `sessions`, `agents`,
`orchestration_edges`, `model_pricing` or `schema_version`, so the append-only triggers and
the replay-from-JSONL P0 test both survive untouched. Two honesty properties are worth
noting. The archival branch you might have chosen is **declared but rejected loudly**:
`rawEvents: 'archive-segments'` is a valid thing to *write* in a policy and an error to
*run*, because implementing it needs a schema act this lane may not make — a policy that
silently did nothing would be far worse than one that refuses. And pruning priced rows
requires an explicit `acknowledgeCostLoss`, after which the prune will not run without an
fsync'd JSONL receipt written **inside** the delete transaction: dollars can leave the
database, but never quietly.

**(b) POLICY — the numbers, still yours, still blocking.** How many days of what is kept is
**not set**, and `policy.ts` says so in its own header: *"the retention MECHANISM is
implemented … the retention POLICY … is NOT set and is not an agent's to set … WP-D10 is
therefore NOT done: half of it - the mechanism - exists, and the numbers are blank by
design."* The default, `NO_RETENTION`, deletes nothing ever; an environment with no
`DASHBOARD_RETENTION_*` variable behaves **byte-identically to a build without the module**.
Nothing invokes retention on a timer or over HTTP. So the shipped state is not a quiet
default policy — it is *no* policy, which is the only honest thing to ship while the question
is open.

- [ ] Accept: retention deletes projections only; `events_raw` ages out by segment
      archival (file detach), never row DML. *(Mechanism half implemented 2026-08 —
      projections-only prune shipped; `archive-segments` declared and rejected loudly, not
      implemented. Ticking ratifies the design, it does not describe new work.)*
- [ ] Choose another resolution: ________________________________________________
- [ ] Policy numbers — retention window(s): _____________________________________
      · prune `token_usage` too? (requires `acknowledgeCostLoss`): _______________
      *(Blank today. WP-D10 stays open until these are filled.)*

### OPEN-2 — `'unknown'` missing from the `agents.status` CHECK 🟥 blocks Track D

**Question.** The reference DDL (`data-model.md`, `glossary.md`, ADR-0006) allows
`('working','waiting','completed','error')`, but WP-IN12's missing-`Stop` watchdog assigns
`'unknown'` — do we add `'unknown'` to the CHECK, and what is the unknown→revert rule?
(docs-consistency view: **C5**.)

**Recommended resolution (audit §4.2 / §10.4).** **Add `'unknown'` to the `agents.status`
CHECK constraint** and **define the unknown→revert rule** (the open follow-up, v2 §7 q5) —
i.e. how an agent leaves `'unknown'` once a late signal arrives.

**If left open.** The WP-IN12 watchdog writes a value the CHECK rejects → insert fails at
runtime; the status enum is a Track-D schema object, so this blocks Track D alongside
OPEN-1.

**Implemented, awaiting ratification (not a tick).** The CHECK now allows all five values,
and the status lifecycle ships with this revert rule, enforced in SQL inside the upsert
(`apps/server/src/db/agents.ts`, mirrored in `db/sessions.ts`): (1) observed terminals
(`completed`, `error`) are **sticky** — no later ingest downgrades them; (2) inferred states
(`working`, `waiting`, `unknown`) are replaced only when the incoming activity anchor
(`last_seen_at` / `last_activity_at`) **strictly advances**, so a late signal or fresh
transcript activity lifts an agent out of `'unknown'`; (3) an unchanged replay therefore
changes nothing, which is what keeps the P0 byte-identical double-replay proof green. See
`docs/site/architecture/ingest-reconciliation.md` §8.1. Ticking the box below remains the
owner's call.

- [ ] Accept: add `'unknown'` to the CHECK **and** define the revert rule below.
      Revert rule: ______________________________________________________________
- [ ] Choose another resolution: ________________________________________________

### OPEN-3 — Redaction phase: Phase 1 or Phase 2? 🟥 blocks Track D

**Question.** ADR-0012 says "retention TTL + payload redaction **from Phase 1**", while
`operations/backup-restore.md` §5 wires the redactor at WP-IN14 with a **Phase-2** exit
criterion — which phase owns redaction? (docs-consistency view: **C7**.)

**Audit position.** §4.2 states the two docs disagree and says "pick one"; the audit did
**not** hard-recommend a phase there. Its **QA lens (§9.4)** does supply the deciding
argument, though: the fixture redaction rule is undefined, the golden corpus is built from
your **real sessions** (real paths, names, potentially secrets) **with a public repo on the
horizon** — a privacy gap. That argument, plus ADR-0012's own "from Phase 1" stance, points
to **Phase 1**. The final pick is yours.

**If left open.** The golden corpus and fixtures may be captured with unredacted secrets;
if redaction slips to Phase 2, that material has to be rebuilt (or worse, leaks to a public
repo). Redactor wiring (WP-IN14) and the fixture pipeline stay blocked.

**Implemented, awaiting ratification (2026-08-15) — not a tick.** The Phase-1 answer is what
shipped: `apps/server/src/hooks/redact.ts` scrubs hook payloads **at the ingest boundary**,
before persistence and before the idempotency key is computed — so a redelivered event
redacts identically and still dedupes rather than landing twice under two different keys. Two
independent rules run: key-based (any field whose normalised name matches `token`, `secret`,
`password`, `credential`, `apikey`, `authorization`, `bearer`, `privatekey`, `accesskey` … is
replaced wholesale, whatever its value type) and value-based (string values are scanned for
credential shapes — `sk-`/`ghp_`/`xox`/`AKIA` keys, JWTs, `Bearer <…>` fragments — and each
match is masked in place). An explicit allowlist keeps token-**count** fields
(`input_tokens`, `output_tokens`, …) intact, because those are the observability data the
whole product exists to report, not credentials.

The module's own header records the status honestly: this implements the recommended
resolution *as the default*, "PENDING Ivan's sign-off", and **"Nothing here relaxes on
sign-off - it can only grow."** That asymmetry is the point. Redaction is the one policy
where shipping the stricter option early costs nothing recoverable and shipping the looser
option early can leak a secret into a public repo permanently, so the code took the strict
branch unilaterally and left the decision open. What is genuinely still open is **ratification
of the field list** — and any future change to it may only widen coverage, never narrow it.

- [ ] Phase 1 — redact from the start (aligns `backup-restore.md` §5 to ADR-0012; matches
      the §9.4 privacy argument). *(Implemented as the default; ticking ratifies it.)*
- [ ] Phase 2 — keep the WP-IN14 / Phase-2 exit criterion (aligns ADR-0012 to
      `backup-restore.md` §5). *(Choosing this would mean removing shipped redaction —
      state that explicitly if you pick it.)*
- [ ] Field list ratified as written: ___________________________________________
      *(Additions welcome; removals are out of scope by the rule above.)*

---

## B. Remaining open decisions

### OPEN-4 — Browser token transport: header vs cookie vs query 🟥 blocks remote-access / security WPs

**Question.** How does the browser present its auth token to the loopback server — request
header, cookie, or query parameter? (docs-consistency view: **C17**.)

**Audit position.** `security/remote-access.md` defers to `security/model.md`, which also
does not decide — a **circular, unowned** deferral (§4.2). The audit lists this under "close
the small opens" (§10.10) but **did not reach a recommendation**; the choice is yours from
the three catalogued options. (Security-sensitive: whichever is picked must respect the CD-5
same-origin check on the SSE stream and the loopback-only bind.)

**If left open.** The token-guard / remote-access surface cannot be implemented; the
circular deferral persists and two site pages that already promise concrete paths (e.g.
`apps/server/src/security/token-guard.ts`) have no defined mechanism to honor.

**Answered by implementation (2026-07/08) — awaiting ratification, not a design decision.**
`apps/server/src/server.ts` gates **every** routed path beginning with `/api/` in a single
global `onRequest` hook, comparing the presented token with `timingSafeTokenEqual`. The
transport is **`Authorization: Bearer`**, with exactly one sanctioned exception: `?token=` is
accepted on **`/api/stream` alone**, because `EventSource` cannot set request headers — there
is no header-based way for a browser to open an SSE connection. That exception is contained
in three ways rather than waved through: the query token is read only when the routed path is
the stream route; the stream additionally enforces the CD-5 same-origin check *before* auth,
so a foreign `Origin` is rejected 403 whether or not it holds a valid token; and
`redactedRequestSerializer` runs every logged URL through `redactTokenInUrl`, so the one place
a token can appear in a URL is also the one place the logs are guaranteed to scrub. Cookies
were not chosen and are not implemented.

One implementation detail is load-bearing enough to record here: authorisation keys on
`request.routeOptions.url` — the **matched route pattern** — not the raw request URL. Fastify
runs `onRequest` after routing, and the router percent-decodes before matching, so a raw-URL
prefix check would let `/%61pi/health` through as "not `/api/`" while the router happily
dispatched it to `/api/health`. Gating on the routed pattern is immune to that mismatch.

- [ ] Header (e.g. `Authorization: Bearer …`) *(Implemented. Ticking ratifies the shipped
      mechanism, including the single `?token=` exception for `/api/stream`.)*
- [ ] Cookie *(not implemented)*
- [ ] Query parameter *(not implemented as a general transport — stream route only)*
- [ ] Other: ____________________________________________________________________

### OPEN-5 — Hook-POST auth mechanism 🟥 blocks hook-ingest WPs

**Question.** The invariant (hook POSTs are authed) is decided; **which mechanism** — a
shared token or Unix-socket peer credentials? (docs-consistency view: **C13**.)

**Audit position.** This is question 8 in three architecture pages, while
`architecture/hooks.md` prose reads as if already settled — a settled-in-prose /
open-in-question-list contradiction (§4.2, C13). The audit **did not reach a
recommendation**; it catalogues the two options.

**If left open.** The hook-ingest endpoint's auth cannot be implemented; the prose and the
open-questions list stay in contradiction.

**Answered by implementation (2026-07/08) — the shared token won, and the interesting part
is how it is carried.** `/api/hooks/event` is not special-cased: it sits behind the same
global `/api/` gate as every other route (see OPEN-4), so the mechanism is the shared bearer
token. Unix-socket peer credentials were not implemented, and choosing them now would mean a
second transport, not a swap.

What the implementation adds beyond "shared token" is a delivery shape that keeps the token
out of every process's argv. `hooks/install.mjs` generates a `curl` invocation that names the
environment variable with `--variable '%DASHBOARD_TOKEN'` and references it from a
single-quoted `--expand-header` template, so **curl reads the environment itself at fire
time** and the shell never expands the secret into an argument. The first shipped shape
(`--header "... Bearer ${NAME}"`) did leak: any local process able to read curl's argv could
harvest the token during the POST window — which is precisely the local multi-user attacker
the token exists to stop. That fix requires curl ≥ 8.3.0; on an older curl the command fails
at option parse and delivers nothing, so the failure mode is **zero telemetry, never a leaked
token**. Reading the env at fire time also makes rotation export-and-done, with no baked
header file to regenerate.

- [ ] Shared token *(Implemented, including the argv-free curl delivery and the curl ≥ 8.3.0
      floor. Ticking ratifies it.)*
- [ ] Socket peer credentials (Unix-socket peer creds) *(not implemented)*
- [ ] Other: ____________________________________________________________________

### OPEN-6 — Pricing data source 🟥 blocks cost-model / Track-D cost attribution

**Question.** `model_pricing` is versioned and CI-gated (a no-price-row fails CI), but where
do prices come from and how does `verified_on` get refreshed? (audit §4.2, v2 §7 residue.)

**Audit position.** Nobody chose a source; the audit lists this under "close the small
opens" (§10.10) and **did not recommend one**. The only adjacent candidates surfaced
anywhere in the corpus are in LOST-2 (the **Anthropic Console / Analytics API**); treat
those as candidates, not a recommendation.

**If left open.** `model_pricing` has no provenance and no refresh process, so the CI
no-price-row gate cannot be satisfied honestly and the dollar-cost attribution moat rests
on unsourced numbers.

**Correction to the premise (2026-08-15): there is no `verified_on` column.** The shipped
table (migration 7, `model-pricing-with-seed`) is
`(model, bucket, usd_per_mtok, effective_from)`, keyed on
`PRIMARY KEY (model, bucket, effective_from)`; the question as
originally written asks how a column refreshes that was never built. The parts of it that
survive the correction are the two that matter, and both are still open:

1. **What is the authoritative price source?** The seeded numbers describe themselves, in
   `migrations.ts`, as "APPROXIMATE LIST prices — a mechanism proof for the cost engine, NOT
   a billing source", and they remain PROVISIONAL. Nobody has chosen a source of record.
2. **Does provenance justify a schema change?** If the answer to (1) is "a named source, as
   of a date", that fact currently has nowhere to live in the row. Adding it is a migration
   (`source` / `verified_on`), and per the freeze rule below it must be a **new** migration.

Two implementation facts constrain any answer. `effective_from` is a **coverage floor**, not
an authoring date: the seed is stamped `2026-01-01` although it was written on 2026-07-11,
because `computeCostUsd` resolves the latest rate with `effectiveFrom <=` the message
timestamp and throws when none is effective — a 2026-07-11 floor would halt every ingest of
the ~12.2k historical messages that predate it. And the seed constants are **frozen by
checksum**: every migration's content is hashed into `schema_version`, so editing a price in
place diverges the operator's database from the code (this already happened once — review
H-1). **A price change ships as a new migration carrying its own inline data, never as an
edit.** See also implementation-plan D6.

- [ ] Source of record: __________________________________  ·  refresh cadence /
      owner: __________________________________
- [ ] Provenance columns (`source`, `verified_on`) are worth a new migration:
      yes ☐ / no ☐

### OPEN-7 — App port number and where it is configured 🟥 blocks config / scaffold + remote-access docs

**Question.** Which port does the app bind (loopback), and where is that configured?
(docs-consistency view: **C18**.)

**Audit position.** `remote-access.md` flags the port as uncommitted; the tunnel examples
have nothing to bind to (§4.2, C18). The audit **did not pick a number**; the choice — and
its config location — is yours.

**If left open.** Tunnel/SSH examples reference a port that does not exist; scaffold and
remote-access docs cannot be finalized.

**Answered by implementation (2026-07/08).** The number is **4317**, defined once as
`DEFAULT_PORT` in `apps/server/src/config.ts` and overridable by the `DASHBOARD_PORT`
environment variable, which is parsed strictly — a non-integer or out-of-range value throws
at startup rather than falling back to the default, so a typo cannot silently move the
server. `hooks/install.mjs` re-declares the same constant with a comment pinning it to the
server's, since the generated hook command must target the same loopback port; the host part
of that target is hard-coded to `127.0.0.1` and only the port is variable. The tunnel and
remote-access examples now have a real number to reference.

- [ ] Port **4317**, configured as `DEFAULT_PORT` in `apps/server/src/config.ts`, override
      `DASHBOARD_PORT`. *(Implemented. Ticking ratifies it.)*
- [ ] Different port: ____________  ·  configured in: ____________________________

### OPEN-9 — "OPCⁿ" — define or drop 🟩 docs only, no track blocked

**Question.** "OPCⁿ" is an undefined token inherited from the vendor documents and used in
two live docs — do we define it or drop it? (audit §0.2 glossary, §4.2; ADR-0002 left it
open.)

**Audit position.** "Nobody has ever defined it" (§0.2); flagged **"define-or-drop"** since
v2 §7 and still open (§10.10). No firm recommendation was reached; because it has never had
a meaning, dropping it is the low-risk path, but that is your call.

**If left open.** Reader confusion and lingering docs debt in the two pages that still use
the term. No WP track is blocked.

**Still open, and the surface has grown (2026-08-15).** The token is now carried by
`contributing/licensing.md`, `contributing/decisions/README.md` and the LB2 ADR, which
records in its own status line that "OPCⁿ" remains undefined. Nothing depends on it
functionally — but LB2 defers commercial-line investment *until it is defined or dropped*, so
leaving it open keeps a scope decision parked behind an undefined word.

- [ ] Drop it (remove from the live docs that still use it)
- [ ] Define it as: _____________________________________________________________

---

## C. Closed — recorded for completeness, do not reopen

### OPEN-8 — Coverage boundary — ✅ CLOSED (2026-07-06)

The ">90%" vs "≥90%" coverage-gate ambiguity (audit §4.2 / C8, where ADR-0009 contradicted
itself) was **normalized to `>90%` on 2026-07-06**. This matches the project quality
conventions (README/CLAUDE.md coverage bar). **Resolved — no sign-off needed; do not
reopen.**

- [x] Coverage merge gate is **`>90%`**. (Closed 2026-07-06.)

**Overtaken by the build (2026-08-15) — the number moved up, the word "merge" is still
false.** The threshold shipped is **100%** for statements, branches, functions and lines, and
it is pinned in each package's own `vitest.config.ts` across all five packages, so ">90%"
above is now historical wording rather than the operative bar. All five additionally carry a
static guard that fails if a `v8 ignore` / `c8 ignore` / `istanbul ignore` pragma appears
anywhere in `src/` — four as `coverage-honesty.test.ts`, `apps/web`'s as the
`coverage honesty` block of `test/honesty.test.tsx`. The guard exists because a pragma
removes both arms of an operator from the **denominator**, which makes 100% reachable by not
looking.

What has **not** changed is the part of the sentence that says *merge gate*. Branch
protection on `main` is not enabled, so a failing coverage run cannot physically block
anything; the gate runs, reports, and is obeyed by convention. Enabling protection is an
owner act on GitHub, not a code change, and until it is done "blocks merges" should be read
as **UNENFORCED**. Recording that here rather than quietly upgrading the closed decision —
the closure was about a comparison operator; the enforcement question was never closed
because it was never asked.

---

## Sign-off ledger

Two columns were added on 2026-08-15. **Build status** says what the code does today;
**Decided** stays empty until you sign. They are deliberately separate: a shipped default is
a question still waiting for an answer, and nothing below has been answered by being built.

| # | Decision | Blocks | Recommendation reached by audit? | Build status (2026-08-15) | Decided (date) |
|---|---|---|---|---|---|
| OPEN-1 | Retention TTL vs `events_raw` immutability | 🟥 Track D | Yes — projections-only + segment archival | Mechanism built; **policy values unset** (`NO_RETENTION`) | |
| OPEN-2 | `'unknown'` in `agents.status` CHECK | 🟥 Track D | Yes — add `'unknown'` + revert rule | Implemented (CHECK + sticky-terminal revert rule) | |
| OPEN-3 | Redaction Phase 1 vs 2 | 🟥 Track D | Lean Phase 1 (§9.4 privacy); pick yours | Phase 1 implemented as the default; field list unratified | |
| OPEN-4 | Browser token transport | 🟥 remote-access / security | No — options only | Implemented: Bearer header + one `?token=` exception on `/api/stream` | |
| OPEN-5 | Hook-POST auth mechanism | 🟥 hook-ingest | No — options only | Implemented: shared token, argv-free curl delivery | |
| OPEN-6 | Pricing data source | 🟥 cost-model / Track-D cost | No — candidates only (LOST-2) | **Still open** — seed is PROVISIONAL; no `verified_on` column exists | |
| OPEN-7 | App port + config location | 🟥 config/scaffold + remote-access | No — pick a number | Implemented: **4317**, `DEFAULT_PORT` / `DASHBOARD_PORT` | |
| OPEN-8 | Coverage boundary | — | ✅ Closed `>90%` (2026-07-06) | Threshold is 100% in five packages; **merge-blocking UNENFORCED** | 2026-07-06 |
| OPEN-9 | "OPCⁿ" define or drop | 🟩 docs only | No firm rec (drop is low-risk) | **Still open** — now in three site docs | |
