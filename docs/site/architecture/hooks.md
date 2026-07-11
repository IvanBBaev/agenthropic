# Hook ingestion

agenthropic wires all twelve Claude Code lifecycle hooks to a **single hook-handler**,
which forwards every event, unmodified, to one authed loopback receiver
(`HookSource`). Two of the twelve — `SubagentStart` and `SubagentStop` — get
**dedicated handling** because they are the only events that can directly assert a
parent→child relationship, and the hierarchy tables (`agents.parent_agent_id`,
`orchestration_edges`) are built from them. Everything else lands as a normal row.
The governing principle, stated directly in the design basis:

> "The differentiator is what we do with events after ingestion, not which we
> receive." — [`DESIGN.md` §5](../../ai/DESIGN.md)

Concretely, that means the ingest boundary is **accept-any-event**: a never-seen
`event_type` is stored, not rejected and not crashed on. Ingestion is deliberately
dumb; the value is created downstream, in the Normalizer and Projection stages
described in [ingest & reconciliation](ingest-reconciliation.md) and
[the data model](data-model.md).

## The twelve lifecycle events

The hook configuration registers all twelve event names (`DESIGN.md` §5):

| # | Event | Fires around | What ingest does with it | Dedicated handling |
|---|---|---|---|---|
| 1 | `PreToolUse` | Before a tool call executes | Interim liveness/state signal for the acting agent (hooks give *interim* state; JSONL remains the final authority — CD-3, see [ingest & reconciliation](ingest-reconciliation.md)) | No |
| 2 | `PostToolUse` | After a tool call completes | Interim state signal; when the tool is a spawn tool (`Agent`/`Workflow`), this is also one half of the **dual-path edge derivation** used to build `orchestration_edges` if `SubagentStart` never fires | No (except the `Agent`/`Workflow` spawn-tool case feeding edge derivation, `WP-IN8`) |
| 3 | `PostToolUseFailure` | A tool call errors | Interim error signal — feeds the `agents.status = 'error'` case (`DESIGN.md` §4) | No |
| 4 | `UserPromptSubmit` | The user submits a prompt | Session-activity marker | No |
| 5 | `Notification` | Claude Code emits a lifecycle notification | Stored generically; a candidate future input for the alert-rules engine (Track A, Phase 5), which reads the *projection*, not raw hook payloads | No |
| 6 | `Stop` | The main agent turn/session stops | Interim status transition for the main agent | No |
| 7 | `SubagentStop` | A subagent finishes | **Yes** — closes the subagent's row; is the other half of the dual-path edge derivation when `SubagentStart` never fired; a *missing* `SubagentStop` triggers the watchdog "unknown" rule (`WP-IN12`) rather than a permanent `working` state | **Yes** |
| 8 | `SubagentStart` | A subagent begins *(unconfirmed — see below)* | **Yes, when it fires** — forward-links parent→child immediately, ahead of any post-hoc reconstruction | **Yes** |
| 9 | `SessionStart` | A session begins | Opens the session record | No |
| 10 | `SessionEnd` | A session ends | Interim close signal; the final session state is still JSONL-authoritative (CD-3) | No |
| 11 | `PreCompact` | Before a context compaction | Marks the compaction boundary so `token_usage` can preserve a repriceable baseline (see [cost model](cost-model.md)); whether the log itself carries a matching pre/post marker is open question **G0.2b** | No |
| 12 | `PermissionRequest` | Claude Code requests a permission decision | Stored generically; not part of the documented nine-event set, so whether it fires at all is unconfirmed (`concept-analysis-v2.md` §4.2 — see the `SubagentStart` hedge below) | No |

