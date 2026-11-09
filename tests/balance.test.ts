import { describe, expect, it } from 'vitest';
import type { Genome } from '../src/genome/codec';
import { buildCreature } from '../src/genome/stats';
import { mateCost } from '../src/sim/mating';
import { RULES } from '../src/sim/rules';
import { balanceReport, gates } from '../tools/balance-report';
import { ARCHETYPE_KEEPS, ARCHETYPES, buildGenome } from './archetypes';
import {
  type BalanceBody,
  type BalanceRun,
  balanceLife,
  fight,
  GENESIS_BODIES,
  population,
  scoreBody,
  VARIANTS,
} from './balance';
import { handBuiltBody } from './combat-tournament';
import { heavyTest } from './heavy';

const body = (
  archetype: string,
  genome: Genome = ARCHETYPES[archetype] as Genome,
): BalanceBody => ({
  id: `${archetype}-test`,
  archetype,
  genome,
});

describe('the population', () => {
  const bodies = population();
  const archetypes = Object.keys(ARCHETYPES);

  it('holds 11 archetypes of 16 bodies each (itself and 15 variants), and 32 genesis bodies', () => {
    expect(archetypes).toHaveLength(11);
    expect(bodies.filter((b) => b.archetype !== 'genesis')).toHaveLength(11 * (VARIANTS + 1));
    expect(bodies.filter((b) => b.archetype === 'genesis')).toHaveLength(GENESIS_BODIES);
    expect(new Set(bodies.map((b) => b.id)).size).toBe(bodies.length);
  });

  it('keeps each archetype defining feature in every variant, and every variant differs', () => {
    for (const name of archetypes) {
      const base = ARCHETYPES[name] as Genome;
      expect(ARCHETYPE_KEEPS[name]?.(base, buildCreature(base))).toBe(true);
      const hashes = new Set<string>([buildCreature(base).hash]);
      for (const b of bodies.filter((x) => x.archetype === name)) {
        const c = buildCreature(b.genome);
        expect(ARCHETYPE_KEEPS[name]?.(b.genome, c), b.id).toBe(true);
        hashes.add(c.hash);
      }
      expect(hashes.size, name).toBe(VARIANTS + 1);
    }
  });

  it('is the same every time', () => {
    const again = population();
    expect(again.map((b) => buildCreature(b.genome).hash)).toEqual(
      bodies.map((b) => buildCreature(b.genome).hash),
    );
  });
});

describe('a life', () => {
  const opponents = population(1, 0);

  heavyTest('is the same life for the same seed, and a different one for another', () => {
    const b = body('ciliate');
    const run = (seed: string) =>
      balanceLife(b, seed, { zone: 'twilight', opponents, capMs: 9 * 60_000 });
    expect(run('a')).toEqual(run('a'));
    expect(run('a')).not.toEqual(run('b'));
  });

  it('scores 0 for a body that starves before maturity', () => {
    const filter = opponents.find((b) => b.id === 'filter-0') as BalanceBody;
    const life = balanceLife(filter, 'x', { zone: 'deep', fights: false });
    expect(life.end).toBe('starved');
    expect(life.score).toBe(0);
    expect(life.matureAtMs).toBeNull();
  });

  it('grows the winner of a fight by the kill reward', () => {
    const side = (name: string) => ({
      body: handBuiltBody(ARCHETYPES[name] as Genome),
      biomass: 100,
    });
    const hunter = side('hunter');
    let kills = 0;
    for (const prey of Object.keys(ARCHETYPES).map(side)) {
      for (let layout = 0; layout < 8; layout++) {
        const r = fight(hunter, prey, layout, false);
        if (!r.kill) continue;
        kills++;
        // The victim is of the same tier and worth 1: the killer takes the reward share of its biomass.
        const gain = r.end.biomass - hunter.biomass;
        expect(gain).toBeCloseTo(RULES.encounter.reward.share * prey.biomass, 6);
      }
    }
    expect(kills).toBeGreaterThan(0);
  });

  heavyTest('ends a fought life when a fight kills it', () => {
    // A starter-sized cell against a hunter's weight in a crowd of hunters: some life of a few dies of a kill.
    const hunters = population(3, 0).filter((b) => b.archetype === 'hunter');
    const ends = Array.from({ length: 6 }, (_, i) =>
      balanceLife(body('filter'), `k${i}`, {
        zone: 'twilight',
        opponents: hunters,
        capMs: 30 * 60_000,
      }),
    );
    for (const life of ends) expect(life.fights).toBeGreaterThanOrEqual(life.kills);
    expect(ends.some((l) => l.end === 'killed')).toBe(true);
  });

  heavyTest(
    'mates at most once per cooldown after maturity, pays the cost, and dies of old age',
    () => {
      const life = balanceLife(body('ciliate'), 'old', {
        zone: 'twilight',
        fights: false,
        keepEnergy: true,
      });
      expect(life.end).toBe('old-age');
      const matured = life.matureAtMs as number;
      expect(matured).toBeGreaterThan(0);
      const minutes = (life.endMs - matured) / 60_000;
      const cooldown = RULES.mating.cooldownMs / 60_000;
      expect(life.matings.length).toBeGreaterThanOrEqual(1);
      expect(life.matings.length).toBeLessThanOrEqual(Math.floor(minutes / cooldown) + 1);
      for (const m of life.matings)
        expect(m.after).toEqual(mateCost(m.before.biomass, m.before.energy));
      expect(life.score).toBe(life.matings.length);
    },
  );
});

describe('a scaled run', () => {
  heavyTest('scores one body of each archetype, the same for the same seed, and reports it', () => {
    const bodies = population(1, 0).filter((b) => b.id.endsWith('-base'));
    const run = (): BalanceRun => ({
      rules: RULES.world.size,
      variants: 1,
      genesis: 0,
      lives: 1,
      bodies: bodies.map((b) => scoreBody(b, 1, { capMs: 9 * 60_000, opponents: bodies })),
    });
    const first = run();
    expect(run()).toEqual(first);
    expect(first.bodies).toHaveLength(11);
    expect(balanceReport(first)).toBe(balanceReport(run()));
    expect(gates(first)).toHaveLength(2);
  });
});
