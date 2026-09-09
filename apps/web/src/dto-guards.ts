/**
 * Runtime shape checks for the API response bodies (CA-8 / AU-10).
 *
 * WHY THESE ARE HAND-WRITTEN AND NOT THE REAL SCHEMAS
 * ---------------------------------------------------
 * `dto.ts` is a deliberately type-ONLY bridge to `@agenthropic/shared`: the web
 * package has no runtime dependency on that package, because its schemas pull
 * in TypeBox and the browser bundle never needs it. `import type` is fully
 * erased at build time, so nothing here may reach for `SessionListResponseSchema`
 * and friends - importing one would drag a validator library into the bundle to
 * check payloads that a few dozen lines of narrowing can check for free. That
 * decision stands; these predicates are its cost, paid on purpose.
 *
 * WHAT THEY ARE FOR
 * -----------------
 * `api.ts` used to end every read with `body as T`. A cast is not provenance:
 * it asserts a shape nobody checked, and the views then dereference containers
 * and print leaves straight off it. Two things follow from an unchecked body,
 * and only one of them is loud:
 *
 *   1. A missing CONTAINER is a TypeError during render - `skippedAgentIds.length`
 *      on `undefined`. The per-route error boundary in `Shell.tsx` contains it,
 *      so the page survives, but the panel is replaced by a failure notice that
 *      cannot say what went wrong.
 *   2. A missing or non-numeric LEAF is quiet, and quiet is worse. Note that the
 *      leaf formatters are NOT the hole any more: `formatUsd` / `formatTokens`
 *      (F-5) and `messageCountLabel` (CA-1) already answer a non-finite input
 *      with "cost unreadable" / "tokens unreadable" rather than `$NaN`. What
 *      those guards cannot reach is everything that happens to a number BEFORE
 *      or INSTEAD of formatting:
 *        - arithmetic that is then printed raw. `CostView` computes
 *          `subagentsPriced + subagentsSkipped` and interpolates it with
 *          `String(...)`, so one absent counter prints the denominator `NaN`;
 *        - and, worst of all, DISCLOSURE GATES. Every honesty notice in this app
 *          is spelled `x > 0 && <notice/>`. `undefined > 0` and `null > 0` are
 *          both `false`, so an absent `unpricedTokens` does not render as a gap -
 *          it silently withdraws the sentence that says the figure is partial,
 *          and the page then asserts complete pricing coverage it never had. The
 *          same falsiness turns an absent `counts.truncated` into a cut-short DAG
 *          presented as the whole graph, and an absent `skippedSessionCount` into
 *          an aggregate that hides the sessions it could not price.
 *
 * A defaulted zero is the exact failure this project exists to avoid, so nothing
 * here ever repairs a body. A payload either satisfies the check and is served
 * unchanged, or it is refused whole and the caller is told the body is unreadable.
 *
 * WHERE THE STRICTNESS LINE IS DRAWN, AND WHY THERE
 * -------------------------------------------------
 * Refusing a whole payload trades a small lie for a total blackout, and a
 * blackout is not automatically the more honest outcome. Two rules keep the
 * trade on the right side, and both were checked against what the suite already
 * proves rather than reasoned about in the abstract.
 *
 * RULE 1 - SHAPE, NOT SANITY. A numeric leaf is tested with
 * `typeof x === 'number'`, which refuses `undefined`, `null`, `'1.5'`, `true`
 * and `{}` - and ACCEPTS `NaN` and `Infinity`. That is not a loophole. JSON has
 * no literal for either, so `response.json()` cannot produce one: across the
 * wire this module actually defends, the two tests are equivalent. The
 * difference shows up only against a hand-built body, and there
 * `Number.isFinite` would refuse payloads whose rendering this app has already
 * been made honest about (`formatUsd`/`formatTokens` answer a non-finite input
 * with "cost unreadable"/"tokens unreadable", F-5). Deciding what is a NUMBER is
 * this module's job because only the server can get it wrong; deciding what is a
 * SANE number belongs to the formatters, which do it per cell instead of per
 * page.
 *
 * RULE 2 - DEFER TO A RENDERER THAT IS ALREADY HONEST. A leaf whose every
 * consumer answers a missing value with an explicit marker is left unchecked,
 * because refusing the payload would REPLACE a precise "this one cell could not
 * be read" with "none of this page can be shown". Three exemptions are claimed
 * under this rule, each pinned by an existing test:
 *   - the five `statusCounts` buckets: `bucketCount` returns `undefined` for a
 *     bucket the server omitted and the board prints NO_FIGURE_META - honesty
 *     suite, "renders an explicit unknown marker, never a blank next to the
 *     label" (LV-3);
 *   - `segment.messageCount`: `messageCountLabel` prints "messages unreadable"
 *     (CA-1);
 *   - the five `segment.tokens` buckets: they are summed and formatted, so one
 *     missing bucket yields "tokens unreadable" for that row (CA-1, same test).
 * Everything else numeric that a view reads IS checked, because it either gates
 * a disclosure or is printed raw, and neither has a fallback:
 *   - DISCLOSURE GATES are the quiet ones. Every honesty notice in this app is
 *     spelled `x > 0 && <notice/>`; `undefined > 0` and `null > 0` are both
 *     false, so an absent `unpricedTokens` does not render as a gap - it
 *     silently withdraws the sentence that says the figure is partial, and the
 *     page then asserts complete pricing coverage it never had. The same
 *     falsiness turns an absent `counts.truncated` into a cut-short DAG
 *     presented as the whole graph, and an absent `skippedSessionCount` into an
 *     aggregate that hides the sessions it could not price;
 *   - RAW PRINTS bypass the formatters entirely: `plural(...)`, `String(...)`
 *     and template interpolation render `undefined` and `NaN` verbatim, and
 *     `subagentsPriced + subagentsSkipped` is interpolated as the denominator of
 *     a coverage claim.
 *
 * Left unchecked besides the three exemptions:
 *   - strings - ids, model names, day labels, project slugs. A wrong string
 *     prints as itself and is self-evident; it cannot masquerade as a precise
 *     figure. Rejecting a cost summary over an odd day label would be exactly
 *     the blackout-for-a-typo trade rule 1 exists to refuse;
 *   - enum membership (`status`, `source`, `outcomeCause`) - the views already
 *     funnel an unrecognised value into an explicit "unknown" bucket, which is
 *     rule 2 again;
 *
 *     AMENDED 2026-09-08 (DG-4). Two things wrong with the sentence above, and
 *     the second one mattered. First the wording: there is no "unknown bucket".
 *     `status.ts` keeps three separate words on purpose - `unknown` (▲, amber)
 *     is a REAL status the missing-Stop watchdog assigns, `unrecorded` (·) means
 *     the server recorded none, and `unrecognised` (?) means this build cannot
 *     read what arrived. An unrecognised value lands in the third. Naming it
 *     "unknown" here reintroduces, in the justification for skipping the check,
 *     exactly the conflation that file exists to prevent.
 *
 *     Second, and this is the part that was not merely imprecise: rule 2 defers
 *     to a renderer that is ALREADY honest, and for a NON-STRING `status` that
 *     renderer was not. Until SV-3 (2026-09-07) `statusMeta` interpolated
 *     whatever it received, so a server that dropped the `status` field reached
 *     the screen as `unrecognised (undefined)` - a sentence that tells the
 *     reader their server sent the status word "undefined" when it had sent no
 *     status at all. The exemption was claimed for a year of commits against a
 *     renderer that did not hold up its end, and nothing pinned it, so nothing
 *     said so.
 *
 *     The exemption STANDS - refusing a whole session list because one row lost
 *     its status word is the blackout-for-a-cell trade rule 2 exists to refuse,
 *     and a non-string now renders as `unrecognised (no status word sent)`,
 *     which names the payload defect precisely. What changes is that it is now
 *     pinned like the other three, from both ends: `dto-guards.test.ts`
 *     ("accepts a `status` that is not a string at all (rule 2)") holds the
 *     guard open, and `status.test.ts` (SV-3) holds the renderer honest. Tighten
 *     either and the other fails.
 *
 *   - fields no view reads (`limit`, `offset` on the session list). Checking one
 *     can only ever cost a blackout, since nothing downstream could have
 *     misreported it;
 *   - the schemas' `Integer` / `minimum: 0` refinements. A negative or fractional
 *     count is a SERVER bug and displays as the number it actually is - the
 *     reader can see it and disbelieve it. That is a different class from `null`,
 *     which displays as a number the server never sent. Only the second is this
 *     module's problem.
 *
 * Consequently these predicates certify the load-bearing subset of each DTO, not
 * the whole contract, and `api.ts` says so where it casts.
 */

