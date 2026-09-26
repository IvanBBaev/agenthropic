/**
 * WP-D10 - retention POLICY types, defaults and loaders.
 *
 * POLICY STATUS. The v1.0 policy is SIGNED (D3, 2026-09-08, on the closing
 * board) and runs in production: `events` rows older than 90 days expire,
 * backup files older than 30 days expire behind a floor of the 7 newest, and
 * `token_usage` is NEVER pruned. `config.ts` parses the three numbers,
 * {@link signedRetentionPolicy} turns them into a policy that cannot express a
 * `token_usage` prune, and `index.ts` runs it after each successful daily
 * backup (L9). `events_raw` stays append-only; OPEN-1's `archive-segments`
 * branch is still declared-but-unbuilt and refused loudly.
 *
 * TWO LOADERS. {@link loadRetentionPolicy} is the library loader: it reads the
 * full `DASHBOARD_RETENTION_*` surface, including the acknowledged
 * `token_usage` rule and an explicit backup directory, for tooling that runs
 * the mechanism by hand. Nothing in the server calls it. The server's own
 * policy comes from {@link signedRetentionPolicy}, which is deliberately
 * narrower.
 *
 * THE LIBRARY DEFAULT IS A NO-OP. {@link NO_RETENTION} deletes nothing, ever,
 * and {@link loadRetentionPolicy} returns exactly that for an environment with
 * no `DASHBOARD_RETENTION_*` variable set. The signed policy with both windows
 * at `0` is the same value: `0` is the off switch.
 *
 * EXPRESSIVE, NOT OPINIONATED. The types can express either branch of OPEN-1:
 *  - projections-only deletes (`events`, `token_usage`) - IMPLEMENTED;
 *  - `events_raw` segment archival (`rawEvents: 'archive-segments'`) -
 *    DECLARED but NOT implemented, and rejected loudly rather than silently
 *    ignored, because it needs a schema/migration act this lane may not make.
 * `events_raw` itself is never a delete target under any policy: it is the
 * append-only substrate, enforced by triggers and proven in
 * `test/events-raw.test.ts`, and the prune never issues DML against it.
 *
 * COST HONESTY. `token_usage` is ground truth for every dollar the dashboard
 * reports. A policy that prunes it must set `acknowledgeCostLoss` explicitly,
 * and the prune then refuses to run without a durable journal receipt (see
 * `journal.ts`). The signed v1.0 policy never sets it at all.
 */

/** Rejected policy: unparseable, out of range, or declared-but-not-implemented. */
export class RetentionPolicyError extends Error {
  override readonly name = 'RetentionPolicyError';
}

/**
 * What retention does with `events_raw`.
 *
 *  - `keep-forever`: never touched. The only implemented strategy, and the
 *    only one compatible with the append-only triggers as they stand today.
 *  - `archive-segments`: the audit's recommended OPEN-1 resolution (detach a
 *    closed period to an archive file so removal is a file operation, never
 *    row DML). Expressible here so the decision has a home, but NOT built -
 *    it needs a migration, and configuring it is a loud error, not a no-op.
 */
export type RawEventStrategy = 'keep-forever' | 'archive-segments';

/** Age-based rule for a projection table. */
export interface AgeRule {
  /** Rows whose `occurred_at` is strictly older than this many days expire. */
  readonly maxAgeDays: number;
}

/**
 * Age rule for a COST-BEARING table. `acknowledgeCostLoss` is a deliberate
 * speed bump: pruning `token_usage` permanently lowers every dollar total the
 * dashboard reports for the pruned window, so the operator states in the
 * configuration that they mean it.
 */
export interface CostBearingAgeRule extends AgeRule {
  readonly acknowledgeCostLoss: boolean;
}

/** Age rule for backup FILES on disk (not rows) - `WP-F8` artifacts. */
export interface BackupFileRule {
  readonly directory: string;
  readonly maxAgeDays: number;
  /**
   * Safety floor, not a policy number: however aggressive the window, this
   * many newest backups always survive. Never below 1 - a retention pass that
   * can leave zero backups is a data-loss mechanism, not a retention one.
   */
  readonly keepMinimum: number;
}

