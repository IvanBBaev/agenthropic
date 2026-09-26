/**
 * The migration checksums, PINNED as literals.
 *
 * `migrationChecksum` records a content hash per migration in `schema_version`
 * and re-verifies it on every run, so an in-place edit of an already-applied
 * migration fails loudly. That guard has one blind spot, and it is the worst
 * possible one: it can only fire against a database that already has rows -
 * i.e. in a USER's database, after the divergence is committed. CI runs against
 * virgin temp databases, where a checksum is written and verified inside the
 * same process, so CI agrees with itself no matter what the value is. Pinning
 * the values here is what turns "the checksum verifies" into "the checksum is
 * THIS".
 *
 * WHAT THE PIN CATCHES
 *
 *  1. An in-place edit of any migration's `up` body, of its id or its name, or
 *     of the frozen module constants the hash also covers (TOKEN_BUCKETS,
 *     PRICING_SEED_EFFECTIVE_FROM, PRICING_SEED). Each of those flips at least
 *     one literal below, in CI, before any operator database sees it. This is
 *     the case the pin serves fully.
 *  2. A change in the transform of the executor THIS TEST runs under. The hashed
 *     text is `up.toString()`, which is TRANSFORMED source, not the bytes on
 *     disk, so the literals are a property of the executor as much as of the
 *     code.
 *
 * MEASURED, AND THE REASON (2) IS NARROWER THAN IT SOUNDS
 *
 * This package has two executors in its run path and they still do not fully
 * agree, but the gap has narrowed. Re-measured on 2026-09-01 by dumping
 * `migrationChecksum` over the exported `migrations` under each executor and
 * comparing the two tables, after review H-1 replaced the whitespace-only
 * normalisation with a lexer that additionally drops comments and separators
 * that are redundant before a closing `)`, `]` or `}`:
 *
 *   vitest (vite's esbuild transform, what this file pins) and `tsx` (what
 *   `pnpm start`, `pnpm dev` and `pnpm bench` run) now produce an IDENTICAL
 *   checksum for FOURTEEN of the nineteen migrations - ids 1-6, 8, 9, 10, 12,
 *   13, 17, 18 and 19. They differ on ids 7, 11, 14, 15 and 16. Running the pre-H-1
 *   whitespace-only formula over the SAME two transform outputs puts the
 *   agreement at ZERO, so the agreeing set is what H-1 bought.
 *
 * Migration 17 (`agents-outcome-cause`) was appended after H-1 and joined that
 * agreeing set on the same re-measurement, which is a property of its body
 * rather than luck: it is one `db.exec` of a single template literal, with no
 * number literal, no `new` expression and no arrow function, so it carries
 * none of the five printer differences enumerated next. Migration 18
 * (`model-pricing-opus-5-fable-5-1`, appended 2026-09-10) was built to that
 * same shape on purpose - its ten rates are spelled inside the SQL text of the
 * one template literal rather than as JS number literals, because a `0.5` in
 * JS would have re-printed as `.5` under tsx and made it a sixth divergent id
 * - and it joined the agreeing set on its own measurement. Migration 19
 * (`model-pricing-opus-5-5`, appended 2026-09-26) is a five-row copy of that
 * shape and joined the same way, measured identical under both executors on
 * the day it was written. The residual five are still exactly ids 7, 11, 14,
 * 15 and 16.
 *
 * The old cause - a separator tsx's esbuild elides before a closing bracket and
 * vite's does not - is now cancelled by the formula itself. The residual five
 * were diffed token by token AFTER normalisation, so what follows is the list of
 * differences that actually survive, not a guess at them:
 *
 *   7, 11  one number literal: vitest prints `0.1`, tsx prints `.1`.
 *   14     `new Map()` against `new Map` - tsx drops the call parentheses of a
 *          `new` expression - plus four EMPTY STATEMENTS, a `;` that vite's
 *          esbuild emits after a block's closing `}` and tsx's does not. That
 *          `;` trails a `}` rather than preceding a closer, so the formula's
 *          redundant-separator rule deliberately does not reach it.
 *   15     two such empty statements, plus esbuild's `keepNames` `__name(...)`
 *          wrapper, which tsx puts round two arrow functions (`shapeGuard`,
 *          `rejects`) and vite does not.
 *   16     that same `__name` wrapper, round seven arrow functions, and nothing
 *          else - its two normalised bodies carry the same separator count.
 *
 * String QUOTING is deliberately absent from that list. It was checked: both
 * transforms chose the same quotes in every migration body, so no quoting
 * difference survives normalisation in the code as it stands - it is a thing
 * esbuild is free to vary, not a thing it currently varies here.
 *
 * Cancelling what does survive would mean re-printing literals and unwrapping
 * helper calls into some canonical form, which by definition changes the bytes
 * tsx produces today - i.e. it would invalidate every checksum already sitting
 * in an operator's database. `migrationChecksum` in `migrations.ts` documents
 * that trade-off; `migrations-checksum-stability.test.ts` pins the residual five
 * as data.
 *
 * The consequence, stated plainly: for those five, a checksum recorded in a
 * real operator database - written by the server, which runs under tsx - is NOT
 * the literal pinned below. Nothing has ever noticed, because each process only
 * ever compares its own transform against itself. So this file pins the CI
 * transform. It detects any content edit (which flips both sets), and it
 * detects a change to the transform vitest uses; it does NOT independently pin
 * the value an operator's `schema_version` holds.
 *
 * WHAT THE PIN DOES NOT DO. None of this is hedging; each is a real limit:
 *
 *  - It does not prove that either transform is the RIGHT one. It pins the one
 *    CI runs so that changing it is a deliberate, visible act.
 *  - It cannot protect a database that was already migrated under a different
 *    transform. Those checksums are bytes in somebody's `schema_version`, and
 *    this test is a compile-time fact that reaches none of them. It makes a flip
 *    detectable before shipping, never repairable afterwards. (`runMigrations`
 *    also backfills a NULL checksum on trust-on-first-verify, so a pre-checksum
 *    database records whatever content is current at its first verified run;
 *    that history is unrecoverable here too.)
 *  - It inherits every blind spot of the formula it pins, and H-1 widened them
 *    from one channel to three. Whitespace is still stripped before hashing, so
 *    a whitespace-only edit inside a string literal is invisible; a comment-only
 *    edit is now invisible too, and so is adding or removing a separator that is
 *    redundant before a closing `)`, `]` or `}`. The last two are by design - a
 *    comment cannot change what a migration does, and neither can a `;` a
 *    printer is free to emit or omit - but they are blind spots all the same,
 *    and migrations.ts documents all three trade-offs itself. And the hash
 *    sees UNEVALUATED template source, so editing how `BUCKET_CHECK` is derived
 *    changes the SQL migration 6 emits while every literal below stays
 *    identical - a gap asserted below rather than merely claimed.
 *  - A green run says nothing about whether a migration is CORRECT. It says only
 *    that it is still the same migration it was.
 *
 * MEASURED ANSWER to the comment-sensitivity question (evidence in the last two
 * tests): two `up` bodies differing ONLY by a comment produce the SAME checksum,
 * and since H-1 they do so for TWO independent reasons. Under this executor
 * esbuild deletes the comment before `toString()` can see it; and the formula's
 * own lexer now drops comments as well, so the two bodies hash IDENTICALLY even
 * when handed over as source no transform has touched - which is what a
 * comment-preserving executor (tsc's default emit, `node
 * --experimental-strip-types`) would give it.
 *
 * Note what that second reason does NOT buy. Both executors named at the top of
 * this file are esbuild, and both delete comments, so comment-dropping
 * contributes nothing to the eleven-of-sixteen agreement reported there - that
 * is the separator rule's doing. What it buys is agreement with a
 * comment-preserving executor, and that was measured too: `node
 * --experimental-strip-types`, which leaves comments standing, went from
 * agreeing with tsx on ZERO of the sixteen to agreeing on the SAME eleven -
 * and, re-measured on 2026-09-01, on migration 17 as well, and on 2026-09-10 on
 * migration 18 too, and on 2026-09-26 on migration 19, so all three executors
 * now agree on the same fourteen.
 */
