import { HEX64 } from '../src/ledger/record';
import { PROTOCOL_VERSION } from '../src/net/protocol';
import { isAllowedOrigin } from './origin';
import type { ProofAge, Served } from './proof';

export { Authority } from './authority';

const CLOSE_ORIGIN_NOT_ALLOWED = 4004;

function json(body: unknown, status: number, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

/** A public read-only answer. A request without Origin (curl, uptime checks) is fine: these endpoints hold nothing private. */
async function publicJson(
  origin: string | null,
  body: () => unknown,
  headers: Record<string, string> = {},
): Promise<Response> {
  if (origin !== null && !isAllowedOrigin(origin)) return json({ error: 'origin' }, 403);
  const cors = origin ? { 'Access-Control-Allow-Origin': origin } : {};
  return json(await body(), 200, { ...cors, ...headers, Vary: 'Origin' });
}

/** `GET /v1/proof/<creature>` and `GET /v1/fight/<enc>` (ADR 0055): the id is 64 lowercase hex. */
const PROOF_PATH = /^\/v1\/(proof|fight)\/([^/]*)$/;
/** A settled fight never changes (a day); a dead creature's bundle can still gain flags (ten minutes); anything else may within a minute. */
const MAX_AGE: Readonly<Record<ProofAge, number>> = { settled: 86_400, dead: 600, live: 60 };
const BUSY_RETRY_S = 600;
/** `GET /v1/audit` is the same for everyone for 5 minutes. */
const AUDIT_MAX_AGE = 300;

const authority = (env: Env) => env.AUTHORITY.get(env.AUTHORITY.idFromName('global'));

/** The CORS headers a public read answers with for its request's origin, or the 403 for a foreign one. */
function corsOf(request: Request): Record<string, string> | Response {
  const origin = request.headers.get('Origin');
  if (origin !== null && !isAllowedOrigin(origin)) return json({ error: 'origin' }, 403);
  return origin ? { 'Access-Control-Allow-Origin': origin, Vary: 'Origin' } : { Vary: 'Origin' };
}

/**
 * A proof read: checked here (origin, id), answered from the edge cache when it holds the path,
 * else by the object, whose answer (a 200 or a 404) is cached for as long as it can't change.
 * The cached copy carries no CORS header, which each answer adds for its own origin.
 */
async function proofRead(
  request: Request,
  env: Env,
  what: 'proof' | 'fight',
  id: string,
): Promise<Response> {
  const cors = corsOf(request);
  if (cors instanceof Response) return cors;
  if (!HEX64.test(id)) return json({ error: 'id' }, 400, cors);
  return edgeCached(request, `/v1/${what}/${id}`, cors, async () => {
    const stub = authority(env);
    const served: Served = what === 'proof' ? await stub.proof(id) : await stub.fight(id);
    if (served.status === 503) {
      return json({ error: 'busy' }, 503, {
        'Retry-After': String(BUSY_RETRY_S),
        'Cache-Control': 'no-store',
      });
    }
    const age = served.status === 200 ? MAX_AGE[served.age] : MAX_AGE.live;
    const body =
      served.status === 200
        ? served.body
        : JSON.stringify({ error: served.status === 413 ? 'too-big' : 'not-found' });
    return new Response(body, {
      status: served.status,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': `public, max-age=${age}` },
    });
  });
}

/** `GET /v1/audit` (ADR 0055): the authority's flag counts, with no ids, cached at the edge for 5 minutes. */
function auditRead(request: Request, env: Env): Promise<Response> | Response {
  const cors = corsOf(request);
  if (cors instanceof Response) return cors;
  return edgeCached(request, '/v1/audit', cors, async () => {
    const report = await authority(env).audit();
    if (!report) {
      return json({ error: 'busy' }, 503, {
        'Retry-After': String(BUSY_RETRY_S),
        'Cache-Control': 'no-store',
      });
    }
    return json(report, 200, { 'Cache-Control': `public, max-age=${AUDIT_MAX_AGE}` });
  });
}

/**
 * The edge cache's copy of `path` when it holds one (a hit never reaches the object), else what
 * `make` answers, kept when it is public. The cached copy carries no CORS header: each answer
 * adds its own origin's.
 */
async function edgeCached(
  request: Request,
  path: string,
  cors: Record<string, string>,
  make: () => Promise<Response>,
): Promise<Response> {
  const key = new Request(`${new URL(request.url).origin}${path}`);
  const cache = caches.default;
  const hit = await cache.match(key);
  if (hit) return withHeaders(hit, cors);
  const response = await make();
  if (response.headers.get('Cache-Control')?.startsWith('public')) {
    await cache.put(key, response.clone());
  }
  return withHeaders(response, cors);
}

const withHeaders = (response: Response, headers: Record<string, string>): Response => {
  const out = new Response(response.body, response);
  for (const [k, v] of Object.entries(headers)) out.headers.set(k, v);
  return out;
};

function hub(request: Request, env: Env): Response | Promise<Response> {
  if (request.headers.get('Upgrade') !== 'websocket') {
    return json({ error: 'upgrade-required' }, 426);
  }
  const origin = request.headers.get('Origin');
  if (!isAllowedOrigin(origin)) {
    // A browser can't read a 403 on a WebSocket handshake, so accept and close with a code.
    const pair = new WebSocketPair();
    pair[1].accept();
    pair[1].close(CLOSE_ORIGIN_NOT_ALLOWED, 'origin not allowed');
    return new Response(null, { status: 101, webSocket: pair[0] });
  }
  return authority(env).fetch(request);
}

export default {
  fetch(request: Request, env: Env): Response | Promise<Response> {
    const { pathname } = new URL(request.url);
    const origin = request.headers.get('Origin');
    if (pathname === '/v1/health') {
      return publicJson(origin, () => ({
        ok: true,
        version: __VERSION__,
        protocol: PROTOCOL_VERSION,
      }));
    }
    if (pathname === '/v1/pubkeys') {
      // Keys are never rotated, so browsers and the edge may keep the list for a while.
      return publicJson(
        origin,
        async () => ({
          keys: await authority(env).pubkeys(),
        }),
        { 'Cache-Control': 'public, max-age=300' },
      );
    }
    if (pathname === '/v1/hub') return hub(request, env);
    if (pathname === '/v1/audit' && request.method === 'GET') return auditRead(request, env);
    const proof = request.method === 'GET' ? PROOF_PATH.exec(pathname) : null;
    if (proof) return proofRead(request, env, proof[1] as 'proof' | 'fight', proof[2] ?? '');
    return json({ error: 'not-found' }, 404);
  },
} satisfies ExportedHandler<Env>;