export interface RetentionPolicy {
  /** Hook liveness projection. Cost-free: deleting it moves no dollar total. */
  readonly events: AgeRule | null;
  /** Ground-truth priced usage. Cost-bearing - see {@link CostBearingAgeRule}. */
  readonly tokenUsage: CostBearingAgeRule | null;
  /** Append-only raw substrate. See {@link RawEventStrategy}. */
  readonly rawEvents: RawEventStrategy;
  /** Backup files on disk. */
  readonly backupFiles: BackupFileRule | null;
  /**
   * Per-table upper bound on rows a SINGLE run may delete. The run is one
   * transaction, so this is what keeps the write lock bounded on a large
   * database; a run that hits the bound reports `budgetExhausted` and the next
   * run continues from there.
   */
  readonly maxRowsPerRun: number;
}

/** Bound on one run's per-table deletions. A ceiling, not a retention number. */
export const DEFAULT_MAX_ROWS_PER_RUN = 10_000;

/**
 * Upper bound for every `maxAgeDays` window: 100 years. A window becomes a
 * cutoff through `new Date(now - days * MS_PER_DAY).toISOString()`, and a Date
 * beyond +/-8.64e15 ms is invalid, so `toISOString()` throws. With no bound, a
 * window of ~1e8 days loads fine and then fails every run. The row prune runs
 * before the backup-file prune, so that failure also stops a valid backup rule.
 */
export const MAX_RETENTION_DAYS = 36_500;

/** Safety floor for backup pruning. A guard rail, not a retention number. */
export const DEFAULT_BACKUP_KEEP_MINIMUM = 1;

/**
 * Tables retention must never delete from, under any policy.
 *
 * `events_raw` is the append-only substrate (triggers + P0 replay proof).
 * `sessions`, `agents` and `orchestration_edges` are the persisted DAG - the
 * moat artifact and a data fact, never a render-time reconstruction; deleting
 * an agent would also fire `parent_agent_id ON DELETE SET NULL` and silently
 * re-parent a subtree. `model_pricing` and `schema_version` are configuration
 * and provenance.
 */
export const RETENTION_PROTECTED_TABLES: readonly string[] = [
  'events_raw',
  'sessions',
  'agents',
  'orchestration_edges',
  'model_pricing',
  'schema_version',
];

/** The no-op policy: nothing is ever deleted (the library default, not the server's). */
export const NO_RETENTION: RetentionPolicy = {
  events: null,
  tokenUsage: null,
  rawEvents: 'keep-forever',
  backupFiles: null,
  maxRowsPerRun: DEFAULT_MAX_ROWS_PER_RUN,
};

/** True when the policy can delete nothing at all (NO_RETENTION, or every window at 0). */
export function isNoOpPolicy(policy: RetentionPolicy): boolean {
  return policy.events === null && policy.tokenUsage === null && policy.backupFiles === null;
}

/**
 * The three numbers the signed v1.0 policy is made of (D3, 2026-09-08; parsed
 * from the environment by `config.ts`). There is no `token_usage` field on
 * purpose: v1.0 never prunes cost ground truth, so the shape cannot ask for it.
 */
export interface SignedRetentionValues {
  /** `events` rows older than this many days expire; `0` switches the prune off. */
  readonly eventsDays: number;
  /** Backup files older than this many days expire; `0` switches the expiry off. */
  readonly backupDays: number;
  /** The newest N backup files always survive, whatever `backupDays` says. */
  readonly backupKeepMinimum: number;
}

/**
 * Build the policy the server runs (D3), bounded by construction:
 *  - `tokenUsage` is ALWAYS null - no value in `values` can change that, which
 *    makes "token_usage is never pruned" a property of the shape rather than
 *    a configuration habit;
 *  - `rawEvents` is always `keep-forever`;
 *  - each window honours `0` as "off", so `{0, 0, n}` equals
 *    {@link NO_RETENTION} and the runner short-circuits without touching the
 *    database.
 * The result is validated like any other policy, so a floor of `0` or a
 * negative window is refused here, at wiring time, rather than inside a
 * scheduled deletion.
 */
