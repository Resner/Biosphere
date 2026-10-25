import { PROTOCOL_VERSION } from '../src/net/protocol';
import { Authority } from './authority';
import { isAllowedOrigin } from './origin';

export { Authority };

const CLOSE_ORIGIN_NOT_ALLOWED = 4004;

function json(body: unknown, status: number, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

function health(origin: string | null): Response {
  // A request without Origin (curl, uptime checks) is fine here: the endpoint holds nothing private.
  if (origin !== null && !isAllowedOrigin(origin)) return json({ error: 'origin' }, 403);
  const cors: Record<string, string> = origin ? { 'Access-Control-Allow-Origin': origin } : {};
  return json({ ok: true, version: __VERSION__, protocol: PROTOCOL_VERSION }, 200, {
    ...cors,
    Vary: 'Origin',
  });
}

function hub(request: Request, env: Env): Response | Promise<Response> {
  if (request.headers.get('Upgrade') !== 'websocket') {
    return json({ error: 'upgrade-required' }, 426);
  }
  const origin = request.headers.get('Origin');
  if (origin === null || !isAllowedOrigin(origin)) {
    // A browser can't read a 403 on a WebSocket handshake, so accept and close with a code.
    const pair = new WebSocketPair();
    pair[1].accept();
    pair[1].close(CLOSE_ORIGIN_NOT_ALLOWED, 'origin not allowed');
    return new Response(null, { status: 101, webSocket: pair[0] });
  }
  return env.AUTHORITY.get(env.AUTHORITY.idFromName('global')).fetch(request);
}

export default {
  fetch(request: Request, env: Env): Response | Promise<Response> {
    const { pathname } = new URL(request.url);
    if (pathname === '/v1/health') return health(request.headers.get('Origin'));
    if (pathname === '/v1/hub') return hub(request, env);
    return json({ error: 'not-found' }, 404);
  },
} satisfies ExportedHandler<Env>;
