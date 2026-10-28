import { describe, expect, it } from 'vitest';
import { ARCHETYPES, buildBytes } from '../../tests/archetypes';
import { decodeGenome, type Genome, genomeHash } from '../genome/codec';
import type { BodyPlan, PlanSegment } from '../genome/develop';
import { develop } from '../genome/develop';
import { express, type Traits } from '../genome/express';
import { genesisGenome } from '../genome/genesis';
import { GENOME_BYTES } from '../genome/karyotype';
import { starterGenome } from '../genome/starter';
import { createRng, seedFromString } from '../sim/prng';
import { RULES } from '../sim/rules';
import { type Anatomy, anatomyOf, CHAMBERS, chamberCount, type Organ } from './anatomy';

// Inner anatomy (M6 T12): render data only, placed inside the hull and seeded by the genome hash.

const rng = createRng(seedFromString('anatomy-tests'), 'bytes');
const randomGenome = (): Genome =>
  decodeGenome(Uint8Array.from({ length: GENOME_BYTES }, () => rng.nextU32() & 0xff));

interface Body {
  genome: Genome;
  traits: Traits;
  plan: BodyPlan;
  hash: string;
}
const bodyOf = (genome: Genome): Body => {
  const traits = express(genome);
  return { genome, traits, plan: develop(traits), hash: genomeHash(genome) };
};
const named: Genome[] = [
  starterGenome(),
  ...Object.values(ARCHETYPES),
  ...[
    new Uint8Array(GENOME_BYTES),
    new Uint8Array(GENOME_BYTES).fill(0xff),
    buildBytes({}, { segDrive1: 255, segDrive2: 255 }),
  ].map(decodeGenome),
  ...Array.from({ length: 20 }, (_, i) => genesisGenome(seedFromString(`anatomy-genesis-${i}`))),
];
const bodies = [...named, ...Array.from({ length: 1_500 }, randomGenome)].map(bodyOf);
const anatomies = new Map<Body, Anatomy>(
  bodies.map((b) => [b, anatomyOf(b.plan, b.traits, b.hash)]),
);
const anatomy = (b: Body): Anatomy => anatomies.get(b) as Anatomy;

const insideHull = (segments: readonly PlanSegment[], x: number, y: number): boolean =>
  segments.some((s) => {
    const [dx, dy] = [x - s.x, y - s.y];
    const u = (dx * Math.cos(s.angle) + dy * Math.sin(s.angle)) / s.rx;
    const v = (-dx * Math.sin(s.angle) + dy * Math.cos(s.angle)) / s.ry;
    return u * u + v * v <= 1 + 1e-9;
  });

/** The disc's centre and 32 points round its edge all lie inside the body's segments. */
const discInside = (plan: BodyPlan, x: number, y: number, r: number): boolean =>
  insideHull(plan.segments, x, y) &&
  Array.from({ length: 32 }, (_, k) => (2 * Math.PI * k) / 32).every((a) =>
    insideHull(plan.segments, x + r * Math.cos(a), y + r * Math.sin(a)),
  );

const chambers = (a: Anatomy): Organ[] =>
  a.organs.filter((o) => o.kind === 'chamber' || o.kind === 'droplet');

