import { readdirSync, readFileSync } from 'node:fs';
import { hexToBytes } from '@noble/hashes/utils.js';
import { describe, expect, it } from 'vitest';
import { buildBytes } from '../../tests/archetypes';
import { atan2, lerp, PI } from '../sim/math';
import { createRng, seedFromString } from '../sim/prng';
import { RULES } from '../sim/rules';
import { decodeGenome, type Genome } from './codec';
import {
  type Appendage,
  type BodyPlan,
  baseLength,
  bodyViolations,
  develop,
  dirOf,
  type PlanSegment,
  partLength,
  partReach,
  rootOf,
} from './develop';
import { express, type Traits } from './express';
import { mutateGenome } from './inherit';
import { GENOME_BYTES } from './karyotype';
import { longest, regionOf, spokeVary } from './organism';

// Body proportions (M6 T14b, ADR 0028): under karyotype v2 the trunk and tail carry the body instead
// of a short tail of tiny segments behind a unit core, parts keep their gene length by sweeping
// along the body, and a radial body's parts spread as an even ring.

const D = RULES.develop;
const DIR = new URL('../../tests/fixtures/gallery/', import.meta.url);

/** The 12 silhouette specimens of M6 T9 (files 21-32). */
const SPECIMENS: { file: string; genome: Genome }[] = readdirSync(DIR)
  .filter((f) => /^(2[1-9]|3[0-2])-specimen-/.test(f))
  .sort()
  .map((file) => {
    const hex = readFileSync(new URL(file, DIR), 'utf8')
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 0 && !l.startsWith('#'))
      .join('');
    return { file, genome: decodeGenome(hexToBytes(hex)) };
  });

const developed = (g: Genome): { traits: Traits; plan: BodyPlan } => {
  const traits = express(g);
  return { traits, plan: develop(traits) };
};

const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? (s[m] as number) : ((s[m - 1] as number) + (s[m] as number)) / 2;
};

/**
 * The length a part's genes ask for in the base range, before any repair (the band's is fixed), and
 * with `long`, the length the long range asks for (look pass 4), which may not all fit.
 */
function geneLength(traits: Traits, a: Appendage, long = false): number {
  if (a.module < 0) return D.band.length;
  const first = traits.modules.findIndex((m) => m.present);
  const scale = a.module === first ? traits.defects.partScale : 1;
  const mod = traits.modules[a.module] as Traits['modules'][number];
  return (long ? partLength : baseLength)(mod.params.length) * scale;
}

/**
 * The length a part's genes ask for as its region shapes it (M6c T3, ADR 0041): a radial spoke's
 * varied by its hash, a bilateral part's at most its role's limit (the longer head pair is the
 * long antennae, the other the short).
 */
function wanted(plan: BodyPlan, traits: Traits, a: Appendage, long = false): number {
  const gene = geneLength(traits, a, long);
  const left = plan.appendages.filter((b) => b.side === 1 && !b.fringe);
  if (plan.form.radial === 1) {
    const slot = left.findIndex((b) => b.angle === a.angle);
    return gene * spokeVary(slot, { ...a, length: geneLength(traits, a, true) });
  }
  const region = regionOf(a, plan);
  if (region === 'trunk') return Math.min(gene, longest('leg', plan.segments));
  if (region === 'rear') return Math.min(gene, longest('tail', plan.segments));
  const head = left.filter((b) => regionOf(b, plan) === 'head');
  const genes = head.map((b) => geneLength(traits, b, true));
  const first = genes.indexOf(Math.max(...genes));
  const role = head[first]?.angle === a.angle ? 'antenna' : 'feeler';
  return Math.min(gene, longest(role, plan.segments));
}

/**
 * What kind of part the acceptance names: tentacles (the spokes of a radial ring), antennae (head
 * parts of a bilateral body, ADR 0041) and wings (well webbed parts in front of the rear segment).
 * A tail part has no room behind the body to keep its length, so it is cut as before. Fringe is
 * cilia (ADR 0041), so it keeps no gene length.
 */
