import { describe, expect, it } from 'vitest';
import { Value } from '@sinclair/typebox/value';
import { HealthSchema, type HealthDto } from '../src/index';

/**
 * `HealthSchema` IS the object the server registers on `GET /api/health`, so
 * these tests pin the wire contract: which fields are required, what each
 * optional field admits, and that nothing else gets through.
 */
describe('HealthSchema', () => {
  it('accepts the minimal payload: status and schemaVersion only', () => {
    const dto: HealthDto = { status: 'ok', schemaVersion: 18 };
    expect(Value.Check(HealthSchema, dto)).toBe(true);
  });

  it('accepts the full payload with every optional field present', () => {
    const dto: HealthDto = {
      status: 'ok',
      schemaVersion: 18,
      ingestSkips: { oversize: 2, 'duplicate-session': 1, 'too-deep': 0 },
      ingest: 'idle',
      lastTickDurationMs: 12.5,
      crossSessionUsageCollisions: 0,
      sessionsExcluded: 3,
      sessionsQuarantined: 1,
    };
    expect(Value.Check(HealthSchema, dto)).toBe(true);
  });

  it('rejects a status other than the literal "ok"', () => {
    expect(Value.Check(HealthSchema, { status: 'degraded', schemaVersion: 18 })).toBe(false);
  });

  it('rejects an extra top-level property (no accidental data leakage into the DTO)', () => {
    expect(Value.Check(HealthSchema, { status: 'ok', schemaVersion: 18, token: 'leak' })).toBe(
      false,
    );
  });

  it('rejects a non-integer schemaVersion', () => {
    expect(Value.Check(HealthSchema, { status: 'ok', schemaVersion: 18.5 })).toBe(false);
  });

  it('rejects ingestSkips with a non-integer count', () => {
    expect(
      Value.Check(HealthSchema, {
        status: 'ok',
        schemaVersion: 18,
        ingestSkips: { oversize: 1.5 },
      }),
    ).toBe(false);
  });

  it('rejects an ingest phase outside "replaying" | "idle"', () => {
    expect(Value.Check(HealthSchema, { status: 'ok', schemaVersion: 18, ingest: 'running' })).toBe(
      false,
    );
  });

  it('requires exactly status and schemaVersion, so an optional field cannot silently become required', () => {
    expect(HealthSchema.required).toEqual(['status', 'schemaVersion']);
  });
});
