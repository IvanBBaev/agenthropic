/**
 * The cross-package string unions that have no TypeBox schema of their own.
 *
 * WHAT THIS FILE IS NOT, AS OF 2026-09-02. It used to be `types/rows.ts` and
 * declared seven `*Row` interfaces "mirroring the SQLite schema", described as
 * the cross-package data contracts that "every workspace consumes". None of the
 * seven had a single importer anywhere in the monorepo, and two of them had
 * drifted into contradicting the schema they claimed to mirror: `AgentRow`
 * declared `started_at`/`ended_at` where `agents` has `first_seen_at`/
 * `last_seen_at`, and `TokenUsageRow` described a WIDE row (`input`, `output`,
 * `cache_read`, `cache_write_5m`, `cache_write_1h`) against a `token_usage`
 * table that is TALL. Four of the names were meanwhile redeclared locally, and
 * correctly, at their point of use (`db-sessions.test.ts`, `db-agents.test.ts`,
 * `event-store.test.ts`, `src/db/pricing.ts`) - which is exactly why the
 * originals were free to rot. A type nobody imports can never fail a typecheck.
 *
 * WHY THE ENUMS DID NOT GO WITH THEM, AND WHY THREE OF THEM DID. Six unions
 * lived here. Three - `AgentStatus`, `AgentType`, `OrchestrationEdgeSource` -
 * were SECOND declarations of names that `schemas/common.ts` also declares from
 * its TypeBox schemas, and the package index re-exported the `schemas/common`
 * versions EXPLICITLY. An explicit re-export shadows a star re-export, so every
 * consumer outside this package was already resolving to `schemas/common`; the
 * copies here were reachable only from this file. Two identical definitions of
 * one union with nothing keeping them in step is a drift waiting to happen, so
 * the shadowed copies are gone and `schemas/common.ts` is the single
 * declaration - the better one, since it is derived from the runtime validator
 * rather than sitting beside it.
 *
 * The two below survive because they are genuinely load-bearing and genuinely
 * have no schema: they constrain values that cross package boundaries as plain
 * TypeScript, never as a validated wire payload. `AgentOutcomeCause` was a
 * third, and left on 2026-09-02 for the good reason - WP-U13 put it on the
 * agent DTO, so it now crosses the wire and needs a runtime validator.
 * `schemas/common.ts` owns it, as `Static<typeof AgentOutcomeCauseSchema>`.
 * Migrating it rather than copying it is the point: one declaration, or the
 * two drift.
 *
 * The package index now re-exports these three BY NAME rather than with
 * `export type *`. That is deliberate: a star export is what let a duplicate
 * declaration hide in plain sight for weeks. With every export named, the next
 * duplicate is a compile error instead of a silent shadow.
 */

/** The five priced token buckets (parser-spec section 5.4). */
export type TokenBucket = 'input' | 'output' | 'cache_read' | 'cache_write_5m' | 'cache_write_1h';

/** Which substrate an `events_raw` row arrived from. */
export type RawEventSource = 'hook' | 'jsonl';
