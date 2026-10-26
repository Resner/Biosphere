// The archetype tournament (M3 T17): the six bodies of `archetypes.ts` run four sim scenarios with
// simple deterministic bots, through the real `step`, so movement, feeding, metabolism and toxin
// all come from the rules. Higher scores are better in every scenario.

import { buildCreature } from '../src/genome/stats';
import { efficiency, foodNear } from '../src/sim/food';
import { Hasher } from '../src/sim/hash';
import { plumesNear } from '../src/sim/hazards';
import { angleToSteer, type Input } from '../src/sim/input';
import { atan2, sin, wrapAngle } from '../src/sim/math';
import { DT, RULES } from '../src/sim/rules';
import { step } from '../src/sim/step';
import type { CreatureState, World } from '../src/sim/types';
import { maxEnergy } from '../src/sim/vitals';
import { createWorld, spawnCreature } from '../src/sim/world';
import { ARCHETYPES } from './archetypes';

export const SCENARIOS = ['forage', 'gauntlet', 'sprint', 'cruise'] as const;
export type Scenario = (typeof SCENARIOS)[number];
export const SEEDS = ['t0', 't1', 't2', 't3', 't4', 't5', 't6', 't7'] as const;

const ID = 'bot';
const SECONDS = 1 / DT;
const FORAGE_TICKS = 180 * SECONDS;
const FORAGE_LOOKOUT = 300;
/** The bot picks a new target this often, in ticks: scanning the food grid every tick is slow. */
const RETARGET = 20;
/** No forager stops growing within its 3 minutes, whatever its size genes say. */
const FORAGE_CAP = 6000;
/** A forager cruises at about 60% thrust: movement burns energy with the square of the throttle. */
const FORAGE_THROTTLE = 9;
/** The forager keeps this far (wu) from a plume's edge. */
const PLUME_MARGIN = 40;
/** Plumes across the gauntlet: three discs 280 wu apart, from x = 800. */
const GAUNTLET = { startX: 200, endX: 1700, y: 4096, plumes: 3, spacing: 280, radius: 80 };
const SPRINT = { distance: 2000, startX: 1000, y: 4096, arrive: 60 };
const CRUISE = { energyFraction: 0.4, throttle: 8, maxSeconds: 600 };

const eaten = (world: World): void => {
  // Every food slot stays empty for good.
  const n = Math.floor(world.size / RULES.world.cellSize);
  for (let cx = 0; cx < n; cx++)
    for (let cy = 0; cy < n; cy++)
      for (let s = 0; s < RULES.food.slotsPerCell; s++)
        world.consumed[`c${cx}_${cy}_s${s}`] = { k: 1, until: Number.MAX_SAFE_INTEGER };
};

/** `young` hatches at the starter biomass; `adult` at the biomass its size genes stop at. */
function spawn(
  world: World,
  archetype: string,
  x: number,
  y: number,
  stage: 'young' | 'adult' = 'young',
): CreatureState {
  const genome = ARCHETYPES[archetype];
  if (genome === undefined) throw new Error(`no archetype ${archetype}`);
  const phys = buildCreature(genome).phys;
  return spawnCreature(world, {
    id: ID,
    x,
    y,
    phys,
    ...(stage === 'adult' ? { biomass: phys.maxBiomass } : {}),
  });
}

const toward = (from: CreatureState, x: number, y: number, throttle = 15): Input => ({
  steer: angleToSteer(atan2(y - from.y, x - from.x)),
  throttle,
  dash: false,
});

/** Turns before it moves: a body that is not facing the target eases off, so it does not orbit it. */
function approach(c: CreatureState, x: number, y: number): Input {
  const error = Math.abs(wrapAngle(atan2(y - c.y, x - c.x) - c.heading));
  const throttle = error > 1 ? 1 : error > 0.4 ? 5 : FORAGE_THROTTLE;
  return toward(c, x, y, throttle);
}

