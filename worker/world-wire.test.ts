import { runInDurableObject } from 'cloudflare:test';
import { afterEach, describe, expect, it } from 'vitest';
import { CLOSE_RATE_LIMITED } from '../src/net/protocol';
import type { Authority } from './authority';
import { anchorAt, closeSockets, login, nextOf, signIn, stub } from './test-hub';

// Protocol 11 on the authority (M11 T2): `where` and `gone` parse and count in the 20-message
// budget; the directory answers them (T6, `where.test.ts`).

afterEach(closeSockets);

const droppedOf = (t: string) =>
  runInDurableObject(stub(), (o: Authority) => (o.dropped as Map<string, number>).get(t) ?? 0);
const where = { t: 'where', x: 4096, y: 4096, r: 10, aoi: 233 };

describe('protocol 11 on the hub', () => {
  it('welcomes with the world', async () => {
    const { c } = await signIn();
    const welcome = await nextOf(c, 'welcome');
    expect(welcome.world).toMatchObject({ seed: expect.any(String), size: expect.any(Number) });
    expect('pond' in welcome).toBe(false);
  });

  it('answers a where with near and a gone with nothing', async () => {
    const { c, id } = await login();
    await anchorAt(id.playerId, where.x, where.y);
    const [wheres, gones] = [await droppedOf('where'), await droppedOf('gone')];
    c.send(where);
    expect(await c.next()).toMatchObject({ t: 'near', peers: [], swarm: [] });
    c.send({ t: 'gone' });
    c.send({ t: 'ping', id: 7 });
    expect(await c.next()).toMatchObject({ t: 'pong', id: 7 });
    expect(await droppedOf('where')).toBe(wheres);
    expect(await droppedOf('gone')).toBe(gones);
  });

  it('counts where in the 20-message budget: the 21st message in 10 s closes the socket', async () => {
    const { c } = await login();
    // The hello was the first message of the window.
    for (let i = 0; i < 18; i++) c.send(where);
    c.send({ t: 'ping', id: 20 });
    expect(await nextOf(c, 'pong')).toMatchObject({ t: 'pong', id: 20 });
    c.send(where);
    expect(await c.closed).toBe(CLOSE_RATE_LIMITED);
  });
});
