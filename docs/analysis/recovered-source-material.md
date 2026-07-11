# Recovered source material — vendor v2 §§12/13/16/17

**Purpose.** This document recovers substantive content from the git-excluded vendor
due-diligence docx that the corpus audit flagged as *lost in digestion* — material that
was in the source but never reached the plan of record. It closes findings **LOST-1**,
**LOST-2**, **LOST-3** and **LOST-4** from
[`corpus-audit-2026-07-06.md`](corpus-audit-2026-07-06.md) §4.3 / Appendix A.

**Provenance.** All content below is extracted verbatim (values and prose) from
`due-diligence/Claude-Code-Agent-Dashboards_Due-Diligence_v2.docx`, which is local-only
(git-excluded per project policy). Nothing here is invented; where I add framing for
agenthropic it is explicitly labelled **[derived — not from source]**.

**A note on the source's section numbers.** Vendor v2 is partially templated. Its
top-level headings read **§12 Fine-Grained Feature Matrix**, **§13 Adjacent Tools**,
**§16 Risk Register**, **§17 Cost-of-Ownership Scenario Model**, but the *subsection*
labels underneath them are mis-numbered (they restart at 13.x / 14.x). This is the same
"templated apparatus" artifact the corpus audit calls out (Appendix A, generation-quality
note). I cite by the top-level numbers the corpus audit uses (§12/§13/§16/§17) and
preserve the real subsection titles.

---

## LOST-1 — Vendor v2 §12: the 24-capability feature matrix

The section-level reviews (§§5–9) compare the projects by discipline. §12 drops to
individual capabilities so features map to needs directly. Legend, verbatim from source:
**✓** = present and verified in source; **~** = partial or via workaround; **✗** = absent.
Columns: `hoang.` = hoangsonww, `simple10`, `disler`, `cast`, `nird.` = nirdiamant.

The matrix has **24 capabilities** across three groups (9 + 7 + 8).

### §12.1 Visualisation capabilities

| Capability | hoang. | simple10 | disler | cast | nird. |
|---|:--:|:--:|:--:|:--:|:--:|
| Orchestration DAG / graph | ✓ | ~ | ✗ | ✓ | ~ |
| Tool-execution Sankey | ✓ | ✗ | ✗ | ✗ | ✗ |
| Agent swim-lanes | ✓ | ✓ | ✓ | ✓ | ✗ |
| Live activity pulse | ✓ | ✓ | ✓ | ✓ | ✓ |
| Subagent hierarchy tree | ✓ | ✓ | ~ | ✓ | ✗ |
| Full transcript replay | ✓ | ✓ | ✓ | ~ | ✗ |
| Collaboration network | ✓ | ✗ | ✗ | ~ | ✗ |
| Error-propagation map | ✓ | ✗ | ✗ | ✓ | ✗ |
| Config/prompt logic map | ✗ | ✗ | ✗ | ✗ | ✓ |

### §12.2 Data & cost capabilities

| Capability | hoang. | simple10 | disler | cast | nird. |
|---|:--:|:--:|:--:|:--:|:--:|
| First-class agent entities | ✓ | ✓ | ✗ | ✓ | ~ |
| Per-model cost breakdown | ✓ | ✓ | ~ | ✓ | ✗ |
| Delegation-savings metric | ✗ | ✗ | ✗ | ✓ | ✗ |
| Cache-token accounting | ✓ | ~ | ✗ | ~ | ✗ |
| Compaction-aware totals | ✓ | ✗ | ✗ | ✗ | ✗ |
| Token burn / quota window | ✓ | ✓ | ~ | ✓ | ✗ |
| Snapshot / restore | ✗ | ✗ | ✗ | ✗ | ✓ |

### §12.3 Operations & integration capabilities

| Capability | hoang. | simple10 | disler | cast | nird. |
|---|:--:|:--:|:--:|:--:|:--:|
| Alert rules | ✓ | ✗ | ✗ | ~ | ✗ |
| Outbound webhooks | ✓ | ✗ | ✗ | ✗ | ✗ |
| Auth-gated writes | ~ | ~ | ✗ | ✓ | ✗ |
| Plugin install | ✓ | ✓ | ✗ | ✗ | ✗ |
| Desktop app | ✓ | ✗ | ✗ | ✓ | ✗ |
| TUI | ✗ | ✗ | ✗ | ✓ | ✗ |
| Multi-tool (Codex/etc.) | ✗ | ✓ | ✗ | ✗ | ✗ |
| MCP server included | ✓ | ✓ | ✗ | ✗ | ✗ |

### §12.4 Reading the matrix (verbatim)

