import { exports } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import security from '../docs/SECURITY.md?raw';

// The public endpoints against docs/SECURITY.md's table (M14 T16): each answers a foreign origin,
// a request with no origin and an over-long path as the table says.

const BASE = 'https://authority.test';
const PAGES = 'https://resner.github.io';
const FOREIGN = 'https://evil.example';
const ID = 'ab'.repeat(32);

interface Row {
  method: string;
  path: string;
  foreign: string;
  none: string;
}

/** The rows of the "Public endpoints" table: `GET /v1/x` | a foreign origin | no origin | … */
function endpoints(): Row[] {
  const start = security.indexOf('## Public endpoints');
  const section = security.slice(start, security.indexOf('\n## ', start + 1));
  return section
    .split('\n')
    .filter((l) => l.startsWith('| `'))
    .map((l) => {
      const [, name = '', foreign = '', none = ''] = l.split('|').map((c) => c.trim());
      const [method = '', path = ''] = name.replaceAll('`', '').split(' ');
      return { method, path: path.replace('<id>', ID), foreign, none };
    });
}

function request(row: Row, origin?: string, path = row.path) {
  const headers = new Headers();
  if (origin) headers.set('Origin', origin);
  if (row.method === 'WS') headers.set('Upgrade', 'websocket');
  return exports.default.fetch(`${BASE}${path}`, { headers });
}

/** A WebSocket answer's close code, or null for an answer with no socket. */
async function closeCode(res: Response): Promise<number | null> {
  const ws = res.webSocket;
  if (!ws) return null;
  const closed = new Promise<number>((resolve) =>
    ws.addEventListener('close', (e) => resolve(e.code)),
  );
  ws.accept();
  const code = await Promise.race([
    closed,
    new Promise<null>((r) => setTimeout(() => r(null), 500)),
  ]);
  ws.close(1000, 'done');
  return code;
}

/** What an answer looks like in the table's words: `403`, `closed 4004`, or `answered`. */
async function seen(res: Response): Promise<string> {
  if (res.status === 403) return '403';
  if (res.status === 101) {
    const code = await closeCode(res);
    return code === null ? 'answered' : `closed ${code}`;
  }
  return 'answered';
}

const expected = (cell: string): string =>
  /403/.test(cell) ? '403' : /4004/.test(cell) ? 'closed 4004' : 'answered';

describe('the public endpoints, as docs/SECURITY.md says', () => {
  const rows = endpoints();

  it('lists every endpoint the Worker serves', () => {
    expect(rows.map((r) => `${r.method} ${r.path.replace(ID, '<id>')}`).sort()).toEqual(
      [
        'GET /v1/audit',
        'GET /v1/fight/<id>',
        'GET /v1/health',
        'GET /v1/metrics',
        'GET /v1/proof/<id>',
        'GET /v1/pubkeys',
        'WS /v1/hub',
      ].sort(),
    );
  });

  it.each(endpoints().map((r) => [`${r.method} ${r.path.slice(0, 20)}`, r] as const))(
    '%s answers a foreign origin, no origin and the Pages origin as the table says',
    async (_name, row) => {
      const foreign = await request(row, FOREIGN);
      expect(await seen(foreign), `${row.path} from ${FOREIGN}`).toBe(expected(row.foreign));
      expect(foreign.headers.get('Access-Control-Allow-Origin')).toBeNull();
      expect(await seen(await request(row)), `${row.path} with no origin`).toBe(expected(row.none));
      const pages = await request(row, PAGES);
      expect(await seen(pages), `${row.path} from the Pages`).toBe('answered');
      if (row.method === 'GET') {
        expect(pages.headers.get('Access-Control-Allow-Origin')).toBe(PAGES);
      }
    },
  );

  it.each(endpoints().map((r) => [`${r.method} ${r.path.slice(0, 20)}`, r] as const))(
    '%s refuses an over-long path',
    async (_name, row) => {
      for (const path of [`${row.path}/${'a'.repeat(4096)}`, `${row.path}${'a'.repeat(200)}`]) {
        const res = await request(row, PAGES, path);
        expect(res.status, path.slice(0, 40)).toBe(414);
        expect(await res.json()).toEqual({ error: 'path' });
      }
    },
  );
});
