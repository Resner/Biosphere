import { describe, expect, it } from 'vitest';
import { vitalsCap } from '../src/ledger/gates';
import { RULES, TICK_HZ } from '../src/sim/rules';
import { LIFECYCLE_ROWS } from '../tools/capacity-measure';
import {
  advance,
  authority,
  join,
  type Player,
  pair,
  rehatch,
  setEnv,
  useFightHub,
} from './fight-test-kit';
import { breed, grower, promote } from './lineage-test-kit';
import type { RowCounter } from './metered-sql';
import { nextOf, placed, report } from './test-hub';

// M14 T14d: what the lifecycle's transactions write, in rows. The capacity model prices them
// (`LIFECYCLE_ROWS` in `tools/capacity-measure.ts`); the soak's rows per player-hour found that the
// model had left them out, and this test holds the numbers to the hub.

useFightHub();

const counter = () =>
  authority((o) => {
    const c = (o as unknown as { rowCount: RowCounter }).rowCount;
    return { written: c.written, tables: { ...c.tables } };
  });

/** The rows `work` writes, in all and by table. */
async function rowsOf(work: () => Promise<unknown>) {
  const before = await counter();
  await work();
  const after = await counter();
  const tables: Record<string, number> = {};
  for (const [t, n] of Object.entries(after.tables)) {
    const d = n - (before.tables[t] ?? 0);
    if (d > 0) tables[t] = d;
  }
  return { written: after.written - before.written, tables };
}

async function play(p: Player, ms: number): Promise<void> {
  await advance(ms);
  p.ticks += (ms * TICK_HZ) / 1000;
  const biomass = Math.floor(RULES.starter.biomass * 100);
  const cap = vitalsCap(biomass);
  report(p.c, p.ticks, { biomass, energy: Math.floor(cap.energy * 0.9), health: cap.health });
  await nextOf(p.c, 'ack');
}

describe('the rows of a life', () => {
  it('writes the rows the capacity model prices for a hatch, a mating and a promotion', async () => {
    await setEnv(true);
    const { c, id, pond } = await join();
    const hatch = await rowsOf(async () => {
      await rehatch({ c, id, pond });
    });
    const [a, b] = await pair();
    for (const q of [a, b]) await play(q, 10_000);
    await placed(a, b);
    let born!: Awaited<ReturnType<typeof breed>>;
    const mating = await rowsOf(async () => {
      born = await breed(a, b);
    });
    const ga = await grower(a);
    const promoted = await rowsOf(async () => {
      await promote(ga, born[0]);
    });
    expect({ hatch: hatch.written, mating: mating.written, promote: promoted.written }).toEqual(
      LIFECYCLE_ROWS,
    );
    // Every row is named by the table it went to.
    for (const r of [hatch, mating, promoted])
      expect(Object.values(r.tables).reduce((n, v) => n + v, 0)).toBe(r.written);
  });
});
