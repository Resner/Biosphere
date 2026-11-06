import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  bundleOf,
  indexOf,
  lineageHistory,
  PLAYERS,
  retail,
  rewrite,
  type Step,
} from '../../tests/lineage-fixture';
import { type Genome, genomeFromBase64url } from '../genome/codec';
import { buildCreature } from '../genome/stats';
import { ownRefusal } from '../sim/mating';
import {
  CLOCK_SLACK_MS,
  type Condition,
  cooldownOf,
  growthReach,
  LIVE_SCALES,
  lifespanOf,
  matureAtOf,
  matureBiomassOf,
  paidFor,
  restoreMinOf,
  startOf,
  vitalsCap,
} from './gates';
import type { ProofBundle } from './proof';
import type { LedgerRecord, StoredRecord } from './record';
import { PROBLEM_TEXT, type Problem, problemText, verifyLineage } from './verify';

// M9 T5: the gates family of the lineage verifier (the life clock, matings, growth, freezes and
// returns) against the golden bundle of the fixture's honest history, with A1 as its subject. Each
// tamper is re-signed with the fixture's key, so only the gate under test can catch it, and each
// limit is also met exactly, which passes: the gates are inclusive, as the authority's are.

const GOLDEN = new URL('./__golden__/lineage.json', import.meta.url);
const history = lineageHistory();
const { A0, A1, B1 } = history.ids;

const golden = (): ProofBundle => JSON.parse(readFileSync(GOLDEN, 'utf8')) as ProofBundle;
const gatesOf = (b: ProofBundle): Problem[] =>
  verifyLineage(b).problems.filter((p) => p.family === 'gates');
const at = (creature: string, seq: number, code: string): Problem => ({
  creature,
  seq,
  family: 'gates',
  code,
});

const genomeOf = (b: ProofBundle, id: string): Genome => {
  const text = b.creatures.find((c) => c.id === id)?.genome;
  const genome = text ? genomeFromBase64url(text) : null;
  if (!genome) throw new Error(`no genome for ${id}`);
  return genome;
};

const recordOf = (b: ProofBundle, creature: string, seq: number): LedgerRecord =>
  (b.records[indexOf(b, creature, seq)] as StoredRecord).record;
const bodyOf = (b: ProofBundle, creature: string, seq: number) => recordOf(b, creature, seq).body;
const num = (v: unknown): number => v as number;

describe('the gates family on the honest history', () => {
  it('finds nothing in the golden, nor in the whole of A0 and B1', () => {
    expect(gatesOf(golden())).toEqual([]);
    expect(gatesOf(bundleOf(history, A0))).toEqual([]);
    expect(gatesOf(bundleOf(history, B1))).toEqual([]);
  });

  it('verifies the history built under test scales, which fails at full scale', () => {
    const scaled = lineageHistory({ lifespan: 0.05, mating: 0.01 });
    const b = bundleOf(scaled, scaled.ids.A1);
    const report = verifyLineage(b);
    expect(report.problems).toEqual([]);
    expect(report.scaled).toBe(true);
    b.world.scales = { ...LIVE_SCALES };
    expect(gatesOf(b)).toContainEqual(at(scaled.ids.A0, 3, 'mature-time'));
  });
});

