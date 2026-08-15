# Governance

This page is agenthropic's governance **policy**: how to report a security
vulnerability privately, which Code of Conduct the project adopts, and what the
issue and pull-request templates ask of a contributor. Key takeaway: this page holds
the reasoning, not the artifacts — those live at the repo root and under `.github/`,
and as of 2026-08-15 most of them exist. The dated table below says which, and in
what state, because "exists" turns out to have two very different meanings here.
Every claim about *where a control comes from* traces to `ai/DESIGN.md` §8 (the
security posture) or to the standard OSS conventions this project adopts rather than
reinvents (Contributor Covenant, GitHub's private vulnerability reporting, issue/PR
templates).

## Scope: policy now, artifacts later

> **Update — 2026-08 (as built).** Re-verified against the repository on **2026-08-15**,
> and this section has moved. Five of the six artifacts below now exist as files, two of
> them in a shape this page did not draw. But they exist **only in the working tree**:
> `gh api repos/IvanBBaev/agenthropic/contents/.github` still answers `workflows` and
> nothing else, and none of the five appears at the repository root on GitHub. That is
> precisely the posture the `LICENSE` file was in a month ago — written, real, and
> invisible to anyone who has not cloned the checkout — and it resolves the same way, by a
> commit the owner makes. Until then, "created" means drafted, not published, and the
> table says so rather than rounding it up.

| Artifact | Physical location | Status (verified 2026-08-15) |
|---|---|---|
| Security disclosure policy | `SECURITY.md` at repo root | **Drafted, unpublished** — 266 lines on disk; absent from GitHub `main` |
| Code of Conduct | `CODE_OF_CONDUCT.md` at repo root | **Not created** — Contributor Covenant adoption still exists only as the decision recorded on this page |
| Bug report template | `.github/ISSUE_TEMPLATE/bug_report.yml` *(planned as `.md`)* | **Drafted, unpublished** — built as a GitHub issue **form**, not a markdown template |
| Feature request template | `.github/ISSUE_TEMPLATE/feature_request.yml` *(planned as `.md`)* | **Drafted, unpublished** — likewise a form |
| Issue template chooser config | `.github/ISSUE_TEMPLATE/config.yml` | **Drafted, unpublished** — `blank_issues_enabled: false` as specified in §3 |
| Pull request template | `.github/PULL_REQUEST_TEMPLATE.md` | **Drafted, unpublished** — checklist diverges from §4; see the note there |

Two further files that were never on this list appeared alongside them: a repo-root
`CONTRIBUTING.md`, deliberately written as a short front door that defers to
[the contributing overview](index.md) for depth, and a repo-root `CHANGELOG.md`. Both are
working-tree-only on the same terms.

The historical note this section used to carry still stands as history: when this page was
first written there was no `.github/` directory, no `SECURITY.md`, no
`CODE_OF_CONDUCT.md` and no `LICENSE` at all. The `LICENSE` gap is the one that closed
properly — the file is tracked and the GitHub API reports this repository's license as
`MIT` rather than `null`, which retires the release blocker
[licensing & provenance](licensing.md) used to carry. The rest closed on disk and has not
closed in public. Publishing them is an owner action; see
[open decisions](#open-decisions--follow-ups).

**One governance control that is worth stating plainly, because it is the gap everything
else on this site depends on:** `main` is **not branch-protected**. Queried again on
2026-08-15, `gh api repos/IvanBBaev/agenthropic/branches/main/protection` still answers
`404 Branch not protected`. CD-7 requires the coverage gate to *block merges*, and the
gate itself is real — CI runs the security gate, typecheck, lint, format check, the web
production build, the full test suite with its 100% coverage thresholds, and the license
gate on every push and pull request, and it fails on a violation. What is missing is the
rule that turns a red run into a withheld merge button. Until that rule exists, every
"merge-blocking" claim in this documentation set describes an intent rather than a
mechanism, and should be read that way. The gap is tracked in
[`RELEASE.md`](../../../RELEASE.md) as a human-owned pre-tag blocker rather than silently
assumed away; enabling it is an owner action on github.com and cannot be done from inside
the repository, which is why no commit and no document can close it.

## 1. Security disclosure policy (`SECURITY.md`)

### Why a private channel, not a public issue

agenthropic's entire security posture (`ai/DESIGN.md` §8, digested in depth on
[the security model](../security/model.md) and [the threat model](../security/threat-model.md))
exists precisely because every comparable self-hosted Claude Code dashboard audited
before this project's build decision shipped a real, source-verified vulnerability —
`0.0.0.0` binds, a no-op-when-unset token, an `/api/run` remote-code-execution
spawner, an SSRF via an event-payload URL (`docs/due-diligence/security.md`). A
public GitHub issue is the wrong channel for a report of this shape: it publishes
the exploit path for anyone's self-hosted instance before a fix exists. The
disclosure policy exists to give a reporter a route that does not do that.

