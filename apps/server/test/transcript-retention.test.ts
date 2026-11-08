/**
 * R12 - Claude Code's transcript cleanup (`cleanupPeriodDays`), modelled.
 *
 * Two halves: the boot report reads the setting and warns below the
 * recommended window; and a transcript that vanishes from the corpus never
 * takes its projected rows with it - after the cleanup, the database is the
 * record, so a re-ingest must leave it untouched.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PricingEntry } from '@agenthropic/core';
import { getFixture } from '@agenthropic/test-fixtures';
import { runCorpusIngest } from '../src/corpus/ingest-corpus';
import {
  CLAUDE_DEFAULT_CLEANUP_PERIOD_DAYS,
  claudeSettingsPath,
  readTranscriptRetention,
  RECOMMENDED_CLEANUP_PERIOD_DAYS,
  reportTranscriptRetentionAtBoot,
  transcriptRetentionLine,
} from '../src/corpus/transcript-retention';
import { createMigratedTempDb, type TempDb } from './helpers';

const SETTINGS = '/home/someone/.claude/settings.json';

function enoent(): Error {
  return Object.assign(new Error('ENOENT: no such file'), { code: 'ENOENT' });
}

describe('claudeSettingsPath', () => {
  it('defaults to ~/.claude/settings.json', () => {
    expect(claudeSettingsPath({}, () => '/home/someone')).toBe(SETTINGS);
  });

  it('honours CLAUDE_CONFIG_DIR, ignoring an empty value', () => {
    expect(claudeSettingsPath({ CLAUDE_CONFIG_DIR: '/etc/claude' }, () => '/x')).toBe(
      join('/etc/claude', 'settings.json'),
    );
    expect(claudeSettingsPath({ CLAUDE_CONFIG_DIR: '' }, () => '/home/someone')).toBe(SETTINGS);
  });

  it('falls back to the real home directory', () => {
    expect(claudeSettingsPath({})).toMatch(/\.claude[/\\]settings\.json$/);
  });
});

describe('readTranscriptRetention', () => {
  it('reads a numeric cleanupPeriodDays', () => {
    expect(readTranscriptRetention(SETTINGS, () => '{"cleanupPeriodDays": 99999}')).toEqual({
      source: 'settings',
      settingsPath: SETTINGS,
      days: 99999,
    });
  });

  it('treats a missing file or a missing key as the default', () => {
    expect(
      readTranscriptRetention(SETTINGS, () => {
        throw enoent();
      }),
    ).toEqual({ source: 'default', settingsPath: SETTINGS });
    expect(readTranscriptRetention(SETTINGS, () => '{"model": "x"}')).toEqual({
      source: 'default',
      settingsPath: SETTINGS,
    });
    expect(readTranscriptRetention(SETTINGS, () => 'null')).toEqual({
      source: 'default',
      settingsPath: SETTINGS,
    });
    expect(readTranscriptRetention(SETTINGS, () => '[1]')).toEqual({
      source: 'default',
      settingsPath: SETTINGS,
    });
  });

  it('reports an unreadable file, bad JSON and a non-numeric value', () => {
    expect(
      readTranscriptRetention(SETTINGS, () => {
        throw new Error('EACCES: permission denied');
      }),
    ).toEqual({
      source: 'unreadable',
      settingsPath: SETTINGS,
      detail: 'EACCES: permission denied',
    });
    expect(
      readTranscriptRetention(SETTINGS, () => {
        throw 'weird';
      }),
    ).toEqual({ source: 'unreadable', settingsPath: SETTINGS, detail: 'weird' });
    expect(readTranscriptRetention(SETTINGS, () => '{nope')).toEqual({
      source: 'unreadable',
      settingsPath: SETTINGS,
      detail: 'not valid JSON',
    });
    for (const value of ['"30"', 'null', '1e999']) {
      expect(readTranscriptRetention(SETTINGS, () => `{"cleanupPeriodDays": ${value}}`)).toEqual({
        source: 'unreadable',
        settingsPath: SETTINGS,
        detail: 'cleanupPeriodDays is not a number',
      });
    }
  });

  it('reads the real file system by default', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agenthropic-r12-settings-'));
    try {
      const path = join(dir, 'settings.json');
      expect(readTranscriptRetention(path).source).toBe('default');
      writeFileSync(path, '{"cleanupPeriodDays": 400}');
      expect(readTranscriptRetention(path)).toEqual({
        source: 'settings',
        settingsPath: path,
        days: 400,
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('transcriptRetentionLine', () => {
  it('is an info line at or above the recommended window', () => {
    const result = transcriptRetentionLine({
      source: 'settings',
      settingsPath: SETTINGS,
      days: RECOMMENDED_CLEANUP_PERIOD_DAYS,
    });
    expect(result.warn).toBe(false);
    expect(result.line).toContain(`cleanupPeriodDays=${RECOMMENDED_CLEANUP_PERIOD_DAYS}`);
  });

  it('warns below the window, on the default and when unreadable', () => {
    const low = transcriptRetentionLine({ source: 'settings', settingsPath: SETTINGS, days: 30 });
    expect(low.warn).toBe(true);
    expect(low.line).toContain('older than 30 day(s)');
    expect(low.line).toContain('"cleanupPeriodDays": 99999');

    const unset = transcriptRetentionLine({ source: 'default', settingsPath: SETTINGS });
    expect(unset.warn).toBe(true);
    expect(unset.line).toContain(`default ${CLAUDE_DEFAULT_CLEANUP_PERIOD_DAYS} days`);

    const unreadable = transcriptRetentionLine({
      source: 'unreadable',
      settingsPath: SETTINGS,
      detail: 'not valid JSON',
    });
    expect(unreadable.warn).toBe(true);
    expect(unreadable.line).toContain('(not valid JSON)');
  });
});

describe('reportTranscriptRetentionAtBoot', () => {
  it('logs an info line for a long window and a warning for a short one', () => {
    const log = vi.fn();
    const logWarn = vi.fn();
    const base = { env: {}, homedir: () => '/home/someone', log, logWarn };

    reportTranscriptRetentionAtBoot({ ...base, readFile: () => '{"cleanupPeriodDays": 99999}' });
    expect(log).toHaveBeenCalledTimes(1);
    expect(logWarn).not.toHaveBeenCalled();

    const result = reportTranscriptRetentionAtBoot({ ...base, readFile: () => '{}' });
    expect(result).toEqual({ source: 'default', settingsPath: SETTINGS });
    expect(logWarn).toHaveBeenCalledTimes(1);
  });

  it('defaults to process.env and the console', () => {
    const info = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      reportTranscriptRetentionAtBoot({ readFile: () => '{"cleanupPeriodDays": 1000}' });
      reportTranscriptRetentionAtBoot({ readFile: () => '{"cleanupPeriodDays": 1}' });
      expect(info).toHaveBeenCalledWith(expect.stringContaining('cleanupPeriodDays=1000'));
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('cleanupPeriodDays=1 '));
      reportTranscriptRetentionAtBoot();
    } finally {
      info.mockRestore();
      warn.mockRestore();
    }
  });
});

describe('a vanished transcript keeps its rows', () => {
  const SLUG = '-Users-synthetic-retention-project';
  const PRICING: PricingEntry[] = ['synthetic-model-a', 'synthetic-model-b'].flatMap((model) =>
    (['input', 'output', 'cache_read', 'cache_write_5m', 'cache_write_1h'] as const).map(
      (bucket) => ({
        model,
        bucket,
        usdPerMtok: 1,
        effectiveFrom: '2020-01-01T00:00:00.000Z',
      }),
    ),
  );
  let temp: TempDb | null = null;
  let corpus: string | null = null;

  afterEach(() => {
    temp?.cleanup();
    temp = null;
    if (corpus !== null) {
      rmSync(corpus, { recursive: true, force: true });
      corpus = null;
    }
  });

  function snapshot(db: TempDb['db']): Record<string, unknown[]> {
    return Object.fromEntries(
      ['sessions', 'agents', 'token_usage'].map((table) => [
        table,
        db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all(),
      ]),
    );
  }

  it('re-ingesting after Claude Code deleted the JSONL deletes nothing', () => {
    temp = createMigratedTempDb();
    corpus = mkdtempSync(join(tmpdir(), 'agenthropic-r12-corpus-'));
    const fixture = getFixture('nested-workflow');
    const main = fixture.files.find((f) => !f.relativePath.includes('/'));
    if (main === undefined) {
      throw new Error('nested-workflow has no main transcript; update this test');
    }
    const sessionId = main.relativePath.slice(0, -'.jsonl'.length);
    for (const f of fixture.files) {
      const rel = f.relativePath.includes('/')
        ? join(sessionId, ...f.relativePath.split('/'))
        : f.relativePath;
      const abs = join(corpus, SLUG, rel);
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, f.lines.join('\n') + '\n');
    }
    const deps = { db: temp.db, pricing: PRICING, env: { CLAUDE_PROJECTS_DIR: corpus } };

    expect(runCorpusIngest(deps).sessionsOk).toBe(1);
    const before = snapshot(temp.db);
    expect(before['sessions']).toHaveLength(1);
    expect(before['agents']?.length).toBeGreaterThan(1);
    expect(before['token_usage']?.length).toBeGreaterThan(0);

    // Claude Code's cleanup: the whole session (main + subagent dir) is gone.
    rmSync(join(corpus, SLUG), { recursive: true, force: true });
    mkdirSync(join(corpus, SLUG));

    expect(runCorpusIngest(deps).sessionsDiscovered).toBe(0);
    expect(snapshot(temp.db)).toEqual(before);
  });
});
