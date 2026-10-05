/**
 * Registry + typed loader for the synthetic fixture corpus
 * (parser-spec section 4.1 provenances, gate item 4 depth-2, the N3
 * usage-dedup case, the WP-U10 outcome terminals and the WP-X1 pathologies).
 */
import { agentOutcomeErrors } from './agent-outcome-errors.js';
import { concurrentInstanceA, concurrentInstanceB } from './concurrent-instances.js';
import { crashedNoStop } from './crashed-no-stop.js';
import { depth2Sync } from './depth-2-sync.js';
import { flatToolUse } from './flat-tool-use.js';
import { legacyBareExplore } from './legacy-bare-explore.js';
import { nestedWorkflow } from './nested-workflow.js';
import { queueOperation } from './queue-operation.js';
import { taskNotificationRecovery } from './task-notification-recovery.js';
import { FIXTURE_NAMES, type Fixture, type FixtureName } from './types.js';
import { usageDedup } from './usage-dedup.js';

const REGISTRY: Readonly<Record<FixtureName, Fixture>> = {
  'flat-tool-use': flatToolUse,
  'nested-workflow': nestedWorkflow,
  'task-notification-recovery': taskNotificationRecovery,
  'queue-operation': queueOperation,
  'usage-dedup': usageDedup,
  'depth-2-sync': depth2Sync,
  'legacy-bare-explore': legacyBareExplore,
  'agent-outcome-errors': agentOutcomeErrors,
  'crashed-no-stop': crashedNoStop,
  'concurrent-instance-a': concurrentInstanceA,
  'concurrent-instance-b': concurrentInstanceB,
};

/** All fixture names, in a stable order. */
export function listFixtures(): readonly FixtureName[] {
  return FIXTURE_NAMES;
}

/** Load one fixture by name; throws on an unknown name. */
export function getFixture(name: FixtureName): Fixture {
  const fixture = REGISTRY[name];
  if (fixture === undefined) {
    throw new Error(`Unknown fixture: ${String(name)}. Known: ${FIXTURE_NAMES.join(', ')}`);
  }
  return fixture;
}

export { FIXTURE_NAMES } from './types.js';
export type { Fixture, FixtureFile, FixtureName } from './types.js';
export { EVICTED_TOOL_USE_ID, TASK_ID } from './task-notification-recovery.js';
export { QUEUED_TASK_ID, QUEUED_TOOL_USE_ID } from './queue-operation.js';
export { DUPLICATED_MESSAGE_ID } from './usage-dedup.js';
export { LEGACY_CHILD_HEX, LEGACY_DECOY_HEX } from './legacy-bare-explore.js';
export {
  INTERRUPT_TOOL_USE_ID,
  TERMINATED_EARLY_AGENT_ID,
  TERMINATED_TOOL_USE_ID,
  USER_INTERRUPT_AGENT_ID,
} from './agent-outcome-errors.js';
export {
  CRASHED_AGENT_ID,
  CRASHED_PENDING_TOOL_USE_ID,
  CRASHED_SPAWN_TOOL_USE_ID,
} from './crashed-no-stop.js';
export {
  CONCURRENT_A_AGENT_ID,
  CONCURRENT_A_SESSION_ID,
  CONCURRENT_B_AGENT_ID,
  CONCURRENT_B_SESSION_ID,
  CONCURRENT_CWD,
} from './concurrent-instances.js';
export { PATHOLOGY_MANIFEST, WP_X1_PATHOLOGIES, checkPathologyManifest } from './pathologies.js';
export type { Pathology, PathologyEntry, PathologyManifest } from './pathologies.js';
