# agent-outcome-errors — hierarchy ground truth (true by construction)

Join path 1 of parser-spec section 4, two siblings: each `agent-<hex>.meta.json`
sidecar carries a `toolUseId` that resolves to its own `Agent` tool_use block in
the main transcript. Both spawns are answered by an `is_error: true`
`tool_result` on the same parent record — one classifies `terminated_early`
(`agents.status = 'error'`), the other `user_interrupt` (ordinary liveness
status, never `'error'`). WP-U10.

## meta

session: a9c0de00-1111-4222-8333-444444444444
provenance: synthetic-by-construction
substrate: fixture:agent-outcome-errors
labeled-by: agenthropic synthetic fixture corpus
labeled-on: 2026-09-02
note: NOT admissible for the Phase-3 exit gate — this truth is machine-authored.

## edges

fa11ed01 <- ROOT # sidecar toolUseId -> Agent block, errored terminated_early
de1e7ed2 <- ROOT # sidecar toolUseId -> Agent block, errored user_interrupt