describe('anatomyOf', () => {
  it('places every organ and the whole gut inside the hull, for 1,500 random plans and the named ones', () => {
    let outside = 0;
    for (const b of bodies) {
      const a = anatomy(b);
      for (const o of a.organs) if (!discInside(b.plan, o.x, o.y, o.r)) outside++;
      for (const g of a.gut) if (!discInside(b.plan, g.x, g.y, g.r)) outside++;
      for (const v of [...a.organs, ...a.gut].flatMap((o) => [o.x, o.y, o.r])) {
        expect(Number.isFinite(v)).toBe(true);
      }
    }
    expect(outside).toBe(0);
  }, 60_000);

  it('runs a gut line along the curved spine, front to rear, with a stomach swelling', () => {
    for (const b of bodies.slice(0, 300)) {
      const { gut } = anatomy(b);
      expect(gut.length).toBeGreaterThanOrEqual(12);
      // Spine shares rise from the front to the rear.
      for (let i = 1; i < gut.length; i++) {
        expect((gut[i] as { s: number }).s).toBeGreaterThan((gut[i - 1] as { s: number }).s);
      }
      // Neighbouring points stay close: a line, not scattered dots.
      const span = Math.max(...b.plan.segments.map((s) => Math.max(s.rx, s.ry))) * 2;
      for (let i = 1; i < gut.length; i++) {
        const [p, q] = [gut[i - 1], gut[i]] as [Anatomy['gut'][0], Anatomy['gut'][0]];
        expect(Math.hypot(q.x - p.x, q.y - p.y)).toBeLessThanOrEqual(span);
      }
      // The stomach is the widest point, well inside both ends.
      const widest = gut.reduce((w, g, i) => (g.r > (gut[w]?.r ?? 0) ? i : w), 0);
      expect(widest).toBeGreaterThan(0);
      expect(widest).toBeLessThan(gut.length - 1);
    }
    // On a roomy body the stomach swells to well over twice the gut's ends.
    const starter = bodyOf(starterGenome());
    const roomy = anatomyOf(starter.plan, starter.traits, starter.hash).gut;
    const peak = Math.max(...roomy.map((g) => g.r));
    expect(peak).toBeGreaterThan(2 * (roomy[1] as { r: number }).r);
    expect(peak).toBeGreaterThan(2 * (roomy[roomy.length - 2] as { r: number }).r);
  });

  it('grows the count of fluid chambers and oil droplets with the genetic maximum size and the metabolism, 3 to 14', () => {
    const base = express(starterGenome());
    const withBody = (maxBiomass: number, metabolism: number): Traits => ({
      ...base,
      body: { ...base.body, maxBiomass },
      physiology: { ...base.physiology, metabolism },
    });
    const { base: least } = RULES.genes.size;
    const most = RULES.body.maxBiomassCeiling;
    const [slow, fast] = RULES.genes.range.physiology.metabolism as [number, number];
    expect(chamberCount(withBody(least, slow))).toBe(CHAMBERS.min);
    expect(chamberCount(withBody(most, fast))).toBe(CHAMBERS.max);
    expect([CHAMBERS.min, CHAMBERS.max]).toEqual([3, 14]);
    let last = 0;
    for (let k = 0; k <= 13; k++) {
      const n = chamberCount(withBody(least * 2 ** k, slow));
      expect(n).toBeGreaterThanOrEqual(last);
      last = n;
    }
    expect(last).toBeGreaterThan(CHAMBERS.min);
    expect(chamberCount(withBody(least * 64, fast))).toBeGreaterThan(
      chamberCount(withBody(least * 64, slow)),
    );
    // Every body gets exactly its count, mixed fluid chambers and oil droplets.
    let droplets = 0;
    let fluid = 0;
    for (const b of bodies) {
      const c = chambers(anatomy(b));
      expect(c.length).toBe(chamberCount(b.traits));
      droplets += c.filter((o) => o.kind === 'droplet').length;
      fluid += c.filter((o) => o.kind === 'chamber').length;
    }
    expect(droplets).toBeGreaterThan(0.15 * (droplets + fluid));
    expect(fluid).toBeGreaterThan(0.15 * (droplets + fluid));
  });

  it('keeps organs apart: no chamber, droplet, heart or pigment spot overlaps another', () => {
    for (const b of bodies) {
      const { organs } = anatomy(b);
      for (let i = 0; i < organs.length; i++) {
        for (let j = i + 1; j < organs.length; j++) {
          const [p, q] = [organs[i], organs[j]] as [Organ, Organ];
          expect(Math.hypot(p.x - q.x, p.y - q.y)).toBeGreaterThanOrEqual(p.r + q.r);
        }
      }
      for (const o of organs) expect(o.r).toBeGreaterThan(0);
    }
  });

  it('has one heart or ganglion spot and eye pigment on every body', () => {
    const kinds = new Set<string>();
    for (const b of bodies) {
      const { organs } = anatomy(b);
      const centre = organs.filter((o) => o.kind === 'heart' || o.kind === 'ganglion');
      expect(centre.length).toBe(1);
      kinds.add((centre[0] as Organ).kind);
      const pigment = organs.filter((o) => o.kind === 'pigment').length;
      // A pair behind a pair of eyes, or one median eye spot.
      expect(pigment).toBe(b.plan.eyes.count >= 2 ? 2 : 1);
    }
    expect(kinds).toEqual(new Set(['heart', 'ganglion']));
  });

  it('is deterministic per genome hash, and the hash seeds the positions', () => {
    for (const b of bodies.slice(0, 50)) {
      expect(anatomyOf(b.plan, b.traits, b.hash)).toEqual(anatomy(b));
    }
    const b = bodyOf(starterGenome());
    const own = anatomyOf(b.plan, b.traits, b.hash);
    const other = anatomyOf(b.plan, b.traits, `${b.hash}x`);
    expect(chambers(other).length).toBe(chambers(own).length);
    expect(chambers(other).map((o) => [o.x, o.y])).not.toEqual(
      chambers(own).map((o) => [o.x, o.y]),
    );
  });
});
