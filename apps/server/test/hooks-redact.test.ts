/**
 * WP-IN14 - redaction at the ingest boundary: secret-named fields and
 * credential-shaped string values are masked before persistence; token-count
 * fields survive; the function is pure.
 */
import { describe, expect, it } from 'vitest';
import {
  REDACTED,
  isSecretKeyName,
  maskCredentialShapes,
  redactSecrets,
} from '../src/hooks/redact';

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null) {
    for (const entry of Object.values(value)) {
      deepFreeze(entry);
    }
    Object.freeze(value);
  }
  return value;
}

describe('isSecretKeyName (WP-IN14)', () => {
  it('matches secret patterns across naming conventions', () => {
    for (const key of [
      'token',
      'api_key',
      'Api-Key',
      'apiKey',
      'AUTHORIZATION',
      'password',
      'passwd',
      'client_secret',
      'bearer',
      'private_key',
      'access_key',
      'session key',
      'cookie',
      'my_refresh_token',
      'credentials',
    ]) {
      expect(isSecretKeyName(key), key).toBe(true);
    }
  });

  it('does not match ordinary fields', () => {
    for (const key of ['session_id', 'hook_event_name', 'transcript_path', 'cwd', 'model']) {
      expect(isSecretKeyName(key), key).toBe(false);
    }
  });

  it('allowlists token-COUNT fields (observability data, not credentials)', () => {
    for (const key of [
      'input_tokens',
      'output_tokens',
      'cache_read_input_tokens',
      'cache_creation_input_tokens',
      'total_tokens',
      'max_tokens',
      'tokens',
    ]) {
      expect(isSecretKeyName(key), key).toBe(false);
    }
  });
});

describe('maskCredentialShapes (WP-IN14)', () => {
  it('masks API-key/JWT/bearer shapes inside prose, leaving the rest intact', () => {
    const jwt =
      'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.TJVA95OrM7E2cBab30RMHrHDcEfxjoYZgeFONFh7HgQ';
    const cases: ReadonlyArray<[string, string]> = [
      ['key sk-ant-api03-abc123def456 used', `key ${REDACTED} used`],
      ['ghp_0123456789abcdef0123456789abcdef01 pushed', `${REDACTED} pushed`],
      ['github_pat_11ABCDEFG0123456789_abcdef done', `${REDACTED} done`],
      ['slack xoxb-1234567890-abcdef', `slack ${REDACTED}`],
      ['aws AKIAIOSFODNN7EXAMPLE key', `aws ${REDACTED} key`],
      [`jwt ${jwt} end`, `jwt ${REDACTED} end`],
      ['header Bearer abc123.def-456 sent', `header ${REDACTED} sent`],
    ];
    for (const [input, expected] of cases) {
      expect(maskCredentialShapes(input)).toBe(expected);
    }
  });

  it('leaves ordinary strings untouched', () => {
    for (const text of [
      'plain prose about tasks',
      '/Users/ivan/project/file.ts',
      'skate is not a key',
      'session 3f9c2a10-aaaa-bbbb-cccc-121212121212',
    ]) {
      expect(maskCredentialShapes(text)).toBe(text);
    }
  });
});

describe('redactSecrets (WP-IN14)', () => {
  it('replaces secret-named fields whatever the value type', () => {
    const input = deepFreeze({
      api_key: 'sk-live-whatever',
      password: 12345,
      credentials: { user: 'ivan', pass: 'x' },
      safe: 'kept',
    });
    expect(redactSecrets(input)).toEqual({
      api_key: REDACTED,
      password: REDACTED,
      credentials: REDACTED,
      safe: 'kept',
    });
  });

  it('recurses through nested objects and arrays (mixed)', () => {
    const input = deepFreeze({
      level1: {
        items: [
          { name: 'ok', token: 'abcd' },
          'contains sk-ant-api03-secretsecret inside',
          42,
          [{ Authorization: 'Bearer zzz' }],
        ],
        session_id: 's-1',
      },
    });
    expect(redactSecrets(input)).toEqual({
      level1: {
        items: [
          { name: 'ok', token: REDACTED },
          `contains ${REDACTED} inside`,
          42,
          [{ Authorization: REDACTED }],
        ],
        session_id: 's-1',
      },
    });
  });

  it('preserves token-count fields and scalars', () => {
    const usage = deepFreeze({
      input_tokens: 100,
      output_tokens: 25,
      cache_read_input_tokens: 4000,
      done: true,
      note: null,
    });
    expect(redactSecrets(usage)).toEqual(usage);
  });

  it('passes through non-object values, masking only string shapes', () => {
    expect(redactSecrets(7)).toBe(7);
    expect(redactSecrets(null)).toBeNull();
    expect(redactSecrets(true)).toBe(true);
    expect(redactSecrets('uses sk-abc123def456 here')).toBe(`uses ${REDACTED} here`);
  });

  it('is pure: never mutates its (frozen) input and returns new structures', () => {
    const input = deepFreeze({ nested: { token: 'x', list: [{ secret: 'y' }] } });
    const output = redactSecrets(input) as Record<string, unknown>;
    expect(output).not.toBe(input);
    expect(input.nested.token).toBe('x');
    expect(input.nested.list[0]?.secret).toBe('y');
  });
});
