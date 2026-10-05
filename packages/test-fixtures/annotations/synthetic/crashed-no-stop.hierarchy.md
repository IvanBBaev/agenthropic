# crashed-no-stop — hierarchy ground truth (true by construction)

WP-X1 pathology live-crash / no-`Stop`: the process died mid-turn. The spawn's
`tool_result` never arrived and the child's transcript ends on an unanswered
tool call, but the edge is a structural fact the crash does not erase — the
sidecar `toolUseId` still resolves to the `Agent` block in the main transcript.
The fixture was built with exactly one spawn, from the main agent.

## meta

session: c7a5bed0-1111-4222-8333-444444444444
provenance: synthetic-by-construction
substrate: fixture:crashed-no-stop
labeled-by: agenthropic synthetic fixture corpus
labeled-on: 2026-09-30
note: NOT admissible for the Phase-3 exit gate — this truth is machine-authored.

## edges

c7a5bd01 <- ROOT # sidecar toolUseId -> the unanswered Agent block in the main transcript