export function signedRetentionPolicy(
  values: SignedRetentionValues,
  backupDirectory: string,
): RetentionPolicy {
  const policy: RetentionPolicy = {
    events: values.eventsDays === 0 ? null : { maxAgeDays: values.eventsDays },
    tokenUsage: null,
    rawEvents: 'keep-forever',
    backupFiles:
      values.backupDays === 0
        ? null
        : {
            directory: backupDirectory,
            maxAgeDays: values.backupDays,
            keepMinimum: values.backupKeepMinimum,
          },
    maxRowsPerRun: DEFAULT_MAX_ROWS_PER_RUN,
  };
  assertRetentionPolicy(policy);
  return policy;
}

/**
 * Validate a policy, throwing {@link RetentionPolicyError} on anything the
 * mechanism cannot honour honestly. Called by the loader AND by the prune, so
 * a hand-built policy object cannot bypass the cost-loss acknowledgement.
 */
export function assertRetentionPolicy(policy: RetentionPolicy): void {
  assertPositiveInt('maxRowsPerRun', policy.maxRowsPerRun);
  if (policy.events !== null) {
    assertDays('events.maxAgeDays', policy.events.maxAgeDays);
  }
  if (policy.tokenUsage !== null) {
    assertDays('tokenUsage.maxAgeDays', policy.tokenUsage.maxAgeDays);
    if (!policy.tokenUsage.acknowledgeCostLoss) {
      throw new RetentionPolicyError(
        'Refusing to prune `token_usage` without acknowledgeCostLoss: those rows are the ' +
          'ground truth behind every reported dollar, and deleting them permanently lowers ' +
          'the totals for the pruned window. Set DASHBOARD_RETENTION_TOKEN_USAGE_ACK_COST_LOSS=1 ' +
          'to state that this is intended.',
      );
    }
  }
  if (policy.rawEvents === 'archive-segments') {
    throw new RetentionPolicyError(
      "Retention strategy 'archive-segments' for events_raw is DECLARED but NOT IMPLEMENTED. " +
        'It is the recommended resolution of OPEN-1 (docs/analysis/open-decisions.md) and ' +
        'needs a schema/migration act plus Ivan\'s ratification. Use "keep-forever" until then; ' +
        'events_raw is append-only and this mechanism never issues DML against it.',
    );
  }
  if (policy.backupFiles !== null) {
    if (policy.backupFiles.directory === '') {
      throw new RetentionPolicyError('backupFiles.directory must not be empty.');
    }
    assertDays('backupFiles.maxAgeDays', policy.backupFiles.maxAgeDays);
    assertPositiveInt('backupFiles.keepMinimum', policy.backupFiles.keepMinimum);
  }
}

/**
 * Build a policy from an environment map.
 *
 * Every variable is optional and an environment with none of them set yields
 * {@link NO_RETENTION} - the no-op default. A variable that IS set but
 * unparseable throws rather than falling back to a default: a typo in a
 * deletion policy must never be interpreted generously.
 */
