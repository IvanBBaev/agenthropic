/**
 * Review H-1, transform half: the migration checksum must not move when the
 * TypeScript transform in the run path changes.
 *
 * `migrationChecksum` hashes `migration.up.toString()`, which is the source the
 * EXECUTOR produced, not the bytes on disk. That makes every recorded checksum a
 * property of the executor. Measured on 2026-08-29, before the normaliser
 * landed, the three executors this repo can reach disagreed on all sixteen
 * migrations:
 *
 *   migration 1, `tsx` (what `pnpm start`, `pnpm dev` and `pnpm bench` run, so
 *     the value a real `schema_version` row holds)
 *     107d36cc226abe28be915d22f365a95dc89d0f0a99295a2811c2f58ccc5eb579
 *   migration 1, vitest (what CI runs)
 *     92bb47e007e74bfb676487c55eb5975c7b4a77f647e22e2ab1dc73378b233d7a
 *   migration 1, `node --experimental-strip-types`
 *     bd6b8383928c23e355d1fa2d00be24896d24ee0ec87eebdd2e2298a5a3797800
 *
 * The normaliser cancels the classes a transform is free to vary - comments
 * (including annotations a transform INJECTS, such as vite's `@__PURE__` block
 * annotation), whitespace, and separators that are redundant before a closing
 * bracket. After it, vitest agrees with tsx on 12 of the 17, up from 0 - and so
 * does `node --experimental-strip-types`, on the same twelve ids (1-6, 8, 9, 10,
 * 12, 13, 17), also up from 0. Re-measured 2026-09-01 by running all three.
 *
 * Migration 17 (`agents-outcome-cause`) is the twelfth, appended after the H-1
 * measurement above, and it agrees for a reason its body states: one `db.exec`
 * of a single template literal, carrying no number literal, no `new` expression
 * and no arrow function, so none of the printer classes below can reach it.
 *
 * It does NOT reach full executor independence, and that is not fixable while
 * the recorded checksums must stay byte-identical. The differences that survive
 * normalisation were diffed token by token on 2026-08-31, so this list is what
 * remains rather than what a printer could in principle do: tsx's esbuild
 * re-prints literals (`0.1` -> `.1`, `new Map()` -> `new Map`) and injects its
 * `keepNames` `__name` wrapper, while vite's emits an empty statement - a bare
 * `;` after a block's closing `}` - that tsx's omits. String quoting is NOT on
 * the list: it is a thing esbuild may vary, but both transforms chose the same
 * quotes in every migration body, so no quoting difference survives here today.
 * Cancelling what does survive would mean re-printing every literal into some
 * canonical form, which changes the bytes tsx produces today - i.e. it would
 * invalidate every operator's recorded checksum, the exact failure this whole
 * lane exists to avoid. The residual five are pinned below as data, so a change
 * in that set is visible.
 *
 * HOW THE PINS WERE GENERATED. Both sets are measurements, not transcriptions:
 * a script imported `migrations` + `migrationChecksum` and printed
 * `${id} ${migrationChecksum(m)}` for each entry - once under
 * `node_modules/.bin/tsx` (OPERATOR_CHECKSUMS) and once inside this vitest
 * process (IN_PROCESS_CHECKSUMS). OPERATOR_CHECKSUMS were captured from the tree
 * BEFORE the normaliser was written and re-captured after: identical, 16 of 16.
 * That is the byte-identity proof, and `pins the values an operator database
 * records` below re-runs the tsx half of it on every test run. Migration 17's
 * entry was added the same way on 2026-09-01, and the same run re-measured the
 * sixteen already listed: byte-identical again, 16 of 16. A row may be APPENDED
 * to these tables; an existing row changing value is drift, not a re-pin.
 *
 * WHY THIS FILE CARRIES `spawner-gate-allow` MARKERS. The no-spawner gate
 * (WP-F5) forbids the whole subprocess API family outright - including, of
 * course, the module name this sentence is deliberately not spelling out, since
 * the gate reads comments too - and the invariant behind
 * it is that the SERVER must have no subprocess surface - the RCE class this
 * project deliberately walks away from. The two opted-out lines below are not
 * that: they run at test time only, are unreachable from any request path, take
 * no input from anywhere (the binary is a fixed path inside this package's
 * `node_modules`, the argv is a single file this test just wrote into its own
 * `mkdtemp` directory), and nothing they touch is imported by the server. The
 * opt-out is the mechanism the gate itself provides for exactly this - the same
 * one `scripts/check-licenses.mjs` uses for its sanctioned `pnpm licenses` call
 * - and it is per-line, so any OTHER forbidden line added to this file is still
 * caught. The alternative was to delete the tsx runs, which would demote
 * OPERATOR_CHECKSUMS from a measurement re-taken on every CI run to sixteen
 * transcribed strings that nothing checks against the shipped file. That trade
 * is not worth making: the pins exist precisely to be a measurement.
 */
