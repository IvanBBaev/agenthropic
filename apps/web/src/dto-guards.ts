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
 * be read" with "none of this page can be shown". Four exemptions are claimed
 * under this rule, each pinned by an existing test - the three numeric ones
 * below, plus enum membership in the unchecked list further down (DG-4):
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
 * Left unchecked besides the three numeric exemptions:
 *   - strings - ids, model names, day labels, project slugs. A wrong string
 *     prints as itself and is self-evident; it cannot masquerade as a precise
 *     figure. Rejecting a cost summary over an odd day label would be exactly
 *     the blackout-for-a-typo trade rule 1 exists to refuse;
 *
 *     AMENDED 2026-09-23 (lane-M). The VERDICT stands - `day` is still unchecked
 *     here, and tightening it would still be the blackout-for-a-typo trade - but
 *     the reason given for it was too broad. "A wrong string prints as itself
 *     and is self-evident; it cannot masquerade as a precise figure" is true of
 *     an id or a model name, and was false of `day`: nothing printed it, the
 *     cost windows ROUTED on it. A row carrying `''` matched no window and fell
 *     out of all four buckets, so its tokens and dollars left the page while the
 *     four totals still read as a partition of the whole; and `'2026-8-5'` sorts
 *     lexicographically above `'2026-08-15'`, so a ten-day-old row was announced
 *     as future-dated evidence that the corpus and the browser disagree about
 *     the clock. That is a string masquerading as a precise figure, by way of
 *     the arithmetic it silently selected. The defence belongs where it now
 *     lives - `isReadableDay` in `views/cost-windows.ts`, which round-trips the
 *     day through `Date.parse` and routes anything that does not survive into an
 *     explicit `unreadableDay` bucket the view discloses. The rule to carry
 *     forward: a string is safe to leave unchecked when it is only ever
 *     RENDERED, and is not when something COMPARES or BUCKETS on it.
 *
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
 *     AMENDED 2026-09-23 (lane-EP). DG-4 audited the exemption one field at a
 *     time and stopped at two of the three. `status` had `statusMeta` and
 *     `outcomeCause` had `outcomeCauseText`; both answer `unrecognised (...)`
 *     for a word they do not know AND for a value that is not a word. `source`
 *     had no such renderer at all. Four sites asked `source === 'tool_use'` and
 *     sent everything else down the `inferred` arm, so the exemption above was
 *     claimed - in the amendment written to check exactly this - against a
 *     funnel that did not exist for the field in the middle of its own list.
 *
 *     The failure is worse than the one DG-4 found, because `inferred` is not a
 *     vaguer word for the same thing: it is a positive claim that the server
 *     DERIVED the parent-child link, made on the sole evidence that the word
 *     was not `tool_use`. A source this build has not learned could equally be
 *     a new OBSERVATION, in which case the page understated the graph. Both
 *     legends made it concrete by enumerating the four inferred sources beside
 *     a dashed stroke that, by construction, was also being drawn for words not
 *     on that list. The exemption STANDS for the same reason as above, and
 *     `views/provenance.ts` is now the funnel it was always said to have:
 *     `provenance.test.ts` holds the renderer honest from one end and the
 *     guard test holds the check open from the other.
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
 *
 * AMENDED 2026-09-09 (L1). `GET /api/cost/summary` gained two required fields,
 * `sessionCount` and `hasMore`, and both are now checked. Neither is a new
 * category: they are the two failure modes this header already names, arriving
 * on one payload.
 *
 * `sessionCount` is the POPULATION the `topSessions` slice was cut from, and
 * the scope sentence over that table prints it RAW as a denominator - "5 of 51
 * sessions". No formatter stands between it and the screen, so an absent
 * counter renders literally, exactly as the header's raw-print bullet says
 * template interpolation renders `undefined`, and the table then claims to be
 * five sessions out of nothing. `hasMore` is a DISCLOSURE GATE, spelled the way
 * every honesty notice in this app is spelled, so an absent flag is false and
 * silently withdraws the sentence that says the table is only a slice - the
 * falsiness failure the header already names for `unpricedTokens` and
 * `counts.truncated`. Rule 2 claims no exemption for either: there is no
 * renderer that answers a missing one with "unreadable" in that one cell, so
 * the whole body is refused and a stale server is named as stale.
 *
 * The two are checked with DIFFERENT strictness, and the difference is rule 1.
 * `sessionCount` goes through `hasNumbers` - `typeof x === 'number'`, nothing
 * more. A `Number.isInteger` test here would contradict the rule this header
 * spends its longest section justifying, and the unchecked list already says
 * why: a fractional count is a SERVER bug that displays as the number it
 * actually is and can be disbelieved, which is a different class from `null`,
 * which displays as a number the server never sent. `hasMore` is checked as a
 * boolean on the precedent of `counts.truncated` in `isGlobalDag` - "the one
 * boolean worth refusing a payload over ... an absent flag is not a blank - it
 * is an assertion of completeness" - the same flag over a table rather than a
 * graph.
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

/**
 * The corpus-scope counter beside the top-sessions table: how many sessions the
 * corpus holds, not how many rows the slice carries. `hasMore` travels with it
 * but is a boolean, so it is checked in place rather than listed here.
 */
const COST_SUMMARY_NUMBERS = ['sessionCount'] as const;

