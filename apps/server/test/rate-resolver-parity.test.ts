/**
 * M-21 reconciliation test: dated-price resolution exists TWICE — core's
 * `computeCostUsd` parses timestamps to epoch milliseconds, while the API's
 * priced CTE (`api/queries.ts`) compares `effective_from <= occurred_at` as
 * BINARY-collated text. The ingest halt gate approves dollars with the first
 * resolver; the API presents dollars with the second. This file drives both
 * over one fixture set of boundary timestamps so any drift between them is a
 * loud test failure instead of a silently wrong dashboard number.
 *
 * The parity contract, per usage row:
 *   - when core prices it, the SQL rollup reports the same dollars to the
 *     cent and zero unpriced tokens;
 *   - when core REFUSES to price it (PricingError — the no-silent-$0 halt),
 *     the SQL rollup reports $0 with every token surfaced as unpriced.
 *
 * The two resolvers agree exactly when every stored `effective_from` is
 * byte-comparable against every `occurred_at` — true for the migration seed's
 * bare-date form ('2026-01-01', a prefix of every same-date ISO string) and
 * for uniformly formatted full timestamps. They DIVERGE on mixed string
 * forms of the same instant; those cases are pinned in the "known
 * divergence" block below rather than asserted as parity, so today's truth
 * stays visible and any fix to either resolver flips this file and forces a
 * conscious graduation of the pinned case into the parity table.
 *
 * Both resolvers read the same stored `model_pricing` rows: the SQL path
 * resolves in the CTE, the core path via `loadPricing` — exactly the two
 * production read paths.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { computeCostUsd, PricingError } from '@agenthropic/core';
import type { DedupedUsage, PricingEntry } from '@agenthropic/core';
import type { ModelCostDto, SessionDetailDto } from '@agenthropic/shared';
import { getSessionDetail } from '../src/api/queries';
import { loadPricing } from '../src/db/pricing';
import { createMigratedTempDb, type TempDb } from './helpers';

const SESSION_ID = 'parity-session';
const TOKENS = 1_000_000;

interface RateRow {
  readonly usdPerMtok: number;
  readonly effectiveFrom: string;
}

interface ResolverCase {
  /** Unique per case — doubles as the model id, so the per-model SQL rollup isolates each case. */
  readonly name: string;
  readonly rates: readonly RateRow[];
  readonly occurredAt: string;
}

/** What core is expected to do, pinned so a both-resolvers-wrong drift cannot pass as parity. */
type CoreExpectation =
  { readonly kind: 'priced'; readonly usd: number } | { readonly kind: 'refused' };

interface ParityCase extends ResolverCase {
  readonly core: CoreExpectation;
}

/** Cases where the two resolvers agree today and must keep agreeing. */
const PARITY_CASES: readonly ParityCase[] = [
  {
    name: 'boundary-equal-identical-form',
    rates: [{ usdPerMtok: 10, effectiveFrom: '2026-03-01T00:00:00Z' }],
    occurredAt: '2026-03-01T00:00:00Z',
    core: { kind: 'priced', usd: 10 },
  },
  {
    // '.' sorts before 'Z', so the millisecond effective_from is byte-wise <=
    // the plain-Z occurred_at of the same instant — the benign direction.
    name: 'same-instant-ef-millis-oa-plain',
    rates: [{ usdPerMtok: 10, effectiveFrom: '2026-03-01T00:00:00.000Z' }],
    occurredAt: '2026-03-01T00:00:00Z',
    core: { kind: 'priced', usd: 10 },
  },
  {
    // Offset-form occurred_at (same instant as the rate's midnight-Z): the
    // hour digits '02' sort above the effective_from's '00', so text and ms
    // agree that the rate applies.
    name: 'same-instant-oa-offset-form',
    rates: [{ usdPerMtok: 10, effectiveFrom: '2026-03-01T00:00:00Z' }],
    occurredAt: '2026-03-01T02:00:00+02:00',
    core: { kind: 'priced', usd: 10 },
  },
  {
    // The production seed shape (migration 7 writes '2026-01-01'): a bare date
    // is a strict prefix of every same-date ISO form, so it is byte-wise <=
    // all of them — the one full-parity form for effective_from today.
    name: 'bare-date-effective-from',
    rates: [{ usdPerMtok: 10, effectiveFrom: '2026-03-01' }],
    occurredAt: '2026-03-01T00:00:00.000Z',
    core: { kind: 'priced', usd: 10 },
  },
  {
    name: 'rate-change-usage-between-rows',
    rates: [
      { usdPerMtok: 10, effectiveFrom: '2026-01-01T00:00:00Z' },
      { usdPerMtok: 30, effectiveFrom: '2026-06-01T00:00:00Z' },
    ],
    occurredAt: '2026-03-15T12:00:00Z',
    core: { kind: 'priced', usd: 10 },
  },
  {
    // Boundary-equal against the NEWER of two rows, same string form on both
    // sides: both resolvers must pick the new rate, not the old one.
    name: 'rate-change-boundary-equal-same-form',
    rates: [
      { usdPerMtok: 10, effectiveFrom: '2026-01-01T00:00:00Z' },
      { usdPerMtok: 30, effectiveFrom: '2026-06-01T00:00:00Z' },
    ],
    occurredAt: '2026-06-01T00:00:00Z',
    core: { kind: 'priced', usd: 30 },
  },
  {
    // Usage one second before the first rate exists: core halts, the API
    // surfaces the tokens as unpriced — refusal parity, no invented dollars.
    name: 'usage-before-first-rate',
    rates: [{ usdPerMtok: 10, effectiveFrom: '2026-03-01T00:00:00Z' }],
    occurredAt: '2026-02-28T23:59:59Z',
    core: { kind: 'refused' },
  },
  {
    // No pricing rows at all: core's unknown-model halt, the API's unpriced
    // bucket — the no-silent-$0 invariant seen from both sides.
    name: 'model-with-no-pricing-rows',
    rates: [],
    occurredAt: '2026-03-01T00:00:00Z',
    core: { kind: 'refused' },
  },
];

