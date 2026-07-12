/**
 * Registry + typed loader for the synthetic fixture corpus
 * (parser-spec section 4 join paths + the N3 usage-dedup case).
 */
import { flatToolUse } from './flat-tool-use.js';
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
