# depth-2-sync — hierarchy ground truth (true by construction)

Parser-spec gate item 4: the grandchild's spawning `Task` block lives inside the
depth-1 agent's own transcript, not in the main transcript. Its parent is
therefore the depth-1 subagent — the self-referential parent index. A parser
that only ever indexes the main transcript flattens this to ROOT and scores
wrong here, which is exactly what the annotation is for.

## meta

session: 66666666-7777-4888-8999-aaaaaaaaaaaa
provenance: synthetic-by-construction
substrate: fixture:depth-2-sync
labeled-by: agenthropic synthetic fixture corpus
labeled-on: 2026-08-07
note: NOT admissible for the Phase-3 exit gate — this truth is machine-authored.

## edges

d1d1a001 <- ROOT # depth-1, spawned from the main transcript
d2d2b002 <- d1d1a001 # depth-2, spawned from inside the depth-1 transcript