// --- primitives --------------------------------------------------------------

/** A non-null, non-array object: the only shape whose properties are safe to read. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Every key holds a value the server sent as a number (rule 1 above: shape, not
 * sanity). `typeof` rather than `Number.isFinite`, and never the global
 * `isFinite`, which coerces and so would accept the string `'1.5'` and even `''`.
 *
 * A loop rather than a chain of `&&`s so that adding a key costs no new branch:
 * an exhaustive predicate whose every branch cannot be reached from a test is
 * one this repo's 100% gate would reject anyway.
 */
function hasNumbers(record: Record<string, unknown>, keys: readonly string[]): boolean {
  for (const key of keys) {
    if (typeof record[key] !== 'number') return false;
  }
  return true;
}

/** The nested record at `key`, or `null` when it is absent or not a record. */
function recordAt(record: Record<string, unknown>, key: string): Record<string, unknown> | null {
  const value = record[key];
  return isRecord(value) ? value : null;
}

/** An array whose every element is a record satisfying `check`. */
function isArrayOfRecords(
  value: unknown,
  check: (row: Record<string, unknown>) => boolean,
): boolean {
  if (!Array.isArray(value)) return false;
  // Widen away the `any[]` that `Array.isArray` narrows to - the elements are
  // untrusted input and must stay `unknown` until `isRecord` says otherwise.
  const rows: readonly unknown[] = value;
  return rows.every((row) => isRecord(row) && check(row));
}

