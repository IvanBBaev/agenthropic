# usage-dedup — hierarchy ground truth (true by construction)

A lone subagent transcript with no main transcript, no sidecar and no queue
record: by construction the fixture carries no parent information at all. The
correct hierarchy answer is therefore ORPHAN — a positive claim that the parser
must emit no edge here. Inventing a parent would be a fabrication, which the
parser contract forbids, so this file is the one that keeps that honest.

## meta

session: 55555555-6666-4777-8888-999999999999
provenance: synthetic-by-construction
substrate: fixture:usage-dedup
labeled-by: agenthropic synthetic fixture corpus
labeled-on: 2026-08-07
note: NOT admissible for the Phase-3 exit gate — this truth is machine-authored.
note: ORPHAN is a claim, not an abstention; UNKNOWN would have been the abstention.

## edges

facade07 <- ORPHAN # no join path exists by construction
