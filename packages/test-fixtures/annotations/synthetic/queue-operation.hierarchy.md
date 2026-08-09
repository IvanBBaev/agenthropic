# queue-operation — hierarchy ground truth (true by construction)

The queued-spawn case: the child reaches its parent through a `queue_operation`
record that maps the queued task id back to the originating tool_use id.

## meta

session: 44444444-5555-4666-8777-888888888888
provenance: synthetic-by-construction
substrate: fixture:queue-operation
labeled-by: agenthropic synthetic fixture corpus
labeled-on: 2026-08-07
note: NOT admissible for the Phase-3 exit gate — this truth is machine-authored.

## edges

ba5eba11 <- ROOT # queue_operation join, queued task id -> tool_use id
