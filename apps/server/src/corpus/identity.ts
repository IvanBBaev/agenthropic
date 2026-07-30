/**
 * WP-IN5 instance / host identity. Orchestration edges are stamped with the
 * host they were observed on (`hostId`) and the logical dashboard instance
 * (`instance`) so a future multi-machine merge can attribute rows. `hostId` is
 * always the OS hostname; `instance` overrides it via `DASHBOARD_INSTANCE` when
 * one physical host runs more than one logical instance, else mirrors it.
 */
import { hostname } from 'node:os';

export interface Identity {
  readonly instance: string;
  readonly hostId: string;
}

export function resolveIdentity(env: Record<string, string | undefined>): Identity {
  const hostId = hostname();
  const instance = env.DASHBOARD_INSTANCE ?? hostId;
  return { instance, hostId };
}
