import { describe, expect, it } from 'vitest';
import { drive, IDLE_CODE, starterFighter, startOf } from '../../../tests/encounter-fixture';
import { speedTest } from '../../../tests/heavy';
import { STARTER_COMBAT, STARTER_PHYS } from '../body';
import type { Input } from '../input';
import { DT, RULES } from '../rules';
import { step } from '../step';
import { createWorld, spawnCreature } from '../world';
import { createEncounter, hashEncounter, results, stepFrame } from './encounter';
import { engageRange, strikeDistance, strikeReach } from './reach';
import type { Encounter } from './types';

const E = RULES.encounter;
const MID = RULES.world.size / 2;
const at = (enc: Encounter, slot: number) => enc.fighters[slot] as Encounter['fighters'][number];
/** A pond with no currents and no hazards, so that a test sees only the encounter's own rules. */
const calm = (enc: ReturnType<typeof createEncounter>) => {
  enc.world.options.currents = false;
  enc.world.options.hazards = false;
  return enc;
};

describe('createEncounter', () => {
  it('seats fighters by creature id and runs the world from t0', () => {
    const enc = createEncounter(
      startOf('seats', [starterFighter('zed', MID, MID), starterFighter('abe', MID + 40, MID)]),
    );
    expect(enc.fighters.map((f) => f.creature)).toEqual(['abe', 'zed']);
    expect(enc.fighters.map((f) => f.slot)).toEqual([0, 1]);
    expect(enc.world.tick).toBe(1000);
    expect(enc.world.creatures).toEqual([]);
  });

  it('refuses a hostile start', () => {
    const f = starterFighter('a', MID, MID);
    expect(() => createEncounter(startOf('bad', [{ ...f, x: Number.NaN }]))).toThrow(RangeError);
    expect(() => createEncounter(startOf('bad', [f, f]))).toThrow(RangeError);
    expect(() => createEncounter(startOf('bad', []))).toThrow(RangeError);
    expect(() =>
      createEncounter(
        startOf('bad', [f, ...['b', 'c', 'd', 'e'].map((id) => starterFighter(id, MID, MID))]),
      ),
    ).toThrow(RangeError);
  });

  it('sanitises the body it is handed', () => {
    const f = starterFighter('a', MID, MID);
    const enc = createEncounter(
      startOf('san', [{ ...f, combat: { ...STARTER_COMBAT, mass: 1e9, power: Number.NaN } }]),
    );
    expect(enc.fighters[0]?.combat.mass).toBe(RULES.body.combat.massMax);
    expect(enc.fighters[0]?.combat.power).toBe(0);
  });

  it('sanitises the behaviour genes it is handed', () => {
    const f = starterFighter('a', MID, MID);
    const wild = {
      aggression: 9,
      caution: Number.NaN,
      curiosity: -2,
      reflex: 0.25,
      targetPref: 'bogus',
    };
    const enc = createEncounter(startOf('san-b', [{ ...f, behaviour: wild as never }]));
    expect(at(enc, 0).behaviour).toEqual({
      aggression: 1,
      caution: 0.5,
      curiosity: 0,
      reflex: 0.25,
      targetPref: 'nearest',
    });
  });
});

describe('stepFrame movement', () => {
  it('moves one fighter exactly as 90 free-roam ticks do', () => {
    const start = startOf('solo', [starterFighter('p1', 3000, 3000)]);
    const enc = createEncounter(start);
    for (let f = 0; f < 30; f++) stepFrame(enc, [drive(0)]);

    const world = createWorld({ seed: 'solo' });
    world.tick = start.t0;
    const c = spawnCreature(world, { id: 'p1', x: 3000, y: 3000 });
    const input: Input = { steer: 0, throttle: 15, dash: false };
    for (let t = 0; t < 90; t++) step(world, { p1: input });

    const mine = enc.fighters[0]?.body;
    expect(mine?.x).toBe(c.x);
    expect(mine?.y).toBe(c.y);
    expect(mine?.vx).toBe(c.vx);
    // Energy differs by design: the free-roam creature eats on the way, nobody eats in a fight.
    expect(mine?.energy).toBeLessThanOrEqual(c.energy);
    expect(enc.world.tick).toBe(start.t0 + 90);
    expect(enc.frame).toBe(30);
    expect(enc.over).toBe(false);
  });

  it('treats the fallback marker as idle and an evasive stance as faster', () => {
    const run = (code: number | null): number => {
      const enc = calm(createEncounter(startOf('stance', [starterFighter('a', 3000, 3000)])));
      for (let f = 0; f < 20; f++) stepFrame(enc, [code]);
      return enc.fighters[0]?.body.x ?? 0;
    };
    expect(run(null)).toBe(3000);
    expect(run(IDLE_CODE)).toBe(3000);
    expect(run(drive(0, 15, { stance: 'evasive' }))).toBeGreaterThan(run(drive(0)));
  });
});

