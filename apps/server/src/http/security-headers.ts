/**
 * Browser-hardening headers sent on EVERY response - SPA shell, assets, JSON
 * API, errors, 404s and the SSE stream alike (R18 / SEC-3).
 *
 * - `frame-ancestors 'none'` + `X-Frame-Options: DENY`: no page the user visits
 *   can frame the dashboard and clickjack the token-entry screen (XFO for
 *   browsers that predate CSP level 2).
 * - The rest of the CSP limits what a future XSS (an unescaped D3 label, a
 *   compromised dependency) could do with the `sessionStorage` token: scripts,
 *   styles and fetch/EventSource only from this origin, so the token cannot be
 *   sent elsewhere; no `<base>` rewrite, no plugins, forms post only here. The
 *   built SPA is one external module script and one stylesheet - no inline
 *   code - so it needs no `unsafe-*` source.
 * - `Referrer-Policy: no-referrer`: a link out of the dashboard never leaks a
 *   session path (or a `?token=` URL) to a third party.
 */
export const CONTENT_SECURITY_POLICY =
  "default-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; " +
  "form-action 'self'; object-src 'none'";

export const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  'content-security-policy': CONTENT_SECURITY_POLICY,
  'x-frame-options': 'DENY',
  'referrer-policy': 'no-referrer',
};
