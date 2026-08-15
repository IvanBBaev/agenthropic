## What changed, and why

<!-- One or two sentences on the change, then the reason it is needed. Link an issue or a
     work-package id if one exists. -->

## Gates run locally

<!-- Tick what you actually ran. See CONTRIBUTING.md for the full list and CI's order. -->

- [ ] `pnpm run gate:spawner`
- [ ] `pnpm run typecheck`
- [ ] `pnpm run lint`
- [ ] `pnpm run format:check`
- [ ] `pnpm --filter @agenthropic/web build`
- [ ] `pnpm run test`
- [ ] `pnpm run gate:licenses`

## Security invariants

This PR does not weaken any of the following:

- [ ] No subprocess or `claude` spawner, no `eval` / `Function(`, no dynamic `data:` import
- [ ] Loopback bind only (`127.0.0.1`) - no `0.0.0.0`, `host: true` or `::`
- [ ] Every endpoint stays auth-gated; the server still refuses to start without a token
- [ ] Realtime stays SSE with its same-origin check - no WebSocket, no wildcard CORS
- [ ] Token counts are still read from the JSONL as ground truth, never inferred
- [ ] The corpus filesystem port is still read-only (no write / rename / unlink / open-for-write)

## Tests and coverage

- [ ] Tests were added or updated for this change (or: none needed, explained below)
- [ ] Coverage is still 100% on lines, branches, functions and statements in every package
- [ ] No coverage threshold was lowered, no `exclude` was added, no ignore pragma was used

## Docs

- [ ] User-visible behaviour changed, and the matching page under `docs/site/` was updated
- [ ] No user-visible behaviour changed, so no docs update was needed
- [ ] No AI attribution in the commit trailer or this description - no `Co-Authored-By`
      for an AI agent, no "Generated with ..." line