const kindOf = (
  plan: BodyPlan,
  a: Appendage,
): 'tentacle' | 'antenna' | 'wing' | 'other' | 'fringe' =>
  a.fringe
    ? 'fringe'
    : plan.form.radial === 1
      ? 'tentacle'
      : regionOf(a, plan) === 'head'
        ? 'antenna'
        : a.webbing >= 0.5 && a.segment < plan.segments.length - 1
          ? 'wing'
          : 'other';

const isNamedPart = (plan: BodyPlan, a: Appendage): boolean =>
  kindOf(plan, a) !== 'other' && kindOf(plan, a) !== 'fringe';

const rng = createRng(seedFromString('develop-proportions'), 'bytes');
const randomV2 = (): Genome =>
  decodeGenome(Uint8Array.from({ length: GENOME_BYTES }, () => rng.nextU32() & 0xff));

describe('proportions: the trunk carries the body (karyotype v2)', () => {
  it('reads all 12 silhouette specimens', () => {
    expect(SPECIMENS).toHaveLength(12);
  });

  it('gives the 12 specimens a median trunk segment of at least 0.35 core radii', () => {
    // ADR 0028 asked for half a core radius; look pass 4 (ADR 0031) slims long chains to 2.5 times
    // as long as wide, which no trunk that wide can be inside the bounds. The trunk still carries
    // the body: the v1 layout left it 0.1 to 0.2 core radii.
    const perBody: number[] = [];
    for (const { genome } of SPECIMENS) {
      const { plan } = developed(genome);
      expect(bodyViolations(plan)).toEqual([]);
      // The core stays the unit every collider and stat is measured in, though the head in front
      // of a chain may be smaller than it (ADR 0028).
      expect(plan.colliders[0]).toEqual({ x: 0, y: 0, r: 1 });
      expect(plan.segments[0]?.ry).toBeLessThanOrEqual(1);
      const trunk = plan.segments.slice(1).map((s) => s.ry);
      if (trunk.length > 0) perBody.push(median(trunk));
    }
    expect(perBody.length).toBeGreaterThanOrEqual(8);
    expect(median(perBody)).toBeGreaterThanOrEqual(0.35);
    // By laying the chain out differently, not by raising the body bound.
    expect(RULES.body.maxReach).toBe(2.5);
    expect(D.caps.bounds).toBe(2.5);
  });

  it('keeps an eight-segment v2 chain wide, inside the reach and overlapping', () => {
    const swim = { M1: { length: 150, thickness: 60, tipShape: 255, beat: 220, angle: 200 } };
    const p = develop(express(decodeGenome(buildBytes(swim, { segDrive1: 255, segDrive2: 255 }))));
    expect(p.segments).toHaveLength(8);
    expect(bodyViolations(p)).toEqual([]);
    for (const s of p.segments.slice(1)) expect(s.ry).toBeGreaterThan(0.3);
    const rear = p.segments[7] as PlanSegment;
    expect(-rear.x + Math.max(rear.rx, rear.ry)).toBeLessThanOrEqual(D.chain.reach + 1e-9);
  });
});

/**
 * A body's outline without its parts (look pass 4): its length along the spine, from the head's
 * front through every link to the tail's end, and its width, the widest segment's.
 */
function outlineOf(plan: BodyPlan): { length: number; width: number } {
  const s = plan.segments;
  let length = (s[0] as PlanSegment).rx + (s[s.length - 1] as PlanSegment).rx;
  for (let i = 1; i < s.length; i++) {
    const [a, b] = [s[i - 1], s[i]] as [PlanSegment, PlanSegment];
    length += Math.hypot(b.x - a.x, b.y - a.y);
  }
  return { length, width: 2 * Math.max(...s.map((x) => x.ry)) };
}