import { describe, expect, it } from 'vitest';
import { migrationChecksum, migrations, type Migration } from '../src/db/migrations';

interface PinnedChecksum {
  readonly id: number;
  readonly name: string;
  /** sha-256 hex, produced by running the real `migrationChecksum` under vitest. */
  readonly checksum: string;
}

/**
 * Derived by executing the real `migrationChecksum` over the real exported
 * `migrations` array - never hand-derived from the formula. Regenerate ONLY with
 * a conscious answer to "why did this change?": a diff here is either an edited
 * migration or a changed transform, and both are incidents.
 *
 * They HAVE been regenerated once, at review H-1, and the answer to "why" is on
 * the record because re-pinning is otherwise exactly the anti-pattern the
 * paragraph above warns about. H-1 changed the normalisation, so all sixteen
 * values below moved. What makes that a re-pin and not an incident is a separate
 * measurement: under `tsx` - the executor an operator's database was actually
 * migrated by - all sixteen checksums came out BYTE-IDENTICAL across the change,
 * so no deployed `schema_version` row was invalidated. Only the vitest-side
 * literals moved, and they are a compile-time artefact of vite's transform, not
 * of anything an operator stores. The tsx side is pinned independently in
 * `migrations-checksum-stability.test.ts` (`OPERATOR_CHECKSUMS`); that table is
 * the one that must never move without a migration-compatibility story, and at
 * H-1 it did not move. A future diff here has no such excuse waiting for it.
 *
 * APPENDING IS NOT RE-PINNING, and the two must never be conflated. Migration
 * 17 was appended to `migrations` on 2026-09-01 and one row was appended below
 * for it. The sixteen rows above that one were re-measured on the same run,
 * under vitest AND under tsx, and came out byte-identical to what they already
 * said - which is what makes this an append rather than the incident the
 * paragraphs above describe. Migration 18 followed the same procedure on
 * 2026-09-10: one row appended, and the seventeen above it re-measured under
 * vitest, tsx and `node --experimental-strip-types` and found byte-identical.
 * That is the only shape a diff in this table may legitimately take: a new row
 * at the end, every older row untouched.
 */
