import { readFileSync, writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { REACH_TABLE_SEEDS, reachTable } from '../../tests/growth-reach-table';
import type { Genome } from '../genome/codec';
import { express } from '../genome/express';
import { genesisGenome } from '../genome/genesis';
import { buildCreature } from '../genome/stats';
import { lifespanMs } from '../sim/life';
import { hatchling } from '../sim/mating';
import { createRng, seedFromString } from '../sim/prng';
import { RULES } from '../sim/rules';
import { maxEnergy, maxHealth } from '../sim/vitals';
import {
  CLOCK_SLACK_MS,
  cooldownOf,
  growthReach,
  LIVE_SCALES,
  lifespanOf,
  matureAtOf,
  matureBiomassOf,
  paidFor,
  reachAt,
  repeatWindowOf,
  restoreMinOf,
  type Scales,
  startOf,
} from './gates';

// The one rulebook of the authority and the verifier (ADR 0055): the values the worker used to
// compute itself, now shared. Hundredths and ms throughout.

const GOLDEN = new URL('./__golden__/growth-reach.json', import.meta.url);
const TEST: Scales = { lifespan: 0.05, mating: 0.01 };
const genome = (name: string): Genome => genesisGenome(seedFromString(name));
const GENOMES = ['gates-a', 'gates-b', 'gates-c', 'gates-d'].map(genome);

/** The reach as the worker's clamp computed it before this rulebook, with `Math.exp`. */
function oldReach(from: number, growth: number, activeMs: number): number {
  const base = Math.max(from / 100, RULES.starter.biomass);
  const reach = base * Math.exp(RULES.growth.maxRate * growth * 1.1 * (activeMs / 1000)) + 1;
  return Math.floor(reach * 100);
}

describe('the time gates', () => {
  it('give the lifespan, scaled by the lifespan scale only', () => {
    for (const g of GENOMES) {
      const base = lifespanMs(express(g).physiology.lifespan);
      expect(lifespanOf(g, LIVE_SCALES)).toBe(Math.round(base));
      expect(lifespanOf(g, TEST)).toBe(Math.round(base * 0.05));
      expect(lifespanOf(g, { lifespan: 1, mating: 0.01 })).toBe(Math.round(base));
    }
  });

  it('give maturity at max(7 min, 10% of the lifespan), scaled by the mating scale', () => {
    for (const g of GENOMES) {
      const base = lifespanMs(express(g).physiology.lifespan);
      const live = Math.round(Math.max(RULES.life.matureMinMs, RULES.life.matureMinShare * base));
      expect(matureAtOf(g, LIVE_SCALES)).toBe(live);
      expect(matureAtOf(g, TEST)).toBe(
        Math.round(0.01 * Math.max(RULES.life.matureMinMs, RULES.life.matureMinShare * base)),
      );
      expect(matureAtOf(g, LIVE_SCALES)).toBeGreaterThanOrEqual(RULES.life.matureMinMs);
    }
  });

  it('give the maturity size as 60% of the adult biomass in hundredths, never scaled', () => {
    for (const g of GENOMES) {
      const max = buildCreature(g).phys.maxBiomass;
      const need = matureBiomassOf(g);
      expect(need / 100).toBeGreaterThanOrEqual(RULES.life.matureBiomassShare * max);
      expect((need - 1) / 100).toBeLessThan(RULES.life.matureBiomassShare * max);
    }
  });

  it('give the cooldown doubling with each earlier mating of the pair, up to the cap', () => {
    expect(cooldownOf(0, LIVE_SCALES)).toBe(540_000);
    expect(cooldownOf(1, LIVE_SCALES)).toBe(1_080_000);
    expect(cooldownOf(9, LIVE_SCALES)).toBe(
      cooldownOf(RULES.mating.repeatMaxDoublings, LIVE_SCALES),
    );
    expect([0, 1, 2].map((k) => cooldownOf(k, TEST))).toEqual([5400, 10_800, 21_600]);
  });

  it('give the repeat window and the restore minimum, scaled by the mating scale', () => {
    expect(repeatWindowOf(LIVE_SCALES)).toBe(RULES.mating.repeatWindowMs);
    expect(repeatWindowOf(TEST)).toBe(864_000);
    expect(restoreMinOf(LIVE_SCALES)).toBe(RULES.mating.restoreMinMs);
    expect(restoreMinOf(TEST)).toBe(1200);
  });

  it('allow the life clock 2 s of slack', () => {
    expect(CLOCK_SLACK_MS).toBe(RULES.life.accrueSlackMs);
    expect(CLOCK_SLACK_MS).toBe(2000);
  });
});

describe('a creature’s start and a mating’s cost', () => {
  it('start a genesis as the starter cell, whatever its genome', () => {
    const b = RULES.starter.biomass;
    const want = {
      biomass: b * 100,
      energy: Math.floor(RULES.starter.energyFraction * maxEnergy(b) * 100),
      health: Math.floor(maxHealth(b) * 100),
    };
    for (const g of GENOMES) expect(startOf('genesis', g)).toEqual(want);
  });

  it('start a birth as the hatchling of its body', () => {
    for (const g of GENOMES) {
      const { biomass, energy } = hatchling(buildCreature(g).phys.maxBiomass);
      expect(startOf('birth', g)).toEqual({
        biomass: Math.floor(biomass * 100),
        energy: Math.floor(energy * 100),
        health: Math.floor(maxHealth(biomass) * 100),
      });
    }
  });

  it('pay 15% of the biomass and 30% of the energy, keeping health within the smaller body', () => {
    expect(paidFor({ biomass: 10_000, energy: 12_000, health: 10_000 })).toEqual({
      biomass: 8500,
      energy: 8400,
      health: Math.min(10_000, Math.floor(maxHealth(85) * 100)),
    });
    const healthy = paidFor({ biomass: 10_000, energy: 12_000, health: 100 });
    expect(healthy.health).toBe(100);
  });
});

describe('growthReach', () => {
  it('reaches from the starter at least, plus 1 wu, in hundredths', () => {
    const g = GENOMES[0] as Genome;
    expect(growthReach(0, g, 0)).toBe(RULES.starter.biomass * 100 + 100);
    expect(growthReach(50_000, g, 0)).toBe(50_100);
    expect(growthReach(50_000, g, 60_000)).toBeGreaterThan(50_100);
    expect(growthReach(50_000, g, 60_000)).toBe(
      reachAt(50_000, buildCreature(g).phys.growth, 60_000),
    );
  });

  it('agrees with the old Math.exp reach within one hundredth over 10k seeded samples', () => {
    const rng = createRng(seedFromString('growth-reach'), 'samples');
    // Over the sizes a body can have: past the largest (2,457,600 wu), the clamp's other cap rules.
    const LARGEST = 1e9;
    let samples = 0;
    while (samples < 10_000) {
      const from = rng.int(0, 250_000_000);
      const growth = rng.range(0.3, 2);
      const activeMs = rng.int(0, 3_600_000);
      const want = oldReach(from, growth, activeMs);
      if (want > LARGEST) continue;
      samples++;
      const got = reachAt(from, growth, activeMs);
      expect(Math.abs(got - want), `${from} ${growth} ${activeMs}`).toBeLessThanOrEqual(1);
    }
  });

  it('matches the pinned table (the workerd pool checks the same file)', () => {
    if (process.env.UPDATE_GOLDENS) {
      writeFileSync(GOLDEN, `${JSON.stringify({ table: reachTable() }, null, 1)}\n`);
    }
    const file = JSON.parse(readFileSync(GOLDEN, 'utf8')) as { table: unknown[] };
    expect(file.table).toHaveLength(64);
    expect(new Set(file.table.map((e) => (e as { seed: string }).seed))).toEqual(
      new Set(REACH_TABLE_SEEDS),
    );
    expect(reachTable()).toEqual(file.table);
  });
});
