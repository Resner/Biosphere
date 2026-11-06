import { expect } from 'vitest';
import { LIVE_SCALES, matureBiomassOf } from '../src/ledger/gates';
import { TICK_HZ } from '../src/sim/rules';
import {
  advance,
  join,
  killB,
  lifeOn,
  lockIn,
  NEAR,
  rehatch,
  seasoned,
  setEnv,
  snap,
} from './fight-test-kit';
import { must } from './ledger-test-kit';
import { breed, grower, growTo, promote, restore, sizeOf } from './lineage-test-kit';
import { closeSockets, nextOf } from './test-hub';

// The hub history shared by the proof tests and the storage report (needs `useFightHub()`).

/**
 * The history of the lineage fixture, made through the hub: A0 and B0 hatch, grow and mate; A
 * promotes A1; A1 kills B0, eating B1's egg; A1 dies of a toxin; A restores A0.
 */
export async function history() {
  await setEnv(true);
  const pa = await join();
  const pb = await join();
  let a = await grower(await rehatch(pa));
  const b = await grower(await rehatch(pb));
  for (const p of [a, b]) await seasoned(p);
  for (const p of [a, b]) await growTo(p, Math.ceil(matureBiomassOf(p.genome, LIVE_SCALES) * 1.02));
  const a0 = a.creature;
  const b0 = b.creature;
  const [bornA, bornB] = await breed(a, b);
  a = await promote(a, bornA);
  const a1 = a.creature;
  // Past A1's spawn protection, then the fight: B0 at 1 hp, carrying B1 as an egg.
  await growTo(a, Math.ceil(must(await lifeOn(a)).biomass * 1.1));
  await advance(16_000);
  const [start] = await lockIn(
    a,
    b,
    snap(b, ...NEAR.b, { health: 0.01, egg: true, biomass: await sizeOf(b) }),
    snap(a, ...NEAR.a, { health: 1, biomass: await sizeOf(a) }),
  );
  await killB(a, b, start);
  await advance(5_000);
  a.ticks += 5 * TICK_HZ;
  a.c.send({ t: 'death', cause: 'toxin', ticks: a.ticks });
  const died = await nextOf(a.c, 'died');
  const ancestor = must(died.fallback?.ancestor);
  expect(ancestor.creature).toBe(a0);
  await restore(a, ancestor, a1);
  await closeSockets();
  return { a0, b0, a1, b1: bornB.record.hash, enc: start.enc };
}
