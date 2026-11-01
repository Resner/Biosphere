import { readFileSync, writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { heavyTest } from '../../tests/heavy';
import { depthAt } from './bathymetry';
import { type PhysStats, STARTER_PHYS } from './body';
import { foodNear } from './food';
import { plumesNear } from './hazards';
import { angleToSteer, encodeInput, IDLE, type Input } from './input';
import { atan2, length } from './math';
import { createRng, seedFromString } from './prng';
import { expandRuns, type InputLog, recordInputs, replay } from './replay';
import { RULES, RULES_VERSION } from './rules';
import { findClearSpot } from './spawn';
import { hashWorld } from './state-hash';
import { step } from './step';
import type { World } from './types';
import { createWorld, spawnCreature } from './world';

interface Golden {
  log: InputLog;
  hash: string;
  events: Record<string, number>;
}

const NAMES = [
  'idle-starve',
  'forage-route',
  'hazard-dash',
  'body-forage',
  'old-age',
  'mate',
] as const;
const file = (name: string) => new URL(`./__golden__/${name}.json`, import.meta.url);
const ID = 'p1';

/** Plays a policy against a live world, one input per tick, and returns the log it produced. */
function record(
  seed: string,
  spawn: { x: number; y: number; phys?: PhysStats },
  ticks: number,
  policy: (world: ReturnType<typeof createWorld>, tick: number) => Input,
): InputLog {
  const world = createWorld({ seed });
  const creature = spawnCreature(world, { id: ID, ...spawn });
  const inputs: Input[] = [];
  for (let tick = 0; tick < ticks; tick++) {
    const input = policy(world, tick);
    inputs.push(input);
    step(world, { [creature.id]: input });
  }
  return {
    rules: RULES_VERSION,
    seed,
    spawn: { id: ID, ...spawn },
    ticks,
    runs: recordInputs(inputs),
  };
}

/** Greedy forager: swim at the nearest food, dashing every three seconds. */
function forager(world: World, tick: number): Input {
  const me = world.creatures[0];
  if (me === undefined) return IDLE;
  const items = foodNear(world, me.x, me.y, 400);
  let best = items[0];
  let bestD = Number.POSITIVE_INFINITY;
  for (const item of items) {
    const d = (item.x - me.x) ** 2 + (item.y - me.y) ** 2;
    if (d < bestD) [best, bestD] = [item, d];
  }
  if (best === undefined) return { steer: 0, throttle: 15, dash: false };
  return {
    steer: angleToSteer(atan2(best.y - me.y, best.x - me.x)),
    throttle: 15,
    dash: tick % 90 === 0,
  };
}

function build(): Record<(typeof NAMES)[number], InputLog> {
  // Food is dense, so an idler only starves if nothing drifts into reach: take the first spawn
  // on a coarse grid where that holds.
  let idle: InputLog | null = null;
  for (let y = 2048; idle === null && y < 6144; y += 97) {
    for (let x = 2048; idle === null && x < 6144; x += 89) {
      const log = record('golden-idle', { x, y }, 5000, () => IDLE);
      if (replay(log).world.creatures[0]?.cause === 'starved') idle = log;
    }
  }
  if (idle === null) throw new Error('golden-idle: no spawn starves');

  const forage = record('golden-forage', { x: 3000, y: 3000 }, 1800, forager);
  const body = record(
    'golden-body',
    { x: 3000, y: 3000, phys: { ...STARTER_PHYS, thrust: 1.4, drag: 0.8, basal: 1.2 } },
    1800,
    forager,
  );

  // Starts just west of a plume and dashes straight through it.
  const probe = createWorld({ seed: 'golden-hazard' });
  // Plumes rise from vents in the deep: take the first one with room to its west, in water too
  // shallow for pressure and too deep for UV, so the dash meets only the toxin.
  const mild = (x: number, y: number): boolean => {
    const depth = depthAt(probe.seed32, x, y);
    return depth > 0.3 && depth < 0.65;
  };
  const plume = plumesNear(probe, 4096, 4096, 8192).find(
    (p) => p.x - p.radius > 200 && mild(p.x, p.y) && mild(p.x - p.radius - 40, p.y),
  );
  if (plume === undefined) throw new Error('golden-hazard has no plume');
  const hazard = record(
    'golden-hazard',
    { x: Math.round(plume.x - plume.radius - 40), y: Math.round(plume.y) },
    600,
    (_world, tick) => ({ steer: 0, throttle: 15, dash: tick === 20 }),
  );
  // The forage route, with the authority calling elder at 20 s and the end of life at 50 s.
  const oldAge: InputLog = {
    ...forage,
    life: [
      [600, 'elder'],
      [1500, 'expire'],
    ],
  };
  // The forage route, with the authority charging a mating cost at 10 s and 40 s.
  const mate: InputLog = {
    ...forage,
    life: [
      [300, 'mate'],
      [1200, 'mate'],
    ],
  };
  return {
    mate,
    'old-age': oldAge,
    'idle-starve': idle,
    'forage-route': forage,
    'hazard-dash': hazard,
    'body-forage': body,
  };
}

function regenerate(): void {
  for (const [name, log] of Object.entries(build())) {
    const { hash, events } = replay(log);
    writeFileSync(file(name), `${JSON.stringify({ log, hash, events }, null, 1)}\n`);
  }
}

const load = (name: string): Golden => JSON.parse(readFileSync(file(name), 'utf8')) as Golden;

describe('golden scenarios', () => {
  if (process.env.UPDATE_GOLDENS) regenerate();

  for (const name of NAMES) {
    it(`${name} replays to its stored hash`, () => {
      const golden = load(name);
      const result = replay(golden.log);
      expect(result.hash).toBe(golden.hash);
      expect(result.events).toEqual(golden.events);
      expect(result.hash).toBe(hashWorld(result.world));
    });
  }

  it('the scenarios exercise what their names promise', () => {
    const idle = replay(load('idle-starve').log);
    expect(idle.world.creatures[0]?.cause).toBe('starved');
    expect(idle.events.death).toBe(1);

    const forage = replay(load('forage-route').log);
    expect(forage.events.eat).toBeGreaterThanOrEqual(3);
    expect(forage.events.dash).toBeGreaterThanOrEqual(1);

    const hazard = replay(load('hazard-dash').log);
    expect(hazard.events.damage).toBeGreaterThan(0);
    expect(hazard.events.dash).toBe(1);
    expect(hazard.world.creatures[0]?.alive).toBe(true);

    const body = replay(load('body-forage').log);
    expect(body.events.eat).toBeGreaterThanOrEqual(3);
    expect(body.world.creatures[0]?.phys.thrust).toBe(1.4);

    const old = replay(load('old-age').log);
    expect(old.events.death).toBe(1);
    expect(old.world.creatures[0]).toMatchObject({ alive: false, cause: 'old-age', elder: true });
  });

  it('the mate golden pays the cost twice and keeps going', () => {
    const { log, hash } = load('mate');
    const result = replay(log);
    const plain = replay({ ...log, life: [] });
    expect(result.world.creatures[0]?.alive).toBe(true);
    expect(result.hash).not.toBe(plain.hash);
    expect(result.events.death ?? 0).toBe(0);
    expect(replay({ ...log, life: [[300, 'mate']] }).hash).not.toBe(hash);
  });

  it('rejects a life list that is out of order or unknown', () => {
    const { log } = load('mate');
    expect(() =>
      replay({
        ...log,
        life: [
          [400, 'mate'],
          [400, 'mate'],
        ],
      }),
    ).toThrow(RangeError);
    expect(() => replay({ ...log, life: [[1, 'breed' as never]] })).toThrow(RangeError);
  });

  it('a life call changes the hash', () => {
    const { log, hash } = load('old-age');
    expect(replay({ ...log, life: [[600, 'elder']] }).hash).not.toBe(hash);
    expect(replay({ ...log, life: [] }).hash).not.toBe(hash);
  });

  it('changing one input changes the hash', () => {
    const golden = load('forage-route');
    const mid = golden.log.runs.length >> 1;
    // Flip the lowest throttle bit of a run in the middle: 15 becomes 14.
    const tweaked: InputLog = {
      ...golden.log,
      runs: golden.log.runs.map((run, i) => (i === mid ? [run[0], run[1] ^ 0x100] : run)),
    };
    expect(replay(tweaked).hash).not.toBe(golden.hash);
  });

  it('changing the seed or spawn changes the hash', () => {
    const { log, hash } = load('hazard-dash');
    expect(replay({ ...log, seed: `${log.seed}!` }).hash).not.toBe(hash);
    expect(replay({ ...log, spawn: { ...log.spawn, y: log.spawn.y + 1 } }).hash).not.toBe(hash);
  });

  it('replays 9,000 ticks in under a second', () => {
    const r = createRng(seedFromString('replay-speed'), 'inputs');
    const inputs: Input[] = [];
    let held: Input = IDLE;
    for (let tick = 0; tick < 9000; tick++) {
      if (tick % 45 === 0)
        held = { steer: r.int(0, 255), throttle: r.int(0, 15), dash: r.int(0, 9) === 0 };
      inputs.push(held);
    }
    const log: InputLog = {
      rules: RULES_VERSION,
      seed: 'replay-speed',
      spawn: { id: ID, x: 4096, y: 4096 },
      ticks: 9000,
      runs: recordInputs(inputs),
    };
    const start = performance.now();
    const result = replay(log);
    expect(performance.now() - start).toBeLessThan(1000);
    expect(result.world.tick).toBe(9000);
  });

  it('is deterministic across repeated replays', () => {
    const { log } = load('forage-route');
    expect(replay(log).hash).toBe(replay(log).hash);
  });
});

/** Forages for the best value per distance and keeps clear of toxic plumes, so a long run measures growth. */
function carefulForager(world: World, _tick: number): Input {
  const me = world.creatures[0];
  if (me === undefined) return IDLE;
  const margin = 80;
  for (const p of plumesNear(world, me.x, me.y, RULES.hazards.plumeMaxRadius + margin)) {
    if (length(me.x - p.x, me.y - p.y) < p.radius + margin)
      return { steer: angleToSteer(atan2(me.y - p.y, me.x - p.x)), throttle: 15, dash: false };
  }
  const safe = foodNear(world, me.x, me.y, 400).filter(
    (item) => plumesNear(world, item.x, item.y, margin).length === 0,
  );
  // Worth per distance: a crystal 100 wu away beats a detritus 20 wu away.
  let best = safe[0];
  let bestScore = -1;
  for (const item of safe) {
    const score = item.value / (length(item.x - me.x, item.y - me.y) + 20);
    if (score > bestScore) [best, bestScore] = [item, score];
  }
  if (best === undefined) return { steer: 0, throttle: 15, dash: false };
  return { steer: angleToSteer(atan2(best.y - me.y, best.x - me.x)), throttle: 15, dash: false };
}

describe('pace', () => {
  heavyTest('a forager with room to grow at least doubles its biomass from 60 s to 150 s', () => {
    const world = createWorld({ seed: 'pace' });
    const phys = { ...STARTER_PHYS, maxBiomass: 900 };
    const spot = findClearSpot(world, 4096, 4096);
    const me = spawnCreature(world, { id: ID, ...spot, phys });
    const at: Record<number, number> = {};
    for (let tick = 0; tick < 180 * 30; tick++) {
      step(world, { [ID]: carefulForager(world, tick) });
      if (tick % 30 === 29) at[(tick + 1) / 30] = me.biomass;
    }
    expect(me.alive).toBe(true);
    expect((at[150] as number) / (at[60] as number)).toBeGreaterThanOrEqual(2);
    // 5,400 ticks with a forager that scans food and plumes each tick: slow on a loaded CI runner.
  });
});

describe('recordInputs', () => {
  it('round-trips per-tick inputs through the runs', () => {
    const r = createRng(seedFromString('record'), 'inputs');
    const inputs: Input[] = [];
    for (let tick = 0; tick < 500; tick++) {
      const repeat = tick > 0 && r.int(0, 3) > 0;
      inputs.push(
        repeat
          ? (inputs[tick - 1] as Input)
          : { steer: r.int(0, 255), throttle: r.int(0, 15), dash: r.int(0, 4) === 0 },
      );
    }
    const runs = recordInputs(inputs);
    expect(runs.length).toBeLessThan(inputs.length);
    expect(expandRuns(runs, inputs.length)).toEqual(inputs);
  });

  it('stores one run for a constant input and none for nothing', () => {
    const held: Input = { steer: 7, throttle: 3, dash: false };
    expect(recordInputs(Array.from({ length: 20 }, () => held))).toEqual([[0, encodeInput(held)]]);
    expect(recordInputs([])).toEqual([]);
  });
});

describe('replay validation', () => {
  const base: InputLog = {
    rules: RULES_VERSION,
    seed: 'v',
    spawn: { id: ID, x: 100, y: 100 },
    ticks: 10,
    runs: [],
  };

  it('rejects a log from other rules', () => {
    expect(() => replay({ ...base, rules: RULES_VERSION + 1 })).toThrow(/rules/);
  });

  it('replays a log with a body and rejects a malformed one', () => {
    const phys = { ...STARTER_PHYS, thrust: 1.4 };
    const log = { ...base, spawn: { ...base.spawn, phys } };
    expect(replay(log).world.creatures[0]?.phys.thrust).toBe(1.4);
    expect(replay(log).hash).not.toBe(replay(base).hash);
    const bad = { ...log, spawn: { ...base.spawn, phys: { thrust: 1 } as never } };
    expect(() => replay(bad)).toThrow(RangeError);
    const nan = { ...log, spawn: { ...base.spawn, phys: { ...phys, drag: Number.NaN } } };
    expect(() => replay(nan)).toThrow(RangeError);
  });

  it('rejects unordered, out-of-range and non-u16 runs', () => {
    expect(() =>
      replay({
        ...base,
        runs: [
          [5, 0],
          [3, 0],
        ],
      }),
    ).toThrow(RangeError);
    expect(() => replay({ ...base, runs: [[10, 0]] })).toThrow(RangeError);
    expect(() => replay({ ...base, runs: [[0, 0x10000]] })).toThrow(RangeError);
  });

  it('rejects unordered, out-of-range and unknown life events', () => {
    const life = (events: unknown) => replay({ ...base, life: events as never });
    expect(() =>
      life([
        [5, 'elder'],
        [5, 'expire'],
      ]),
    ).toThrow(RangeError);
    expect(() => life([[10, 'expire']])).toThrow(RangeError);
    expect(() => life([[1.5, 'expire']])).toThrow(RangeError);
    expect(() => life([[1, 'retire']])).toThrow(RangeError);
    expect(() => life([null])).toThrow(RangeError);
    expect(() => life([[1]])).toThrow(RangeError);
    expect(() => life('expire')).toThrow(RangeError);
    expect(life([[9, 'expire']]).events.death).toBe(1);
  });
});
