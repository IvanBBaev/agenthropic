# flat-tool-use — hierarchy ground truth (true by construction)

Join path 1 of parser-spec section 4: the `agent-<hex>.meta.json` sidecar carries
`toolUseId`, which resolves to a `Task` tool_use block in the main transcript.
The fixture was built with exactly one spawn, from the main agent.

## meta

session: 11111111-2222-4333-8444-555555555555
provenance: synthetic-by-construction
substrate: fixture:flat-tool-use
labeled-by: agenthropic synthetic fixture corpus
labeled-on: 2026-08-07
note: NOT admissible for the Phase-3 exit gate — this truth is machine-authored.

## edges

3fa9c2d1 <- ROOT # sidecar toolUseId -> Task block in the main transcript
