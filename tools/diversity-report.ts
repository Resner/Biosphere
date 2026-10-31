// Diversity report (M3 T9): samples genesis cells and bred descendants and prints Markdown about
// their bodies. `npm run report:diversity -- --genesis 2000 --bred 2000 --generations 6`.

import { type Genome, genomeHash } from '../src/genome/codec';
import { type Appendage, type BodyPlan, bodyViolations } from '../src/genome/develop';
import { genesisGenome } from '../src/genome/genesis';
import { breed } from '../src/genome/inherit';
import { RARITY_TIERS, rarityOfTraits } from '../src/genome/rarity';
import { SILHOUETTES, silhouetteOf } from '../src/genome/silhouette';
import { buildCreature, type Creature } from '../src/genome/stats';
import { anatomyOf } from '../src/render/anatomy';
import { estimateVertices } from '../src/render/creature-mesh';
import { glintPlanOf } from '../src/render/surface';
import { createRng, seedFromString } from '../src/sim/prng';
import { sizeTier } from '../src/sim/size';

export interface ReportOptions {
  genesis: number;
  bred: number;
  generations: number;
}

const DEFAULTS: ReportOptions = { genesis: 2000, bred: 2000, generations: 6 };

export function parseArgs(argv: readonly string[]): ReportOptions {
  const options = { ...DEFAULTS };
  for (let i = 0; i < argv.length; i += 2) {
    const key = (argv[i] ?? '').replace(/^--/, '');
    const value = Number(argv[i + 1]);
    if (!Object.hasOwn(DEFAULTS, key) || !Number.isInteger(value) || value < 1) {
      throw new Error(
        `Bad option ${argv[i]} ${argv[i + 1]}: use --genesis, --bred, --generations with whole numbers`,
      );
    }
    options[key as keyof ReportOptions] = value;
  }
  return options;
}

/** Descendants of the first genesis cells: each generation breeds random pairs of the one before. */
function breedGenerations(
  genesis: readonly Genome[],
  total: number,
  generations: number,
): Genome[] {
  const rng = createRng(seedFromString('diversity-report'), 'pairs');
  const perGeneration = Math.ceil(total / generations);
  let pool = genesis.slice(0, 256);
  const out: Genome[] = [];
  for (let gen = 1; gen <= generations && out.length < total; gen++) {
    const count = Math.min(perGeneration, total - out.length);
    pool = Array.from({ length: count }, (_, i) => {
      const a = pool[rng.int(0, pool.length - 1)] as Genome;
      const b = pool[rng.int(0, pool.length - 1)] as Genome;
      return breed(a, b, seedFromString(`diversity-${gen}-${i}`));
    });
    out.push(...pool);
  }
  return out;
}

const percentile = (sorted: readonly number[], p: number): number =>
  sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] as number;

function histogram(
  title: string,
  values: readonly (string | number)[],
  order: readonly (string | number)[] = [],
): string[] {
  const counts = new Map<string | number, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  const rank = (v: string | number): number =>
    order.includes(v) ? order.indexOf(v) : order.length;
  const rows = [...counts].sort(
    (a, b) => rank(a[0]) - rank(b[0]) || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0),
  );
  return [
    `## ${title}`,
    '',
    `| Value | Count | Share |`,
    '|---|---|---|',
    ...rows.map(([v, n]) => `| ${v} | ${n} | ${((100 * n) / values.length).toFixed(1)}% |`),
    '',
  ];
}

const appearanceKey = (c: Creature): string =>
  [
    Math.min(23, Math.floor(c.traits.colour.hue * 24)),
    c.traits.colour.pattern.join('+'),
    Math.min(2, Math.floor(c.traits.skin.membrane * 3)),
    c.traits.colour.albino,
    c.traits.skin.iridescence,
    c.traits.colour.luminescence,
  ].join('/');

/**
 * A body's trunk legs (M6b T7): the left-side gene parts behind the head of a bilateral body of
 * three or more segments.
 */
export const trunkLegsOf = (plan: BodyPlan): Appendage[] =>
  plan.form.radial === 0 && plan.segments.length >= 3
    ? plan.appendages.filter((a) => a.side === 1 && a.module >= 0 && a.segment >= 1)
    : [];

/** A body's legs on any body: its left-side gene parts but the whip's slot (M1) and the band. */
export const legsOf = (plan: BodyPlan): Appendage[] =>
  plan.appendages.filter((a) => a.side === 1 && a.module >= 1);

