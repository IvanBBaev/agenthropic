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
      'passphrase',
      'ssh_pass_phrase',
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
    // Joined at run time: a whole JWT literal on one source line is itself a
    // secret shape, and the repository's secret scanner would flag the test.
    const jwt = [
      'eyJhbGciOiJIUzI1NiJ9',
      'eyJzdWIiOiIxMjM0NTY3ODkwIn0',
      'TJVA95OrM7E2cBab30RMHrHDcEfxjoYZgeFONFh7HgQ',
    ].join('.');
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

  it('masks a PEM private-key block whole, closed or cut off (SEC-5)', () => {
    // A pasted key is the one credential whose body matches no prefix shape:
    // the armour lines are the signature, and the body between them must go
    // with them. A block whose END line was cut off (a truncated paste) is
    // masked to the end of the string rather than left in the clear.
    // The armour lines are assembled at run time: a source line holding a whole
    // private-key marker would trip the repository's secret scanner at commit.
    const armour = (edge: 'BEGIN' | 'END', ...kind: readonly string[]): string =>
      `-----${edge} ${[...kind, 'PRIVATE', 'KEY'].join(' ')}-----`;
    const body = 'MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC7\nq2Zz9w==';
    const closed = `cert ${armour('BEGIN', 'RSA')}\n${body}\n${armour('END', 'RSA')} end`;
    expect(maskCredentialShapes(closed)).toBe(`cert ${REDACTED} end`);
    const generic = `${armour('BEGIN')}\n${body}\n${armour('END')}`;
    expect(maskCredentialShapes(generic)).toBe(REDACTED);
    const cut = `cert ${armour('BEGIN', 'OPENSSH')}\n${body}`;
    expect(maskCredentialShapes(cut)).toBe(`cert ${REDACTED}`);
    // A public-key or certificate block is not a credential and stays.
    const pub = '-----BEGIN PUBLIC KEY-----\nAAAA\n-----END PUBLIC KEY-----';
    expect(maskCredentialShapes(pub)).toBe(pub);
  });

  it('masks the value of a secret-named shell / env assignment, keeping the name (HK-1)', () => {
    // `export DASHBOARD_TOKEN=...` inside a prompt or a Bash tool input is the
    // commonest way a credential reaches a hook payload, and its value is a
    // random string no prefix shape recognises. The key-based rule already
    // decides which NAMES are secret-bearing; this applies the same decision
    // inside string values. The name survives so the reader still sees WHAT was
    // set; only the value goes.
    // Secret-shaped values are assembled from fragments so that no source line
    // holds a credential literal for the repository's secret scanner to flag.
    const hex = ['4f3c9a1b', '2e7d8c6f', '5a4b3c2d', '1e0f9a8b'].join('');
    const awsName = ['aws', 'secret', 'access', 'key'].join('_');
    const awsValue = ['wJalrXUtn', 'FEMI/K7MD', 'ENG'].join('');
    const cases: ReadonlyArray<readonly [string, string]> = [
      [`export DASHBOARD_TOKEN=${hex}`, `export DASHBOARD_TOKEN=${REDACTED}`],
      ['run with password=hunter2 now', `run with password=${REDACTED} now`],
      [`${awsName} = ${awsValue}`, `${awsName}=${REDACTED}`],
      ['api-key="quoted value here" ok', `api-key=${REDACTED} ok`],
      ["API_KEY='single quoted' ok", `API_KEY=${REDACTED} ok`],
      ['TOKEN=abc123; echo done', `TOKEN=${REDACTED}; echo done`],
      ['https://h/x?token=abc123&page=2', `https://h/x?token=${REDACTED}&page=2`],
    ];
    for (const [input, expected] of cases) {
      expect(maskCredentialShapes(input)).toBe(expected);
    }
    // Non-secret names, comparisons and valueless assignments are not touched.
    for (const text of [
      'count=5',
      'max_tokens=4096',
      'if (token === expected) {',
      'if (token == expected) {',
      'x = token',
      'token=',
    ]) {
      expect(maskCredentialShapes(text)).toBe(text);
    }
    // Idempotent: a second pass over the masked text changes nothing.
    for (const [input] of cases) {
      const once = maskCredentialShapes(input);
      expect(maskCredentialShapes(once)).toBe(once);
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

describe('maskCredentialShapes runs in linear time (R3 / SEC-1)', () => {
  // The pre-SEC-1 implementation, verbatim: the oracle the linear rewrite must
  // reproduce byte for byte. Its JWT and assignment patterns are quadratic, so
  // it is only ever fed short strings here.
  const ORIGINAL_SHAPES: readonly RegExp[] = [
    /\bsk-[A-Za-z0-9_-]{8,}/g,
    /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{16,}/g,
    /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
    /\bxox[a-z]-[A-Za-z0-9-]{8,}/g,
    /\bAKIA[0-9A-Z]{16}\b/g,
    /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g,
    /\bBearer\s+[A-Za-z0-9._~+/=-]{6,}/gi,
    /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
  ];
  const ORIGINAL_ENV_ASSIGNMENT =
    /\b([A-Za-z_][A-Za-z0-9_.-]*)\s*=(?!=)\s*("[^"]*"|'[^']*'|[^\s&;]+)/g;
  function originalMask(text: string): string {
    let masked = text;
    for (const shape of ORIGINAL_SHAPES) {
      masked = masked.replace(shape, REDACTED);
    }
    return masked.replace(ORIGINAL_ENV_ASSIGNMENT, (match: string, name: string) =>
      isSecretKeyName(name) ? `${name}=${REDACTED}` : match,
    );
  }

  it('matches the original patterns on the run-boundary cases the rewrite reasons about', () => {
    for (const text of [
      '--api-key=hunter2',
      '-token=abc',
      '.secret=abc',
      'os.environ.API_KEY=abc',
      '9.password=abc',
      '9password=abc',
      'a9.b-c_TOKEN = "quoted value" rest',
      "x=1 y.z-token='v' w",
      'eyJ=1',
      'x-eyJhbGci.eyJzdWIi.sig',
      '.eyJhbGci.eyJzdWIi.sig tail',
      'xeyJhbGci.eyJzdWIi.sig',
      '9-eyJa.b.c',
      'eyJ.eyJa.b.c',
      'eyJa-eyJb.c',
      'eyJa.b',
      'auth=eyJa.b.c&next=1',
    ]) {
      expect(maskCredentialShapes(text)).toBe(originalMask(text));
    }
  });

  it('is byte-identical to the original patterns on random inputs (differential)', () => {
    const pieces = [
      'a',
      'Z',
      '9',
      '_',
      '.',
      '-',
      '=',
      '==',
      ' ',
      '\t',
      '"',
      "'",
      '&',
      ';',
      '!',
      'eyJ',
      'key',
      'token',
      'api_',
      'PASSWORD',
      'sk-',
      'abcdef1234',
      'Bearer ',
      'é',
    ];
    let seed = 0x5ec1;
    const next = (bound: number): number => {
      seed = (Math.imul(seed, 1103515245) + 12345) & 0x7fffffff;
      return seed % bound;
    };
    for (let round = 0; round < 20_000; round += 1) {
      let text = '';
      const length = 1 + next(16);
      for (let index = 0; index < length; index += 1) {
        text += pieces[next(pieces.length)];
      }
      expect(maskCredentialShapes(text), JSON.stringify(text)).toBe(originalMask(text));
    }
  });

  it('scans 256 KiB adversarial strings within a time budget', () => {
    // Each unit repeated to 256 KiB (a quarter of the default Fastify
    // bodyLimit, to stay fast under a loaded test run). The original
    // assignment pattern needed 35 s for `'a.'` at just 40k chars - at this
    // size, tens of minutes; a linear scan takes milliseconds. The budget is
    // generous for a slow, busy CI box yet far below any quadratic regression,
    // and the test's own timeout is raised so 26 scans never trip the default.
    const budgetMs = 1_500;
    for (const unit of [
      'a.',
      'a-',
      '_.',
      '9a.',
      '.a',
      'a ',
      'a =',
      'a="',
      "a='",
      'a=a.',
      'eyJ-',
      'eyJa.',
      'eyJa.b-',
      '.eyJ-',
      '-eyJa',
      'sk-',
      'sk-.',
      'ghp_',
      'github_pat_',
      'xoxa-',
      'AKIA',
      'Bearer ',
      'bearer  ',
      '-----BEGIN ',
      '-----BEGIN A',
      '-----BEGIN A PRIVATE KEY-----',
    ]) {
      const text = unit.repeat(Math.ceil((256 * 1024) / unit.length));
      const started = performance.now();
      maskCredentialShapes(text);
      expect(performance.now() - started, JSON.stringify(unit)).toBeLessThan(budgetMs);
    }
  }, 60_000);
});

describe('redactSecrets (WP-IN14)', () => {
  // WP-D10 Done-when: "Redaction deterministic; redacted re-ingest byte-identical +
  // idempotent" (2026-09-26 audit: no test proved either property). The route
  // computes the idempotency key over the REDACTED payload, so both properties are
  // what makes a redelivered - or re-ingested - event dedupe to zero new rows.
  const SECRET_BEARING = {
    hook_event_name: 'UserPromptSubmit',
    api_key: 'sk-ant-api03-supersecretvalue',
    prompt: 'use Bearer abc.def.ghi and sk-ant-api03-supersecretvalue please',
    nested: [{ authorization: 'Bearer xyz' }, { token_count: 42, note: 'plain' }],
  };

  it('is deterministic: the same input always redacts to byte-identical output', () => {
    const first = JSON.stringify(redactSecrets(deepFreeze(structuredClone(SECRET_BEARING))));
    const second = JSON.stringify(redactSecrets(deepFreeze(structuredClone(SECRET_BEARING))));
    expect(second).toBe(first);
    expect(first).not.toContain('supersecretvalue');
  });

  it('is idempotent: redacting an already-redacted payload changes nothing', () => {
    const once = redactSecrets(SECRET_BEARING);
    const twice = redactSecrets(deepFreeze(structuredClone(once)));
    expect(JSON.stringify(twice)).toBe(JSON.stringify(once));
  });

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
  it('keeps a __proto__ field as ordinary data instead of dropping it', () => {
    // `scrubbed[key] = ...` on a plain object invokes Object.prototype's
    // __proto__ SETTER, so the field never becomes an own property of the
    // result: it disappears from the value that is stored, and its object
    // value silently becomes the result's prototype. Everything downstream
    // reads ids with `record[key]`, which follows the prototype chain - so the
    // envelope's hookName and the events projection's ids can be lifted from
    // evidence that appears nowhere in the stored payload.
    const input: unknown = JSON.parse(
      '{"__proto__":{"hook_event_name":"SubagentStop","agent_id":"agent-ff"},"cwd":"/tmp"}',
    );

    const output = redactSecrets(input) as Record<string, unknown>;

    expect(Object.keys(output)).toEqual(['__proto__', 'cwd']);
    expect(Object.getPrototypeOf(output)).toBe(Object.prototype);
    expect((output as { hook_event_name?: unknown }).hook_event_name).toBeUndefined();
  });
});