interface DivergentCase extends ResolverCase {
  readonly core: CoreExpectation;
  /** Today's SQL answer, pinned verbatim — a pin, NOT an approval. */
  readonly sql: { readonly costUsd: number; readonly unpricedTokens: number };
}

/**
 * KNOWN DIVERGENCE (M-21) — pinned, not accepted. Each entry is a stored-form
 * combination on which the text comparison and the epoch-ms comparison order
 * the same instants differently. Deleting an entry here without moving it
 * into PARITY_CASES is buying the green, not fixing the bug.
 */
const DIVERGENT_CASES: readonly DivergentCase[] = [
  {
    // Same instant, but 'Z' sorts above '.', so as text the plain-Z
    // effective_from is NOT <= the millisecond occurred_at (the form Claude
    // Code JSONL actually writes). Core prices; the API shows $0 + unpriced.
    name: 'same-instant-ef-plain-oa-millis',
    rates: [{ usdPerMtok: 10, effectiveFrom: '2026-03-01T00:00:00Z' }],
    occurredAt: '2026-03-01T00:00:00.000Z',
    core: { kind: 'priced', usd: 10 },
    sql: { costUsd: 0, unpricedTokens: TOKENS },
  },
  {
    // Offset-form effective_from (02:00+02:00 = midnight Z): as an instant it
    // precedes the usage by 30 minutes, as text it sorts after it. Core
    // prices; the API shows $0 + unpriced.
    name: 'offset-form-effective-from',
    rates: [{ usdPerMtok: 10, effectiveFrom: '2026-03-01T02:00:00+02:00' }],
    occurredAt: '2026-03-01T00:30:00Z',
    core: { kind: 'priced', usd: 10 },
    sql: { costUsd: 0, unpricedTokens: TOKENS },
  },
  {
    // The dangerous direction: at a rate change whose new row is plain-Z and
    // whose usage is millisecond-form of the SAME boundary instant, the text
    // comparison rejects the new row and silently prices at the OLD rate —
    // dollars the ingest halt gate never approved, flagged by nothing.
    name: 'rate-change-boundary-mixed-forms',
    rates: [
      { usdPerMtok: 10, effectiveFrom: '2026-01-01T00:00:00Z' },
      { usdPerMtok: 30, effectiveFrom: '2026-06-01T00:00:00Z' },
    ],
    occurredAt: '2026-06-01T00:00:00.000Z',
    core: { kind: 'priced', usd: 30 },
    sql: { costUsd: 10, unpricedTokens: 0 },
  },
];

