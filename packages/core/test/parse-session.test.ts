/**
 * Tests for the pure read-side reconstruction parser (WP-IN8 core).
 *
 * Coverage strategy:
 * - Every shipped fixture is parsed and its agents / edges / deduped usage
 *   asserted field-by-field against the four structural join paths.
 * - A hand-built depth-2 substrate proves the self-referential parent: a
 *   grandchild's parent is the depth-1 agent, NOT the main root (gate #4).
 * - Negative substrates prove each loud `SubstrateError` (and the propagated
 *   `UsageConflictError`), while unknown record types and non-JSON-object
 *   lines are tolerated, not fatal.
 */
import { describe, expect, it } from 'vitest';
import {
  parseSession,
  SubstrateError,
  UsageConflictError,
  type ParsedEdge,
  type ParsedSession,
  type SessionSubstrate,
} from '../src/index';
import {
  DUPLICATED_MESSAGE_ID,
  EVICTED_TOOL_USE_ID,
  QUEUED_TOOL_USE_ID,
  getFixture,
  listFixtures,
} from '@agenthropic/test-fixtures';

// --- helpers ----------------------------------------------------------------

/** JSON-encode a record as one JSONL line (mirrors the fixtures' `jsonLine`). */
function jline(record: Record<string, unknown>): string {
  return JSON.stringify(record);
}

/** Build a `SessionSubstrate` from an array of { path, lines } file specs. */
function substrate(files: Array<{ path: string; lines: string[] }>): SessionSubstrate {
  return { files: files.map((f) => ({ relativePath: f.path, lines: f.lines })) };
}

function agentById(result: ParsedSession, id: string) {
  return result.agents.find((a) => a.id === id);
}

function edgeForChild(result: ParsedSession, childId: string): ParsedEdge | undefined {
  return result.edges.find((e) => e.childAgentId === childId);
}

function usageFor(result: ParsedSession, messageId: string) {
  return result.usage.find((u) => u.messageId === messageId);
}

// --- fixture: flat-tool-use (join path 1) -----------------------------------

describe('parseSession — flat-tool-use fixture (tool_use join)', () => {
  const SESSION = '11111111-2222-4333-8444-555555555555';
  const HEX = '3fa9c2d1';
  const TOOL_USE_ID = 'toolu_01SynthFlatSpawn0001';
  const result = parseSession(getFixture('flat-tool-use'));

  it('derives the session id from the records', () => {
    expect(result.sessionId).toBe(SESSION);
  });

  it('emits the main agent node from the top-level transcript', () => {
    const main = agentById(result, SESSION);
    expect(main).toEqual({
      id: SESSION,
      type: 'main',
      subagentType: null,
      parentAgentId: null,
      startedAt: '2026-01-15T10:00:00.000Z',
      endedAt: '2026-01-15T10:00:05.000Z',
    });
  });

  it('resolves the subagent parent via tool_use with its subagent_type', () => {
    const child = agentById(result, HEX);
    expect(child).toEqual({
      id: HEX,
      type: 'subagent',
      subagentType: 'general-purpose',
      parentAgentId: SESSION,
      startedAt: '2026-01-15T10:00:06.000Z',
      endedAt: '2026-01-15T10:00:09.000Z',
    });
  });

  it('emits exactly one edge, anchored by tool_use id position not prose substring (gate #5)', () => {
    expect(result.edges).toHaveLength(1);
    expect(result.edges[0]).toEqual({
      sessionId: SESSION,
      parentAgentId: SESSION,
      childAgentId: HEX,
      source: 'tool_use',
      toolUseId: TOOL_USE_ID,
    });
  });

  it('dedupes usage and attributes each row to its transcript owner', () => {
    expect(result.usage).toHaveLength(2);
    expect(usageFor(result, 'msg_synth_flat_parent_0001')).toEqual({
      messageId: 'msg_synth_flat_parent_0001',
      model: 'synthetic-model-a',
      timestamp: '2026-01-15T10:00:05.000Z',
      usage: { input: 42, output: 87, cacheRead: 1200, cacheWrite5m: 0, cacheWrite1h: 0 },
      agentId: null,
    });
    expect(usageFor(result, 'msg_synth_flat_child_0001')).toEqual({
      messageId: 'msg_synth_flat_child_0001',
      model: 'synthetic-model-a',
      timestamp: '2026-01-15T10:00:09.000Z',
      usage: { input: 15, output: 22, cacheRead: 0, cacheWrite5m: 300, cacheWrite1h: 0 },
      agentId: HEX,
    });
  });
});

// --- fixture: nested-workflow (join path 2) ---------------------------------

describe('parseSession — nested-workflow fixture (directory join)', () => {
  const SESSION = '22222222-3333-4444-8555-666666666666';
  const result = parseSession(getFixture('nested-workflow'));

  it('anchors both siblings to the workflow dispatcher (the main agent)', () => {
    for (const hex of ['deadbe01', 'deadbe02']) {
      const child = agentById(result, hex);
      expect(child?.parentAgentId).toBe(SESSION);
      expect(child?.subagentType).toBe('general-purpose');
      const edge = edgeForChild(result, hex);
      expect(edge).toEqual({
        sessionId: SESSION,
        parentAgentId: SESSION,
        childAgentId: hex,
        source: 'directory',
        toolUseId: null,
      });
    }
  });

  it('records per-sibling timespans from the nested transcripts', () => {
    expect(agentById(result, 'deadbe01')?.startedAt).toBe('2026-01-16T09:00:05.001Z');
    expect(agentById(result, 'deadbe02')?.startedAt).toBe('2026-01-16T09:00:05.003Z');
  });

  it('dedupes usage across main + two nested agents (ignoring the journal)', () => {
    expect(result.usage).toHaveLength(3);
    expect(usageFor(result, 'msg_synth_wf_parent_0001')?.agentId).toBeNull();
    expect(usageFor(result, 'msg_synth_wf_child_a_0001')?.agentId).toBe('deadbe01');
    expect(usageFor(result, 'msg_synth_wf_child_b_0001')).toEqual({
      messageId: 'msg_synth_wf_child_b_0001',
      model: 'synthetic-model-b',
      timestamp: '2026-01-16T09:00:08.000Z',
      usage: { input: 11, output: 40, cacheRead: 900, cacheWrite5m: 150, cacheWrite1h: 0 },
      agentId: 'deadbe02',
    });
  });
});

// --- fixture: task-notification-recovery (join path N1) ---------------------

describe('parseSession — task-notification-recovery fixture', () => {
  const SESSION = '33333333-4444-4555-8666-777777777777';
  const HEX = 'c0ffee42';
  const result = parseSession(getFixture('task-notification-recovery'));

  it('recovers the evicted parent edge via the child <task-notification>', () => {
    expect(agentById(result, HEX)?.parentAgentId).toBe(SESSION);
    expect(edgeForChild(result, HEX)).toEqual({
      sessionId: SESSION,
      parentAgentId: SESSION,
      childAgentId: HEX,
      source: 'task_notification',
      toolUseId: EVICTED_TOOL_USE_ID,
    });
  });

  it('tolerates the compact_boundary system record and emits a main node', () => {
    expect(agentById(result, SESSION)).toMatchObject({
      type: 'main',
      startedAt: '2026-01-17T14:00:00.000Z',
      endedAt: '2026-01-17T14:00:01.000Z',
    });
  });

  it('attributes the surviving usage to the recovered subagent', () => {
    expect(result.usage).toHaveLength(1);
    expect(usageFor(result, 'msg_synth_recover_child_0001')).toMatchObject({
      agentId: HEX,
      usage: { input: 19, output: 64, cacheRead: 3100, cacheWrite5m: 0, cacheWrite1h: 0 },
    });
  });
});

