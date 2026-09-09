/**
 * The built SPA, served by the SAME loopback server that serves /api - so the
 * product is one command and one port instead of two dev servers on two
 * origins. Serving both from one origin is also what makes the SSE same-origin
 * check on /api/stream a real defence rather than a permanent CORS exception.
 *
 * Hand-rolled on purpose: no @fastify/static, no mime library. The whole
 * surface is "read one file out of one directory", the dependency budget of
 * this project is deliberately tiny (a CI licence/provenance gate stands behind
 * every addition), and every branch here has to be reachable by a real test
 * because coverage is pinned at 100% with no ignore pragmas allowed.
 *
 * SECURITY - why this surface is UNAUTHENTICATED, and why that is safe:
 * every /api route stays behind the Bearer gate in server.ts; only the shell of
 * the UI is public. The bundle holds NO secret - the operator types the token
 * into the running page and it lives in sessionStorage, never in the build. The
 * gate cannot be applied here anyway: a browser cannot present an Authorization
 * header when it is asked for a page it has not loaded yet, so gating the HTML
 * would mean no token could ever be entered. What is served is therefore the
 * same JS/CSS that anyone can read in this public repository, from a socket
 * bound to 127.0.0.1 only. It is the one unauthenticated surface in the server,
 * and it deliberately exposes no data whatsoever.
 *
 * SECURITY - the static handler must never answer an /api path. Fastify's
 * router prefers a registered exact route over the wildcard, so /api/health and
 * /api/stream keep their handlers (and their auth gate) untouched; but an
 * UNREGISTERED path like /api/unknown would otherwise fall to the wildcard,
 * whose routed pattern is '/*' - which does NOT start with '/api/', so the
 * auth hook skips it. The explicit first-segment guard below closes that: a
 * path in the `api` namespace gets the uniform 404 before a single filesystem
 * call. The guard folds case, because the filesystem does - see
 * {@link API_PATH_PATTERN}, which is where that was got wrong once already.
 */
import { closeSync, constants, lstatSync, openSync, readFileSync, realpathSync } from 'node:fs';
import { extname, join } from 'node:path';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { assertWithinRoot, isSafeEntryName } from '../corpus/corpus-paths';

/** The SPA entry document, the only file served for '/'. */
export const SPA_INDEX_FILE = 'index.html';

/** Uniform 404 message - the same `{ error }` shape every API route uses. */
export const NOT_FOUND_MESSAGE = 'Not found.';

/**
 * Status for "the UI has not been built yet".
 *
 * 503, not 404 and not 500. 404 would say "this URL does not exist", which is
 * false - '/' is exactly where the dashboard lives, and a monitoring probe must
 * be able to tell a wrong URL from a missing build. 500 would say the server
 * failed, which is also false: the API is up and every endpoint works; only the
 * optional UI asset is absent. 503 is the honest "this surface is temporarily
 * unavailable, and here is what to do about it" - and it is not cached by
 * default, so the page starts working the moment the build lands.
 */
export const SPA_NOT_BUILT_STATUS = 503;

/** Actionable, path-free: a filesystem path in a response body is a leak. */
export const SPA_NOT_BUILT_MESSAGE =
  'The dashboard UI is not built yet. Run `pnpm start` (which builds it first), ' +
  'or `pnpm --filter @agenthropic/web build`, then reload this page.';

/** Never guessed, never sniffed - an unknown extension is opaque bytes. */
export const DEFAULT_CONTENT_TYPE = 'application/octet-stream';

/**
 * The only HTML this build emits is an entry document, so this content type is
 * also the marker for "never cache this". Named rather than inlined twice so
 * the table entry and the cache rule below cannot drift apart.
 */
const HTML_CONTENT_TYPE = 'text/html; charset=utf-8';

/**
 * Cache directive for the entry document, on EVERY route that can produce it.
 *
 * The reason is in the '/' handler: the document's asset references are
 * content-hashed, so a copy cached across a rebuild points at files that no
 * longer exist. That reason does not depend on which URL the document was
 * fetched from - and the wildcard can serve the very same file as
 * '/index.html'. Measured before this was added: `GET /` carried
 * `cache-control: no-store` while `GET /index.html` carried no cache header at
 * all, which leaves the identical bytes heuristically cacheable. The rule keys
 * off {@link HTML_CONTENT_TYPE} rather than off the file name, so it holds for
 * any HTML the build ever emits; the hashed assets stay cacheable.
 */
const NO_STORE = 'no-store';

/**
 * Extension -> content type. A fixed table rather than a mime package: this is
 * the complete set a Vite build of this app can emit, and anything outside it
 * is served as opaque bytes rather than a guess. Charset is spelled out for
 * every text format so a UTF-8 bundle is never decoded as latin-1.
 */