const PINNED: readonly PinnedChecksum[] = [
  {
    id: 1,
    name: 'events-raw-append-only',
    checksum: '107d36cc226abe28be915d22f365a95dc89d0f0a99295a2811c2f58ccc5eb579',
  },
  {
    id: 2,
    name: 'sessions',
    checksum: '799032eebc8df6dfde58db00cbeb7c5874e37b2a73cd793a73cae065efa9b31f',
  },
  {
    id: 3,
    name: 'events',
    checksum: 'f926d86618cdda580341d152714ac976a8d64d3d80417b56391fde3dcee5f508',
  },
  {
    id: 4,
    name: 'agents-self-referential',
    checksum: 'bb3bdf2fd004b1dea501a5a723641cfcef16672893e236d3f30fda2f23c56be6',
  },
  {
    id: 5,
    name: 'orchestration-edges',
    checksum: '4bda485ca1f35981a00b813c0323ece22a44964038296db11b5eae5f2d3faec6',
  },
  {
    id: 6,
    name: 'token-usage',
    checksum: '6c8d1bb57d038fff2b7bbaab667e8306db6d7249d8ffa97c345f95bbab65eba4',
  },
  {
    id: 7,
    name: 'model-pricing-with-seed',
    checksum: '6d21aa9331a5042eca1be8a10e49be887b4e8eb3770466f0b78840ce64920c70',
  },
  {
    id: 8,
    name: 'token-usage-main-agent-attribution',
    checksum: 'c509fc63bcaba634c5c000b955de9eb010d97e1684005363c5b709cabb95278b',
  },
  {
    id: 9,
    name: 'ingest-checkpoints',
    checksum: '30b4d024dfaff2786d78b2bf9815590c7956a30e9045d7556983091aaf967499',
  },
  {
    id: 10,
    name: 'retention-scan-indexes',
    checksum: 'bd559951e62b04612f71864016d1164670a635aeee6101dab134eba2612be596',
  },
  {
    id: 11,
    name: 'model-pricing-seed-convergence',
    checksum: '6f8474bf663b4852fceb351574330e20f02238d26fb01d44471f1c6b0b4a0b1e',
  },
  {
    id: 12,
    name: 'orchestration-edge-endpoint-indexes',
    checksum: '91d8a4a68a55a0f0bc62bb988103a2c4d6c3e2f7708ab5bea29f79433ce628c5',
  },
  {
    id: 13,
    name: 'orchestration-edges-legacy-explore-source',
    checksum: 'f6f4c01936e782476c5c30402599ba2462b6fdec79e68511411529d6d5ee629b',
  },
  {
    id: 14,
    name: 'model-pricing-canonical-effective-from',
    checksum: '6e08d74809e8677ebc808e32c29ef2245235279f02386ab0c242c615aba2a1a2',
  },
  {
    id: 15,
    name: 'token-usage-canonical-occurred-at',
    checksum: '9d1f9a8a644676e6bf5d3b49f2675309ce51c0f3241d79e17e86052268dc2a63',
  },
  {
    id: 16,
    name: 'token-usage-rollup',
    checksum: '0943cfbc1329162777666d137cd4012112992b128659fd7081f47d427485702a',
  },
  {
    id: 17,
    name: 'agents-outcome-cause',
    checksum: '05ff7a6f95a7ff9432e38bd164c593b95c163fdcd1e461008a75e3fea01f1c41',
  },
  {
    id: 18,
    name: 'model-pricing-opus-5-fable-5-1',
    checksum: 'ec11bd686759b257661764839b23befa7813e89846328f79ce1c3bd48888ce8a',
  },
  {
    id: 19,
    name: 'model-pricing-opus-5-5',
    checksum: '4efb01c611acb6d2723aed7beb74d1e82ec676b970adf64857ce1d40537a6920',
  },
];

