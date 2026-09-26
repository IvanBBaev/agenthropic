/**
 * LABEL-ME claim renderer - every branch on synthetic substrates only.
 *
 * Nothing here touches spike/ or ~/.claude: the hand-built substrates below and
 * the shipped fixtures are invented records. The CLI wrapper in
 * annotations/tools/ is deliberately not spawned (the spawner gate forbids
 * child processes anywhere in the tree); `runRenderClaims` is driven directly
 * with an injected stdout/stderr and a temp package layout.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  EVICTED_TOOL_USE_ID,
  LEGACY_CHILD_HEX,
  LEGACY_DECOY_HEX,
  QUEUED_TASK_ID,
  QUEUED_TOOL_USE_ID,
  RENDER_DIR,
  SUBSTRATE_UNAVAILABLE,
  buildSpawnIndex,
  describeRecord,
  describeToolUseBlock,
  getFixture,
  isParserArtifact,
  previewContent,
  readClaimTemplate,
  renderClaims,
  renderIndexPage,
  resolveClaim,
  runRenderClaims,
  writeRender,
  type ClaimTemplate,
  type RenderIo,
  type SessionSubstrateLike,
  type TemplateClaim,
} from '../src/index';

const SESSION = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const TEMPLATE_SOURCE = 'synthetic.hierarchy.md';

// Hand-built substrate: one hex per branch of the mirrored join.
const HEX_EMPTY_CHILD = 'ab12cd34'; // empty transcript + empty sidecar, queue-operation join
const HEX_RESULT_ONLY = 'ab12cd36'; // legacy Explore sidecar, joined through toolUseResult
const HEX_PROGRESS_ONLY = 'ab12cd37'; // named by a progress record, but has no transcript
const HEX_WORKFLOW = 'ab12cd38'; // nested under wf_abc, whose dispatcher carries workflow_id
const HEX_BASH_ANCHOR = 'ab12cd39'; // sidecar toolUseId names a Bash block (not a spawn)
const HEX_GONE_ANCHOR = 'ab12cd3a'; // sidecar toolUseId names nothing at all
const HEX_BARE_EXPLORE = 'ab12cd3b'; // bare Explore sidecar, no progress record
const HEX_TAG_NO_ID = 'ab12cd3c'; // <task-notification> without a <tool-use-id>
const HEX_ARRAY_CONTENT = 'ab12cd3d'; // first record content is a block array
const HEX_WORKFLOW_UNMATCHED = 'ab12cd3e'; // nested under wf_none, which no block dispatches
const HEX_MISSING = 'deadbeef';

function must<T>(value: T | undefined | null): T {
  if (value === undefined || value === null) {
    throw new Error('expected a value');
  }
  return value;
}

function substrate(files: Record<string, readonly string[]>): SessionSubstrateLike {
  return { files: Object.entries(files).map(([relativePath, lines]) => ({ relativePath, lines })) };
}

function j(record: unknown): string {
  return JSON.stringify(record);
}

function claimsFor(hexes: readonly string[], sessionId = SESSION): ClaimTemplate {
  return {
    source: TEMPLATE_SOURCE,
    sessionId,
    substrateDir: 'corpus/synthetic',
    claims: hexes.map((hex, i): TemplateClaim => ({
      childAgentId: hex,
      line: 10 + i,
      slot: '__________',
      comment: i % 2 === 0 ? `general-purpose: claim ${String(i)}` : null,
      text: `${hex} <- __________`,
    })),
  };
}

function sessionIdOf(fixture: SessionSubstrateLike): string {
  const main = must(fixture.files.find((file) => !file.relativePath.includes('/')));
  return main.relativePath.slice(0, -'.jsonl'.length);
}

const HAND_BUILT = substrate({
  [`${SESSION}.jsonl`]: [
    '',
    'not json at all',
    '42',
    j({ type: 'assistant', message: { content: 'not an array' } }),
    j({
      type: 'assistant',
      uuid: 'u-main-5',
      message: {
        content: [
          'a bare string block',
          { type: 'text', text: 'dispatching' },
          { type: 'tool_use', name: 'Agent' },
          { type: 'tool_use', id: 'toolu_noname' },
          { type: 'tool_use', id: 'toolu_bash', name: 'Bash', input: { command: 'ls' } },
          {
            type: 'tool_use',
            id: 'toolu_agent',
            name: 'Agent',
            input: { subagent_type: 'Explore', description: 'look', prompt: 'p'.repeat(300) },
          },
          { type: 'tool_use', id: 'toolu_wf', name: 'Workflow', input: { workflow_id: 'wf_abc' } },
          { type: 'tool_use', id: 'toolu_wf2', name: 'Workflow', input: { prompt: 'batch' } },
        ],
      },
    }),
    j({ type: 'queue-operation', content: 42 }),
    j({ type: 'queue-operation', content: 'no ids in here' }),
    j({ type: 'queue-operation', content: '<tool-use-id>toolu_q1</tool-use-id>' }),
    j({
      type: 'queue-operation',
      content: `<task-notification><task-id>${HEX_EMPTY_CHILD}</task-id><tool-use-id>toolu_q2</tool-use-id></task-notification>`,
    }),
    j({ type: 'user', message: { content: [] } }),
    j({ type: 'user', toolUseResult: { agentId: 'ab12cd35' }, message: { content: 'text' } }),
    j({
      type: 'user',
      uuid: 'u-main-12',
      toolUseResult: { agentId: HEX_RESULT_ONLY },
      message: {
        content: [
          'string block',
          { type: 'text', text: 'ignored' },
          { type: 'tool_result' },
          { type: 'tool_result', tool_use_id: 'toolu_agent' },
        ],
      },
    }),
    j({ type: 'progress' }),
    j({ type: 'progress', agentId: SESSION }),
    j({ type: 'progress', agentId: HEX_PROGRESS_ONLY }),
    j({ type: 'system', subtype: 'compact_boundary' }),
  ],
  'journal.jsonl': [
    j({
      type: 'assistant',
      message: { content: [{ type: 'tool_use', id: 'toolu_journal', name: 'Agent', input: {} }] },
    }),
  ],
  'notes.txt': ['not a transcript'],
  'sub/other.jsonl': [j({ type: 'assistant' })],
  [`subagents/agent-${HEX_EMPTY_CHILD}.jsonl`]: ['', ''],
  [`subagents/agent-${HEX_EMPTY_CHILD}.meta.json`]: [''],
  [`subagents/agent-${HEX_RESULT_ONLY}.jsonl`]: [
    j({ type: 'user', uuid: 'u-child-1', message: { content: 'go' } }),
  ],
  [`subagents/agent-${HEX_RESULT_ONLY}.meta.json`]: [j({ agentType: 'Explore' })],
  [`subagents/workflows/wf_abc/agent-${HEX_WORKFLOW}.jsonl`]: [
    j({ type: 'user', message: { content: 'workflow child' } }),
  ],
  [`subagents/agent-${HEX_BASH_ANCHOR}.jsonl`]: [j({ type: 'user', message: { content: 'x' } })],
  [`subagents/agent-${HEX_BASH_ANCHOR}.meta.json`]: [
    j({ agentType: 'general-purpose', toolUseId: 'toolu_bash', spawnDepth: 1 }),
  ],
  [`subagents/agent-${HEX_GONE_ANCHOR}.jsonl`]: [j({ type: 'user', message: { content: 'x' } })],
  [`subagents/agent-${HEX_GONE_ANCHOR}.meta.json`]: [j({ toolUseId: 'toolu_gone', spawnDepth: 1 })],
  [`subagents/agent-${HEX_BARE_EXPLORE}.jsonl`]: [j({ type: 'user', message: { content: 'x' } })],
  [`subagents/agent-${HEX_BARE_EXPLORE}.meta.json`]: [j({ agentType: 'Explore' })],
  [`subagents/agent-${HEX_TAG_NO_ID}.jsonl`]: [
    j({ type: 'user', message: { content: '<task-notification>no id</task-notification>' } }),
  ],
  [`subagents/agent-${HEX_ARRAY_CONTENT}.jsonl`]: [
    j({ type: 'user', message: { content: [{ type: 'text', text: 'blocks' }] } }),
  ],
  [`subagents/workflows/wf_none/agent-${HEX_WORKFLOW_UNMATCHED}.jsonl`]: [
    j({ type: 'user', message: { content: 'unmatched workflow child' } }),
  ],
});

describe('readClaimTemplate', () => {
  it('reads meta and claim lines, blank or filled, and ignores prose elsewhere', () => {
    const text = [
      'Intro prose before any heading.',
      '',
      '## meta',
      `session: ${SESSION}`,
      'provenance: human',
      'substrate: session-tree:spike/corpus/sessions/x/data',
      'a note line without a colon',
      '',
      '## edges',
      '# a comment line',
      'aaaa0001 <- __________   # Explore: something',
      'bbbb0002 <- ROOT',
      'cccc0003 <- aaaa0001 # x | y',
      '',
      '## notes',
      'free prose here is fine',
    ].join('\n');
    const template = readClaimTemplate('t.hierarchy.md', text);
    expect(template.sessionId).toBe(SESSION);
    expect(template.substrateDir).toBe('spike/corpus/sessions/x/data');
    expect(template.claims).toEqual([
      {
        childAgentId: 'aaaa0001',
        line: 11,
        slot: '__________',
        comment: 'Explore: something',
        text: 'aaaa0001 <- __________   # Explore: something',
      },
      { childAgentId: 'bbbb0002', line: 12, slot: 'ROOT', comment: null, text: 'bbbb0002 <- ROOT' },
      {
        childAgentId: 'cccc0003',
        line: 13,
        slot: 'aaaa0001',
        comment: 'x | y',
        text: 'cccc0003 <- aaaa0001 # x | y',
      },
    ]);
  });

  it('rejects a line under ## edges that is not a claim', () => {
    const text = `## meta\nsession: ${SESSION}\nsubstrate: session-tree:d\n## edges\nthis is prose\n`;
    expect(() => readClaimTemplate('t.hierarchy.md', text)).toThrow(
      't.hierarchy.md:5: not a claim line: this is prose',
    );
  });

  it('requires a session line', () => {
    expect(() =>
      readClaimTemplate('t.hierarchy.md', '## meta\nsubstrate: session-tree:d\n'),
    ).toThrow("t.hierarchy.md: meta has no 'session:' line");
  });

  it('requires a session-tree substrate (a missing or fixture substrate has nothing to render)', () => {
    expect(() => readClaimTemplate('t.hierarchy.md', `## meta\nsession: ${SESSION}\n`)).toThrow(
      "substrate must be 'session-tree:<dir>' (got '')",
    );
    expect(() =>
      readClaimTemplate(
        't.hierarchy.md',
        `## meta\nsession: ${SESSION}\nsubstrate: fixture:depth-2-sync\n`,
      ),
    ).toThrow("substrate must be 'session-tree:<dir>' (got 'fixture:depth-2-sync')");
  });
});

describe('isParserArtifact', () => {
  it('admits agent transcripts, sidecars and journals anywhere; nothing else', () => {
    expect(isParserArtifact('agent-0123abcd.jsonl')).toBe(true);
    expect(isParserArtifact('subagents/agent-0123abcd.meta.json')).toBe(true);
    expect(isParserArtifact('subagents/workflows/wf_x/journal.jsonl')).toBe(true);
    expect(isParserArtifact('tool-results/toolu_x.txt')).toBe(false);
    expect(isParserArtifact('notes.md')).toBe(false);
    expect(isParserArtifact('agent-xyz.jsonl')).toBe(false);
  });
});

describe('buildSpawnIndex', () => {
  const index = buildSpawnIndex(SESSION, HAND_BUILT);

  it('records every non-JSON line with its file:line and skips it', () => {
    expect(index.unparseableLines).toEqual([`${SESSION}.jsonl:2`, `${SESSION}.jsonl:3`]);
    expect(index.fileCount).toBe(HAND_BUILT.files.length);
  });

  it('indexes tool_use blocks the way the parser does: only Agent/Workflow are spawns', () => {
    expect([...index.toolUseBlocks.keys()].sort()).toEqual([
      'toolu_agent',
      'toolu_bash',
      'toolu_noname',
      'toolu_wf',
      'toolu_wf2',
    ]);
    expect(must(index.toolUseBlocks.get('toolu_noname')).name).toBe('');
    expect([...index.spawnBlocks.keys()].sort()).toEqual(['toolu_agent', 'toolu_wf', 'toolu_wf2']);
    expect(must(index.spawnBlocks.get('toolu_agent')).line).toBe(5);
    expect([...index.workflowDispatchers.keys()]).toEqual(['wf_abc']);
    // A top-level journal.jsonl and nested non-agent files are never transcripts.
    expect(index.toolUseBlocks.has('toolu_journal')).toBe(false);
  });

  it('indexes queue operations, tool results and foreign progress records', () => {
    expect([...index.queueOps.keys()].sort()).toEqual(['toolu_q1', 'toolu_q2']);
    expect([...index.queueChildToToolUse.entries()]).toEqual([[HEX_EMPTY_CHILD, 'toolu_q2']]);
    expect([...index.toolUseResultByChildHex.keys()]).toEqual([HEX_RESULT_ONLY]);
    expect(must(index.toolUseResultByChildHex.get(HEX_RESULT_ONLY)).toolUseId).toBe('toolu_agent');
    expect([...index.legacyProgressOwner.keys()]).toEqual([HEX_PROGRESS_ONLY]);
  });

  it('keeps agents (with their workflow dir) and sidecars, empty ones included', () => {
    expect(must(index.agents.get(HEX_WORKFLOW)).workflowId).toBe('wf_abc');
    expect(must(index.agents.get(HEX_EMPTY_CHILD))).toMatchObject({
      workflowId: null,
      firstRecord: null,
    });
    expect(must(index.sidecars.get(HEX_EMPTY_CHILD))).toMatchObject({
      record: null,
      toolUseId: null,
      agentType: null,
      isLegacyBareExplore: false,
    });
    expect(must(index.sidecars.get(HEX_RESULT_ONLY)).isLegacyBareExplore).toBe(true);
    expect(must(index.sidecars.get(HEX_BASH_ANCHOR))).toMatchObject({
      toolUseId: 'toolu_bash',
      isLegacyBareExplore: false,
    });
    expect(must(index.sidecars.get(HEX_GONE_ANCHOR))).toMatchObject({
      toolUseId: 'toolu_gone',
      agentType: null,
    });
  });
});

describe('resolveClaim mirrors resolveParent', () => {
  it('tool_use through the sidecar toolUseId, at depth 1 and depth 2', () => {
    const fixture = getFixture('depth-2-sync');
    const index = buildSpawnIndex(sessionIdOf(fixture), fixture);
    const depth1 = resolveClaim(index, 'd1d1a001');
    expect(depth1).toMatchObject({ kind: 'tool_use', parserParent: 'ROOT' });
    expect(depth1.parentBlock).not.toBeNull();
    const depth2 = resolveClaim(index, 'd2d2b002');
    expect(depth2).toMatchObject({ kind: 'tool_use', parserParent: 'd1d1a001' });
    expect(must(depth2.parent).file).toContain('agent-d1d1a001.jsonl');
    expect(depth2.steps.join('\n')).toContain('depth-2 parent - write that hex');
  });

  it('queue_operation through the <task-id> of a queue-operation record', () => {
    const fixture = getFixture('queue-operation');
    const index = buildSpawnIndex(sessionIdOf(fixture), fixture);
    const claim = resolveClaim(index, QUEUED_TASK_ID);
    expect(claim).toMatchObject({
      kind: 'queue_operation',
      parserParent: 'ROOT',
      anchor: QUEUED_TOOL_USE_ID,
      parentBlock: null,
    });
    expect(claim.steps.join('\n')).toContain('carries no toolUseId');
  });

  it('task_notification through the child-side <task-notification> (no sidecar at all)', () => {
    const fixture = getFixture('task-notification-recovery');
    const index = buildSpawnIndex(sessionIdOf(fixture), fixture);
    const claim = resolveClaim(index, 'c0ffee42');
    expect(claim).toMatchObject({
      kind: 'task_notification',
      parserParent: 'ROOT',
      anchor: EVICTED_TOOL_USE_ID,
      parent: null,
      sidecar: null,
    });
    expect(claim.steps.join('\n')).toContain('no agent-<hex>.meta.json sidecar');
  });

  it('legacy_explore through a foreign progress record; a decoy hex without a transcript is missing', () => {
    const fixture = getFixture('legacy-bare-explore');
    const index = buildSpawnIndex(sessionIdOf(fixture), fixture);
    const claim = resolveClaim(index, LEGACY_CHILD_HEX);
    expect(claim).toMatchObject({
      kind: 'legacy_explore',
      parserParent: 'ROOT',
      parentBlock: null,
    });
    expect(must(claim.parent).record['type']).toBe('progress');
    expect(resolveClaim(index, LEGACY_DECOY_HEX)).toMatchObject({
      kind: 'child_missing',
      parserParent: null,
      child: null,
      childFile: null,
      evidence: [],
    });
  });

  it('directory without a dispatcher: ROOT by layout, candidate Workflow blocks listed but not matched', () => {
    const fixture = getFixture('nested-workflow');
    const index = buildSpawnIndex(sessionIdOf(fixture), fixture);
    const claim = resolveClaim(index, 'deadbe01');
    expect(claim).toMatchObject({ kind: 'directory', parserParent: 'ROOT', parent: null });
    expect(claim.steps.join('\n')).toContain('falls back to the main session by directory alone');
    expect(claim.evidence.some((e) => e.what.includes('NOT match'))).toBe(true);
  });

  it('directory with a dispatcher: the Workflow block carrying workflow_id is the parent record', () => {
    const index = buildSpawnIndex(SESSION, HAND_BUILT);
    const claim = resolveClaim(index, HEX_WORKFLOW);
    expect(claim).toMatchObject({ kind: 'directory', parserParent: 'ROOT' });
    expect(must(claim.parentBlock)['id']).toBe('toolu_wf');
    expect(claim.steps.join('\n')).toContain('input.workflow_id = wf_abc');
  });

  it('directory without a dispatcher lists only the Workflow blocks as candidates', () => {
    const index = buildSpawnIndex(SESSION, HAND_BUILT);
    const claim = resolveClaim(index, HEX_WORKFLOW_UNMATCHED);
    expect(claim).toMatchObject({ kind: 'directory', parserParent: 'ROOT', parent: null });
    const candidates = claim.evidence.filter((e) => e.what.includes('NOT match'));
    expect(candidates.map((e) => e.what.includes('toolu_wf'))).toEqual([true, true]);
  });

  it('orphan when no join path exists (no main transcript, no sidecar)', () => {
    const fixture = getFixture('usage-dedup');
    const index = buildSpawnIndex('00000000-0000-4000-8000-000000000000', fixture);
    const claim = resolveClaim(index, 'facade07');
    expect(claim).toMatchObject({ kind: 'orphan', parserParent: null, parent: null, anchor: null });
    expect(claim.steps.at(-1)).toContain('NO edge');
  });

  const handBuilt = buildSpawnIndex(SESSION, HAND_BUILT);

  it('toolUseResult.agentId leads to the spawn block when the sidecar has no toolUseId', () => {
    const claim = resolveClaim(handBuilt, HEX_RESULT_ONLY);
    expect(claim).toMatchObject({ kind: 'tool_use', parserParent: 'ROOT', anchor: 'toolu_agent' });
    expect(claim.steps.join('\n')).toContain(`toolUseResult.agentId = ${HEX_RESULT_ONLY}`);
    expect(must(claim.sidecar).record).toEqual({ agentType: 'Explore' });
  });

  it('queue_operation via <task-id> for an empty transcript with an empty sidecar', () => {
    const claim = resolveClaim(handBuilt, HEX_EMPTY_CHILD);
    expect(claim).toMatchObject({
      kind: 'queue_operation',
      anchor: 'toolu_q2',
      child: null,
      childFile: `subagents/agent-${HEX_EMPTY_CHILD}.jsonl`,
      sidecar: null,
    });
    expect(claim.steps.join('\n')).toContain('holds no JSON record');
  });

  it('a sidecar anchor naming a non-spawn block re-anchors to ROOT and says the block exists', () => {
    const claim = resolveClaim(handBuilt, HEX_BASH_ANCHOR);
    expect(claim).toMatchObject({
      kind: 'task_notification',
      parserParent: 'ROOT',
      anchor: 'toolu_bash',
    });
    expect(claim.steps.join('\n')).toContain('DOES exist');
    expect(claim.evidence.some((e) => e.what.includes("named 'Bash'"))).toBe(true);
  });

  it('a sidecar anchor naming nothing re-anchors to ROOT with no extra evidence', () => {
    const claim = resolveClaim(handBuilt, HEX_GONE_ANCHOR);
    expect(claim).toMatchObject({
      kind: 'task_notification',
      parserParent: 'ROOT',
      anchor: 'toolu_gone',
    });
    expect(claim.evidence.map((e) => e.what)).toEqual(["the child's first record", 'the sidecar']);
  });

  it('a bare Explore sidecar without a progress record ends as orphan', () => {
    const claim = resolveClaim(handBuilt, HEX_BARE_EXPLORE);
    expect(claim.kind).toBe('orphan');
    expect(claim.steps.join('\n')).toContain('but no foreign progress record');
  });

  it('a <task-notification> without a tool-use-id recovers nothing; block-array content likewise', () => {
    expect(resolveClaim(handBuilt, HEX_TAG_NO_ID).kind).toBe('orphan');
    expect(resolveClaim(handBuilt, HEX_ARRAY_CONTENT).kind).toBe('orphan');
  });
});

describe('record previews', () => {
  it('truncates strings to about 200 chars and summarises block arrays', () => {
    const long = previewContent('x'.repeat(300));
    expect(long).toHaveLength(203);
    expect(long?.endsWith('...')).toBe(true);
    expect(previewContent('short  and\n spaced')).toBe('short and spaced');
    expect(
      previewContent([
        'str',
        { type: 'text', text: 'hi' },
        { type: 'text' },
        { type: 'tool_use' },
        { type: 'tool_use', name: 'Agent', id: 't1' },
        { type: 'tool_result' },
        { type: 'tool_result', tool_use_id: 't1' },
        { type: 'image' },
        {},
      ]),
    ).toBe(
      'str | text: hi | text: | tool_use ? ? | tool_use Agent t1 | tool_result ? | tool_result t1 | image | ?',
    );
    expect(previewContent(undefined)).toBeNull();
    expect(previewContent(42)).toBeNull();
  });

  it('describeRecord keeps the identifying fields only', () => {
    expect(
      describeRecord({
        uuid: 'u1',
        parentUuid: 'u0',
        timestamp: 't',
        type: 'user',
        agentId: 'ab12cd34',
        isSidechain: true,
        sessionId: SESSION,
        toolUseResult: { agentId: 'ab12cd34', bulky: 'dropped' },
        message: { role: 'user', content: 'hello' },
        extra: 'dropped',
      }),
    ).toEqual({
      uuid: 'u1',
      parentUuid: 'u0',
      timestamp: 't',
      type: 'user',
      agentId: 'ab12cd34',
      isSidechain: true,
      sessionId: SESSION,
      'toolUseResult.agentId': 'ab12cd34',
      contentPreview: 'hello',
    });
    expect(describeRecord({ type: 'queue-operation', content: 'c', toolUseResult: {} })).toEqual({
      type: 'queue-operation',
      contentPreview: 'c',
    });
    expect(describeRecord({ type: 'system' })).toEqual({ type: 'system' });
  });

  it('describeToolUseBlock shows the labeled input fields, a truncated prompt and the key list', () => {
    expect(describeToolUseBlock({ type: 'tool_use', id: 't', name: 'Agent' })).toEqual({
      type: 'tool_use',
      id: 't',
      name: 'Agent',
    });
    const shown = describeToolUseBlock({
      type: 'tool_use',
      id: 't',
      name: 'Agent',
      input: { subagent_type: 'Explore', description: 'd', prompt: 'p'.repeat(300), other: 1 },
    });
    expect(shown['inputKeys']).toEqual(['subagent_type', 'description', 'prompt', 'other']);
    expect(shown['input']).toMatchObject({ subagent_type: 'Explore', description: 'd' });
    expect(String((shown['input'] as Record<string, unknown>)['prompt'])).toHaveLength(203);
    expect(
      describeToolUseBlock({ type: 'tool_use', id: 't', name: 'Bash', input: { command: 'ls' } }),
    ).toEqual({ type: 'tool_use', id: 't', name: 'Bash', input: {}, inputKeys: ['command'] });
  });
});

describe('renderClaims pages', () => {
  const fixture = getFixture('depth-2-sync');
  const rendered = renderClaims(
    claimsFor(['d1d1a001', 'd2d2b002', HEX_MISSING], sessionIdOf(fixture)),
    fixture,
  );

  it('counts records found and missing', () => {
    expect(rendered.stats).toEqual({
      claims: 3,
      bothRecordsFound: 2,
      childMissing: 1,
      parentRecordAbsent: 0,
    });
  });

  it('a found claim shows child, sidecar, parent record, matched block, join path and evidence', () => {
    const page = must(rendered.claims[1]).page;
    expect(page).toContain(`# Claim \`d2d2b002\` - ${TEMPLATE_SOURCE} line 11`);
    expect(page).toContain('d2d2b002 <- ROOT | <parent hex> | ORPHAN | UNKNOWN');
    expect(page).toContain('Parser reading: **d1d1a001** via `tool_use`');
    expect(page).toContain('## Child record');
    expect(page).toContain('## Sidecar');
    expect(page).toContain('(owner: d1d1a001)');
    expect(page).toContain('Matched block:');
    expect(page).toContain('1. child transcript subagents/agent-d2d2b002.jsonl (flat layout)');
    expect(page).toContain("- `subagents/agent-d2d2b002.jsonl:1` - the child's first record");
    expect(page).not.toContain('_none_');
    expect(must(rendered.claims[0]).page).toContain('(owner: ROOT)');
  });

  it('a claim whose transcript does not exist says so instead of crashing', () => {
    const page = must(rendered.claims[2]).page;
    expect(page).toContain('**Child transcript not found.**');
    expect(page).toContain('write `UNKNOWN` unless you can locate the transcript by hand');
    expect(page).toContain('Parser reading: **ORPHAN (no edge)** via `child_missing`');
    expect(page).toContain('_No parent-side record: the child transcript itself was not found');
    expect(page).toContain('_none_');
  });

  it('explains every kind of absent parent record', () => {
    const nested = getFixture('nested-workflow');
    const directory = renderClaims(claimsFor(['deadbe01'], sessionIdOf(nested)), nested);
    expect(must(directory.claims[0]).page).toContain(
      'workflow subagents are joined by directory alone',
    );
    expect(directory.stats.parentRecordAbsent).toBe(1);

    const recovery = getFixture('task-notification-recovery');
    const notification = renderClaims(claimsFor(['c0ffee42'], sessionIdOf(recovery)), recovery);
    expect(must(notification.claims[0]).page).toContain(
      'the anchor names no surviving parent-side record',
    );
    expect(must(notification.claims[0]).page).not.toContain('## Sidecar');

    const handBuilt = renderClaims(claimsFor([HEX_BARE_EXPLORE, HEX_EMPTY_CHILD]), HAND_BUILT);
    expect(must(handBuilt.claims[0]).page).toContain(
      'the parser emits no edge, i.e. its answer is ORPHAN',
    );
    expect(must(handBuilt.claims[1]).page).toContain('holds no JSON record.**');
    expect(handBuilt.stats).toEqual({
      claims: 2,
      bothRecordsFound: 1,
      childMissing: 0,
      parentRecordAbsent: 1,
    });
  });

  it('the index lists every claim with a verdict box, the parser reading and a page link', () => {
    const index = rendered.index;
    expect(index).toContain(
      'Claims: 3 - both records found: 2 - child transcript missing: 1 - parent record absent: 0.',
    );
    expect(index).toContain(
      '| [ ] | 1 | `d1d1a001` | 10 | tool_use | ROOT | both | general-purpose: claim 0 | [page](claims/d1d1a001.md) |',
    );
    expect(index).toContain(
      '| [ ] | 2 | `d2d2b002` | 11 | tool_use | d1d1a001 | both |  | [page](claims/d2d2b002.md) |',
    );
    expect(index).toContain(
      `| [ ] | 3 | \`${HEX_MISSING}\` | 12 | child_missing | ORPHAN (no edge) | child missing |`,
    );
    expect(index).not.toContain('not JSON objects');
  });

  it('the index escapes pipes in comments and reports unparseable lines, capped at ten', () => {
    const template: ClaimTemplate = {
      ...claimsFor([]),
      claims: [
        { childAgentId: 'ab12cd34', line: 9, slot: '__________', comment: 'a | b', text: 'x' },
      ],
    };
    const few = renderIndexPage(template, [], buildSpawnIndex(SESSION, HAND_BUILT), {
      claims: 0,
      bothRecordsFound: 0,
      childMissing: 0,
      parentRecordAbsent: 0,
    });
    expect(few).toContain(
      `**2 line(s) are not JSON objects and were skipped** (the parser itself would refuse this session with a SubstrateError): ${SESSION}.jsonl:2, ${SESSION}.jsonl:3\n`,
    );
    expect(few).not.toContain(', ...');

    const noisy = substrate({ [`${SESSION}.jsonl`]: Array.from({ length: 11 }, () => 'bad') });
    const many = renderClaims(template, noisy);
    expect(many.index).toContain('**11 line(s) are not JSON objects');
    expect(many.index).toContain(', ...');
    expect(many.index).toContain('| a \\| b |');
  });
});

describe('runRenderClaims', () => {
  let root: string;
  const packageDir = (): string => join(root, 'pkg');
  const templatesDir = (): string => join(root, 'pkg', 'annotations', 'templates');

  function writeSessionTree(dir: string, fixture: SessionSubstrateLike): string {
    const sessionId = sessionIdOf(fixture);
    for (const file of fixture.files) {
      const target = file.relativePath.includes('/')
        ? join(dir, sessionId, file.relativePath)
        : join(dir, file.relativePath);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, file.lines.join('\n'), 'utf8');
    }
    return sessionId;
  }

  function writeTemplate(
    id: string,
    sessionId: string,
    substrateDir: string,
    claims: readonly string[],
  ): void {
    writeFileSync(
      join(templatesDir(), `${id}.hierarchy.md`),
      [
        '# template',
        '',
        '## meta',
        `session: ${sessionId}`,
        'provenance: human',
        `substrate: session-tree:${substrateDir}`,
        'labeled-by: __________',
        'labeled-on: __________',
        '',
        '## edges',
        ...claims.map((hex) => `${hex} <- __________   # general-purpose: synthetic`),
        '',
      ].join('\n'),
      'utf8',
    );
  }

  function run(argv: readonly string[]): { code: number; stdout: string[]; stderr: string[] } {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const io: RenderIo = {
      packageDir: packageDir(),
      repoRoot: root,
      stdout: (line) => {
        stdout.push(line);
      },
      stderr: (line) => {
        stderr.push(line);
      },
    };
    return { code: runRenderClaims(argv, io), stdout, stderr };
  }

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'render-claims-'));
    mkdirSync(templatesDir(), { recursive: true });
    const sessionId = writeSessionTree(join(root, 'corpus', 'depth2'), getFixture('depth-2-sync'));
    writeTemplate('depth2', sessionId, 'corpus/depth2', ['d1d1a001', 'd2d2b002', HEX_MISSING]);
    writeTemplate('absolute', sessionId, join(root, 'corpus', 'depth2'), ['d1d1a001']);
    writeTemplate('nowhere', sessionId, 'spike/corpus/sessions/nowhere/data', ['d1d1a001']);
  });

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('renders index and one page per claim into annotations/.render/<id>/', () => {
    const result = run(['depth2']);
    expect(result.code).toBe(0);
    const outDir = join(packageDir(), RENDER_DIR, 'depth2');
    expect(RENDER_DIR).toBe(join('annotations', '.render'));
    expect(result.stdout).toEqual([
      `rendered 3 claims -> ${outDir}`,
      'both records found: 2; child transcript missing: 1; parent record absent: 0',
    ]);
    expect(result.stderr).toEqual([]);
    expect(readFileSync(join(outDir, 'index.md'), 'utf8')).toContain('[page](claims/d2d2b002.md)');
    expect(readFileSync(join(outDir, 'claims', 'd2d2b002.md'), 'utf8')).toContain('via `tool_use`');
    expect(readFileSync(join(outDir, 'claims', `${HEX_MISSING}.md`), 'utf8')).toContain(
      'Child transcript not found',
    );
  });

  it('drops the literal -- that pnpm forwards before the template id', () => {
    expect(run(['--', 'depth2']).code).toBe(0);
    expect(run(['--']).code).toBe(2);
    expect(run(['--', 'a', 'b']).code).toBe(2);
  });

  it('accepts an absolute substrate directory', () => {
    const result = run(['absolute']);
    expect(result.code).toBe(0);
    expect(existsSync(join(packageDir(), RENDER_DIR, 'absolute', 'claims', 'd1d1a001.md'))).toBe(
      true,
    );
  });

  it('prints exactly "substrate unavailable" and exits 1 when the session tree is not here', () => {
    const result = run(['nowhere']);
    expect(result.code).toBe(1);
    expect(result.stdout).toEqual([SUBSTRATE_UNAVAILABLE]);
    expect(must(result.stderr[0])).toMatch(
      /^substrate unavailable: .*nowhere.* is not on this machine$/,
    );
    expect(existsSync(join(packageDir(), RENDER_DIR, 'nowhere'))).toBe(false);
  });

  it('exits 2 on usage errors and on a template that does not exist', () => {
    expect(run([])).toMatchObject({ code: 2, stdout: [] });
    expect(must(run([]).stderr[0])).toContain('usage: render-claims <template-id>');
    expect(run(['a', 'b']).code).toBe(2);
    const missing = run(['no-such-template']);
    expect(missing.code).toBe(2);
    expect(must(missing.stderr[0])).toContain('template not found: ');
    expect(must(missing.stderr[0])).toContain('no-such-template.hierarchy.md');
  });

  it('writeRender creates the claims directory on its own', () => {
    const fixture = getFixture('flat-tool-use');
    const outDir = join(root, 'direct');
    writeRender(outDir, renderClaims(claimsFor(['3fa9c2d1'], sessionIdOf(fixture)), fixture));
    expect(existsSync(join(outDir, 'claims', '3fa9c2d1.md'))).toBe(true);
    expect(existsSync(join(outDir, 'index.md'))).toBe(true);
  });
});