/** Runs core's resolver over one case, catching only its documented refusal. */
function resolveWithCore(
  resolverCase: ResolverCase,
  pricing: readonly PricingEntry[],
): { kind: 'priced'; usd: number } | { kind: 'refused' } {
  const deduped: DedupedUsage = {
    messageId: `msg-${resolverCase.name}`,
    model: resolverCase.name,
    timestamp: resolverCase.occurredAt,
    usage: { input: TOKENS, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 },
    agentId: null,
  };
  try {
    return { kind: 'priced', usd: computeCostUsd([deduped], pricing) };
  } catch (error) {
    if (error instanceof PricingError) {
      return { kind: 'refused' };
    }
    throw error;
  }
}

/** The per-model SQL rollup row for one case — the API's answer for it. */
function resolveWithSql(detail: SessionDetailDto, model: string): ModelCostDto {
  const row = detail.models.find((candidate) => candidate.model === model);
  if (row === undefined) {
    throw new Error(`no per-model rollup row for "${model}" — fixture row missing`);
  }
  return row;
}

describe('rate-resolver parity: core epoch-ms vs API lexicographic SQL (M-21)', () => {
  let temp: TempDb;
  let detail: SessionDetailDto;
  let pricing: readonly PricingEntry[];

  beforeAll(() => {
    temp = createMigratedTempDb();
    temp.db
      .prepare(
        `INSERT INTO sessions (id, project_slug, started_at, last_activity_at, status)
         VALUES (?, 'parity', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', 'active')`,
      )
      .run(SESSION_ID);
    const insertRate = temp.db.prepare(
      'INSERT INTO model_pricing (model, bucket, usd_per_mtok, effective_from) VALUES (?, ?, ?, ?)',
    );
    const insertUsage = temp.db.prepare(
      `INSERT INTO token_usage
         (session_id, agent_id, message_id, model, bucket, tokens, is_compaction_baseline, occurred_at)
       VALUES (?, NULL, ?, ?, 'input', ?, 0, ?)`,
    );
    for (const resolverCase of [...PARITY_CASES, ...DIVERGENT_CASES]) {
      for (const rate of resolverCase.rates) {
        insertRate.run(resolverCase.name, 'input', rate.usdPerMtok, rate.effectiveFrom);
      }
      insertUsage.run(
        SESSION_ID,
        `msg-${resolverCase.name}`,
        resolverCase.name,
        TOKENS,
        resolverCase.occurredAt,
      );
    }
    // Both production read paths, over the same stored rows.
    const loaded = getSessionDetail(temp.db, SESSION_ID);
    if (loaded === undefined) {
      throw new Error('parity session not found after seeding');
    }
    detail = loaded;
    pricing = loadPricing(temp.db);
  });

  afterAll(() => {
    temp.cleanup();
  });

  describe('agreement cases', () => {
    for (const parityCase of PARITY_CASES) {
      it(`${parityCase.name}: both resolvers give the same answer`, () => {
        const core = resolveWithCore(parityCase, pricing);
        const sql = resolveWithSql(detail, parityCase.name);
        expect(core).toEqual(parityCase.core);
        if (parityCase.core.kind === 'priced') {
          // "To the cent": two digits. Same rate x same tokens is bit-identical
          // double math today, but the contract is monetary, not bit-level.
          expect(sql.costUsd).toBeCloseTo(parityCase.core.usd, 2);
          expect(sql.unpricedTokens).toBe(0);
        } else {
          // Refusal parity: what ingest halts on, the API must surface as
          // unpriced — never as dollars.
          expect(sql.costUsd).toBe(0);
          expect(sql.unpricedTokens).toBe(TOKENS);
        }
      });
    }
  });

  describe('known divergence, pinned until the resolvers are reconciled', () => {
    for (const divergentCase of DIVERGENT_CASES) {
      it(`${divergentCase.name}: SQL still disagrees with core exactly as documented`, () => {
        const core = resolveWithCore(divergentCase, pricing);
        const sql = resolveWithSql(detail, divergentCase.name);
        expect(core).toEqual(divergentCase.core);
        expect(sql.costUsd).toBeCloseTo(divergentCase.sql.costUsd, 2);
        expect(sql.unpricedTokens).toBe(divergentCase.sql.unpricedTokens);
        // The pin IS the divergence: if these two ever agree, this case has
        // been fixed — move it into PARITY_CASES instead of deleting it.
        if (divergentCase.core.kind === 'priced') {
          expect(sql.costUsd).not.toBeCloseTo(divergentCase.core.usd, 2);
        }
      });
    }
  });
});
