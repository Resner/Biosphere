import { afterEach, beforeEach, describe, expect } from 'vitest';
import { signMateAsk } from '../src/ledger/mating';
import { FRAME_MS } from '../src/net/referee';
import { RULES } from '../src/sim/rules';
import { drive, IDLE_CODE } from '../tests/encounter-fixture';
import { heavyTest } from '../tests/heavy';
import { SPLIT_WAIT_MS } from './crowds';
import { Directory } from './directory';
import {
  advance,
  advanceTo,
  answer,
  authority,
  CENTRE,
  clock,
  type EncStart,
  editSession,
  engage,
  fighters,
  join,
  locked,
  NEAR,
  type Player,
  slotOf,
  snap,
  spawned,
  useFightHub,
  within,
} from './fight-test-kit';
import { must } from './ledger-test-kit';
import type { RowCounter } from './metered-sql';
import { RIDE_ALONE_MS } from './ride';
import { Seats } from './seats';
import { activeSessions, hubReads, socketsOf } from './socket';
import {
  anchorAt,
  type Client,
  flush,
  freshNonce,
  nextOf,
  placed,
  signIn,
  sockets,
  sql,
} from './test-hub';
import { eligible, playOf } from './witness-pool';
import { useWitnessHub, witness } from './witness-test-kit';

// M13 T2: the hub's work per message doesn't grow with its sockets. Each message finds what it
// needs through the hub's indexes (`seats.ts`), so the attachment reads it costs are the same with
// 20 seated sessions as with 200, and no message walks `getWebSockets()`.

useFightHub();
useWitnessHub();

const SEED = '5'.repeat(64);
const STARTER = { r: 10, aoi: 233 };
/** The split group's spot, in the world's north-west quarter: nobody else reports there. */
const GROUP = { x: CENTRE - 30_000, y: CENTRE + 30_000 };
/** Far out east: the rider is alone there. */
const FAR = { x: CENTRE + 40_000, y: CENTRE };
/** The actors each round seats besides the background: five in the split group, two fighters, a witness and two swimmers. */
const ACTORS = 10;

const setSessions = (n: number) =>
  authority((o) => {
    (o.env as unknown as Record<string, string>).MAX_SESSIONS = String(n);
  });

beforeEach(async () => {
  await sql('UPDATE world SET seed = ?', SEED);
  await setSessions(1000);
});
afterEach(() => setSessions(200));

interface Cost {
  attachments: number;
  sockets: number;
}

const reads = () => authority(() => ({ ...hubReads }));

/** The attachment reads and `getWebSockets()` calls `run` costs the object. */
async function cost(run: () => Promise<unknown>): Promise<Cost> {
  const before = await reads();
  await run();
  const after = await reads();
  return {
    attachments: after.attachments - before.attachments,
    sockets: after.sockets - before.sockets,
  };
}

/** Seated sessions that sit out of the water and say nothing: what makes a hub big. */
async function background(n: number): Promise<void> {
  for (let i = 0; i < n; i++) await join();
}

/** Anchors a practice cell at (x, y) and reports there, with a crowd list if given; resolves with its `near`. */
async function standAt(c: Client, player: string, x: number, y: number, crowd?: string[]) {
  await anchorAt(player, x, y);
  c.send({ t: 'where', x, y, ...STARTER, ...(crowd ? { crowd } : {}) });
  return nextOf(c, 'near');
}

/**
 * Plays A's hunt of B (at 1 hp) frame by frame as `play` does, and returns what the frame that
 * kills B costs: its inputs, the settlement and the carrion notice.
 */
async function killCost(a: Player, b: Player, start: EncStart): Promise<Cost> {
  const target = slotOf(start, b);
  const startOf = (f: number) => start.at + f * FRAME_MS;
  for (let f = 0; f < RULES.encounter.timeoutFrames; f++) {
    let ended = false;
    const spent = await cost(async () => {
      await advanceTo(startOf(f) - FRAME_MS);
      a.c.send({
        t: 'input',
        enc: start.enc,
        f,
        i: drive(0, 15, { stance: 'aggressive', target }),
      });
      b.c.send({ t: 'input', enc: start.enc, f, i: IDLE_CODE });
      await within(Promise.all([nextOf(a.c, 'enc-frame'), nextOf(b.c, 'enc-frame')]), `frame ${f}`);
      ended = !(await locked(a));
      if (!ended) return;
      const heard = [...a.c.inbox, ...(await flush(a.c))];
      expect(heard.some((m) => m.t === 'carrion')).toBe(true);
    });
    if (ended) return spent;
  }
  throw new Error('B never died');
}

