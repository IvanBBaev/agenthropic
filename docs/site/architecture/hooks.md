# Hook ingestion

The design basis wired all twelve assumed Claude Code lifecycle hooks to a **single
hook-handler**, forwarding every event, unmodified, to one authed loopback receiver
(`HookSource`). Two of the twelve — `SubagentStart` and `SubagentStop` — were to get
**dedicated handling** because they are the only events that could directly assert a
parent→child relationship. *(As built, neither the twelve nor the dedicated handling
survived contact with reality — see the update below.)* The governing principle, stated
directly in the design basis:

> "The differentiator is what we do with events after ingestion, not which we
> receive." — `DESIGN.md` §5

Concretely, that means the ingest boundary is **accept-any-event**: a never-seen
`event_type` is stored, not rejected and not crashed on. Ingestion is deliberately
dumb; the value is created downstream. *(In the design sketch that downstream was a
Normalizer stage followed by a Projection stage. Neither was built as a separate stage —
see [ingest & reconciliation](ingest-reconciliation.md) for the pipeline that actually
runs and [the data model](data-model.md) for the tables it writes.)*

> **Update — 2026-07 (as built).** This page was written before the hook catalog was
> verified and before any code existed. The running system is simpler and stricter than
> the design above:
>
> - **Four real hooks, not twelve.** The hooks installer registers exactly
>   `UserPromptSubmit`, `Stop`, `SubagentStop`, and `PreCompact` — each a fail-silent
>   `curl` POST to the authed loopback receiver (`POST /api/hooks/event`).
>   **`SubagentStart` does not exist** (the Phase-0 hedge below held).
> - **No hook has structural handling — including `SubagentStop`.** Hooks contribute
>   **liveness only, never structure**: no hook ever creates an agent row, deletes one,
>   re-parents one, asserts a parent→child edge, or writes a token row. The hierarchy
>   tables (`agents.parent_agent_id`, `orchestration_edges`) are built **entirely from the
>   JSONL transcripts** by the parser's five join paths. A hook delivery lands one raw row in
>   `events_raw` plus one identifier-only row in the `events` liveness timeline, in the
>   same transaction, and may move the `status` column of an agent the parser already
>   created — an `UPDATE`-only reach, described in full below.
> - **Accept-any-event shipped as designed**: any body shape → `202` + a durable row.
>   There is no Normalizer stage; the only interpretation is the defensive extraction of
>   `session_id`/`agent_id` for the liveness timeline.
> - The receiver's **auth question is answered**: it sits behind the same mandatory-token
>   gate as every endpoint, and the installed hook command never lets a shell touch the
>   secret at all — `curl` imports the environment variable into its own variable space
>   and expands it into the `Authorization` header itself, so the token occupies no argv
>   position anywhere (mechanism and its curl-version floor below).
>
> The twelve-event table and the dual-path sections below are kept as the design record,
> with notes where the as-built system settled the open questions.

## The twelve lifecycle events (the design catalog)

The design basis assumed twelve event names (`DESIGN.md` §5). **As built, the installer
registers four** — `UserPromptSubmit` (row 4), `Stop` (row 6), `SubagentStop` (row 7),
and `PreCompact` (row 11) — and every registered hook is treated identically: one
liveness row, no structural interpretation. The "what ingest does with it" column below
records design intent, not running behavior:

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

