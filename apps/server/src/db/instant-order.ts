/**
 * SQL fragments that order stored timestamps as INSTANTS, not as text.
 *
 * Ingest canonicalizes every span instant to `toISOString` form before it
 * reaches an upsert (see `canonicalizeTimestamp`), and for that one spelling
 * text order IS instant order. A row written before that boundary existed may
 * still hold a legacy offset spelling ('2026-01-01T10:00:00+02:00'), and text
 * comparison of that against a canonical value compares wall-clock digits:
 * '...T10:00:00+02:00' (08:00Z) sorts AFTER '...T09:00:00.000Z'. A scalar
 * MIN()/MAX() or a `>` over such a pair keeps the wrong anchor forever.
 *
 * These fragments compare through `julianday()`, which SQLite resolves to
 * integer milliseconds for both spellings, so the order is the instant order
 * whatever the spelling. They only CHOOSE between the two operands - never
 * rewrite one - so a canonical value is stored byte-identical (the P0
 * double-replay proof depends on that). On an instant tie the incoming
 * (canonical) operand wins, which heals a legacy spelling in place without
 * changing anything for two canonical operands (a tie there is the same text).
 *
 * NULL is absence of evidence: the known side wins. A stored value that
 * `julianday()` cannot parse loses to a parsable incoming one rather than
 * pinning the anchor forever.
 *
 * Both operands must be trusted SQL column references (never user input) -
 * they are spliced into the statement text.
 */

/** The earlier of `incoming` and `stored` as an instant (monotonic MIN). */
export function earlierInstantSql(incoming: string, stored: string): string {
  return pickInstantSql(incoming, stored, '<=');
}

/** The later of `incoming` and `stored` as an instant (monotonic MAX). */
export function laterInstantSql(incoming: string, stored: string): string {
  return pickInstantSql(incoming, stored, '>=');
}

/** True when `incoming` is a STRICTLY later instant than `stored`. */
export function isLaterInstantSql(incoming: string, stored: string): string {
  return `julianday(${incoming}) > julianday(${stored})`;
}

function pickInstantSql(incoming: string, stored: string, wins: '<=' | '>='): string {
  return `CASE
         WHEN ${incoming} IS NULL OR julianday(${incoming}) IS NULL
           THEN COALESCE(${stored}, ${incoming})
         WHEN ${stored} IS NULL OR julianday(${stored}) IS NULL THEN ${incoming}
         WHEN julianday(${incoming}) ${wins} julianday(${stored}) THEN ${incoming}
         ELSE ${stored}
       END`;
}