const CONTENT_TYPES: Readonly<Record<string, string>> = {
  '.html': HTML_CONTENT_TYPE,
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

/**
 * The one URL namespace the static handler refuses to answer under: a first
 * segment of `api`, alone or followed by anything.
 *
 * The leading `\/*` is not decoration. Fastify hands the wildcard the path with
 * the FIRST slash already consumed by the route, so `/api/health` arrives as
 * `api/health` - but `//api/health` arrives as `/api/health`, with an empty
 * leading segment, and `/%2fapi/health` decodes to exactly the same thing.
 * Without the `\/*` those two forms miss the guard and fall through to
 * {@link readSiteFile}, where they are refused only as a side effect of the
 * empty-segment rule in {@link isSafeEntryName}. Measured: both currently 404,
 * so nothing is exploitable today - but the refusal comes from the wrong rule,
 * and the invariant this constant exists to hold ("a path in the `api`
 * namespace is never answered off the filesystem") would be one leniency about
 * duplicate slashes away from being false. The guard states it directly.
 *
 * Matched case-INSENSITIVELY, because the filesystem underneath is. This guard
 * originally compared the first segment to the literal `'api'`, and on the
 * project's own target platform that was a hole: macOS mounts APFS
 * case-insensitively by default, so a bait file at `<root>/api/health` opened
 * happily as `API/health`. `GET /api/health` was refused while `GET /API/health`
 * returned that file's bytes with 200 - measured against a real server on this
 * machine, not reasoned about. The router is case-SENSITIVE, so `/API/health`
 * never reached the real (gated) handler and no gated data was ever reachable
 * this way; what the case-sensitive compare leaked past was the invariant
 * itself - "a path in the /api namespace is never answered off the filesystem" -
 * which is the guard's whole job, and which future files under the built root
 * would rely on.
 *
 * `/i` folds exactly the set APFS folds for this word, which was measured
 * rather than assumed: of `api`, `API`, `Api`, `aPI`, `APİ` (U+0130), `apı`
 * (U+0131), `ＡＰＩ` (fullwidth) and `ᴀᴘɪ` (small capitals), the filesystem
 * opened the four ASCII-case variants and returned ENOENT for the other four -
 * the same four this pattern matches. On a case-SENSITIVE volume the pattern is
 * stricter than the filesystem (it still refuses `/API/...`, which could not
 * have resolved anyway), and stricter is the safe direction for a refusal.
 */
const API_PATH_PATTERN = /^\/*api(?:\/|$)/i;

/**
 * True when a wildcard request path lies in the `api` namespace and must
 * therefore never be answered off the filesystem. See {@link API_PATH_PATTERN}.
 *
 * Exported so the rule can be asserted directly rather than only through a
 * status code: every HTTP-level refusal of an `/api` path is a 404 that
 * {@link readSiteFile} would also have produced on its own, so a test that
 * checked the status alone could not tell the guard from a missing file and
 * would pass just as happily with the guard deleted.
 */
export function isApiNamespacePath(requestPath: string): boolean {
  return API_PATH_PATTERN.test(requestPath);
}

/**
 * Sent on every static response, including the refusals.
 *
 * This is precaution, not a fix for anything demonstrated here: no sniffing
 * exploit was reproduced against this surface. The reasoning is that any
 * extension outside {@link CONTENT_TYPES} is served as
 * {@link DEFAULT_CONTENT_TYPE}, and a user agent that sniffed such a body as
 * HTML would be executing script on THIS origin - the same origin the SSE
 * same-origin check on /api/stream treats as trusted. One header with no branch
 * behind it takes that class off the table rather than leaving it to argument.
 */
const NOSNIFF_HEADER = 'x-content-type-options';
const NOSNIFF_VALUE = 'nosniff';

/** Content type for a request path, or {@link DEFAULT_CONTENT_TYPE}. */
export function contentTypeFor(filePath: string): string {
  return CONTENT_TYPES[extname(filePath).toLowerCase()] ?? DEFAULT_CONTENT_TYPE;
}

/**
 * Read one file out of the web root, or `null` when it must not be served.
 *
 * `null` covers every refusal with ONE answer on purpose - missing root,
 * missing file, traversal, symlink escape, directory, dotfile, permission
 * error. The caller turns all of them into the same 404, so the response can
 * never be used to probe what exists outside the root or what the root's path
 * even is.
 *
 * `segments` are the ALREADY-DECODED path segments (Fastify percent-decodes the
 * wildcard exactly once; nothing here decodes again, so a double-encoded
 * `%252e%252e%252f` stays the literal filename it decoded to and cannot become
 * a traversal on a second pass).
 *
 * Containment is decided on the RESOLVED path, never on the request string:
 * both the root and the target go through `realpathSync`, so a symlink planted
 * inside the root that points outside is judged by where it actually lands, and
 * {@link assertWithinRoot} then requires the target to be the root itself or to
 * sit under `root + sep` - the separator being what stops a sibling directory
 * whose name merely starts with the root's name (`/site` vs `/site-secret`).
 *
 * The compare stays case-SENSITIVE even though macOS is usually not. That is
 * deliberate: `realpathSync` on macOS resolves symlinks but does NOT canonicalize
 * case, so a root configured as `/SITE` for an on-disk `/site` yields a root
 * string that no resolved child of `/site` is a prefix of - and every such
 * request is refused. Fail-closed under a case mismatch is the correct
 * direction; a case-insensitive compare would be the one that could be talked
 * into accepting a path outside the root on a case-sensitive volume.
 */
export function readSiteFile(webRoot: string, segments: readonly string[]): Buffer | null {
  for (const segment of segments) {
    // `isSafeEntryName` rejects '', '.', '..' and any embedded '/' or '\\' -
    // the same rule the corpus reader uses, stated once. The dot-prefix rule
    // keeps dotfiles (.env, .git, .DS_Store, tsconfig's .tsbuildinfo) off the
    // wire; a NUL is truncation bait for any C-level path API and is never a
    // legitimate file name.
    if (!isSafeEntryName(segment) || segment.startsWith('.') || segment.includes('\u0000')) {
      return null;
    }
  }
  try {
    const rootReal = realpathSync(webRoot);
    const target = realpathSync(join(rootReal, ...segments));
    assertWithinRoot(rootReal, target);
    if (!lstatSync(target).isFile()) {
      return null; // a directory is not content, and is never listed
    }
    // O_NOFOLLOW on the already-resolved path closes the TOCTOU window between
    // the realpath above and this open: if the entry became a symlink in
    // between, the open fails (ELOOP) instead of following it. Same idiom as
    // the corpus reader's confined read.
    const fd = openSync(target, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      return readFileSync(fd);
    } finally {
      closeSync(fd);
    }
  } catch {
    return null;
  }
}

export interface StaticSiteOptions {
  /** Absolute path of the built SPA directory (apps/web/dist by default). */
  readonly webRoot: string;
}

/** The uniform 404 - identical body for every refusal, no path, no reason. */
function notFound(reply: FastifyReply): FastifyReply {
  return reply.code(404).send({ error: NOT_FOUND_MESSAGE });
}

/**
 * Register the static site on `app`: '/' serves index.html, '/<path>' serves an
 * emitted asset, everything else is a uniform 404.
 *
 * NO history-API catch-all is needed and none is added: the SPA routes on the
 * URL hash, so the browser only ever asks this server for '/' and for files
 * that were actually emitted. A wildcard that answered index.html for unknown
 * paths would invent routes that do not exist and would blur the /api boundary
 * for no benefit.
 */
export function registerStaticSite(app: FastifyInstance, options: StaticSiteOptions): void {
  const { webRoot } = options;

  app.get('/', async (_request, reply) => {
    const body = readSiteFile(webRoot, [SPA_INDEX_FILE]);
    // The entry document is never stored: its asset references are content
    // hashed, so a cached copy from a previous build points at files that no
    // longer exist. The hashed assets themselves are safe to cache.
    void reply.header('cache-control', NO_STORE).header(NOSNIFF_HEADER, NOSNIFF_VALUE);
    if (body === null) {
      return reply.code(SPA_NOT_BUILT_STATUS).send({ error: SPA_NOT_BUILT_MESSAGE });
    }
    return reply.type(contentTypeFor(SPA_INDEX_FILE)).send(body);
  });

  app.get<{ Params: { '*': string } }>('/*', async (request, reply) => {
    const requestPath = request.params['*'];
    void reply.header(NOSNIFF_HEADER, NOSNIFF_VALUE);
    if (isApiNamespacePath(requestPath)) {
      // Never a filesystem lookup for an /api path - see the header comment.
      return notFound(reply);
    }
    const body = readSiteFile(webRoot, requestPath.split('/'));
    if (body === null) {
      return notFound(reply);
    }
    const contentType = contentTypeFor(requestPath);
    if (contentType === HTML_CONTENT_TYPE) {
      // The same document '/' serves, reached by its file name - see NO_STORE.
      void reply.header('cache-control', NO_STORE);
    }
    return reply.type(contentType).send(body);
  });
}
