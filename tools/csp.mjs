// The pages' Content-Security-Policy (M14 T16, docs/SECURITY.md). GitHub Pages sets no headers, so
// each page carries it as a `<meta>` whose content the build writes (`vite.config.ts`): scripts and
// workers only from the site itself and never `eval`, connections only to the site, the authority
// the build names (`AUTHORITY_URL`) and a hub on localhost (`?hub=`, E2E and `wrangler dev`).
// Plain JavaScript, as `version.mjs`: the Vite config imports it.

/** The `content` each page's CSP `<meta>` holds in source, replaced at build. */
export const CSP_PLACEHOLDER = '__BS_CSP__';

/** Every page of the build (`vite.config.ts`'s inputs). */
export const CSP_PAGES = ['index.html', 'lab.html', 'card.html'];

/** The only hubs `?hub=` accepts (`hubSocketUrl` in `src/game/online-config.ts`). */
const LOCAL_HUBS = ['http://localhost:*', 'ws://localhost:*', 'http://127.0.0.1:*', 'ws://127.0.0.1:*'];

/** The authority's HTTP and WebSocket origins; none for a build without one. */
export function authorityOrigins(url) {
  if (!url) return [];
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`AUTHORITY_URL is not a URL: ${url}`);
  }
  if (!/^(https?|wss?):$/.test(parsed.protocol)) {
    throw new Error(`AUTHORITY_URL is not an http(s) or ws(s) URL: ${url}`);
  }
  const secure = parsed.protocol === 'https:' || parsed.protocol === 'wss:';
  return [
    `${secure ? 'https' : 'http'}://${parsed.host}`,
    `${secure ? 'wss' : 'ws'}://${parsed.host}`,
  ];
}

/** The policy for a build whose authority is `authorityUrl` ('' for none). */
export function cspPolicy(authorityUrl) {
  const directives = [
    ['default-src', ["'self'"]],
    ['script-src', ["'self'"]],
    ['worker-src', ["'self'"]],
    // Inline styles can't run code; the pages and the E2E helpers' style tags use them.
    ['style-src', ["'self'", "'unsafe-inline'"]],
    ['img-src', ["'self'", 'data:', 'blob:']],
    ['connect-src', ["'self'", ...authorityOrigins(authorityUrl), ...LOCAL_HUBS]],
    ['object-src', ["'none'"]],
    ['base-uri', ["'none'"]],
    ['form-action', ["'none'"]],
  ];
  return directives.map(([name, values]) => `${name} ${values.join(' ')}`).join('; ');
}

/** A page with its policy written in; a page without the placeholder fails the build. */
export function withCsp(html, policy) {
  if (!html.includes(`content="${CSP_PLACEHOLDER}"`)) {
    throw new Error('every page carries the CSP meta (tools/csp.mjs)');
  }
  return html.replaceAll(CSP_PLACEHOLDER, policy);
}
