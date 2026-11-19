/**
 * Schema migrations from id 30 onwards, one module per migration (ARC-4,
 * 2026-11-19).
 *
 * `db/migrations.ts` holds migrations 1-29 in a single in-code list that is
 * frozen: an applied migration's checksum is recorded in every database it
 * touched, so that list is never edited, and new migrations no longer grow it.
 *
 * Adding migration N:
 *   1. create `NNN-short-name.ts` here (zero-padded id, kebab-case name) that
 *      exports `const migration: Migration` with `id: N`;
 *   2. import it below and append it to `fileMigrations` - ids strictly
 *      increasing, which the runner asserts on every run;
 *   3. bump the `currentSchemaVersion` pins in the tests.
 *
 * `test/db-migration-files.test.ts` holds the directory to this convention.
 */
import type { Migration } from '../migrations';

export const fileMigrations: readonly Migration[] = [];