describe('collisions', () => {
  it('never let two fighters overlap by more than 10% of the core radius', () => {
    const enc = calm(
      createEncounter(
        startOf('bump', [
          starterFighter('a', 3000, 3000),
          starterFighter('b', 3030, 3000, Math.PI),
        ]),
      ),
    );
    const radius = Math.sqrt(RULES.starter.biomass);
    let worst = 0;
    for (let f = 0; f < 60; f++) {
      stepFrame(enc, [drive(0), drive(128)]);
      const a = at(enc, 0);
      const b = at(enc, 1);
      const overlap = 2 * radius - Math.hypot(b.body.x - a.body.x, b.body.y - a.body.y);
      worst = Math.max(worst, overlap);
    }
    expect(worst).toBeLessThanOrEqual(0.1 * radius);
    // Pressed together at equal mass, they stop: the closing velocity is gone.
    const a = at(enc, 0);
    const b = at(enc, 1);
    expect(Math.abs(a.body.vx - b.body.vx)).toBeLessThan(1e-6);
  });

  it('moves the lighter fighter further', () => {
    const light = starterFighter('a', 3000, 3000);
    const heavy = { ...starterFighter('b', 3015, 3000), combat: { ...STARTER_COMBAT, mass: 4 } };
    const enc = calm(createEncounter(startOf('mass', [light, heavy])));
    stepFrame(enc, [IDLE_CODE, IDLE_CODE]);
    const a = at(enc, 0);
    const b = at(enc, 1);
    expect(3000 - a.body.x).toBeCloseTo(4 * (b.body.x - 3015), 6);
  });
});

describe('hazards in a fight', () => {
  const planted = (health: number) => {
    const enc = createEncounter(
      startOf('plume', [
        { ...starterFighter('a', 3000, 3000), health },
        starterFighter('b', 3500, 3000),
      ]),
    );
    // Only the planted plume acts: no seeded plumes, zones or currents.
    calm(enc).world.extraPlumes.push({ id: 'pl', x: 3000, y: 3000, radius: 80 });
    return enc;
  };

  it('hurts a fighter in a plume at the plume rate', () => {
    const enc = planted(100);
    stepFrame(enc, [IDLE_CODE, IDLE_CODE]);
    expect(100 - at(enc, 0).body.health).toBeCloseTo(RULES.damage.toxin * E.frameTicks * DT, 6);
  });

  it('kills a fighter at 1 hp with cause toxin and ends the fight', () => {
    const enc = planted(1);
    for (let frames = 0; !enc.over && frames < 30; frames++) stepFrame(enc, [IDLE_CODE, IDLE_CODE]);
    expect(results(enc)[0]).toMatchObject({ outcome: 'died', cause: 'toxin', by: null });
    expect(results(enc)[1]?.outcome).toBe('stood');
    expect(enc.over).toBe(true);
  });
});

describe('ending', () => {
  it('lets a fighter escape after exactly 90 ticks outside 2 x every opponent engage range', () => {
    const enc = calm(
      createEncounter(
        startOf('flee', [starterFighter('a', 3000, 3000), starterFighter('b', 3030, 3000)]),
      ),
    );
    const a = at(enc, 0);
    const b = at(enc, 1);
    const limit = (): number => E.escapeFactor * engageRange(b, a);
    let outsideTicks = 0;
    let frames = 0;
    while (!enc.over && frames++ < 200) {
      stepFrame(enc, [drive(128), IDLE_CODE]);
      if (!enc.over && strikeDistance(b.body, a.body) > limit()) {
        outsideTicks = a?.outside ?? 0;
      }
    }
    expect(enc.over).toBe(true);
    const [ra, rb] = results(enc);
    expect(ra?.outcome).toBe('escaped');
    expect(rb?.outcome).toBe('stood');
    expect(a?.outside).toBe(E.escapeTicks);
    expect(outsideTicks).toBeLessThanOrEqual(E.escapeTicks);
    const hash = hashEncounter(enc);
    const tick = enc.world.tick;
    stepFrame(enc, [drive(128), IDLE_CODE]);
    expect(hashEncounter(enc)).toBe(hash);
    expect(enc.world.tick).toBe(tick);
  });

  it('counts only consecutive ticks outside', () => {
    const enc = calm(
      createEncounter(
        startOf('flicker', [starterFighter('a', 3000, 3000), starterFighter('b', 3000, 3060)]),
      ),
    );
    // a swims away until it is outside, then comes back: the count restarts from zero.
    let frames = 0;
    while (enc.fighters[0]?.outside === 0 && frames++ < 100)
      stepFrame(enc, [drive(192), IDLE_CODE]);
    expect(enc.fighters[0]?.outside).toBeGreaterThan(0);
    expect(enc.over).toBe(false);
    stepFrame(enc, [drive(64), IDLE_CODE]);
    stepFrame(enc, [drive(64), IDLE_CODE]);
    stepFrame(enc, [drive(64), IDLE_CODE]);
    frames = 0;
    while ((enc.fighters[0]?.outside ?? 0) > 0 && frames++ < 100)
      stepFrame(enc, [drive(64), IDLE_CODE]);
    expect(enc.fighters[0]?.outside).toBe(0);
    expect(enc.over).toBe(false);
  });

  it('times out at frame 900 with both standing', () => {
    // Placed 1.5 x strike reach apart: outside reach, inside 2 x engage range. At this spot of this
    // seed the current moves both alike for 90 s, in the default pond (plumes, UV and pressure on).
    const radius = Math.sqrt(RULES.starter.biomass);
    const gap = 1.5 * radius + radius;
    const enc = createEncounter(
      startOf('timeout', [starterFighter('a', 5200, 3000), starterFighter('b', 5200 + gap, 3000)]),
    );
    expect(strikeDistance(at(enc, 0).body, at(enc, 1).body)).toBeCloseTo(
      1.5 * strikeReach(at(enc, 0)),
      9,
    );
    for (let i = 0; i < E.timeoutFrames + 5; i++) stepFrame(enc, [IDLE_CODE, IDLE_CODE]);
    expect(enc.over).toBe(true);
    const out = results(enc);
    expect(out.map((r) => r.outcome)).toEqual(['stood', 'stood']);
    expect(out.map((r) => r.frame)).toEqual([E.timeoutFrames, E.timeoutFrames]);
    expect(enc.frame).toBe(E.timeoutFrames);
  });

  it('survives structuredClone with the same hash', () => {
    const enc = createEncounter(
      startOf('clone', [starterFighter('a', 3000, 3000), starterFighter('b', 3030, 3000)]),
    );
    for (let f = 0; f < 5; f++) stepFrame(enc, [drive(10), drive(200)]);
    const copy = structuredClone(enc);
    expect(hashEncounter(copy)).toBe(hashEncounter(enc));
    stepFrame(enc, [drive(10), drive(200)]);
    stepFrame(copy, [drive(10), drive(200)]);
    expect(hashEncounter(copy)).toBe(hashEncounter(enc));
  });
});

