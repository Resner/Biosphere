import { describe, expect, it } from 'vitest';
import { CENTRE, runScenario } from './aoi-harness';
import { EventQueue, Meter } from './aoi-meter';
import type { ClientSpec, Scenario } from './aoi-types';

// The load simulation's meter and the harness options it needs (M13 T5).

describe('EventQueue', () => {
  it('pops in time order, and in the order added at one time', () => {
    const q = new EventQueue<{ t: number; seq: number }>();
    const input = [5, 1, 3, 3, 9, 1, 0, 7, 3];
    for (const [seq, t] of input.entries()) q.push({ t, seq });
    const out: [number, number][] = [];
    for (let e = q.pop(); e; e = q.pop()) out.push([e.t, e.seq]);
    expect(out).toEqual([
      [0, 6],
      [1, 1],
      [1, 5],
      [3, 2],
      [3, 3],
      [3, 8],
      [5, 0],
      [7, 7],
      [9, 4],
    ]);
    expect(q.size).toBe(0);
    expect(q.pop()).toBeUndefined();
  });

  it('pops the least of what it holds, with events pushed between the pops', () => {
    const q = new EventQueue<{ t: number; seq: number }>();
    let x = 12345;
    const rnd = () => {
      x = (Math.imul(x, 1103515245) + 12345) >>> 0;
      return x / 2 ** 32;
    };
    const held: { t: number; seq: number }[] = [];
    let popped = 0;
    for (let i = 0; i < 2000; i++) {
      const e = { t: Math.floor(rnd() * 100), seq: i };
      held.push(e);
      q.push(e);
      if (i % 3 === 0) {
        held.sort((a, b) => a.t - b.t || a.seq - b.seq);
        expect(q.pop()).toBe(held.shift());
        popped++;
      }
    }
    held.sort((a, b) => a.t - b.t || a.seq - b.seq);
    for (const e of held) expect(q.pop()).toBe(e);
    expect(popped).toBeGreaterThan(600);
    expect(q.size).toBe(0);
  });
});

describe('Meter', () => {
  it('times an operation under its name, even when it throws', () => {
    const m = new Meter();
    expect(m.time('place', () => 42)).toBe(42);
    expect(() =>
      m.time('pool', () => {
        throw new Error('x');
      }),
    ).toThrow('x');
    expect(m.ops.place.length).toBe(1);
    expect(m.ops.pool.length).toBe(1);
    expect(m.ops.where.length).toBe(0);
  });

  it('sums the rates and keeps the most', () => {
    const m = new Meter();
    m.rate(100, 300);
    m.rate(200, 100);
    expect([m.upSum, m.downSum, m.rateSamples, m.upMax, m.downMax]).toEqual([
      300, 400, 2, 200, 300,
    ]);
  });
});

function client(id: string, spawnAt: number, patch: Partial<ClientSpec> = {}): ClientSpec {
  return {
    id,
    x: CENTRE + (id === 'a' ? 0 : 400),
    y: CENTRE,
    r: 20,
    adultR: 20,
    spawnAt,
    walk: { heading: 0, speed: 0, turn: 0, dash: false },
    ...patch,
  };
}

const pair = (patch: Partial<Scenario> = {}): Scenario => ({
  name: 'pair',
  seconds: 40,
  clients: [client('a', 0), client('b', 0)],
  ...patch,
});

describe('the harness with a meter', () => {
  it('counts messages by type, link setups and bandwidth', () => {
    const meter = new Meter();
    runScenario(pair({ meter }), 'm');
    expect(meter.msgs.where).toBeGreaterThan(0);
    expect(meter.msgs.offer + meter.msgs.answer).toBeGreaterThan(0);
    expect(meter.setups).toBe(1);
    expect(meter.rateSamples).toBeGreaterThan(0);
    expect(meter.upMax).toBeGreaterThan(0);
    expect(meter.downMax).toBeCloseTo(meter.upMax, 6);
    expect(meter.ops.where.length).toBe(meter.msgs.where + meter.msgs.whereCrowd);
  });

  it('changes no result: the run is the same with and without it', () => {
    const plain = runScenario(pair(), 'm');
    const metered = runScenario(pair({ meter: new Meter() }), 'm');
    expect(metered).toEqual(plain);
  });

  it('counts a leave as gone, and keeps a fighter in the water until its fight ends', () => {
    const meter = new Meter();
    const sc = pair({
      meter,
      seconds: 100,
      clients: [client('a', 0, { leaveAt: 15_000 }), client('b', 0)],
      fights: [{ from: 10_000, until: 85_000, fighters: ['a', 'b'], witnesses: [] }],
    });
    const run = runScenario(sc, 'm');
    expect(meter.msgs.gone).toBe(1);
    // Each client that lived a full first minute has a first-minute count: a stayed 85 s, not 15.
    expect(run.joinMinute.length).toBe(2);
    expect(run.violations.fightWater).toBe(0);
  });
});

describe('the pair checks', () => {
  it('can run every few ticks and on a sample of the clients without changing the links', () => {
    const every = runScenario(pair({ pairsEvery: 10 }), 'p');
    const sampled = runScenario(pair({ pairSample: 0.5 }), 'p');
    const all = runScenario(pair(), 'p');
    expect(every.maxHeld).toBe(all.maxHeld);
    expect(sampled.maxHeld).toBe(all.maxHeld);
    expect(every.violations).toEqual(all.violations);
  });
});
