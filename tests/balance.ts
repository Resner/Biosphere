// The balance simulation (M14 T10, ADR 0078): whole lives of many bodies on the real rules, scored
// by their matings, to see whether different builds succeed. `tools/balance-report.ts` turns the
// scores into the report and its gates; `npm run sim:balance` runs it.

import type { Genome } from '../src/genome/codec';
import { fighterOf } from '../src/genome/fighter';
import { genesisGenome } from '../src/genome/genesis';
import { mutateGenome } from '../src/genome/inherit';
import { buildCreature } from '../src/genome/stats';
import { depthAt, type Zone, zoneAt } from '../src/sim/bathymetry';
import type { Outcome } from '../src/sim/encounter/types';
import { foodForTier } from '../src/sim/food';
import { plumesNear } from '../src/sim/hazards';
import { angleToSteer } from '../src/sim/input';
import { applyLife, lifeStage, lifespanMs } from '../src/sim/life';
import { atan2, log } from '../src/sim/math';
import { cooldownMs, hatchling } from '../src/sim/mating';
import { createRng, hashU32, seedFromString } from '../src/sim/prng';
import { RULES, TICK_HZ } from '../src/sim/rules';
import { step } from '../src/sim/step';
import type { DeathCause, World } from '../src/sim/types';
import { maxEnergy, maxHealth } from '../src/sim/vitals';
import { createWorld, spawnCreature } from '../src/sim/world';
import { ARCHETYPE_KEEPS, ARCHETYPES } from './archetypes';
import { duel, type FighterEnd, handBuiltBody, type Side } from './combat-tournament';

/** Variants per archetype, genesis bodies as a reference, and lives per body (the full run). */
export const VARIANTS = 15;
export const GENESIS_BODIES = 32;
export const LIVES = 16;
/** Fights per hour of a life (the capacity model's assumption) and the opponent's biomass ratio range. */
export const FIGHTS_PER_HOUR = 3;
export const FIGHT_RATIO: readonly [number, number] = [0.67, 1.5];
/** The probe that picks a body's zone: this many active ms in each zone. */
export const PROBE_MS = 120_000;
export const ZONES: readonly Zone[] = ['shallows', 'twilight', 'deep', 'abyss'];

export interface BalanceBody {
  id: string;
  /** The archetype it varies, or `genesis` for the reference bodies. */
  archetype: string;
  genome: Genome;
}

/** One variant per `index`: 1 to 3 mutation trials of the archetype that still hold its feature. */
export function variantOf(name: string, index: number, taken: ReadonlySet<string>): Genome {
  const base = ARCHETYPES[name] as Genome;
  const keeps = ARCHETYPE_KEEPS[name] as NonNullable<(typeof ARCHETYPE_KEEPS)[string]>;
  for (let attempt = 0; attempt < 200; attempt++) {
    const trials = 1 + (hashU32(index, attempt, seedFromString(name)[0]) % 3);
    let g = base;
    for (let t = 0; t < trials; t++) {
      g = mutateGenome(g, seedFromString(`balance/${name}/${index}/${attempt}/${t}`), {
        mutation: 2,
      });
    }
    const c = buildCreature(g);
    if (!taken.has(c.hash) && keeps(g, c)) return g;
  }
  throw new Error(`no variant ${index} of ${name} keeps its feature`);
}

/** The population: each archetype itself and `variants` mutated bodies of it, then `genesis` reference bodies. */
export function population(variants = VARIANTS, genesis = GENESIS_BODIES): BalanceBody[] {
  const bodies: BalanceBody[] = [];
  for (const name of Object.keys(ARCHETYPES)) {
    const taken = new Set<string>([buildCreature(ARCHETYPES[name] as Genome).hash]);
    bodies.push({ id: `${name}-base`, archetype: name, genome: ARCHETYPES[name] as Genome });
    for (let v = 0; v < variants; v++) {
      const genome = variantOf(name, v, taken);
      taken.add(buildCreature(genome).hash);
      bodies.push({ id: `${name}-${v}`, archetype: name, genome });
    }
  }
  for (let i = 0; i < genesis; i++) {
    bodies.push({
      id: `genesis-${i}`,
      archetype: 'genesis',
      genome: genesisGenome(seedFromString(`balance-genesis-${i}`)),
    });
  }
  return bodies;
}

