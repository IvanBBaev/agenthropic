# Contributing to agenthropic

agenthropic is a self-hosted, local-first dashboard for observing Claude Code agent and
subagent activity. Read the [README](README.md) for what it is, and its
[Status](README.md#status) section for what actually runs today versus what is planned.

This file is the short front door: prerequisites, setup, and the gates a change has to
clear. The depth lives in the docs corpus - start at
[`docs/site/contributing/index.md`](docs/site/contributing/index.md). Nothing here is
restated there on purpose; when the two disagree, the docs corpus is the detail and this
page is the summary.

## Before you open a large PR

This is a pre-v1.0 project with a single maintainer and a fixed roadmap. Open work is in
[`TODO.md`](TODO.md); the release blockers are in [`RELEASE.md`](RELEASE.md). Large
unsolicited feature PRs are likely to be declined - not because they are bad, but because
the sequencing is already decided (one work package, one change, one PR - see
[`docs/site/contributing/index.md`](docs/site/contributing/index.md)). **Open an issue
first** and agree the shape before writing code. Bug fixes, test gaps, and documentation
corrections are welcome without asking.

## Prerequisites

- **Node 22 or newer.** `engines.node` is `">=22"`, and CI runs Node 22.
- **pnpm**, which you should not install by hand: the version is pinned in the root
  `package.json` `packageManager` field (`pnpm@11.11.0`), so `corepack enable` gives you
  exactly that one. CI does the same thing.

## Setup

```sh
git clone https://github.com/IvanBBaev/agenthropic.git
cd agenthropic
corepack enable
pnpm install
```

Running it takes two terminals. The auth token is mandatory and must be at least 16
characters; the server refuses to start without one.

```sh
# terminal 1 - API server on 127.0.0.1:4317 (loopback only, not configurable)
DASHBOARD_TOKEN="replace-with-a-long-random-secret" pnpm --filter @agenthropic/server dev

# terminal 2 - dashboard on 127.0.0.1:5173, proxying /api to the server
pnpm --filter @agenthropic/web dev
```

The lifecycle hooks are optional but consequential - they are the only terminal signal the
dashboard has. See [`hooks/README.md`](hooks/README.md) and the README for the installer.

## The gates

Run these before you push. They are the same commands `.github/workflows/ci.yml` runs, in
CI's order:

| # | Gate | Command |
|---|---|---|
| 1 | Security gate (no spawner / no wide bind / no eval / no WebSocket) | `pnpm run gate:spawner` |
| 2 | Typecheck | `pnpm run typecheck` |
| 3 | Lint | `pnpm run lint` |
| 4 | Format check | `pnpm run format:check` |
| 5 | Web production build | `pnpm --filter @agenthropic/web build` |
| 6 | Tests, with the coverage thresholds | `pnpm run test` |
| 7 | License allowlist (CD-9) | `pnpm run gate:licenses` |

`pnpm run format` rewrites files in place when step 4 fails.

**Coverage is pinned at 100%** - lines, branches, functions and statements - in all five
packages: `apps/server`, `apps/web`, `packages/core`, `packages/shared` and
`packages/test-fixtures`. Every one of them runs `vitest run --coverage`, and every
`vitest.config.ts` sets all four thresholds to `100`. A PR that drops below that fails the
run. Three cheap ways to buy a 100% are guarded by tests that read the configs and sources
as text - raising a threshold, adding a coverage `exclude`, and suppressing a line with an
ignore pragma. The guard is not uniform, though: `apps/web` asserts only the pragma sweep,
because it legitimately carries an `exclude` (`src/main.tsx`, `src/vite-env.d.ts`), so
widening that list or lowering the web thresholds would not trip anything. That gap is
real and is written up, with the rest of the mechanics, in
[`docs/site/contributing/testing.md`](docs/site/contributing/testing.md).

One caveat, stated plainly because the docs state it too: `main` is not branch-protected,
so a red CI run does not physically withhold the merge button. Treat it as blocking anyway.

## Conventions

- **Everything in the repository is English** - code, identifiers, comments, docs, commit
  messages, test names, user-facing strings.
- **TypeScript strict**, plus `noUncheckedIndexedAccess`, `noImplicitOverride`,
  `noFallthroughCasesInSwitch` and `verbatimModuleSyntax` - see
  [`tsconfig.base.json`](tsconfig.base.json). `any` is an ESLint error
  (`@typescript-eslint/no-explicit-any`); narrow the type or take `unknown` and validate.
- **ESM with extensionless relative imports** (`from './cost/compute-cost'`), resolved
  under `moduleResolution: "bundler"`.
- **`import type` for type-only imports.** `verbatimModuleSyntax` is on, so a value import
  of a type is not elided and will break the build.
- **Comments explain WHY and the failure mode**, never what the line does. The headers in
  the `vitest.config.ts` files and in `scripts/check-no-spawner.mjs` are the house style:
  name the invariant, the trade-off that was weighed, and what breaks if the rule is
  dropped.
- Formatting is Prettier (single quotes, print width 100, trailing commas). Do not
  hand-format.

## Invariants a PR may not break

These are why the project exists at all - it was built after auditing comparable
dashboards that shipped an `/api/run` spawner, a `0.0.0.0` bind and a no-op-when-unset
token. **A PR that weakens any of them will be declined regardless of code quality.** That
is the point of the project, not a review preference.

- **No subprocess or `claude` spawner.** Statically guarded by `pnpm run gate:spawner`,
  which also forbids `eval` / `Function(`, dynamic `data:` imports, wide binds and
  WebSocket packages.
- **Loopback bind only** (`127.0.0.1`). Never `0.0.0.0`, `host: true` or `::`.
- **Auth on every endpoint.** A global `onRequest` hook registered before any route,
  timing-safe token compare, and a server that refuses to start without a token.
- **SSE, never WebSocket** as the realtime transport (CD-5), with a same-origin check on
  the stream and no wildcard CORS.
- **Token counts are ground truth**, read from `~/.claude/projects/*.jsonl` and never
  inferred. Every displayed dollar traces to (tokens x a dated priced model).
- **The corpus filesystem port stays read-only.** It exposes no write, rename, unlink or
  open-for-write operation at all, so the transcripts Claude Code is actively appending to
  cannot be perturbed by the dashboard even by accident.
- Related habit worth keeping: omit an unknown value rather than reporting a placeholder
  zero - see [What it refuses to report](README.md#what-it-refuses-to-report).

Start at [`SECURITY.md`](SECURITY.md), which carries both the as-built enumeration of
these controls and the disclosure policy - a suspected vulnerability goes to the private
channel named there, never to a public issue or a PR that demonstrates it against `main`.
Deeper background: [`docs/site/security/model.md`](docs/site/security/model.md),
[`docs/site/security/threat-model.md`](docs/site/security/threat-model.md) and
[`docs/site/contributing/governance.md`](docs/site/contributing/governance.md).

## Commits and pull requests

- The base branch is **`main`**.
- Subjects follow the existing log (`git log --oneline` shows the real style):
  `type(scope): summary`, lowercase, no trailing period - for example
  `feat(server): ...`, `docs: ...`.
- **No AI attribution in git history.** No `Co-Authored-By` trailer for an AI agent, no
  "Generated with ..." line in a commit message or a PR description.
- Fill in [`.github/PULL_REQUEST_TEMPLATE.md`](.github/PULL_REQUEST_TEMPLATE.md) honestly.
  An unchecked box with one sentence explaining why is worth more than a checked one that
  is not true.
- If user-visible behaviour changed, update the matching page under
  [`docs/site/`](docs/site/) in the same PR.

## Licensing

Contributions are made under the MIT license ([`LICENSE`](LICENSE)). The per-artifact
provenance rule (clean-room versus attribution) and the dependency license allowlist that
`pnpm run gate:licenses` enforces are documented in
[`docs/site/contributing/licensing.md`](docs/site/contributing/licensing.md).
