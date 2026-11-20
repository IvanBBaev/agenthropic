/**
 * QA-9c - the guards of the parser's join and usage-owner indices, pinned with
 * the malformed or decoy shapes that no fixture carries.
 *
 * Each case mixes a block or record into a scan that must NOT match it: a
 * non-`tool_result` block with `is_error`, a non-`tool_use` block named
 * `Agent`, an id-less `Workflow` block, an `Agent` block with a `workflow_id`,
 * a stray entry before the real `tool_result`, a non-`progress` record with a
 * top-level `agentId`, and a usage-less or non-assistant record that shares a
 * fork's `message.id`. Removing the matching guard in `parse-session.ts` makes
 * the case below fail (each was applied by hand, see the QA-9 mutation note).
 */
import { describe, expect, it } from 'vitest';
import {
  parseSession,
  UsageConflictError,
  type ParsedSession,
  type SessionSubstrate,
} from '../src/index';

function jline(record: Record<string, unknown>): string {
  return JSON.stringify(record);
}

function substrate(files: Array<{ path: string; lines: string[] }>): SessionSubstrate {
  return { files: files.map((f) => ({ relativePath: f.path, lines: f.lines })) };
}

function userLine(session: string, timestamp: string, extra: Record<string, unknown> = {}): string {
  return jline({
    sessionId: session,
    type: 'user',
    timestamp,
    message: { role: 'user', content: 'go' },
    ...extra,
  });
}

function assistantLine(
  session: string,
  timestamp: string,
  message: Record<string, unknown>,
  extra: Record<string, unknown> = {},
): string {
  return jline({ sessionId: session, type: 'assistant', timestamp, message, ...extra });
}

function childTranscript(session: string, hex: string): { path: string; lines: string[] } {
  return {
    path: `subagents/agent-${hex}.jsonl`,
    lines: [userLine(session, '2026-09-02T00:00:05.000Z', { agentId: hex })],
  };
}

function edgesOf(result: ParsedSession, childId: string) {
  return result.edges.filter((edge) => edge.childAgentId === childId);
}

function parentOf(result: ParsedSession, childId: string): string | null | undefined {
  return result.agents.find((agent) => agent.id === childId)?.parentAgentId;
}