// --- fixture: queue-operation (join path N2) --------------------------------

describe('parseSession — queue-operation fixture', () => {
  const SESSION = '44444444-5555-4666-8777-888888888888';
  const HEX = 'ba5eba11';
  const result = parseSession(getFixture('queue-operation'));

  it('joins the backgrounded subagent via the queue-operation record', () => {
    expect(agentById(result, HEX)?.parentAgentId).toBe(SESSION);
    expect(edgeForChild(result, HEX)).toEqual({
      sessionId: SESSION,
      parentAgentId: SESSION,
      childAgentId: HEX,
      source: 'queue_operation',
      toolUseId: QUEUED_TOOL_USE_ID,
    });
  });

  it('extracts one usage row for the background agent', () => {
    expect(result.usage).toHaveLength(1);
    expect(usageFor(result, 'msg_synth_queue_child_0001')).toMatchObject({
      agentId: HEX,
      usage: { input: 27, output: 73, cacheRead: 0, cacheWrite5m: 500, cacheWrite1h: 0 },
    });
  });
});

// --- fixture: usage-dedup (gate N3) -----------------------------------------

describe('parseSession — usage-dedup fixture (lone subagent, no main)', () => {
  const HEX = 'facade07';
  const result = parseSession(getFixture('usage-dedup'));

  it('emits no main node and no edge for a lone orphan transcript', () => {
    expect(result.sessionId).toBe('55555555-6666-4777-8888-999999999999');
    expect(result.agents).toHaveLength(1);
    expect(agentById(result, HEX)).toEqual({
      id: HEX,
      type: 'subagent',
      subagentType: null,
      parentAgentId: null,
      startedAt: '2026-01-19T11:00:01.000Z',
      endedAt: '2026-01-19T11:00:12.000Z',
    });
    expect(result.edges).toHaveLength(0);
  });

  it('collapses 6 usage lines to 4 messages, keeping the first-seen timestamp and breakdown buckets', () => {
    expect(result.usage).toHaveLength(4);
    expect(usageFor(result, DUPLICATED_MESSAGE_ID)).toEqual({
      messageId: DUPLICATED_MESSAGE_ID,
      model: 'synthetic-model-a',
      timestamp: '2026-01-19T11:00:01.000Z',
      usage: { input: 8, output: 310, cacheRead: 52000, cacheWrite5m: 0, cacheWrite1h: 0 },
      agentId: HEX,
    });
    expect(usageFor(result, 'msg_synth_uniq_0003')?.usage).toEqual({
      input: 640,
      output: 210,
      cacheRead: 0,
      cacheWrite5m: 15000,
      cacheWrite1h: 0,
    });
  });
});

// --- every fixture parses without throwing ----------------------------------

describe('parseSession — all fixtures', () => {
  it('parses every shipped fixture into a consistent shape', () => {
    for (const name of listFixtures()) {
      const result = parseSession(getFixture(name));
      expect(result.sessionId).toBeTruthy();
      expect(result.agents.length).toBeGreaterThan(0);
      // Every edge's endpoints must be real agent ids in the session.
      const ids = new Set(result.agents.map((a) => a.id));
      for (const edge of result.edges) {
        expect(ids.has(edge.parentAgentId)).toBe(true);
        expect(ids.has(edge.childAgentId)).toBe(true);
      }
    }
  });

  it('does not mutate the input substrate', () => {
    const fixture = getFixture('flat-tool-use');
    const before = JSON.stringify(fixture);
    parseSession(fixture);
    expect(JSON.stringify(fixture)).toBe(before);
  });
});

// --- self-referential depth-2 tree ------------------------------------------

describe('parseSession — depth-2 self-referential parent', () => {
  const SESSION = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
  const DEPTH1 = 'aaaa1111';
  const DEPTH2 = 'bbbb2222';

  const input = substrate([
    {
      path: `${SESSION}.jsonl`,
      lines: [
        jline({
          sessionId: SESSION,
          type: 'user',
          timestamp: '2026-04-01T00:00:00.000Z',
          message: { role: 'user', content: 'dispatch depth-1' },
        }),
        jline({
          sessionId: SESSION,
          type: 'assistant',
          timestamp: '2026-04-01T00:00:01.000Z',
          message: {
            id: 'm_main',
            model: 'm',
            content: [
              {
                type: 'tool_use',
                id: 'toolu_depth1',
                name: 'Agent',
                input: { subagent_type: 'depth1-agent', prompt: 'p' },
              },
            ],
            usage: { input_tokens: 1 },
          },
        }),
      ],
    },
    {
      // The depth-1 agent transcript CONTAINS the depth-2 spawn block.
      path: `subagents/agent-${DEPTH1}.jsonl`,
      lines: [
        jline({
          sessionId: SESSION,
          agentId: DEPTH1,
          type: 'user',
          timestamp: '2026-04-01T00:00:02.000Z',
          message: { role: 'user', content: 'child task' },
        }),
        jline({
          sessionId: SESSION,
          agentId: DEPTH1,
          type: 'assistant',
          timestamp: '2026-04-01T00:00:03.000Z',
          message: {
            id: 'm_d1',
            model: 'm',
            content: [
              {
                type: 'tool_use',
                id: 'toolu_depth2',
                name: 'Agent',
                input: { subagent_type: 'grandchild-agent', prompt: 'p2' },
              },
            ],
            usage: { input_tokens: 2 },
          },
        }),
      ],
    },
    {
      path: `subagents/agent-${DEPTH2}.jsonl`,
      lines: [
        jline({
          sessionId: SESSION,
          agentId: DEPTH2,
          type: 'user',
          timestamp: '2026-04-01T00:00:04.000Z',
          message: { role: 'user', content: 'grandchild task' },
        }),
        jline({
          sessionId: SESSION,
          agentId: DEPTH2,
          type: 'assistant',
          timestamp: '2026-04-01T00:00:05.000Z',
          message: {
            id: 'm_d2',
            model: 'm',
            content: [{ type: 'text', text: 'done' }],
            usage: { input_tokens: 3 },
          },
        }),
      ],
    },
    // Real sidecars anchor each child hex to its parent spawn block by toolUseId.
    {
      path: `subagents/agent-${DEPTH1}.meta.json`,
      lines: [
        JSON.stringify({ toolUseId: 'toolu_depth1', agentType: 'depth1-agent', spawnDepth: 1 }),
      ],
    },
    {
      path: `subagents/agent-${DEPTH2}.meta.json`,
      lines: [
        JSON.stringify({ toolUseId: 'toolu_depth2', agentType: 'grandchild-agent', spawnDepth: 2 }),
      ],
    },
  ]);

  const result = parseSession(input);

  it("attributes the grandchild's parent to the depth-1 agent, not the main root", () => {
    const grandchild = agentById(result, DEPTH2);
    expect(grandchild?.parentAgentId).toBe(DEPTH1);
    expect(grandchild?.parentAgentId).not.toBe(SESSION);
    expect(grandchild?.subagentType).toBe('grandchild-agent');

    const edge = edgeForChild(result, DEPTH2);
    expect(edge).toEqual({
      sessionId: SESSION,
      parentAgentId: DEPTH1,
      childAgentId: DEPTH2,
      source: 'tool_use',
      toolUseId: 'toolu_depth2',
    });
  });

  it('still anchors the depth-1 agent to the main root', () => {
    expect(agentById(result, DEPTH1)?.parentAgentId).toBe(SESSION);
    expect(edgeForChild(result, DEPTH1)?.parentAgentId).toBe(SESSION);
    expect(result.edges).toHaveLength(2);
  });

  it('attributes usage down the whole chain', () => {
    expect(usageFor(result, 'm_main')?.agentId).toBeNull();
    expect(usageFor(result, 'm_d1')?.agentId).toBe(DEPTH1);
    expect(usageFor(result, 'm_d2')?.agentId).toBe(DEPTH2);
  });
});