This also matters more, not less, for a project like agenthropic than for a
typical web app: the [threat model](../security/threat-model.md#attacker-models-used-in-this-page)
names three concrete attacker models (LAN peer, local multi-user, malicious event
payload) that a self-hosted operator has to reason about on their own network, with
no vendor SOC watching for exploitation. A vulnerability report that leaks the
mechanism publicly before a patch lands is strictly worse here than in a
centrally-hosted SaaS product, where the operator can patch and roll out a fix
before most users are ever exposed.

### What the policy states

> **Update — 2026-08-15 (as built).** A drafted `SECURITY.md` now exists in the working
> tree and covers all six points below. Point 2 is resolved in favour of GitHub's native
> private vulnerability reporting — and that channel is **not switched on**:
> `gh api repos/IvanBBaev/agenthropic/private-vulnerability-reporting` returns
> `{"enabled": false}`, verified on 2026-08-15. The drafted file handles that honestly
> instead of pointing a reporter at a button that is not there: it tells anyone who cannot
> find "Report a vulnerability" to open a public issue naming only the affected component
> — "the SSE origin check", "corpus path resolution" — and to keep the mechanism out of
> the public thread until a private channel is opened for them. That is the right
> behaviour for a policy that cannot enable its own channel, but it is a degraded path,
> and it stays degraded until the owner turns private reporting on in the repository
> settings. It is the second owner-only gap on this page, alongside branch protection.

`SECURITY.md` states, at minimum:

1. **Do not open a public issue for a suspected vulnerability.** Use the private
   channel named in the file instead.
2. **The private channel.** The standard, low-friction option is GitHub's built-in
   **private vulnerability reporting** (repo Security tab → "Report a vulnerability"),
   which creates a private advisory visible only to the maintainer and the reporter
   until a fix is coordinated. A direct-contact fallback (e.g. an email address) may
   also be listed. *Decided by implementation, 2026-08-15: the drafted file uses
   GitHub's native channel and publishes no security email, no phone number and no
   PGP key — a single-maintainer project that advertises a second channel it does not
   monitor has added an unanswered inbox, not a route.*
3. **What to include in a report**: affected version/commit, the endpoint or code
   path, a minimal reproduction, and — critically — **no real secrets**. A report
   that needs to demonstrate a token-handling bug should use a placeholder value
   (`DASHBOARD_TOKEN=<token>`, matching the project-wide sample convention in
   [the style guide](../STYLE-GUIDE.md)), never a live token, even in a private
   channel.
4. **Response expectations.** Because this is currently a single-maintainer
   project, `SECURITY.md` should set a realistic acknowledgment window rather than
   an SLA it cannot honor — an explicit "best effort, no guaranteed SLA yet" is more
   honest than an aspirational number, consistent with this project's own rule
   (`docs/site/STYLE-GUIDE.md`) to say plainly when something is undecided rather
   than gloss over it.
5. **Severity framing borrowed from the threat model.** A report that only affects
   a *LAN peer* attacker model (defeated by loopback-only bind, per
   [the threat model](../security/threat-model.md#attacker-models-used-in-this-page))
   is triaged differently from one that reaches a *local multi-user* or *malicious
   event payload* model — the latter two are not defeated by the loopback bind
   alone and are treated as higher severity by default.
6. **Scope note.** `SECURITY.md` covers this repository's own code. It does not
   cover Claude Code itself (report those to Anthropic through Anthropic's own
   channels) and does not cover a third-party fork.

### Disclosure flow

```
Reporter finds a suspected vulnerability
        │
        ▼
Is it in agenthropic's own code (this repo)?
        │                              │
       yes                             no ──► not in scope; report to the
        │                                     relevant upstream (e.g. Anthropic
        ▼                                     for a Claude Code issue)
Open a PRIVATE report:
  GitHub "Report a vulnerability" (Security tab)  — channel choice: open decision
  or the direct-contact address named in SECURITY.md
        │
        ▼
Maintainer acknowledges (best-effort window, stated in SECURITY.md)
        │
        ▼
Triage against the threat-model attacker classes:
  LAN peer / local multi-user / malicious event payload
        │
        ▼
Fix developed privately → coordinated disclosure → public advisory
  (only after a fix is available, per standard responsible-disclosure practice)
```

Never: a public issue, a PR that demonstrates the exploit against `main`, or a
report containing a real `DASHBOARD_TOKEN` value.

## 2. Code of Conduct — Contributor Covenant

agenthropic adopts the **[Contributor Covenant](https://www.contributor-covenant.org/)**
as its Code of Conduct, published as `CODE_OF_CONDUCT.md` at the repo root — the
de facto standard for open-source projects on GitHub and the option GitHub's own
"Add file" community-health template picker offers first. This page does not
reproduce its text (the Covenant's own canonical text is the authoritative source
once the file is added); it records the adoption decision and the one governance
detail specific to this project:

- **Enforcement contact.** Until the project has more than one maintainer, the
  Code of Conduct's enforcement contact is the same private channel used for
  security reports (see [above](#1-security-disclosure-policy-securitymd)) —
  there is no separate community-moderation team to stand up yet. This should be
  revisited if/when the contributor base grows past a single maintainer.
- **Version.** The current Contributor Covenant release at the time of writing is
  v2.1; `CODE_OF_CONDUCT.md` should track whichever version is current when the
  file is actually added, not necessarily v2.1 by the time that happens.

## 3. Issue templates (`.github/ISSUE_TEMPLATE/`)

Two templates plus a chooser config, in the standard GitHub layout:

> **Update — 2026-08-15 (as built).** Both templates were built as **GitHub issue forms**
> (`bug_report.yml`, `feature_request.yml`), not as the markdown files this outline names.
> The divergence is worth keeping rather than smoothing away, because it runs in the
> project's favour: a markdown template's headings are a suggestion a reporter can delete,
> whereas a form's `required: true` fields are enforced by GitHub before the issue can be
> submitted. The redaction rule this page asks for is therefore no longer advice — the bug
> form makes a reporter tick three required boxes before filing: that no `DASHBOARD_TOKEN`
> or other credential appears in the report, that no raw transcript content from
> `~/.claude/projects` was pasted in, and that the issue is not a security vulnerability.
> The field lists below describe the intent; the built forms ask for the same information
> in more detail (commit, Node and pnpm versions, OS, whether the hooks were installed via
> `node hooks/install.mjs`, and the `GET /api/health` body). The chooser config landed as
> specified, with blank issues disabled and links to the docs corpus and `SECURITY.md`.

### `bug_report.md`

| Field | Purpose |
|---|---|
| Summary | One or two sentences: what happened vs. what was expected. |
| Environment | OS, Node version, agenthropic version/commit, and which phase of the [roadmap](../guide/roadmap.md) is in play (this matters more than usual here — pre-Phase-0 there is no running app to file a bug against at all). |
| Reproduction steps | Minimal steps; for ingest bugs, which of the twelve [lifecycle hook events](../architecture/hooks.md) was involved. |
| Logs / relevant excerpt | **Redacted.** No real `DASHBOARD_TOKEN`, no raw tool-call payload that might contain secrets — same placeholder convention as [the style guide](../STYLE-GUIDE.md). |
| Is this a security issue? | A visible reminder in the template itself: if yes, stop and use the [private channel](#1-security-disclosure-policy-securitymd) instead of filing this issue. |

### `feature_request.md`

| Field | Purpose |
|---|---|
| Problem statement | What's missing or awkward today; not a solution yet. |
| Proposed approach | Optional — a sketch, not a spec. |
| Related work package | If it maps to an existing WP in `docs/analysis/development-plan.md` or an open item in the repo-root `TODO.md`, name it — this keeps the one-WP-one-agent model (see [contributing overview](index.md)) legible instead of creating a duplicate, untracked ask. |
| Moat relevance | Optional: does this touch one of the five absent-from-the-field capabilities in [the moat](../guide/the-moat.md), or is it orthogonal to it? |

### `config.yml`

Sets `blank_issues_enabled: false` and adds a `contact_links` entry pointing at
`SECURITY.md` / the private reporting channel, labeled explicitly as "Report a
security vulnerability (do not open a public issue)". This is the standard
GitHub mechanism for steering security reports away from the public tracker
*before* someone starts typing, rather than relying on every reporter to have
read `SECURITY.md` first.

## 4. Pull request template (`.github/PULL_REQUEST_TEMPLATE.md`)

Outline, structured around the **Global Definition of Done** every work package
already commits to (`docs/analysis/development-plan.md` §8) so the template
doesn't invent a separate bar:

| Section | Content |
|---|---|
| Summary | What changed and why; link the WP id if one exists (`docs/analysis/development-plan.md`). |
| Test plan | How this was verified — which tests were added/run, and for anything touching ingest or the agent tree, which fixture session(s) from the golden corpus ([testing & quality](testing.md)) it was checked against. |
| Definition-of-Done checklist | See below — one checkbox per Global DoD item. |

The checklist items, each traceable to `docs/analysis/development-plan.md` §8:

- [ ] Touched code passes typecheck, lint, and tests; coverage stays at **100%** —
      the Global DoD words this as ">90%", but every shipped package pins lines,
      branches, functions and statements at 100 and holds it, so a drop to 91% is a
      failing run, not a passing one (see [testing & quality](testing.md) §6.1).
- [ ] No security invariant is weakened: loopback-only bind; mandatory-token-or
      -fail-startup (`timingSafeEqual`); same-origin realtime channel; no
      subprocess/`claude` spawner; no SSRF (no URL dialed from an event payload);
      no secret in SQLite, the realtime stream, or logs. (Full enumeration:
      [security model](../security/model.md).)
- [ ] Ground-truth tokens are read from `~/.claude/projects/*.jsonl`, never
      inferred; any displayed dollar figure traces to (tokens × a dated priced
      model).
- [ ] No all-rights-reserved code copied — clean-room for `cast`/`disler`/`nirdiamant`,
      attribution for `simple10`/`hoangsonww` (see
      [licensing & provenance](licensing.md)).
- [ ] A local `WORKLOG.md` entry was appended for this change. **This checkbox
      confirms an action taken outside the diff** — `WORKLOG.md` is an
      AI-harness file and is git-excluded project-wide (`.git/info/exclude`); the
      PR diff must **never** contain a `WORKLOG.md` change, and a reviewer should
      treat one appearing in a diff as a mistake to fix, not merge.

That last item is worth stating precisely because it is easy to get backwards: the
Global DoD requires the *action* of logging the work, but the file that records it
is deliberately outside version control. The template asks the contributor to
attest to having done it, not to prove it via the diff.

> **Update — 2026-08-15 (as built).** The drafted `.github/PULL_REQUEST_TEMPLATE.md`
> covers more ground than this outline in one direction and less in another, and both
> halves belong here. It adds a **"Gates run locally"** block naming all seven CI commands
> in CI's own order (`gate:spawner`, `typecheck`, `lint`, `format:check`, the web
> production build, `test`, `gate:licenses`), so a contributor ticks the commands rather
> than a vague "tests pass"; it expands the security bullet into six separate invariants,
> including the read-only corpus filesystem port; it names the three ways a coverage figure
> can be bought and asks that none of them were used — no threshold lowered, no `exclude`
> added, no ignore pragma — which mirrors the static guards described in
> [testing & quality](testing.md) §6.1; and it adds a no-AI-attribution checkbox this
> outline never asked for. What it **omits** are two items the list above traces to the
> Global Definition of Done: the clean-room / attribution checkbox from
> [licensing & provenance](licensing.md), and the `WORKLOG.md` attestation. Neither was
> dropped by a decision, so they should be read as a gap in the built template rather than
> a revision of the policy on this page.

## Traceability

| Governance element | Source |
|---|---|
| Why a private disclosure channel exists at all | `ai/DESIGN.md` §8; `docs/due-diligence/security.md` (every audited rival's vulnerability class) |
| Attacker-model severity framing in the disclosure flow | [threat model](../security/threat-model.md) — LAN peer / local multi-user / malicious event payload |
| Placeholder-secret rule in report/issue templates | `docs/site/STYLE-GUIDE.md` |
| PR checklist items | `docs/analysis/development-plan.md` §8, "Global Definition of Done" |
| `WORKLOG.md` git-exclusion rule | repo-root `CLAUDE.md`; `.git/info/exclude` |
| Code of Conduct choice | Standard OSS convention (Contributor Covenant) — not project-specific source material |

## Open decisions / follow-ups

- **Enabling GitHub's private vulnerability reporting.** The channel `SECURITY.md`
  names is off — `{"enabled": false}` as of 2026-08-15 — so the policy currently
  routes reporters down its own fallback path. Switching it on is a checkbox in the
  repository's Security settings and is the owner's to tick; no file in this
  repository can do it. *(The prior form of this item — which channel to use — was
  decided by implementation on 2026-08-15 in favour of the native channel, with no
  email or PGP fallback published. See [§1](#what-the-policy-states).)*
- **Publishing the drafted artifacts.** `SECURITY.md`, both issue forms, the chooser
  config and the PR template exist on disk and on no remote. Until they are
  committed and pushed, a contributor arriving from github.com sees none of them:
  no security policy, no issue forms, no PR checklist. A drafted policy that nobody
  can reach governs nothing.
- **`CODE_OF_CONDUCT.md` is still the one artifact that does not exist at all.** The
  adoption decision (Contributor Covenant, §2) has been made; the file has not been
  written. It is also not named as a work package in
  `docs/analysis/development-plan.md`, so raising it as a small doc/devops item
  alongside `WP-X6`/`WP-X9` in Track X remains the reasonable next step it always
  was.
- **Response-time SLA for security reports** is deliberately left unspecified
  above (best-effort only) pending the project having more than one maintainer.
- **Two checklist items are missing from the built PR template** — the clean-room /
  attribution box and the `WORKLOG.md` attestation (see [§4](#4-pull-request-template-githubpull_request_templatemd)).
  Restoring them is a small edit to a file outside this page's lane.
- **Enabling branch protection on `main`** is the single highest-leverage governance
  action still outstanding, and it is the owner's alone: it converts a CI suite that
  already exists and already fails correctly into something that actually prevents a bad
  merge. Nothing in this repository can perform it, and no document should be read as
  having done so.

## See also

- [Security model](../security/model.md) — the full rule-by-rule enumeration of
  every control a vulnerability report is evaluated against.
- [Threat model](../security/threat-model.md) — the attacker-model vocabulary
  (LAN peer, local multi-user, malicious event payload) used above to triage
  report severity.
- [Contributing overview](index.md) — dev setup, PR flow, and the one-WP-one-agent
  model referenced by the feature-request template.
- [`CONTRIBUTING.md`](../../../CONTRIBUTING.md) (repo root) — the short front door
  drafted on 2026-08-15: prerequisites, setup, and the seven gates in CI's order. It
  defers to the contributing overview for depth rather than restating it.
- [Testing & quality](testing.md) — the golden fixture corpus and coverage gate
  referenced by the PR template's test plan.
- [Licensing & provenance](licensing.md) — the clean-room/attribution rule
  referenced by the PR checklist.
- [Decisions (ADRs)](decisions/README.md) — where a governance-adjacent decision
  (e.g. the eventual disclosure-channel choice) would be recorded once made.
- [Roadmap](../guide/roadmap.md) — where this project sits (pre-Phase-0) at the
  time this policy was written.