describe('parseSession - spawn-block scan guards (QA-9c)', () => {
  it('reads an error result only from a tool_result block, never from another block type', () => {
    const SESSION = 'c9c90001-1111-4222-8333-444444444444';
    const HEX = 'c9c9c901';
    const TOOL_USE_ID = 'toolu_qa9c_err';
    const result = parseSession(
      substrate([
        {
          path: `${SESSION}.jsonl`,
          lines: [
            userLine(SESSION, '2026-09-02T00:00:00.000Z'),
            assistantLine(SESSION, '2026-09-02T00:00:01.000Z', {
              id: 'm_qa9c_err',
              model: 'm',
              usage: { input_tokens: 1 },
              content: [
                {
                  type: 'tool_use',
                  id: TOOL_USE_ID,
                  name: 'Agent',
                  input: { subagent_type: 'general-purpose', prompt: 'p' },
                },
              ],
            }),
            userLine(SESSION, '2026-09-02T00:00:02.000Z', {
              message: {
                role: 'user',
                content: [
                  // A decoy: the error shape on a block that is not a tool result.
                  {
                    type: 'text',
                    tool_use_id: TOOL_USE_ID,
                    is_error: true,
                    content: '[Request interrupted by user for tool use]',
                  },
                  { type: 'tool_result', tool_use_id: TOOL_USE_ID, content: 'done' },
                ],
              },
            }),
          ],
        },
        childTranscript(SESSION, HEX),
        {
          path: `subagents/agent-${HEX}.meta.json`,
          lines: [jline({ toolUseId: TOOL_USE_ID, agentType: 'general-purpose', spawnDepth: 1 })],
        },
      ]),
    );

    expect(edgesOf(result, HEX).map((edge) => edge.source)).toEqual(['tool_use']);
    expect(result.outcomes).toEqual([]);
  });

  it('indexes only tool_use blocks as spawns, not another block that carries an Agent name', () => {
    const SESSION = 'c9c90002-1111-4222-8333-444444444444';
    const HEX = 'c9c9c902';
    const BLOCK_ID = 'toolu_qa9c_text';
    const result = parseSession(
      substrate([
        {
          path: `${SESSION}.jsonl`,
          lines: [
            userLine(SESSION, '2026-09-02T00:00:00.000Z'),
            assistantLine(SESSION, '2026-09-02T00:00:01.000Z', {
              id: 'm_qa9c_text',
              model: 'm',
              usage: { input_tokens: 1 },
              content: [
                {
                  type: 'text',
                  text: 'x',
                  id: BLOCK_ID,
                  name: 'Agent',
                  input: { subagent_type: 'Explore' },
                },
              ],
            }),
          ],
        },
        childTranscript(SESSION, HEX),
        {
          path: `subagents/agent-${HEX}.meta.json`,
          lines: [jline({ toolUseId: BLOCK_ID, agentType: 'general-purpose', spawnDepth: 1 })],
        },
      ]),
    );

    // No materialized spawn block owns the anchor, so the tool_use path cannot
    // take it; the child falls through to a weaker path.
    expect(edgesOf(result, HEX).map((edge) => edge.source)).not.toContain('tool_use');
  });

  it('registers no workflow dispatcher for a Workflow block that has no id', () => {
    const SESSION = 'c9c90003-1111-4222-8333-444444444444';
    const DISPATCHER = 'c9c9d003';
    const HEX = 'c9c9c903';
    const result = parseSession(
      substrate([
        { path: `${SESSION}.jsonl`, lines: [userLine(SESSION, '2026-09-02T00:00:00.000Z')] },
        {
          path: `subagents/agent-${DISPATCHER}.jsonl`,
          lines: [
            assistantLine(
              SESSION,
              '2026-09-02T00:00:01.000Z',
              {
                id: 'm_qa9c_noid',
                model: 'm',
                usage: { input_tokens: 1 },
                content: [
                  { type: 'tool_use', name: 'Workflow', input: { workflow_id: 'wf_qa9c_noid' } },
                ],
              },
              { agentId: DISPATCHER },
            ),
          ],
        },
        {
          path: `subagents/workflows/wf_qa9c_noid/agent-${HEX}.jsonl`,
          lines: [userLine(SESSION, '2026-09-02T00:00:02.000Z', { agentId: HEX })],
        },
      ]),
    );

    // Without a known dispatcher a workflow agent joins to the main agent.
    expect(parentOf(result, HEX)).toBe(SESSION);
    expect(edgesOf(result, HEX).map((edge) => edge.source)).toEqual(['directory']);
  });

  it('registers a workflow dispatcher only for a Workflow block, not an Agent block', () => {
    const SESSION = 'c9c90004-1111-4222-8333-444444444444';
    const DISPATCHER = 'c9c9d004';
    const HEX = 'c9c9c904';
    const result = parseSession(
      substrate([
        { path: `${SESSION}.jsonl`, lines: [userLine(SESSION, '2026-09-02T00:00:00.000Z')] },
        {
          path: `subagents/agent-${DISPATCHER}.jsonl`,
          lines: [
            assistantLine(
              SESSION,
              '2026-09-02T00:00:01.000Z',
              {
                id: 'm_qa9c_agentwf',
                model: 'm',
                usage: { input_tokens: 1 },
                content: [
                  {
                    type: 'tool_use',
                    id: 'toolu_qa9c_agentwf',
                    name: 'Agent',
                    input: { subagent_type: 'general-purpose', workflow_id: 'wf_qa9c_agent' },
                  },
                ],
              },
              { agentId: DISPATCHER },
            ),
          ],
        },
        {
          path: `subagents/workflows/wf_qa9c_agent/agent-${HEX}.jsonl`,
          lines: [userLine(SESSION, '2026-09-02T00:00:02.000Z', { agentId: HEX })],
        },
      ]),
    );

    expect(parentOf(result, HEX)).toBe(SESSION);
  });

  it('joins a toolUseResult child by the tool_result block, skipping stray entries before it', () => {
    const SESSION = 'c9c90005-1111-4222-8333-444444444444';
    const HEX = 'c9c9c905';
    const WRONG_ID = 'toolu_qa9c_wrong';
    const REAL_ID = 'toolu_qa9c_real';
    const spawn = (id: string) => ({
      type: 'tool_use',
      id,
      name: 'Agent',
      input: { subagent_type: 'general-purpose', prompt: 'p' },
    });
    const result = parseSession(
      substrate([
        {
          path: `${SESSION}.jsonl`,
          lines: [
            userLine(SESSION, '2026-09-02T00:00:00.000Z'),
            assistantLine(SESSION, '2026-09-02T00:00:01.000Z', {
              id: 'm_qa9c_tur',
              model: 'm',
              usage: { input_tokens: 1 },
              content: [spawn(WRONG_ID), spawn(REAL_ID)],
            }),
            userLine(SESSION, '2026-09-02T00:00:02.000Z', {
              toolUseResult: { agentId: HEX },
              message: {
                role: 'user',
                content: [
                  'stray',
                  { type: 'text', text: 'x', tool_use_id: WRONG_ID },
                  { type: 'tool_result', tool_use_id: REAL_ID, content: 'async launched' },
                ],
              },
            }),
          ],
        },
        childTranscript(SESSION, HEX),
      ]),
    );

    expect(edgesOf(result, HEX)).toEqual([
      {
        sessionId: SESSION,
        parentAgentId: SESSION,
        childAgentId: HEX,
        source: 'tool_use',
        toolUseId: REAL_ID,
      },
    ]);
  });

  it('reads the legacy join key only from a progress record', () => {
    const SESSION = 'c9c90006-1111-4222-8333-444444444444';
    const HEX = 'c9c9c906';
    const result = parseSession(
      substrate([
        {
          path: `${SESSION}.jsonl`,
          lines: [
            userLine(SESSION, '2026-09-02T00:00:00.000Z'),
            // A top-level agentId on a record that is not a progress line.
            jline({
              sessionId: SESSION,
              type: 'system',
              subtype: 'informational',
              agentId: HEX,
              timestamp: '2026-09-02T00:00:01.000Z',
            }),
          ],
        },
        childTranscript(SESSION, HEX),
        { path: `subagents/agent-${HEX}.meta.json`, lines: [jline({ agentType: 'Explore' })] },
      ]),
    );

    expect(edgesOf(result, HEX)).toEqual([]);
    expect(parentOf(result, HEX)).toBeNull();
  });
});