const MS_PER_TICK = 1000 / TICK_HZ;
const SENSE = 400;
const PLUME_MARGIN = 60;
/** The forager looks for food this often (0.4 s): twice the pacing bot's interval, for half the lookups. */
const RETARGET_TICKS = 12;
const ZONE_EDGES = RULES.bathymetry.zones;
const ZONE_RANGE: Record<Zone, readonly [number, number]> = {
  shallows: [0, ZONE_EDGES.shallows],
  twilight: [ZONE_EDGES.shallows, ZONE_EDGES.twilight],
  deep: [ZONE_EDGES.twilight, ZONE_EDGES.deep],
  abyss: [ZONE_EDGES.deep, 1],
};
const inZone = (world: World, zone: Zone, x: number, y: number): boolean => {
  const depth = depthAt(world.seed32, x, y, world.size);
  const [lo, hi] = ZONE_RANGE[zone];
  return depth >= lo && depth <= hi;
};

/** The point nearest the world's centre that lies well inside `zone` (all around it), or null. */
function zoneAnchor(world: World, zone: Zone): { x: number; y: number } | null {
  const mid = world.size / 2;
  const STEP = 256;
  const around = [-1, 0, 1].flatMap((i) => [-1, 0, 1].map((j) => [i * 300, j * 300] as const));
  let best: { x: number; y: number } | null = null;
  let bestD = Number.POSITIVE_INFINITY;
  for (let i = -64; i <= 64; i++) {
    for (let j = -64; j <= 64; j++) {
      const d = i * i + j * j;
      if (d >= bestD) continue;
      const x = mid + i * STEP;
      const y = mid + j * STEP;
      if (around.every(([dx, dy]) => zoneAt(world.seed32, x + dx, y + dy, world.size) === zone)) {
        best = { x, y };
        bestD = d;
      }
    }
  }
  return best;
}

/** A forager in one zone: the pacing bot's policy (nearest food, away from clouds), kept inside the zone. */
interface Forager {
  world: World;
  zone: Zone;
  anchor: { x: number; y: number };
  target: { x: number; y: number } | null;
  flee: { x: number; y: number } | null;
  wander: number;
}

function forageTick(f: Forager, name: number): void {
  const { world } = f;
  const me = world.creatures[0];
  if (me === undefined) return;
  if (world.tick % RETARGET_TICKS === 0) {
    let bestD = Number.POSITIVE_INFINITY;
    f.target = null;
    f.flee = null;
    const clouds = plumesNear(world, me.x, me.y, SENSE);
    const margin = Math.sqrt(me.biomass) + PLUME_MARGIN;
    let fleeD = Number.POSITIVE_INFINITY;
    for (const p of clouds) {
      const d = Math.hypot(p.x - me.x, p.y - me.y) - p.radius;
      if (d < margin && d < fleeD) {
        fleeD = d;
        f.flee = { x: p.x, y: p.y };
      }
    }
    for (const item of foodForTier(world, me.x, me.y, SENSE, 0)) {
      const d = (item.x - me.x) ** 2 + (item.y - me.y) ** 2;
      if (d >= bestD) continue;
      if (clouds.some((p) => Math.hypot(p.x - item.x, p.y - item.y) < p.radius + margin)) continue;
      if (!inZone(world, f.zone, item.x, item.y)) continue;
      bestD = d;
      f.target = item;
    }
    if (f.target === null && world.tick % 180 === 0) {
      f.wander = (hashU32(world.tick, name) % 628) / 100;
    }
  }
  const adrift = !inZone(world, f.zone, me.x, me.y);
  const aim =
    f.flee !== null
      ? atan2(me.y - f.flee.y, me.x - f.flee.x)
      : adrift
        ? atan2(f.anchor.y - me.y, f.anchor.x - me.x)
        : f.target === null
          ? f.wander
          : atan2(f.target.y - me.y, f.target.x - me.x);
  step(world, { [me.id]: { steer: angleToSteer(aim), throttle: 15, dash: false } });
}

