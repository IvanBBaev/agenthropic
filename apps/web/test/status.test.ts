/**
 * Status vocabulary tests (WP-U6..U9): unknown is first-class, color is
 * never the sole channel, and an unrecorded (null) status is distinct from
 * the watchdog's 'unknown'.
 */
import { describe, expect, it } from 'vitest';
import {
  ABSENT_STATUS_META,
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

/**
 * Red-team honesty wave (2026-09-07), SV-3. `statusMeta` is the last honest
 * stop for a status value: the api-layer guards check containers and
 * load-bearing numbers and deliberately do NOT check strings, so an omitted
 * `status` field arrives here as `undefined` and gets rendered.
 */
describe('statusMeta - absent status (SV-3)', () => {
  it('reports an absent status as absent, never as the word "undefined"', () => {
    const meta = statusMeta(undefined);
    expect(meta.label).not.toContain('undefined');
    expect(meta.label).toContain('no status word');
    // Still the unrecognised glyph, which the shell legend already explains:
    // this build cannot map what it got onto the vocabulary.
    expect(meta.symbol).toBe('?');
    expect(meta).toBe(ABSENT_STATUS_META);
    // Three different absences, three different words: nothing was recorded
    // (null), nothing arrived (absent), something arrived that this build
    // cannot read (unrecognised word).
    expect(ABSENT_STATUS_META).not.toBe(NULL_STATUS_META);
  });

  it('keeps reporting an unknown status WORD with its raw value', () => {
    expect(statusMeta('zombie').label).toBe('unrecognised (zombie)');
  });
});