Full field-by-field payload reference and the `agents.status` / event vocabulary are
scoped to [the glossary](glossary.md) (`DOC-A7`), not duplicated here — this page
covers what each event *is for*, not its exact JSON shape (not yet fixed; see
[Open items](#open-items-not-yet-built) below).

## Why `SubagentStart`/`Stop` get dedicated handling

`agents.parent_agent_id` and `orchestration_edges` are the hierarchy tables — "the
subagent tree is a data fact, not a client-side UI reconstruction from a flat event
log" (`DESIGN.md` §3). Building that fact requires knowing, at ingest time, which
agent spawned which. Only two events can carry that assertion directly:

- **`SubagentStart`** — if it fires, forward-links the child to its parent the moment
  the subagent begins.
- **`SubagentStop`** — closes the subagent's lifecycle and is the fallback anchor for
  edge derivation when no `SubagentStart` arrived.

This is precisely the gap the project's own reference implementation gets wrong:
`disler`'s ~180-line `send_event.py` is "the clearest teaching example of hook→HTTP→SQLite→WS"
but is explicitly **not** built on because "its server *drops* `agent_id`/`agent_type`"
(`DESIGN.md` §3, §7) — i.e. it ingests events but throws away exactly the fields the
hierarchy tables need. Dedicated handling for `SubagentStart`/`Stop` exists so
agenthropic does not repeat that mistake.

### The `SubagentStart` hedge — read before you build the normalizer

`DESIGN.md` §5 lists `SubagentStart` in parentheses — `` `SubagentStop` (+ `SubagentStart`) ``
— deliberately, not as a typo. The source-level pass behind the development plan is
more blunt:

> "`SubagentStart` is probably not a real hook — the documented set is
> PreToolUse/PostToolUse/UserPromptSubmit/Notification/Stop/SubagentStop/SessionStart/SessionEnd/PreCompact.
> Plan for its **absence** as the base case." — `concept-analysis-v2.md` §4.2

That "documented set" is nine events; it does not include `SubagentStart`,
`PermissionRequest`, or `PostToolUseFailure` either. Whether the runtime actually
fires those three is unconfirmed until the Phase-0 spike reports. Confirming or
denying `SubagentStart` specifically is **G0.2** (`concept-analysis-v2.md` §7,
`WP-S4` in the development plan): *"which of the assumed 'twelve' actually fire —
specifically does `SubagentStart` exist? If not, edge derivation keys off the
`Agent`/`Workflow` spawn tools' `PostToolUse` + `SubagentStop`."*

That fallback is exactly what `WP-IN8` builds — **dual-path edge derivation**:

> "Correct parent→child tree via the JSONL `Agent`/`Workflow` spawn chain **even if
> `SubagentStart` never fires**." — `development-plan.md`, `WP-IN8`

So the hooks page and the code it describes are written so the hierarchy tables are
correct either way: `SubagentStart` is wired and used opportunistically if the
Phase-0 spike confirms it fires; if it doesn't, the same tables are populated from
`SubagentStop` plus the JSONL `Agent`/`Workflow` spawn-tool invocation chain, with no
code change to the schema. This is why `hooks.md` and [the DAG moat](dag-moat.md) both
describe `orchestration_edges` as *dual-path*, not *hook-derived*.

> **Empirically grounded (2026-07-04 desktop corpus probe).** The read-only full-corpus
> probe confirms the spawn tool is `Agent`/`Workflow`, never `Task` (`Task` blocks = **0**,
> `Agent` = 142, `Workflow` = 29) — a parser hard-keyed to `name=='Task'` reconstructs an
> **empty** DAG. It also confirms the join is genuinely dual-path (flat: `meta.toolUseId`
> equals the `Agent` spawn's `tool_use.id`; nested: `workflows/wf_*/` directory containment
> for `Workflow`; **85%** of agent files are nested). On that evidence **CD-1 is pre-answered
> `CONDITIONAL-GO`, confidence 85** — but this only **de-risks**, it does not replace the
> formal Phase-0 spike (`WP-S4`/`WP-S7`), which confirms it on the paired-capture corpus and
> **still gates all production code**. See [Phase-0 corpus probe](../../analysis/phase0-probe.md).

A related, separately-tracked failure mode: a `SubagentStop` that never arrives (a
crashed subagent) must not leave an agent permanently `working`. `WP-IN12`'s
missing-Stop watchdog flips it to an explicit `unknown` state within a bounded
window instead — detailed in [troubleshooting](../operations/troubleshooting.md).

## Accept-any-event: stored, not crashed

The `HookSource` adapter (`WP-IN3`) is described in the development plan as an
"authed loopback POST receiver, **accept-any-event**." Its done-when criterion is
explicit:

> "Never-seen `event_type` → 202 + a row lands (audit-preserving)." — `WP-IN3`

The Phase 2 exit gate restates the same invariant at the system level: **"an unknown
event_type is stored, not crashed."** The rationale, from the same source-level pass
that produced the `SubagentStart` hedge:

> "Ingest must accept-and-store-raw ANY event type (graceful audit) so an
> unknown/new hook never crashes the pipeline; the normalizer keys only off verified
> events + `schema_version`." — `concept-analysis-v2.md` §4.2

Two things fall out of this:

1. **The hook receiver never validates against a fixed event-name allowlist.**
   A thirteenth event Anthropic ships tomorrow, or a locally-misconfigured hook
   name, still produces a `202` and a durable `events_raw` row — it simply isn't
   *interpreted* by the Normalizer until `WP-IN6` is taught to recognize it.
2. **Recognition is versioned, not hardcoded.** The Normalizer "keys only off
   verified events + `schema_version`" — so extending the twelve-event catalog is a
   Normalizer change, never an ingest-boundary change. This is also why the hooks
   page does not, and should not, assume the twelve are final or fully confirmed
   (see the `SubagentStart` hedge above).

## From raw envelope to projection

Every event — hook or JSONL line — goes through the same immutable-substrate,
deterministic-projection pipeline (`CD-2`, `development-plan.md` Track IN):

```
Claude Code lifecycle event (any of the twelve)
        │  single hook-handler script, invoked per event
        ▼
HookSource adapter  (WP-IN3)
  authed loopback POST · accept-any-event · unknown event_type → 202, row lands
        │
        ▼
raw envelope + cross-source idempotency key  (WP-IN1)
  a hook payload and the JSONL line for the *same fact*
  produce a byte-identical idempotency key
        │
        ▼
events_raw  (WP-D4 — immutable, append-only substrate)
  UPDATE/DELETE raises and leaves the row unchanged (test-proven)
        │
        ▼
Normalizer  (WP-IN6 — pure function)
  events_raw → events, deterministic: identical input → identical output
        │
        ▼
events  (WP-D5 — normalized, queryable; events.raw_event_id FK enforced)
        │
        ▼
Projection  (WP-IN7, precedence-aware)
        │
   ┌────┴─────────────┬───────────────────────┐
   ▼                   ▼                       ▼
sessions / agents   orchestration_edges     token_usage
(WP-D6, self-ref    (WP-D7 — the moat       (WP-D8 — fine-grained
 parent_agent_id)    artifact; dual-path      buckets, compaction
                     derivation, WP-IN8)      baseline, nullable
                                              agent_id, backfilled
                                              by WP-IN9)
```

`EventStore.append` (`WP-IN2`) is the port both the hook path and the JSONL
tail-follow path (see [ingest & reconciliation](ingest-reconciliation.md)) write
through, so **appending the same envelope twice produces exactly one row** — the
idempotency contract holds regardless of which source saw the fact first.

The self-referential shape those hierarchy tables are ultimately built into (from
`DESIGN.md` §4, the full annotated schema lives in [the data model](data-model.md)):

```sql
CREATE TABLE agents (
  id              TEXT PRIMARY KEY,
  session_id      TEXT NOT NULL,
  type            TEXT CHECK(type IN ('main','subagent')),
  subagent_type   TEXT,
  status          TEXT CHECK(status IN ('working','waiting','completed','error')),
  parent_agent_id TEXT,          -- self-ref: builds the subagent tree
  FOREIGN KEY (parent_agent_id) REFERENCES agents(id) ON DELETE SET NULL
);
```

## Hooks are interim, JSONL is authoritative

Reconciliation precedence (`CD-3`) governs how hook-sourced facts and JSONL-sourced
facts are weighed once they reach the projection:

- **Tokens are JSONL-authoritative, never inferred from hooks.**
- **Interim liveness/state** (is this agent currently `working`?) comes from hooks —
  they are the only source that reports state *before* the corresponding JSONL line
  is durably written.
- **Final session/agent state and cost** are resolved from JSONL.
- `token_usage.agent_id` is nullable at first write and deterministically backfilled
  once the owning agent is known (`WP-IN9`).

This is why the twelve hook events are not treated as twelve independent sources of
truth: most of them (rows 1, 2, 3, 4, 6, 9, 10 in the table above) contribute *interim*
signal that the projection later reconciles against — or overrides with — the
JSONL-derived final state. Full treatment of the JSONL-vs-hooks precedence question
(`CD-1`, the Phase-0 primacy probe) is [ingest & reconciliation](ingest-reconciliation.md),
not this page.

## Security posture of the hook receiver

The `HookSource` adapter is a write endpoint and follows the same non-negotiable
invariants as the rest of the app (`DESIGN.md` §8):

- **Loopback-only.** The receiver binds `127.0.0.1`, never `0.0.0.0`, mounted under
  the Fastify bootstrap (`WP-U0`) that makes loopback-or-fail and the auth gate real.
- **Mandatory, timing-safe auth.** Every POST to the receiver is gated by a
  `DASHBOARD_TOKEN`-style check using `timingSafeEqual` — not opt-in, not a
  no-op-when-unset (the mistake `DESIGN.md` §8 names explicitly against a rival's
  spawner-adjacent design). `WP-IN3` depends on `WP-U0` for exactly this wiring.
- **No SSRF surface.** The receiver stores payloads; it never dials a URL taken from
  a hook payload.
- **No spawner.** Ingestion never invokes `claude` or any subprocess derived from
  request input — full rationale in [security model](../security/model.md).

Full detail: [security model](../security/model.md) and
[threat model](../security/threat-model.md).

## Open items (not yet built)

Nothing in this page is implemented yet — Phase 0 (the feasibility spike) gates all
production code (`CD-8`), and `HookSource` itself is Phase 2 (`WP-IN3`). Concretely
open, sourced from the analysis:

- **Which of the twelve actually fire.** `WP-S4` / **G0.2** must confirm or deny
  `SubagentStart` (and, per the narrower nine-event "documented set" in
  `concept-analysis-v2.md` §4.2, `PermissionRequest` and `PostToolUseFailure` are
  similarly unconfirmed). See the hedge section above.
- **PreCompact marker mechanism (G0.2b).** Whether the log carries pre/post-compaction
  markers, or the baseline must be snapshotted at hook time, is open —
  `concept-analysis-v2.md` §7, item 4.
- **Hook-POST auth mechanics (open question, item 8).** *"Is the loopback hook
  endpoint itself authenticated, and how does the hook script obtain the token
  without leaking it into `~/.claude` scripts?"* — unresolved; will be settled
  alongside the hooks installer (`WP-X8`, [usage/hooks-installer](../usage/hooks-installer.md),
  currently a blocked stub).
- **Exact envelope/payload field shape.** The idempotency-key *contract* is fixed
  (`WP-IN1`: byte-identical across hook and JSONL for the same fact); the literal
  JSON field names of the envelope are an `WP-IN1` implementation detail not yet
  written down anywhere citable.

Track status for all of the above: [`TODO.md`](../../../TODO.md) at the repo root and
the roadmap page, [guide/roadmap](../guide/roadmap.md).

## Related pages

- [Architecture overview](overview.md) — the full ingest loop in context.
- [Data model](data-model.md) — annotated DDL for `events_raw`, `events`,
  `orchestration_edges`, `token_usage`, `agents`.
- [Ingest & reconciliation](ingest-reconciliation.md) — `CD-1` JSONL-vs-hooks
  primacy, the Phase-0 probe, replay-on-startup.
- [The DAG moat](dag-moat.md) — why `orchestration_edges` must be persisted and
  dual-path, not reconstructed at render time.
- [Cost model](cost-model.md) — how `PreCompact` feeds the compaction-baseline
  repricing.
- [Glossary & reference](glossary.md) — hook-event field/status reference tables.
- [Security model](../security/model.md) — loopback, mandatory token, no-spawner,
  no-SSRF.
- [Troubleshooting](../operations/troubleshooting.md) — the missing-Stop watchdog
  and "unknown" state in practice.
