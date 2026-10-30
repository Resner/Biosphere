// Speed report (M6b T1, ADR 0036): how fast bodies swim, dash and turn, in world units, body radii
// and screen heights. `npm run report:speed -- --bodies 1000 --generations 6`.
// A test aid for the owner's "creatures are sometimes way too fast" (#183): the numbers behind the
// speed band, before and after.

import type { Genome } from '../src/genome/codec';
import { genesisGenome } from '../src/genome/genesis';
import { breed } from '../src/genome/inherit';
import { starterGenome } from '../src/genome/starter';
import { buildCreature } from '../src/genome/stats';
import { viewHalfHeight } from '../src/render/camera';
import type { PhysStats } from '../src/sim/body';
import { createRng, seedFromString } from '../src/sim/prng';
import { RULES, RULES_VERSION } from '../src/sim/rules';

export interface SpeedOptions {
  bodies: number;
  generations: number;
}

const DEFAULTS: SpeedOptions = { bodies: 1000, generations: 6 };

export function parseArgs(argv: readonly string[]): SpeedOptions {
  const options = { ...DEFAULTS };
  for (let i = 0; i < argv.length; i += 2) {
    const key = (argv[i] ?? '').replace(/^--/, '');
    const value = Number(argv[i + 1]);
    if (!Object.hasOwn(DEFAULTS, key) || !Number.isInteger(value) || value < 1) {
      throw new Error(
        `Bad option ${argv[i]} ${argv[i + 1]}: use --bodies, --generations with whole numbers`,
      );
    }
    options[key as keyof SpeedOptions] = value;
  }
  return options;
}

export interface Speeds {
  /** Terminal speed at full throttle, wu/s. */
  top: number;
  /** Body radii per second. */
  radii: number;
  /** Screen heights per second at the default zoom. */
  screens: number;
  /** The speed a dash adds, wu/s. */
  dash: number;
  /** Turning rate at full throttle, rad/s. */
  turn: number;
}

/** What the sim does with `phys` at `biomass` (DESIGN §4), and what the camera shows (DESIGN §3). */
export function speedsOf(phys: PhysStats, biomass: number, maxBiomass: number): Speeds {
  const m = RULES.movement;
  const scale = biomass / RULES.starter.biomass;
  const top = (m.thrust * phys.thrust * scale ** m.thrustExp) / (m.drag * phys.drag);
  const radius = Math.sqrt(biomass);
  const screen = 2 * viewHalfHeight(radius, Math.sqrt(maxBiomass));
  return {
    top,
    radii: top / radius,
    screens: top / screen,
    dash: m.dashSpeed * scale ** m.dashExp * Math.sqrt(phys.thrust / phys.drag),
    turn: m.turn * phys.turn * scale ** m.turnExp,
  };
}

const percentile = (sorted: readonly number[], p: number): number =>
  sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] as number;

const PERCENTILES: readonly [string, number][] = [
  ['p1', 0.01],
  ['p10', 0.1],
  ['median', 0.5],
  ['p90', 0.9],
  ['p99', 0.99],
  ['max', 1],
];

const MEASURES: readonly [string, keyof Speeds][] = [
  ['Top speed (wu/s)', 'top'],
  ['Top speed (body radii/s)', 'radii'],
  ['Top speed (screen heights/s)', 'screens'],
  ['Dash speed (wu/s)', 'dash'],
  ['Turning (rad/s)', 'turn'],
];

function table(title: string, speeds: readonly Speeds[]): string[] {
  const lines = [`## ${title}`, '', `| Measure | ${PERCENTILES.map(([n]) => n).join(' | ')} |`];
  lines.push(`|---|${PERCENTILES.map(() => '---:').join('|')}|`);
  for (const [name, key] of MEASURES) {
    const sorted = speeds.map((s) => s[key]).sort((a, b) => a - b);
    lines.push(
      `| ${name} | ${PERCENTILES.map(([, p]) => percentile(sorted, p).toFixed(2)).join(' | ')} |`,
    );
  }
  return [...lines, ''];
}

/** Descendants: each generation breeds random pairs of the one before, from the first genesis cells. */
function bred(genesis: readonly Genome[], total: number, generations: number): Genome[] {
  const rng = createRng(seedFromString('speed-report'), 'pairs');
  let pool = genesis.slice(0, 256);
  for (let gen = 1; gen <= generations; gen++) {
    pool = Array.from({ length: total }, (_, i) => {
      const a = pool[rng.int(0, pool.length - 1)] as Genome;
      const b = pool[rng.int(0, pool.length - 1)] as Genome;
      return breed(a, b, seedFromString(`speed-${gen}-${i}`));
    });
  }
  return pool;
}

export function speedReport(options: SpeedOptions = DEFAULTS): string {
  const genesis = Array.from({ length: options.bodies }, (_, i) =>
    genesisGenome(seedFromString(`speed-genesis-${i}`)),
  );
  const descendants = bred(genesis, options.bodies, options.generations);
  const hatch = RULES.mating.hatchlingMinBiomass;

  const sets = (genomes: readonly Genome[]): { hatch: Speeds[]; adult: Speeds[] } => {
    const out = { hatch: [] as Speeds[], adult: [] as Speeds[] };
    for (const g of genomes) {
      const c = buildCreature(g);
      const max = c.traits.body.maxBiomass;
      // The sim gives a body its adult `phys` at every size; only the scale terms change with biomass.
      out.hatch.push(speedsOf(c.phys, hatch, max));
      out.adult.push(speedsOf(c.phys, max, max));
    }
    return out;
  };

  const starter = buildCreature(starterGenome());
  const s = speedsOf(starter.phys, hatch, starter.traits.body.maxBiomass);
  const g = sets(genesis);
  const d = sets(descendants);
  return [
    '# Speed report',
    '',
    `Rules ${RULES_VERSION}. ${options.bodies} bodies per set.`,
    '',
    '## M1 starter at hatch',
    '',
    `Top speed ${s.top.toFixed(1)} wu/s, ${s.radii.toFixed(2)} radii/s, ${s.screens.toFixed(2)} screen heights/s; dash ${s.dash.toFixed(1)} wu/s; turning ${s.turn.toFixed(2)} rad/s.`,
    '',
    ...table(`Genesis bodies at hatch (biomass ${hatch})`, g.hatch),
    ...table('Genesis bodies as adults', g.adult),
    ...table(`Bred bodies at hatch (${options.generations} generations)`, d.hatch),
    ...table(`Bred bodies as adults (${options.generations} generations)`, d.adult),
  ].join('\n');
}
