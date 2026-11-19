import { describe, expect, it } from 'vitest';
import { classifyOrphan, type OrphanEvidence } from './unanchorable-orphan';

const HEX = 'a0b1c2d3e4f5a6b7c';
const PROMPT = 'prompt-0001';

function jsonl(...records: unknown[]): string {
  return records.map((record) => `${JSON.stringify(record)}\n`).join('');
}

function evidence(overrides: Partial<OrphanEvidence> = {}): OrphanEvidence {
  return {
    hex: HEX,
    transcript: jsonl({ type: 'user', promptId: PROMPT, message: { content: 'go' } }),
    sidecar: JSON.stringify({ agentType: 'general-purpose' }),
    flat: true,
    foreign: [jsonl({ type: 'user', promptId: 'prompt-other', message: { content: 'hi' } })],
    ...overrides,
  };
}

function reason(overrides: Partial<OrphanEvidence>): string | undefined {
  const verdict = classifyOrphan(evidence(overrides));
  return verdict.unanchorable ? undefined : verdict.reason;
}

describe('classifyOrphan', () => {
  it('accepts an orphan whose turn and hex no foreign transcript mentions', () => {
    expect(classifyOrphan(evidence())).toEqual({ unanchorable: true });
    expect(classifyOrphan(evidence({ sidecar: undefined }))).toEqual({ unanchorable: true });
    expect(classifyOrphan(evidence({ foreign: [] }))).toEqual({ unanchorable: true });
  });

  it('skips malformed and non-object lines before the first record', () => {
    const transcript = `not json\n[1]\nnull\n${jsonl({ type: 'user', promptId: PROMPT })}`;
    expect(classifyOrphan(evidence({ transcript }))).toEqual({ unanchorable: true });
  });

  it('refuses a nested transcript: the directory is its parent', () => {
    expect(reason({ flat: false })).toMatch(/directory parent/);
  });

  it('refuses when the sidecar names an anchor or cannot be read', () => {
    expect(reason({ sidecar: JSON.stringify({ toolUseId: 'toolu_1' }) })).toMatch(/anchor/);
    expect(reason({ sidecar: '{not json' })).toMatch(/anchor/);
  });

  it('refuses a transcript without a complete first record', () => {
    expect(reason({ transcript: '' })).toMatch(/no complete first record/);
    expect(reason({ transcript: '{"type":"user","promptId":"p"}' })).toMatch(
      /no complete first record/,
    );
  });

  it('refuses a first record that carries a task notification', () => {
    const transcript = jsonl({
      type: 'user',
      promptId: PROMPT,
      message: { content: '<task-notification><tool-use-id>toolu_1</tool-use-id>' },
    });
    expect(reason({ transcript })).toMatch(/task notification/);
  });

  it('refuses when any foreign transcript mentions the child hex', () => {
    const foreign = [jsonl({ type: 'user', toolUseResult: { agentId: HEX } })];
    expect(reason({ foreign })).toMatch(/child hex/);
  });

  it('refuses a first record without a promptId', () => {
    expect(reason({ transcript: jsonl({ type: 'user' }) })).toMatch(/no promptId/);
    expect(reason({ transcript: jsonl({ type: 'user', promptId: '' }) })).toMatch(/no promptId/);
    expect(reason({ transcript: jsonl({ type: 'user', promptId: 7 }) })).toMatch(/no promptId/);
  });

  it('refuses when any foreign transcript carries the same turn, on any record type', () => {
    expect(reason({ foreign: [jsonl({ type: 'user', promptId: PROMPT })] })).toMatch(
      /same promptId/,
    );
    expect(reason({ foreign: [jsonl({ type: 'assistant', note: PROMPT })] })).toMatch(
      /same promptId/,
    );
  });
});