> hoangsonww leads the visualisation and operations rows decisively — it is the only
> project with the Sankey, collaboration network, alert rules and outbound webhooks
> together. cast is the only source of the delegation-savings metric and the only one
> with a TUI. simple10 is alone in multi-tool support. nirdiamant's single ✓ column
> (config-logic map, snapshot) confirms it plays a different game. disler's row is sparse
> by design — it is the minimal baseline others extend.

### Re-framed as an agenthropic UI checklist  **[derived — not from source]**

The 24 capabilities become the closest thing the corpus has to a target-feature checklist
for agenthropic's own UI. Each row below is a build target; the ✓/~/✗ above is the field
baseline agenthropic is measured against. Status is a *planning aid*, grounded in the
security invariants and CD decisions already recorded in the corpus — it is **not** a
committed scope and does not override any lane's own design doc. Boxes are unchecked
because no code is scaffolded yet (pre-Gate-A).

**Visualisation**
- [ ] **Orchestration DAG / graph** — core moat. First-class persisted subagent DAG from
  `parent_agent_id`; the graph is a data fact, not a UI reconstruction (design invariant).
- [ ] **Subagent hierarchy tree** — same substrate as the DAG; queryable agents/subagents.
- [ ] **Live activity pulse** — realtime via **SSE** (CD-5), not WebSocket; same-origin check.
- [ ] **Full transcript replay** — replay from the immutable `events_raw` substrate (P0 replay test).
- [ ] **Error-propagation map** — target; derivable once edges + agent status are modelled.
- [ ] **Tool-execution Sankey** — candidate (hoangsonww-only in the field); nice-to-have, not core.
- [ ] **Agent swim-lanes** — candidate timeline view; common in the field.
- [ ] **Collaboration network** — candidate; lower priority.
- [ ] **Config/prompt logic map** — out of scope for v1 (nirdiamant's niche).

**Data & cost**
- [ ] **First-class agent entities** — design invariant (agents/subagents are queryable entities).
- [ ] **Per-model cost breakdown** — token counts are ground truth from `~/.claude/projects/*.jsonl`, never inferred.
- [ ] **Token burn / quota window** — derivable from the same ground-truth token stream.
- [ ] **Cache-token accounting** — target; part of faithful token reconciliation (field-leading only in hoangsonww).
- [ ] **Compaction-aware totals** — target; hoangsonww is the *only* field example, so a genuine differentiator.
- [ ] **Delegation-savings metric** — target differentiator (only cast has it today); part of the stated vision.
- [ ] **Snapshot / restore** — partially covered by SQLite WAL + backup/restore ops, not a per-session UI feature in v1.

**Operations & integration**
- [ ] **Auth-gated writes** — non-negotiable: auth-gate all endpoints; authed hook-POST (field is only ~/✗ here).
- [ ] **Alert rules** — **v2.0 only** (alerts entered via KC-5, earned by real daily use). Off the v1 critical path.
- [ ] **Outbound webhooks** — **v2.0** alert transport (e.g. Telegram sink); deferred with alerts.
- [ ] **MCP server included** — candidate later; not a v1 requirement.
- [ ] **Plugin install** — not a target (agenthropic is a standalone self-hosted app, not a CC plugin).
- [ ] **Desktop app** — not a target (loopback web UI).
- [ ] **TUI** — not a target.
- [ ] **Multi-tool (Codex/etc.)** — not a target (Claude Code-specific by design).

---

## LOST-2 — Vendor v2 §13: adjacent tools & the wider landscape

The five shortlisted projects are purpose-built dashboards. §13 maps the *adjacent* tooling
so the shortlist sits in context. These are not substitutes for a visual dashboard but may
complement one. Recovered verbatim:

**§13.1 Cost/usage CLIs (no visualisation)**
- **ccusage** — parses local JSONL session logs entirely on-machine, no API key, prints
  daily/monthly/per-session/5-hour-block cost with per-model and cache breakdowns. Excellent
  for quick cost checks; no orchestration view.
- **claude-token-lens** — real-time token attribution from JSONL, live burn-rate and ETA,
  5h/7d tracking, zero telemetry. Terminal-only.

**§13.2 Telemetry backends (bring-your-own-dashboard)**
- **OpenTelemetry → SigNoz / Grafana** — **Claude Code emits a stable OTel span schema with
  `query_source` values (main / subagent / auxiliary).** Route spans to a self-hosted SigNoz
  for a durable, queryable backend. The most "serious" option for long-term telemetry, but
  you build the views.
- **LiteLLM gateway** — meters everything through virtual keys with per-developer budgets;
  the central option for Bedrock/Vertex deployments where the Analytics API doesn't reach.
  Overkill for a solo local setup.

**§13.3 First-party sources**
- **Anthropic Console** — the source of truth for API billing, with per-user
  sessions/commits/PR counts via the Analytics API. Requires an Admin API key; unavailable
  on some hosted deployments. Complements but does not replace a local visual dashboard.

**§13.4 Where the shortlist fits (verbatim)**
> The shortlisted dashboards occupy the sweet spot the CLIs and backends miss: real-time
> visual orchestration for a single developer, self-hosted, zero-config. If your needs ever
> expand to org-wide governance or multi-cloud metering, the backends above become relevant
> — but for the stated use case, a purpose-built dashboard is the right layer, and the CLIs
> (ccusage) are a useful zero-setup companion for cost spot-checks.

### Why this matters for agenthropic  **[derived — not from source]**

The `query_source` = `main`/`subagent`/`auxiliary` OTel signal is the finding the corpus
audit singles out (LOST-2): Claude Code exposes a **stable, documented** span attribute that
labels *which kind of query* produced each span. agenthropic's primary ingest is the
`~/.claude/projects/*.jsonl` files (CD-1), whose subagent structure is reconstructed from
undocumented internals — so `query_source` is a **corroborating (or fallback) signal** for
the main/subagent/auxiliary distinction the parser otherwise infers. Worth capturing in the
WP-S* spike scope as a cross-check on the JSONL-derived tree, and as a hedge against the
hook-schema-drift risk below (LOST-3). ccusage is also a useful zero-setup companion for
validating agenthropic's own per-model / cache cost numbers against an independent parser.

---

## LOST-3 — Vendor v2 §16: risk register

Structured register of material risks across the shortlist, scored by likelihood and impact
(Low/Medium/High); the composite drives mitigation priority. Recovered verbatim.

### §16.1 Cross-project risks

| Risk | Likelihood | Impact | Mitigation |
|---|:--:|:--:|---|
| Solo-maintainer abandonment | High | High | Fork and self-host; pin versions; do not depend on upstream cadence |
| Breaking schema change pre-1.0 | High | Medium | Pin a known-good commit; test upgrades in a scratch clone before adopting |
| **Hook-schema drift in Claude Code** | **Medium** | **High** | Choose a project with active maintenance (hoangsonww/cast) to absorb upstream changes |
| Licence dispute on commercial use | Medium | High | Use only MIT-with-file projects for anything client-facing |
| Accidental network exposure | Medium | High | Enforce loopback bind; audit before any reverse-proxy |
| Data-integrity loss on crash | Low | Medium | SQLite WAL + periodic backup of the .db file |

### §16.2 hoangsonww-specific risks

| Risk | Likelihood | Impact | Mitigation |
|---|:--:|:--:|---|
| Run-spawner RCE if exposed | Medium | Critical | Delete spawner routes; never bind 0.0.0.0 with it active |
| 92k-LOC self-support burden | High | Medium | Budget maintenance time; keep fork minimal by stripping unused packages |
| Feature bloat obscuring core | Medium | Low | Disable MCP/desktop/vscode packages if only the dashboard is needed |
| **CLA relicensing surprise** | Low | Low | Note the CLA; your fork remains MIT regardless |

### §16.3 Risk-adjusted ranking (verbatim)

Folding the risk register back into the scoring, the risk-adjusted order for the client's
context is:
- **hoangsonww (harden-first)** — highest raw fit, risks known and cheaply mitigated by forking and stripping the spawner.
- **simple10** — lowest residual risk profile; the Docker dependency is an annoyance, not a hazard.
- **cast** — low security risk but high adoption risk from framework coupling and immaturity.
- **disler** — licence and staleness risks dominate; acceptable only for non-commercial learning.
- **nirdiamant** — low risk but low relevance; wrong problem.

### Why this matters for agenthropic  **[derived — not from source]**

The corpus audit (LOST-3) flags **"Hook-schema drift in Claude Code" (Medium / High)** as a
live risk for the greenfield build too — not only for the fork-a-rival options. The source's
mitigation ("pick an actively-maintained upstream to absorb the drift") does not exist for a
greenfield project: agenthropic *is* the parser that reads undocumented CC internals, so it
absorbs the drift itself. The audit's own framing is that the parser reads undocumented
internals across the observed CC versions — meaning agenthropic must own a version-census /
drift-detection mechanism rather than delegate it upstream. The **CLA relicensing** note
(hoangsonww, Low/Low) is recovered here as the audit requested; it is materially relevant only
if agenthropic ever grafted forked code (CD-9 forbids copying — clean-room only), so for the
greenfield path it is informational.

---

## LOST-4 — Vendor v2 §17: cost-of-ownership scenario model

Money here is time, not licence fees — every project is free. The real cost is the
engineering hours to adopt, harden, integrate and maintain. Estimates are order-of-magnitude,
in **developer-days**, for an experienced engineer. They are planning aids, not quotes.
Recovered verbatim.

### §17.1 Scenario A — internal cockpit, minimal integration

Goal: a working self-hosted dashboard showing live subagent activity, loopback only, no
external integrations.

| Project | Adopt | Harden | Notes |
|---|:--:|:--:|---|
| hoangsonww | 0.5 d | 1 d | Docker-compose up; strip spawner; wire hooks |
| simple10 | 0.5 d | 0.25 d | Plugin install; Docker daemon setup |
| disler | 1 d | 0.5 d | Bun+Python+uv toolchain; per-project hooks |
| cast | 1 d | 0.5 d | Plus CAST-OS install for full value |
| nirdiamant | 0.5 d | 0.25 d | But wrong tool for this goal |

### §17.2 Scenario B — integrated into the OPCⁿ stack

Goal: dashboard + Telegram alerts to @baev_bot_bot + delegation-savings metric + session data
feeding the vector-DB context layer.

| Component | hoangsonww | simple10 | Notes |
|---|:--:|:--:|---|
| Base adopt + harden | 1.5 d | 0.75 d | Per Scenario A |
| Telegram alert sink | 1 d | 2.5 d | hoangsonww has webhook schema; simple10 needs it built |
| Delegation-savings metric | 1.5 d | 1.5 d | Borrowed from cast's model; new work either way |
| Vector-DB session feed | 2 d | 2 d | Read the SQLite session tables into your middleware |
| **Total (approx.)** | **6 d** | **6.75 d** | hoangsonww's webhook schema saves ~1.5 d |

> The integration scenario is where hoangsonww's richer schema pays for its heavier
> maintenance: the pre-existing alert/webhook plumbing saves roughly a day and a half of
> Telegram-sink work versus building it on simple10.

### §17.3 Ongoing maintenance

| Project | Est. maint/quarter | Driver |
|---|:--:|---|
| hoangsonww | 1–2 d | Large surface; but active upstream absorbs hook-schema drift |
| simple10 | 0.5–1 d | Small clean surface; Docker updates |
| disler | 1–2 d | No tests = manual regression checking on every change |
| cast | 1–1.5 d | Coupled to CAST-OS version cadence |
| nirdiamant | 0.5 d | Small; but limited value delivered |

### Reading these for agenthropic  **[derived — not from source]**

These sizings are for *adopting/forking a rival*, not for the greenfield build agenthropic
chose — the whole "~6 developer-days" cost model in §17 assumes a fork with a pre-existing
schema. The corpus audit (LOST-4) notes the roadmap "kept the phases and dropped all effort
numbers"; these are the dropped numbers. They are useful as **calibration**: the adopt-and-
harden path was ~6 dev-days, so agenthropic's greenfield estimate should be read against that
floor, and the specific line items (Telegram sink ~1–2.5 d, delegation-savings ~1.5 d,
vector-DB feed ~2 d) are the effort deltas for the features agenthropic deferred to v2.0 /
the experimental track. Note the ongoing-maintenance driver for hoangsonww — "active upstream
absorbs hook-schema drift" — is precisely the mitigation the greenfield build cannot buy
(see LOST-3).

---

## LOST-8 — do NOT propagate the "no true DAG" quote

Recorded here so this recovery does not reintroduce the error. The independent audit
attributes a **"no true DAG"** verbatim quote to the vendor, characterising it as a factual
error about simple10. **That quote is not verbatim in either vendor docx.** What the sources
actually say:
- §12.1 scores simple10 **~ (partial)** on "Orchestration DAG / graph" (not ✗).
- Every literal "no DAG" phrase in both docx refers to **disler**, not simple10 (v1 disler
  deep-dive; v2 §9.3 and the Decision FAQ — "disler … has no DAG").

So the vendor never said simple10 has "no true DAG". The audit's *core* argument (the
visualisation tie-break is contestable; the vendor's own weighted model ranks simple10 first,
4.1 vs 4.0) still stands — but the "factual error / no true DAG" characterisation is stronger
than the source warrants. Per LOST-8, treat it as a **contestable judgment call**, and do not
quote "no true DAG" as the vendor's words anywhere.

---

## Recovery status

| Finding | Source | Status |
|---|---|---|
| LOST-1 — 24-capability feature matrix | v2 §12 | **Fully recovered** (all 24 rows × 5 columns, verbatim) + UI-checklist reframing |
| LOST-2 — adjacent tools / `query_source` | v2 §13 | **Fully recovered** (verbatim) |
| LOST-3 — risk register / hook-schema drift / CLA | v2 §16 | **Fully recovered** (both tables + ranking, verbatim) |
| LOST-4 — cost-of-ownership sizing | v2 §17 | **Fully recovered** (all three tables, verbatim) |
| LOST-8 — "no true DAG" | v1/v2 (absence) | Confirmed **not in source**; do not propagate |

Nothing in the four target sections was unrecoverable — the v2 docx extracts cleanly with
`textutil -convert txt` and every table survived intact (only the templated subsection
numbering was corrected, as noted at the top).
