import { describe, expect, it } from 'vitest';
import { PondClock } from '../net/clock';
import { foodNear } from '../sim/food';
import { plumesNear } from '../sim/hazards';
import { TICK_HZ } from '../sim/rules';
import { step } from '../sim/step';
import { createWorld, spawnCreature } from '../sim/world';
import { PondTime } from './pond-time';

const EPOCH = 1_000_000;

/** A browser whose local clock reads `skew` ms off the hub's and started at a given time. */
function client(skew: number) {
  const clock = new PondClock();
  clock.addSample(0, 0, skew); // hubNow = local + skew
  return new PondTime(clock, EPOCH);
}

const snapshot = (w: ReturnType<typeof createWorld>) =>
  JSON.stringify([foodNear(w, 2000, 2000, 400), plumesNear(w, 2000, 2000, 400)]);

describe('PondTime', () => {
  it('puts a joining world on the pond tick', () => {
    const world = createWorld({ seed: 'pond' });
    client(5_000).join(world, EPOCH - 5_000 + 12_345);
    expect(world.tick).toBe(Math.floor((12_345 * TICK_HZ) / 1000));
  });

  it('reads pond time in ms since the epoch from the local clock', () => {
    expect(client(5_000).pondMs(EPOCH - 5_000 + 1_500)).toBe(1_500);
  });

  it('shows the same food and plumes to worlds that joined 7 s apart', () => {
    const early = createWorld({ seed: 'pond' });
    const late = createWorld({ seed: 'pond' });
    // Different local clocks, joining 7 s of hub time apart.
    const a = client(5_000);
    const b = client(-3_000);
    a.join(early, EPOCH - 5_000 + 20_000);
    b.join(late, EPOCH + 3_000 + 27_000);
    expect(early.tick).toBeLessThan(late.tick);
    // A plays 7 s while B has just joined: both are at hub time EPOCH + 27 s.
    for (let i = 0; i < 7 * TICK_HZ; i++) step(early, {});
    expect(early.tick).toBe(late.tick);
    expect(snapshot(early)).toBe(snapshot(late));
  });

  it('slews a small drift without snapping and settles within a tick', () => {
    const world = createWorld({ seed: 'pond' });
    const time = client(0);
    time.join(world, EPOCH);
    let now = EPOCH;
    let acc = 0;
    let ran = 0;
    let largestJump = 0;
    /** One 60 fps loop frame: the loop speed from `update` scales the ticks it runs. */
    const frame = (): void => {
      const speed = time.update(world, now);
      acc += (speed * TICK_HZ) / 60;
      while (acc >= 1) {
        acc -= 1;
        const before = world.tick;
        world.tick++;
        ran++;
        largestJump = Math.max(largestJump, world.tick - before);
      }
      now += 1000 / 60;
    };
    for (let i = 0; i < 60 * 10; i++) frame(); // ten seconds on time
    expect(Math.abs(((now - EPOCH) * TICK_HZ) / 1000 - world.tick)).toBeLessThan(1.5);
    world.tick -= 2; // two ticks behind the pond
    ran = 0;
    for (let i = 0; i < 60 * 12; i++) frame();
    const target = ((now - EPOCH) * TICK_HZ) / 1000;
    expect(largestJump).toBe(1);
    expect(ran).toBeGreaterThan(12 * TICK_HZ); // it ran fast to catch up
    expect(Math.abs(target - world.tick)).toBeLessThan(1.5);
  });

  it('leaves an on-time world alone and snaps a large drift', () => {
    const world = createWorld({ seed: 'pond' });
    const time = client(0);
    time.join(world, EPOCH);
    world.tick = 300; // on time at EPOCH + 10 s
    expect(time.update(world, EPOCH + 10_000)).toBe(1);
    expect(world.tick).toBe(300);
    world.tick = 100;
    expect(time.update(world, EPOCH + 20_000)).toBe(1);
    expect(world.tick).toBe(600);
  });

  it('resnaps after a hidden tab without costing the creature anything', () => {
    const world = createWorld({ seed: 'pond' });
    const creature = spawnCreature(world, { id: 'me', x: 2000, y: 2000 });
    const time = client(0);
    time.join(world, EPOCH);
    for (let i = 0; i < 30; i++) step(world, {});
    const energy = creature.energy;
    time.resnap(world, EPOCH + 300_000); // five minutes hidden
    expect(world.tick).toBe(300 * TICK_HZ);
    expect(creature.alive).toBe(true);
    expect(creature.energy).toBe(energy);
  });
});