/** Heads for the food it can digest that pays best for the trip; sweeps the pond when none is near. */
function forageTarget(world: World, c: CreatureState): { x: number; y: number } {
  // Out of a plume first: head directly away from the nearest one that is close.
  const near = plumesNear(world, c.x, c.y, 2 * PLUME_MARGIN)
    .map((p) => ({ p, d: Math.hypot(p.x - c.x, p.y - c.y) - p.radius }))
    .sort((a, b) => a.d - b.d)[0];
  if (near !== undefined && near.d < PLUME_MARGIN)
    return { x: c.x - (near.p.x - c.x), y: c.y - (near.p.y - c.y) };
  let best: { x: number; y: number } | null = null;
  let bestScore = 0;
  const plumes = plumesNear(world, c.x, c.y, FORAGE_LOOKOUT);
  const inPlume = (x: number, y: number): boolean =>
    plumes.some((p) => Math.hypot(p.x - x, p.y - y) < p.radius + PLUME_MARGIN);
  for (const item of foodNear(world, c.x, c.y, FORAGE_LOOKOUT)) {
    if (inPlume(item.x, item.y)) continue;
    const worth = item.value * efficiency(item.kind, c.phys.mouth.type) * c.phys.mouth.digestion;
    const score = worth / (Math.hypot(item.x - c.x, item.y - c.y) + 80);
    if (score > bestScore) {
      bestScore = score;
      best = item;
    }
  }
  if (best !== null) return best;
  // Nothing in sight: circle the pond's middle so every body explores the same ground.
  const t = world.tick / SECONDS;
  return {
    x: world.size / 2 + 2000 * sin(t * 0.05 + 1.57),
    y: world.size / 2 + 2000 * sin(t * 0.05),
  };
}

export interface Run {
  /** Higher is better. */
  score: number;
  /** A readable value for the report. */
  detail: string;
}

function forage(archetype: string, seed: string): Run {
  const world = createWorld({ seed });
  const c = spawn(world, archetype, world.size / 2, world.size / 2);
  c.phys.maxBiomass = FORAGE_CAP;
  const start = c.biomass;
  let target = { x: c.x, y: c.y };
  for (let i = 0; i < FORAGE_TICKS && c.alive; i++) {
    if (i % RETARGET === 0) target = forageTarget(world, c);
    step(world, { [ID]: approach(c, target.x, target.y) });
  }
  const gained = c.biomass - start;
  return { score: gained, detail: `${gained.toFixed(1)} biomass` };
}

function gauntlet(archetype: string, seed: string): Run {
  const g = GAUNTLET;
  const world = createWorld({ seed, hazards: false });
  for (let i = 0; i < g.plumes; i++)
    world.extraPlumes.push({ id: `p${i}`, x: 800 + i * g.spacing, y: g.y, radius: g.radius });
  const c = spawn(world, archetype, g.startX, g.y, 'adult');
  let ticks = 0;
  while (c.alive && c.x < g.endX && ticks < 120 * SECONDS) {
    step(world, { [ID]: toward(c, g.endX + 200, g.y) });
    ticks++;
  }
  const seconds = ticks / SECONDS;
  // Health left is what counts; the time breaks ties between bodies that took the same damage.
  const finished = c.alive && c.x >= g.endX;
  const score = finished ? c.health - seconds * 0.01 : -seconds;
  return {
    score,
    detail: finished
      ? `${c.health.toFixed(1)} hp, ${seconds.toFixed(1)} s`
      : `died, ${seconds.toFixed(1)} s`,
  };
}

function sprint(archetype: string, seed: string): Run {
  const s = SPRINT;
  const world = createWorld({ seed, hazards: false });
  const c = spawn(world, archetype, s.startX, s.y);
  const goal = s.startX + s.distance;
  let ticks = 0;
  while (c.alive && Math.hypot(goal - c.x, s.y - c.y) > s.arrive && ticks < 300 * SECONDS) {
    const input = toward(c, goal, s.y);
    step(world, { [ID]: { ...input, dash: world.tick >= c.dashReadyTick } });
    ticks++;
  }
  const seconds = ticks / SECONDS;
  return { score: -seconds, detail: `${seconds.toFixed(1)} s` };
}

