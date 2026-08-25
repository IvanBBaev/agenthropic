/**
 * Contract for {@link peekSubstrateSessionId} — the non-throwing look-ahead the
 * corpus runner uses to compare the session id a substrate's RECORDS declare
 * against the uuid its FILENAME declares before anything is written (review
 * L-4).
 *
 * Two properties carry the whole feature and are asserted here:
 *  1. it never throws — a non-JSON line, a non-object record and a record with
 *     no (or a non-string) `sessionId` are all skipped, so the pre-flight check
 *     can never become a second way for a session to fail;
 *  2. it agrees with {@link parseSession} on every shipped fixture — the peek
 *     and the derivation must not be able to drift apart, or the cross-check
 *     would compare against an id the writer never used.
 */
import { describe, expect, it } from 'vitest';
import { parseSession, peekSubstrateSessionId, type SessionSubstrate } from '../src/index';
import { getFixture, listFixtures } from '@agenthropic/test-fixtures';

function substrate(files: Array<{ path: string; lines: string[] }>): SessionSubstrate {
  return { files: files.map((f) => ({ relativePath: f.path, lines: f.lines })) };
}

describe('peekSubstrateSessionId', () => {
  it('returns the first declared sessionId, in substrate file order', () => {
    const input = substrate([
      {
        path: 'aaaa.jsonl',
        lines: [
          JSON.stringify({ sessionId: 'first', type: 'user' }),
          JSON.stringify({ sessionId: 'first', type: 'assistant' }),
        ],
      },
      { path: 'subagents/agent-abcd1234.jsonl', lines: [JSON.stringify({ sessionId: 'first' })] },
    ]);
    expect(peekSubstrateSessionId(input)).toBe('first');
  });

  it('skips blank lines, non-JSON lines, non-object records and sessionId-less records', () => {
    const input = substrate([
      {
        path: 'aaaa.jsonl',
        lines: [
          '',
          '   ',
          'not json {',
          '42',
          'null',
          '[{"sessionId":"in-an-array"}]',
          JSON.stringify({ type: 'user', message: { role: 'user', content: 'hi' } }),
          JSON.stringify({ sessionId: 'found-late' }),
        ],
      },
    ]);
    expect(peekSubstrateSessionId(input)).toBe('found-late');
  });

  it('ignores a non-string sessionId and keeps scanning', () => {
    const input = substrate([
      {
        path: 'aaaa.jsonl',
        lines: [JSON.stringify({ sessionId: 7 }), JSON.stringify({ sessionId: 'real' })],
      },
    ]);
    expect(peekSubstrateSessionId(input)).toBe('real');
  });

  it('falls through to a later file when earlier files declare nothing', () => {
    const input = substrate([
      { path: 'notes/other.json', lines: [JSON.stringify({ note: 'x' })] },
      {
        path: 'subagents/agent-abcd1234.jsonl',
        lines: [JSON.stringify({ sessionId: 'from-kid' })],
      },
    ]);
    expect(peekSubstrateSessionId(input)).toBe('from-kid');
  });

  it('abstains with null when no record declares a sessionId', () => {
    expect(peekSubstrateSessionId(substrate([]))).toBeNull();
    expect(peekSubstrateSessionId(substrate([{ path: 'aaaa.jsonl', lines: [] }]))).toBeNull();
    expect(
      peekSubstrateSessionId(substrate([{ path: 'aaaa.jsonl', lines: ['', '{"type":"user"}'] }])),
    ).toBeNull();
  });

  it('agrees with the id parseSession derives, on every shipped fixture', () => {
    for (const name of listFixtures()) {
      const fixture = getFixture(name);
      expect(peekSubstrateSessionId(fixture)).toBe(parseSession(fixture).sessionId);
    }
  });

  it('does not mutate the input substrate', () => {
    const fixture = getFixture('flat-tool-use');
    const before = JSON.stringify(fixture);
    peekSubstrateSessionId(fixture);
    expect(JSON.stringify(fixture)).toBe(before);
  });
});
