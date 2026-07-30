# Governance

This page is agenthropic's governance **policy**: how to report a security
vulnerability privately, which Code of Conduct the project adopts, and what the
issue and pull-request templates will require of a contributor. Key takeaway: this
page documents the policy only — it does not create the artifacts it describes.
`SECURITY.md` (repo root), `CODE_OF_CONDUCT.md` (repo root), and the `.github/`
issue/PR templates are tracked follow-up work, not yet written; every claim below
about *where a control comes from* traces to `ai/DESIGN.md` §8 (the security
posture) or to the standard OSS conventions this project adopts rather than
reinvents (Contributor Covenant, GitHub's private vulnerability reporting, issue/PR
templates).

## Scope: policy now, artifacts later

> **Update — 2026-07 (as built).** Re-verified against the repository on **2026-07-30**.
> `.github/` now exists, but it contains **only workflows** — `ci.yml` and `pages.yml`.
> **All six governance artifacts below are still uncreated**, so this page remains
> policy-only exactly as it says. Two corrections to the paragraph after the table:
> a `LICENSE` file **does** now exist at the repo root (MIT), but it is **untracked** —
> which is why GitHub still reports this repository's license as `null`, and why
> [licensing & provenance](licensing.md) lists it as an open release blocker. Nothing
> else in the table has changed.

| Artifact | Physical location (planned) | Status (verified 2026-07-30) |
|---|---|---|
| Security disclosure policy | `SECURITY.md` at repo root | **Not created** — policy defined on this page |
| Code of Conduct | `CODE_OF_CONDUCT.md` at repo root | **Not created** — Contributor Covenant adoption defined on this page |
| Bug report template | `.github/ISSUE_TEMPLATE/bug_report.md` | **Not created** — outline defined on this page |
| Feature request template | `.github/ISSUE_TEMPLATE/feature_request.md` | **Not created** — outline defined on this page |
| Issue template chooser config | `.github/ISSUE_TEMPLATE/config.yml` | **Not created** — outline defined on this page |
| Pull request template | `.github/PULL_REQUEST_TEMPLATE.md` | **Not created** — outline defined on this page |

Originally confirmed by `ls .github` and repo-root `ls` at the time of writing: no
`.github/` directory, no `SECURITY.md`, no `CODE_OF_CONDUCT.md`, and no `LICENSE` file
existed. As of 2026-07-30 `.github/workflows/` and an untracked `LICENSE` exist; the six
artifacts above do not. Creating them is out of scope for this page — see
[open decisions](#open-decisions--follow-ups) for how that work is tracked.

**One governance control that is worth stating plainly, because it is enforced today
and is not in the table:** `main` is **not branch-protected**
(`gh api repos/IvanBBaev/agenthropic/branches/main/protection` → `404`). CD-7 requires
the coverage gate to *block merges*; CI runs it and fails on a violation, but without a
branch-protection rule nothing physically prevents a merge. That gap is tracked in
[`RELEASE.md`](../../../RELEASE.md) as a human-owned pre-tag blocker, not silently
assumed away.

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

`SECURITY.md` will state, at minimum:

1. **Do not open a public issue for a suspected vulnerability.** Use the private
   channel named in the file instead.
2. **The private channel.** The standard, low-friction option is GitHub's built-in
   **private vulnerability reporting** (repo Security tab → "Report a vulnerability"),
   which creates a private advisory visible only to the maintainer and the reporter
   until a fix is coordinated. A direct-contact fallback (e.g. an email address) may
   also be listed. *Which of these — or both — agenthropic uses is not yet decided;
   see [open decisions](#open-decisions--follow-ups).*
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

- [ ] Touched code passes typecheck, lint, and tests; coverage stays **>90%**
      (merge-blocking from Phase 1 — see [testing & quality](testing.md)).
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

- **Exact private-reporting channel.** Whether `SECURITY.md` uses GitHub's native
  private vulnerability reporting, a direct email address, or both, is not yet
  decided. Track this alongside the six-artifact creation work below.
- **Creating the six artifacts** (`SECURITY.md`, `CODE_OF_CONDUCT.md`, the two
  issue templates, `config.yml`, the PR template) is follow-up implementation
  work, not covered by this policy page. It is not currently named as its own
  work package in `docs/analysis/development-plan.md` or itemized in the
  repo-root `TODO.md` at the time of writing — raising it as a small doc/devops
  work package (natural fit alongside `WP-X6`/`WP-X9` in Track X) is a reasonable
  next step but is not yet recorded as one.
- **Response-time SLA for security reports** is deliberately left unspecified
  above (best-effort only) pending the project having more than one maintainer.

## See also

- [Security model](../security/model.md) — the full rule-by-rule enumeration of
  every control a vulnerability report is evaluated against.
- [Threat model](../security/threat-model.md) — the attacker-model vocabulary
  (LAN peer, local multi-user, malicious event payload) used above to triage
  report severity.
- [Contributing overview](index.md) — dev setup, PR flow, and the one-WP-one-agent
  model referenced by the feature-request template.
- [Testing & quality](testing.md) — the golden fixture corpus and coverage gate
  referenced by the PR template's test plan.
- [Licensing & provenance](licensing.md) — the clean-room/attribution rule
  referenced by the PR checklist.
- [Decisions (ADRs)](decisions/README.md) — where a governance-adjacent decision
  (e.g. the eventual disclosure-channel choice) would be recorded once made.
- [Roadmap](../guide/roadmap.md) — where this project sits (pre-Phase-0) at the
  time this policy was written.
