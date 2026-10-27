/**
 * AD-2 - the alerts config file: every way it can be wrong stops the boot
 * with a message naming the file and the problem.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadAlertsConfig } from '../src/alerts/load-config';

const VALID = {
  targets: [{ id: 'ops', kind: 'telegram', tokenRef: 'env:ALERT_TOKEN', chatId: '12345' }],
  rules: [{ id: 'spend', kind: 'cost_threshold', targetId: 'ops', thresholdUsd: 5 }],
};

const fromText = (text: string) => (): string => text;

describe('loadAlertsConfig (AD-2)', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'agenthropic-alerts-config-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('reads and returns a valid file from disk', () => {
    const path = join(dir, 'alerts.json');
    writeFileSync(path, JSON.stringify(VALID));
    expect(loadAlertsConfig(path)).toEqual(VALID);
  });

  it('names the errno when the file cannot be read', () => {
    const path = join(dir, 'missing.json');
    expect(() => loadAlertsConfig(path)).toThrow(
      `Invalid alerts config ${path}: cannot be read (ENOENT).`,
    );
  });

  it('falls back to a generic reason for a read error without a code', () => {
    const readFile = (): string => {
      throw new Error('boom');
    };
    expect(() => loadAlertsConfig('/x.json', readFile)).toThrow(
      'Invalid alerts config /x.json: cannot be read (unknown error).',
    );
  });

  it('rejects invalid JSON', () => {
    expect(() => loadAlertsConfig('/x.json', fromText('{ nope'))).toThrow(
      'Invalid alerts config /x.json: not valid JSON.',
    );
  });

  it('quotes schema errors by path, with the root as /', () => {
    expect(() => loadAlertsConfig('/x.json', fromText('42'))).toThrow(
      /^Invalid alerts config \/x\.json: \/ /,
    );
    expect(() =>
      loadAlertsConfig(
        '/x.json',
        fromText(JSON.stringify({ ...VALID, rules: [{ ...VALID.rules[0], thresholdUsd: 0 }] })),
      ),
    ).toThrow(/^Invalid alerts config \/x\.json: \/rules\/0 /);
  });

  it('quotes at most five schema errors and counts the rest', () => {
    const bad = {
      targets: [{ id: 'BAD ID', kind: 'slack', tokenRef: 'plain', chatId: 'x', extra: 1 }],
      rules: 7,
    };
    let message = '';
    try {
      loadAlertsConfig('/x.json', fromText(JSON.stringify(bad)));
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toMatch(/; and \d+ more\.$/);
    expect(message.split('; ').length).toBe(6);
  });

  it('never quotes a value from the file', () => {
    const bad = {
      ...VALID,
      targets: [{ ...VALID.targets[0], tokenRef: 'raw-secret-123456:ABCDEF' }],
    };
    expect(() => loadAlertsConfig('/x.json', fromText(JSON.stringify(bad)))).toThrow(/tokenRef/);
    expect(() => loadAlertsConfig('/x.json', fromText(JSON.stringify(bad)))).not.toThrow(
      /raw-secret/,
    );
  });

  it('rejects cross-reference problems the schema cannot see', () => {
    const bad = { ...VALID, rules: [{ ...VALID.rules[0], targetId: 'nobody' }] };
    expect(() => loadAlertsConfig('/x.json', fromText(JSON.stringify(bad)))).toThrow(
      /^Invalid alerts config \/x\.json: .*nobody.*\.$/,
    );
  });
});