// --- fixture: depth-2-sync (self-referential parent via sidecar anchors) -----

describe('parseSession — depth-2-sync fixture (self-referential parent, sidecar anchors)', () => {
  const SESSION = '66666666-7777-4888-8999-aaaaaaaaaaaa';
  const DEPTH1 = 'd1d1a001';
  const DEPTH2 = 'd2d2b002';
  const TOOL_USE_D1 = 'toolu_01SynthDepth1Spawn';
  const TOOL_USE_D2 = 'toolu_01SynthDepth2Spawn';
  const result = parseSession(getFixture('depth-2-sync'));

  it('emits three agents (main + depth-1 + depth-2) and two spawn edges', () => {
    expect(new Set(result.agents.map((a) => a.id))).toEqual(new Set([SESSION, DEPTH1, DEPTH2]));
    expect(result.edges).toHaveLength(2);
  });

  it('anchors the depth-1 agent to the main session via its sidecar toolUseId', () => {
    const depth1 = agentById(result, DEPTH1);
    expect(depth1?.parentAgentId).toBe(SESSION);
    expect(depth1?.subagentType).toBe('depth1-agent');
    expect(edgeForChild(result, DEPTH1)).toEqual({
      sessionId: SESSION,
      parentAgentId: SESSION,
      childAgentId: DEPTH1,
      source: 'tool_use',
      toolUseId: TOOL_USE_D1,
    });
  });

  it("attributes the grandchild's parent to the depth-1 agent, not the main root", () => {
    const depth2 = agentById(result, DEPTH2);
    expect(depth2?.parentAgentId).toBe(DEPTH1);
    expect(depth2?.parentAgentId).not.toBe(SESSION);
    expect(depth2?.subagentType).toBe('grandchild-agent');
    expect(edgeForChild(result, DEPTH2)).toEqual({
      sessionId: SESSION,
      parentAgentId: DEPTH1,
      childAgentId: DEPTH2,
      source: 'tool_use',
      toolUseId: TOOL_USE_D2,
    });
  });

  it('attributes usage down the whole chain', () => {
    expect(usageFor(result, 'msg_synth_d2sync_main_0001')?.agentId).toBeNull();
    expect(usageFor(result, 'msg_synth_d2sync_d1_0001')?.agentId).toBe(DEPTH1);
    expect(usageFor(result, 'msg_synth_d2sync_d2_0001')?.agentId).toBe(DEPTH2);
  });
});

// --- directory join with an unknown workflow (dispatcher-miss fallback) ------

describe('parseSession — nested agent under an unknown workflow', () => {
  const SESSION = 'ffffffff-0000-4000-8000-000000000abc';
  const HEX = 'cccc3333';

  const result = parseSession(
    substrate([
      {
        path: `${SESSION}.jsonl`,
        lines: [
          jline({
            sessionId: SESSION,
            type: 'user',
            timestamp: '2026-05-01T00:00:00.000Z',
            message: { role: 'user', content: 'go' },
          }),
        ],
      },
      {
        path: `workflows/wf_orphanwave/agent-${HEX}.jsonl`,
        lines: [
          jline({
            sessionId: SESSION,
            agentId: HEX,
            type: 'user',
            timestamp: '2026-05-01T00:00:01.000Z',
            message: { role: 'user', content: 'nested' },
          }),
          jline({
            sessionId: SESSION,
            agentId: HEX,
            type: 'assistant',
            timestamp: '2026-05-01T00:00:02.000Z',
            message: {
              id: 'm_c',
              model: 'm',
              content: [{ type: 'text', text: 'x' }],
              usage: { input_tokens: 1 },
            },
          }),
        ],
      },
    ]),
  );

  it('falls back to the main agent when the wf_<id> dispatcher is unknown', () => {
    expect(agentById(result, HEX)?.parentAgentId).toBe(SESSION);
    expect(edgeForChild(result, HEX)).toEqual({
      sessionId: SESSION,
      parentAgentId: SESSION,
      childAgentId: HEX,
      source: 'directory',
      toolUseId: null,
    });
  });
});

// --- usage bucket + row edge cases ------------------------------------------

describe('parseSession — usage bucket and row edge cases', () => {
  const SESSION = 'dddddddd-0000-4000-8000-000000000abc';

  const result = parseSession(
    substrate([
      {
        path: `${SESSION}.jsonl`,
        lines: [
          jline({
            sessionId: SESSION,
            type: 'user',
            timestamp: '2026-02-01T00:00:00.000Z',
            message: { role: 'user', content: 'go' },
          }),
          // Only input present, no cache_creation object -> all other buckets 0.
          jline({
            sessionId: SESSION,
            type: 'assistant',
            timestamp: '2026-02-01T00:00:01.000Z',
            message: { id: 'm_sparse_1', model: 'm', usage: { input_tokens: 5 } },
          }),
          // Empty cache_creation breakdown -> ephemeral buckets default to 0.
          jline({
            sessionId: SESSION,
            type: 'assistant',
            timestamp: '2026-02-01T00:00:02.000Z',
            message: { id: 'm_sparse_2', model: 'm', usage: { cache_creation: {} } },
          }),
          // No model and no timestamp -> both default to the empty string.
          jline({
            sessionId: SESSION,
            type: 'assistant',
            message: { id: 'm_sparse_3', usage: { input_tokens: 1 } },
          }),
          // No message id -> the usage row is skipped.
          jline({
            sessionId: SESSION,
            type: 'assistant',
            timestamp: '2026-02-01T00:00:04.000Z',
            message: { model: 'm', usage: { input_tokens: 9 } },
          }),
          // Assistant record with no usage block -> skipped.
          jline({
            sessionId: SESSION,
            type: 'assistant',
            timestamp: '2026-02-01T00:00:05.000Z',
            message: { id: 'm_sparse_5', model: 'm', content: [{ type: 'text', text: 'x' }] },
          }),
        ],
      },
    ]),
  );

  it('defaults missing buckets, model and timestamp; skips rows without usage or id', () => {
    expect(result.usage).toHaveLength(3);
    expect(usageFor(result, 'm_sparse_1')?.usage).toEqual({
      input: 5,
      output: 0,
      cacheRead: 0,
      cacheWrite5m: 0,
      cacheWrite1h: 0,
    });
    expect(usageFor(result, 'm_sparse_2')?.usage).toEqual({
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite5m: 0,
      cacheWrite1h: 0,
    });
    const sparse3 = usageFor(result, 'm_sparse_3');
    expect(sparse3?.model).toBe('');
    expect(sparse3?.timestamp).toBe('');
    expect(usageFor(result, 'm_sparse_5')).toBeUndefined();
  });

  it('spans the main transcript from its first to its last timestamped record', () => {
    expect(agentById(result, SESSION)).toMatchObject({
      startedAt: '2026-02-01T00:00:00.000Z',
      endedAt: '2026-02-01T00:00:05.000Z',
    });
  });
});

