// The combat tournament (M7 T5, ADR 0051): duels between bodies, every fighter flown by the
// autopilot through the real encounter simulation. It measures balance (a win matrix over the
// archetypes, genesis pairs), size (mirror duels at 1x, 1.5x and 2x biomass) and growth by kills
// (the winners' biomass per minute of fighting). `tools/combat-report.ts` prints it; the unit tests
// gate it.

import type { Genome } from '../src/genome/codec';
import { fighterOf } from '../src/genome/fighter';
import { genesisGenome } from '../src/genome/genesis';
import { buildCreature } from '../src/genome/stats';
import { createEncounter, results, stepFrame } from '../src/sim/encounter/encounter';
import { engageRange } from '../src/sim/encounter/reach';
import type { Behaviour, FighterStart, Outcome } from '../src/sim/encounter/types';
import { cos, sin } from '../src/sim/math';
import { createRng, hashU32, seedFromString } from '../src/sim/prng';
import { DT, RULES } from '../src/sim/rules';
import { ARCHETYPES } from './archetypes';
import { CALM, starterFighter, startOf } from './encounter-fixture';

/** Seconds per encounter frame. */
const SECONDS_PER_FRAME = RULES.encounter.frameTicks * DT;

/** The mirror duels' behaviour: stubborn (caution 0: it never flees, so a fight ends in a kill) and no dashing in (aggression below 0.5), so strikes alone show the size. */
const MIRROR_BEHAVIOUR: Behaviour = { ...CALM, aggression: 0.4, caution: 0 };

/** The archetype names, in the tournament's fixed order. */
export const ARCHETYPE_NAMES: readonly string[] = Object.keys(ARCHETYPES);
/** Start layouts per pairing; each is also run with the sides swapped. */
export const LAYOUTS = 8;
export const ARCHETYPE_BIOMASS = 400;
export const GENESIS_PAIRS = 64;
export const GENESIS_BIOMASS = 300;
/** Mirror duels: the genomes that fight a copy of themselves, and the biomass ratios. */
export const MIRROR_GENOMES = 8;
export const MIRROR_BIOMASS = 300;
const MIRROR_RATIOS = [1, 1.5, 2] as const;

export interface Side {
  body: Pick<FighterStart, 'phys' | 'combat' | 'behaviour'>;
  biomass: number;
  /** Its energy and health going in (default: a starter's, full for its biomass). */
  energy?: number;
  health?: number;
}

/** A fighter's condition at the end of a fight. */
export interface FighterEnd {
  outcome: Outcome;
  biomass: number;
  energy: number;
  health: number;
}

export interface Duel {
  /** The first side's score: 1 for a win, 0.5 for a draw, 0 for a loss. */
  score: number;
  seconds: number;
  /** One side was killed. */
  kill: boolean;
  /** Biomass each side gained during the fight (the kill's reward). */
  gain: [number, number];
  /** How each side left the fight. */
  end: [FighterEnd, FighterEnd];
}

/** The hand-built archetypes carry no behaviour genes: the armed or armoured ones fly the middling behaviour, the others this skittish one, so the matrix measures anatomy. */
const SKITTISH: Behaviour = { ...CALM, aggression: 0.2, caution: 0.9, reflex: 0.9 };
/** A hand-built genome's fighter: the middling behaviour when armed or armoured, else the skittish one. */
export const handBuiltBody = (genome: Genome): Side['body'] => {
  const body = fighterOf(buildCreature(genome));
  return {
    ...body,
    behaviour: body.combat.power > 1 || body.combat.armour > 0.5 ? CALM : SKITTISH,
  };
};
const archetypeBody = (name: string): Side['body'] =>
  handBuiltBody(ARCHETYPES[name] as NonNullable<(typeof ARCHETYPES)[string]>);
const genesisBody = (seed: string): Side['body'] =>
  fighterOf(buildCreature(genesisGenome(seedFromString(seed))));

const fighterAt = (side: Side, id: string, x: number, y: number, heading: number): FighterStart => {
  const start = starterFighter(id, x, y, heading, side.biomass);
  return {
    ...start,
    ...side.body,
    energy: side.energy ?? start.energy,
    health: side.health ?? start.health,
  };
};

/**
 * One fight on the autopilot. The layout (0 to LAYOUTS - 1) sets the bearing between the fighters
 * and how far each faces off their line, and `swap` puts the first side where the second would be.
 * They start inside the larger engage range, as a lock-in leaves them.
 */