describe('parseSession - usage-owner index and fork parents (QA-9c)', () => {
  const FORK = 'c9c9f0f0';

  function forkTranscript(session: string, messageId: string): { path: string; lines: string[] } {
    return {
      path: `subagents/agent-${FORK}.jsonl`,
      lines: [
        jline({
          sessionId: session,
          agentId: FORK,
          type: 'fork-context-ref',
          timestamp: '2026-09-02T00:00:03.000Z',
        }),
        assistantLine(
          session,
          '2026-09-02T00:00:04.000Z',
          {
            id: messageId,
            model: 'm',
            usage: { input_tokens: 3, output_tokens: 1 },
            content: [{ type: 'text', text: 'x' }],
          },
          { agentId: FORK, parentUuid: null },
        ),
      ],
    };
  }

  it('keeps a fork row whose id lives elsewhere only on a non-assistant record', () => {
    const SESSION = 'c9c90007-1111-4222-8333-444444444444';
    const MESSAGE_ID = 'm_qa9c_fork_user';
    const result = parseSession(
      substrate([
        {
          path: `${SESSION}.jsonl`,
          lines: [
            userLine(SESSION, '2026-09-02T00:00:00.000Z', {
              message: {
                role: 'user',
                id: MESSAGE_ID,
                content: 'go',
                usage: { input_tokens: 3, output_tokens: 1 },
              },
            }),
          ],
        },
        forkTranscript(SESSION, MESSAGE_ID),
      ]),
    );

    expect(result.usage.find((row) => row.messageId === MESSAGE_ID)?.agentId).toBe(FORK);
  });

  it('keeps a fork row whose id lives elsewhere only on a usage-less assistant record', () => {
    const SESSION = 'c9c90008-1111-4222-8333-444444444444';
    const MESSAGE_ID = 'm_qa9c_fork_nousage';
    const result = parseSession(
      substrate([
        {
          path: `${SESSION}.jsonl`,
          lines: [
            userLine(SESSION, '2026-09-02T00:00:00.000Z'),
            assistantLine(SESSION, '2026-09-02T00:00:01.000Z', {
              id: MESSAGE_ID,
              model: 'm',
              content: [{ type: 'text', text: 'x' }],
            }),
          ],
        },
        forkTranscript(SESSION, MESSAGE_ID),
      ]),
    );

    expect(result.usage.find((row) => row.messageId === MESSAGE_ID)?.agentId).toBe(FORK);
  });

  it('records a fork parent only for a fork: a non-fork sharing its parent id stays a conflict', () => {
    const SESSION = 'c9c90009-1111-4222-8333-444444444444';
    const HEX = 'c9c9c909';
    const TOOL_USE_ID = 'toolu_qa9c_nonfork';
    const MESSAGE_ID = 'm_qa9c_nonfork';
    const message = {
      id: MESSAGE_ID,
      model: 'm',
      usage: { input_tokens: 1 },
      content: [
        {
          type: 'tool_use',
          id: TOOL_USE_ID,
          name: 'Agent',
          input: { subagent_type: 'general-purpose', prompt: 'p' },
        },
      ],
    };
    const shared = substrate([
      {
        path: `${SESSION}.jsonl`,
        lines: [
          userLine(SESSION, '2026-09-02T00:00:00.000Z'),
          assistantLine(SESSION, '2026-09-02T00:00:01.000Z', message),
        ],
      },
      {
        path: `subagents/agent-${HEX}.jsonl`,
        lines: [assistantLine(SESSION, '2026-09-02T00:00:02.000Z', message, { agentId: HEX })],
      },
      {
        path: `subagents/agent-${HEX}.meta.json`,
        lines: [jline({ toolUseId: TOOL_USE_ID, agentType: 'general-purpose', spawnDepth: 1 })],
      },
    ]);

    // The child resolves to the main agent, but it is no fork: the shared id is
    // an attribution conflict, never a silently skipped inherited row.
    expect(() => parseSession(shared)).toThrow(UsageConflictError);
  });
});