// --- the repeated numeric vocabularies --------------------------------------
// Three shapes carry the same rollup triple under two different spellings, so
// the key lists are shared rather than restated per DTO.

/** `AgentNodeDto` and the session tree's `unattributed` rollup. */
const AGENT_NUMBERS = ['totalTokens', 'costUsd', 'unpricedTokens'] as const;

/** `CostTotalsDto` / `ModelCostDto` / `DailyCostDto` / `SessionCostDto`. */
const COST_ROW_NUMBERS = ['tokens', 'costUsd', 'unpricedTokens'] as const;

/** The delegation counterfactual, per session and per agent alike. */
const SAVINGS_NUMBERS = ['actualUsd', 'hypotheticalUsd', 'savingsUsd'] as const;

function hasAgentNumbers(row: Record<string, unknown>): boolean {
  return hasNumbers(row, AGENT_NUMBERS);
}

function hasCostRowNumbers(row: Record<string, unknown>): boolean {
  return hasNumbers(row, COST_ROW_NUMBERS);
}

function hasSavingsNumbers(row: Record<string, unknown>): boolean {
  return hasNumbers(row, SAVINGS_NUMBERS);
}

// --- per-endpoint predicates -------------------------------------------------

/**
 * `limit` and `offset` are in the contract but no view reads them, so they are
 * not checked - see rule 2's last bullet.
 */
const SESSION_LIST_NUMBERS = ['total'] as const;
const SESSION_SUMMARY_NUMBERS = [
  'agentCount',
  'totalTokens',
  'totalCostUsd',
  'unpricedTokens',
] as const;
function isSessionSummary(row: Record<string, unknown>): boolean {
  // The `statusCounts` OBJECT is required - `bucketCount` reads a property off
  // it and would throw - but its five buckets are NOT checked: a bucket the
  // server omitted already renders as NO_FIGURE_META, which says more than a
  // blacked-out board would (rule 2).
  return recordAt(row, 'statusCounts') !== null && hasNumbers(row, SESSION_SUMMARY_NUMBERS);
}

/** `GET /api/sessions` - drives the live board and the session list. */
export function isSessionList(body: Record<string, unknown>): boolean {
  return (
    hasNumbers(body, SESSION_LIST_NUMBERS) && isArrayOfRecords(body['sessions'], isSessionSummary)
  );
}

const SESSION_TREE_NUMBERS = ['agentCount', 'edgeCount'] as const;

/** `GET /api/sessions/:id/tree` - the persisted subagent tree for one session. */
export function isSessionTree(body: Record<string, unknown>): boolean {
  const unattributed = recordAt(body, 'unattributed');
  return (
    unattributed !== null &&
    hasAgentNumbers(unattributed) &&
    hasNumbers(body, SESSION_TREE_NUMBERS) &&
    isArrayOfRecords(body['agents'], hasAgentNumbers) &&
    // Edges carry no figure - only ids, which are checked nowhere by design -
    // but the array itself is mapped and counted, so it must exist.
    Array.isArray(body['edges'])
  );
}

const DAG_COUNT_NUMBERS = [
  'totalSessions',
  'totalAgents',
  'totalEdges',
  'returnedAgents',
  'returnedEdges',
] as const;