/** A bilateral chain of three or more segments: the bodies that must read long. */
const isLongChain = (plan: BodyPlan): boolean =>
  plan.form.radial === 0 && plan.segments.length >= 3;

describe('proportions v3: long bodies read by outline (look pass 4)', () => {
  const ratioOf = (plan: BodyPlan): number => {
    const o = outlineOf(plan);
    return o.length / o.width;
  };

  it('makes every bilateral v2 chain of 3+ segments at least 2.5 times as long as wide', () => {
    let long = 0;
    let curved = 0;
    for (let i = 0; i < 3_000; i++) {
      const random = randomV2();
      for (const g of [
        random,
        mutateGenome(random, seedFromString(`long-${i}`), { mutation: 4 }),
      ]) {
        const { traits, plan } = developed(g);
        if (!isLongChain(plan)) continue;
        long++;
        expect(bodyViolations(plan)).toEqual([]);
        // A curled chain fits the bounds along its curve (M6b T6): it is measured along its own
        // spine, and curling keeps its girth (its width before slimming), except that a curled
        // (not coiled) chain of 5 or more free segments is a worm and evener, and a coil is a
        // chambered spiral of its own.
        const straight = develop({ ...traits, shape: { ...traits.shape, curve: 0 } });
        if (plan.form.turn > 0) {
          curved++;
          const worm =
            plan.segments.length >= D.chain.trunk.worm.from &&
            plan.carapace.count < 2 &&
            traits.shape.curve >= D.chain.trunk.worm.curl &&
            plan.form.mode !== 2;
          const girth = (p: BodyPlan) => p.segments.map((s) => s.ry / p.form.slim);
          if (worm) {
            const [w, s] = [plan.segments, straight.segments].map((x) =>
              Math.max(...x.map((q) => q.ry)),
            ) as [number, number];
            expect(w).toBeLessThan(s);
          } else if (plan.form.mode !== 2) {
            const [a, b] = [girth(plan), girth(straight)];
            expect(a.length).toBe(b.length);
            for (const [k, x] of a.entries()) expect(x).toBeCloseTo(b[k] as number, 9);
          }
          const curl = ratioOf(plan);
          if (!(curl >= D.chain.aspect - 1e-9)) expect.fail(`genome ${i}: ${curl} long per wide`);
        }
        const ratio = ratioOf(straight);
        if (!(ratio >= D.chain.aspect - 1e-9)) expect.fail(`genome ${i}: ${ratio} long per wide`);
      }
    }
    expect(long).toBeGreaterThan(1_000);
    expect(curved).toBeGreaterThan(200);
    expect(D.chain.aspect).toBeGreaterThanOrEqual(2.5);
  });

  it('gives the segmented specimens long outlines', () => {
    let long = 0;
    for (const { file, genome } of SPECIMENS) {
      const { traits, plan } = developed(genome);
      if (!isLongChain(plan)) continue;
      long++;
      const straight = develop({ ...traits, shape: { ...traits.shape, curve: 0 } });
      expect(ratioOf(straight), file).toBeGreaterThanOrEqual(2.5 - 1e-9);
    }
    // Copepod, shrimp, worm, coil, crab, winged and fan tail.
    expect(long).toBeGreaterThanOrEqual(7);
  });
});

