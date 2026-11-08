/**
 * R12 / ARC-3, OPS-11 - Claude Code's own transcript cleanup, modelled.
 *
 * Claude Code deletes transcripts under `~/.claude/projects` once they are
 * older than its `cleanupPeriodDays` setting (default 30). The projected
 * tables are rebuildable from that corpus only while the files exist: past
 * the window, this database and its backups are the only record of the DAG
 * and the spend, and a later parser or pricing fix cannot be back-applied.
 * Ingest never deletes rows because a transcript vanished - that is pinned in
 * test/transcript-retention.test.ts - so the cleanup costs replayability, not
 * history.
 *
 * The boot report reads the setting from Claude Code's user settings file and
 * says which side of that line the install is on: an info line when the
 * window is at least {@link RECOMMENDED_CLEANUP_PERIOD_DAYS}, a warning
 * otherwise. Read-only, and it never throws: an unreadable file is reported,
 * the server boots regardless.
 */
import { readFileSync } from 'node:fs';
import { homedir as osHomedir } from 'node:os';
import { join } from 'node:path';

/** What Claude Code uses when `cleanupPeriodDays` is not set. */
export const CLAUDE_DEFAULT_CLEANUP_PERIOD_DAYS = 30;

/** Below this, the boot report warns. */
export const RECOMMENDED_CLEANUP_PERIOD_DAYS = 365;

export type TranscriptRetention =
  | { readonly source: 'settings'; readonly settingsPath: string; readonly days: number }
  | { readonly source: 'default'; readonly settingsPath: string }
  | { readonly source: 'unreadable'; readonly settingsPath: string; readonly detail: string };

/** Claude Code's user settings file: `$CLAUDE_CONFIG_DIR/settings.json`, else `~/.claude/settings.json`. */
export function claudeSettingsPath(
  env: Record<string, string | undefined>,
  homedir: () => string = osHomedir,
): string {
  const configDir = env['CLAUDE_CONFIG_DIR'];
  return join(
    configDir === undefined || configDir === '' ? join(homedir(), '.claude') : configDir,
    'settings.json',
  );
}

function isMissingFile(error: unknown): boolean {
  return error instanceof Error && (error as NodeJS.ErrnoException).code === 'ENOENT';
}

/** Read `cleanupPeriodDays` from `settingsPath`; a missing file or key is Claude Code's default. */
export function readTranscriptRetention(
  settingsPath: string,
  readFile: (path: string) => string = (path) => readFileSync(path, 'utf8'),
): TranscriptRetention {
  let text: string;
  try {
    text = readFile(settingsPath);
  } catch (error) {
    if (isMissingFile(error)) {
      return { source: 'default', settingsPath };
    }
    return {
      source: 'unreadable',
      settingsPath,
      detail: error instanceof Error ? error.message : String(error),
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { source: 'unreadable', settingsPath, detail: 'not valid JSON' };
  }
  if (typeof parsed !== 'object' || parsed === null || !('cleanupPeriodDays' in parsed)) {
    return { source: 'default', settingsPath };
  }
  const days = parsed.cleanupPeriodDays;
  if (typeof days !== 'number' || !Number.isFinite(days)) {
    return { source: 'unreadable', settingsPath, detail: 'cleanupPeriodDays is not a number' };
  }
  return { source: 'settings', settingsPath, days };
}

const CONSEQUENCE =
  'past that, this database and its backups are the only record of those sessions. ' +
  'Set "cleanupPeriodDays": 99999 in that file to keep the corpus replayable.';

/** The boot line, and whether it is a warning. */
export function transcriptRetentionLine(retention: TranscriptRetention): {
  readonly warn: boolean;
  readonly line: string;
} {
  const where = retention.settingsPath;
  switch (retention.source) {
    case 'settings':
      if (retention.days >= RECOMMENDED_CLEANUP_PERIOD_DAYS) {
        return {
          warn: false,
          line: `claude transcripts: cleanupPeriodDays=${retention.days} (${where}); the JSONL corpus stays a rebuild source for that long.`,
        };
      }
      return {
        warn: true,
        line: `claude transcripts: cleanupPeriodDays=${retention.days} (${where}) - Claude Code deletes transcripts older than ${retention.days} day(s); ${CONSEQUENCE}`,
      };
    case 'default':
      return {
        warn: true,
        line: `claude transcripts: cleanupPeriodDays not set in ${where} - Claude Code deletes transcripts after its default ${CLAUDE_DEFAULT_CLEANUP_PERIOD_DAYS} days; ${CONSEQUENCE}`,
      };
    case 'unreadable':
      return {
        warn: true,
        line: `claude transcripts: could not read cleanupPeriodDays from ${where} (${retention.detail}); assuming Claude Code's ${CLAUDE_DEFAULT_CLEANUP_PERIOD_DAYS}-day default - ${CONSEQUENCE}`,
      };
  }
}

/** Log the transcript-retention line at boot. Never throws. */
export function reportTranscriptRetentionAtBoot(
  options: {
    readonly env?: Record<string, string | undefined>;
    readonly homedir?: () => string;
    readonly readFile?: (path: string) => string;
    readonly log?: (line: string) => void;
    readonly logWarn?: (line: string) => void;
  } = {},
): TranscriptRetention {
  const retention = readTranscriptRetention(
    claudeSettingsPath(options.env ?? process.env, options.homedir),
    options.readFile,
  );
  const { warn, line } = transcriptRetentionLine(retention);
  if (warn) {
    (options.logWarn ?? console.warn)(line);
  } else {
    (options.log ?? console.log)(line);
  }
  return retention;
}
