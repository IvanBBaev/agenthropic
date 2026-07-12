/**
 * Self-testing manifest for the synthetic fixture corpus (WP-X1 spirit):
 * every fixture loads, every line is valid JSON, and the structural anchor
 * ids actually cross-match between parent-side and child-side files.
 */
import { describe, expect, it } from 'vitest';
import {
  DUPLICATED_MESSAGE_ID,
  EVICTED_TOOL_USE_ID,
  FIXTURE_NAMES,
  QUEUED_TASK_ID,
  QUEUED_TOOL_USE_ID,
  TASK_ID,
  getFixture,
  listFixtures,
  type Fixture,
  type FixtureName,
} from '../src/index';

// Fixture lines are schemaless JSON; tests navigate them dynamically.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = Record<string, any>;

function parsedLines(fixture: Fixture, relativePath: string): Json[] {
  const file = fixture.files.find((f) => f.relativePath === relativePath);
  if (!file) {
    throw new Error(`Fixture ${fixture.name} has no file ${relativePath}`);
  }
  return file.lines.map((line) => JSON.parse(line) as Json);
}

function mainTranscript(fixture: Fixture): Json[] {
  const file = fixture.files.find((f) => /^[0-9a-f-]{36}\.jsonl$/.test(f.relativePath));
  if (!file) {
    throw new Error(`Fixture ${fixture.name} has no main transcript`);
  }
  return file.lines.map((line) => JSON.parse(line) as Json);
}

/** All tool_use blocks across a transcript's assistant messages. */
function toolUseBlocks(lines: Json[]): Json[] {
  return lines.flatMap((record) =>
    Array.isArray(record.message?.content)
      ? record.message.content.filter((block: Json) => block.type === 'tool_use')
      : [],
  );
}

function agentHexFromPath(relativePath: string): string {
  const match = /agent-([0-9a-f]+)\.jsonl$/.exec(relativePath);
  if (!match) throw new Error(`Not an agent file path: ${relativePath}`);
  return match[1]!;
}

describe('fixture manifest', () => {
  it('lists exactly the five expected fixtures', () => {
    expect([...listFixtures()]).toEqual([
      'flat-tool-use',
      'nested-workflow',
      'task-notification-recovery',
      'queue-operation',
      'usage-dedup',
    ]);
  });

  it('throws on an unknown fixture name', () => {
    expect(() => getFixture('no-such-fixture' as FixtureName)).toThrow(/Unknown fixture/);
  });

  it.each([...FIXTURE_NAMES])('%s loads, has files, and every line is valid JSON', (name) => {
    const fixture = getFixture(name);
    expect(fixture.name).toBe(name);
    expect(fixture.description.length).toBeGreaterThan(0);
    expect(fixture.files.length).toBeGreaterThan(0);
    for (const file of fixture.files) {
      expect(file.lines.length).toBeGreaterThan(0);
      for (const line of file.lines) {
        expect(() => JSON.parse(line)).not.toThrow();
      }
    }
  });
});

describe('flat-tool-use (base join path 1)', () => {
  const fixture = getFixture('flat-tool-use');

  it('anchors the parent tool_use id to the child inline agentId and meta.toolUseId', () => {
    const blocks = toolUseBlocks(mainTranscript(fixture));
    expect(blocks).toHaveLength(1);
    const spawn = blocks[0]!;
    expect(spawn.name).toBe('Agent');
    expect(spawn.id).toMatch(/^toolu_/);

    const childFile = fixture.files.find(
      (f) => f.relativePath.endsWith('.jsonl') && f.relativePath.includes('agent-'),
    )!;
    const child = parsedLines(fixture, childFile.relativePath);
    const hex = agentHexFromPath(childFile.relativePath);
    for (const record of child) {
      expect(record.agentId).toBe(hex);
    }
    expect(child[0]!.meta.toolUseId).toBe(spawn.id);

    const meta = parsedLines(fixture, childFile.relativePath.replace('.jsonl', '.meta.json'))[0]!;
    expect(meta.agentId).toBe(hex);
    expect(meta.toolUseId).toBe(spawn.id);
  });

  it('carries the anchor id in prose too (substring joins must be impossible, gate #5)', () => {
    const lines = mainTranscript(fixture);
    const spawnId = toolUseBlocks(lines)[0]!.id as string;
    const proseMentions = lines.flatMap((record) =>
      Array.isArray(record.message?.content)
        ? record.message.content.filter(
            (block: Json) => block.type === 'text' && String(block.text).includes(spawnId),
          )
        : [],
    );
    expect(proseMentions.length).toBeGreaterThan(0);
  });
});

