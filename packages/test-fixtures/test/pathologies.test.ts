/**
 * WP-X1 pathology manifest self-test (owner decision D14(a), 2026-09-30):
 * every one of the four hostile pathologies of parser-spec section 1 is
 * represented by at least one shipped fixture, every manifest entry names a
 * fixture that exists, and each named fixture structurally exhibits the
 * pathology it is filed under.
 */
import { describe, expect, it } from 'vitest';
import {
  CONCURRENT_A_AGENT_ID,
  CONCURRENT_A_SESSION_ID,
  CONCURRENT_B_AGENT_ID,
  CONCURRENT_B_SESSION_ID,
  CONCURRENT_CWD,
  CRASHED_AGENT_ID,
  CRASHED_PENDING_TOOL_USE_ID,
  CRASHED_SPAWN_TOOL_USE_ID,
  FIXTURE_NAMES,
  PATHOLOGY_MANIFEST,
  WP_X1_PATHOLOGIES,
  checkPathologyManifest,
  getFixture,
  type Fixture,
  type FixtureName,
} from '../src/index';

// Fixture lines are schemaless JSON; tests navigate them dynamically.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = Record<string, any>;

const MAIN_TRANSCRIPT = /^[0-9a-f-]{36}\.jsonl$/;
const AGENT_TRANSCRIPT = /agent-([0-9a-f]+)\.jsonl$/;

function linesOf(fixture: Fixture, test: (path: string) => boolean): Json[] {
  return fixture.files
    .filter((file) => test(file.relativePath))
    .flatMap((file) => file.lines.map((line) => JSON.parse(line) as Json));
}

function mainTranscript(name: FixtureName): Json[] {
  return linesOf(getFixture(name), (path) => MAIN_TRANSCRIPT.test(path));
}

function allRecords(name: FixtureName): Json[] {
  return linesOf(getFixture(name), (path) => path.endsWith('.jsonl'));
}

function blocks(record: Json, type: string): Json[] {
  const content: unknown = record.message?.content;
  return Array.isArray(content) ? (content as Json[]).filter((block) => block.type === type) : [];
}

function answeredToolUseIds(records: Json[]): Set<string> {
  return new Set(
    records.flatMap((record) => blocks(record, 'tool_result').map((b) => String(b.tool_use_id))),
  );
}

function agentHexes(name: FixtureName): string[] {
  return getFixture(name)
    .files.map((file) => AGENT_TRANSCRIPT.exec(file.relativePath)?.[1])
    .filter((hex): hex is string => hex !== undefined);
}

function timeSpan(name: FixtureName): { start: number; end: number; times: number[] } {
  const times = allRecords(name)
    .map((record) => record.timestamp as string | undefined)
    .filter((t): t is string => t !== undefined)
    .map((t) => Date.parse(t));
  return { start: Math.min(...times), end: Math.max(...times), times };
}

describe('pathology manifest', () => {
  it('covers exactly the four WP-X1 pathologies', () => {
    expect([...WP_X1_PATHOLOGIES]).toEqual([
      'post-compaction-eviction',
      'crashed-no-stop',
      'same-slug-concurrency',
      'dual-layout-depth-2',
    ]);
    expect(Object.keys(PATHOLOGY_MANIFEST).sort()).toEqual([...WP_X1_PATHOLOGIES].sort());
  });

  it('has no issue against the shipped registry', () => {
    expect(checkPathologyManifest(PATHOLOGY_MANIFEST)).toEqual([]);
    expect(checkPathologyManifest(PATHOLOGY_MANIFEST, FIXTURE_NAMES)).toEqual([]);
  });

  it.each([...WP_X1_PATHOLOGIES])('%s names at least one shipped fixture', (pathology) => {
    const entry = PATHOLOGY_MANIFEST[pathology];
    expect(entry.description.length).toBeGreaterThan(0);
    expect(entry.fixtures.length).toBeGreaterThan(0);
    for (const fixture of entry.fixtures) {
      expect(FIXTURE_NAMES).toContain(fixture);
    }
  });

  it('flags a pathology that is absent from the manifest', () => {
    const rest: Partial<Record<string, { readonly fixtures: readonly string[] }>> = {
      ...PATHOLOGY_MANIFEST,
    };
    delete rest['crashed-no-stop'];
    expect(checkPathologyManifest(rest)).toEqual(['pathology "crashed-no-stop" has no fixture']);
  });

  it('flags a pathology whose fixture list is empty', () => {
    expect(
      checkPathologyManifest({
        ...PATHOLOGY_MANIFEST,
        'same-slug-concurrency': { fixtures: [] },
      }),
    ).toEqual(['pathology "same-slug-concurrency" has no fixture']);
  });

  it('flags an entry that names a fixture the registry does not ship', () => {
    expect(
      checkPathologyManifest({
        ...PATHOLOGY_MANIFEST,
        'dual-layout-depth-2': { fixtures: ['depth-2-sync', 'no-such-fixture'] },
      }),
    ).toEqual(['pathology "dual-layout-depth-2" names missing fixture "no-such-fixture"']);
  });

  it('flags a manifest fixture that was dropped from the registry', () => {
    const shrunk = FIXTURE_NAMES.filter((name) => name !== 'concurrent-instance-b');
    expect(checkPathologyManifest(PATHOLOGY_MANIFEST, shrunk)).toEqual([
      'pathology "same-slug-concurrency" names missing fixture "concurrent-instance-b"',
    ]);
  });

  it('keeps every fixture free of real home-directory paths', () => {
    for (const name of FIXTURE_NAMES) {
      for (const file of getFixture(name).files) {
        expect(file.relativePath).not.toContain('/Users/');
        for (const line of file.lines) {
          expect(line).not.toContain('/Users/');
        }
      }
    }
  });
});

