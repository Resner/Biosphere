// Six hand-built body plans for the stats tests (M3 T6): each is made through the karyotype and
// nothing else, then measured with the sim's own movement and feeding formulas.

import { decodeGenome, encodeGenome, type Genome } from '../src/genome/codec';
import { GENOME_BYTES, HAPLOTYPE_BYTES, LOCI, MODULE_PARAMS } from '../src/genome/karyotype';
import { buildCreature, statsAt } from '../src/genome/stats';
import { efficiency } from '../src/sim/food';
import { pow } from '../src/sim/math';
import { RULES } from '../src/sim/rules';

export type Params = Partial<Record<(typeof MODULE_PARAMS)[number], number>>;

export const locus = (id: string) => LOCI.find((l) => l.id === id) as (typeof LOCI)[number];

/** Bytes of a genome with the given modules present in both haplotypes and `set` loci written in both. */
export function buildBytes(
  modules: Record<string, Params> = {},
  set: Record<string, number> = {},
): Uint8Array {
  const bytes = new Uint8Array(GENOME_BYTES);
  for (let hap = 0; hap < 2; hap++) {
    const at = hap * HAPLOTYPE_BYTES;
    for (const [id, v] of Object.entries(set)) bytes[at + locus(id).offset] = v;
    for (const [id, params] of Object.entries(modules)) {
      const o = at + locus(id).offset;
      bytes[o] = 1;
      MODULE_PARAMS.forEach((name, k) => {
        bytes[o + 1 + k] = params[name] ?? 0;
      });
    }
  }
  return bytes;
}

/** A copy of `bytes` with `set` loci written in both haplotypes. */
export function withLoci(bytes: Uint8Array, set: Record<string, number>): Uint8Array {
  const out = bytes.slice();
  for (const [id, v] of Object.entries(set)) {
    out[locus(id).offset] = v;
    out[HAPLOTYPE_BYTES + locus(id).offset] = v;
  }
  return out;
}

/** `base` with these single-byte loci set per haplotype (`[first, second]`). */
export function withAlleles(base: Genome, set: Record<string, [number, number]>): Genome {
  const bytes = encodeGenome(base);
  for (const [id, [x, y]] of Object.entries(set)) {
    bytes[locus(id).offset] = x;
    bytes[HAPLOTYPE_BYTES + locus(id).offset] = y;
  }
  return decodeGenome(bytes);
}

export const buildGenome = (
  modules: Record<string, Params> = {},
  set: Record<string, number> = {},
) => decodeGenome(buildBytes(modules, set));

const MOUTH_MID = { mouthSize: 255, mouthType: 128, digestion: 128 };

export const ARCHETYPES: Record<string, Genome> = {
  // One long whip behind a small round cell.
  flagellate: buildGenome(
    { M1: { length: 200, thickness: 20, tipShape: 255, beat: 220, angle: 255, joints: 130 } },
    { ...MOUTH_MID, aspect: 128 },
  ),
  // A fringe of fine cilia: three pairs of short, fast hairs.
  ciliate: buildGenome(
    {
      M1: {
        length: 70,
        thickness: 25,
        tipShape: 230,
        beat: 255,
        angle: 150,
        pairs: 255,
        attachSpan: 255,
      },
    },
    { ...MOUTH_MID, aspect: 100, flexibility: 255 },
  ),
  // A long, tapering body driven by broad paddle fins.
  swimmer: buildGenome(
    {
      M1: {
        length: 200,
        thickness: 220,
        tipShape: 191,
        beat: 200,
        angle: 120,
        pairs: 255,
        attachSpan: 255,
        joints: 130,
      },
    },
    { ...MOUTH_MID, segDrive1: 140, segDrive2: 140, aspect: 255, taper: 200 },
  ),
  // Plates and spines over a stout paddle pair: slow, but toxin barely touches it.
  armoured: buildGenome(
    {
      M1: {
        length: 110,
        thickness: 90,
        tipShape: 191,
        beat: 200,
        angle: 150,
        pairs: 255,
        attachSpan: 255,
      },
    },
    {
      ...MOUTH_MID,
      plating1: 255,
      plating2: 255,
      spines: 255,
      membrane: 255,
      size1: 255,
      size2: 200,
    },
  ),
  // A wide filter mouth on a big, plain body, pulled along by whips.
  filter: buildGenome(
    {
      M1: { length: 200, thickness: 20, tipShape: 255, beat: 220, angle: 255, joints: 130 },
      M2: {
        length: 60,
        thickness: 60,
        tipShape: 230,
        beat: 140,
        angle: 200,
        pairs: 128,
        attachSpan: 255,
      },
    },
    { mouthSize: 255, mouthType: 0, digestion: 255, aspect: 255, size1: 255 },
  ),
  // A jaw up front and a hooked spike beside it.
  hunter: buildGenome(
    {
      M1: { length: 180, thickness: 35, tipShape: 255, beat: 220, angle: 255, joints: 130 },
      M5: { length: 190, thickness: 90, tipShape: 96, stiffness: 255, beat: 0, angle: 30 },
      M6: { length: 190, thickness: 90, tipShape: 96, stiffness: 255, beat: 0, angle: 330 },
    },
    { mouthSize: 255, mouthType: 255, digestion: 255, growth: 255 },
  ),
};

export const METRICS = [
  'speed',
  'acceleration',
  'turn',
  'efficiency',
  'detritus',
  'crystal',
  'armour',
  'weapon',
] as const;
export type Metric = (typeof METRICS)[number];

/** The body as measured at one biomass, with the sim's own movement, metabolism and feeding formulas. */
export function metricsAt(g: Genome, biomass: number): Record<Metric, number> {
  const c = buildCreature(g);
  const stats = statsAt(c.plan, c.traits, biomass);
  const phys = { thrust: stats.thrust, drag: stats.drag, turn: stats.turn, basal: stats.basal };
  const m = RULES.movement;
  const scale = biomass / 100;
  const acceleration = m.thrust * phys.thrust * pow(scale, m.thrustExp);
  const speed = acceleration / (m.drag * phys.drag);
  // Energy per second at full throttle, so distance per energy is speed ÷ that.
  const burn =
    RULES.metabolism.basal * phys.basal * pow(biomass, RULES.metabolism.basalExp) +
    RULES.metabolism.move * biomass;
  const mouth = stats.mouth;
  // A wide mouth takes more, and a jaw that reaches ahead sweeps more water in front of it.
  const reach =
    (mouth.radius + mouth.offset) * (0.5 + (0.5 * mouth.arc) / Math.PI) * mouth.digestion;
  return {
    speed,
    acceleration,
    turn: m.turn * phys.turn * pow(scale, m.turnExp),
    efficiency: speed / burn,
    detritus: reach * efficiency('detritus', mouth.type),
    crystal: reach * efficiency('crystal', mouth.type),
    armour: stats.combat.armour,
    weapon: stats.combat.power,
  };
}
