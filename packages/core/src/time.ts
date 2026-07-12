/** Internal: strict ISO-8601 timestamp parsing with loud failure. */

/**
 * Parses an ISO-8601 timestamp to epoch milliseconds, throwing on anything
 * unparsable. A silent NaN would corrupt price resolution and wave grouping.
 */
export function parseTimestampMs(value: string, context: string): number {
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) {
    throw new RangeError(`${context}: unparsable ISO-8601 timestamp "${value}"`);
  }
  return ms;
}