describe('proportions: parts keep their gene length', () => {
  it('gives every antenna, tentacle and wing of the 12 specimens its gene length', () => {
    let named = 0;
    for (const { file, genome } of SPECIMENS) {
      const { traits, plan } = developed(genome);
      for (const a of plan.appendages) {
        if (!isNamedPart(plan, a)) continue;
        named++;
        // At least the v1 gene length, and at most what the long range asks for, as the part's
        // region shapes them.
        expect(a.length, `${file} module ${a.module}`).toBeGreaterThanOrEqual(
          wanted(plan, traits, a) - 1e-9,
        );
        expect(a.length).toBeLessThanOrEqual(wanted(plan, traits, a, true) + 1e-9);
      }
    }
    expect(named).toBeGreaterThan(30);
  });

  it('keeps the gene length of most parts over 3,000 genomes', () => {
    // The bounds hold 2.5 core radii around a unit core, so not every long part can fit: a long
    // part far back on the body has nowhere to go.
    const kept: Record<string, [number, number]> = {};
    const count = (key: string, ok: boolean) => {
      const k = kept[key] ?? [0, 0];
      kept[key] = [k[0] + 1, k[1] + (ok ? 1 : 0)];
    };
    for (let i = 0; i < 3_000; i++) {
      const traits = express(randomV2());
      const plan = develop(traits);
      for (const a of plan.appendages) {
        const kind = kindOf(plan, a);
        if (kind === 'fringe') continue;
        const ok = a.length >= wanted(plan, traits, a) - 1e-9;
        count(`v2 ${kind}`, ok);
        count('v2 all', ok);
      }
    }
    const share = (key: string): number => {
      const [n, ok] = kept[key] as [number, number];
      return ok / n;
    };
    expect(share('v2 antenna')).toBeGreaterThanOrEqual(0.95);
    expect(share('v2 tentacle')).toBeGreaterThanOrEqual(0.9);
    expect(share('v2 wing')).toBeGreaterThanOrEqual(0.7);
    expect(share('v2 all')).toBeGreaterThanOrEqual(0.75);
    // A leg the bounds would sweep over the trunk turns out and shortens instead (M6b T7, ADR
    // 0039), so legs keep their gene length a little less often than antennae and wings do.
    expect(share('v2 other'), 'other').toBeGreaterThanOrEqual(0.45);
  });

  it('sweeps a part that would leave the bounds along the body instead of cutting it', () => {
    // A long forked antenna on a cell: pointing out it would end past the bounds, so it lies back.
    const p = develop(
      express(
        decodeGenome(
          buildBytes(
            {
              M1: {
                length: 255,
                thickness: 40,
                tipShape: 255,
                beat: 220,
                angle: 32,
                branching: 255,
                curvature: 128,
              },
              M2: { length: 150, thickness: 60, tipShape: 255, beat: 220, angle: 200 },
            },
            {},
          ),
        ),
      ),
    );
    expect(bodyViolations(p)).toEqual([]);
    const antenna = p.appendages.find((a) => a.module === 0) as Appendage;
    expect(antenna.segment).toBe(0);
    expect(antenna.branches).toBe(2);
    expect(antenna.length).toBeGreaterThanOrEqual(D.length[1] as number);
    const free = antenna.angle + D.sweep * (PI - antenna.angle);
    expect(antenna.dir).toBeGreaterThan(free);
    expect(antenna.dir).toBeLessThanOrEqual(PI);
    // Pointing where it would grow freely, it would not fit.
    const s = p.segments[0] as PlanSegment;
    expect(partReach(s, { ...antenna, dir: free }, 1)).toBeGreaterThan(D.caps.bounds);
  });
});