describe('the clock', () => {
  it('names a clock that goes back', () => {
    const b = golden();
    rewrite(b, A1, 5, (r) => {
      r.body.activeMs = num(r.body.activeMs) - 1;
    });
    expect(gatesOf(b)).toEqual([at(A1, 5, 'clock-back')]);
  });

  it('names a rise of the t difference + 2,001 ms, and passes + 2,000', () => {
    const rise = (extra: number) => {
      const b = golden();
      const mc = recordOf(b, A0, 3);
      const cp = recordOf(b, A0, 2);
      // The honest rise is exactly the wall time between them.
      expect(num(mc.body.activeMs) - num(cp.body.activeMs)).toBe(mc.t - cp.t);
      for (const seq of [3, 4]) {
        rewrite(b, A0, seq, (r) => {
          r.body.activeMs = num(r.body.activeMs) + extra;
          r.body.cooldownUntilMs = num(r.body.cooldownUntilMs) + extra;
        });
      }
      return gatesOf(b);
    };
    expect(rise(CLOCK_SLACK_MS + 1)).toEqual([at(A0, 3, 'clock-fast')]);
    expect(rise(CLOCK_SLACK_MS)).toEqual([]);
  });

  /** A1's last checkpoint moved to `activeMs`, its wall time with it, and its toxin death after it. */
  const lateCheckpoint = (activeMs: number) => {
    const b = golden();
    const cp = recordOf(b, A1, 4);
    const t = cp.t + (activeMs - num(cp.body.activeMs));
    rewrite(b, A1, 4, (r) => {
      r.t = t;
      r.body.activeMs = activeMs;
    });
    rewrite(b, A1, 5, (r) => {
      r.t = t;
      r.body.activeMs = activeMs;
    });
    return gatesOf(b);
  };

  it('names a checkpoint after the lifespan, and passes one at it', () => {
    const lifespan = lifespanOf(genomeOf(golden(), A1), LIVE_SCALES);
    expect(lateCheckpoint(lifespan + 1)).toEqual([at(A1, 4, 'after-lifespan')]);
    expect(lateCheckpoint(lifespan)).toEqual([]);
  });

  /** A1's toxin death made an old-age one at `activeMs`, its wall time moved with it. */
  const oldAge = (activeMs: number) => {
    const b = golden();
    const cp = recordOf(b, A1, 4);
    rewrite(b, A1, 5, (r) => {
      r.t = cp.t + (activeMs - num(cp.body.activeMs));
      r.body.cause = 'old-age';
      r.body.activeMs = activeMs;
    });
    return gatesOf(b);
  };

  it('names an old-age death 1 ms early, and passes one at the lifespan', () => {
    const lifespan = lifespanOf(genomeOf(golden(), A1), LIVE_SCALES);
    expect(oldAge(lifespan - 1)).toEqual([at(A1, 5, 'old-age-early')]);
    expect(oldAge(lifespan)).toEqual([]);
  });

  it("names a pending child's clock that moved before its promotion", () => {
    const b = bundleOf(history, B1);
    rewrite(b, B1, 1, (r) => {
      r.body.activeMs = 1;
    });
    expect(gatesOf(b)).toEqual([at(B1, 1, 'pending-clock')]);
  });
});

describe('matings', () => {
  const b0 = golden();
  const g = genomeOf(b0, A0);
  const genesis = recordOf(b0, A0, 0);
  const mateBody = bodyOf(b0, A0, 3);
  const matureAt = matureAtOf(g, LIVE_SCALES);
  const matureSize = matureBiomassOf(g, LIVE_SCALES);
  const adult = Math.floor(buildCreature(g).phys.maxBiomass * 100);
  const cooldown = cooldownOf(0, LIVE_SCALES);
  const start = startOf('genesis', g).biomass;

  /** A full condition of `biomass`. */
  const full = (biomass: number): Condition => ({ biomass, ...vitalsCap(biomass) });
  /** A `mate-commit` at `activeMs` paid from `before`, its cooldown `length`. */
  const mating = (activeMs: number, before: Condition, length = cooldown): Step => ({
    kind: 'mate-commit',
    t: genesis.t + activeMs,
    body: {
      ...mateBody,
      activeMs,
      ...paidFor(before),
      cooldownUntilMs: activeMs + length,
      biomassBefore: before.biomass,
      energyBefore: before.energy,
      healthBefore: before.health,
    },
  });
  /** A0 mating straight from its genesis: its records after the genesis replaced by `steps`. */
  const onA0 = (...steps: Step[]) => {
    const b = golden();
    retail(b, A0, 1, steps);
    return gatesOf(b);
  };
  const grown = Math.min(adult, growthReach(start, g, matureAt));

  it('starts from a mating the gates take: mature, grown and fed', () => {
    expect(grown).toBeGreaterThan(matureSize);
    expect(onA0(mating(matureAt, full(grown)))).toEqual([]);
  });

  it('names a mating 1 ms before maturity', () => {
    expect(onA0(mating(matureAt - 1, full(grown)))).toEqual([at(A0, 1, 'mature-time')]);
  });

  it('names a mating 1 hundredth under the maturity size, and passes one at it', () => {
    expect(onA0(mating(matureAt, full(matureSize - 1)))).toEqual([at(A0, 1, 'mature-size')]);
    expect(onA0(mating(matureAt, full(matureSize)))).toEqual([]);
  });

  it('names a mating 1 hundredth under half energy, at the bound the authority refuses below', () => {
    const fed = (energy: number) =>
      ownRefusal({
        creature: A0,
        owner: PLAYERS.A,
        active: true,
        activeMs: matureAt,
        matureAtMs: matureAt,
        cooldownUntilMs: 0,
        biomass: grown / 100,
        energy: energy / 100,
        hasPending: false,
        inFlight: false,
        locked: false,
      }) === null;
    let least = Math.ceil(vitalsCap(grown).energy / 2);
    while (!fed(least)) least++;
    while (fed(least - 1)) least--;
    const fedWith = (energy: number) => ({ ...full(grown), energy });
    expect(onA0(mating(matureAt, fedWith(least - 1)))).toEqual([at(A0, 1, 'mate-energy')]);
    expect(onA0(mating(matureAt, fedWith(least)))).toEqual([]);
  });

  it('names a mating 1 ms inside the cooldown, and passes one as it ends', () => {
    const first = mating(matureAt, full(grown));
    const again = (activeMs: number) => {
      const after = num(first.body.biomass);
      const biomass = Math.min(adult, growthReach(after, g, activeMs - matureAt));
      return mating(activeMs, full(biomass));
    };
    expect(onA0(first, again(matureAt + cooldown - 1))).toEqual([at(A0, 2, 'cooldown')]);
    expect(onA0(first, again(matureAt + cooldown))).toEqual([]);
  });

  it('names a cooldown 1 ms shorter than the base, and passes every doubling', () => {
    expect(onA0(mating(matureAt, full(grown), cooldown - 1))).toEqual([
      at(A0, 1, 'cooldown-length'),
    ]);
    for (let k = 0; k <= 5; k++) {
      expect(onA0(mating(matureAt, full(grown), cooldownOf(k, LIVE_SCALES)))).toEqual([]);
    }
    expect(onA0(mating(matureAt, full(grown), cooldownOf(5, LIVE_SCALES) + 1))).toEqual([
      at(A0, 1, 'cooldown-length'),
    ]);
  });

  it('names a cost 1 hundredth off', () => {
    const b = golden();
    rewrite(b, A0, 3, (r) => {
      r.body.biomass = num(r.body.biomass) - 1;
    });
    expect(gatesOf(b)).toEqual([at(A0, 3, 'cost')]);
    const c = golden();
    rewrite(c, A0, 3, (r) => {
      r.body.energy = num(r.body.energy) + 1;
    });
    expect(gatesOf(c)).toEqual([at(A0, 3, 'cost')]);
  });

  it('names a biomassBefore 1 hundredth beyond the reach, and passes one at it', () => {
    const beyond = (extra: number) => {
      const b = golden();
      const cp = bodyOf(b, A0, 2);
      const mc = bodyOf(b, A0, 3);
      const reach = growthReach(num(cp.biomass), g, num(mc.activeMs) - num(cp.activeMs));
      rewrite(b, A0, 3, (r) => {
        const before = {
          biomass: reach + extra,
          energy: num(r.body.energyBefore),
          health: num(r.body.healthBefore),
        };
        Object.assign(r.body, paidFor(before), { biomassBefore: before.biomass });
      });
      return gatesOf(b);
    };
    expect(beyond(1)).toEqual([at(A0, 3, 'growth')]);
    expect(beyond(0)).toEqual([]);
  });
});

