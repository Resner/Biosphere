import { describe, expect, it } from 'vitest';
import {
  classCheck,
  galleryGenome as gallery,
  isChain,
  passes,
  type TrunkCheck,
  trunkCheck,
} from '../../tests/body-outline';
import { heavyTest } from '../../tests/heavy';
import { findSpecimen } from '../../tools/specimen';
import { wildGenome } from '../lab/specimens';
import { createRng, seedFromString } from '../sim/prng';
import { RULES } from '../sim/rules';
import { decodeGenome, type Genome } from './codec';
import { bodyViolations, develop } from './develop';
import { express } from './express';
import { mutateGenome } from './inherit';
import { GENOME_BYTES } from './karyotype';
import { silhouetteOf } from './silhouette';

// One body, widest at the trunk (M6b T5, ADR 0037): a bilateral karyotype v2 chain draws a head
// narrower than its trunk, is widest in the front half of the trunk and narrows to the tail, and
// is still at least 2.5 times as long as wide (ADR 0031). The core collider stays the unit circle.

const rng = createRng(seedFromString('develop-trunk'), 'bytes');
const randomV2 = (): Genome =>
  decodeGenome(Uint8Array.from({ length: GENOME_BYTES }, () => rng.nextU32() & 0xff));

const ALL: TrunkCheck = { head: true, widest: true, narrows: true, aspect: true };

describe('one body, widest at the trunk (M6b T5)', () => {
  heavyTest('holds the outline rules for 95% of 10,000 random v2 chains', () => {
    let chains = 0;
    const fail = { head: 0, widest: 0, narrows: 0, aspect: 0, any: 0 };
    for (let i = 0; i < 10_000; i++) {
      const traits = express(randomV2());
      const plan = develop(traits);
      if (!isChain(plan)) continue;
      chains++;
      const c = trunkCheck(plan);
      for (const k of ['head', 'widest', 'narrows', 'aspect'] as const) if (!c[k]) fail[k]++;
      if (!passes(c)) fail.any++;
    }
    expect(chains).toBeGreaterThan(2_000);
    expect(fail.any / chains, JSON.stringify({ chains, ...fail })).toBeLessThanOrEqual(0.05);
  });

  it('holds them for the long gallery specimens', () => {
    for (const n of ['07', '09', '10', '11', '12', '18', '19', '26', '27', '30']) {
      const traits = express(gallery(n));
      const plan = develop(traits);
      expect(isChain(plan), n).toBe(true);
      expect(bodyViolations(plan), n).toEqual([]);
      expect(trunkCheck(plan), n).toEqual(ALL);
    }
  });

  it('keeps the core collider the unit circle inside the 2.5 bound', () => {
    const plan = develop(express(gallery('27')));
    expect(plan.colliders[0]).toEqual({ x: 0, y: 0, r: 1 });
    expect(RULES.body.maxReach).toBe(2.5);
    expect(RULES.develop.caps.bounds).toBe(2.5);
  });
});

describe('copepods, shrimps and worms read as their class (M6b T5)', () => {
  const CLASSES = ['copepod', 'shrimp', 'worm'] as const;

  it('draws the class specimens of tools/specimen.ts by their class rules', () => {
    for (const cls of CLASSES) {
      const found = findSpecimen(cls, 'specimen-test');
      expect(found, cls).not.toBeNull();
      const plan = develop(express(found?.genome as Genome));
      expect(silhouetteOf(plan), cls).toBe(cls);
      expect(classCheck(plan, cls), cls).toBe(true);
    }
    // And the gallery's stored class specimens (M6 T9).
    for (const [n, cls] of [
      ['26', 'copepod'],
      ['27', 'shrimp'],
      ['28', 'worm'],
    ] as const) {
      const plan = develop(express(gallery(n)));
      expect(silhouetteOf(plan), n).toBe(cls);
      expect(classCheck(plan, cls), n).toBe(true);
    }
  });

  heavyTest('draws 80% of random, wild and mutated bodies of each class by its rules', () => {
    // Random bytes are mostly rings and wings; the Lab's wild cells (a few v2 axes on a v1 body)
    // make most of the long bodies.
    const seen: Record<string, [number, number]> = {};
    for (let i = 0; i < 4_000; i++) {
      const random = randomV2();
      const wild = wildGenome(seedFromString(`trunk-wild-${i}`));
      for (const g of [
        random,
        wild,
        mutateGenome(random, seedFromString(`trunk-${i}`), { mutation: 4 }),
        mutateGenome(wild, seedFromString(`trunk-wild-${i}`), { mutation: 4 }),
      ]) {
        const plan = develop(express(g));
        const cls = silhouetteOf(plan);
        if (!(CLASSES as readonly string[]).includes(cls)) continue;
        const k = seen[cls] ?? [0, 0];
        seen[cls] = [k[0] + 1, k[1] + (classCheck(plan, cls) ? 1 : 0)];
      }
    }
    for (const cls of CLASSES) {
      const [n, ok] = seen[cls] ?? [0, 0];
      expect(n, cls).toBeGreaterThan(100);
      expect(ok / n, `${cls}: ${ok} of ${n}`).toBeGreaterThanOrEqual(0.8);
    }
  });
});
