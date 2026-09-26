/** Internal: strict ISO-8601 timestamp parsing with loud failure. */

/**
 * A full ISO-8601 extended-format datetime with an explicit zone: `Z` or a
 * `±hh:mm` offset. Seconds are required; fractional seconds are optional.
 * Captures: year, month, day, hour, minute, second, fraction, zone.
 *
 * Field ranges are checked in code, not here, so that a rolled-over value
 * ('2026-02-30', hour 24) and a malformed one fail through the same path.
 */
const ZONED_DATETIME =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:\d{2})$/;

/** A bare calendar date, read as UTC midnight. Pricing dates only. */
const BARE_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * Epoch milliseconds of midnight UTC on the given calendar day, or NaN when
 * the day does not exist. Built with `setUTCFullYear` rather than `Date.UTC`
 * because the latter maps years 0-99 onto 1900-1999.
 */
function utcDayStartMs(year: number, month: number, day: number): number {
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  // The Date constructor rolls month 13 and day 30 of February forward; a
  // round-trip mismatch is how a day that does not exist is caught.
  return date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
    ? date.getTime()
    : Number.NaN;
}

function parseZonedDatetimeMs(value: string): number {
  const match = ZONED_DATETIME.exec(value);
  if (match === null) {
    return Number.NaN;
  }
  const [, year, month, day, hour, minute, second, fraction = '', zone] = match as unknown as [
    string,
    string,
    string,
    string,
    string,
    string,
    string,
    string | undefined,
    string,
  ];
  const dayStartMs = utcDayStartMs(Number(year), Number(month), Number(day));
  const hours = Number(hour);
  const minutes = Number(minute);
  const seconds = Number(second);
  let offsetMinutes = 0;
  if (zone !== 'Z') {
    const offsetHours = Number(zone.slice(1, 3));
    const offsetMins = Number(zone.slice(4, 6));
    if (offsetHours > 23 || offsetMins > 59) {
      return Number.NaN;
    }
    offsetMinutes = (zone.startsWith('-') ? -1 : 1) * (offsetHours * 60 + offsetMins);
  }
  if (hours > 23 || minutes > 59 || seconds > 59) {
    return Number.NaN;
  }
  // Sub-millisecond digits are truncated, matching how Date.parse and
  // toISOString treat them.
  const millis = Number(fraction.padEnd(3, '0').slice(0, 3));
  return dayStartMs + ((hours * 60 + minutes - offsetMinutes) * 60 + seconds) * 1000 + millis;
}

function fail(value: string, context: string): never {
  throw new RangeError(`${context}: unparsable ISO-8601 timestamp "${value}"`);
}

/**
 * Parses a transcript timestamp to epoch milliseconds, throwing on anything
 * that is not a full ISO-8601 datetime with an explicit zone.
 *
 * `Date.parse` is deliberately not trusted with the raw string: it accepts
 * non-ISO spellings ('Sep 23 2026'), reads a zone-less datetime in the host's
 * local zone (so the same transcript would price and group differently per
 * machine), and rolls impossible fields ('2026-02-30', hour 24) into another
 * instant. A silent NaN or a silently shifted instant would corrupt price
 * resolution and wave grouping alike.
 */
export function parseTimestampMs(value: string, context: string): number {
  const ms = parseZonedDatetimeMs(value);
  return Number.isNaN(ms) ? fail(value, context) : ms;
}

/**
 * Parses a pricing `effectiveFrom`. Accepts everything
 * {@link parseTimestampMs} accepts, plus a bare `YYYY-MM-DD` read as UTC
 * midnight - the pricing-date spelling the server documents and seeds
 * (`canonicalizeEffectiveFrom`). A bare date is unambiguous (ECMAScript and
 * SQLite both read it as UTC); a zone-less datetime is not and stays rejected.
 */
export function parsePricingInstantMs(value: string, context: string): number {
  const bare = BARE_DATE.exec(value);
  const ms =
    bare === null
      ? parseZonedDatetimeMs(value)
      : utcDayStartMs(Number(bare[1]), Number(bare[2]), Number(bare[3]));
  return Number.isNaN(ms) ? fail(value, context) : ms;
}

/** The four-digit-year window in which `toISOString` output orders as text. */
const MIN_FOUR_DIGIT_YEAR_MS = utcDayStartMs(0, 1, 1);
const MAX_FOUR_DIGIT_YEAR_MS = utcDayStartMs(9999, 12, 31) + 86_400_000 - 1;

/**
 * Rewrites a transcript timestamp to the one spelling every stored instant
 * shares: `Date.prototype.toISOString` form, `YYYY-MM-DDTHH:mm:ss.sssZ`.
 *
 * The server compares stored instants as TEXT (a monotonic `MAX()` and a
 * "strictly advances" `>`), which equals instant order only when all values
 * share one shape: '...:01Z' sorts after '...:01.500Z' because 'Z' > '.', and
 * an offset spelling compares wall-clock digits rather than instants. A value
 * already in canonical form comes back byte-identical.
 *
 * Throws (RangeError, naming `context`) on anything {@link parseTimestampMs}
 * rejects, and on an instant whose canonical form would need an expanded
 * six-digit year ('9999-12-31T23:00:00-05:00'), which also misorders as text.
 */
export function canonicalizeTimestamp(value: string, context: string): string {
  const ms = parseTimestampMs(value, context);
  if (ms < MIN_FOUR_DIGIT_YEAR_MS || ms > MAX_FOUR_DIGIT_YEAR_MS) {
    throw new RangeError(
      `${context}: timestamp "${value}" is outside the four-digit year range once normalized to UTC`,
    );
  }
  return new Date(ms).toISOString();
}