function cruise(archetype: string, seed: string): Run {
  const world = createWorld({ seed, hazards: false });
  eaten(world);
  const c = spawn(world, archetype, world.size / 2, world.size / 2);
  c.energy = CRUISE.energyFraction * maxEnergy(c.biomass);
  let ticks = 0;
  // Gentle laps round a point, so no wall interferes.
  while (c.alive && c.energy > 0 && ticks < CRUISE.maxSeconds * SECONDS) {
    const t = ticks / SECONDS;
    step(world, {
      [ID]: toward(
        c,
        world.size / 2 + 300 * sin(t * 0.3 + 1.57),
        world.size / 2 + 300 * sin(t * 0.3),
        CRUISE.throttle,
      ),
    });
    ticks++;
  }
  const seconds = ticks / SECONDS;
  return { score: seconds, detail: `${seconds.toFixed(1)} s` };
}

const RUN: Record<Scenario, (archetype: string, seed: string) => Run> = {
  forage,
  gauntlet,
  sprint,
  cruise,
};

export interface Tournament {
  archetypes: string[];
  /** Mean score over the seeds, `[archetype][scenario]`. */
  means: Record<string, Record<Scenario, number>>;
  /** Readable mean per cell for the report. */
  details: Record<string, Record<Scenario, string>>;
  winners: Record<Scenario, string>;
  /** Archetypes by rank, best first, per scenario. */
  ranking: Record<Scenario, string[]>;
  hash: string;
}

/** Runs every archetype through `scenarios` on all seeds. Pure: the same call gives the same result. */
export function runTournament(scenarios: readonly Scenario[] = SCENARIOS): Tournament {
  const archetypes = Object.keys(ARCHETYPES);
  const means = {} as Tournament['means'];
  const details = {} as Tournament['details'];
  for (const a of archetypes) {
    means[a] = {} as Record<Scenario, number>;
    details[a] = {} as Record<Scenario, string>;
    for (const sc of scenarios) {
      const runs = SEEDS.map((seed) => RUN[sc](a, seed));
      const mean = runs.reduce((sum, r) => sum + r.score, 0) / runs.length;
      means[a][sc] = mean;
      details[a][sc] = runs.map((r) => r.detail).join(' | ');
    }
  }
  const ranking = {} as Tournament['ranking'];
  const winners = {} as Tournament['winners'];
  const h = new Hasher();
  for (const sc of scenarios) {
    const order = [...archetypes].sort(
      (x, y) => (means[y]?.[sc] ?? 0) - (means[x]?.[sc] ?? 0) || (x < y ? -1 : 1),
    );
    ranking[sc] = order;
    winners[sc] = order[0] as string;
  }
  for (const a of archetypes) for (const sc of scenarios) h.f64(means[a]?.[sc] ?? 0);
  return { archetypes, means, details, winners, ranking, hash: h.digest() };
}

/** The archetype × scenario table of mean scores, with each cell's rank. */
export function report(t: Tournament): string {
  const scenarios = SCENARIOS.filter((sc) => t.ranking[sc] !== undefined);
  const rows = t.archetypes.map((a) => {
    const cells = scenarios.map((sc) => {
      const rank = t.ranking[sc].indexOf(a) + 1;
      return `${(t.means[a]?.[sc] ?? 0).toFixed(2)} (#${rank})`;
    });
    return `| ${a} | ${cells.join(' | ')} |`;
  });
  return [
    `| archetype | ${scenarios.join(' | ')} |`,
    `|---|${scenarios.map(() => '---').join('|')}|`,
    ...rows,
  ].join('\n');
}