// --- tool_use index tolerance -----------------------------------------------

describe('parseSession — tool_use index tolerance', () => {
  const SESSION = 'eeeeeeee-0000-4000-8000-000000000abc';

  it('ignores non-object blocks, non-spawn tools, and id-less / input-less spawn blocks', () => {
    const result = parseSession(
      substrate([
        {
          path: `${SESSION}.jsonl`,
          lines: [
            jline({
              sessionId: SESSION,
              type: 'user',
              timestamp: '2026-06-01T00:00:00.000Z',
              message: { role: 'user', content: 'go' },
            }),
            jline({
              sessionId: SESSION,
              type: 'assistant',
              timestamp: '2026-06-01T00:00:01.000Z',
              message: {
                id: 'm_idx',
                model: 'm',
                usage: { input_tokens: 1 },
                content: [
                  42, // non-object content block
                  { type: 'text', text: 'hi' }, // non-tool block
                  { type: 'tool_use', name: 'Agent', input: { subagent_type: 'x' } }, // no id
                  {
                    type: 'tool_use',
                    id: 'toolu_wf_noid',
                    name: 'Workflow',
                    input: { prompt: 'p' },
                  }, // no workflow_id
                  { type: 'tool_use', id: 'toolu_noinput', name: 'Agent' }, // no input
                  { type: 'tool_use', id: 'toolu_read', name: 'Read', input: {} }, // non-spawn tool
                ],
              },
            }),
          ],
        },
      ]),
    );
    // No subagent transcripts exist, so none of these blocks forge an edge.
    expect(result.agents).toHaveLength(1);
    expect(result.edges).toHaveLength(0);
    expect(result.usage).toHaveLength(1);
  });
});

// --- orphan with plain-string content (no task-notification) ----------------

describe('parseSession — orphan subagent with plain-string content', () => {
  const HEX = '0badf00d';

  it('leaves the subagent parentless when no join path matches', () => {
    const result = parseSession(
      substrate([
        {
          path: `subagents/agent-${HEX}.jsonl`,
          lines: [
            jline({
              sessionId: 'orphan-session-uuid',
              agentId: HEX,
              type: 'user',
              timestamp: '2026-07-01T00:00:00.000Z',
              message: { role: 'user', content: 'plain string with no notification tag' },
            }),
            jline({
              sessionId: 'orphan-session-uuid',
              agentId: HEX,
              type: 'assistant',
              timestamp: '2026-07-01T00:00:01.000Z',
              message: {
                id: 'm_orphan',
                model: 'm',
                content: [{ type: 'text', text: 'x' }],
                usage: { input_tokens: 1 },
              },
            }),
          ],
        },
      ]),
    );
    expect(agentById(result, HEX)?.parentAgentId).toBeNull();
    expect(result.edges).toHaveLength(0);
    expect(usageFor(result, 'm_orphan')?.agentId).toBe(HEX);
  });
});

// --- tolerance: unknown record types, blank + non-object lines, sidecars -----

describe('parseSession — tolerates unknown records and non-transcript files', () => {
  const SESSION = 'abcdef00-0000-4000-8000-000000000abc';

  it('ignores unknown record types, blank/non-object lines and "other" files', () => {
    const result = parseSession(
      substrate([
        {
          path: `${SESSION}.jsonl`,
          lines: [
            jline({
              sessionId: SESSION,
              type: 'user',
              timestamp: '2026-03-01T00:00:00.000Z',
              message: { role: 'user', content: 'hi' },
            }),
            '', // blank line, skipped
            '42', // valid JSON but not an object, ignored everywhere
            jline({
              sessionId: SESSION,
              type: 'totally-unknown-event',
              timestamp: 'x',
              foo: 'bar',
            }),
            jline({
              sessionId: SESSION,
              type: 'assistant',
              timestamp: '2026-03-01T00:00:02.000Z',
              message: {
                id: 'm_unknown',
                model: 'm',
                content: [{ type: 'text', text: 'x' }],
                usage: {
                  input_tokens: 1,
                  output_tokens: 2,
                  cache_read_input_tokens: 3,
                  cache_creation_input_tokens: 4,
                },
              },
            }),
          ],
        },
        // "other" files (with a slash / non-.jsonl name) are classified out and
        // carry no sessionId, so they neither contribute nor contradict.
        { path: 'sidecar/data.json', lines: [jline({ note: 'x' })] },
        { path: 'config.json', lines: [jline({ a: 1 })] },
      ]),
    );

    expect(result.agents).toHaveLength(1);
    expect(agentById(result, SESSION)).toMatchObject({
      startedAt: '2026-03-01T00:00:00.000Z',
      endedAt: '2026-03-01T00:00:02.000Z',
    });
    expect(usageFor(result, 'm_unknown')?.usage).toEqual({
      input: 1,
      output: 2,
      cacheRead: 3,
      cacheWrite5m: 4,
      cacheWrite1h: 0,
    });
  });
});

// --- loud failures ----------------------------------------------------------

describe('parseSession — loud SubstrateError failures', () => {
  it('throws with file:line on a non-JSON line', () => {
    const input = substrate([{ path: 'session.jsonl', lines: ['{"ok":true}', 'not json {'] }]);
    expect(() => parseSession(input)).toThrow(SubstrateError);
    expect(() => parseSession(input)).toThrow('session.jsonl:2');
  });

  it('throws when an agent file has no sessionId on any record', () => {
    const input = substrate([
      {
        path: 'session.jsonl',
        lines: [jline({ type: 'user', timestamp: '2026-01-01T00:00:00.000Z', message: {} })],
      },
    ]);
    expect(() => parseSession(input)).toThrow(/no sessionId/);
  });

  it('throws on a sessionId contradiction across records', () => {
    const input = substrate([
      {
        path: 'session.jsonl',
        lines: [
          jline({ sessionId: 'A', type: 'user', timestamp: '2026-01-01T00:00:00.000Z' }),
          jline({ sessionId: 'B', type: 'user', timestamp: '2026-01-01T00:00:01.000Z' }),
        ],
      },
    ]);
    expect(() => parseSession(input)).toThrow(/sessionId contradiction/);
  });

  it('throws when an inline agentId disagrees with the filename hex', () => {
    const input = substrate([
      {
        path: 'subagents/agent-abcd1234.jsonl',
        lines: [
          jline({
            sessionId: 's',
            agentId: 'wronghex',
            type: 'user',
            timestamp: '2026-01-01T00:00:00.000Z',
          }),
        ],
      },
    ]);
    expect(() => parseSession(input)).toThrow(/does not equal filename hex/);
  });

  it('throws when two agent files share a hex', () => {
    const input = substrate([
      {
        path: 'subagents/agent-abcd1234.jsonl',
        lines: [jline({ sessionId: 's', type: 'user', timestamp: '2026-01-01T00:00:00.000Z' })],
      },
      {
        path: 'other/agent-abcd1234.jsonl',
        lines: [jline({ sessionId: 's', type: 'user', timestamp: '2026-01-01T00:00:01.000Z' })],
      },
    ]);
    expect(() => parseSession(input)).toThrow(/share hex/);
  });

  it('throws when a transcript carries no timestamped record', () => {
    const input = substrate([
      {
        path: 'session.jsonl',
        lines: [jline({ sessionId: 's', type: 'user', timestamp: '2026-01-01T00:00:00.000Z' })],
      },
      { path: 'subagents/agent-abcd1234.jsonl', lines: [''] },
    ]);
    expect(() => parseSession(input)).toThrow(/no timestamped record/);
  });

  it('propagates UsageConflictError when a shared message id carries a conflicting model', () => {
    // Streamed partials of one message never disagree on model; a model
    // collision on a shared message.id is a corrupted/colliding substrate
    // (parser-spec 5.3: message ids are per-agent-disjoint) and must be loud.
    // Divergent token counts alone no longer throw — they collapse to the
    // per-bucket maximum (the final streamed usage).
    const input = substrate([
      {
        path: 'session.jsonl',
        lines: [
          jline({ sessionId: 's', type: 'user', timestamp: '2026-01-01T00:00:00.000Z' }),
          jline({
            sessionId: 's',
            type: 'assistant',
            timestamp: '2026-01-01T00:00:01.000Z',
            message: { id: 'm_conflict', model: 'm', usage: { input_tokens: 10 } },
          }),
          jline({
            sessionId: 's',
            type: 'assistant',
            timestamp: '2026-01-01T00:00:02.000Z',
            message: { id: 'm_conflict', model: 'm2', usage: { input_tokens: 20 } },
          }),
        ],
      },
    ]);
    expect(() => parseSession(input)).toThrow(UsageConflictError);
  });
});