describe('nested-workflow (base join path 2)', () => {
  const fixture = getFixture('nested-workflow');
  const journalPath = fixture.files.find((f) =>
    f.relativePath.endsWith('journal.jsonl'),
  )!.relativePath;
  const workflowDir = journalPath.replace(/\/journal\.jsonl$/, '');

  it('directory-anchors both agents under the same wf_ dir as the journal', () => {
    const agentFiles = fixture.files.filter((f) => /agent-[0-9a-f]+\.jsonl$/.test(f.relativePath));
    expect(agentFiles).toHaveLength(2);
    expect(workflowDir).toMatch(/^workflows\/wf_[0-9a-f]+$/);
    for (const file of agentFiles) {
      expect(file.relativePath.startsWith(`${workflowDir}/`)).toBe(true);
    }
  });

  it('journal started lines cross-match agent file hex, inline agentId, and one shared promptId', () => {
    const journal = parsedLines(fixture, journalPath);
    expect(journal.every((entry) => entry.type === 'started')).toBe(true);

    const promptIds = new Set(journal.map((entry) => entry.promptId));
    expect(promptIds.size).toBe(1); // promptId is a batch key, not an ordinal (EMP-1)

    const agentFiles = fixture.files.filter((f) => /agent-[0-9a-f]+\.jsonl$/.test(f.relativePath));
    const journalAgents = journal.map((entry) => entry.agentId as string).sort();
    const fileAgents = agentFiles.map((f) => agentHexFromPath(f.relativePath)).sort();
    expect(journalAgents).toEqual(fileAgents);

    for (const file of agentFiles) {
      const hex = agentHexFromPath(file.relativePath);
      const first = parsedLines(fixture, file.relativePath)[0]!;
      expect(first.agentId).toBe(hex);
      expect(first.parentUuid).toBeNull(); // first nested record has no parentUuid (spec 6.3)
      expect(first.meta.promptId).toBe([...promptIds][0]);
    }
  });

  it('siblings start within the same dispatch wave (< 10 ms apart)', () => {
    const agentFiles = fixture.files.filter((f) => /agent-[0-9a-f]+\.jsonl$/.test(f.relativePath));
    const starts = agentFiles
      .map((f) => Date.parse(parsedLines(fixture, f.relativePath)[0]!.timestamp as string))
      .sort((a, b) => a - b);
    expect(starts[1]! - starts[0]!).toBeLessThan(10);
  });
});

describe('task-notification-recovery (recovery path N1)', () => {
  const fixture = getFixture('task-notification-recovery');

  it('child-side <task-notification> tags carry the evicted tool-use id and task id', () => {
    const childFile = fixture.files.find((f) => f.relativePath.includes('agent-'))!;
    const first = parsedLines(fixture, childFile.relativePath)[0]!;
    const content = first.message.content as string;
    expect(content).toContain(`<tool-use-id>${EVICTED_TOOL_USE_ID}</tool-use-id>`);
    expect(content).toContain(`<task-id>${TASK_ID}</task-id>`);
    expect(first.meta.toolUseId).toBe(EVICTED_TOOL_USE_ID);
  });

  it('the parent-side tool_use block is genuinely absent (evicted by compaction)', () => {
    const lines = mainTranscript(fixture);
    const spawnIds = toolUseBlocks(lines).map((block) => block.id);
    expect(spawnIds).not.toContain(EVICTED_TOOL_USE_ID);
    expect(spawnIds).toHaveLength(0);
    expect(lines.some((record) => record.subtype === 'compact_boundary')).toBe(true);
  });
});

describe('queue-operation (recovery path N2)', () => {
  const fixture = getFixture('queue-operation');

  it('the queue-operation record tags cross-match the child meta.toolUseId/taskId', () => {
    const lines = mainTranscript(fixture);
    const queueRecord = lines.find((record) => record.type === 'queue-operation')!;
    expect(queueRecord).toBeDefined();
    expect(queueRecord.content).toContain(`<tool-use-id>${QUEUED_TOOL_USE_ID}</tool-use-id>`);
    expect(queueRecord.content).toContain(`<task-id>${QUEUED_TASK_ID}</task-id>`);

    const childFile = fixture.files.find((f) => f.relativePath.includes('agent-'))!;
    const first = parsedLines(fixture, childFile.relativePath)[0]!;
    expect(first.meta.toolUseId).toBe(QUEUED_TOOL_USE_ID);
    expect(first.meta.taskId).toBe(QUEUED_TASK_ID);
    expect(first.agentId).toBe(agentHexFromPath(childFile.relativePath));
  });

  it('no parent tool_use block exists for the backgrounded spawn', () => {
    expect(toolUseBlocks(mainTranscript(fixture))).toHaveLength(0);
  });
});

describe('usage-dedup (correctness gate N3)', () => {
  const fixture = getFixture('usage-dedup');
  const childFile = fixture.files[0]!;
  const lines = parsedLines(fixture, childFile.relativePath);

  it('has 6 usage-bearing lines but only 4 distinct message.ids across 2 models', () => {
    expect(lines).toHaveLength(6);
    expect(lines.every((record) => record.message?.usage !== undefined)).toBe(true);
    expect(new Set(lines.map((record) => record.message.id)).size).toBe(4);
    expect(new Set(lines.map((record) => record.message.model)).size).toBe(2);
  });

  it('the 3 lines sharing one message.id carry byte-identical usage blocks', () => {
    const duplicates = lines.filter((record) => record.message.id === DUPLICATED_MESSAGE_ID);
    expect(duplicates).toHaveLength(3);
    const serialized = duplicates.map((record) => JSON.stringify(record.message.usage));
    expect(new Set(serialized).size).toBe(1);
  });

  it('includes cache_read-heavy buckets on both models', () => {
    const heavyModels = new Set(
      lines
        .filter(
          (record) =>
            record.message.usage.cache_read_input_tokens > record.message.usage.input_tokens,
        )
        .map((record) => record.message.model),
    );
    expect(heavyModels.size).toBe(2);
  });

  it('attributes every row to the enclosing agent-<hex> filename (spec 5.1 hard key)', () => {
    const hex = agentHexFromPath(childFile.relativePath);
    expect(lines.every((record) => record.agentId === hex)).toBe(true);
  });
});
