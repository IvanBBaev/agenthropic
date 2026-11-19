/**
 * The boot-time retention dry-run report.
 *
 * Moved out of the composition root `index.ts` (ARC-4, 2026-11-19), which
 * re-exports it; `index.ts` keeps only the wiring in `start()`.
 */
import type { RetentionPort } from '../retention/port';
import { describeRetentionPolicy, retentionRunLine } from '../retention/summary';

/**
 * Boot-time retention report (L9): one info line saying what the signed policy
 * is and what it WOULD prune right now. A dry run by construction - nothing is
 * deleted at boot; the first real pass is the first daily cycle, after its
 * backup. Never throws: an assessment that fails is logged as an error and the
 * server boots regardless.
 */
export function reportRetentionAtBoot(
  retention: RetentionPort,
  options: {
    readonly now?: () => Date;
    readonly log?: (line: string) => void;
    readonly logError?: (line: string) => void;
  } = {},
): void {
  const now = options.now ?? (() => new Date());
  const log = options.log ?? console.log;
  const logError = options.logError ?? console.error;
  try {
    const report = retention.run({ now: now(), dryRun: true });
    log(
      `retention policy: ${describeRetentionPolicy(retention.policy)}. ${retentionRunLine(report)}`,
    );
  } catch (error) {
    logError(`retention dry run failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}