describe('reach', () => {
  it('is the farther of weapon reach and mouth reach times the radius', () => {
    const enc = createEncounter(startOf('reach', [starterFighter('a', 3000, 3000)]));
    const f = at(enc, 0);
    expect(strikeReach(f)).toBe(10);
    f.combat = { ...STARTER_COMBAT, reach: 2 };
    expect(strikeReach(f)).toBe(20);
    f.combat = STARTER_COMBAT;
    f.body.phys = { ...STARTER_PHYS, mouth: { ...STARTER_PHYS.mouth, offset: 1.5, radius: 0.5 } };
    expect(strikeReach(f)).toBe(20);
  });

  it('measures to the nearest collider edge and adds 30% of the target radius to engage', () => {
    const enc = createEncounter(
      startOf('dist', [starterFighter('a', 3000, 3000), starterFighter('b', 3050, 3000)]),
    );
    const a = at(enc, 0);
    const b = at(enc, 1);
    expect(strikeDistance(a.body, b.body)).toBeCloseTo(40, 9);
    expect(strikeDistance({ ...a.body, x: 3100 }, b.body)).toBeCloseTo(40, 9);
    expect(engageRange(a, b)).toBeCloseTo(13, 9);
  });
});

describe('worth', () => {
  const pair = (worth: number) =>
    createEncounter(
      startOf('worth', [
        starterFighter('a', 3000, 3000),
        { ...starterFighter('b', 3030, 3000), worth },
      ]),
    );

  it('is hashed: different worths differ, a structuredClone matches', () => {
    expect(hashEncounter(pair(0.5))).not.toBe(hashEncounter(pair(1)));
    expect(hashEncounter(structuredClone(pair(0.5)))).toBe(hashEncounter(pair(0.5)));
  });

  it('must be 2^-k with k from 0 to 7', () => {
    for (const worth of [0, -1, 1.5, 0.75, 2 ** -8, Number.NaN])
      expect(() => pair(worth)).toThrow(RangeError);
  });
});

describe('speed', () => {
  speedTest('plays 900 frames of null inputs of a 4-fighter encounter in under 250 ms', () => {
    const make = () =>
      calm(
        createEncounter(
          startOf(
            'ffwd',
            ['a', 'b', 'c', 'd'].map((id, i) =>
              starterFighter(id, 3000 + i * 12, 3000 + (i % 2) * 12),
            ),
          ),
        ),
      );
    const warm = make();
    for (let f = 0; f < 100; f++) stepFrame(warm, [null, null, null, null]);
    const enc = make();
    const t0 = performance.now();
    for (let f = 0; f < RULES.encounter.timeoutFrames; f++)
      stepFrame(enc, [null, null, null, null]);
    expect(performance.now() - t0).toBeLessThan(250);
  });

  speedTest('steps a 4-fighter frame in under 0.2 ms', () => {
    const enc = calm(
      createEncounter(
        startOf(
          'speed',
          ['a', 'b', 'c', 'd'].map((id, i) =>
            starterFighter(id, 3000 + i * 12, 3000 + (i % 2) * 12),
          ),
        ),
      ),
    );
    const inputs = [drive(10), drive(70), drive(140), drive(200)];
    for (let i = 0; i < 100; i++) stepFrame(enc, inputs); // warm up
    const runs = 400;
    const t0 = performance.now();
    for (let i = 0; i < runs; i++) stepFrame(enc, inputs);
    const per = (performance.now() - t0) / runs;
    expect(per).toBeLessThan(0.2);
  });
});