export function loadRetentionPolicy(env: Record<string, string | undefined>): RetentionPolicy {
  const eventsDays = parseOptionalPositiveInt(
    'DASHBOARD_RETENTION_EVENTS_DAYS',
    env['DASHBOARD_RETENTION_EVENTS_DAYS'],
  );
  const tokenUsageDays = parseOptionalPositiveInt(
    'DASHBOARD_RETENTION_TOKEN_USAGE_DAYS',
    env['DASHBOARD_RETENTION_TOKEN_USAGE_DAYS'],
  );
  const backupDays = parseOptionalPositiveInt(
    'DASHBOARD_RETENTION_BACKUP_DAYS',
    env['DASHBOARD_RETENTION_BACKUP_DAYS'],
  );
  const backupDirectory = env['DASHBOARD_RETENTION_BACKUP_DIR'] ?? '';
  const backupKeepMinimum =
    parseOptionalPositiveInt(
      'DASHBOARD_RETENTION_BACKUP_KEEP_MIN',
      env['DASHBOARD_RETENTION_BACKUP_KEEP_MIN'],
    ) ?? DEFAULT_BACKUP_KEEP_MINIMUM;
  const maxRowsPerRun =
    parseOptionalPositiveInt(
      'DASHBOARD_RETENTION_MAX_ROWS_PER_RUN',
      env['DASHBOARD_RETENTION_MAX_ROWS_PER_RUN'],
    ) ?? DEFAULT_MAX_ROWS_PER_RUN;

  if (backupDays !== null && backupDirectory === '') {
    throw new RetentionPolicyError(
      'DASHBOARD_RETENTION_BACKUP_DAYS is set but DASHBOARD_RETENTION_BACKUP_DIR is not: ' +
        'refusing to guess which directory to delete files from.',
    );
  }

  const policy: RetentionPolicy = {
    events: eventsDays === null ? null : { maxAgeDays: eventsDays },
    tokenUsage:
      tokenUsageDays === null
        ? null
        : {
            maxAgeDays: tokenUsageDays,
            acknowledgeCostLoss: parseFlag(
              'DASHBOARD_RETENTION_TOKEN_USAGE_ACK_COST_LOSS',
              env['DASHBOARD_RETENTION_TOKEN_USAGE_ACK_COST_LOSS'],
            ),
          },
    rawEvents: parseRawEventStrategy(env['DASHBOARD_RETENTION_RAW_EVENTS']),
    backupFiles:
      backupDays === null
        ? null
        : {
            directory: backupDirectory,
            maxAgeDays: backupDays,
            keepMinimum: backupKeepMinimum,
          },
    maxRowsPerRun,
  };
  assertRetentionPolicy(policy);
  return policy;
}

function assertDays(field: string, value: number): void {
  assertPositiveInt(field, value);
  if (value > MAX_RETENTION_DAYS) {
    throw new RetentionPolicyError(
      `Invalid retention ${field} "${String(value)}": expected a positive integer up to ${String(MAX_RETENTION_DAYS)}.`,
    );
  }
}

function assertPositiveInt(field: string, value: number): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new RetentionPolicyError(
      `Invalid retention ${field} "${String(value)}": expected a positive integer.`,
    );
  }
}

function parseOptionalPositiveInt(name: string, raw: string | undefined): number | null {
  if (raw === undefined || raw === '') {
    return null;
  }
  // Digits only, like `parseDigits` in config.ts: Number() alone would accept
  // ' 30', '0x1e', '1e3' and '+5', and silently round past 2^53.
  const value = /^\d+$/.test(raw) ? Number(raw) : Number.NaN;
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RetentionPolicyError(`Invalid ${name} "${raw}": expected a positive integer.`);
  }
  return value;
}

/** Unset/empty/'0'/'false' → false; '1'/'true' → true; anything else is an error. */
function parseFlag(name: string, raw: string | undefined): boolean {
  if (raw === undefined || raw === '' || raw === '0' || raw === 'false') {
    return false;
  }
  if (raw === '1' || raw === 'true') {
    return true;
  }
  throw new RetentionPolicyError(`Invalid ${name} "${raw}": expected 1/true/0/false.`);
}

function parseRawEventStrategy(raw: string | undefined): RawEventStrategy {
  if (raw === undefined || raw === '' || raw === 'keep-forever') {
    return 'keep-forever';
  }
  if (raw === 'archive-segments') {
    // Accepted by the parser so `assertRetentionPolicy` can explain WHY it is
    // refused; a bare "unknown value" error would hide the real reason.
    return 'archive-segments';
  }
  throw new RetentionPolicyError(
    `Invalid DASHBOARD_RETENTION_RAW_EVENTS "${raw}": expected keep-forever or archive-segments.`,
  );
}
