import { describe, expect } from 'vitest';
import { poolOf } from '../src/ledger/witness';
import { aoiRadius } from '../src/net/aoi';
import { createRng, seedFromString } from '../src/sim/prng';
import { RULES } from '../src/sim/rules';
import { heavyTest, speedTest } from '../tests/heavy';
import { type CrowdContext, type CrowdMember, Crowds } from './crowds';
import { Directory, type DirMember } from './directory';
import {
  clearance,
  groupsFor,
  type Placed,
  place,
  SPAWN_RECENT_MS,
  type Spawner,
} from './placement';

// The pure parts at 10,000 members (M13 T3): placement past the rings' reach, and the budgets of
// placement, the directory, the crowds and the witness pool.

const SIZE = RULES.world.size;
const CENTRE = { x: SIZE / 2, y: SIZE / 2 };
const R = 20;
const AOI = aoiRadius(R, R);
const STARTER: Spawner = { r: R, adultR: R, aoi: AOI };
const WORLD = { seed: 'scale-parts', size: SIZE, tick: 0 };
const rngFor = (label: string) => createRng(seedFromString(label), 'scale-parts');

const member = (id: string, x: number, y: number, r = R): Placed => ({
  id,
  x,
  y,
  r,
  aoi: aoiRadius(r, r),
  n: 0,
});

describe('place past the rings', () => {
  heavyTest(
    '3,000 starters placed one after another keep their clearance and never fall back',
    () => {
      const base = clearance(STARTER, STARTER);
      const members: Placed[] = [];
      const recent: { x: number; y: number; r: number; aoi: number; t: number }[] = [];
      // A hash of the members by cell, so that the checks of 3,000 points stay cheap.
      const cells = new Map<string, Placed[]>();
      const cellKey = (x: number, y: number) => `${Math.floor(x / base)},${Math.floor(y / base)}`;
      let beyondRings = 0;
      for (let k = 0; k < 3000; k++) {
        const now = k * 100;
        const live = recent.filter((s) => now - s.t < SPAWN_RECENT_MS);
        const out = place({
          members,
          recent: live,
          spawner: STARTER,
          centre: CENTRE,
          world: WORLD,
          now,
          rng: rngFor(`growth-${k}`),
        });
        expect(out.fallback, `placement ${k}`).toBe('none');
        // Clearance from every earlier member (each placed point is a member, standing still) and
        // from every spawn of the last 60 s.
        const cx = Math.floor(out.x / base);
        const cy = Math.floor(out.y / base);
        for (let dx = -1; dx <= 1; dx++) {
          for (let dy = -1; dy <= 1; dy++) {
            for (const m of cells.get(`${cx + dx},${cy + dy}`) ?? []) {
              expect(
                Math.hypot(m.x - out.x, m.y - out.y),
                `placement ${k} near ${m.id}`,
              ).toBeGreaterThanOrEqual(clearance(STARTER, m));
            }
          }
        }
        for (const s of live) {
          expect(Math.hypot(s.x - out.x, s.y - out.y)).toBeGreaterThanOrEqual(
            clearance(STARTER, s),
          );
        }
        // Within its group's reach plus 3 clearances of the centroid (the wave's gate 3, ADR 0066).
        if (out.group !== null) {
          const away = Math.hypot(out.x - out.group.x, out.y - out.group.y);
          expect(away, `placement ${k} reach`).toBeLessThanOrEqual(out.group.radius + 3 * base);
          if (out.group.radius > 6500) beyondRings++;
        }
        const placed = member(`s${k}`, out.x, out.y);
        members.push(placed);
        recent.push({ x: out.x, y: out.y, r: R, aoi: AOI, t: now });
        const key = cellKey(out.x, out.y);
        const bucket = cells.get(key);
        if (bucket === undefined) cells.set(key, [placed]);
        else bucket.push(placed);
      }
      // The populated area did grow past what the rings reach from the centroid.
      expect(beyondRings).toBeGreaterThan(0);
    },
  );
});

/** 9,000 starters on a lattice in one populated area, and 1,000 T1s scattered over the world. */
function crowdedWorld(): Placed[] {
  const out: Placed[] = [];
  const gap = clearance(STARTER, STARTER) + 6;
  const side = Math.ceil(Math.sqrt(9000));
  for (let i = 0; i < 9000; i++) {
    const col = i % side;
    const row = Math.floor(i / side);
    out.push(
      member(
        `s${i}`,
        CENTRE.x + (col - side / 2) * gap + (row % 2) * (gap / 2),
        CENTRE.y + (row - side / 2) * gap * 0.87,
      ),
    );
  }
  const rng = rngFor('t1s');
  for (let i = 0; i < 1000; i++) {
    out.push(member(`t${i}`, rng.range(2000, SIZE - 2000), rng.range(2000, SIZE - 2000), 63));
  }
  return out;
}