describe('growth', () => {
  it("names a checkpoint's biomass 1 hundredth beyond the reach, and passes one at it", () => {
    const beyond = (extra: number) => {
      const b = golden();
      const enc = bodyOf(b, A1, 3);
      const cp = bodyOf(b, A1, 4);
      const reach = growthReach(
        num(enc.biomass),
        genomeOf(b, A1),
        num(cp.activeMs) - num(enc.activeMs),
      );
      rewrite(b, A1, 4, (r) => {
        r.body.biomass = reach + extra;
      });
      return gatesOf(b);
    };
    expect(beyond(1)).toEqual([at(A1, 4, 'growth')]);
    expect(beyond(0)).toEqual([]);
  });

  it('names energy above the maximum, and passes it at the maximum', () => {
    const over = (extra: number) => {
      const b = golden();
      rewrite(b, A1, 2, (r) => {
        r.body.energy = vitalsCap(num(r.body.biomass)).energy + extra;
      });
      return gatesOf(b);
    };
    expect(over(1)).toEqual([at(A1, 2, 'vitals')]);
    expect(over(0)).toEqual([]);
    const b = golden();
    rewrite(b, A1, 2, (r) => {
      r.body.health = vitalsCap(num(r.body.biomass)).health + 1;
    });
    expect(gatesOf(b)).toEqual([at(A1, 2, 'vitals')]);
  });

  it("names a first checkpoint beyond the start's reach, for a genesis and a birth", () => {
    for (const [creature, seq, kind] of [
      [A0, 1, 'genesis'],
      [A1, 2, 'birth'],
    ] as const) {
      const beyond = (extra: number) => {
        const b = golden();
        const g = genomeOf(b, creature);
        const cp = bodyOf(b, creature, seq);
        const reach = growthReach(startOf(kind, g).biomass, g, num(cp.activeMs));
        rewrite(b, creature, seq, (r) => {
          r.body.biomass = reach + extra;
          Object.assign(r.body, vitalsCap(reach + extra));
        });
        return gatesOf(b);
      };
      expect(beyond(1)).toEqual([at(creature, seq, 'growth')]);
      expect(beyond(0)).toEqual([]);
    }
  });
});