/** Every measured message of one round, with `n` sessions seated in all. */
async function round(n: number): Promise<Record<string, Cost>> {
  await authority((o) => {
    // A directory whose leaves split above 4, so the split group's fifth report splits one.
    o.directory = new Directory(RULES.world.size, { leafMax: 4 });
    o.spawns.length = 0;
  });
  await background(n - ACTORS - (await authority((o) => o.seats.size)));
  const out: Record<string, Cost> = {};

  // A `where` with a crowd list: its split's `leaf` notices, then the crowd's `instance` notices.
  const group = [];
  for (let i = 0; i < 5; i++) group.push(await join());
  for (const [i, g] of group.slice(0, 4).entries())
    await standAt(g.c, g.id.playerId, GROUP.x + 40 * i, GROUP.y);
  const fifth = must(group[4]);
  await anchorAt(fifth.id.playerId, GROUP.x + 160, GROUP.y);
  out.where = await cost(async () => {
    fifth.c.send({
      t: 'where',
      x: GROUP.x + 160,
      y: GROUP.y,
      ...STARTER,
      crowd: group.slice(0, 4).map((g) => g.id.playerId),
    });
    await nextOf(fifth.c, 'near');
    await advance(SPLIT_WAIT_MS + 1);
    await nextOf(fifth.c, 'instance');
  });

  const w = await witness();
  const [a, b] = await fighters();
  await placed(a, b);
  out.signal = await cost(async () => {
    a.c.send({ t: 'signal', to: b.id.playerId, kind: 'offer', sdp: 'v=0' });
    expect((await nextOf(b.c, 'signal')).from).toBe(a.id.playerId);
  });
  out.progress = await cost(async () => {
    a.c.send({ t: 'progress', n: 1, ticks: 30, biomass: 10_000, energy: 12_000, health: 10_000 });
    await flush(a.c);
  });
  out.mate = await cost(async () => {
    a.c.send({ t: 'mate-check', partner: b.id.playerId });
    await nextOf(a.c, 'mate-info');
    const ask = signMateAsk(a.id, {
      creature: a.creature,
      partner: b.id.playerId,
      partnerCreature: b.creature,
      nonce: freshNonce(),
    });
    a.c.send({ t: 'court', ask });
    await flush(a.c);
    await flush(b.c);
  });

  // An engage with its lock-ask and answer: the fight starts and its witness pool is drawn.
  const weak = { health: 0.01 };
  let start: EncStart | null = null;
  out.engage = await cost(async () => {
    engage(a, b, snap(b, ...NEAR.b, weak), snap(a, ...NEAR.a, { health: 1 }));
    await answer(a, b, { mine: snap(b, ...NEAR.b, weak) });
    [start] = await Promise.all([nextOf(a.c, 'enc-start'), nextOf(b.c, 'enc-start')]);
    await flush(a.c);
  });
  out.pool = await cost(() =>
    authority((o) => {
      expect(eligible(o, [a.id.playerId, b.id.playerId], clock.now())).toEqual([w.id.playerId]);
    }),
  );
  out.kill = await killCost(a, b, must(start));

  out.seated = await cost(() => join());
  await setSessions(await authority((o) => o.seats.size));
  out.queued = await cost(async () => {
    const { c } = await signIn();
    expect((await c.next()).t).toBe('queued');
  });
  const waiting = must(sockets.at(-1));
  waiting.ws.close(1000, 'done');
  await waiting.closed;
  await setSessions(1000);

  const swimmer = await join();
  out.spawn = await cost(() => spawned(swimmer));
  const rider = await join();
  expect((await standAt(rider.c, rider.id.playerId, FAR.x, FAR.y)).peers).toEqual([]);
  await editSession(rider as Player, (s) => ({ ...s, aloneSince: clock.t - 2 * RIDE_ALONE_MS }));
  out.ride = await cost(async () => {
    rider.c.send({ t: 'ride' });
    const answered = await flush(rider.c);
    expect(answered.some((m) => m.t === 'spawn' || m.t === 'ride-no')).toBe(true);
  });

  out.alarm = await cost(() => authority((o) => o.alarm()));

  // The round's actors leave; the background stays for the next.
  const actors = [...group, w, a, b, swimmer, rider];
  for (const p of actors) p.c.ws.close(1000, 'done');
  await Promise.all(actors.map((p) => p.c.closed));
  return out;
}