describe('post-compaction-eviction fixtures', () => {
  it.each([...PATHOLOGY_MANIFEST['post-compaction-eviction'].fixtures])(
    '%s carries a compact_boundary record',
    (name) => {
      expect(mainTranscript(name).some((r) => r.subtype === 'compact_boundary')).toBe(true);
    },
  );
});

describe('crashed-no-stop (WP-X1 live-crash / no-Stop)', () => {
  const fixture = getFixture('crashed-no-stop');
  const main = mainTranscript('crashed-no-stop');
  const child = linesOf(fixture, (path) => path === `subagents/agent-${CRASHED_AGENT_ID}.jsonl`);
  const meta = linesOf(
    fixture,
    (path) => path === `subagents/agent-${CRASHED_AGENT_ID}.meta.json`,
  )[0]!;

  it('is filed under the crashed-no-stop pathology', () => {
    expect(PATHOLOGY_MANIFEST['crashed-no-stop'].fixtures).toContain('crashed-no-stop');
  });

  it('ends the main transcript on the spawn block, which is never answered', () => {
    const last = main.at(-1)!;
    expect(last.type).toBe('assistant');
    const spawn = blocks(last, 'tool_use');
    expect(spawn.map((b) => [b.id, b.name])).toEqual([[CRASHED_SPAWN_TOOL_USE_ID, 'Agent']]);
    expect(answeredToolUseIds(main).has(CRASHED_SPAWN_TOOL_USE_ID)).toBe(false);
  });

  it('anchors the child to the unanswered spawn via its sidecar', () => {
    expect(meta.toolUseId).toBe(CRASHED_SPAWN_TOOL_USE_ID);
    expect(meta.spawnDepth).toBe(1);
    expect(child.every((r) => r.agentId === CRASHED_AGENT_ID)).toBe(true);
  });

  it('ends the child transcript mid-turn on an unanswered tool call', () => {
    const last = child.at(-1)!;
    expect(last.type).toBe('assistant');
    expect(blocks(last, 'tool_use').map((b) => b.id)).toEqual([CRASHED_PENDING_TOOL_USE_ID]);
    expect(answeredToolUseIds(child).has(CRASHED_PENDING_TOOL_USE_ID)).toBe(false);
  });

  it('writes no stop or terminal marker and no error result anywhere', () => {
    const records = allRecords('crashed-no-stop');
    for (const record of records) {
      expect(JSON.stringify(record)).not.toMatch(/"(Stop|SubagentStop)"|stop_hook/);
      expect(record.message?.stop_reason ?? 'tool_use').toBe('tool_use');
      for (const result of blocks(record, 'tool_result')) {
        expect(result.is_error).toBeUndefined();
      }
    }
  });
});

