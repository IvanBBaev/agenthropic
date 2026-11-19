/**
 * ARC-4 - the per-file migration convention. `db/migrations.ts` is frozen at
 * migration 29; every later migration is one module in `db/migration-files/`,
 * named after its id, and listed in that directory's index in id order.
 */
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { FROZEN_THROUGH_MIGRATION_ID, migrations } from '../src/db/migrations';
import { fileMigrations } from '../src/db/migration-files/index';

const MIGRATION_FILE = /^(\d{3})-[a-z0-9]+(?:-[a-z0-9]+)*\.ts$/;

function migrationFileIds(): number[] {
  const dir = fileURLToPath(new URL('../src/db/migration-files', import.meta.url));
  return readdirSync(dir)
    .filter((name) => name !== 'index.ts')
    .map((name) => {
      const match = MIGRATION_FILE.exec(name);
      expect(match, `${name} must be named NNN-kebab-name.ts`).not.toBeNull();
      return Number(match![1]);
    })
    .sort((a, b) => a - b);
}

describe('per-file migrations (ARC-4)', () => {
  it('keeps the in-code list frozen at 1..29 and appends the file list after it', () => {
    expect(FROZEN_THROUGH_MIGRATION_ID).toBe(29);
    expect(migrations.slice(0, FROZEN_THROUGH_MIGRATION_ID).map((m) => m.id)).toEqual(
      Array.from({ length: FROZEN_THROUGH_MIGRATION_ID }, (_, i) => i + 1),
    );
    const appended = migrations.slice(FROZEN_THROUGH_MIGRATION_ID);
    expect(appended).toHaveLength(fileMigrations.length);
    appended.forEach((migration, i) => expect(migration).toBe(fileMigrations[i]));
  });

  it('has exactly one NNN-name.ts module per file migration, named after its id', () => {
    const ids = migrationFileIds();
    expect(ids).toEqual(fileMigrations.map((m) => m.id));
    for (const id of ids) expect(id).toBeGreaterThan(FROZEN_THROUGH_MIGRATION_ID);
  });
});
