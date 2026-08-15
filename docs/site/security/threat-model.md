# Threat model

This page walks through four **verified, source-level vulnerabilities** found in the
comparable self-hosted Claude Code dashboards audited before agenthropic's build
decision — `simple10`, `cast`, `hoangsonww`, and `disler` — states the attacker model
each one hands a local network or a malicious client, and maps each to the exact design
invariant (`DESIGN.md` §8) that forecloses it structurally in agenthropic. The key
takeaway: the due-diligence's cross-cutting verdict is blunt, not diplomatic —
**"every viable candidate binds `0.0.0.0` and/or ships auth that is a no-op in
practice"** (`docs/due-diligence/security.md`) — so agenthropic's four non-negotiable
security constraints (loopback-only bind, mandatory `timingSafeEqual` token, no
request-driven spawner, no SSRF) are not generic hardening boilerplate borrowed from a
checklist. They are named, structural responses to four real bugs this project read at
the source and decided never to repeat.

> **Status (updated 2026-07, as built).** This page was written in the bootstrap
> phase, when every mitigation below was a locked design invariant and nothing more.
> Implementation began 2026-07-11, and the mitigations are now **shipped and
> test-proven**: loopback-or-fail bind, mandatory-token-or-fail-startup with a
> timing-safe compare on every route, same-origin-before-auth SSE, the
> no-spawner/no-wide-bind/no-eval static gate running in CI, and hook-payload
> redaction at the ingest boundary. The SSRF mitigation is currently satisfied by
> absence — no outbound-dialing code exists at all (the webhook sink is post-1.0).
> None of the invariants was relaxed. The rival findings and attacker models below
> are the historical record and remain accurate; per-section as-built notes mark
> what changed — see [status](#status-and-whats-not-yet-built) at the end.

## Scope of this page

This is the "what the field got wrong, and why we can't repeat it" reference. It covers
four concrete, source-verified failure classes and the attacker model each enables.
Adjacent security topics live elsewhere and are only cross-referenced here:

- The full enforcement model — every endpoint's auth requirement, the same-origin check
  on the realtime channel, credential custody for the Telegram bot token — is the remit
  of [security model](model.md) (`DOC-S1`).
- Tunnel mechanics (SSH port-forward vs. Tailscale) are the remit of
  [remote access](remote-access.md) (`DOC-S3`).
- SQLite WAL backup/restore and payload-retention posture are the remit of
  [backup & restore](../operations/backup-restore.md) (`DOC-S4`).

> **Amended 2026-08.** A fifth section has since been added —
> [the corpus read surface](#5-the-corpus-read-surface--agenthropics-own-untrusted-input)
> — and it is not a rival finding. It is agenthropic's own untrusted-input boundary,
> documented here because it is the one surface on this page the project cannot
> foreclose by declining to build it: reading the corpus **is** the product.

## The honest read: the field is worse than advertised

`docs/due-diligence/security.md` opens by correcting the premise most of these projects'
own READMEs invite: "loopback by default" is not what the source shows. The verified
posture, at source, for the four projects in scope here:

| Project | Bind | Auth | CORS | Worst finding | Location |
|---|---|---|---|---|---|
| **simple10** | **`0.0.0.0`** | **none** | wildcard | LAN-exposed dashboard, no token; stores full tool payloads | server bind + CORS config |
| **cast** | **`0.0.0.0`** | write-gate good, **GET reads unauth** | — | Read-gate 404s writes without `CAST_DASHBOARD_CONTROL=1` + token, but unauth GETs dump every table | `index.ts:101`, `controlGate.ts` |
| **hoangsonww** | configurable | `DASHBOARD_TOKEN` — **no-op when unset** | — | **RCE**: `/api/run` accepts `permission-mode` from the browser; `ALLOWED_PERMISSION_MODES` includes `bypassPermissions` → spawns `claude --permission-mode bypassPermissions` in any cwd | `run.js:96`, `security.js:133` |
| **disler** | — | **none** | `*` | **SSRF**: server dials an arbitrary `responseWebSocketUrl` from the request body; unauth `POST /events`; `.env` guard commented out | `index.ts:198-201`, `pre_tool_use.py:324-327` |

(Reproduced from `docs/due-diligence/security.md`, restricted to the four projects in
this page's scope. The full matrix also covers `nirdiamant` and
`claude-code-templates` — see that file directly.)

Two additional per-project facts sharpen the read:

- `simple10` is the project **agenthropic actually forks patterns from** (DESIGN §0,
  §7 — ports/adapters storage, strategy-pattern agent classes, `buildAgentTree()`) —
  its A− grade is *despite*, not because of, its network posture. Its own writeup is
  explicit: "Binds `0.0.0.0`, wildcard CORS, no auth — LAN-exposed as shipped... First
  patch: bind `127.0.0.1`, add a `DASHBOARD_TOKEN`, same-origin WS check"
  (`docs/due-diligence/projects/simple10.md`).
- `hoangsonww` was the **due-diligence panel's primary pick** before the independent
  audit corrected the tie-break (DESIGN §0) — and it is simultaneously "the most
  dangerous... of the serious options" (`docs/due-diligence/projects/hoangsonww.md`).
  The most feature-rich candidate in the set ships the worst finding in the set. That
  correlation is the whole reason this page exists: richness and safety were not the
  same axis anywhere in the field, so agenthropic cannot inherit the former and assume
  the latter comes with it.

## Attacker models used in this page

Three attacker models recur across the four findings below. Naming them once, up
front, avoids re-litigating "who could actually exploit this" in every section. A
fourth — the **local corpus writer** — is defined in
[section 5](#5-the-corpus-read-surface--agenthropics-own-untrusted-input) rather than
here, because none of the four rival findings involve it:

| Model | Definition | Defeated by |
|---|---|---|
| **LAN peer** | Any device on the same network segment as the Mac Mini — another laptop on the same Wi-Fi, a compromised IoT device, a guest on the same router — reaching the dashboard's port directly, no credential required beyond network access. | Loopback-only bind (`127.0.0.1`): there is nothing at a routable address to connect to. |
| **Local multi-user** | Another OS account *on the same host* connecting to `127.0.0.1:<port>`. This attacker model **survives a perfect loopback bind** — bind alone only stops the network; it does not stop a second account on the same Mac Mini. | Mandatory auth token, `timingSafeEqual`-compared, checked independently of bind. |
| **Malicious event payload** | A client that can submit — or, worse, does not even need authorization to submit — an event/webhook-registration payload whose *contents* the server later acts on, e.g. dialing a URL the payload names. | Never deriving an outbound-dial target from event-payload data; outbound targets are operator-configured only. |

> **As built — an honest amendment to the local-multi-user row (M-11, fixed
> 2026-08).** "Defeated by the mandatory token" is only as true as the token's own
> custody, and agenthropic's first shipped hook command undermined it: the command
> written into Claude Code's settings let the shell expand `${DASHBOARD_TOKEN}`
> into **curl's argv**, so for the up-to-3-second life of every hook POST the
> token value sat in the process table — harvestable via `ps`/`/proc/<pid>/cmdline`
> by *exactly this attacker*, who could then pass the gate legitimately. The fix
> (2026-08): the generated command now has curl import the env var itself
> (`--variable '%DASHBOARD_TOKEN'` + a single-quoted `--expand-header` template,
> curl ≥ 8.3.0), so the token appears in **no** process's argv; a test simulates
> the shell expansion and asserts a canary value is absent from every argv word.
> On an older curl the command fails closed — nothing sent, session never blocked
> — rather than falling back to the leaking shape. **Residual exposure:** a
> process of the *same* account, or root, can always read the token (process
> environment, the profile/`launchd` plist that exports it); the token defends
> the cross-account boundary, nothing stronger. Details:
> [hooks installer](../usage/hooks-installer.md).

A fourth pattern shows up only in `hoangsonww` and deserves its own framing: **an
attacker model that collapses the other three.** Because its bind is "configurable"
and its token is "a no-op when unset," whichever of LAN peer or local multi-user the
deployer's bind setting happens to expose gets the same outcome — full RCE — because
auth was supposed to be the backstop and provided none. Section
["hoangsonww" below](#3-hoangsonww--no-op-token--apirun-spawner-is-rce) covers this in
detail.

## 1. simple10 — `0.0.0.0` + zero auth

**Threat.** Ships bound to `0.0.0.0`, wildcard CORS, and no authentication of any kind
— "LAN-exposed dashboard, no token" (`docs/due-diligence/security.md` posture matrix).
It additionally **stores full tool payloads** rather than redacted ones
(`docs/due-diligence/projects/simple10.md`, "Must-fix before exposure"), so anything an
agent's tool calls touched — file contents, command output, credentials that happened
to pass through a tool argument — is retained in full and reachable by whoever can
reach the dashboard.

**Attacker model.** **LAN peer.** No credential is needed; reaching the port is
sufficient. On a home network this is anyone sharing the router; on the Mac Mini's
network specifically, anything else on that segment.

**Why it matters for agenthropic specifically.** `simple10` is the project whose
*application-layer* patterns (ports/adapters storage, strategy-pattern agent classes,
`buildAgentTree()`/`layoutTree()`) agenthropic explicitly studies and reuses (DESIGN
§0, §7). Studying a project's architecture and inheriting its network posture are two
different acts — agenthropic does the first, never the second.

**Our mitigation.**

- **Bind `127.0.0.1` only, never `0.0.0.0`.** Stated as a non-negotiable constraint in
  the project's own `CLAUDE.md` and in `DESIGN.md` §8 ("Bind loopback only... Never
  widen to `0.0.0.0`"). This removes the LAN-peer attacker model entirely — there is no
  routable address for a LAN peer to dial.
- **Mandatory auth token** as a second, independent layer — see the general treatment
  under [hoangsonww](#3-hoangsonww--no-op-token--apirun-spawner-is-rce) below, since
  that is where the "no-op when unset" failure mode is best illustrated.
- **Redact tool payloads at rest**, rather than storing them verbatim — named directly
  in `docs/due-diligence/security.md`'s hardening list ("Store redacted tool payloads
  if payloads are stored at all") as the corrective to simple10's behavior. The
  requirement is decided (retention TTL + ingest-boundary redaction, `WP-D10`/`WP-IN14`)
  but the exact field list and thresholds are still open policy inputs — see
  [status](#status-and-whats-not-yet-built) and
  [backup & restore](../operations/backup-restore.md) §6.

  > **As built:** the ingest-boundary redaction (`WP-IN14`) is implemented — hook
  > payloads are redacted *before* the idempotency key is computed, so unredacted
  > secrets never reach the stored envelope or its hash — with the final field-list
  > sign-off (OPEN-3) still pending. The retention TTL (`WP-D10`) has since split
  > into three claims with different truth values: the sweeper **mechanism** is
  > built and tested, its **policy is blank by design** (no table has a configured
  > window, and an empty policy is a byte-identical no-op rather than a silent
  > default), and the runner is **wired into nothing** — no production path calls
  > it. So redaction, not retention, is what currently keeps stored payloads small;
  > see [backup & restore §4](../operations/backup-restore.md#4-retention-policy).
  > Note also a structural narrowing that helps here: JSONL transcripts are parsed
  > into projections (sessions, agents, edges, token counts) — raw transcript
  > payloads are **not** stored in the database at all; `events_raw` holds redacted
  > hook envelopes only.

## 2. cast — `0.0.0.0` + unauthenticated GET reads

**Threat.** `cast`'s `controlGate.ts` is, on its own terms, good security engineering:
non-safe HTTP verbs 404 unless `CAST_DASHBOARD_CONTROL=1` **and** `DASHBOARD_TOKEN` are
both set, compared with `timingSafeEqual`, mounted before the router
(`docs/due-diligence/projects/cast.md`). But the server binds `0.0.0.0`
(`index.ts:101`), and the gate protects **writes only** — every `GET` route is
unauthenticated and, per the due-diligence, "unauth GETs dump every table"
(`docs/due-diligence/security.md`). The write-side is exemplary; the read side
is wide open on a routable address.

**Attacker model.** **LAN peer**, performing purely passive reconnaissance — no write
attempt is needed to exfiltrate session contents, tool payloads, or cost data; a
`GET` is enough.

**Our mitigation.**

- **Bind `127.0.0.1` only** removes the LAN-peer reach the same way it does for
  `simple10` — there is no routable address to `GET` from off-host.
- **Adopt `controlGate.ts`'s *shape*, not its scope.** DESIGN §7 names `cast`'s gate
  as the pattern to steal ("`controlGate.ts` (~73 LOC: read-only by default, non-safe
  verbs 404 unless token, `timingSafeEqual`, mounted before router)"). The shape — a
  single dependency-free middleware, constant-time comparison, mounted ahead of
  routing — is worth keeping. Illustrative pseudocode of that shape, kept as the
  design record (the real gate is now built — a single global `onRequest` hook in
  `apps/server/src/server.ts` covering every route, reads included, with the token
  compare hashing both sides to fixed length before `timingSafeEqual`; see
  [security model](model.md) rule 2's as-built note):

  ```ts
  // Illustrative only — design-basis sketch, not the shipped code. Shape adapted
  // from cast's controlGate.ts
  // (docs/due-diligence/projects/cast.md), mounted before the router.
  function authGate(req: Request, res: Response, next: NextFunction) {
    const supplied = extractToken(req);          // e.g. Authorization header
    const expected = Buffer.from(DASHBOARD_TOKEN); // mandatory — see finding 3 below
    if (!supplied || !timingSafeEqual(Buffer.from(supplied), expected)) {
      return res.status(401).end();
    }
    next();
  }
  ```

- **The mandatory token gates `GET` routes too, not only writes.** `DESIGN.md` §8 and
  the project's `CLAUDE.md` state the floor as "no unauthenticated write endpoints" and
  "auth-gate all write endpoints" — write-scoped language, matching what `cast` already
  does correctly. [Security model](model.md) closes the gap `cast` left open: its rule
  5 states the stricter bar explicitly — "every endpoint, not only the ones that
  mutate state, sits behind the same-origin + token gate. There is no 'reads are safe
  to leave open' carve-out" — precisely so a **local multi-user** on the same Mac Mini
  (who survives the loopback bind) cannot read an ungated `GET` route over
  `127.0.0.1` the way a LAN peer could against `cast`.

## 3. hoangsonww — no-op token + `/api/run` spawner is RCE

**Threat — two independent failures that compound.**

1. **The token is a no-op when unset.** `DASHBOARD_TOKEN` auth is "opt-in and a no-op
   when unset" (`security.js:133`, per `docs/due-diligence/projects/hoangsonww.md`).
   Bind is "configurable" (`docs/due-diligence/security.md`). If an operator never sets
   the token — the default, unconfigured state — there is no authentication at all,
   regardless of bind.
2. **`/api/run` accepts a `permission-mode` from the browser request body**, and
   `ALLOWED_PERMISSION_MODES` **includes `bypassPermissions`** (`run.js:96`). The
   result: a browser request spawns `claude --permission-mode bypassPermissions` in an
   **attacker-chosen absolute cwd** — arbitrary code execution as the host user
   (`docs/due-diligence/projects/hoangsonww.md`). The due-diligence is explicit that
   the report's originally-flagged "concurrency cap of 10,000" is a red herring; **the
   permission mode is the actual lever.**

Put together: on an unconfigured install, this is — in
`docs/due-diligence/projects/hoangsonww.md`'s own words — "a self-hosted RCE box." It
is the single worst finding across every project audited (`docs/due-diligence/security.md`,
"The two standouts").

**Attacker model.** This is the finding that **collapses the attacker-model
distinction** drawn earlier. Because the token is a no-op when unset, it does not
matter whether the exposure ends up being a LAN peer (if bind is left wide) or a local
multi-user (if bind is tightened but the token is still unset) — either one reaches
`/api/run` with zero authentication and gets host-user code execution. Auth was
supposed to be the backstop regardless of bind, and for an unconfigured install it
provides none.

**Our mitigation — two structurally separate answers, because these are two separate
bugs:**

- **For the RCE: there is no `/api/run`-shaped surface anywhere in agenthropic's
  design, full stop.** This is stated as a non-negotiable constraint, not a
  configuration option: *"Never add a browser-driven subprocess/`claude` spawner (the
  RCE that this project deliberately walks away from)"* (`CLAUDE.md`); *"Never add a
  browser-driven subprocess / `claude` spawner"* and the precise diagnosis of why
  hoangsonww's is one (`DESIGN.md` §8). agenthropic is a **read-only observability
  system** over hook events and JSONL transcripts — it has no code path that accepts a
  permission mode, a cwd, or any other exec parameter from a request and turns it into
  a spawned process. There is nothing to excise later because nothing like it is ever
  built; contrast this with the due-diligence's own note that hoangsonww's spawner is
  "cleanly excisable — ~6 files + one mount line + one table" if that project were ever
  forked (`docs/due-diligence/projects/hoangsonww.md`) — agenthropic does not fork it,
  precisely so that excision is never a step anyone has to remember to perform.
- **For the no-op token: "auth token is mandatory, not opt-in"** is stated as its own
  named invariant in `DESIGN.md` §8, with hoangsonww cited by name as the mistake:
  *"a `DASHBOARD_TOKEN` that is a no-op when unset (hoangsonww's mistake) is not
  auth. Use `timingSafeEqual`."* The comparison is constant-time for the same reason
  `cast`'s is (DESIGN §7) — a variable-time compare on the token would leak it a byte
  at a time via timing side-channel, defeating the point of requiring it. The exact
  fail-closed mechanics are resolved in [security model](model.md) (rule 2): the
  server refuses to start at all if the token env var is absent, and rejects
  per-request at the gate via `timingSafeEqual` once a token is set — an unset token
  must never silently mean "no auth."

## 4. disler — SSRF via an event-payload URL

**Threat.** The server dials an **arbitrary `responseWebSocketUrl` taken directly from
the incoming request body** (`index.ts:198-201`, per
`docs/due-diligence/projects/disler.md` and `docs/due-diligence/security.md`). Combined
with an **unauthenticated `POST /events`** and wildcard CORS (`*`), any client that can
reach the endpoint can make the server originate an outbound connection to a URL of
the attacker's choosing — the textbook SSRF pattern: the observability server becomes
a stepping stone for internal-network scanning or exfiltration, dialing out on the
attacker's behalf using the server's own network position. A second finding compounds
the trust problem: the `.env`/key guard the original report credited it for is
**commented out** in the shipped source (`pre_tool_use.py:324-327`).

**Attacker model.** **Malicious event payload.** No LAN position and no local account
are needed — anything able to reach the unauthenticated `POST /events` endpoint
controls a field the server will act on. This is the attacker model named directly in
`DESIGN.md` §8's SSRF clause: *"no SSRF (never dial a URL taken from an event payload —
disler's bug)."*

**Why this one is easy to reintroduce by accident.** disler is also the project
agenthropic explicitly studies as "the clearest teaching example of the whole ingest
pattern... hook → HTTP → SQLite → WebSocket → browser" (`docs/due-diligence/projects/disler.md`;
DESIGN §3, §7 — its ~180-line `send_event.py` is named as the reference implementation
to *learn the loop from, not build on*). The webhook-sink leg of agenthropic's own
architecture (event → outbound HTTP → Telegram) is structurally the same shape as the
code that has the bug. The mitigation therefore has to be a rule about **where a
dial target is allowed to come from**, not merely "don't copy disler's file."
*(As built, that leg does not exist yet — the webhook sink is post-1.0, entered only
via KC-5, and today the server makes no outbound request of any kind. The rule below
is what any future dispatcher will be held to.)*

**Our mitigation.**

- **Outbound dial targets are operator-configured only, never derived from event-payload
  data.** `DESIGN.md` §8: *"no SSRF (never dial a URL taken from an event payload)."*
  Concretely, this means the webhook sink's targets live in `webhook_targets`
  (DESIGN §4, grafted from `hoangsonww`'s schema) — a table an operator populates
  ahead of time — never a field read out of an incoming hook/event payload and dialed
  immediately. No hook event, `PostToolUse` payload, or any other ingested field is
  ever interpreted as "the address to connect to."
- **No unauthenticated write endpoints, including ingest.** `CLAUDE.md`: *"Auth-gate
  all write endpoints"*; `DESIGN.md` §8: *"no unauthenticated write endpoints."* This
  directly forecloses disler's second bug (unauth `POST /events`) — the equivalent
  ingest path in agenthropic requires the mandatory token like every other write.
- **Same-origin check on the realtime channel** — `DESIGN.md` §8 — closes the
  adjacent risk class of a browser-originated cross-site request driving the
  SSE channel, which disler's wildcard CORS (`*`) does nothing to prevent.

## 5. The corpus read surface — agenthropic's own untrusted input

*(Added 2026-08, written from the shipped ingest adapter.)*

The four findings above are other people's bugs, and every mitigation against them is a
surface agenthropic simply never built. This section is different in kind. It describes
a surface the project cannot decline, because reading the corpus **is** the product:
`~/.claude/projects` is a directory tree written by another program, on a schedule
agenthropic does not control, containing filenames and file contents that anything
Claude Code ran can have influenced. Treating that tree as trusted input on the grounds
that it sits inside the operator's own home directory would be the same category of
error as `simple10`'s "loopback by default" — a posture asserted rather than enforced.

**Attacker model.** **Local corpus writer** — any process able to create, rename, or
swap an entry under the corpus root. On a single-user Mac Mini that is usually Claude
Code itself, but it is equally every tool Claude Code runs and every path a prompt can
talk one of those tools into writing. This model needs no network, no dashboard token,
and is entirely untouched by the loopback bind: it is the one attacker on this page that
all four mitigations above leave in place. The reader is therefore built to be
**structurally incapable of the things that would matter**, rather than merely careful.

**What the reader refuses, and why.**

- **A capability that is never imported cannot be misused.**
  `apps/server/src/corpus/node-corpus-fs.ts` is the only module anywhere in the corpus
  read path bound to `node:fs`, and it is bound to that module's read family alone: it
  imports `closeSync`, `constants`, `fstatSync`, `lstatSync`, `openSync`,
  `readdirSync`, `readFileSync`, `readSync` and `realpathSync`, and no `write`,
  `rename`, `unlink`, `chmod`, `writeFile`, or open-for-write symbol. "The ingest
  adapter cannot mutate the corpus" is consequently a property of a nine-line import
  list that a reviewer can check at a glance, rather than a promise about behaviour
  spread across a recursive walk. This is the same intent as the `gate:spawner` CI
  check, applied one level down. (Other parts of the server do write to disk — the
  SQLite file, its backups, the retention journal — but none of them is reachable from
  the walk, and none of them writes anywhere near the corpus root.)
- **Symlinks are skipped, never resolved.** The walk `lstat`s without following, and an
  entry that reports as a symlink is recorded with reason `symlink` and abandoned. A
  symlink is the cheapest available way to make "a file inside the corpus" mean a file
  anywhere on disk, so the reader declines to resolve one at all rather than resolving
  it and then checking where it landed.
- **`O_NOFOLLOW` plus a post-open `fstat`, because the skip decision goes stale.**
  Between the walk's `lstat` and the read's `open` there is a window in which the path
  can be swapped. Confined reads therefore open with `O_RDONLY | O_NOFOLLOW` — a symlink
  substituted into that window fails the open with `ELOOP` instead of being followed —
  and then re-check the **open descriptor** with `fstat` rather than trusting the
  earlier `lstat`. Two swap targets survive an `O_NOFOLLOW` open and are rejected on the
  descriptor: a directory (`EISDIR`) and a character device (`ENOTREG`). Both arms are
  exercised against real syscalls, not mocks.
- **A traversal-shaped name stops the whole ingest instead of being skipped.** Every
  other hazard on this list is a skip: the file is recorded, the walk continues, the
  dashboard shows slightly less. A `ContainmentError` — an entry name containing a path
  separator or `..`, or a resolved path that falls outside the root it was joined
  against — is the single exception the adapter never swallows. (The root itself is
  canonicalized through `realpath` before any of this, so every containment check
  compares against a symlink-free absolute path rather than against whatever the
  operator typed.) The server logs it as `FATAL` and exits with status 1. The
  distinction is the point: a skip says *this file
  was not usable*, whereas a containment failure says *the assumption the entire walk
  rests on is false*, and there is no honest way to keep reading after that. Operator
  guidance for the resulting log line is in
  [troubleshooting §6](../operations/troubleshooting.md#6-reading-the-ingest-log--skips-quarantines-and-the-one-fatal).
- **Reads are bounded, and the bounds are admitted to be arbitrary.** A single file is
  capped at 64 MiB, and the cap is enforced against the whole file even when only its
  tail is being read; the directory walk refuses to descend past depth 4, as
  belt-and-braces against a symlink cycle the `lstat` guard has already blocked. Both
  numbers are **PROVISIONAL** —
  they are chosen floors, not measured ones, and they carry the same
  pending-ratification status as every other Phase-0 constant.
- **A short read is truncated honestly, never padded.** If the file shrinks between the
  `fstat` and the read, the adapter returns exactly the bytes it received rather than
  zero-filling to the length it expected. This is the same rule the health endpoint
  applies to its optional fields: the code will report less than it hoped for, but never
  a value it did not observe.
- **"I could not look" is never spelled "there is nothing there."** An unreadable corpus
  root is reported as its own outcome, distinct from the root having vanished (`ENOENT`,
  which genuinely does mean no sessions). A permissions failure that silently rendered as
  an empty dashboard would be the most dangerous possible bug in an observability tool,
  because it looks exactly like a quiet day.

**What this does not defend against, stated plainly.** None of the above protects
against corpus contents that are hostile but well-formed — a transcript that misreports
token counts, or a filename crafted to mislead a human reader rather than to traverse.
The reader's contract is narrow and deliberately so: stay inside the root, stay bounded,
never write. Judging whether the JSONL is telling the truth is not a security control
and is not claimed as one. Equally, nothing here defends the corpus itself: an attacker
who can already write into `~/.claude/projects` can shape what the dashboard displays,
and the only thing these guards secure is that they cannot use that position to escape
the tree, exhaust the process, or make agenthropic write anything back.

## Traceability — finding → invariant → source

| Rival finding | Attacker model | agenthropic invariant | Source |
|---|---|---|---|
| simple10: `0.0.0.0`, zero auth, wildcard CORS | LAN peer | Bind `127.0.0.1` only, never `0.0.0.0` | `CLAUDE.md`; `DESIGN.md` §8 |
| simple10: stores full tool payloads | (data-at-rest exposure, any reader) | Store redacted payloads — requirement decided, exact field list/thresholds open | `docs/due-diligence/security.md`; [backup & restore](../operations/backup-restore.md) |
| cast: `0.0.0.0` + unauth `GET` reads | LAN peer | Bind `127.0.0.1` only (removes the reach); reads token-gated too, not only writes | `docs/due-diligence/security.md`; [security model](model.md) |
| hoangsonww: `DASHBOARD_TOKEN` no-op when unset | Local multi-user **or** LAN peer, whichever bind exposes | Auth token mandatory, not opt-in; `timingSafeEqual` | `DESIGN.md` §8 |
| hoangsonww: `/api/run` + `bypassPermissions` = RCE | Any client reaching the endpoint | Never build a request-driven `claude`/subprocess spawner | `CLAUDE.md`; `DESIGN.md` §8 |
| disler: SSRF via `responseWebSocketUrl` | Malicious event payload | Never dial a URL taken from an event payload; outbound targets are operator-configured | `DESIGN.md` §8 |
| disler: unauth `POST /events`, CORS `*` | Malicious event payload / any client | No unauthenticated write endpoints; same-origin check on the realtime channel | `CLAUDE.md`; `DESIGN.md` §8 |

The table has no row for
[section 5](#5-the-corpus-read-surface--agenthropics-own-untrusted-input) because there
is no rival finding to trace: the corpus read surface is agenthropic's own, and its
mitigations answer to the shipped adapter rather than to `DESIGN.md` §8.

## What agenthropic structurally forecloses

Annotated against the canonical pipeline diagram (`DESIGN.md` §3):

```
                         LAN / other local accounts
                                    │
                                    X   no 0.0.0.0 bind — nothing routable to reach
                                    │      (forecloses simple10 & cast's LAN-peer path)
                                    ▼
127.0.0.1 only ──►  hook-ingest  ──►  SQLite (WAL)  ──►  SSE  ──►  browser SPA
                        │  ▲                                 (same-origin only —
                        │  └── mandatory token,               forecloses disler's
                        │      timingSafeEqual                wildcard-CORS path)
                        │      (forecloses hoangsonww's
                        │       no-op-when-unset path)
                        │
                        X   no /api/run, no claude spawn, no subprocess
                        │      driven by request input
                        │      (forecloses hoangsonww's RCE — structurally,
                        │       by never building the surface)
                        ▼
                  webhook sink ──►  Telegram relay (@baev_bot_bot)
                        │
                        X   target is operator-configured (webhook_targets),
                            never a URL taken from an event payload
                            (forecloses disler's SSRF)
```

Every `X` above is a surface that is **not built**, not a surface that is built and
then locked down. This is the deliberate consequence of DESIGN §0's decision to build
greenfield rather than fork: the RCE spawner, the wildcard CORS, the no-op token are
not bugs to patch in agenthropic's own code because that code does not exist in the
first place — they only had to be studied, named, and excluded at the design stage.

> **As built:** the top of the diagram is now running code and each `X` is now
> *enforced*, not only designed: the static gate (`scripts/check-no-spawner.mjs`, a CI
> step) turns the build red on any subprocess import, wide bind, WebSocket server, or
> dynamic eval anywhere in the tree, and the security-contract tests boot the real
> server and prove the loopback bind, mandatory token, and same-origin SSE. Two
> as-built refinements to the picture: the realtime leg is **SSE** (CD-5), as drawn;
> and the bottom leg — webhook sink → Telegram relay — is **not built** (post-1.0,
> KC-5), so its `X` currently holds in the strongest form: no outbound dial exists at
> all. There is also a second ingest path the diagram predates: JSONL transcripts
> read directly from the local filesystem (`~/.claude/projects`), which never crosses
> an HTTP surface in the first place — and which, precisely because none of the `X`
> marks above apply to it, gets its own treatment in
> [section 5](#5-the-corpus-read-surface--agenthropics-own-untrusted-input).

## Status and what's not yet built

Consistent with `docs/site/STYLE-GUIDE.md`'s rule to say plainly when something is
undecided rather than gloss over it:

- **Server code now exists and the mitigations are verified implementations.**
  *(Resolved 2026-07 — this bullet originally read "no server code is scaffolded
  yet.")* Implementation began 2026-07-11; the loopback bind, mandatory timing-safe
  token gate, and same-origin SSE are asserted by
  `apps/server/test/security-contract.test.ts` against the real composition root, and
  the no-spawner static gate runs in CI. This page served as the acceptance bar it
  promised to be.
- **The redaction rule for stored tool payloads** (the corrective to simple10's
  full-payload storage) is decided at the requirement level — a retention TTL plus
  ingest-boundary redaction, owned by `WP-D10`/`WP-IN14` — but the exact retention
  window, redacted field list, and "huge payload" reject-vs-truncate threshold remain
  open Phase-0 policy inputs; see [backup & restore](../operations/backup-restore.md)
  §6 for the full decided-vs-open tally. *(Partially resolved: `WP-IN14`'s
  redaction-before-keying is built. The OPEN-3 field-list sign-off is still open.
  `WP-D10` is now three separate facts — the sweeper mechanism is built, its policy
  is deliberately unset, and the runner is called from tests only — so no row is
  currently being pruned from the database by anything.)*
- **The corpus reader's limits are built but unratified.** The 64 MiB per-file cap and
  the depth-4 walk limit in
  [section 5](#5-the-corpus-read-surface--agenthropics-own-untrusted-input) are enforced
  in code and covered by tests, but the numbers themselves remain **PROVISIONAL** — they
  were chosen, never measured against a real corpus, and no owner has ratified them.
  Treat them as working defaults rather than as a sized bound.
- **`GET`/read endpoints are token-gated, not left to the loopback bind alone** —
  resolved in [security model](model.md) (rule 5), which closes exactly the gap
  flagged in the `cast` section above.
- **The fail-closed mechanics of the mandatory-token check** are resolved in
  [security model](model.md) (rule 2): the server refuses to start if
  `DASHBOARD_TOKEN` is unset, and a present-but-wrong token is rejected per-request via
  `timingSafeEqual`.
- [security model](model.md), [remote access](remote-access.md), and
  [backup & restore](../operations/backup-restore.md) — tracked as `DOC-S1`, `DOC-S3`,
  `DOC-S4` in the docs plan — now exist and cover the adjacent topics referenced above
  in full; this page's cross-references have been updated accordingly.

## See also

- [Architecture overview](../architecture/overview.md) — the full ingest pipeline this
  threat model is drawn against, including the security-boundary summary of the same
  loop.
- [Data model](../architecture/data-model.md) — the `agents`, `orchestration_edges`,
  and `token_usage` schema referenced by the mitigations above.
- [The moat](../guide/the-moat.md) and [comparison vs. the field](../guide/comparison.md)
  — why agenthropic builds greenfield rather than forking any of the four projects
  discussed on this page.
- [Troubleshooting](../operations/troubleshooting.md) — the operator-facing side of
  [section 5](#5-the-corpus-read-surface--agenthropics-own-untrusted-input): what each
  skip reason looks like in the log, and why a containment failure exits the process.
- [Roadmap](../guide/roadmap.md) — where hardening work sits in the phase sequence
  (`DESIGN.md` §9, Phase 1: "Hardened internal cockpit").