describe('same-slug-concurrency (WP-X1 two concurrent instances)', () => {
  const pair = PATHOLOGY_MANIFEST['same-slug-concurrency'].fixtures;
  const a = mainTranscript('concurrent-instance-a');
  const b = mainTranscript('concurrent-instance-b');

  it('is represented by the A/B pair', () => {
    expect([...pair]).toEqual(['concurrent-instance-a', 'concurrent-instance-b']);
  });

  it('shares one project directory (one slug) across both instances', () => {
    for (const name of pair) {
      const cwds = new Set(
        allRecords(name)
          .map((r) => r.cwd as string | undefined)
          .filter((c) => c !== undefined),
      );
      expect([...cwds]).toEqual([CONCURRENT_CWD]);
    }
  });

  it('keeps session uuids, agent hexes, tool_use ids and message ids disjoint', () => {
    expect(new Set(a.map((r) => r.sessionId))).toEqual(new Set([CONCURRENT_A_SESSION_ID]));
    expect(new Set(b.map((r) => r.sessionId))).toEqual(new Set([CONCURRENT_B_SESSION_ID]));
    expect(agentHexes('concurrent-instance-a')).toEqual([CONCURRENT_A_AGENT_ID]);
    expect(agentHexes('concurrent-instance-b')).toEqual([CONCURRENT_B_AGENT_ID]);
    const ids = (name: FixtureName): Set<string> =>
      new Set(
        allRecords(name).flatMap((r) => [
          String(r.uuid),
          ...(r.message?.id === undefined ? [] : [String(r.message.id)]),
          ...blocks(r, 'tool_use').map((block) => String(block.id)),
        ]),
      );
    const idsB = ids('concurrent-instance-b');
    expect([...ids('concurrent-instance-a')].filter((id) => idsB.has(id))).toEqual([]);
  });

  it('interleaves the two sessions in wall-clock time', () => {
    const spanA = timeSpan('concurrent-instance-a');
    const spanB = timeSpan('concurrent-instance-b');
    // Overlapping lifetimes, and each session has a record inside the other's span.
    expect(spanA.start).toBeLessThan(spanB.end);
    expect(spanB.start).toBeLessThan(spanA.end);
    expect(spanA.times.some((t) => t > spanB.start && t < spanB.end)).toBe(true);
    expect(spanB.times.some((t) => t > spanA.start && t < spanA.end)).toBe(true);
  });

  it('issues look-alike spawns inside one dispatch wave', () => {
    const spawnOf = (records: Json[]): { time: number; input: Json } => {
      const record = records.find((r) => blocks(r, 'tool_use').some((b) => b.name === 'Agent'))!;
      return {
        time: Date.parse(record.timestamp as string),
        input: blocks(record, 'tool_use')[0]!.input as Json,
      };
    };
    const spawnA = spawnOf(a);
    const spawnB = spawnOf(b);
    expect(Math.abs(spawnA.time - spawnB.time)).toBeLessThanOrEqual(10);
    expect(spawnA.input).toEqual(spawnB.input);
  });

  it('answers each spawn in its own session and carries no error result', () => {
    for (const [name, records] of [
      ['concurrent-instance-a', a],
      ['concurrent-instance-b', b],
    ] as const) {
      const spawnIds = records.flatMap((r) => blocks(r, 'tool_use').map((x) => String(x.id)));
      const answered = answeredToolUseIds(records);
      expect(spawnIds.every((id) => answered.has(id))).toBe(true);
      for (const record of allRecords(name)) {
        for (const result of blocks(record, 'tool_result')) {
          expect(result.is_error).toBeUndefined();
        }
      }
    }
  });
});

describe('dual-layout-depth-2 fixtures', () => {
  const fixtures = PATHOLOGY_MANIFEST['dual-layout-depth-2'].fixtures;
  const metas = fixtures.flatMap((name) =>
    linesOf(getFixture(name), (path) => path.endsWith('.meta.json')),
  );
  const paths = fixtures.flatMap((name) => getFixture(name).files.map((f) => f.relativePath));

  it('includes a depth-2 spawn', () => {
    expect(metas.some((meta) => meta.spawnDepth === 2)).toBe(true);
  });

  it('includes both the flat and the nested on-disk layout', () => {
    expect(paths.some((path) => /^subagents\/agent-[0-9a-f]+\.jsonl$/.test(path))).toBe(true);
    expect(paths.some((path) => path.startsWith('subagents/workflows/'))).toBe(true);
  });
});