import { execFileSync } from 'node:child_process'; // spawner-gate-allow: measurement only
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, beforeAll } from 'vitest';
import { openDatabase } from '../src/db/connection';
import type { Migration } from '../src/db/migrations';
import { migrationChecksum, migrations, runMigrations } from '../src/db/migrations';

/**
 * The value a `schema_version` row in a real operator database holds, because
 * the server process runs under `tsx`. Unchanged by the normaliser.
 */
const OPERATOR_CHECKSUMS: Readonly<Record<number, string>> = {
  1: '107d36cc226abe28be915d22f365a95dc89d0f0a99295a2811c2f58ccc5eb579',
  2: '799032eebc8df6dfde58db00cbeb7c5874e37b2a73cd793a73cae065efa9b31f',
  3: 'f926d86618cdda580341d152714ac976a8d64d3d80417b56391fde3dcee5f508',
  4: 'bb3bdf2fd004b1dea501a5a723641cfcef16672893e236d3f30fda2f23c56be6',
  5: '4bda485ca1f35981a00b813c0323ece22a44964038296db11b5eae5f2d3faec6',
  6: '6c8d1bb57d038fff2b7bbaab667e8306db6d7249d8ffa97c345f95bbab65eba4',
  7: '036cff68ae16eec8f994548b5b853368d5089a432478e4fef4e642b74f59013c',
  8: 'c509fc63bcaba634c5c000b955de9eb010d97e1684005363c5b709cabb95278b',
  9: '30b4d024dfaff2786d78b2bf9815590c7956a30e9045d7556983091aaf967499',
  10: 'bd559951e62b04612f71864016d1164670a635aeee6101dab134eba2612be596',
  11: '146c8bca3eedcf1de47511b40ce21b7a2bb8485b0c132f3e1442017a004f5eac',
  12: '91d8a4a68a55a0f0bc62bb988103a2c4d6c3e2f7708ab5bea29f79433ce628c5',
  13: 'f6f4c01936e782476c5c30402599ba2462b6fdec79e68511411529d6d5ee629b',
  14: '13ae81aaf1e0c1816c033d171fd15beda632126885185ccf1897cd0a3f91a6e9',
  15: 'bb15868c382415fd34bcf43ef0f2fee939841015a8e26305d73c7834af1c644c',
  16: 'e51b009bbdb6987db41245bcfea3f87dc654e46613eb35feb9b98ed50ddafc80',
  17: '05ff7a6f95a7ff9432e38bd164c593b95c163fdcd1e461008a75e3fea01f1c41',
};

/**
 * The same seventeen, computed inside this vitest process. Spelled as the
 * operator table plus the five overrides, so a migration the two executors
 * agree on - which is every one not listed here, migration 17 included - cannot
 * drift in one table without drifting in the other.
 */
const IN_PROCESS_CHECKSUMS: Readonly<Record<number, string>> = {
  ...OPERATOR_CHECKSUMS,
  7: '6d21aa9331a5042eca1be8a10e49be887b4e8eb3770466f0b78840ce64920c70',
  11: '6f8474bf663b4852fceb351574330e20f02238d26fb01d44471f1c6b0b4a0b1e',
  14: '6e08d74809e8677ebc808e32c29ef2245235279f02386ab0c242c615aba2a1a2',
  15: '9d1f9a8a644676e6bf5d3b49f2675309ce51c0f3241d79e17e86052268dc2a63',
  16: '0943cfbc1329162777666d137cd4012112992b128659fd7081f47d427485702a',
};

