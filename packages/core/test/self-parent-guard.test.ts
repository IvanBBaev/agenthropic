/**
 * C-6 regression: no join path may produce a self-parent (`ab -> ab`) edge.
 *
 * Every parent candidate is the agent id of the transcript that CONTAINS a
 * spawn anchor. If that transcript is the child's own, the "parent" is the
 * child itself — a one-node cycle that the subagent tree cannot hold. The
 * gate-#7 legacy path already refuses this at index time (a transcript's own
 * `progress` lines never register it as its own spawner); the same
 * foreign-owner rule now holds on the directory, `tool_use` and
 * `queue_operation` paths. A self-owned candidate counts as no owner at all,
 * so resolution falls through to the next path exactly as if the self entry
 * had never been indexed.
 */
import { describe, expect, it } from 'vitest';
import { parseSession, type ParsedSession, type SessionSubstrate } from '../src/index';

function jline(record: Record<string, unknown>): string {
  return JSON.stringify(record);
}

function substrate(files: Array<{ path: string; lines: string[] }>): SessionSubstrate {
  return { files: files.map((f) => ({ relativePath: f.path, lines: f.lines })) };
}

function mainTranscript(session: string): { path: string; lines: string[] } {
  return {
    path: `${session}.jsonl`,
    lines: [
      jline({
        sessionId: session,
        type: 'user',
        timestamp: '2026-09-01T00:00:00.000Z',
        message: { role: 'user', content: 'go' },
      }),
    ],
  };
}

function expectNoSelfEdge(result: ParsedSession): void {
  for (const edge of result.edges) {
    expect(edge.parentAgentId).not.toBe(edge.childAgentId);
  }
  for (const agent of result.agents) {
    expect(agent.parentAgentId).not.toBe(agent.id);
  }
}

describe('parseSession — self-parent guard (C-6)', () => {
  it('directory: a workflow agent that dispatched its own workflow joins to main, not itself', () => {
    const SESSION = 'c6c60001-1111-4222-8333-444444444444';
    const HEX = 'c6c6c6c1';
    const result = parseSession(
      substrate([
        mainTranscript(SESSION),
        {
          path: `workflows/wf_self/agent-${HEX}.jsonl`,
          lines: [
            jline({
              sessionId: SESSION,
              agentId: HEX,
              type: 'assistant',
              timestamp: '2026-09-01T00:00:01.000Z',
              message: {
                id: 'm_c6_wf',
                model: 'm',
                usage: { input_tokens: 1 },
                content: [
                  {
                    type: 'tool_use',
                    id: 'toolu_c6_wf',
                    name: 'Workflow',
                    input: { workflow_id: 'wf_self', prompt: 'p' },
                  },
                ],
              },
            }),
          ],
        },
      ]),
    );

    expectNoSelfEdge(result);
    expect(result.agents.find((a) => a.id === HEX)?.parentAgentId).toBe(SESSION);
    expect(result.edges).toEqual([
      {
        sessionId: SESSION,
        parentAgentId: SESSION,
        childAgentId: HEX,
        source: 'directory',
        toolUseId: null,
      },
    ]);
  });

  it('tool_use: a sidecar anchor naming a block inside the child own transcript is not a parent', () => {
    const SESSION = 'c6c60002-1111-4222-8333-444444444444';
    const HEX = 'c6c6c6c2';
    const result = parseSession(
      substrate([
        mainTranscript(SESSION),
        {
          path: `subagents/agent-${HEX}.jsonl`,
          lines: [
            jline({
              sessionId: SESSION,
              agentId: HEX,
              type: 'assistant',
              timestamp: '2026-09-01T00:00:01.000Z',
              message: {
                id: 'm_c6_tu',
                model: 'm',
                usage: { input_tokens: 1 },
                content: [
                  {
                    type: 'tool_use',
                    id: 'toolu_c6_self',
                    name: 'Agent',
                    input: { subagent_type: 'self-typed', prompt: 'p' },
                  },
                ],
              },
            }),
          ],
        },
        {
          path: `subagents/agent-${HEX}.meta.json`,
          lines: [
            JSON.stringify({
              toolUseId: 'toolu_c6_self',
              agentType: 'sidecar-typed',
              spawnDepth: 1,
            }),
          ],
        },
      ]),
    );

    expectNoSelfEdge(result);
    // No foreign owner for the anchor -> the documented anchor-known/owner-unknown
    // path (re-anchor to main), with the type taken from the sidecar, not the
    // child's own spawn block.
    expect(result.agents.find((a) => a.id === HEX)).toMatchObject({
      parentAgentId: SESSION,
      subagentType: 'sidecar-typed',
    });
    expect(result.edges).toEqual([
      {
        sessionId: SESSION,
        parentAgentId: SESSION,
        childAgentId: HEX,
        source: 'task_notification',
        toolUseId: 'toolu_c6_self',
      },
    ]);
  });

  it('queue_operation: a queue record inside the child own transcript is not a parent', () => {
    const SESSION = 'c6c60003-1111-4222-8333-444444444444';
    const HEX = 'c6c6c6c3';
    const QUEUED = 'toolu_c6_queued';
    const result = parseSession(
      substrate([
        mainTranscript(SESSION),
        {
          path: `subagents/agent-${HEX}.jsonl`,
          lines: [
            jline({
              sessionId: SESSION,
              agentId: HEX,
              type: 'queue-operation',
              operation: 'enqueue',
              timestamp: '2026-09-01T00:00:01.000Z',
              content: `<task-notification><task-id>${HEX}</task-id><tool-use-id>${QUEUED}</tool-use-id></task-notification>`,
            }),
          ],
        },
      ]),
    );

    expectNoSelfEdge(result);
    expect(result.agents.find((a) => a.id === HEX)?.parentAgentId).toBe(SESSION);
    expect(result.edges).toEqual([
      {
        sessionId: SESSION,
        parentAgentId: SESSION,
        childAgentId: HEX,
        source: 'task_notification',
        toolUseId: QUEUED,
      },
    ]);
  });
});
