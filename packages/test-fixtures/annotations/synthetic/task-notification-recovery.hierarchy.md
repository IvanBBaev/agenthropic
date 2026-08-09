# task-notification-recovery — hierarchy ground truth (true by construction)

The compaction-eviction case: the spawning `Task` tool_use block is gone from
the main transcript, and the only surviving structural trace is the
`<task-notification>` record. The parser must re-anchor the child to the main
agent rather than drop it.

## meta

session: 33333333-4444-4555-8666-777777777777
provenance: synthetic-by-construction
substrate: fixture:task-notification-recovery
labeled-by: agenthropic synthetic fixture corpus
labeled-on: 2026-08-07
note: NOT admissible for the Phase-3 exit gate — this truth is machine-authored.

## edges

c0ffee42 <- ROOT # recovered via task_notification after the tool_use was evicted