describe('freezes and returns', () => {
  it('names a restore that changes its health or its clock', () => {
    const b = bundleOf(history, A0);
    rewrite(b, A0, 5, (r) => {
      r.body.health = num(r.body.health) - 1;
    });
    expect(gatesOf(b)).toEqual([at(A0, 5, 'restore-changed')]);
    const c = bundleOf(history, A0);
    rewrite(c, A0, 5, (r) => {
      r.body.activeMs = num(r.body.activeMs) + 1;
    });
    expect(gatesOf(c)).toEqual([at(A0, 5, 'restore-changed')]);
    const d = bundleOf(history, A0);
    rewrite(d, A0, 5, (r) => {
      r.body.cooldownUntilMs = num(r.body.cooldownUntilMs) - 1;
    });
    expect(gatesOf(d)).toEqual([at(A0, 5, 'restore-changed')]);
  });

  it("names a parent's promote that changes its cooldown", () => {
    const b = golden();
    rewrite(b, A0, 4, (r) => {
      r.body.cooldownUntilMs = num(r.body.cooldownUntilMs) - 1;
    });
    expect(gatesOf(b)).toEqual([at(A0, 4, 'promote-cooldown')]);
  });

  /** A0 frozen with `left` ms of life, its clock carried there in wall time, then `then` after it. */
  const frozenWith = (left: number, then: (promote: Step) => Step) => {
    const b = bundleOf(history, A0);
    const g = genomeOf(b, A0);
    const mc = recordOf(b, A0, 3);
    const activeMs = lifespanOf(g, LIVE_SCALES) - left;
    const promote: Step = {
      kind: 'promote',
      t: mc.t + (activeMs - num(mc.body.activeMs)),
      body: { ...bodyOf(b, A0, 4), activeMs },
    };
    retail(b, A0, 4, [promote, then(promote)]);
    return gatesOf(b);
  };
  const minimum = restoreMinOf(LIVE_SCALES);
  const restore = (p: Step): Step => {
    const { role: _r, child, ...kept } = p.body;
    return { kind: 'restore', t: p.t + 5_000, body: { from: child as string, ...kept } };
  };
  const exhausted = (p: Step): Step => ({
    kind: 'death',
    t: p.t + 5_000,
    body: { cause: 'old-age', activeMs: num(p.body.activeMs), biomass: num(p.body.biomass) },
  });

  it('names a restore with 1 ms less than the minimum left, and passes the minimum', () => {
    expect(frozenWith(minimum - 1, restore)).toEqual([at(A0, 5, 'restore-exhausted')]);
    expect(frozenWith(minimum, restore)).toEqual([]);
  });

  it('takes an old-age death of a frozen creature only with less than the minimum left', () => {
    expect(frozenWith(minimum - 1, exhausted)).toEqual([]);
    expect(frozenWith(minimum, exhausted)).toEqual([at(A0, 5, 'old-age-early')]);
  });

  it("names a frozen creature's death that moves its clock or its size", () => {
    const moved = (p: Step): Step => {
      const d = exhausted(p);
      return { ...d, body: { ...d.body, activeMs: num(d.body.activeMs) + 1 } };
    };
    expect(frozenWith(minimum - 1, moved)).toEqual([at(A0, 5, 'frozen-changed')]);
    const shrunk = (p: Step): Step => {
      const d = exhausted(p);
      return { ...d, body: { ...d.body, biomass: num(d.body.biomass) - 1 } };
    };
    expect(frozenWith(minimum - 1, shrunk)).toEqual([at(A0, 5, 'frozen-changed')]);
  });
});

describe('problemText for the gates', () => {
  it('has a sentence for every code the family names', () => {
    const codes = [
      'clock-back',
      'clock-fast',
      'after-lifespan',
      'old-age-early',
      'pending-clock',
      'mature-time',
      'mature-size',
      'mate-energy',
      'cooldown',
      'cooldown-length',
      'cost',
      'growth',
      'vitals',
      'restore-changed',
      'restore-exhausted',
      'promote-cooldown',
      'frozen-changed',
    ];
    for (const code of codes) {
      expect(Object.hasOwn(PROBLEM_TEXT, code), code).toBe(true);
      expect(problemText(at(A1, 0, code))).toBe(PROBLEM_TEXT[code]);
    }
  });
});