> **As built, the hedge resolved past its own base case:** `SubagentStart` indeed does
> not exist — and the shipped edge derivation ended up needing **no hook at all**, not
> even `SubagentStop`. All five `orchestration_edges` join paths (`tool_use`,
> `directory`, `task_notification`, `queue_operation`, and the pre-2.1.71 `legacy_explore`
> fallback) come from the JSONL parser alone; `SubagentStop` contributes a liveness
> verdict and nothing structural. "Dedicated handling" for `SubagentStart`/`Stop` in the
> sense this section meant it — a hook asserting a parent→child relationship — therefore
> exists nowhere in the codebase; the hierarchy tables never read hook data. The `disler`
> lesson was still honored, one layer down: the *parser* preserves `agent_id`/`agent_type`
> faithfully instead of dropping them. (`SubagentStop` did keep a job, just not this one —
> it is one of the two events that can observe an *ending*. See
> [Hooks are interim, JSONL is authoritative](#hooks-are-interim-jsonl-is-authoritative).)

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
window instead — `DASHBOARD_WATCHDOG_MINUTES`, default **10** and **PROVISIONAL
(LABEL-ME)**, a figure chosen to feel right rather than measured against a real
distribution of subagent lifetimes. It is the only producer of `'unknown'`, and it leans
toward honesty on degenerate rows: an agent with no parseable timestamp at all cannot
prove recent activity, so it is marked `'unknown'` immediately rather than left
`'working'` forever. Detailed in [troubleshooting](../operations/troubleshooting.md).

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

> **As built:** point 1 shipped exactly as written — the receiver validates nothing
> about the body and answers `202` with a durable row for any shape. Point 2 has no
> Normalizer to version: the only downstream "recognition" is the liveness projection's
> defensive identifier extraction (non-empty string `session_id`/`agent_id` only, snake
> case winning over camelCase, nothing coerced), which is total and cannot crash on a
> new event type. A thirteenth hook would land, be stored, and appear on the liveness
> timeline with whatever identifiers it honestly carries.

## From raw envelope to projection

> **As built, this diagram is design history.** JSONL never enters this pipeline: the
> parser reads transcripts directly and writes the projections (`sessions` / `agents` /
> `orchestration_edges` / `token_usage`) in one transaction per session, bypassing
> `events_raw` entirely — so the cross-source idempotency key (`WP-IN1` as drawn) was
> never built. The real hook flow is: envelope → redaction → **hook-only** key
> (`hook:` + SHA-256 over the canonicalized envelope minus `receivedAt`, computed
> *after* redaction) → one `events_raw` row + one identifier-only `events` row, same
> transaction. The Normalizer (`WP-IN6`) and Projection (`WP-IN7`) stages below were
> never built as separate stages; see
> [ingest & reconciliation](ingest-reconciliation.md) for the as-built pipeline.
>
> Two labels inside the `token_usage` box below also went stale. The **compaction
> baseline** is not a stored marker: the column `is_compaction_baseline` exists but is
> dead — a literal `0` is written and nothing reads it back (implementation review
> 2026-08-09, finding L-7) — because repricing walks the transcript's own compaction
> boundaries at analysis time. And **`agent_id` is not backfilled by a later pass**: the
> parser attributes it before the row is ever written, so a `NULL` means genuinely
> unattributable rather than "not yet resolved" (`WP-IN9` was never needed).

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
`DESIGN.md` §4 — a design-basis sketch; the real migration adds a fifth status,
`'unknown'`, plus `first_seen_at`/`last_seen_at`. The as-built DDL lives in
[the data model](data-model.md)):

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

> **As built, the precedence holds — with one bullet rewritten.** Tokens
> JSONL-authoritative and never inferred from hooks: true as built, verbatim. The
> `token_usage.agent_id` bullet is design history, though — there is no backfill pass.
> The parser attributes the owning agent **before** the row is written, so a `NULL` means
> genuinely unattributable, not "not yet backfilled" (`WP-IN9` was never needed). And
> "interim liveness" turned out to be a larger job than one adjective: it is the whole
> status lifecycle described next.

### The status lifecycle, and who is allowed to say an agent ended

The one sentence that governs everything below: **reading a transcript proves activity,
never termination.** A JSONL file that has stopped growing is indistinguishable from one
whose next line has not been flushed yet. `endedAt` — which the parser always fills from
the last record's timestamp — is therefore evidence of the *most recent activity*, not of
an ending, and deriving `'completed'` from it was a confident lie that marked every agent
finished the first time its transcript was read, while it was still running.

So ingest asserts exactly one status, ever: `LIVENESS_STATUS = 'working'`. The terminal
verdict belongs to whatever *observes* the ending, and three sources can:

| Source | Verdict | Why that one |
|---|---|---|
| `SubagentStop` (hook) | `'completed'` for that subagent | The hook fires when an identified subagent terminates — a real observation of an ending |
| `Stop` (hook) | `'waiting'` for the main agent | Claude Code fires `Stop` at the end of **every turn**, so reading it as a session ending would re-introduce the same lie; `'waiting'` (idle right now) is the honest reading |
| The `WP-IN12` watchdog | `'unknown'` | Nobody observed an ending and activity went stale past `DASHBOARD_WATCHDOG_MINUTES` |

This is the piece of the design that most needs stating plainly rather than hiding:
**with no hooks installed, nothing ever reports `'completed'`.** Agents go `'working'` →
`'unknown'`. That is not a defect to be papered over; it is the honest reading of the
evidence the system actually has, and it is why `'unknown'` is a first-class status in
the `CHECK` constraint rather than a `NULL` or a softened `'completed'`. `'unknown'` is
rendered as `'unknown'` in the UI, never as anything friendlier.

CD-1 survives all of this intact, because the hook's entire structural reach is one
column. Every hook-driven transition goes through `applyAgentStatus`, an `UPDATE`-only
primitive: a hook can move the `status` of a row **the parser already created**, and
nothing else — it cannot create an agent, delete one, re-parent one, add an edge, or
touch token usage. A hook naming an agent this server has never parsed is stored as raw
liveness and changes no row at all. The transcript remains the sole structural authority;
hooks only ever answer the one question the transcript structurally cannot.

Two details keep that rule from quietly costing accuracy. Terminals are **sticky**: the
upserts refuse to resurrect an observed terminal as `'working'` just because the same
transcript bytes were re-read, and only revert an *inferred* state when the JSONL
timestamps strictly advance. And a subagent that starts and finishes inside a single poll
interval fires its `SubagentStop` *before* ingest has ever parsed its transcript — CD-1
correctly makes that delivery change no row, which without a second step would lose the
verdict forever and leave the watchdog to age a genuinely-completed agent to `'unknown'`.
So the projection replays stored `SubagentStop` payloads, narrowly: only for agents
**first inserted by the current projection**, only that one event type (`Stop` recurs
every turn and replaying a stale one would overwrite fresher liveness), and only through
a reconcile that refuses to move a row that is already terminal. A stored payload that
does not parse is skipped, never thrown on — best-effort recovery must not be able to
fail an ingest tick.

Alongside the status column, hook deliveries also surface as the `events` liveness
timeline: identifier-only rows with `occurred_at` set to receipt time, holding what the
envelope honestly carried and never the payload body.

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

### The token never occupies an argv slot

Requiring a Bearer token on the hook POST raises an obvious second question: how does a
one-line `curl` command, stored in a plaintext settings file and re-run on every hook
firing, get that token without leaking it? The first shipped answer was the obvious one —
`--header "Authorization: Bearer ${DASHBOARD_TOKEN}"`, expanded by the shell. It was
wrong, and review item **M-11** caught it: the shell substitutes the value *before* `curl`
starts, so the real token sits in `curl`'s argv for the whole POST window, readable by
any process on the machine that can list processes. That is precisely the local
multi-user attacker the token exists to stop.

The shipped command therefore never lets a shell touch the secret. It names the *variable*
to curl instead:

```
--variable '%DASHBOARD_TOKEN' --expand-header 'Authorization: Bearer {{DASHBOARD_TOKEN}}'
```

`--variable '%NAME'` imports the environment variable into curl's own variable space, and
the single-quoted `--expand-header` template is expanded **inside curl, after argv is
parsed**. Every argv position — in the hook shell and in curl alike — carries only the
variable's *name*. The quoting split is load-bearing and deliberate: those two arguments
are single-quoted so the shell cannot expand them, while the delivery-id header stays
double-quoted because the shell *must* expand it (it is per-firing and carries no secret).
Order matters too — `--variable` has to precede `--expand-header`, because curl resolves
variables in command-line order and the reverse order would send the literal template as
the header value.

Reading the environment at fire time, rather than baking a header file at install time,
also makes the env var the single runtime source of truth: rotating the token is
export-and-done, with no stale file to regenerate. The installer itself never reads,
embeds, prints, or otherwise touches the token value.

The cost of this mechanism is a version floor: `--variable`/`--expand-header` shipped in
**curl 8.3.0** (September 2023), recorded as `MIN_CURL_VERSION`. That is a release fact,
not a tunable. On an older curl the command fails at option parse and sends nothing — it
degrades to *zero telemetry, never to a leaked token*, which is the correct direction for
this trade. Every failure mode stays non-blocking anyway: `--silent --fail`, a hard
`--max-time 3`, and a trailing `|| true` mean an unset variable, an old curl, or a
dashboard that simply is not running all end the same way — a short token-free line on
stderr and exit 0. Claude Code is never blocked by an observability tool. (Verified on
curl 8.7.1.)

One more header rides along for a reason worth stating: `X-Agenthropic-Delivery-Id`,
minted per firing by the shell from the hook shell's pid, the epoch second and `$RANDOM`.
A `Stop` hook body is **byte-identical on every turn of a session**, so the server cannot
distinguish "this happened again" from "this was delivered twice" by content alone — only
the sender can. The installer computes no id itself, so none is ever baked into the
settings file, and the server uses the value as idempotency-key material only: never
stored, never echoed.

Full detail: [security model](../security/model.md) and
[threat model](../security/threat-model.md).

## Open items (not yet built)

> **Resolved as built (2026-07).** "Nothing in this page is implemented yet" is no
> longer true — implementation began 2026-07-11 (owner override of CD-8) and the hook
> receiver, installer, and liveness pipeline are running. The four bullets below landed
> as follows:
>
> - **Which fire:** verified — the installer registers `UserPromptSubmit`, `Stop`,
>   `SubagentStop`, `PreCompact`; `SubagentStart` does not exist.
> - **PreCompact marker (G0.2b):** compaction boundaries are **parsed from the JSONL
>   substrate** at parse time; the `PreCompact` hook contributes liveness only.
> - **Hook-POST auth:** answered — see
>   [the token never occupies an argv slot](#the-token-never-occupies-an-argv-slot) below
>   for the mechanism ([usage/hooks-installer](../usage/hooks-installer.md) — the
>   installer is built, no longer a blocked stub).
> - **Envelope shape:** fixed in code — the idempotency key is **hook-only**
>   (`hook:` + SHA-256 over the canonicalized envelope minus `receivedAt`, computed
>   after redaction); the cross-source byte-identical contract was never built because
>   JSONL never flows through `events_raw`.

Nothing in this page was implemented when it was written — Phase 0 (the feasibility
spike) gated all production code (`CD-8`), and `HookSource` itself was Phase 2
(`WP-IN3`). Concretely open at the time, sourced from the analysis:

- **Which of the twelve actually fire.** `WP-S4` / **G0.2** must confirm or deny
  `SubagentStart` (and, per the narrower nine-event "documented set" in
  `concept-analysis-v2.md` §4.2, `PermissionRequest` and `PostToolUseFailure` are
  similarly unconfirmed). See the hedge section above.
- **PreCompact marker mechanism (G0.2b).** Whether the log carries pre/post-compaction
  markers, or the baseline must be snapshotted at hook time, is open —
  `concept-analysis-v2.md` §7, item 4.
- **Hook-POST auth mechanics (open question, item 8).** *"Is the loopback hook
  endpoint itself authenticated, and how does the hook script obtain the token
  without leaking it into `~/.claude` scripts?"* — unresolved at the time; to be settled
  alongside the hooks installer (`WP-X8`,
  [usage/hooks-installer](../usage/hooks-installer.md)). *(Since settled — the installer
  is built; the mechanism is [above](#the-token-never-occupies-an-argv-slot).)*
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
