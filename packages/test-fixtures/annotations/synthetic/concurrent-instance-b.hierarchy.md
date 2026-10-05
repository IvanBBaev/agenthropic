# concurrent-instance-b — hierarchy ground truth (true by construction)

WP-X1 pathology same-slug concurrency, instance B of 2: this session ran at
the same time, in the same project, as `concurrent-instance-a`, and dispatched a
look-alike subagent 2 ms apart from it. Keyed on session uuid its single child
belongs to this session's root only — never to the other instance's tree.

## meta

session: c0c0b000-1111-4222-8333-444444444444
provenance: synthetic-by-construction
substrate: fixture:concurrent-instance-b
labeled-by: agenthropic synthetic fixture corpus
labeled-on: 2026-09-30
note: NOT admissible for the Phase-3 exit gate — this truth is machine-authored.

## edges

c0c0b001 <- ROOT # sidecar toolUseId -> the Agent block in this session's own main transcript