/** A hatchling in a fresh world at `zone`'s anchor, or null when the world has no such zone. */
function hatch(genome: Genome, seed: string, zone: Zone): Forager | null {
  const { stats, phys } = buildCreature(genome);
  const world = createWorld({ seed });
  const anchor = zoneAnchor(world, zone);
  if (anchor === null) return null;
  const born = hatchling(stats.maxBiomass);
  const me = spawnCreature(world, {
    id: 'bot',
    x: anchor.x,
    y: anchor.y,
    biomass: born.biomass,
    phys,
  });
  me.energy = born.energy;
  return { world, zone, anchor, target: null, flee: null, wander: 0 };
}

/** The zone a body forages best in: the most biomass (and energy, at the carrion exchange rate) gained in a 2-minute probe that leaves it at 90% health or more; twilight when none does. */
export function chooseZone(body: BalanceBody): Zone {
  let best: Zone = 'twilight';
  let bestGain = Number.NEGATIVE_INFINITY;
  for (const zone of ZONES) {
    const f = hatch(body.genome, `balance/${body.id}/probe`, zone);
    if (f === null) continue;
    const me = f.world.creatures[0] as World['creatures'][number];
    const [biomass, energy] = [me.biomass, me.energy];
    for (let t = 0; t < PROBE_MS / MS_PER_TICK && me.alive; t++) forageTick(f, body.id.length);
    // A zone that wears it down (UV, pressure) is no place to forage, however well it eats.
    const sound = me.alive && me.health >= 0.9 * maxHealth(me.biomass);
    const gain = sound
      ? me.biomass - biomass + (me.energy - energy) / RULES.encounter.reward.energyPerBiomass
      : Number.NEGATIVE_INFINITY;
    if (gain > bestGain) {
      bestGain = gain;
      best = zone;
    }
  }
  return best;
}

const zones = new Map<string, Zone>();
/** `chooseZone`, remembered per body. */
export function zoneOf(body: BalanceBody): Zone {
  let zone = zones.get(body.id);
  if (zone === undefined) {
    zone = chooseZone(body);
    zones.set(body.id, zone);
  }
  return zone;
}

export interface LifeOptions {
  /** The zone to forage in (default: `zoneOf(body)`). */
  zone?: Zone;
  /** Fights come as a Poisson process (default true). */
  fights?: boolean;
  /** Energy and health stay full, so nothing starves or dies of the water (default false). */
  keepEnergy?: boolean;
  /** The opponents, drawn by the fights (default: the full population). */
  opponents?: readonly BalanceBody[];
  /** Stop the life at this active ms (default: its lifespan). */
  capMs?: number;
}

export interface Mating {
  ms: number;
  before: { biomass: number; energy: number };
  after: { biomass: number; energy: number };
}

export interface LifeResult {
  /** The matings of the life. */
  score: number;
  zone: Zone;
  /** How the life ended: a cause of death, `old-age`, or `cap`. */
  end: DeathCause | 'cap';
  endMs: number;
  matureAtMs: number | null;
  matings: Mating[];
  fights: number;
  kills: number;
}

let everyone: BalanceBody[] | null = null;
function pooled(): BalanceBody[] {
  everyone = everyone ?? population();
  return everyone;
}
const fightersOf = new Map<string, Side['body']>();
/** The fighter view of a body: hand-built archetypes fly the tournament's behaviour, genesis bodies their own. */
function fighterFor(body: BalanceBody): Side['body'] {
  let f = fightersOf.get(body.id);
  if (f === undefined) {
    f =
      body.archetype === 'genesis'
        ? fighterOf(buildCreature(body.genome))
        : handBuiltBody(body.genome);
    fightersOf.set(body.id, f);
  }
  return f;
}

/** Plays `a`'s side of one fight against `opponent` and returns how it ended for `a`. */
export function fight(
  me: Side,
  opponent: Side,
  layout: number,
  swap: boolean,
): { end: FighterEnd; kill: boolean } {
  const d = duel(me, opponent, layout, swap);
  return { end: d.end[0], kill: d.score === 1 };
}

const dead = (o: Outcome): boolean => o === 'killed' || o === 'died';