/** Some legs: how many, their median width, and the share with 6 or more bristles. */
export function legReport(legs: readonly Appendage[]): {
  legs: number;
  width: number;
  bristled: number;
} {
  const widths = legs.map((a) => a.width).sort((a, b) => a - b);
  return {
    legs: legs.length,
    width: widths.length > 0 ? percentile(widths, 0.5) : 0,
    bristled: legs.length > 0 ? legs.filter((a) => a.setae >= 6).length / legs.length : 0,
  };
}

const legLine = (name: string, legs: readonly Appendage[]): string => {
  const r = legReport(legs);
  return `- ${name}: ${r.legs}, median width ${r.width.toFixed(3)}, ${(100 * r.bristled).toFixed(1)}% with 6+ bristles`;
};

const stats = (values: readonly number[], unit: string, digits = 0): string => {
  const sorted = [...values].sort((a, b) => a - b);
  const f = (x: number): string => x.toFixed(digits);
  return `median ${f(percentile(sorted, 0.5))}${unit}, p99 ${f(percentile(sorted, 0.99))}${unit}, max ${f(sorted[sorted.length - 1] as number)}${unit}`;
};

export function diversityReport(options: ReportOptions): string {
  const genesis = Array.from({ length: options.genesis }, (_, i) =>
    genesisGenome(seedFromString(`diversity-genesis-${i}`)),
  );
  const bred = breedGenerations(genesis, options.bred, options.generations);
  const genomes = [...genesis, ...bred];

  const times: number[] = [];
  const creatures = genomes.map((g) => {
    const start = performance.now();
    const c = buildCreature(g);
    times.push(performance.now() - start);
    return c;
  });
  const invalid = creatures.filter((c) => bodyViolations(c.plan).length > 0).length;
  const rarities = creatures.map((c) => rarityOfTraits(c.traits));
  const silhouettes = creatures.map((c) => silhouetteOf(c.plan));
  const vertices = creatures.map((c) =>
    estimateVertices(c.plan, 'high', anatomyOf(c.plan, c.traits, c.hash), glintPlanOf(c)),
  );

  const lines = [
    '# Diversity report',
    '',
    '## Bodies',
    '',
    `- Genesis: ${genesis.length}`,
    `- Bred: ${bred.length} over ${options.generations} generations`,
    `- Valid bodies: ${creatures.length - invalid} of ${creatures.length} (${invalid} invalid)`,
    `- Distinct genomes: ${new Set(genomes.map(genomeHash)).size}`,
    '',
    ...histogram(
      'Segments',
      creatures.map((c) => c.plan.segments.length),
    ),
    ...histogram(
      'Appendages',
      creatures.map((c) => c.plan.appendages.length),
    ),
    ...histogram('Silhouettes', silhouettes, SILHOUETTES),
    ...histogram('Genesis silhouettes', silhouettes.slice(0, genesis.length), SILHOUETTES),
    ...histogram(
      'Size tiers',
      creatures.map((c) => `T${sizeTier(c.stats.maxBiomass)}`),
    ),
    ...histogram(
      'Rarity',
      rarities.map((r) => r.tier),
      RARITY_TIERS.map(([name]) => name),
    ),
    '## Looks',
    '',
    `- Distinct appearance keys: ${new Set(creatures.map(appearanceKey)).size}`,
    `- Rarity tiers seen: ${RARITY_TIERS.filter(([t]) => rarities.some((r) => r.tier === t))
      .map(([t]) => t)
      .join(', ')}`,
    '',
    '## Legs',
    '',
    ...(['Genesis', 'Bred'] as const).flatMap((sample) => {
      const group =
        sample === 'Genesis' ? creatures.slice(0, genesis.length) : creatures.slice(genesis.length);
      return [
        legLine(
          `${sample} parts but the whip`,
          group.flatMap((c) => legsOf(c.plan)),
        ),
        legLine(
          `${sample} trunk legs`,
          group.flatMap((c) => trunkLegsOf(c.plan)),
        ),
      ];
    }),
    '',
    '## Mesh vertices',
    '',
    `- High detail: ${stats(vertices, '')}`,
    '',
    '## Development time',
    '',
    `- Express, develop and stats per genome: ${stats(times, ' ms', 3)}`,
    '',
  ];
  return lines.join('\n');
}