// --- additional real join-path branches -------------------------------------
// The four documented resolution paths below have no coverage from the shipped
// fixtures (a workflow dispatched BY a subagent, the parent-side async
// toolUseResult anchor, a sidecar anchor whose block was evicted, and an empty
// sidecar). They exercise real parser behavior, not synthetic edge cases.

describe('parseSession — workflow dispatched by a subagent (dispatcher hit)', () => {
  const SESSION = 'a0a0a0a0-1111-4222-8333-444444444444';
  const D1 = 'a1a1a1a1';
  const WFC = 'b2b2b2b2';

  const result = parseSession(
    substrate([
      {
        path: `${SESSION}.jsonl`,
        lines: [
          jline({
            sessionId: SESSION,
            type: 'user',
            timestamp: '2026-08-01T00:00:00.000Z',
            message: { role: 'user', content: 'dispatch an orchestrator' },
          }),
          jline({
            sessionId: SESSION,
            type: 'assistant',
            timestamp: '2026-08-01T00:00:01.000Z',
            message: {
              id: 'm_wfh_main',
              model: 'm',
              usage: { input_tokens: 1 },
              content: [
                {
                  type: 'tool_use',
                  id: 'toolu_spawn_d1',
                  name: 'Agent',
                  input: { subagent_type: 'orchestrator', prompt: 'p' },
                },
              ],
            },
          }),
        ],
      },
      {
        // The depth-1 orchestrator transcript CONTAINS the Workflow dispatch, so
        // the dispatcher owner is D1 — not the main session.
        path: `subagents/agent-${D1}.jsonl`,
        lines: [
          jline({
            sessionId: SESSION,
            agentId: D1,
            type: 'user',
            timestamp: '2026-08-01T00:00:02.000Z',
            message: { role: 'user', content: 'orchestrate' },
          }),
          jline({
            sessionId: SESSION,
            agentId: D1,
            type: 'assistant',
            timestamp: '2026-08-01T00:00:03.000Z',
            message: {
              id: 'm_wfh_d1',
              model: 'm',
              usage: { input_tokens: 1 },
              content: [
                {
                  type: 'tool_use',
                  id: 'toolu_wf_known',
                  name: 'Workflow',
                  input: { workflow_id: 'wf_known', prompt: 'run the workflow' },
                },
              ],
            },
          }),
        ],
      },
      {
        path: `subagents/agent-${D1}.meta.json`,
        lines: [
          JSON.stringify({ toolUseId: 'toolu_spawn_d1', agentType: 'orchestrator', spawnDepth: 1 }),
        ],
      },
      {
        // The workflow subagent is joined by directory to the dispatcher (D1).
        path: `workflows/wf_known/agent-${WFC}.jsonl`,
        lines: [
          jline({
            sessionId: SESSION,
            agentId: WFC,
            type: 'user',
            timestamp: '2026-08-01T00:00:04.000Z',
            message: { role: 'user', content: 'workflow child task' },
          }),
          jline({
            sessionId: SESSION,
            agentId: WFC,
            type: 'assistant',
            timestamp: '2026-08-01T00:00:05.000Z',
            message: {
              id: 'm_wfh_wfc',
              model: 'm',
              usage: { input_tokens: 1 },
              content: [{ type: 'text', text: 'x' }],
            },
          }),
        ],
      },
    ]),
  );

  it('anchors the nested workflow agent to the dispatching subagent, not the main root', () => {
    expect(agentById(result, D1)?.parentAgentId).toBe(SESSION);
    expect(agentById(result, WFC)?.parentAgentId).toBe(D1);
    expect(edgeForChild(result, WFC)).toEqual({
      sessionId: SESSION,
      parentAgentId: D1,
      childAgentId: WFC,
      source: 'directory',
      toolUseId: null,
    });
  });
});

describe('parseSession — async toolUseResult join (sidecar without a toolUseId)', () => {
  const SESSION = 'c3c30000-1111-4222-8333-444444444444';
  const CHILD = 'c3c3c3c3';

  const result = parseSession(
    substrate([
      {
        path: `${SESSION}.jsonl`,
        lines: [
          jline({
            sessionId: SESSION,
            type: 'user',
            timestamp: '2026-08-02T00:00:00.000Z',
            message: { role: 'user', content: 'spawn async worker' },
          }),
          jline({
            sessionId: SESSION,
            type: 'assistant',
            timestamp: '2026-08-02T00:00:01.000Z',
            message: {
              id: 'm_async_main',
              model: 'm',
              usage: { input_tokens: 1 },
              content: [
                {
                  type: 'tool_use',
                  id: 'toolu_async_spawn',
                  name: 'Agent',
                  input: { subagent_type: 'async-worker', prompt: 'p' },
                },
              ],
            },
          }),
          // Parent-side async result: toolUseResult.agentId names the child hex,
          // and a sibling tool_result block's tool_use_id is the parent block.
          jline({
            sessionId: SESSION,
            type: 'user',
            timestamp: '2026-08-02T00:00:02.000Z',
            toolUseResult: { agentId: CHILD },
            message: {
              role: 'user',
              content: [
                { type: 'text', text: 'ignored non-tool_result block' },
                { type: 'tool_result', tool_use_id: 'toolu_async_spawn', content: 'ok' },
              ],
            },
          }),
        ],
      },
      {
        path: `subagents/agent-${CHILD}.jsonl`,
        lines: [
          jline({
            sessionId: SESSION,
            agentId: CHILD,
            type: 'user',
            timestamp: '2026-08-02T00:00:03.000Z',
            message: { role: 'user', content: 'async task' },
          }),
          jline({
            sessionId: SESSION,
            agentId: CHILD,
            type: 'assistant',
            timestamp: '2026-08-02T00:00:04.000Z',
            message: {
              id: 'm_async_child',
              model: 'm',
              usage: { input_tokens: 1 },
              content: [{ type: 'text', text: 'x' }],
            },
          }),
        ],
      },
      {
        // Sidecar carries NO toolUseId, forcing the async-toolUseResult anchor.
        path: `subagents/agent-${CHILD}.meta.json`,
        lines: [JSON.stringify({ agentType: 'async-worker', spawnDepth: 1 })],
      },
    ]),
  );

  it('anchors the child to the parent spawn block via the async toolUseResult', () => {
    expect(agentById(result, CHILD)?.parentAgentId).toBe(SESSION);
    expect(agentById(result, CHILD)?.subagentType).toBe('async-worker');
    expect(edgeForChild(result, CHILD)).toEqual({
      sessionId: SESSION,
      parentAgentId: SESSION,
      childAgentId: CHILD,
      source: 'tool_use',
      toolUseId: 'toolu_async_spawn',
    });
  });
});

