# nested-workflow — hierarchy ground truth (true by construction)

The `workflows/wf_*/subagents/` layout. Workflow subagents carry no `toolUseId`
in their sidecar, so the only available join is the directory itself: both
agents were spawned by the main agent inside one workflow.

## meta

session: 22222222-3333-4444-8555-666666666666
provenance: synthetic-by-construction
substrate: fixture:nested-workflow
labeled-by: agenthropic synthetic fixture corpus
labeled-on: 2026-08-07
note: NOT admissible for the Phase-3 exit gate — this truth is machine-authored.

## edges

deadbe01 <- ROOT # directory join, wf_ tree
deadbe02 <- ROOT # directory join, same wf_ tree, sibling not child