/** The literal whitespace normalisation `migrationChecksum` applies. */
const squeeze = (source: string): string => source.replace(/\s+/g, '');

/**
 * Migration 2's normalised body, verbatim - the shortest migration, pinned as
 * TEXT rather than as a hash. Sixteen hex strings can only ever say "something
 * moved"; this one says what the hash actually eats.
 *
 * It is pinned through `squeeze`, i.e. through the pre-H-1 whitespace-only
 * normalisation, deliberately: that is what makes the executor difference
 * legible here. This text ends `);}` under vitest and `)}` under tsx, because
 * tsx's esbuild elides the redundant semicolon. What `migrationChecksum` now
 * consumes is one step further on - its lexer drops that semicolon under BOTH
 * executors, which is precisely why migration 2's checksum is one of the eleven
 * the two executors now agree on.
 */
const PINNED_NORMALISED_MIGRATION_2 =
  'up(db){db.exec(`CREATETABLEsessions(idTEXTPRIMARYKEY,project_slugTEXT,started_atTEXT,last_activity_atTEXT,statusTEXT);`);}';

/**
 * Referenced by both comment probes so neither body can be optimised away to
 * nothing - a probe whose normalised body were empty would collide vacuously.
 */
const probeSink: string[] = [];
const PROBE_SQL = 'CREATE TABLE probe (id INTEGER PRIMARY KEY);';

/**
 * Two migrations identical in id, name and effect, differing ONLY by a comment
 * in the `up` body. Written as ordinary source in this file on purpose: they go
 * through the same transform as `src/db/migrations.ts`, so comparing them
 * measures the EXECUTOR rather than a string this test invented.
 */
const COMMENTED_PROBE: Migration = {
  id: 0,
  name: 'comment-probe',
  up() {
    // This comment is the only difference from UNCOMMENTED_PROBE.
    probeSink.push(PROBE_SQL);
  },
};

const UNCOMMENTED_PROBE: Migration = {
  id: 0,
  name: 'comment-probe',
  up() {
    probeSink.push(PROBE_SQL);
  },
};

/**
 * The same two bodies as raw text that no transform has touched - a stand-in for
 * an executor that PRESERVES comments. `migrationChecksum` reads its input
 * through `up.toString()`, so pinning `toString` is enough to feed the REAL
 * function untransformed source; nothing about the formula is re-derived here.
 */
function migrationWithSource(source: string): Migration {
  const up = (): void => undefined;
  Object.defineProperty(up, 'toString', { value: () => source });
  return { id: 0, name: 'comment-probe', up };
}

const UNTRANSFORMED_WITH_COMMENT = `up() {
    // This comment is the only difference from UNCOMMENTED_PROBE.
    probeSink.push(PROBE_SQL);
  }`;
const UNTRANSFORMED_WITHOUT_COMMENT = `up() {
    probeSink.push(PROBE_SQL);
  }`;

