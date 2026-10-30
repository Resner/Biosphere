import { exports } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';

const BASE = 'https://authority.test';

function get(path: string, origin?: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  if (origin) headers.set('Origin', origin);
  return exports.default.fetch(`${BASE}${path}`, { ...init, headers });
}

async function connect(origin: string | undefined) {
  const res = await get('/v1/hub', origin, { headers: { Upgrade: 'websocket' } });
  const ws = res.webSocket;
  if (!ws) throw new Error(`no WebSocket (status ${res.status})`);
  const closed = new Promise<number>((resolve) =>
    ws.addEventListener('close', (e) => resolve(e.code)),
  );
  ws.accept();
  return { res, ws, closed };
}

describe('GET /v1/health', () => {
  it('answers with version and protocol', async () => {
    const res = await get('/v1/health', 'https://resner.github.io');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, version: __VERSION__, protocol: 5 });
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('https://resner.github.io');
  });

  it.each(['http://localhost:5173', 'http://localhost', 'http://127.0.0.1:8787'])(
    'allows %s',
    async (origin) => {
      const res = await get('/v1/health', origin);
      expect(res.status).toBe(200);
      expect(res.headers.get('Access-Control-Allow-Origin')).toBe(origin);
    },
  );

  it.each([
    'https://evil.example',
    'https://resner.github.io.evil.example',
    'http://resner.github.io',
    'http://localhost.evil.example',
    'https://localhost:5173',
    'null',
  ])('rejects %s without a CORS header', async (origin) => {
    const res = await get('/v1/health', origin);
    expect(res.status).toBe(403);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBeNull();
  });

  it('allows a request without Origin (curl)', async () => {
    const res = await get('/v1/health');
    expect(res.status).toBe(200);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBeNull();
  });
});

describe('GET /v1/hub', () => {
  it('closes 4004 for a disallowed origin', async () => {
    const { res, closed } = await connect('https://evil.example');
    expect(res.status).toBe(101);
    expect(await closed).toBe(4004);
  });

  it('closes 4004 when Origin is missing', async () => {
    const { closed } = await connect(undefined);
    expect(await closed).toBe(4004);
  });

  it('reaches the Authority for an allowed origin', async () => {
    const { res, ws } = await connect('https://resner.github.io');
    expect(res.status).toBe(101);
    ws.close(1000, 'bye');
  });

  it('answers a plain GET with 426', async () => {
    const res = await get('/v1/hub', 'https://resner.github.io');
    expect(res.status).toBe(426);
  });
});

describe('unknown paths', () => {
  it('return 404 JSON', async () => {
    const res = await get('/nope', 'https://resner.github.io');
    expect(res.status).toBe(404);
    expect(res.headers.get('Content-Type')).toContain('application/json');
    expect(await res.json()).toEqual({ error: 'not-found' });
  });
});