export function duel(a: Side, b: Side, layout: number, swap = false): Duel {
  const rng = createRng(seedFromString(`combat-layout-${layout}`), 'layout');
  const bearing = rng.next() * 2 * Math.PI;
  const offsets = [(rng.next() - 0.5) * 1.6, (rng.next() - 0.5) * 1.6];
  const mid = RULES.world.size / 2;
  // The ids order the slots ('a' first); `swap` puts each side on the other end of the line.
  const flip = swap ? -1 : 1;
  const first = fighterAt(
    a,
    'a',
    mid,
    mid,
    bearing + (swap ? Math.PI : 0) + (offsets[0] as number),
  );
  const second = fighterAt(
    b,
    'b',
    mid,
    mid,
    bearing + (swap ? 0 : Math.PI) + (offsets[1] as number),
  );
  const enc = createEncounter(startOf(`combat-${layout}`, [first, second]));
  const [fa, fb] = enc.fighters;
  if (fa === undefined || fb === undefined) throw new Error('two fighters expected');
  const gap = 0.9 * Math.max(engageRange(fa, fb), engageRange(fb, fa)) + Math.sqrt(a.biomass) / 2;
  const total = gap + Math.sqrt(a.biomass) + Math.sqrt(b.biomass);
  const dx = cos(bearing) * total;
  const dy = sin(bearing) * total;
  fa.body.x = mid - (dx / 2) * flip;
  fa.body.y = mid - (dy / 2) * flip;
  fb.body.x = mid + (dx / 2) * flip;
  fb.body.y = mid + (dy / 2) * flip;
  while (!enc.over) stepFrame(enc, [null, null]);
  const [ra, rb] = results(enc);
  if (ra === undefined || rb === undefined) throw new Error('two results expected');
  const kill = ra.outcome === 'killed' || rb.outcome === 'killed';
  // A kill is the only win: an escape or a timeout leaves both standing, which is a draw.
  const score = ra.outcome === 'killed' ? 0 : rb.outcome === 'killed' ? 1 : 0.5;
  const endOf = (f: typeof fa, r: typeof ra): FighterEnd => ({
    outcome: r.outcome,
    biomass: f.body.biomass,
    energy: f.body.energy,
    health: f.body.health,
  });
  return {
    score,
    seconds: enc.frame * SECONDS_PER_FRAME,
    kill,
    gain: [fa.body.biomass - a.biomass, fb.body.biomass - b.biomass],
    end: [endOf(fa, ra), endOf(fb, rb)],
  };
}

/** The mean score of `a` over every layout, on both ends of the line. */
function match(a: Side, b: Side): number {
  let total = 0;
  for (let layout = 0; layout < LAYOUTS; layout++) {
    total += duel(a, b, layout, false).score + duel(a, b, layout, true).score;
  }
  return total / (2 * LAYOUTS);
}

export interface Tournament {
  archetypes: readonly string[];
  /** `matrix[i][j]` is the share archetype i takes against j (the diagonal is 0.5). */
  matrix: number[][];
  /** Each archetype's overall win rate against the other ten, draws as half. */
  rates: number[];
  mirror: { ratio: number; score: number }[];
  genesis: {
    medianSeconds: number;
    p10Seconds: number;
    p90Seconds: number;
    kills: number;
  };
  /** The winners' biomass per minute of fighting across the equal genesis duels. */
  growthPerMinute: number;
}

export const percentile = (sorted: readonly number[], p: number): number =>
  sorted.length === 0
    ? Number.NaN
    : (sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] as number);

/** Runs the whole tournament (deterministic: the same result every time). */
export function runTournament(): Tournament {
  const n = ARCHETYPE_NAMES.length;
  const sides = ARCHETYPE_NAMES.map(
    (name): Side => ({ body: archetypeBody(name), biomass: ARCHETYPE_BIOMASS }),
  );
  const matrix = Array.from({ length: n }, () => new Array<number>(n).fill(0.5));
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const score = match(sides[i] as Side, sides[j] as Side);
      (matrix[i] as number[])[j] = score;
      (matrix[j] as number[])[i] = 1 - score;
    }
  }
  const rates = matrix.map((row, i) => row.reduce((s, v, j) => (j === i ? s : s + v), 0) / (n - 1));

  // Mirror duels: a genome against a copy of itself that is as big or bigger. The same anatomy and
  // behaviour on both sides, so only the size differs.
  const bodies = Array.from({ length: MIRROR_GENOMES }, (_, g) => ({
    ...genesisBody(`combat-mirror-${g}`),
    behaviour: MIRROR_BEHAVIOUR,
  }));
  const mirror = MIRROR_RATIOS.map((ratio) => {
    let total = 0;
    for (const body of bodies) {
      const small: Side = { body, biomass: MIRROR_BIOMASS };
      total += match({ body, biomass: MIRROR_BIOMASS * ratio }, small);
    }
    return { ratio, score: total / MIRROR_GENOMES };
  });

  // Equal genesis duels: length and growth.
  const seconds: number[] = [];
  let kills = 0;
  let gain = 0;
  let winnerSeconds = 0;
  for (let i = 0; i < GENESIS_PAIRS; i++) {
    const a: Side = { body: genesisBody(`combat-genesis-${i}-a`), biomass: GENESIS_BIOMASS };
    const b: Side = { body: genesisBody(`combat-genesis-${i}-b`), biomass: GENESIS_BIOMASS };
    const d = duel(a, b, hashU32(i) % LAYOUTS, i % 2 === 1);
    seconds.push(d.seconds);
    if (!d.kill) continue;
    kills++;
    gain += d.score === 1 ? d.gain[0] : d.gain[1];
    winnerSeconds += d.seconds;
  }
  seconds.sort((x, y) => x - y);
  return {
    archetypes: ARCHETYPE_NAMES,
    matrix,
    rates,
    mirror,
    genesis: {
      medianSeconds: percentile(seconds, 0.5),
      p10Seconds: percentile(seconds, 0.1),
      p90Seconds: percentile(seconds, 0.9),
      kills,
    },
    growthPerMinute: winnerSeconds > 0 ? (gain / winnerSeconds) * 60 : 0,
  };
}