describe('the work per message', () => {
  heavyTest(
    'costs the same attachment reads with 20 and with 200 seated, and walks no sockets',
    async () => {
      const small = await round(20);
      const big = await round(200);
      expect(await authority((o) => o.seats.size)).toBeGreaterThanOrEqual(200 - ACTORS);
      for (const [what, c] of Object.entries(big)) {
        expect({ what, ...c }).toEqual({ what, ...small[what], sockets: 0 });
      }
    },
  );

  heavyTest('relays 100 signals among 500 seated, each to its target', async () => {
    const ps: { c: Client; id: { playerId: string } }[] = [];
    for (let i = 0; i < 500; i++) ps.push(await join());
    // Everyone reports near the centre, within each other's reach.
    for (const [i, p] of ps.entries())
      await standAt(p.c, p.id.playerId, CENTRE + (i % 25) * 40, CENTRE + Math.floor(i / 25) * 40);
    let seed = 7;
    const next = () => {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
      return seed % ps.length;
    };
    const spent = await cost(async () => {
      for (let k = 0; k < 100; k++) {
        const from = must(ps[next()]);
        let to = must(ps[next()]);
        if (to === from) to = must(ps[(ps.indexOf(from) + 1) % ps.length]);
        from.c.send({ t: 'signal', to: to.id.playerId, kind: 'offer', sdp: `s${k}` });
        const got = await nextOf(to.c, 'signal');
        expect(got).toMatchObject({ from: from.id.playerId, sdp: `s${k}` });
      }
    });
    expect(spent.sockets).toBe(0);
  });
});

describe('witness eligibility', () => {
  heavyTest('reads no SQLite row when a pool is drawn', async () => {
    await background(20);
    const w = await witness();
    const rows = (o: unknown) => ({ ...(o as { rowCount: RowCounter }).rowCount });
    await authority((o) => {
      const before = rows(o);
      expect(eligible(o, [], clock.now())).toEqual([w.id.playerId]);
      expect(rows(o)).toEqual(before);
    });
  });
});

describe('a wake', () => {
  heavyTest('rebuilds the same seated set, line, courts and witness candidates', async () => {
    await background(3);
    const w = await witness();
    const [a, b] = await fighters();
    await editSession(a, (s) => ({
      ...s,
      court: {
        ask: signMateAsk(a.id, {
          creature: a.creature,
          partner: b.id.playerId,
          partnerCreature: b.creature,
          nonce: freshNonce(),
        }),
        sentAt: Date.now(),
      },
    }));
    await authority((o) => o.duties.strike(w.id.playerId, 'authority-only', 'test:wake'));
    await setSessions(await authority((o) => o.seats.size));
    for (let i = 0; i < 2; i++) {
      const { c } = await signIn();
      expect((await c.next()).t).toBe('queued');
    }
    await authority((o) => {
      const now = Date.now();
      const woken = new Seats(playOf(o));
      woken.rebuild(socketsOf(o));
      const live = o.seats.view(now);
      expect(woken.view(now)).toEqual(live);
      expect(live.courts).toEqual(
        [
          [a.id.playerId, [b.id.playerId]],
          [b.id.playerId, [a.id.playerId]],
        ].sort(([x], [y]) => (String(x) < String(y) ? -1 : 1)),
      );
      expect(live.line).toHaveLength(2);
      expect(live.seated).toEqual([...activeSessions(o)].map(([, s]) => s.playerId).sort());
      expect(live.candidates.find(([id]) => id === w.id.playerId)?.[1]).toMatchObject({
        avail: true,
        struckUntil: clock.t + 86_400_000,
      });
    });
  });
});