describe('parseSession — sidecar anchor whose parent block was evicted (re-anchor to main)', () => {
  const SESSION = 'd4d40000-1111-4222-8333-444444444444';
  const CHILD = 'd4d4d4d4';

  const result = parseSession(
    substrate([
      {
        path: `${SESSION}.jsonl`,
        lines: [
          jline({
            sessionId: SESSION,
            type: 'user',
            timestamp: '2026-08-03T00:00:00.000Z',
            message: { role: 'user', content: 'go' },
          }),
        ],
      },
      {
        path: `subagents/agent-${CHILD}.jsonl`,
        lines: [
          jline({
            sessionId: SESSION,
            agentId: CHILD,
            type: 'user',
            timestamp: '2026-08-03T00:00:01.000Z',
            message: { role: 'user', content: 'orphaned-anchor task' },
          }),
          jline({
            sessionId: SESSION,
            agentId: CHILD,
            type: 'assistant',
            timestamp: '2026-08-03T00:00:02.000Z',
            message: {
              id: 'm_ghost_child',
              model: 'm',
              usage: { input_tokens: 1 },
              content: [{ type: 'text', text: 'x' }],
            },
          }),
        ],
      },
      {
        // The sidecar's toolUseId matches no materialized tool_use or queue-op,
        // so the anchor is known but its parent block is gone -> re-anchor main.
        path: `subagents/agent-${CHILD}.meta.json`,
        lines: [JSON.stringify({ toolUseId: 'toolu_ghost', agentType: 'ghosted', spawnDepth: 1 })],
      },
    ]),
  );

  it('re-anchors to the main agent via task_notification when the anchor block is gone', () => {
    expect(agentById(result, CHILD)?.parentAgentId).toBe(SESSION);
    expect(agentById(result, CHILD)?.subagentType).toBe('ghosted');
    expect(edgeForChild(result, CHILD)).toEqual({
      sessionId: SESSION,
      parentAgentId: SESSION,
      childAgentId: CHILD,
      source: 'task_notification',
      toolUseId: 'toolu_ghost',
    });
  });
});

describe('parseSession — non-object lines before the first record of a transcript', () => {
  const SESSION = 'f0f00000-1111-4222-8333-444444444444';
  const CHILD = 'f0f0f0f0';
  const RECOVERED_TOOL_USE_ID = 'toolu_legacy_notify';

  const result = parseSession(
    substrate([
      {
        path: `${SESSION}.jsonl`,
        lines: [
          jline({
            sessionId: SESSION,
            type: 'user',
            timestamp: '2026-08-05T00:00:00.000Z',
            message: { role: 'user', content: 'go' },
          }),
        ],
      },
      {
        path: `subagents/agent-${CHILD}.jsonl`,
        lines: [
          // JSONL noise ahead of the real first record: a bare null and a bare
          // array are valid JSON but carry no fields, so the legacy
          // <task-notification> scan must look past them, not give up on line 1.
          'null',
          '[1, 2]',
          jline({
            sessionId: SESSION,
            agentId: CHILD,
            type: 'user',
            timestamp: '2026-08-05T00:00:01.000Z',
            message: {
              role: 'user',
              content:
                '<task-notification>' +
                `<tool-use-id>${RECOVERED_TOOL_USE_ID}</tool-use-id>` +
                '</task-notification>',
            },
          }),
          jline({
            sessionId: SESSION,
            agentId: CHILD,
            type: 'assistant',
            timestamp: '2026-08-05T00:00:02.000Z',
            message: {
              id: 'm_leading_noise_child',
              model: 'm',
              usage: { input_tokens: 7 },
              content: [{ type: 'text', text: 'x' }],
            },
          }),
        ],
      },
    ]),
  );

  it('skips leading non-object lines and still recovers the legacy task_notification edge', () => {
    expect(agentById(result, CHILD)?.parentAgentId).toBe(SESSION);
    expect(edgeForChild(result, CHILD)).toEqual({
      sessionId: SESSION,
      parentAgentId: SESSION,
      childAgentId: CHILD,
      source: 'task_notification',
      toolUseId: RECOVERED_TOOL_USE_ID,
    });
  });

  it('keeps the timespan and the usage row of the noisy transcript intact', () => {
    expect(agentById(result, CHILD)).toMatchObject({
      startedAt: '2026-08-05T00:00:01.000Z',
      endedAt: '2026-08-05T00:00:02.000Z',
    });
    expect(usageFor(result, 'm_leading_noise_child')).toMatchObject({
      agentId: CHILD,
      usage: { input: 7, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 },
    });
  });
});

describe('parseSession — malformed queue-operation records build no queue index', () => {
  const SESSION = 'c9c90000-1111-4222-8333-444444444444';
  const CHILD = 'c9c9c9c9';

  const result = parseSession(
    substrate([
      {
        path: `${SESSION}.jsonl`,
        lines: [
          jline({
            sessionId: SESSION,
            type: 'user',
            timestamp: '2026-08-06T00:00:00.000Z',
            message: { role: 'user', content: 'go' },
          }),
          // `content` is not a string at all -> nothing to scan for tags.
          jline({
            sessionId: SESSION,
            type: 'queue-operation',
            operation: 'enqueue',
            timestamp: '2026-08-06T00:00:01.000Z',
            content: { taskId: CHILD, toolUseId: 'toolu_never_indexed' },
          }),
          // A string, but with no <tool-use-id> tag: the record names a task but
          // no parent block, so it must not enter the queue index either.
          jline({
            sessionId: SESSION,
            type: 'queue-operation',
            operation: 'enqueue',
            timestamp: '2026-08-06T00:00:02.000Z',
            content: `<task-notification><task-id>${CHILD}</task-id></task-notification>`,
          }),
        ],
      },
      {
        path: `subagents/agent-${CHILD}.jsonl`,
        lines: [
          jline({
            sessionId: SESSION,
            agentId: CHILD,
            type: 'user',
            timestamp: '2026-08-06T00:00:03.000Z',
            message: { role: 'user', content: 'backgrounded task with no usable queue record' },
          }),
          jline({
            sessionId: SESSION,
            agentId: CHILD,
            type: 'assistant',
            timestamp: '2026-08-06T00:00:04.000Z',
            message: {
              id: 'm_bad_queue_child',
              model: 'm',
              usage: { input_tokens: 3, output_tokens: 4 },
              content: [{ type: 'text', text: 'x' }],
            },
          }),
        ],
      },
    ]),
  );

  it('leaves the backgrounded child an orphan rather than fabricating a parent', () => {
    expect(agentById(result, CHILD)?.parentAgentId).toBeNull();
    expect(agentById(result, CHILD)?.subagentType).toBeNull();
    expect(result.edges).toHaveLength(0);
  });

  it('still emits the child agent and its ground-truth usage (no data is dropped)', () => {
    expect(result.agents.map((a) => a.id).sort()).toEqual([SESSION, CHILD].sort());
    expect(usageFor(result, 'm_bad_queue_child')).toMatchObject({
      agentId: CHILD,
      usage: { input: 3, output: 4, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 },
    });
  });
});