/** One life of `body` from hatching to its end, on the real rules; deterministic in `seed`. */
export function balanceLife(
  body: BalanceBody,
  seed: string,
  options: LifeOptions = {},
): LifeResult {
  const zone = options.zone ?? zoneOf(body);
  const { stats } = buildCreature(body.genome);
  const lifespan = lifespanMs(stats.physiology.lifespan);
  const f = hatch(body.genome, `balance/${body.id}/${seed}`, zone);
  const result: LifeResult = {
    score: 0,
    zone,
    end: 'cap',
    endMs: 0,
    matureAtMs: null,
    matings: [],
    fights: 0,
    kills: 0,
  };
  if (f === null) {
    result.end = 'starved';
    return result;
  }
  const { world } = f;
  const me = world.creatures[0] as World['creatures'][number];
  const rng = createRng(seedFromString(`balance/${body.id}/${seed}`), 'fights');
  const pool = options.opponents ?? pooled();
  const nextGap = (): number => (-log(1 - rng.next()) * 3_600_000) / FIGHTS_PER_HOUR;
  let nextFight = options.fights === false ? Number.POSITIVE_INFINITY : nextGap();
  let cooldownUntil = 0;
  const capMs = Math.min(options.capMs ?? lifespan, lifespan);
  for (;;) {
    const ms = world.tick * MS_PER_TICK;
    result.endMs = ms;
    if (ms >= lifespan) {
      result.end = 'old-age';
      break;
    }
    if (!me.alive) {
      result.end = me.cause ?? 'starved';
      break;
    }
    if (ms >= capMs) break;
    if (ms >= RULES.life.elderAt * lifespan) me.elder = true;
    if (options.keepEnergy === true) {
      me.energy = maxEnergy(me.biomass);
      me.health = maxHealth(me.biomass);
    }
    if (ms >= nextFight) {
      nextFight += nextGap();
      const other = pool[Math.floor(rng.next() * pool.length)] as BalanceBody;
      const ratio = FIGHT_RATIO[0] + rng.next() * (FIGHT_RATIO[1] - FIGHT_RATIO[0]);
      const layout = Math.floor(rng.next() * 8);
      const swap = rng.next() < 0.5;
      const mine: Side = {
        body: fighterFor(body),
        biomass: me.biomass,
        energy: me.energy,
        health: me.health,
      };
      const theirs: Side = { body: fighterFor(other), biomass: me.biomass * ratio };
      const { end, kill } = fight(mine, theirs, layout, swap);
      result.fights++;
      if (kill) result.kills++;
      if (dead(end.outcome)) {
        applyLife(world, me.id, 'killed');
        continue;
      }
      me.biomass = end.biomass;
      me.energy = end.energy;
      me.health = end.health;
    }
    forageTick(f, body.id.length);
    const now = world.tick * MS_PER_TICK;
    if (
      result.matureAtMs === null &&
      lifeStage(now, lifespan, me.biomass, stats.maxBiomass) !== 'young'
    ) {
      result.matureAtMs = now;
    }
    const fed = me.energy >= RULES.mating.minEnergyShare * maxEnergy(me.biomass);
    if (result.matureAtMs !== null && now >= cooldownUntil && fed && me.alive) {
      const before = { biomass: me.biomass, energy: me.energy };
      applyLife(world, me.id, 'mate');
      result.matings.push({ ms: now, before, after: { biomass: me.biomass, energy: me.energy } });
      // A partner is always found, and always a new one: the pair doubling stays at zero.
      cooldownUntil = now + cooldownMs(0);
    }
  }
  result.score = result.matings.length;
  return result;
}

export interface BodyResult {
  id: string;
  archetype: string;
  /** The mean score over the body's lives. */
  score: number;
  zone: Zone;
  /** How many lives ended each way. */
  ends: Record<string, number>;
  fights: number;
  kills: number;
}

/** A body's score: the mean matings over `lives` lives. */
export function scoreBody(
  body: BalanceBody,
  lives = LIVES,
  options: Omit<LifeOptions, 'zone'> = {},
): BodyResult {
  const zone = zoneOf(body);
  const ends: Record<string, number> = {};
  let total = 0;
  let fights = 0;
  let kills = 0;
  for (let i = 0; i < lives; i++) {
    const life = balanceLife(body, `life-${i}`, { ...options, zone });
    total += life.score;
    fights += life.fights;
    kills += life.kills;
    ends[life.end] = (ends[life.end] ?? 0) + 1;
  }
  return {
    id: body.id,
    archetype: body.archetype,
    score: total / lives,
    zone,
    ends,
    fights,
    kills,
  };
}

/** Everything a run measures, as the report reads it. */
export interface BalanceRun {
  rules: number;
  variants: number;
  genesis: number;
  lives: number;
  bodies: BodyResult[];
}