/**
 * `GET /api/cost/summary` - the KPI row, the day windows and the cost flow.
 *
 * AMENDED 2026-09-09 (L1). And the scope sentence over the top-sessions table,
 * which is what the two checks below defend. `sessionCount` is interpolated
 * raw as the denominator of "n of N sessions", and `hasMore` gates the notice
 * that the table is a slice, so a server that predates the pair is refused
 * whole rather than rendered as "5 of undefined sessions" with the truncation
 * notice silently withdrawn.
 */
export function isCostSummary(body: Record<string, unknown>): boolean {
  const totals = recordAt(body, 'totals');
  return (
    totals !== null &&
    hasCostRowNumbers(totals) &&
    isArrayOfRecords(body['perModel'], hasCostRowNumbers) &&
    isArrayOfRecords(body['perDay'], hasCostRowNumbers) &&
    isArrayOfRecords(body['topSessions'], hasCostRowNumbers) &&
    // The population the slice above was cut from, printed raw as a
    // denominator: an absent counter reaches the reader as itself.
    hasNumbers(body, COST_SUMMARY_NUMBERS) &&
    // The second boolean worth refusing a payload over, on the precedent of
    // `counts.truncated` in `isGlobalDag`: an absent flag is not a blank - it
    // is an assertion of completeness, here about a table rather than a graph.
    typeof body['hasMore'] === 'boolean' &&
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
const SEGMENT_NUMBERS = ['usd', 'index'] as const;

/**
 * Only the `tokens` OBJECT and `usd` are checked. `segmentTokens(segment.tokens)`
 * reads five properties off `tokens`, so its absence throws - but the buckets
 * inside it, and `messageCount` beside it, are two of the exemptions rule 2 names:
 * a missing bucket makes the row's sum non-finite and `formatTokens` prints
 * "tokens unreadable", and `messageCountLabel` prints "messages unreadable".
 * Refusing the payload would trade those two precise cells for an empty panel.
 *
 * AMENDED 2026-09-23 (K1, K2). The sentence above is still the rule; the row it
 * was applied to had three more fields that the rule sends the other way, and
 * none of them was audited against it. Each is a category this header already
 * names, so nothing new is being decided here - only applied.
 *
 * K1 - `index` is a RAW PRINT, now in `SEGMENT_NUMBERS`. `SessionCostAnalysis`
 * renders the leading `#` column as `{segment.index + 1}` and keys the row as
 * `${agentId ?? 'main'}-${String(index)}`. No formatter stands between either
 * and the screen, which is the header's raw-print bullet verbatim: an absent
 * counter numbers every segment `NaN` down a column of otherwise real figures,
 * and every row keys to the same `main-undefined`, which React reconciles as
 * one row - so the table also silently loses segments it was handed. Rule 2
 * claims no exemption because there is no renderer that says "unreadable" in
 * that one cell; `index` reaches the DOM through arithmetic and `String`.
 *
 * K2 - `agentId` and `boundary` are read THROUGH, so their absence is the
 * TypeError of category 1, exactly as `tokens`' absence is. Both are nullABLE
 * and both nulls are handled and meaningful - a null `agentId` prints "main"
 * and a null `boundary` prints "session start" - which is why the test is "null
 * or the right kind of thing" rather than a bare presence check. Undefined is a
 * different fact and is handled nowhere: `shortId(segment.agentId)` reads
 * `.length` off it and `segment.boundary.trigger` reads `.trigger` off it, and
 * the route error boundary then replaces the panel with a notice that cannot
 * say what went wrong. `agentId` is additionally required to be a STRING, which
 * is not a retreat from rule 1's string exemption: that exemption covers a
 * WRONG string, which prints as itself, and `shortId(42)` prints as itself too -
 * but `shortId({})` returns the object unchanged and React refuses an object as
 * a child, which takes the panel down as surely as the undefined does.
 */
function isCompactionSegment(row: Record<string, unknown>): boolean {
  const agentId = row['agentId'];
  const boundary = row['boundary'];
  return (
    recordAt(row, 'tokens') !== null &&
    hasNumbers(row, SEGMENT_NUMBERS) &&
    (agentId === null || typeof agentId === 'string') &&
    (boundary === null || isRecord(boundary))
  );
}

/**
 * K2 (2026-09-23). One `perAgent` row of the delegation estimate: the three
 * dollar figures, plus the `agentId` the row is read through.
 *
 * `hasSavingsNumbers` alone cannot stand here, because it is shared with the
 * delegation ROLLUP, which carries the same three figures and no agent id -
 * and a predicate that certifies the rollup cannot also certify what the rows
 * have that the rollup does not. The row is rendered as
 * `<code>{shortId(agent.agentId)}</code>` under `key={agent.agentId}`, so an
 * absent id throws inside `shortId` and takes the whole delegation table with
 * it. The schema types it a plain `Type.String()`, not a nullable one: unlike
 * a compaction segment, a per-agent savings row with no agent is not a fact
 * this panel has any way to render.
 */
function isAgentSavingsRow(row: Record<string, unknown>): boolean {
  return hasSavingsNumbers(row) && typeof row['agentId'] === 'string';
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
    isArrayOfRecords(delegationSavings['perAgent'], isAgentSavingsRow) &&
    // Counted (`.length`) to report how many subagents were left out; an absent
    // array crashes the panel, and an absent COUNT would erase the exclusion.
    Array.isArray(delegationSavings['skippedAgentIds'])
  );
}
