/**
 * Status vocabulary tests (WP-U6..U9): unknown is first-class, color is
 * never the sole channel, and an unrecorded (null) status is distinct from
 * the watchdog's 'unknown'.
 */
import { describe, expect, it } from 'vitest';
import {
  AGENT_STATUSES,
  isAgentStatus,
  NULL_STATUS_META,
  STATUS_META,
  statusMeta,
} from '../src/views/status';

describe('AGENT_STATUSES', () => {
  it('lists all five persisted statuses including unknown', () => {
    expect(AGENT_STATUSES).toEqual(['working', 'waiting', 'completed', 'error', 'unknown']);
  });
});

describe('isAgentStatus', () => {
  it('accepts every listed status and rejects everything else', () => {
    for (const status of AGENT_STATUSES) expect(isAgentStatus(status)).toBe(true);
    expect(isAgentStatus('done')).toBe(false);
    expect(isAgentStatus(null)).toBe(false);
    expect(isAgentStatus(3)).toBe(false);
  });
});

describe('STATUS_META', () => {
  it('pairs every status with a symbol AND a label - color never alone', () => {
    for (const status of AGENT_STATUSES) {
      const meta = STATUS_META[status];
      expect(meta.symbol.length).toBeGreaterThan(0);
      expect(meta.label.length).toBeGreaterThan(0);
      expect(meta.className.startsWith('status-')).toBe(true);
    }
  });
});

describe('statusMeta', () => {
  it('maps a persisted status to its meta', () => {
    expect(statusMeta('unknown')).toBe(STATUS_META.unknown);
  });

  it('maps null to the distinct unrecorded meta, not to unknown', () => {
    expect(statusMeta(null)).toBe(NULL_STATUS_META);
    expect(NULL_STATUS_META.label).toBe('unrecorded');
    expect(NULL_STATUS_META).not.toBe(STATUS_META.unknown);
  });
});