describe('the pure parts at 10,000 members', () => {
  speedTest(
    'place() averages under 20 ms over 50 placements, and groupsFor stays under 10 ms',
    () => {
      const members = crowdedWorld();
      const args = { members, recent: [], spawner: STARTER, centre: CENTRE, world: WORLD, now: 0 };
      place({ ...args, rng: rngFor('warm') }); // builds the world's depth field once
      let groupsMs = Number.POSITIVE_INFINITY;
      for (let round = 0; round < 5; round++) {
        const t = performance.now();
        groupsFor(members, STARTER, CENTRE);
        groupsMs = Math.min(groupsMs, performance.now() - t);
      }
      const started = performance.now();
      for (let k = 0; k < 50; k++) {
        const out = place({ ...args, rng: rngFor(`timed-${k}`) });
        expect(out.fallback).toBe('none');
      }
      expect((performance.now() - started) / 50).toBeLessThan(20);
      expect(groupsMs).toBeLessThan(10);
    },
  );

  const dirMember = (m: Placed): DirMember => ({
    id: m.id,
    name: m.id,
    x: m.x,
    y: m.y,
    r: m.r,
    aoi: m.aoi,
    t: 0,
  });

  speedTest('the directory takes 10,000 reports and 10,000 near queries within 1.5 s', () => {
    const members = crowdedWorld();
    const dir = new Directory(SIZE);
    const started = performance.now();
    for (const m of members) dir.report(dirMember(m));
    for (const m of members) dir.near(m.id, 0);
    expect(performance.now() - started).toBeLessThan(1500);
  });

  speedTest(
    'the crowds take 10,000 open-water reports within 0.5 s, and one into a crowd of 300 within 1 ms',
    () => {
      const rng = rngFor('open-water');
      const scattered: Placed[] = Array.from({ length: 10_000 }, (_, i) =>
        member(`w${i}`, rng.range(2000, SIZE - 2000), rng.range(2000, SIZE - 2000)),
      );
      const dir = new Directory(SIZE);
      const ctx: CrowdContext = {
        locked: () => false,
        partners: () => [],
        around: (x, y, radius): CrowdMember[] =>
          dir.around(x, y, radius).flatMap((id) => {
            const m = dir.member(id);
            return m ? [{ id, x: m.x, y: m.y, r: m.r }] : [];
          }),
      };
      for (const m of scattered) dir.report(dirMember(m));
      const crowds = new Crowds();
      const started = performance.now();
      for (const m of scattered) crowds.report(m, null, 0, ctx);
      expect(performance.now() - started).toBeLessThan(500);

      // A crowd of 300 inside that world: one report into it.
      const inCrowd: Placed[] = Array.from({ length: 300 }, (_, i) =>
        member(`c${i}`, CENTRE.x + rng.range(-300, 300), CENTRE.y + rng.range(-300, 300)),
      );
      for (const m of inCrowd) dir.report(dirMember(m));
      for (const m of inCrowd) crowds.report(m, null, 0, ctx);
      crowds.report(
        inCrowd[0] as Placed,
        inCrowd.slice(1, 20).map((m) => m.id),
        100,
        ctx,
      );
      crowds.settle(3200, ctx);
      let reporting = Number.POSITIVE_INFINITY;
      for (let round = 0; round < 5; round++) {
        const t = performance.now();
        for (let i = 0; i < 100; i++) crowds.report(inCrowd[i] as Placed, null, 4000 + round, ctx);
        reporting = Math.min(reporting, (performance.now() - t) / 100);
      }
      expect(reporting).toBeLessThan(1);
    },
  );

  speedTest('poolOf over 10,000 eligible ids takes under 10 ms', () => {
    const ids = Array.from({ length: 10_000 }, (_, i) => `p${String(i).padStart(42, '0')}`);
    poolOf(ids, 'warm');
    let best = Number.POSITIVE_INFINITY;
    for (let round = 0; round < 5; round++) {
      const t = performance.now();
      poolOf(ids, `event-${round}`);
      best = Math.min(best, performance.now() - t);
    }
    expect(best).toBeLessThan(10);
  });
});