/**
 * The migrations on which vitest's transform and tsx's still disagree, and every
 * printer difference responsible for each - measured by diffing the two
 * NORMALISED bodies token by token, not guessed from the hex.
 *
 * The empty statement named below is a `;` vite's esbuild emits after a block's
 * closing `}` and tsx's does not. The formula's redundant-separator rule cannot
 * reach it: that rule drops a separator sitting BEFORE a closer, and this one
 * follows one.
 */
const RESIDUAL_PRINTER_DIVERGENCE: Readonly<Record<number, string>> = {
  7: 'number literal: tsx prints `.1`, vitest prints `0.1`',
  11: 'number literal: tsx prints `.1`, vitest prints `0.1`',
  14: 'call parentheses: tsx prints `new Map`, vitest prints `new Map()`; and 4 empty statements',
  15: 'esbuild keepNames: tsx wraps 2 arrows in `__name`; and 2 empty statements',
  16: 'esbuild keepNames: tsx wraps 7 arrows in `__name`, and nothing else',
};

const SERVER_ROOT = fileURLToPath(new URL('..', import.meta.url));
const MIGRATIONS_PATH = join(SERVER_ROOT, 'src/db/migrations.ts');
const TSX_BIN = join(SERVER_ROOT, 'node_modules/.bin/tsx');
/** Erased at runtime; replacing it lets a copy of the module load standalone. */
const CONNECTION_IMPORT = "import type { SqliteDatabase } from './connection';";

/**
 * Run `migrationChecksum` over every migration in a separate `tsx` process -
 * the executor an operator actually runs - and return `{ id: checksum }`.
 *
 * With no `patch`, the real module is imported by absolute path, so the pinned
 * values are a measurement of the shipped file. With a `patch`, the module text
 * is mutated into a temporary directory first; the `import type` line is
 * rewritten because the copy cannot resolve `./connection` from there. The
 * rewrite is provably inert - the `no-patch` and `identity-patch` runs are
 * asserted equal below - and it only touches a type-only import, which the
 * transform erases before `up.toString()` ever sees the module.
 */
