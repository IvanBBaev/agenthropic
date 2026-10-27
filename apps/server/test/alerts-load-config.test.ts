/**
 * AD-2 - the alerts config file: every way it can be wrong stops the boot
 * with a message naming the file and the problem.
 */
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadAlertsConfig } from '../src/alerts/load-config';

const VALID = {
  targets: [{ id: 'ops', kind: 'telegram', tokenRef: 'env:ALERT_TOKEN', chatId: '12345' }],
  rules: [{ id: 'spend', kind: 'cost_threshold', targetId: 'ops', thresholdUsd: 5 }],
};

const fromText = (text: string) => (): string => text;

/** A root-owned 0644 regular file: passes the ownership check on any uid. */
const okStat = (): { uid: number; mode: number } => ({ uid: 0, mode: 0o100644 });

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
    expect(() => loadAlertsConfig('/x.json', readFile, okStat)).toThrow(
      'Invalid alerts config /x.json: cannot be read (unknown error).',
    );
  });

  it('rejects invalid JSON', () => {
    expect(() => loadAlertsConfig('/x.json', fromText('{ nope'), okStat)).toThrow(
      'Invalid alerts config /x.json: not valid JSON.',
    );
  });

  it('quotes schema errors by path, with the root as /', () => {
    expect(() => loadAlertsConfig('/x.json', fromText('42'), okStat)).toThrow(
      /^Invalid alerts config \/x\.json: \/ /,
    );
    expect(() =>
      loadAlertsConfig(
        '/x.json',
        fromText(JSON.stringify({ ...VALID, rules: [{ ...VALID.rules[0], thresholdUsd: 0 }] })),
        okStat,
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
      loadAlertsConfig('/x.json', fromText(JSON.stringify(bad)), okStat);
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
    expect(() => loadAlertsConfig('/x.json', fromText(JSON.stringify(bad)), okStat)).toThrow(
      /tokenRef/,
    );
    expect(() => loadAlertsConfig('/x.json', fromText(JSON.stringify(bad)), okStat)).not.toThrow(
      /raw-secret/,
    );
  });

  it('refuses a config file group or other can rewrite (AU, 2026-10-27)', () => {
    // The file picks the chat and the secret alerts are sent with, so a file
    // another local user can rewrite could redirect every alert to them.
    const path = join(dir, 'alerts.json');
    writeFileSync(path, JSON.stringify(VALID));
    for (const mode of [0o666, 0o664, 0o646, 0o620]) {
      chmodSync(path, mode);
      const shown = mode.toString(8);
      expect(() => loadAlertsConfig(path)).toThrow(
        `Invalid alerts config ${path}: mode ${shown} lets group/other rewrite it ` +
          '(use chmod 644 or 600).',
      );
    }
    for (const mode of [0o644, 0o600, 0o444]) {
      chmodSync(path, mode);
      expect(loadAlertsConfig(path)).toEqual(VALID);
    }
  });

  it('refuses a config file owned by another non-root user', () => {
    const owned = (uid: number) => (): { uid: number; mode: number } => ({ uid, mode: 0o100644 });
    const text = fromText(JSON.stringify(VALID));
    expect(() => loadAlertsConfig('/x.json', text, owned(502), 501)).toThrow(
      'Invalid alerts config /x.json: is not owned by the server user or root.',
    );
    expect(loadAlertsConfig('/x.json', text, owned(501), 501)).toEqual(VALID);
    expect(loadAlertsConfig('/x.json', text, owned(0), 501)).toEqual(VALID);
    // No POSIX uid (not a supported host, but never a crash): ownership is not judged.
    expect(loadAlertsConfig('/x.json', text, owned(502), null)).toEqual(VALID);
  });

  it('checks ownership before it reads the file', () => {
    let reads = 0;
    const readFile = (): string => {
      reads += 1;
      return JSON.stringify(VALID);
    };
    expect(() => loadAlertsConfig('/x.json', readFile, () => ({ uid: 0, mode: 0o100666 }))).toThrow(
      /mode 666/,
    );
    expect(reads).toBe(0);
  });

  it('skips the ownership check by default where the platform has no process uid', () => {
    const original = process.getuid;
    Object.defineProperty(process, 'getuid', {
      value: undefined,
      configurable: true,
      writable: true,
    });
    try {
      const foreign = (): { uid: number; mode: number } => ({ uid: 4242, mode: 0o100644 });
      expect(loadAlertsConfig('/x.json', fromText(JSON.stringify(VALID)), foreign)).toEqual(VALID);
    } finally {
      Object.defineProperty(process, 'getuid', {
        value: original,
        configurable: true,
        writable: true,
      });
    }
  });

  it('rejects cross-reference problems the schema cannot see', () => {
    const bad = { ...VALID, rules: [{ ...VALID.rules[0], targetId: 'nobody' }] };
    expect(() => loadAlertsConfig('/x.json', fromText(JSON.stringify(bad)), okStat)).toThrow(
      /^Invalid alerts config \/x\.json: .*nobody.*\.$/,
    );
  });
});