describe('parseSession — queue-operation with a tool-use-id but no task-id', () => {
  const SESSION = 'b8b80000-1111-4222-8333-444444444444';
  const CHILD = 'b8b8b8b8';
  const QUEUED_ID = 'toolu_bg_no_task_id';

  const result = parseSession(
    substrate([
      {
        path: `${SESSION}.jsonl`,
        lines: [
          jline({
            sessionId: SESSION,
            type: 'user',
            timestamp: '2026-08-07T00:00:00.000Z',
            message: { role: 'user', content: 'go' },
          }),
          // The record names the parent spawn block but not the queued child, so
          // it can own an anchor supplied from elsewhere (here: the sidecar) yet
          // contributes no child-hex -> tool-use-id join of its own.
          jline({
            sessionId: SESSION,
            type: 'queue-operation',
            operation: 'enqueue',
            timestamp: '2026-08-07T00:00:01.000Z',
            content: `<task-notification><tool-use-id>${QUEUED_ID}</tool-use-id></task-notification>`,
          }),
        ],
      },
      {
        path: `subagents/agent-${CHILD}.jsonl`,
        lines: [
          jline({
            sessionId: SESSION,
            agentId: CHILD,
            type: 'user',
            timestamp: '2026-08-07T00:00:02.000Z',
            message: { role: 'user', content: 'backgrounded task' },
          }),
          jline({
            sessionId: SESSION,
            agentId: CHILD,
            type: 'assistant',
            timestamp: '2026-08-07T00:00:03.000Z',
            message: {
              id: 'm_queue_no_task_id',
              model: 'm',
              usage: { input_tokens: 2 },
              content: [{ type: 'text', text: 'x' }],
            },
          }),
        ],
      },
      // Sidecar supplies the anchor but knows no agentType.
      {
        path: `subagents/agent-${CHILD}.meta.json`,
        lines: [JSON.stringify({ toolUseId: QUEUED_ID, spawnDepth: 1 })],
      },
    ]),
  );

  it('resolves the sidecar anchor through the queue-operation owner', () => {
    expect(agentById(result, CHILD)?.parentAgentId).toBe(SESSION);
    expect(edgeForChild(result, CHILD)).toEqual({
      sessionId: SESSION,
      parentAgentId: SESSION,
      childAgentId: CHILD,
      source: 'queue_operation',
      toolUseId: QUEUED_ID,
    });
  });

  it('leaves the subagent type null instead of guessing one', () => {
    expect(agentById(result, CHILD)?.subagentType).toBeNull();
  });
});

describe('parseSession — async toolUseResult whose message content is not a block array', () => {
  const SESSION = 'dada0000-1111-4222-8333-444444444444';
  const CHILD = 'dadadada';

  const result = parseSession(
    substrate([
      {
        path: `${SESSION}.jsonl`,
        lines: [
          jline({
            sessionId: SESSION,
            type: 'user',
            timestamp: '2026-08-08T00:00:00.000Z',
            message: { role: 'user', content: 'go' },
          }),
          jline({
            sessionId: SESSION,
            type: 'assistant',
            timestamp: '2026-08-08T00:00:01.000Z',
            message: {
              id: 'm_async_str_main',
              model: 'm',
              usage: { input_tokens: 1 },
              content: [
                {
                  type: 'tool_use',
                  id: 'toolu_async_str',
                  name: 'Agent',
                  input: { subagent_type: 'async-worker', prompt: 'p' },
                },
              ],
            },
          }),
          // `toolUseResult.agentId` names the child, but the record's content is
          // a plain string: there is no tool_result block to read a parent block
          // id from, so this record must forge nothing.
          jline({
            sessionId: SESSION,
            type: 'user',
            timestamp: '2026-08-08T00:00:02.000Z',
            toolUseResult: { agentId: CHILD },
            message: { role: 'user', content: 'agent finished' },
          }),
        ],
      },
      {
        path: `subagents/agent-${CHILD}.jsonl`,
        lines: [
          jline({
            sessionId: SESSION,
            agentId: CHILD,
            type: 'user',
            timestamp: '2026-08-08T00:00:03.000Z',
            message: { role: 'user', content: 'async task' },
          }),
          jline({
            sessionId: SESSION,
            agentId: CHILD,
            type: 'assistant',
            timestamp: '2026-08-08T00:00:04.000Z',
            message: {
              id: 'm_async_str_child',
              model: 'm',
              usage: { input_tokens: 1 },
              content: [{ type: 'text', text: 'x' }],
            },
          }),
        ],
      },
    ]),
  );

  it('does not anchor the child from a toolUseResult carrying no tool_result block', () => {
    expect(agentById(result, CHILD)?.parentAgentId).toBeNull();
    expect(result.edges).toHaveLength(0);
  });

  it('keeps the unjoined subagent and its usage visible', () => {
    expect(agentById(result, CHILD)?.type).toBe('subagent');
    expect(usageFor(result, 'm_async_str_child')?.agentId).toBe(CHILD);
  });
});

describe('parseSession — async toolUseResult with an id-less tool_result block first', () => {
  const SESSION = 'ebeb0000-1111-4222-8333-444444444444';
  const CHILD = 'ebebebeb';

  const result = parseSession(
    substrate([
      {
        path: `${SESSION}.jsonl`,
        lines: [
          jline({
            sessionId: SESSION,
            type: 'user',
            timestamp: '2026-08-09T00:00:00.000Z',
            message: { role: 'user', content: 'go' },
          }),
          jline({
            sessionId: SESSION,
            type: 'assistant',
            timestamp: '2026-08-09T00:00:01.000Z',
            message: {
              id: 'm_idless_main',
              model: 'm',
              usage: { input_tokens: 1 },
              content: [
                {
                  type: 'tool_use',
                  id: 'toolu_real_block',
                  name: 'Agent',
                  input: { subagent_type: 'async-worker', prompt: 'p' },
                },
              ],
            },
          }),
          jline({
            sessionId: SESSION,
            type: 'user',
            timestamp: '2026-08-09T00:00:02.000Z',
            toolUseResult: { agentId: CHILD },
            message: {
              role: 'user',
              content: [
                // A tool_result with no `tool_use_id` must be skipped, not taken
                // as "no anchor exists" — the scan continues to the next block.
                { type: 'tool_result', content: 'malformed, no tool_use_id' },
                { type: 'tool_result', tool_use_id: 'toolu_real_block', content: 'ok' },
              ],
            },
          }),
        ],
      },
      {
        path: `subagents/agent-${CHILD}.jsonl`,
        lines: [
          jline({
            sessionId: SESSION,
            agentId: CHILD,
            type: 'user',
            timestamp: '2026-08-09T00:00:03.000Z',
            message: { role: 'user', content: 'async task' },
          }),
          jline({
            sessionId: SESSION,
            agentId: CHILD,
            type: 'assistant',
            timestamp: '2026-08-09T00:00:04.000Z',
            message: {
              id: 'm_idless_child',
              model: 'm',
              usage: { input_tokens: 1 },
              content: [{ type: 'text', text: 'x' }],
            },
          }),
        ],
      },
    ]),
  );

  it('skips the id-less tool_result and anchors on the next well-formed one', () => {
    expect(agentById(result, CHILD)?.parentAgentId).toBe(SESSION);
    expect(edgeForChild(result, CHILD)).toEqual({
      sessionId: SESSION,
      parentAgentId: SESSION,
      childAgentId: CHILD,
      source: 'tool_use',
      toolUseId: 'toolu_real_block',
    });
    expect(agentById(result, CHILD)?.subagentType).toBe('async-worker');
  });
});

