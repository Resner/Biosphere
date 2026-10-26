import { env, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { type Beacon, QUICKNET, roundAt, roundTime } from '../src/ledger/drand';
import rounds from '../tests/fixtures/drand/rounds.json';
import * as beaconsModule from './beacons';
import { type BeaconSource, Beacons } from './beacons';
import { fixtureSource } from './fixture-beacons';
import { Ledger } from './ledger';
import { migrate } from './schema';

const all = rounds.beacons as Beacon[];
const beaconOf = (round: number): Beacon => all[round - rounds.first] as Beacon;
const OWNER = 'a'.repeat(43);
let ids = 0;

interface Rig {
  beacons: Beacons;
  ledger: Ledger;
  clock: { now: number };
  fetched: Array<number | 'latest'>;
  rearms: number;
  fail: { on: boolean };
  /** Serves real beacons published by the fake clock, or a forged one when `forge` is set. */
  forge: { on: boolean };
  storage: DurableObjectStorage;
}

/** A Beacons over a fresh Durable Object's storage, with a fake clock and a fake network. */
async function rig<T>(body: (r: Rig) => Promise<T>, startRound = rounds.first + 10): Promise<T> {
  const stub = env.AUTHORITY.get(env.AUTHORITY.idFromName(`beacons-${++ids}`));
  return runInDurableObject(stub, async (_authority, state) => {
    migrate(state.storage.sql);
    const clock = { now: roundTime(startRound) + 100 };
    const fetched: Array<number | 'latest'> = [];
    const fail = { on: false };
    const forge = { on: false };
    const source: BeaconSource = {
      now: () => clock.now,
      async fetch(round) {
        fetched.push(round);
        if (fail.on) throw new Error('offline');
        const r = round === 'latest' ? roundAt(clock.now) : round;
        if (r > roundAt(clock.now)) throw new Error('not yet published');
        const real = beaconOf(r);
        return forge.on ? { round: r, signature: beaconOf(r + 1).signature } : real;
      },
    };
    const ledger = new Ledger(state.storage, () => clock.now);
    const out = { clock, fetched, fail, forge, rearms: 0, storage: state.storage } as Rig;
    out.ledger = ledger;
    out.beacons = new Beacons({
      storage: state.storage,
      source,
      countersign: (hash) => ledger.countersign(hash),
      rearm: async () => {
        out.rearms++;
      },
    });
    return body(out);
  });
}

const count = (r: Rig, table: string): number =>
  r.storage.sql.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`).one().n;

describe('Beacons.latest and get', () => {
  it('names the newest published round', async () => {
    await rig(async (r) => {
      const current = roundAt(r.clock.now);
      expect((await r.beacons.latest())?.round).toBe(current);
    });
  });

  it('steps back one round when the newest is not published yet', async () => {
    await rig(async (r) => {
      const current = roundAt(r.clock.now);
      const real = r.beacons;
      // The network is a round behind the clock.
      const behind: BeaconSource = {
        now: () => r.clock.now,
        fetch: async (round) => {
          if (round === current) throw new Error('late');
          return beaconOf(round === 'latest' ? current - 1 : round);
        },
      };
      const lagging = new Beacons({
        storage: r.storage,
        source: behind,
        countersign: (h) => r.ledger.countersign(h),
        rearm: async () => {},
      });
      expect((await lagging.latest())?.round).toBe(current - 1);
      expect(real).toBeDefined();
    });
  });

  it('serves a cached round without a fetch, and stores a fetched one with one write', async () => {
    await rig(async (r) => {
      const round = roundAt(r.clock.now) - 2;
      const before = r.beacons.rowsWritten;
      expect((await r.beacons.get(round))?.signature).toBe(beaconOf(round).signature);
      expect(r.beacons.rowsWritten - before).toBe(1);
      expect(r.fetched).toEqual([round]);
      expect((await r.beacons.get(round))?.round).toBe(round);
      expect(r.fetched).toEqual([round]);
      expect(count(r, 'beacons')).toBe(1);
    });
  });

  it('never stores or returns an unverifiable beacon', async () => {
    await rig(async (r) => {
      r.forge.on = true;
      const round = roundAt(r.clock.now) - 1;
      expect(await r.beacons.get(round)).toBeNull();
      expect(count(r, 'beacons')).toBe(0);
      expect(await r.beacons.latest()).toBeNull();
      expect(count(r, 'beacons')).toBe(0);
    });
  });

  it('refuses a beacon for a different round than the one asked for', async () => {
    await rig(async (r) => {
      const wrong: BeaconSource = {
        now: () => r.clock.now,
        fetch: async (round) => beaconOf((round as number) - 1),
      };
      const b = new Beacons({
        storage: r.storage,
        source: wrong,
        countersign: (h) => r.ledger.countersign(h),
        rearm: async () => {},
      });
      expect(await b.get(roundAt(r.clock.now) - 1)).toBeNull();
      expect(count(r, 'beacons')).toBe(0);
    });
  });
});

describe('Beacons.commit', () => {
  it('names the round after the latest published, signed, and the same request returns the same commitment', async () => {
    await rig(async (r) => {
      const latest = (await r.beacons.latest())?.round as number;
      const a = await r.beacons.commit('genesis', OWNER, { nonce: 'n1' });
      expect(a.commitment.round).toBe(latest + 2);
      expect(a.commitment.round).toBeGreaterThan(roundAt(r.clock.now) + 0);
      expect(a.status).toBe('awaiting');
      expect(a.commitment.kind).toBe('genesis');
      expect(a.commitment.owner).toBe(OWNER);
      const key = r.ledger.pubkeys()[0];
      expect(key?.id).toBe(a.keyId);
      // The same request again, even much later: same round, same id, no new row.
      r.clock.now += 60_000;
      const rows = count(r, 'commitments');
      const again = await r.beacons.commit('genesis', OWNER, { nonce: 'n1' });
      expect(again.id).toBe(a.id);
      expect(again.commitment.round).toBe(a.commitment.round);
      expect(again.authSig).toBe(a.authSig);
      expect(count(r, 'commitments')).toBe(rows);
      // A new nonce is a new commitment, at a later round.
      const other = await r.beacons.commit('genesis', OWNER, { nonce: 'n2' });
      expect(other.id).not.toBe(a.id);
      expect(other.commitment.round).toBeGreaterThan(a.commitment.round);
    });
  });

  it('collapses concurrent identical requests into one row', async () => {
    await rig(async (r) => {
      const [x, y] = await Promise.all([
        r.beacons.commit('genesis', OWNER, { nonce: 'same' }),
        r.beacons.commit('genesis', OWNER, { nonce: 'same' }),
      ]);
      expect(x.id).toBe(y.id);
      expect(count(r, 'commitments')).toBe(1);
    });
  });

  it('is never earlier than the clock allows, even while the network is down', async () => {
    await rig(async (r) => {
      r.fail.on = true;
      const c = await r.beacons.commit('genesis', OWNER, { nonce: 'offline' });
      expect(c.commitment.round).toBeGreaterThan(roundAt(r.clock.now));
    });
  });

  it('exports nothing that could change a stored round', () => {
    const names = [
      ...Object.keys(beaconsModule),
      ...Object.getOwnPropertyNames(Beacons.prototype),
    ].join(' ');
    expect(names).not.toMatch(/reroll|cancel|retarget|setround|changeround|updateround|replace/i);
    // The only writes to `commitments` are the insert and the resolution stamp.
  });

  it('writes two rows for a commitment: the row and its request index', async () => {
    await rig(async (r) => {
      r.ledger.pubkeys();
      const before = r.beacons.rowsWritten;
      await r.beacons.commit('genesis', OWNER, { nonce: 'w' });
      expect(r.beacons.rowsWritten - before).toBe(2);
    });
  });
});

describe('alarms and resolution', () => {
  it('sets one alarm for the commitment round plus 500 ms, and none when nothing is pending', async () => {
    await rig(async (r) => {
      expect(r.beacons.nextDue()).toBeNull();
      const c = await r.beacons.commit('genesis', OWNER, { nonce: 'a' });
      expect(r.rearms).toBe(1);
      const due = roundTime(c.commitment.round) + 500;
      expect(r.beacons.nextDue()).toBeCloseTo(Date.now() + (due - r.clock.now), -2);
      expect(r.beacons.pending()).toBe(1);
      // Not yet: the alarm does nothing and stays set.
      await r.beacons.alarm();
      expect(r.beacons.pending()).toBe(1);
      expect(r.beacons.status(c.id)).toBe('awaiting');
      r.clock.now = due;
      await r.beacons.alarm();
      expect(r.beacons.pending()).toBe(0);
      expect(r.beacons.status(c.id)).toBe('ready');
      expect(r.beacons.nextDue()).toBeNull();
      expect((await r.beacons.beaconFor(c.id))?.round).toBe(c.commitment.round);
    });
  });

  it('resolves everything available and reschedules for the earliest still pending', async () => {
    await rig(async (r) => {
      const a = await r.beacons.commit('genesis', OWNER, { nonce: 'a' });
      r.clock.now += 3000;
      const b = await r.beacons.commit('genesis', OWNER, { nonce: 'b' });
      r.clock.now = roundTime(a.commitment.round) + 600;
      await r.beacons.alarm();
      expect(r.beacons.status(a.id)).toBe('ready');
      expect(r.beacons.status(b.id)).toBe('awaiting');
      expect(r.beacons.pending()).toBe(1);
      const due = roundTime(b.commitment.round) + 500;
      expect(r.beacons.nextDue()).toBeCloseTo(Date.now() + (due - r.clock.now), -2);
    });
  });

  it('survives a 60 s outage: stays pending, substitutes nothing, resolves on the first success', async () => {
    await rig(async (r) => {
      const c = await r.beacons.commit('genesis', OWNER, { nonce: 'o' });
      r.fail.on = true;
      for (let t = 0; t <= 60_000; t += 5000) {
        r.clock.now = roundTime(c.commitment.round) + 500 + t;
        await r.beacons.alarm();
        expect(r.beacons.status(c.id)).toBe('awaiting');
        expect(r.beacons.nextDue()).not.toBeNull();
      }
      expect(count(r, 'beacons')).toBe(0);
      r.fail.on = false;
      r.clock.now += 5000;
      await r.beacons.alarm();
      expect(r.beacons.status(c.id)).toBe('ready');
      const beacon = await r.beacons.beaconFor(c.id);
      expect(beacon?.signature).toBe(beaconOf(c.commitment.round).signature);
    });
  });

  it('beaconFor waits (null) until the round has been published', async () => {
    await rig(async (r) => {
      const c = await r.beacons.commit('genesis', OWNER, { nonce: 'w' });
      expect(await r.beacons.beaconFor(c.id)).toBeNull();
      expect(await r.beacons.beaconFor('0'.repeat(64))).toBeNull();
    });
  });
});

describe('in the authority object', () => {
  it('holds one alarm for the next commitment and none once all are resolved', async () => {
    const stub = env.AUTHORITY.get(env.AUTHORITY.idFromName(`beacons-${++ids}`));
    await runInDurableObject(stub, async (authority, state) => {
      const clock = { now: roundTime(rounds.first + 10) + 100 };
      // Swap the live network for the fake one the other tests use.
      (authority.beacons as unknown as { deps: { source: BeaconSource } }).deps.source = {
        now: () => clock.now,
        fetch: async (round) => beaconOf(round === 'latest' ? roundAt(clock.now) : round),
      };
      expect(await state.storage.getAlarm()).toBeNull();
      const c = await authority.beacons.commit('genesis', OWNER, { nonce: 'alarm' });
      const due = roundTime(c.commitment.round) + 500;
      const alarm = (await state.storage.getAlarm()) as number;
      expect(Math.abs(alarm - (Date.now() + due - clock.now))).toBeLessThan(100);
      clock.now = due;
      await authority.alarm();
      expect(authority.beacons.status(c.id)).toBe('ready');
      expect(await state.storage.getAlarm()).toBeNull();
    });
  });
});

describe('fixture source', () => {
  it('starts its clock at the first recorded round and serves recorded beacons', async () => {
    let wall = 1_000_000;
    const source = fixtureSource(wall, () => wall);
    expect(source.now()).toBe(roundTime(rounds.first));
    expect((await source.fetch(rounds.first)).signature).toBe(beaconOf(rounds.first).signature);
    // The next round is not published yet.
    await expect(source.fetch(rounds.first + 1)).rejects.toThrow();
    wall += 3000;
    expect(source.now()).toBe(roundTime(rounds.first + 1));
    expect((await source.fetch('latest')).round).toBe(rounds.first + 1);
  });

  it('keeps serving the last round for latest() past the recording, and reports later rounds unavailable', async () => {
    let wall = 0;
    const source = fixtureSource(0, () => wall);
    wall = (rounds.last - rounds.first + 50) * QUICKNET.period * 1000;
    expect((await source.fetch('latest')).round).toBe(rounds.last);
    await expect(source.fetch(rounds.last + 1)).rejects.toThrow();
    expect((await source.fetch(rounds.last)).round).toBe(rounds.last);
  });
});
