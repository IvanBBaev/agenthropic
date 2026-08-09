/**
 * WP-U2/U3/U4 - the read API plugin. Registered by buildServer ONLY when a
 * database handle was provided, and always INSIDE the app scope whose global
 * onRequest hook auth-gates every /api/* route - this plugin never opens an
 * unauthenticated path.
 *
 * Conventions: TypeBox response schemas on every route, additionalProperties
 * false everywhere, the uniform { error } shape for every non-2xx, and capped
 * limit/offset pagination on anything unbounded. All SQL behind these routes
 * is read-only (queries.ts).
 */
import type { FastifyError, FastifyPluginAsync } from 'fastify';
import { Type, type TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import {
  ApiErrorSchema,
  CostAnalysisSchema,
  CostSummaryResponseSchema,
  DEFAULT_COST_TOP_N,
  DEFAULT_DAG_NODE_LIMIT,
  DEFAULT_PAGE_LIMIT,
  GlobalDagResponseSchema,
  MAX_COST_TOP_N,
  MAX_DAG_NODE_LIMIT,
  MAX_PAGE_LIMIT,
  MAX_PAGE_OFFSET,
  SessionDetailSchema,
  SessionEventsResponseSchema,
  SessionListResponseSchema,
  SessionTreeResponseSchema,
} from '@agenthropic/shared';
import {
  PricingError,
  SubstrateError,
  computeCompactionAwareCost,
  computeDelegationSavings,
} from '@agenthropic/core';
import type { SqliteDatabase } from '../db/connection';
import { loadPricing } from '../db/pricing';
import type { SubstrateLookup, SubstrateProvider } from './substrate-provider';
import {
  countSessions,
  getCostSummary,
  getGlobalDag,
  getSessionDetail,
  getSessionEvents,
  getSessionTree,
  listSessions,
} from './queries';

export interface ApiRoutesOptions {
  readonly db: SqliteDatabase;
  /**
   * Read-only corpus seam for the WP-C4/C5 cost-analysis endpoint. Optional:
   * when absent (e.g. a DB-only deployment or test), the endpoint replies 503
   * instead of guessing at a corpus location.
   */
  readonly substrateProvider?: SubstrateProvider;
}

/** Capped limit/offset pagination - /api/sessions and /api/sessions/:id/events. */
const SessionListQuerySchema = Type.Object(
  {
    limit: Type.Integer({ minimum: 1, maximum: MAX_PAGE_LIMIT, default: DEFAULT_PAGE_LIMIT }),
    offset: Type.Integer({ minimum: 0, maximum: MAX_PAGE_OFFSET, default: 0 }),
  },
  { additionalProperties: false },
);

const SessionParamsSchema = Type.Object(
  {
    id: Type.String({ minLength: 1 }),
  },
  { additionalProperties: false },
);

const CostQuerySchema = Type.Object(
  {
    topN: Type.Integer({ minimum: 1, maximum: MAX_COST_TOP_N, default: DEFAULT_COST_TOP_N }),
  },
  { additionalProperties: false },
);

const DagQuerySchema = Type.Object(
  {
    limit: Type.Integer({
      minimum: 1,
      maximum: MAX_DAG_NODE_LIMIT,
      default: DEFAULT_DAG_NODE_LIMIT,
    }),
  },
  { additionalProperties: false },
);

const CostAnalysisQuerySchema = Type.Object(
  {
    /**
     * Optional routing alternative for the delegation-savings hypothetical
     * (WP-C5 rule 1); absent → per-subagent ancestor derivation.
     */
    topTierModel: Type.Optional(Type.String({ minLength: 1 })),
  },
  { additionalProperties: false },
);

export const apiRoutes: FastifyPluginAsync<ApiRoutesOptions> = async (app, options) => {
  const { db, substrateProvider } = options;
  const typed = app.withTypeProvider<TypeBoxTypeProvider>();

  // Scoped to THIS plugin (Fastify encapsulation) - the uniform error shape
  // for validation failures (400) and query errors (500). 5xx details never
  // reach the client; nothing about the request is echoed back on 500.
  app.setErrorHandler((error: FastifyError, _request, reply) => {
    const statusCode = error.statusCode ?? 500;
    const message = statusCode >= 500 ? 'Internal server error.' : error.message;
    void reply.code(statusCode).send({ error: message });
  });

  typed.get(
    '/api/sessions',
    {
      schema: {
        querystring: SessionListQuerySchema,
        response: {
          200: SessionListResponseSchema,
          400: ApiErrorSchema,
          500: ApiErrorSchema,
        },
      },
    },
    async (request) => {
      const { limit, offset } = request.query;
      return {
        sessions: listSessions(db, limit, offset),
        total: countSessions(db),
        limit,
        offset,
      };
    },
  );

  typed.get(
    '/api/sessions/:id',
    {
      schema: {
        params: SessionParamsSchema,
        response: {
          200: SessionDetailSchema,
          400: ApiErrorSchema,
          404: ApiErrorSchema,
          500: ApiErrorSchema,
        },
      },
    },
    async (request, reply) => {
      const detail = getSessionDetail(db, request.params.id);
      if (detail === undefined) {
        return reply.code(404).send({ error: 'Session not found.' });
      }
      return detail;
    },
  );

  typed.get(
    '/api/sessions/:id/tree',
    {
      schema: {
        params: SessionParamsSchema,
        response: {
          200: SessionTreeResponseSchema,
          400: ApiErrorSchema,
          404: ApiErrorSchema,
          500: ApiErrorSchema,
        },
      },
    },
    async (request, reply) => {
      const tree = getSessionTree(db, request.params.id);
      if (tree === undefined) {
        return reply.code(404).send({ error: 'Session not found.' });
      }
      return tree;
    },
  );

  // WP-D5 reader - the hook LIVENESS timeline of one session, normalized
  // from hook deliveries (events_raw -> events). These rows are liveness
  // signals ONLY: they are NOT the DAG, they never influence agents /
  // orchestration_edges / token_usage, and the ABSENCE of events means
  // NOTHING about whether an agent ran - hooks are a secondary best-effort
  // channel; JSONL transcripts are ground truth. A known session with zero
  // hook events is a 200 with an empty list; only an unknown session id is a
  // 404 - the API never conflates those two facts. Pagination is the same
  // capped limit/offset idiom as /api/sessions, with `total` keeping any
  // truncation visible.
  typed.get(
    '/api/sessions/:id/events',
    {
      schema: {
        params: SessionParamsSchema,
        querystring: SessionListQuerySchema,
        response: {
          200: SessionEventsResponseSchema,
          400: ApiErrorSchema,
          404: ApiErrorSchema,
          500: ApiErrorSchema,
        },
      },
    },
    async (request, reply) => {
      const { limit, offset } = request.query;
      const events = getSessionEvents(db, request.params.id, limit, offset);
      if (events === undefined) {
        return reply.code(404).send({ error: 'Session not found.' });
      }
      return events;
    },
  );

  // WP-C4 + WP-C5 over one session, computed from the JSONL substrate (not DB
  // rows): compaction boundaries are not persisted and the savings estimate
  // needs the parsed agent tree. Honesty rules: `isEstimate` stays visible in
  // the DTO, and a priceless model is an explicit 422 — never a silent $0.
  typed.get(
    '/api/sessions/:id/cost-analysis',
    {
      schema: {
        params: SessionParamsSchema,
        querystring: CostAnalysisQuerySchema,
        response: {
          200: CostAnalysisSchema,
          400: ApiErrorSchema,
          404: ApiErrorSchema,
          422: ApiErrorSchema,
          500: ApiErrorSchema,
          503: ApiErrorSchema,
        },
      },
    },
    async (request, reply) => {
      if (substrateProvider === undefined) {
        return reply.code(503).send({ error: 'corpus access is not configured' });
      }

      let lookup: SubstrateLookup;
      try {
        lookup = substrateProvider.loadSession(request.params.id);
      } catch (error) {
        if (error instanceof SubstrateError) {
          // A poisoned transcript is a data problem, not a server bug; corpus
          // internals (paths, offending lines) are never echoed to the client.
          return reply.code(422).send({ error: 'Session transcripts could not be parsed.' });
        }
        throw error; // e.g. ContainmentError → uniform detail-free 500
      }
      // Four ways to have no substrate, four different answers. They used to
      // share one `404 Session not found.`, which was untrue in most cases:
      // with no corpus root (or one that cannot be read) nothing here knows
      // whether the session exists, and an empty remnant was found — it simply
      // holds nothing to analyse.
      if (lookup.kind === 'no-corpus-root') {
        // 503, not 404: the root is re-resolved per call, so a corpus that
        // appears later fixes this without a restart. That is a server
        // capability gap, exactly like the absent provider above.
        return reply
          .code(503)
          .send({ error: 'no corpus root is present on this machine, so nothing can be analysed' });
      }
      if (lookup.kind === 'unreadable-root') {
        // Also 503 and also retryable — but a DIFFERENT sentence: the root is
        // there, this process just could not read it on this attempt.
        return reply
          .code(503)
          .send({ error: 'the corpus root exists but could not be read; retry shortly' });
      }
      if (lookup.kind === 'session-not-found') {
        return reply.code(404).send({ error: 'Session not found.' });
      }
      if (lookup.kind === 'no-substrate') {
        return reply
          .code(422)
          .send({ error: 'the session transcript holds no analysable records' });
      }
      const resolved = lookup.substrate;

      const pricing = loadPricing(db);
      const { topTierModel } = request.query;
      try {
        return {
          compaction: computeCompactionAwareCost(
            resolved.session.usage,
            resolved.boundaries,
            pricing,
          ),
          delegationSavings: computeDelegationSavings(
            resolved.session,
            pricing,
            topTierModel === undefined ? {} : { topTierModel },
          ),
        };
      } catch (error) {
        if (error instanceof PricingError) {
          // The honest no-silent-$0 payload: which model/bucket cannot be
          // priced (the message carries model/message ids only — no paths).
          return reply.code(422).send({ error: error.message });
        }
        throw error; // timestamp/dedup corruption → uniform detail-free 500
      }
    },
  );

  typed.get(
    '/api/cost/summary',
    {
      schema: {
        querystring: CostQuerySchema,
        response: {
          200: CostSummaryResponseSchema,
          400: ApiErrorSchema,
          500: ApiErrorSchema,
        },
      },
    },
    async (request) => getCostSummary(db, request.query.topN),
  );

  typed.get(
    '/api/dag/global',
    {
      schema: {
        querystring: DagQuerySchema,
        response: {
          200: GlobalDagResponseSchema,
          400: ApiErrorSchema,
          500: ApiErrorSchema,
        },
      },
    },
    async (request) => getGlobalDag(db, request.query.limit),
  );
};