describe('proportions: longer parts sweep round the body (look pass 4)', () => {
  it('maps the length gene past 1.5 core radii at its long end, unchanged below the knee', () => {
    expect(baseLength(255)).toBeCloseTo(D.length[1] as number, 12);
    expect(partLength(255)).toBeGreaterThanOrEqual(2.2);
    for (let b = 0; b < 256; b++) {
      expect(baseLength(b)).toBeCloseTo(
        lerp(D.length[0] as number, D.length[1] as number, b / 255),
        12,
      );
      expect(partLength(b)).toBeGreaterThanOrEqual(baseLength(b));
      if (b > 0) expect(partLength(b)).toBeGreaterThan(partLength(b - 1));
    }
    // Most genes keep their base length: only the long end reaches further.
    expect(partLength(128)).toBe(baseLength(128));
  });

  it('lets antennae and tentacles reach past 1.5 core radii, inside the bounds', () => {
    const long = { antenna: 0, tentacle: 0 };
    for (let i = 0; i < 3_000; i++) {
      const { plan } = developed(randomV2());
      let any = false;
      for (const a of plan.appendages) {
        const kind = kindOf(plan, a);
        if ((kind === 'antenna' || kind === 'tentacle') && a.length > 1.5 + 1e-9) {
          long[kind]++;
          any = true;
        }
      }
      if (any) expect(bodyViolations(plan)).toEqual([]);
    }
    // One long antenna pair per body at most (ADR 0041), where any front part counted before.
    expect(long.antenna).toBeGreaterThan(150);
    expect(long.tentacle).toBeGreaterThan(50);
  });

  it('sweeps a long antenna round the body instead of cutting it', () => {
    const p = develop(
      express(
        decodeGenome(
          buildBytes(
            {
              M1: { length: 255, thickness: 30, tipShape: 255, beat: 30, angle: 40, curvature: 90 },
              M2: { length: 150, thickness: 60, tipShape: 255, beat: 220, angle: 200 },
            },
            { segDrive1: 160, segDrive2: 160 },
          ),
        ),
      ),
    );
    expect(bodyViolations(p)).toEqual([]);
    const antenna = p.appendages.find((a) => a.module === 0) as Appendage;
    expect(antenna.segment).toBe(0);
    expect(antenna.length).toBeCloseTo(partLength(255), 9);
    // It lies back along the body: its tip is behind the head.
    const s = p.segments[0] as PlanSegment;
    const root = rootOf(s, antenna.angle, 1);
    const d = dirOf(s, antenna);
    expect(root.x + antenna.length * d.x).toBeLessThan(0);
  });
});

describe('proportions: radial bodies ring their parts', () => {
  /** Each ring part's tip, as a polar angle round the core centre (left side, 0 forward). */
  const tipAngles = (plan: BodyPlan): number[] =>
    plan.appendages
      .filter((a) => a.side === 1)
      .map((a) => {
        const s = plan.segments[a.segment] as PlanSegment;
        const root = rootOf(s, a.angle, 1);
        const d = dirOf(s, a);
        return atan2(root.y + a.length * d.y, root.x + a.length * d.x);
      });

  it('spreads the ring of every radial specimen round the body, never bunched behind it', () => {
    let rings = 0;
    for (const { file, genome } of SPECIMENS) {
      const { plan } = developed(genome);
      if (plan.form.radial !== 1) continue;
      rings++;
      const left = plan.appendages.filter((a) => a.side === 1);
      // Even root angles, and growth directions in ring order: no part crosses its neighbour.
      for (let k = 1; k < left.length; k++) {
        expect((left[k] as Appendage).dir, file).toBeGreaterThanOrEqual(
          (left[k - 1] as Appendage).dir - 1e-9,
        );
      }
      // The tips cover most of the half circle on their side.
      const tips = tipAngles(plan);
      expect(Math.max(...tips) - Math.min(...tips), file).toBeGreaterThan(PI / 2);
    }
    expect(rings).toBeGreaterThanOrEqual(2);
  });

  it('keeps radial rings in order over 3,000 mutated genomes', () => {
    // Validity over 10,000 random and mutated genomes is develop.test.ts's; this checks the order.
    let rings = 0;
    for (let i = 0; i < 3_000; i++) {
      const g = mutateGenome(randomV2(), seedFromString(`ring-${i}`), { mutation: 4 });
      const { plan } = developed(g);
      if (plan.form.radial !== 1) continue;
      rings++;
      const left = plan.appendages.filter((a) => a.side === 1);
      for (let k = 1; k < left.length; k++) {
        if ((left[k] as Appendage).dir < (left[k - 1] as Appendage).dir - 1e-9) {
          expect.fail(`genome ${i}: ring parts ${k - 1} and ${k} cross`);
        }
      }
    }
    expect(rings).toBeGreaterThan(300);
  });
});