describe('migration checksum pin', () => {
  it('computes exactly the pinned checksum for every migration', () => {
    const computed = migrations.map((migration) => ({
      id: migration.id,
      name: migration.name,
      checksum: migrationChecksum(migration),
    }));
    // One `toEqual` over the whole table rather than a loop of assertions: the
    // failure output then shows every literal that moved at once, which
    // separates "someone edited migration 11" from "the transform changed" at a
    // glance - one row versus nineteen.
    expect(computed).toEqual(PINNED);
  });

  it('pins every migration in the exported array - count and exact (id, name) order', () => {
    // A new migration cannot be added without being consciously pinned, and a
    // RENAME is caught too: the name is hashed, so renaming migration 9 changes
    // its checksum, and this assertion names the drift instead of leaving the
    // reader to decode a hex diff.
    expect(migrations).toHaveLength(PINNED.length);
    expect(migrations.map((m) => ({ id: m.id, name: m.name }))).toEqual(
      PINNED.map((p) => ({ id: p.id, name: p.name })),
    );
  });

  it('pins the normalised text the hash actually consumes, for migration 2', () => {
    const migration = migrations.find((m) => m.id === 2);
    if (migration === undefined) {
      throw new Error('migration 2 is missing');
    }
    expect(squeeze(migration.up.toString())).toBe(PINNED_NORMALISED_MIGRATION_2);
  });

  it('hashes the UNEVALUATED template source, so a BUCKET_CHECK edit is invisible', () => {
    // The honest boundary of this pin, measured rather than asserted in prose.
    // Migrations 6 and 7 build their bucket CHECK constraint by interpolating
    // `${BUCKET_CHECK}` - a module constant derived from TOKEN_BUCKETS, but not
    // itself part of the hashed `frozenConstants` blob. `up.toString()` returns
    // the template with that interpolation unevaluated, so changing how
    // BUCKET_CHECK is derived would change the SQL these migrations emit while
    // leaving every literal above untouched.
    const withInterpolation = migrations.filter((m) => m.up.toString().includes('${BUCKET_CHECK}'));
    expect(withInterpolation.map((m) => m.id)).toEqual([6, 7]);

    // Migration 6 is the pure case: not one of the five bucket names the
    // constant expands to appears in the text that gets hashed. (Migration 7 is
    // not asserted this way - it names the same buckets legitimately, as keys of
    // its own `rates` object, so its hash does cover them.)
    const migration6 = withInterpolation[0];
    if (migration6 === undefined) {
      throw new Error('migration 6 is missing');
    }
    const hashed6 = migration6.up.toString();
    for (const bucket of ['input', 'output', 'cache_read', 'cache_write_5m', 'cache_write_1h']) {
      expect(hashed6).not.toContain(`'${bucket}'`);
    }
  });

  it('MEASURED: under this executor a comment-only difference does NOT change the checksum', () => {
    // Not a claim about the formula - a claim about esbuild, which is what both
    // vitest and `tsx` run. It deletes comments before `toString()` can see
    // them, so the two bodies are already identical by the time the hash runs.
    // This assertion is therefore a second, self-explaining detector for the
    // transform change the pinned literals also encode: a comment-preserving
    // executor fails HERE with an obvious cause instead of only producing
    // sixteen mystifying hex diffs.
    const commented = squeeze(COMMENTED_PROBE.up.toString());
    const uncommented = squeeze(UNCOMMENTED_PROBE.up.toString());

    // Guard the guard: a body optimised away to nothing would collide for the
    // wrong reason and make this test vacuous.
    expect(commented).toContain('probeSink.push(PROBE_SQL)');
    expect(commented).not.toContain('//');

    expect(commented).toBe(uncommented);
    expect(migrationChecksum(COMMENTED_PROBE)).toBe(migrationChecksum(UNCOMMENTED_PROBE));
  });

  it('MEASURED: whitespace squeezing keeps a comment, but the formula removes it', () => {
    // The other half of the same measurement, and the half review H-1 changed.
    //
    // Whitespace squeezing on its own still cannot remove a comment - `\s+`
    // squeezes it and leaves the text sitting in the stream, asserted first so
    // the second half cannot pass vacuously.
    expect(squeeze(UNTRANSFORMED_WITH_COMMENT)).toContain('//Thiscommentistheonly');

    // But the REAL `migrationChecksum` no longer normalises by squeezing alone.
    // Hand it those same two bodies as untransformed text - what a
    // comment-preserving executor gives it - and the checksums now AGREE,
    // because its lexer drops the comment before hashing. That is intended: a
    // comment cannot change what a migration does, so a comment-only edit must
    // not brick a healthy database, and a comment-preserving executor must not
    // disagree with a comment-deleting one for that reason alone.
    expect(migrationChecksum(migrationWithSource(UNTRANSFORMED_WITH_COMMENT))).toBe(
      migrationChecksum(migrationWithSource(UNTRANSFORMED_WITHOUT_COMMENT)),
    );

    // Guard against the vacuous way that could pass: normalising everything to
    // the empty string would make any two bodies agree. The surviving text must
    // still carry the statement.
    expect(migrationChecksum(migrationWithSource(UNTRANSFORMED_WITH_COMMENT))).not.toBe(
      migrationChecksum(migrationWithSource('up() {}')),
    );

    // And the measurement that bounds the claim: once the comment is gone, the
    // untransformed body and the transformed one normalise IDENTICALLY. So
    // comment removal is the whole of what vite's transform contributes to this
    // body - it is not merely one difference among several. (Measured: it does
    // NOT hold under tsx, which prints `push(PROBE_SQL)}` where vite prints
    // `push(PROBE_SQL);}` - the same separator elision that
    // PINNED_NORMALISED_MIGRATION_2's docstring describes, and that the real
    // formula cancels under both executors.)
    expect(squeeze(UNTRANSFORMED_WITHOUT_COMMENT)).toBe(squeeze(UNCOMMENTED_PROBE.up.toString()));
  });
});