describe('parseSession — spawn block without a subagent_type', () => {
  const SESSION = 'f6f60000-1111-4222-8333-444444444444';
  const CHILD_A = 'f6f6aaaa';
  const CHILD_B = 'f6f6bbbb';

  const childTranscript = (hex: string, second: number, messageId: string) => ({
    path: `subagents/agent-${hex}.jsonl`,
    lines: [
      jline({
        sessionId: SESSION,
        agentId: hex,
        type: 'user',
        timestamp: `2026-08-10T00:00:0${second}.000Z`,
        message: { role: 'user', content: 'task' },
      }),
      jline({
        sessionId: SESSION,
        agentId: hex,
        type: 'assistant',
        timestamp: `2026-08-10T00:00:0${second + 1}.000Z`,
        message: {
          id: messageId,
          model: 'm',
          usage: { input_tokens: 1 },
          content: [{ type: 'text', text: 'x' }],
        },
      }),
    ],
  });

  const result = parseSession(
    substrate([
      {
        path: `${SESSION}.jsonl`,
        lines: [
          jline({
            sessionId: SESSION,
            type: 'user',
            timestamp: '2026-08-10T00:00:00.000Z',
            message: { role: 'user', content: 'go' },
          }),
          jline({
            sessionId: SESSION,
            type: 'assistant',
            timestamp: '2026-08-10T00:00:01.000Z',
            message: {
              id: 'm_no_type_main',
              model: 'm',
              usage: { input_tokens: 1 },
              content: [
                // Neither spawn block declares `subagent_type` in its input.
                { type: 'tool_use', id: 'toolu_no_type_a', name: 'Agent', input: { prompt: 'p' } },
                { type: 'tool_use', id: 'toolu_no_type_b', name: 'Agent', input: { prompt: 'p' } },
              ],
            },
          }),
        ],
      },
      childTranscript(CHILD_A, 2, 'm_no_type_child_a'),
      {
        path: `subagents/agent-${CHILD_A}.meta.json`,
        lines: [
          JSON.stringify({ toolUseId: 'toolu_no_type_a', agentType: 'Explore', spawnDepth: 1 }),
        ],
      },
      childTranscript(CHILD_B, 4, 'm_no_type_child_b'),
      // No `agentType` anywhere for B: neither the block nor the sidecar knows it.
      {
        path: `subagents/agent-${CHILD_B}.meta.json`,
        lines: [JSON.stringify({ toolUseId: 'toolu_no_type_b', spawnDepth: 1 })],
      },
    ]),
  );

  it('recovers the subagent type from the sidecar when the spawn block omits it', () => {
    expect(agentById(result, CHILD_A)?.subagentType).toBe('Explore');
    expect(edgeForChild(result, CHILD_A)).toEqual({
      sessionId: SESSION,
      parentAgentId: SESSION,
      childAgentId: CHILD_A,
      source: 'tool_use',
      toolUseId: 'toolu_no_type_a',
    });
  });

  it('leaves the subagent type null when neither the block nor the sidecar knows it', () => {
    expect(agentById(result, CHILD_B)?.subagentType).toBeNull();
    // The edge itself is unaffected — an unknown type never costs a real edge.
    expect(edgeForChild(result, CHILD_B)).toEqual({
      sessionId: SESSION,
      parentAgentId: SESSION,
      childAgentId: CHILD_B,
      source: 'tool_use',
      toolUseId: 'toolu_no_type_b',
    });
  });
});

describe('parseSession — evicted anchor with a type-less sidecar', () => {
  const SESSION = 'a7a70000-1111-4222-8333-444444444444';
  const CHILD = 'a7a7a7a7';

  const result = parseSession(
    substrate([
      {
        path: `${SESSION}.jsonl`,
        lines: [
          jline({
            sessionId: SESSION,
            type: 'user',
            timestamp: '2026-08-11T00:00:00.000Z',
            message: { role: 'user', content: 'go' },
          }),
        ],
      },
      {
        path: `subagents/agent-${CHILD}.jsonl`,
        lines: [
          jline({
            sessionId: SESSION,
            agentId: CHILD,
            type: 'user',
            timestamp: '2026-08-11T00:00:01.000Z',
            message: { role: 'user', content: 'task with an evicted parent block' },
          }),
          jline({
            sessionId: SESSION,
            agentId: CHILD,
            type: 'assistant',
            timestamp: '2026-08-11T00:00:02.000Z',
            message: {
              id: 'm_evicted_typeless',
              model: 'm',
              usage: { input_tokens: 1 },
              content: [{ type: 'text', text: 'x' }],
            },
          }),
        ],
      },
      // The anchor is known but its block is gone, and the sidecar records no
      // agentType — the edge is still recoverable, the type honestly is not.
      {
        path: `subagents/agent-${CHILD}.meta.json`,
        lines: [JSON.stringify({ toolUseId: 'toolu_evicted_typeless', spawnDepth: 1 })],
      },
    ]),
  );

  it('re-anchors to main via task_notification while keeping the type unknown', () => {
    expect(agentById(result, CHILD)?.subagentType).toBeNull();
    expect(edgeForChild(result, CHILD)).toEqual({
      sessionId: SESSION,
      parentAgentId: SESSION,
      childAgentId: CHILD,
      source: 'task_notification',
      toolUseId: 'toolu_evicted_typeless',
    });
  });
});

describe('parseSession — tolerates an empty .meta.json sidecar', () => {
  const SESSION = 'e5e50000-1111-4222-8333-444444444444';
  const CHILD = 'e5e5e5e5';

  const result = parseSession(
    substrate([
      {
        path: `${SESSION}.jsonl`,
        lines: [
          jline({
            sessionId: SESSION,
            type: 'user',
            timestamp: '2026-08-04T00:00:00.000Z',
            message: { role: 'user', content: 'go' },
          }),
        ],
      },
      {
        path: `subagents/agent-${CHILD}.jsonl`,
        lines: [
          jline({
            sessionId: SESSION,
            agentId: CHILD,
            type: 'user',
            timestamp: '2026-08-04T00:00:01.000Z',
            message: { role: 'user', content: 'no-sidecar-data task' },
          }),
          jline({
            sessionId: SESSION,
            agentId: CHILD,
            type: 'assistant',
            timestamp: '2026-08-04T00:00:02.000Z',
            message: {
              id: 'm_empty_meta_child',
              model: 'm',
              usage: { input_tokens: 1 },
              content: [{ type: 'text', text: 'x' }],
            },
          }),
        ],
      },
      // A blank sidecar (no JSON object record) must be tolerated, not fatal.
      { path: `subagents/agent-${CHILD}.meta.json`, lines: [''] },
    ]),
  );

  it('does not crash and leaves the agent an orphan (no sidecar anchor)', () => {
    expect(agentById(result, CHILD)?.parentAgentId).toBeNull();
    expect(agentById(result, CHILD)?.subagentType).toBeNull();
    expect(edgeForChild(result, CHILD)).toBeUndefined();
  });
});
