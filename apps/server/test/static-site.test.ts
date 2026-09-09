/**
 * Single-port static site: the built SPA served from the same loopback origin
 * as /api.
 *
 * Every fixture is a REAL directory under `mkdtempSync` - including a real
 * symlink that escapes the root - and the web root is injected through
 * `buildServer` options, so nothing here depends on the process's cwd or on the
 * repository having been built.
 *
 * The security half of this file is the point of it: traversal (raw, encoded,
 * double-encoded, backslash, absolute, NUL), containment by RESOLVED path,
 * symlink escape, dotfiles, directories, methods, and the rule that the static
 * handler must never answer an /api path.
 */
import { lstatSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import {
  contentTypeFor,
  DEFAULT_CONTENT_TYPE,
  isApiNamespacePath,
  NOT_FOUND_MESSAGE,
  readSiteFile,
  SPA_INDEX_FILE,
  SPA_NOT_BUILT_MESSAGE,
  SPA_NOT_BUILT_STATUS,
} from '../src/http/static-site';
import { buildServer } from '../src/server';
import { TEST_TOKEN } from './helpers';

const INDEX_HTML =
  '<!doctype html><html><head><title>agenthropic</title></head><body></body></html>';
const SCRIPT_JS = 'export const dashboard = 1;\n';
const SECRET = 'TOP-SECRET-OUTSIDE-THE-ROOT';
const STATIC_API_BAIT = 'STATIC-FILE-PRETENDING-TO-BE-THE-API';
/** A NUL built without an escape sequence - a literal one in source is a trap. */
const NUL = String.fromCharCode(0);
/** Served content under a first segment that merely LOOKS like the api one. */
const NEAR_MISS_BODY = 'NOT-THE-API-NAMESPACE';
/** A symlink INSIDE the root, pointing at `assets/` - the contained control. */
const CONTAINED_LINK = 'shortcut';
/**
 * Character devices, used to prove no read is attempted. Both are POSIX and
 * both are S_IFCHR on macOS and on Linux; `/dev/null` is the important half of
 * the pair, because reading IT succeeds instantly - so a refusal that covers
 * both cannot be "the read failed", it has to be "no read happened".
 */
const CHAR_DEVICE_DIR = '/dev';
const NEVER_ENDING_DEVICE = 'zero';
const EMPTY_DEVICE = 'null';
/**
 * The same glyph twice: `cafe` + an acute e, COMPOSED (U+00E9) and DECOMPOSED
 * (`e` + U+0301). Written as escapes, never as literal characters - the two
 * spellings are indistinguishable on screen, and an editor or a formatter that
 * normalised the file would silently collapse this test into a tautology.
 */
const NFC_NAME = 'caf\u00e9.txt';
const NFD_NAME = 'cafe\u0301.txt';

describe('static site (single port)', () => {
  let dir: string;
  let siteRoot: string;
  let app: FastifyInstance;
  let unbuilt: FastifyInstance;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'agenthropic-static-'));
    siteRoot = join(dir, 'site');
    mkdirSync(join(siteRoot, 'assets'), { recursive: true });
    writeFileSync(join(siteRoot, SPA_INDEX_FILE), INDEX_HTML);
    writeFileSync(join(siteRoot, 'assets', 'index-abc123.js'), SCRIPT_JS);
    writeFileSync(join(siteRoot, 'assets', 'index-abc123.css'), 'body{color:#111}');
    writeFileSync(join(siteRoot, 'favicon.ico'), 'icon-bytes');
    writeFileSync(join(siteRoot, 'payload.bin'), 'opaque-bytes');
    writeFileSync(join(siteRoot, '.env'), 'DASHBOARD_TOKEN=not-really');

    // Bait: a real file that WOULD be servable if the /api guard were absent.
    mkdirSync(join(siteRoot, 'api'));
    writeFileSync(join(siteRoot, 'api', 'unknown'), STATIC_API_BAIT);
    writeFileSync(join(siteRoot, 'api', 'health'), STATIC_API_BAIT);

    // The near miss: a first segment that shares the api one's prefix but is
    // NOT in the namespace. It is the positive control for every refusal in
    // 'route shadowing' below - it proves nested lookup through the wildcard
    // works, so those 404s are the guard refusing and not a dead pipeline.
    mkdirSync(join(siteRoot, 'apix'));
    writeFileSync(join(siteRoot, 'apix', 'health'), NEAR_MISS_BODY);

    // A sibling whose name merely STARTS WITH the root's name: a containment
    // check written as `resolved.startsWith(root)` without the separator would
    // accept everything in here.
    const outside = join(dir, 'site-secret');
    mkdirSync(outside);
    writeFileSync(join(outside, 'secret.txt'), SECRET);
    // Held in its DECOMPOSED spelling, so the normalisation test can ask for it
    // in the composed one - the pairing macOS resolves and Linux does not.
    writeFileSync(join(outside, NFD_NAME), SECRET);
    // A character device reached through a symlink: reading one never reaches
    // EOF, so this is the fixture behind 'a character device is never read'.
    symlinkSync('/dev/zero', join(siteRoot, 'zero.bin'));
    // Real symlinks that escape the root: one as the final component, one as an
    // intermediate directory component (which `lstat` alone would never see).
    symlinkSync(join(outside, 'secret.txt'), join(siteRoot, 'escape.txt'));
    symlinkSync(outside, join(siteRoot, 'escape-dir'));
    // ...and the positive control for both of those: a symlink that stays
    // INSIDE the root. Containment is decided by where a link lands, not by
    // "it is a link" - without this fixture a handler that refused every
    // symlink outright would pass every escape test in this file.
    symlinkSync(join(siteRoot, 'assets'), join(siteRoot, CONTAINED_LINK));

    app = buildServer({ token: TEST_TOKEN, schemaVersion: 7, webRoot: siteRoot });
    await app.ready();
    unbuilt = buildServer({
      token: TEST_TOKEN,
      schemaVersion: 7,
      webRoot: join(dir, 'never-built'),
    });
    await unbuilt.ready();
  });

  afterAll(async () => {
    await app.close();
    await unbuilt.close();
    rmSync(dir, { recursive: true, force: true });
  });

  describe('serving the built SPA', () => {
    it("serves index.html at '/' as UTF-8 HTML", async () => {
      const response = await app.inject({ method: 'GET', url: '/' });
      expect(response.statusCode).toBe(200);
      expect(response.headers['content-type']).toBe('text/html; charset=utf-8');
      expect(response.body).toBe(INDEX_HTML);
    });

    it('serves an emitted asset with its own content type', async () => {
      const script = await app.inject({ method: 'GET', url: '/assets/index-abc123.js' });
      expect(script.statusCode).toBe(200);
      expect(script.headers['content-type']).toBe('text/javascript; charset=utf-8');
      expect(script.body).toBe(SCRIPT_JS);

      const style = await app.inject({ method: 'GET', url: '/assets/index-abc123.css' });
      expect(style.statusCode).toBe(200);
      expect(style.headers['content-type']).toBe('text/css; charset=utf-8');

      const icon = await app.inject({ method: 'GET', url: '/favicon.ico' });
      expect(icon.statusCode).toBe(200);
      expect(icon.headers['content-type']).toBe('image/x-icon');
    });

    it('never guesses a content type - an unknown extension is opaque bytes', async () => {
      const response = await app.inject({ method: 'GET', url: '/payload.bin' });
      expect(response.statusCode).toBe(200);
      expect(response.headers['content-type']).toBe(DEFAULT_CONTENT_TYPE);
    });

    it('answers HEAD for the entry document without a body', async () => {
      const response = await app.inject({ method: 'HEAD', url: '/' });
      expect(response.statusCode).toBe(200);
      expect(response.headers['content-type']).toBe('text/html; charset=utf-8');
      expect(response.body).toBe('');
    });

    it('does not let a browser cache the entry document across builds', async () => {
      const response = await app.inject({ method: 'GET', url: '/' });
      expect(response.headers['cache-control']).toBe('no-store');
    });

    it('maps every extension the build can emit, and nothing else', () => {
      expect(contentTypeFor('index.html')).toBe('text/html; charset=utf-8');
      expect(contentTypeFor('a/b/app.mjs')).toBe('text/javascript; charset=utf-8');
      expect(contentTypeFor('app.js.map')).toBe('application/json; charset=utf-8');
      expect(contentTypeFor('manifest.json')).toBe('application/json; charset=utf-8');
      expect(contentTypeFor('robots.txt')).toBe('text/plain; charset=utf-8');
      expect(contentTypeFor('logo.svg')).toBe('image/svg+xml');
      expect(contentTypeFor('a.png')).toBe('image/png');
      expect(contentTypeFor('a.jpg')).toBe('image/jpeg');
      expect(contentTypeFor('a.jpeg')).toBe('image/jpeg');
      expect(contentTypeFor('a.gif')).toBe('image/gif');
      expect(contentTypeFor('a.webp')).toBe('image/webp');
      expect(contentTypeFor('a.ico')).toBe('image/x-icon');
      expect(contentTypeFor('f.woff')).toBe('font/woff');
      expect(contentTypeFor('f.woff2')).toBe('font/woff2');
      // Case-folded, so an uppercase name is not silently downgraded to bytes.
      expect(contentTypeFor('LOGO.PNG')).toBe('image/png');
      // No extension, and an extension nobody emits: both opaque.
      expect(contentTypeFor('LICENSE')).toBe(DEFAULT_CONTENT_TYPE);
      expect(contentTypeFor('archive.tar.gz')).toBe(DEFAULT_CONTENT_TYPE);
    });
  });

  describe('the API surface is untouched', () => {
    it('keeps /api/health 401 without a token, even with the static site registered', async () => {
      const response = await app.inject({ method: 'GET', url: '/api/health' });
      expect(response.statusCode).toBe(401);
      expect(response.json()).toEqual({ error: 'Unauthorized.' });
      // The bait file at <root>/api/health must not have been served instead.
      expect(response.body).not.toContain(STATIC_API_BAIT);
    });

    it('keeps /api/health 200 with the token', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/health',
        headers: { authorization: `Bearer ${TEST_TOKEN}` },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ status: 'ok', schemaVersion: 7 });
    });

    it('never answers an unregistered /api path off the filesystem', async () => {
      // <root>/api/unknown EXISTS on disk. The first-segment guard must refuse
      // before any filesystem call, or the static surface would silently start
      // answering /api paths that the auth gate does not cover.
      const response = await app.inject({ method: 'GET', url: '/api/unknown' });
      expect(response.statusCode).toBe(404);
      expect(response.json()).toEqual({ error: NOT_FOUND_MESSAGE });
      expect(response.body).not.toContain(STATIC_API_BAIT);
    });

    it('refuses the /api segment however deep the path goes', async () => {
      const response = await app.inject({ method: 'GET', url: '/api/v2/anything/at/all' });
      expect(response.statusCode).toBe(404);
      expect(response.json()).toEqual({ error: NOT_FOUND_MESSAGE });
    });

    it('serves a first segment that merely shares the api prefix', async () => {
      // The positive control for every refusal above: nested lookup through the
      // wildcard does work, so those 404s are the guard refusing and not a dead
      // pipeline that would answer nothing either way.
      const response = await app.inject({ method: 'GET', url: '/apix/health' });
      expect(response.statusCode).toBe(200);
      expect(response.body).toBe(NEAR_MISS_BODY);
    });

    it('decides the namespace from the path itself, not from a status code', () => {
      // Each refusal above is a 404 that a missing file would produce too, so
      // those tests would pass just as happily with the guard deleted. This one
      // asks the rule directly, and pins the prefix cases in both directions.
      //
      // The unprefixed spellings are the ones that MATTER, and are listed
      // first: measured against a bare Fastify wildcard, `GET /api/health`
      // hands the handler `api/health` - the route eats the leading slash - and
      // only the `//api/...` and `/%2fapi/...` forms arrive with one. A guard
      // written `^\/+api` would therefore be dead for every ordinary request
      // while still satisfying a slash-prefixed-only list.
      for (const inNamespace of [
        'api',
        'api/',
        'api/health',
        'api/unknown',
        'API/unknown',
        '/api',
        '/api/',
        '/api/health',
        '/API/health',
        '//api/health',
      ]) {
        expect(isApiNamespacePath(inNamespace)).toBe(true);
      }
      for (const outside of [
        '',
        'apix/health',
        'assets/index-abc123.js',
        'apiary',
        '/apix',
        '/apix/health',
        '/',
        '/assets/index-abc123.js',
        '/apiary',
      ]) {
        expect(isApiNamespacePath(outside)).toBe(false);
      }
    });

    it('applies the guard to the DECODED path, not to the raw one', async () => {
      // Fastify percent-decodes the wildcard exactly once before the handler
      // sees it, so an encoded spelling of the namespace is still the
      // namespace. Measured against a bare wildcard: `/api%2funknown` and
      // `/%41%50%49/unknown` arrive as `api/unknown` and `API/unknown`, and
      // `/%2fapi/unknown` arrives with the empty leading segment the `\/*` in
      // the pattern exists for.
      for (const url of ['/api%2funknown', '/api%2Funknown', '/%41%50%49/unknown']) {
        const response = await app.inject({ method: 'GET', url });
        expect(response.statusCode).toBe(404);
        expect(response.json()).toEqual({ error: NOT_FOUND_MESSAGE });
        expect(response.body).not.toContain(STATIC_API_BAIT);
      }
    });

    it('refuses the bait even though it is a perfectly readable file', () => {
      // The one assertion that makes every /api 404 in this block mean
      // something: read through the function directly, WITHOUT the HTTP guard,
      // both bait files come back. So the 404s above are the guard refusing a
      // file that is there - not the uninteresting 404 of a file that is not.
      expect(readSiteFile(siteRoot, ['api', 'unknown'])?.toString()).toBe(STATIC_API_BAIT);
      expect(readSiteFile(siteRoot, ['api', 'health'])?.toString()).toBe(STATIC_API_BAIT);
    });
  });

  describe('security: the sniffing opt-out is on the refusals too', () => {
    it('sends nosniff on every answer this surface produces', async () => {
      // The header's docstring claims "every static response, including the
      // refusals" - a claim nothing asserted. Measured: present on the 200s, on
      // a HEAD, on BOTH flavours of 404 (a missing file and the /api guard, set
      // at different points in the handler) and on the 503 the unbuilt server
      // answers at '/'. Listed rather than checked once, because a refusal path
      // is exactly where a header set on the success path gets forgotten.
      const answers = [
        await app.inject({ method: 'GET', url: '/' }),
        await app.inject({ method: 'GET', url: '/assets/index-abc123.js' }),
        await app.inject({ method: 'HEAD', url: '/assets/index-abc123.js' }),
        await app.inject({ method: 'GET', url: '/nope.js' }),
        await app.inject({ method: 'GET', url: '/.env' }),
        await app.inject({ method: 'GET', url: '/api/unknown' }),
        await app.inject({ method: 'HEAD', url: '/api/unknown' }),
        await unbuilt.inject({ method: 'GET', url: '/' }),
      ];
      for (const answer of answers) {
        expect(answer.headers['x-content-type-options']).toBe('nosniff');
      }
      // ...and their statuses, so this list cannot quietly decay into eight
      // copies of the same 404 that would prove nothing about the refusals.
      expect(answers.map((answer) => answer.statusCode)).toEqual([
        200,
        200,
        200,
        404,
        404,
        404,
        404,
        SPA_NOT_BUILT_STATUS,
      ]);
    });
  });

  describe('security: traversal is closed', () => {
    /** Every refusal is the SAME body: no path, no reason, nothing to probe. */
    async function expectUniform404(url: string): Promise<void> {
      const response = await app.inject({ method: 'GET', url });
      expect(response.statusCode).toBe(404);
      expect(response.json()).toEqual({ error: NOT_FOUND_MESSAGE });
      expect(response.body).not.toContain(SECRET);
      expect(response.body).not.toContain(dir);
    }

    it('refuses percent-encoded ../ traversal', async () => {
      await expectUniform404('/%2e%2e%2fsite-secret%2fsecret.txt');
      await expectUniform404('/assets%2f%2e%2e%2f%2e%2e%2fsite-secret%2fsecret.txt');
    });

    it('refuses double-encoded traversal (nothing is decoded twice)', async () => {
      await expectUniform404('/%252e%252e%252fsite-secret%252fsecret.txt');
    });

    it('refuses backslash traversal variants', async () => {
      await expectUniform404('/%2e%2e%5csite-secret%5csecret.txt');
      await expectUniform404('/assets%5c%2e%2e%5csecret.txt');
    });

    it('refuses absolute-looking paths', async () => {
      await expectUniform404('//etc/passwd');
      await expectUniform404('/%2fetc%2fpasswd');
      await expectUniform404(`/%2f${SECRET}`);
    });

    it('refuses an encoded NUL', async () => {
      await expectUniform404('/index.html%00');
      await expectUniform404('/%00index.html');
    });

    it('refuses traversal segments at the function boundary too', () => {
      // The HTTP tests above go through one URL parser and one router; these
      // pin the RULE itself, so it cannot be weakened by a change that happens
      // to keep some particular encoding harmless.
      expect(readSiteFile(siteRoot, ['..', '..', 'etc', 'passwd'])).toBeNull();
      expect(readSiteFile(siteRoot, ['..', 'site-secret', 'secret.txt'])).toBeNull();
      expect(readSiteFile(siteRoot, ['.'])).toBeNull();
      expect(readSiteFile(siteRoot, [''])).toBeNull();
      expect(readSiteFile(siteRoot, ['assets/../../site-secret/secret.txt'])).toBeNull();
      expect(readSiteFile(siteRoot, [`${SPA_INDEX_FILE}${NUL}`])).toBeNull();
      expect(readSiteFile(siteRoot, ['assets', `..${NUL}`])).toBeNull();
      // ...and the positive control, so the refusals above are not vacuous.
      expect(readSiteFile(siteRoot, [SPA_INDEX_FILE])?.toString()).toBe(INDEX_HTML);
    });
  });

  describe('security: containment is decided on the resolved path', () => {
    it('does not follow a symlink that leaves the root', async () => {
      const response = await app.inject({ method: 'GET', url: '/escape.txt' });
      expect(response.statusCode).toBe(404);
      expect(response.json()).toEqual({ error: NOT_FOUND_MESSAGE });
      expect(response.body).not.toContain(SECRET);
      // The same file IS readable through its real path - proof the 404 is the
      // containment rule refusing, not a broken fixture.
      expect(readSiteFile(join(dir, 'site-secret'), ['secret.txt'])?.toString()).toBe(SECRET);
    });

    it('does not follow a symlinked intermediate directory', async () => {
      const response = await app.inject({ method: 'GET', url: '/escape-dir/secret.txt' });
      expect(response.statusCode).toBe(404);
      expect(response.body).not.toContain(SECRET);
    });

    it('requires a separator, so a sibling starting with the root name is outside', () => {
      // `<tmp>/site-secret` starts with `<tmp>/site`. A prefix compare without
      // the trailing separator would call it contained; both escapes above land
      // exactly there, and both are refused.
      expect(readSiteFile(siteRoot, ['escape.txt'])).toBeNull();
      expect(readSiteFile(siteRoot, ['escape-dir', 'secret.txt'])).toBeNull();
    });

    it('refuses a Unicode spelling that pairs with an escaping file', async () => {
      // The file outside the root exists in its DECOMPOSED spelling; this asks
      // for the COMPOSED one, through the escaping directory symlink. On macOS
      // the filesystem pairs the two, so the open would succeed and the refusal
      // is the containment rule doing its job; on a Linux volume the name does
      // not exist and the refusal happens one step earlier. Both platforms give
      // one answer, and neither may hand back the body.
      const response = await app.inject({
        method: 'GET',
        url: `/escape-dir/${encodeURIComponent(NFC_NAME)}`,
      });
      expect(response.statusCode).toBe(404);
      expect(response.body).not.toContain(SECRET);
      expect(readSiteFile(siteRoot, ['escape-dir', NFC_NAME])).toBeNull();
      expect(readSiteFile(siteRoot, ['escape-dir', NFD_NAME])).toBeNull();
      // The positive control, so the three refusals are not vacuous: read
      // through the real directory, the decomposed name IS the secret.
      expect(readSiteFile(join(dir, 'site-secret'), [NFD_NAME])?.toString()).toBe(SECRET);
    });

    it('follows a symlink that stays inside the root', async () => {
      // The positive control for the two escapes above. `<root>/shortcut` is a
      // real symlink to `<root>/assets`, and it IS served - so those 404s are
      // the containment rule judging where a link LANDS, not a blanket "no
      // symlinks" that would pass every escape test while being a different,
      // weaker guarantee than the one the module documents.
      const response = await app.inject({
        method: 'GET',
        url: `/${CONTAINED_LINK}/index-abc123.js`,
      });
      expect(response.statusCode).toBe(200);
      expect(response.body).toBe(SCRIPT_JS);
      expect(readSiteFile(siteRoot, [CONTAINED_LINK, 'index-abc123.js'])?.toString()).toBe(
        SCRIPT_JS,
      );
    });

    it('fail-closes when the configured root differs in case from the disk', () => {
      // macOS mounts APFS case-INSENSITIVELY, and `realpathSync` resolves
      // symlinks WITHOUT canonicalizing case - so a root given as `<tmp>/SITE`
      // stays `<tmp>/SITE` while the escaping symlink resolves under the real
      // `<tmp>/site-secret`, and the case-sensitive prefix compare refuses. On a
      // case-sensitive volume the root does not exist at all and the same
      // refusal happens one step earlier. Both platforms, one answer.
      expect(readSiteFile(join(dir, 'SITE'), ['escape.txt'])).toBeNull();
    });
  });

  /**
   * A character device is never read.
   *
   * `<root>/zero.bin` is a symlink to `/dev/zero`, and a read of that device
   * never reaches EOF. A handler that opened it and read to the end would not
   * come back with an answer at all - so what has to be proved is that the
   * refusal happens BEFORE any read, at BOTH of the independent places this
   * code can refuse, because the fixture alone only exercises one of them.
   *
   * Measured on this machine (node 22.23.2, macOS, APFS), not reasoned about:
   *   lstatSync('/dev/zero').isFile()            -> false
   *   lstatSync('/dev/zero').isCharacterDevice() -> true
   *   readSiteFile(siteRoot, ['zero.bin'])       -> null, in 0.12 ms
   *   readSiteFile('/dev', ['zero'])             -> null, in 0.07 ms
   *   readSiteFile('/dev', ['null'])             -> null
   *   GET /zero.bin                              -> 404, the uniform body
   * Both device nodes are POSIX and are character devices on Linux as well, so
   * every assertion below holds on both platforms for the same reason.
   *
   * That `isFile()` is the rule doing the work was checked by mutation, on
   * `/dev/null` ONLY (an instant EOF, so it is safe to let it be read) and
   * never on `/dev/zero`: with the check replaced by an `isDirectory()` test,
   * `readSiteFile('/dev', ['null'])` came back as an empty Buffer instead of
   * null. The `null` half of the pair below therefore fails if the guard is
   * ever weakened, which is what makes this describe more than documentation.
   *
   * HONEST LIMIT of the explicit timeouts: `readSiteFile` is synchronous, so a
   * regression that really did start reading would block this worker's event
   * loop and vitest's per-test timer could never fire. The timeout bounds the
   * async half and records the intent; the proof is carried by the elapsed-time
   * bound and by `isFile()` being false for a device node.
   */
  describe('security: a character device is never read', () => {
    /** So a regression that merely stalls fails loudly instead of sitting in CI. */
    const DEVICE_TIMEOUT_MS = 5_000;
    /** ~10000x the measured time: unflakeable, and unreachable by a real read. */
    const NO_READ_BUDGET_MS = 1_000;
    const NEVER_ENDING_PATH = join(CHAR_DEVICE_DIR, NEVER_ENDING_DEVICE);

    it(
      'refuses a device reached through a symlink that leaves the root',
      async () => {
        expect(lstatSync(NEVER_ENDING_PATH).isCharacterDevice()).toBe(true);

        const started = performance.now();
        const body = readSiteFile(siteRoot, ['zero.bin']);
        const elapsedMs = performance.now() - started;
        expect(body).toBeNull();
        // A call that had begun reading /dev/zero could not have returned at
        // all, let alone returned null inside a second.
        expect(elapsedMs).toBeLessThan(NO_READ_BUDGET_MS);

        const response = await app.inject({ method: 'GET', url: '/zero.bin' });
        expect(response.statusCode).toBe(404);
        expect(response.json()).toEqual({ error: NOT_FOUND_MESSAGE });
      },
      DEVICE_TIMEOUT_MS,
    );

    it(
      'refuses a device that lies INSIDE the web root',
      () => {
        // The fixture above escapes the root, so containment alone accounts for
        // its refusal and the "not a regular file" rule is never reached.
        // Pointing the web root AT /dev takes containment out of the picture:
        // the device is inside the root, and `isFile()` is what refuses it.
        expect(lstatSync(NEVER_ENDING_PATH).isFile()).toBe(false);
        const started = performance.now();
        expect(readSiteFile(CHAR_DEVICE_DIR, [NEVER_ENDING_DEVICE])).toBeNull();
        expect(performance.now() - started).toBeLessThan(NO_READ_BUDGET_MS);

        // ...and the same refusal for the device that WOULD read fine - an
        // instant EOF - which is what makes the answer "no read was attempted"
        // rather than "the read happened to fail".
        const emptyDevicePath = join(CHAR_DEVICE_DIR, EMPTY_DEVICE);
        expect(lstatSync(emptyDevicePath).isCharacterDevice()).toBe(true);
        expect(readSiteFile(CHAR_DEVICE_DIR, [EMPTY_DEVICE])).toBeNull();
      },
      DEVICE_TIMEOUT_MS,
    );
  });

  describe('security: nothing else is exposed', () => {
    it('does not serve dotfiles', async () => {
      const response = await app.inject({ method: 'GET', url: '/.env' });
      expect(response.statusCode).toBe(404);
      expect(response.body).not.toContain('DASHBOARD_TOKEN');
      expect(readSiteFile(siteRoot, ['.env'])).toBeNull();
      expect(readSiteFile(siteRoot, ['assets', '.hidden'])).toBeNull();
    });

    it('does not list a directory, with or without a trailing slash', async () => {
      const bare = await app.inject({ method: 'GET', url: '/assets' });
      expect(bare.statusCode).toBe(404);
      expect(bare.body).not.toContain('index-abc123.js');

      const slashed = await app.inject({ method: 'GET', url: '/assets/' });
      expect(slashed.statusCode).toBe(404);
      expect(slashed.body).not.toContain('index-abc123.js');

      // The root directory itself is content only via index.html.
      expect(readSiteFile(siteRoot, ['assets'])).toBeNull();
    });

    it('404s a file that simply is not there', async () => {
      const response = await app.inject({ method: 'GET', url: '/assets/index-oldhash.js' });
      expect(response.statusCode).toBe(404);
      expect(response.json()).toEqual({ error: NOT_FOUND_MESSAGE });
    });

    it('never leaks the web root path in a 404 body', async () => {
      const response = await app.inject({ method: 'GET', url: '/nope.js' });
      expect(response.body).not.toContain(dir);
      expect(response.body).not.toContain('site');
    });

    it('answers no method other than GET/HEAD', async () => {
      // Both targets: the wildcard AND the '/' route, since they are registered
      // separately and only `app.get` was called for either. Measured: every
      // one of these is Fastify's own route-not-found 404 - the static handler
      // is never entered, which is why the body is Fastify's `{ message, error,
      // statusCode }` shape and not this surface's uniform one.
      for (const method of ['POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'] as const) {
        for (const url of ['/index.html', '/', '/assets/index-abc123.js']) {
          const response = await app.inject({ method, url });
          expect(response.statusCode).toBe(404);
          expect(response.body).not.toContain(INDEX_HTML);
          expect(response.body).not.toContain(SCRIPT_JS);
        }
      }
    });

    it('never caches the entry document, whichever URL asked for it', async () => {
      // '/' and '/index.html' are the same bytes from two routes, and the
      // reason the document must not be stored - content-hashed asset
      // references that a rebuild invalidates - does not care which one the
      // browser used. Measured before this was pinned: '/' carried no-store and
      // '/index.html' carried no cache header at all.
      for (const url of ['/', '/index.html']) {
        const response = await app.inject({ method: 'GET', url });
        expect(response.statusCode).toBe(200);
        expect(response.body).toBe(INDEX_HTML);
        expect(response.headers['cache-control']).toBe('no-store');
      }
      // The hashed assets are the opposite case and stay cacheable: their names
      // change with their content, so there is nothing to invalidate.
      const asset = await app.inject({ method: 'GET', url: '/assets/index-abc123.js' });
      expect(asset.headers['cache-control']).toBeUndefined();
    });

    it('refuses at the function boundary what has no HTTP spelling', () => {
      // Reachable only by calling `readSiteFile` directly, so nothing else in
      // this file covers them.
      // No segments at all: `join(root)` is the root, which is a directory.
      expect(readSiteFile(siteRoot, [])).toBeNull();
      // A web root of '/' is not a filesystem browser. `assertWithinRoot`
      // requires the target to be the root itself or to sit under `root + sep`,
      // and '/etc/passwd' does not start with '//' - so the whole tree is
      // refused, on macOS (where /etc resolves to /private/etc) and on Linux
      // (where it does not) alike, by the same rule.
      expect(readSiteFile('/', ['etc', 'passwd'])).toBeNull();
      expect(readSiteFile('/', ['tmp'])).toBeNull();
    });
  });

  describe('when the UI has not been built', () => {
    it("explains how to build it at '/', with an actionable status", async () => {
      const response = await unbuilt.inject({ method: 'GET', url: '/' });
      expect(response.statusCode).toBe(SPA_NOT_BUILT_STATUS);
      expect(response.json()).toEqual({ error: SPA_NOT_BUILT_MESSAGE });
      expect(SPA_NOT_BUILT_MESSAGE).toContain('pnpm');
      // Actionable, but still not a filesystem path.
      expect(response.body).not.toContain(dir);
    });

    it('does not let the 503 be cached, so the page works the moment it builds', async () => {
      // The status was chosen partly because it is not cached by default; the
      // header states it outright, so a proxy in a tunnel cannot pin the
      // "not built yet" answer in front of a UI that has since been built.
      const response = await unbuilt.inject({ method: 'GET', url: '/' });
      expect(response.headers['cache-control']).toBe('no-store');
    });

    it('answers HEAD the same way, without a body', async () => {
      // A monitoring probe that uses HEAD must get the same verdict as GET,
      // not a 200 that would read as "the dashboard is up".
      const response = await unbuilt.inject({ method: 'HEAD', url: '/' });
      expect(response.statusCode).toBe(SPA_NOT_BUILT_STATUS);
      expect(response.body).toBe('');
    });

    it('404s assets rather than pretending they exist', async () => {
      const response = await unbuilt.inject({ method: 'GET', url: '/assets/index-abc123.js' });
      expect(response.statusCode).toBe(404);
      expect(response.json()).toEqual({ error: NOT_FOUND_MESSAGE });
    });

    it('leaves the whole API working - a missing build is not a boot failure', async () => {
      const health = await unbuilt.inject({
        method: 'GET',
        url: '/api/health',
        headers: { authorization: `Bearer ${TEST_TOKEN}` },
      });
      expect(health.statusCode).toBe(200);
      expect(health.json()).toEqual({ status: 'ok', schemaVersion: 7 });

      const gated = await unbuilt.inject({ method: 'GET', url: '/api/health' });
      expect(gated.statusCode).toBe(401);
    });
  });

  it('registers no static route at all when no web root is configured', async () => {
    // The seam that keeps every API-only harness in this suite unchanged.
    const apiOnly = buildServer({ token: TEST_TOKEN, schemaVersion: 7 });
    await apiOnly.ready();
    try {
      const response = await apiOnly.inject({ method: 'GET', url: '/' });
      expect(response.statusCode).toBe(404);
      expect(response.body).not.toContain(INDEX_HTML);
    } finally {
      await apiOnly.close();
    }
  });
});
