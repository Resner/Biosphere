import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createRng, seedFromString } from '../sim/prng';
import { decodeGenome, genomeToBase64url } from './codec';
import { type BodyPlan, develop, hashPlan } from './develop';
import {
  develop as developV5,
  estimateVertices as estimateVerticesV5,
  hashPlan as hashPlanV5,
} from './develop-v5';
import { express } from './express';
import { GENOME_BYTES_V1 } from './karyotype-v1';
import { bandSpeed, computeStats, hashStats, type Stats } from './stats';
import { computeStats as computeStatsV5, hashStats as hashStatsV5 } from './stats-v5';

/**
 * The v5 stats as rules 7 sees them: the same numbers, except that the top speed (thrust ÷ drag)
 * is eased into the speed band (ADR 0036). Nothing else about stats changed.
 */
const banded = (v5: Stats): Stats => ({ ...v5, thrust: v5.drag * bandSpeed(v5.thrust / v5.drag) });

const v1Bytes = (rng: ReturnType<typeof createRng>): Uint8Array =>
  Uint8Array.from({ length: GENOME_BYTES_V1 }, () => rng.nextU32() & 0xff);

describe('development and stats under rules v5 (frozen, ADR 0025)', () => {
  // The golden was written once, from the shared code before M6 T7 changed it; tests never write it.
  const golden = JSON.parse(
    readFileSync(new URL('./__golden__/develop-v5.json', import.meta.url), 'utf8'),
  ) as {
    rulesVersion: number;
    vectors: Record<string, { genome: string; planHash: string; statsHash: string }>;
  };

  it('keeps the v5 plan and stats hashes of 20 v1 genomes', () => {
    expect(golden.rulesVersion).toBe(5);
    const r = createRng(seedFromString('genome-develop-v5-golden'), 'bytes');
    const inputs: Record<string, Uint8Array> = {
      zero: new Uint8Array(GENOME_BYTES_V1),
      ones: new Uint8Array(GENOME_BYTES_V1).fill(0xff),
    };
    for (let i = 0; Object.keys(inputs).length < 20; i++) inputs[`random${i}`] = v1Bytes(r);
    const computed = Object.fromEntries(
      Object.entries(inputs).map(([name, bytes]) => {
        const g = decodeGenome(bytes);
        const traits = express(g);
        const plan = developV5(traits);
        return [
          name,
          {
            genome: genomeToBase64url(g),
            planHash: hashPlanV5(plan),
            statsHash: hashStatsV5(computeStatsV5(plan, traits)),
          },
        ];
      }),
    );
    expect(computed).toEqual(golden.vectors);
  });
});

/** Whether rules v5 would have dropped parts of `plan` for its mesh vertex budget (6,000, low 1,500). */
const overV5Budget = (plan: BodyPlan): boolean =>
  estimateVerticesV5(plan, 'full') > 6000 || estimateVerticesV5(plan, 'low') > 1500;

describe('development v2: v1 equivalence', () => {
  it('develops 10,000 random v1 genomes to the v5 plan and the v5 stats (speed banded)', () => {
    const rng = createRng(seedFromString('genome-develop-v1-equivalence'), 'bytes');
    let regained = 0;
    for (let i = 0; i < 10_000; i++) {
      const traits = express(decodeGenome(v1Bytes(rng)));
      const v5 = developV5(traits);
      const v6 = develop(traits);
      // Development v2 adds fields; with every new locus at 0 they hold the straight v1 body, bare.
      const expected: BodyPlan = {
        ...v5,
        appendages: v5.appendages.map((x) => ({
          ...x,
          webbing: 0,
          setae: 0,
          setaeLength: 0,
          bulb: 0,
          chela: 0,
          beads: 0,
        })),
        segments: v5.segments.map((s) => ({ x: s.x, y: 0, rx: s.rx, ry: s.ry, angle: 0 })),
        form: { turn: 0, mode: 0, radial: 0, slim: 1 },
        carapace: { count: 0, x: 0, y: 0, rx: 0, ry: 0, angle: 0, thickness: 0 },
        eyes: { count: 0, size: 0, stalk: 0, angle: 0, x: 0, y: 0 },
        membranes: [],
      };
      if (hashPlan(v6) !== hashPlan(expected)) {
        // The one exception (ADR 0025): v6 caps parts by count only, so a body whose parts v5 dropped
        // for its mesh vertex budget gets them back. Every other v1 body is the v5 body.
        if (v6.appendages.length > v5.appendages.length && overV5Budget(v6)) {
          regained++;
          continue;
        }
        expect(v6, `genome ${i}`).toEqual(expected);
      }
      const a = computeStats(v6, traits);
      const b = banded(computeStatsV5(v5, traits));
      if (hashStats(a) !== hashStatsV5(b)) expect(a, `genome ${i}`).toEqual(b);
    }
    // The exception is real but rare: most v1 bodies never reached the old budget.
    expect(regained).toBeGreaterThan(0);
    expect(regained).toBeLessThan(2_000);
  });

  it('gives v1 genomes new plan hashes but the v5 stats hashes (speed banded)', () => {
    const traits = express(decodeGenome(new Uint8Array(GENOME_BYTES_V1)));
    expect(hashStats(computeStats(develop(traits), traits))).toBe(
      hashStatsV5(banded(computeStatsV5(developV5(traits), traits))),
    );
    expect(hashPlan(develop(traits))).not.toBe(hashPlanV5(developV5(traits)));
  });
});
