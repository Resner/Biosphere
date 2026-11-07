import { runInDurableObject } from 'cloudflare:test';
import { afterEach, describe, expect, it } from 'vitest';
import { CLOSE_RATE_LIMITED } from '../src/net/protocol';
import type { Authority } from './authority';
import { anchorAt, closeSockets, login, nextOf, stub } from './test-hub';

// Protocol 12 on the authority (M12 T1): `spawn` and `ride` count in the 20-message budget; `spawn`
// is answered (T4, `spawn.test.ts`) and `ride` dropped and counted until T7 answers it; a `where`'s
// crowd is parsed and ignored until T5. The protocol-11 hello's refusal is in `hub.test.ts`.

afterEach(closeSockets);

const droppedOf = (t: string) =>
  runInDurableObject(stub(), (o: Authority) => (o.dropped as Map<string, number>).get(t) ?? 0);
const where = { t: 'where', x: 4096, y: 4096, r: 10, aoi: 233 };
const spawn = { t: 'spawn', r: 10, aoi: 233 };
const ride = { t: 'ride' };

describe('protocol 12 on the hub', () => {
  it('answers a spawn, and drops and counts a ride', async () => {
    const { c } = await login();
    const [spawns, rides] = [await droppedOf('spawn'), await droppedOf('ride')];
    c.send(spawn);
    c.send(ride);
    c.send({ t: 'ping', id: 3 });
    expect(await c.next()).toMatchObject({ t: 'spawn', why: 'placed', protect: false });
    expect(await c.next()).toMatchObject({ t: 'pong', id: 3 });
    expect(await droppedOf('spawn')).toBe(spawns);
    expect(await droppedOf('ride')).toBe(rides + 1);
  });

  it('answers a where with a crowd with near, as before', async () => {
    const { c, id } = await login();
    await anchorAt(id.playerId, where.x, where.y);
    const wheres = await droppedOf('where');
    c.send({ ...where, crowd: ['A'.repeat(43), 'B'.repeat(43)] });
    expect(await c.next()).toMatchObject({ t: 'near', peers: [], swarm: [] });
    expect(await droppedOf('where')).toBe(wheres);
  });

  it('counts spawn and ride in the 20-message budget: the 21st message in 10 s closes the socket', async () => {
    const { c } = await login();
    // The hello was the first message of the window.
    for (let i = 0; i < 18; i++) c.send(i % 2 ? spawn : ride);
    c.send({ t: 'ping', id: 20 });
    expect(await nextOf(c, 'pong')).toMatchObject({ t: 'pong', id: 20 });
    c.send(spawn);
    expect(await c.closed).toBe(CLOSE_RATE_LIMITED);
  });
});
