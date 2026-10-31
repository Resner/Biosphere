import { describe, expect, it } from 'vitest';
import { galleryGenome as gallery, insideShare, trunkLegs } from '../../tests/body-outline';
import { createRng, seedFromString } from '../sim/prng';
import { RULES } from '../sim/rules';
import { decodeGenome, type Genome } from './codec';
import { type BodyPlan, develop } from './develop';
import { express } from './express';
import { genesisGenome } from './genesis';
import { GENOME_BYTES } from './karyotype';

// Thin, bristled legs that keep off the body (M6b T7): a karyotype v2 part is as thick as its
// root segment allows, lies mostly outside the body outline, and genesis bristles most of its
// non-whip slots, so bred trunks carry combs of setae (reference 02's shrimps and copepods).

const rng = createRng(seedFromString('develop-legs'), 'bytes');
const randomV2 = (): Genome =>
  decodeGenome(Uint8Array.from({ length: GENOME_BYTES }, () => rng.nextU32() & 0xff));
const median = (v: readonly number[]): number => [...v].sort((a, b) => a - b)[v.length >> 1] ?? 0;
/** A segment's drawn half-width (ADR 0039: not its girth, which a slimmed chain keeps wide). */
const halfWidth = (plan: BodyPlan, segment: number): number =>
  (plan.segments[segment] as BodyPlan['segments'][number]).ry;

const plans = Array.from({ length: 10_000 }, () => develop(express(randomV2())));

describe('thin legs (M6b T7)', () => {
  it('keeps every v2 part at most half its root segment drawn half-width', () => {
    const share = RULES.develop.part.root;
    expect(share).toBe(0.5);
    for (const plan of plans) {
      for (const a of plan.appendages) {
        expect(a.width).toBeLessThanOrEqual(share * halfWidth(plan, a.segment) + 1e-9);
      }
    }
  });

  it('draws the median trunk leg of 3+ segment bodies at most 0.12 core radii wide', () => {
    const widths = plans.flatMap((p) => trunkLegs(p).map((a) => a.width));
    expect(widths.length).toBeGreaterThan(10_000);
    expect(median(widths)).toBeLessThanOrEqual(0.12);
  });

  it('draws thin trunk legs on the gallery long bodies', () => {
    for (const n of ['26', '27', '30', '37', '38']) {
      const widths = trunkLegs(develop(express(gallery(n)))).map((a) => a.width);
      expect(widths.length, n).toBeGreaterThan(0);
      expect(median(widths), n).toBeLessThanOrEqual(0.12);
    }
  });
});

describe('legs keep off the body (M6b T7)', () => {
  it('lays 95% of the parts of 10,000 random v2 bodies at most 25% inside the outline', () => {
    let parts = 0;
    let over = 0;
    for (const plan of plans) {
      for (const a of plan.appendages) {
        parts++;
        if (insideShare(plan, a) > 0.25) over++;
      }
    }
    expect(parts).toBeGreaterThan(50_000);
    expect(over / parts, `${over} of ${parts}`).toBeLessThanOrEqual(0.05);
  });
});

describe('bristles are common at genesis (M6b T7)', () => {
  it('bristles at least half of the non-whip slots with a density of 0.3 or more', () => {
    let slots = 0;
    let bristled = 0;
    for (let i = 0; i < 5_000; i++) {
      const traits = express(genesisGenome(seedFromString(`legs-genesis-${i}`)));
      traits.modules.forEach((m, slot) => {
        if (!m.present || slot === 0) return; // slot M1 is the whip
        slots++;
        if (m.ext.setaeDensity >= 0.3 && m.ext.setaeLength > 0) bristled++;
      });
    }
    expect(slots).toBeGreaterThan(2_000);
    expect(bristled / slots).toBeGreaterThanOrEqual(0.5);
  });
});
