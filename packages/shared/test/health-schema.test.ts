import { describe, expect, it } from 'vitest';
import { Value } from '@sinclair/typebox/value';
import { HealthSchema, type HealthDto } from '../src/index';

describe('HealthSchema', () => {
  it('accepts a valid health DTO', () => {
    const dto: HealthDto = { status: 'ok', version: '0.1.0', uptimeSeconds: 12.5 };
    expect(Value.Check(HealthSchema, dto)).toBe(true);
  });

  it('accepts zero uptime', () => {
    expect(Value.Check(HealthSchema, { status: 'ok', version: '0.1.0', uptimeSeconds: 0 })).toBe(
      true,
    );
  });

  it('rejects a status other than the literal "ok"', () => {
    expect(
      Value.Check(HealthSchema, { status: 'degraded', version: '0.1.0', uptimeSeconds: 1 }),
    ).toBe(false);
  });

  it('rejects negative uptime', () => {
    expect(Value.Check(HealthSchema, { status: 'ok', version: '0.1.0', uptimeSeconds: -1 })).toBe(
      false,
    );
  });

  it('rejects missing fields', () => {
    expect(Value.Check(HealthSchema, { status: 'ok' })).toBe(false);
  });

  it('rejects additional properties (no accidental data leakage into the DTO)', () => {
    expect(
      Value.Check(HealthSchema, {
        status: 'ok',
        version: '0.1.0',
        uptimeSeconds: 1,
        token: 'leak',
      }),
    ).toBe(false);
  });
});
