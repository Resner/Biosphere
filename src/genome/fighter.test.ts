import { describe, expect, it } from 'vitest';
import { heavyTest } from '../../tests/heavy';
import { STARTER_COMBAT, sanitizeCombat } from '../sim/body';
import { createRng, seedFromString } from '../sim/prng';
import { RULES } from '../sim/rules';
import { decodeGenome } from './codec';
import { fighterOf } from './fighter';
import { genesisGenome } from './genesis';
import { mutateGenome } from './inherit';
import { GENOME_BYTES } from './karyotype';
import { starterGenome } from './starter';
import { buildCreature } from './stats';

const rng = createRng(seedFromString('genome-fighter-tests'), 'bytes');
const randomGenome = () =>
  decodeGenome(Uint8Array.from({ length: GENOME_BYTES }, () => rng.nextU32() & 0xff));

const check = (g: ReturnType<typeof randomGenome>, label: string): void => {
  const f = fighterOf(buildCreature(g));
  const c = RULES.body.combat;
  expect(Object.values(f.combat).every(Number.isFinite), label).toBe(true);
  expect(f.combat.reach, label).toBeGreaterThanOrEqual(c.reachMin);
  expect(f.combat.reach, label).toBeLessThanOrEqual(c.reachMax);
  expect(f.combat.arc, label).toBeGreaterThanOrEqual(0);
  expect(f.combat.arc, label).toBeLessThanOrEqual(Math.PI);
  expect(f.combat.power, label).toBeLessThanOrEqual(c.powerMax);
  expect(f.combat.armour, label).toBeLessThanOrEqual(1);
  expect(f.combat.spines, label).toBeLessThanOrEqual(1);
  expect(f.combat.mass, label).toBeGreaterThanOrEqual(c.massMin);
  expect(f.combat.mass, label).toBeLessThanOrEqual(c.massMax);
  expect(sanitizeCombat(f.combat), label).toEqual(f.combat);
  for (const k of ['aggression', 'caution', 'curiosity', 'reflex'] as const) {
    expect(f.behaviour[k], label).toBeGreaterThanOrEqual(0);
    expect(f.behaviour[k], label).toBeLessThanOrEqual(1);
  }
  expect(['nearest', 'weakest', 'largest', 'strongest'], label).toContain(f.behaviour.targetPref);
};

describe('fighterOf', () => {
  it('gives the reference cell the bare starter combat stats', () => {
    const f = fighterOf(buildCreature(starterGenome()));
    expect(f.combat.reach).toBe(STARTER_COMBAT.reach);
    expect(f.combat.power).toBe(0);
    expect(f.combat.armour).toBe(0);
    expect(f.combat.mass).toBeCloseTo(1, 6);
  });

  it('maps every target allele to one of the four kinds', () => {
    const c = buildCreature(starterGenome());
    for (const targetPref of ['nearest', 'weakest', 'largest', 'strongest', 'bogus']) {
      const f = fighterOf({
        ...c,
        traits: { ...c.traits, behaviour: { ...c.traits.behaviour, targetPref } },
      });
      expect(['nearest', 'weakest', 'largest', 'strongest']).toContain(f.behaviour.targetPref);
    }
  });

  it('keeps the genesis creatures in range', () => {
    for (let i = 0; i < 200; i++)
      check(genesisGenome(seedFromString(`fighter-genesis-${i}`)), `genesis ${i}`);
  });

  heavyTest('stays in range and finite for 10,000 random and 10,000 mutated genomes', () => {
    for (let i = 0; i < 10_000; i++) check(randomGenome(), `random ${i}`);
    for (let i = 0; i < 10_000; i++) {
      const g = mutateGenome(randomGenome(), seedFromString(`fighter-mutant-${i}`), {
        mutation: 1 + (i % 4),
      });
      check(g, `mutant ${i}`);
    }
  });
});