const checksumsUnderTsx = (patch?: (source: string) => string): Record<number, string> => {
  const dir = mkdtempSync(join(tmpdir(), 'agenthropic-checksum-'));
  try {
    writeFileSync(join(dir, 'package.json'), '{"type":"module"}\n');
    let importSpecifier = MIGRATIONS_PATH;
    if (patch !== undefined) {
      const source = readFileSync(MIGRATIONS_PATH, 'utf8');
      expect(source).toContain(CONNECTION_IMPORT);
      writeFileSync(
        join(dir, 'migrations.ts'),
        patch(source).replace(CONNECTION_IMPORT, 'type SqliteDatabase = never;'),
      );
      importSpecifier = join(dir, 'migrations.ts');
    }
    const entry = join(dir, 'dump.ts');
    writeFileSync(
      entry,
      [
        `import { migrations, migrationChecksum } from ${JSON.stringify(importSpecifier)};`,
        'const pairs = migrations.map((m) => [m.id, migrationChecksum(m)]);',
        'process.stdout.write(JSON.stringify(Object.fromEntries(pairs)));',
        '',
      ].join('\n'),
    );
    // Kept on one line so no reflow can separate the marker from the call it
    // opts out of; see the header for why this one is sanctioned.
    const stdout = execFileSync(TSX_BIN, [entry], { encoding: 'utf8' }); // spawner-gate-allow
    return JSON.parse(stdout) as Record<number, string>;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

/**
 * A migration whose hashed source is exactly `source`. `migrationChecksum`
 * consumes `up.toString()`, so overriding `toString` is what lets a test feed
 * the normaliser text no transform in this repo would ever emit - unterminated
 * literals, comments a transform would have deleted, alternative spacing.
 */
const withSource = (source: string, id = 1, name = 'stability-probe'): Migration => {
  const up = (): void => {};
  Object.defineProperty(up, 'toString', { value: () => source });
  return { id, name, up };
};

const sum = (source: string, id = 1, name = 'stability-probe'): string =>
  migrationChecksum(withSource(source, id, name));

describe('migration checksum stability under a changed TypeScript transform', () => {
  describe('pinned values', () => {
    it('pins the checksum of every migration in this process', () => {
      const actual = Object.fromEntries(migrations.map((m) => [m.id, migrationChecksum(m)]));
      expect(actual).toStrictEqual(IN_PROCESS_CHECKSUMS);
    });

    it('pins the values an operator database records, measured by running tsx', () => {
      expect(checksumsUnderTsx()).toStrictEqual(OPERATOR_CHECKSUMS);
    }, 60_000);

    it('agrees with the operator executor except on the residual printer classes', () => {
      const disagreeing = Object.keys(OPERATOR_CHECKSUMS)
        .map(Number)
        .filter((id) => OPERATOR_CHECKSUMS[id] !== IN_PROCESS_CHECKSUMS[id]);
      expect(disagreeing).toStrictEqual(Object.keys(RESIDUAL_PRINTER_DIVERGENCE).map(Number));
      expect(disagreeing).toHaveLength(5);
    });

    it('covers every migration in the list, so no entry is silently unpinned', () => {
      expect(migrations.map((m) => m.id)).toStrictEqual(
        Object.keys(OPERATOR_CHECKSUMS).map(Number),
      );
    });
  });

  describe('invariance: what a transform is free to change', () => {
    const BODY = 'db.exec(`CREATE TABLE t (a TEXT)`);';

    it('ignores line comments', () => {
      expect(sum(`(db) => {\n  // create it\n  ${BODY}\n}`)).toBe(sum(`(db) => {\n  ${BODY}\n}`));
    });

    it('ignores block comments, including a transform-injected annotation', () => {
      const injected = `(db) => { const m = /* @__PURE__ */ new Map(); ${BODY} return m; }`;
      const plain = `(db) => { const m = new Map(); ${BODY} return m; }`;
      expect(sum(injected)).toBe(sum(plain));
    });

    it('ignores a comment whose text is itself code', () => {
      const commented = `(db) => {\n  // db.exec('DROP TABLE events'); if (x) { return; }\n  ${BODY}\n}`;
      expect(sum(commented)).toBe(sum(`(db) => {\n  ${BODY}\n}`));
    });

    it('ignores whitespace, indentation and line endings', () => {
      const spaced = `(db)  =>  {\r\n\t\t${BODY}\r\n}`;
      expect(sum(spaced)).toBe(sum(`(db)=>{${BODY}}`));
    });

    it('ends a line comment at CR, LS and PS as well as LF', () => {
      const terminators = ['\n', '\r', '\u2028', '\u2029'];
      const hashes = terminators.map((eol) => sum(`(db) => { // gone${eol}${BODY} }`));
      expect(new Set(hashes).size).toBe(1);
      expect(hashes[0]).toBe(sum(`(db) => { ${BODY} }`));
    });

    it('ignores a separator that is redundant before a closing bracket', () => {
      expect(sum('(db) => { const a = [1, 2,]; const o = { b: 1, }; f(1,); }')).toBe(
        sum('(db) => { const a = [1, 2]; const o = { b: 1 }; f(1) }'),
      );
    });

    it('keeps a separator that is not redundant', () => {
      expect(sum('(db) => { f(1, 2); }')).not.toBe(sum('(db) => { f(1 2); }'));
    });
  });

  describe('invariance must not swallow literals that merely look like syntax', () => {
    it('does not read // or /* inside a template literal as a comment', () => {
      const source = (host: string): string =>
        `(db) => {\n  db.exec(\`-- https://${host}/a//b and /* keep */ tail\`);\n}`;
      expect(sum(`/* dropped */ ${source('example.com')}`)).toBe(sum(source('example.com')));
      expect(sum(source('example.com'))).not.toBe(sum(source('example.org')));
    });

    it('does not read // or /* inside a quoted string as a comment', () => {
      const single = "(db) => { db.exec('-- a // b /* c */ d'); }";
      const double = '(db) => { db.exec("-- a // b /* c */ d"); }';
      expect(sum(`${single} // tail`)).toBe(sum(single));
      expect(sum(single)).not.toBe(sum("(db) => { db.exec('-- a // b /* c */ e'); }"));
      expect(sum(double)).not.toBe(sum('(db) => { db.exec("-- a // b /* c */ e"); }'));
    });

    it('keeps a regular expression literal whole, slashes and character class included', () => {
      const re = String.raw`(db) => { const ok = /a\/b[/]c/gi.test('x'); ${'db.exec(`X`);'} }`;
      expect(sum(`${re} // tail`)).toBe(sum(re));
      expect(sum(re)).not.toBe(sum(re.replace('c/gi', 'd/gi')));
    });

    it('reads a slash after a closing parenthesis as division, not as a regex', () => {
      const div = (n: string): string => `(db) => { const q = (1) / ${n}; db.exec(\`X\`); }`;
      expect(sum(div('2'))).not.toBe(sum(div('3')));
      expect(sum(`${div('2')} // tail`)).toBe(sum(div('2')));
    });

    it('reads a slash after an identifier as division, so following code survives', () => {
      const src = (tail: string): string => `(db) => { const q = a / b; db.exec(\`${tail}\`); }`;
      expect(sum(src('X'))).not.toBe(sum(src('Y')));
    });

    it('reads a slash after a regex-only keyword as a regex', () => {
      const src = (flag: string): string => `(db) => { return /x/${flag}; }`;
      expect(sum(src('g'))).not.toBe(sum(src('i')));
    });

    it('keeps escapes inside strings, templates and regexes', () => {
      expect(sum("(db) => { const s = 'a\\'b'; }")).not.toBe(sum("(db) => { const s = 'a\\'c'; }"));
      expect(sum('(db) => { const s = `a\\`b`; }')).not.toBe(sum('(db) => { const s = `a\\`c`; }'));
      expect(sum(String.raw`(db) => { const r = /a\/b/; }`)).not.toBe(
        sum(String.raw`(db) => { const r = /a\/c/; }`),
      );
    });

    it('tracks nested template substitutions and object literals inside them', () => {
      const src = (inner: string): string =>
        '(db) => { const o = { k: 1 }; db.exec(`a${`b${' + inner + '}c`}${o.k}d $ e`); }';
      expect(sum(`${src('1')} // tail`)).toBe(sum(src('1')));
      expect(sum(src('1'))).not.toBe(sum(src('2')));
    });

    it('treats ++ and -- as single tokens', () => {
      expect(sum('(db) => { let i = 0; i++; i--; }')).not.toBe(
        sum('(db) => { let i = 0; i--; i++; }'),
      );
      expect(sum('(db) => { const n = 1 + 2 - 3; }')).not.toBe(
        sum('(db) => { const n = 1 + 2 - 4; }'),
      );
    });

    it('terminates on truncated literals instead of looping, and still discriminates', () => {
      const truncated = [
        "(db) => { db.exec('unterminated",
        '(db) => { db.exec("unterminated',
        '(db) => { db.exec(`unterminated',
        '(db) => { const r = /unterminated',
        '(db) => { const s = `a\\',
      ];
      const hashes = truncated.map((source) => sum(source));
      for (const hash of hashes) {
        expect(hash).toMatch(/^[0-9a-f]{64}$/);
      }
      expect(new Set(hashes).size).toBe(truncated.length);
      expect(sum("(db) => { db.exec('unterminated")).not.toBe(
        sum("(db) => { db.exec('unterminatee"),
      );
    });

    it('drops a comment that runs to the end of the source, both kinds alike', () => {
      // Both collapse to the same text, which is the point: a comment carries
      // no meaning, so an unterminated one carries none either.
      expect(sum('(db) => { /* unterminated')).toBe(sum('(db) => { // unterminated'));
      expect(sum('(db) => { /* unterminated')).toBe(sum('(db) => {'));
    });
  });

  describe('sensitivity: what the guard must still catch', () => {
    it('changes when the id or the name changes', () => {
      const body = '(db) => { db.exec(`X`); }';
      expect(sum(body, 1, 'a')).not.toBe(sum(body, 2, 'a'));
      expect(sum(body, 1, 'a')).not.toBe(sum(body, 1, 'b'));
    });

    it('changes when SQL text inside a template literal changes', () => {
      expect(sum('(db) => { db.exec(`CREATE TABLE t (a TEXT)`); }')).not.toBe(
        sum('(db) => { db.exec(`CREATE TABLE t (a BLOB)`); }'),
      );
    });

    it('changes when a real migration renames a table', () => {
      const before = 'CREATE TABLE orchestration_edges (';
      const after = 'CREATE TABLE orchestration_edgez (';
      const mutated = checksumsUnderTsx((source) => {
        expect(source.split(before)).toHaveLength(2);
        return source.replace(before, after);
      });
      expect(mutated[5]).not.toBe(OPERATOR_CHECKSUMS[5]);
      expect(mutated[4]).toBe(OPERATOR_CHECKSUMS[4]);
    }, 60_000);

    it('changes when a real migration edits an index definition', () => {
      const before = 'CREATE INDEX idx_events_session_id ON events(session_id);';
      const mutated = checksumsUnderTsx((source) => {
        expect(source.split(before)).toHaveLength(2);
        return source.replace(before, 'CREATE INDEX idx_events_sid ON events(session_id);');
      });
      expect(mutated[3]).not.toBe(OPERATOR_CHECKSUMS[3]);
      expect(mutated[2]).toBe(OPERATOR_CHECKSUMS[2]);
    }, 60_000);

    it('changes EVERY checksum when a frozen PRICING_SEED price changes', () => {
      const before = "{ model: 'claude-opus-4-8', inputUsdPerMtok: 5, outputUsdPerMtok: 25 },";
      const after = "{ model: 'claude-opus-4-8', inputUsdPerMtok: 5, outputUsdPerMtok: 26 },";
      const mutated = checksumsUnderTsx((source) => {
        expect(source.split(before)).toHaveLength(2);
        return source.replace(before, after);
      });
      for (const migration of migrations) {
        expect(mutated[migration.id]).not.toBe(OPERATOR_CHECKSUMS[migration.id]);
      }
    }, 60_000);
  });

  describe('end to end through runMigrations', () => {
    /**
     * The real failure mode: a database migrated under one executor, re-opened
     * under another that prints comments where the first deleted them. Both
     * revisions of `up` here do exactly the same thing and differ only in a
     * comment, so a healthy database must open without complaint.
     *
     * The `toString` override is what makes this test say anything at all. A
     * comment written literally in this file is deleted by vitest's transform
     * before `up.toString()` runs, so it would never reach the hash under any
     * revision of `migrationChecksum`.
     */
    const CREATE = "d.exec('CREATE TABLE t1 (id INTEGER PRIMARY KEY);');";
    const migrationFrom = (source: string): Migration[] => [withSource(source, 1, 'first')];

    it('re-opens a database whose applied migration now carries comments', () => {
      const dir = mkdtempSync(join(tmpdir(), 'agenthropic-checksum-e2e-'));
      const db = openDatabase(join(dir, 'e2e.db'));
      try {
        expect(runMigrations(db, migrationFrom(`(d) => { ${CREATE} }`)).appliedIds).toStrictEqual([
          1,
        ]);
        const commented = `(d) => {\n  // added by a comment-preserving transform\n  ${CREATE}\n}`;
        expect(runMigrations(db, migrationFrom(commented)).appliedIds).toStrictEqual([]);
      } finally {
        db.close();
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('still refuses a database whose applied migration changed what it does', () => {
      const dir = mkdtempSync(join(tmpdir(), 'agenthropic-checksum-e2e-edit-'));
      const db = openDatabase(join(dir, 'e2e.db'));
      try {
        runMigrations(db, migrationFrom(`(d) => { ${CREATE} }`));
        const edited = `(d) => { d.exec('CREATE TABLE t1 (id INTEGER PRIMARY KEY, x TEXT);'); }`;
        expect(() => runMigrations(db, migrationFrom(edited))).toThrow(
          /Migration 1 \(first\) was edited after being applied/,
        );
      } finally {
        db.close();
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  describe('the tsx harness itself', () => {
    let direct: Record<number, string>;
    let viaCopy: Record<number, string>;

    beforeAll(() => {
      direct = checksumsUnderTsx();
      viaCopy = checksumsUnderTsx((source) => source);
    }, 120_000);

    it('is unaffected by the copy and the erased-import rewrite it performs', () => {
      expect(viaCopy).toStrictEqual(direct);
    });
  });
});
