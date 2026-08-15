# legacy-bare-explore — hierarchy ground truth (true by construction)

Parser-spec section 3, gate #7: a pre-2.1.71 bare `{agentType: 'Explore'}`
sidecar carries no `toolUseId`/`spawnDepth`, and no modern anchor exists
anywhere; the only join key is the child hex as the raw top-level `agentId`
of a `progress` record in the main transcript. The fixture was built with
exactly one legacy spawn, from the main agent, and the parser must emit the
edge with the DISTINCT `legacy_explore` provenance rather than orphaning.

## meta

session: 99999999-aaaa-4bbb-8ccc-dddddddddddd
provenance: synthetic-by-construction
substrate: fixture:legacy-bare-explore
labeled-by: agenthropic synthetic fixture corpus
labeled-on: 2026-08-12
note: NOT admissible for the Phase-3 exit gate — this truth is machine-authored.

## edges

0b501e7e <- ROOT # raw agentId on a main-transcript progress line (gate #7, legacy_explore)