/** `GET /api/dag/global` - the cross-session DAG and the top-burners ranking. */
export function isGlobalDag(body: Record<string, unknown>): boolean {
  const counts = recordAt(body, 'counts');
  return (
    counts !== null &&
    hasNumbers(counts, DAG_COUNT_NUMBERS) &&
    // The one boolean worth refusing a payload over: both DagView and CostView
    // render their "this graph was cut short" notice behind `counts.truncated`,
    // so an absent flag is not a blank - it is an assertion of completeness.
    typeof counts['truncated'] === 'boolean' &&
    isArrayOfRecords(body['nodes'], hasAgentNumbers) &&
    Array.isArray(body['edges'])
  );
}

const COVERAGE_NUMBERS = ['sessionsExcluded', 'sessionsQuarantined'] as const;

/**
 * `coverage` is `Type.Optional` in the schema and its absence is meaningful -
 * "the server has no ingest seam wired", which is a different fact from zero and
 * must not be refused as malformed. Present, though, it prints two counts, so it
 * is held to the same standard as any other figure.
 */
function hasOptionalCoverage(body: Record<string, unknown>): boolean {
  const coverage = body['coverage'];
  return coverage === undefined || (isRecord(coverage) && hasNumbers(coverage, COVERAGE_NUMBERS));
}

/** `GET /api/cost/summary` - the KPI row, the day windows and the cost flow. */
export function isCostSummary(body: Record<string, unknown>): boolean {
  const totals = recordAt(body, 'totals');
  return (
    totals !== null &&
    hasCostRowNumbers(totals) &&
    isArrayOfRecords(body['perModel'], hasCostRowNumbers) &&
    isArrayOfRecords(body['perDay'], hasCostRowNumbers) &&
    isArrayOfRecords(body['topSessions'], hasCostRowNumbers) &&
    hasOptionalCoverage(body)
  );
}

const AGGREGATE_NUMBERS = [
  'actualUsd',
  'hypotheticalUsd',
  'savingsUsd',
  'sessionsTotal',
  'sessionsWithSubagents',
  'sessionsPriced',
  'skippedSessionCount',
  'subagentsPriced',
  'subagentsSkipped',
  'untypedAgents',
] as const;

/**
 * `GET /api/cost/delegation-savings`. The scope counters are checked with the
 * same force as the dollar figures on purpose: the schema calls them mandatory
 * because an aggregate quietly computed over a subset is a lie, and every one of
 * them is either summed into a printed denominator or used as a `> 0` gate on a
 * disclosure.
 */
export function isAggregateSavings(body: Record<string, unknown>): boolean {
  return (
    hasNumbers(body, AGGREGATE_NUMBERS) &&
    Array.isArray(body['skippedSessions']) &&
    Array.isArray(body['hypotheticalModels'])
  );
}

const COMPACTION_NUMBERS = ['naiveUsd', 'repricedUsd', 'deltaUsd', 'compactionCount'] as const;
const SEGMENT_NUMBERS = ['usd'] as const;

/**
 * Only the `tokens` OBJECT and `usd` are checked. `segmentTokens(segment.tokens)`
 * reads five properties off `tokens`, so its absence throws - but the buckets
 * inside it, and `messageCount` beside it, are the two exemptions rule 2 names:
 * a missing bucket makes the row's sum non-finite and `formatTokens` prints
 * "tokens unreadable", and `messageCountLabel` prints "messages unreadable".
 * Refusing the payload would trade those two precise cells for an empty panel.
 */
function isCompactionSegment(row: Record<string, unknown>): boolean {
  return recordAt(row, 'tokens') !== null && hasNumbers(row, SEGMENT_NUMBERS);
}

/** `GET /api/sessions/:id/cost-analysis` - compaction repricing + delegation savings. */
export function isCostAnalysis(body: Record<string, unknown>): boolean {
  const compaction = recordAt(body, 'compaction');
  const delegationSavings = recordAt(body, 'delegationSavings');
  return (
    compaction !== null &&
    delegationSavings !== null &&
    hasNumbers(compaction, COMPACTION_NUMBERS) &&
    isArrayOfRecords(compaction['segments'], isCompactionSegment) &&
    hasSavingsNumbers(delegationSavings) &&
    isArrayOfRecords(delegationSavings['perAgent'], hasSavingsNumbers) &&
    // Counted (`.length`) to report how many subagents were left out; an absent
    // array crashes the panel, and an absent COUNT would erase the exclusion.
    Array.isArray(delegationSavings['skippedAgentIds'])
  );
}
