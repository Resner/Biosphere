import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  AUTH_SECRET,
  bundleOf,
  indexOf,
  lineageHistory,
  play,
  retail,
  rewrite,
} from '../../tests/lineage-fixture';
import { genomeFromBase64url } from '../genome/codec';
import { buildCreature } from '../genome/stats';
import { settlementOf, verifyEncounter } from '../net/encounter-verify';
import { FRAME_MS } from '../net/referee';
import { CLOCK_SLACK_MS, reachAt } from './gates';
import type { ProofBundle } from './proof';
import type { LedgerRecord, StoredRecord } from './record';
import { type FightLog, type SignedSettlement, signSettlement } from './settlement';
import {
  PROBLEM_TEXT,
  type Problem,
  problemText,
  type VerifyOptions,
  verifyLineage,
} from './verify';

// M9 T6: the fights family of the lineage verifier against the golden bundle of the fixture's
// honest history (A1 kills B0 and eats B1's egg), with A1 as its subject. Each tamper is re-signed
// with the fixture's key, so only the check under test can catch it.

const GOLDEN = new URL('./__golden__/lineage.json', import.meta.url);
const history = lineageHistory();
const { A0, A1, B0, B1 } = history.ids;
const [ENC, LOG] = [...history.logs][0] as [string, FightLog];

const golden = (): ProofBundle => JSON.parse(readFileSync(GOLDEN, 'utf8')) as ProofBundle;
const replaying = (log: FightLog | null = LOG, enc = ENC): VerifyOptions => ({
  logs: new Map([[enc, log]]),
  replay: verifyEncounter,
});
const fightsOf = (b: ProofBundle, opts?: VerifyOptions): Problem[] =>
  verifyLineage(b, opts).problems.filter((p) => p.family === 'fights');
const at = (creature: string, seq: number | null, code: string): Problem => ({
  creature,
  seq,
  family: 'fights',
  code,
});

const recordOf = (b: ProofBundle, creature: string, seq: number): LedgerRecord =>
  (b.records[indexOf(b, creature, seq)] as StoredRecord).record;
const num = (v: unknown): number => v as number;
const growthOf = (b: ProofBundle, id: string): number => {
  const genome = genomeFromBase64url(b.creatures.find((c) => c.id === id)?.genome ?? '');
  if (!genome) throw new Error(`no genome for ${id}`);
  return buildCreature(genome).phys.growth;
};

/**
 * A1's encounter record moved by `ms` of clock, with its later records moved with it, so that only
 * the fight's own bounds see the change.
 */
function shiftA1Clock(b: ProofBundle, ms: number): void {
  for (const seq of [3, 4, 5]) {
    rewrite(b, A1, seq, (r) => {
      r.body.activeMs = num(r.body.activeMs) + ms;
    });
  }
}

/**
 * The golden with its fight fought again from a log that `change` alters: the fight replayed, its
 * settlement signed again, and A1's records from the fight on written from the new result.
 */
function refight(change: (log: FightLog) => void): { b: ProofBundle; log: FightLog } {
  const b = golden();
  const altered = structuredClone(LOG);
  change(altered);
  const fought = play({ pondSeed: altered.pondSeed, start: altered.start, joins: altered.joins });
  const frames = fought.log.frames.length;
  const t = altered.start.at + frames * FRAME_MS + 50;
  const signed = signSettlement(AUTH_SECRET, settlementOf(fought.log, fought.enc, t));
  b.settlements = [signed];
  const r = signed.settlement.results.find((x) => x.creature === A1);
  if (r?.outcome !== 'stood') throw new Error('A1 no longer stands');
  // Locked from its clock at the start for every frame fought.
  const activeMs = num(recordOf(b, A1, 3).body.activeMs) + (frames - LOG.frames.length) * FRAME_MS;
  const condition = { biomass: r.biomass, energy: r.energy, health: r.health };
  const after = { activeMs: activeMs + 20_000, ...condition };
  retail(b, A1, 3, [
    {
      kind: 'encounter',
      t,
      body: {
        enc: ENC,
        outcome: r.outcome,
        frames: r.frame,
        ...condition,
        reward: r.reward,
        activeMs,
      },
    },
    { kind: 'checkpoint', t: t + 20_000, body: after },
    {
      kind: 'death',
      t: t + 20_000,
      body: { cause: 'toxin', activeMs: after.activeMs, biomass: r.biomass },
    },
  ]);
  return { b, log: fought.log };
}

describe('the fights family on the honest history', () => {
  it('finds nothing in the golden and counts its one fight unreplayed', () => {
    const report = verifyLineage(golden());
    expect(report.problems).toEqual([]);
    expect(report.fights).toEqual({ settled: 1, replayed: 0, pruned: 0, unreplayed: 1 });
  });

  it('replays the golden fight from its log, with no problem', () => {
    const report = verifyLineage(golden(), replaying());
    expect(report.problems).toEqual([]);
    expect(report.fights).toEqual({ settled: 1, replayed: 1, pruned: 0, unreplayed: 0 });
  });

  it('counts a log passed as null as pruned, with no problem', () => {
    const report = verifyLineage(golden(), replaying(null));
    expect(report.problems).toEqual([]);
    expect(report.fights).toEqual({ settled: 1, replayed: 0, pruned: 1, unreplayed: 0 });
  });

  it('counts a log given without a replay as unreplayed', () => {
    const report = verifyLineage(golden(), { logs: new Map([[ENC, LOG]]) });
    expect(report.fights).toEqual({ settled: 1, replayed: 0, pruned: 0, unreplayed: 1 });
  });

  it('verifies the killed fighter and the eaten egg in their own bundles, replayed or not', () => {
    for (const id of [B0, B1, A0]) {
      const b = bundleOf(history, id);
      expect(verifyLineage(b).problems, id).toEqual([]);
      expect(verifyLineage(b, replaying()).problems, id).toEqual([]);
    }
    expect(verifyLineage(bundleOf(history, B1), replaying()).fights.replayed).toBe(1);
  });
});

describe('fight records against their settlement', () => {
  it("names the survivor's record biomass or reward", () => {
    const b = golden();
    rewrite(b, A1, 3, (r) => {
      r.body.biomass = num(r.body.biomass) - 1;
    });
    expect(fightsOf(b)).toEqual([at(A1, 3, 'settled:biomass')]);
    const c = golden();
    rewrite(c, A1, 3, (r) => {
      r.body.reward = num(r.body.reward) + 1;
    });
    expect(fightsOf(c)).toEqual([at(A1, 3, 'settled:reward')]);
  });

  it('leaves a flipped settlement signature to the signature family, replayed or not', () => {
    const b = golden();
    const signed = b.settlements[0] as SignedSettlement;
    const sig = [...signed.authSig];
    sig[5] = sig[5] === 'A' ? 'B' : 'A';
    signed.authSig = sig.join('');
    const problems = [at(A1, 3, 'settlement-sig')].map((p) => ({ ...p, family: 'signature' }));
    expect(verifyLineage(b).problems).toEqual(problems);
    expect(verifyLineage(b, replaying()).problems).toEqual(problems);
  });

  it('names a fight death or an encounter whose settlement is missing', () => {
    for (const [id, seq] of [
      [B0, 4],
      [B1, 1],
      [A1, 3],
    ] as const) {
      const b = bundleOf(history, id);
      b.settlements = [];
      expect(fightsOf(b), id).toEqual([at(id, seq, 'settlement-missing')]);
    }
    const c = bundleOf(history, B1);
    rewrite(c, B1, 1, (r) => {
      r.body.enc = 'f'.repeat(64);
    });
    expect(fightsOf(c)).toEqual([at(B1, 1, 'settlement-missing')]);
  });

  it("names a killed fighter's death that disagrees with its result", () => {
    const b = bundleOf(history, B0);
    rewrite(b, B0, 4, (r) => {
      r.body.biomass = num(r.body.biomass) + 1;
    });
    expect(fightsOf(b)).toEqual([at(B0, 4, 'settled:biomass')]);
  });
});

describe('the eaten egg', () => {
  it('names an egg eaten by another creature, and an egg that grew', () => {
    const b = bundleOf(history, B1);
    rewrite(b, B1, 1, (r) => {
      r.body.by = B0;
    });
    expect(fightsOf(b)).toEqual([at(B1, 1, 'settled:by')]);
    // A pending child is what it was born as: the reach over no time, 1 wu.
    const start = num(recordOf(bundleOf(history, B1), B1, 1).body.biomass);
    const reach = reachAt(start, growthOf(b, B1), 0);
    const grown = (biomass: number) => {
      const c = bundleOf(history, B1);
      rewrite(c, B1, 1, (r) => {
        r.body.biomass = biomass;
      });
      return fightsOf(c);
    };
    expect(grown(reach)).toEqual([]);
    expect(grown(reach + 1)).toEqual([at(B1, 1, 'fight-growth')]);
  });
});

describe('locked time and growth around a fight', () => {
  /** The most A1's encounter record may carry: the checkpoint before it, the wall time, the slack and the frames. */
  const clockBound = (b: ProofBundle): number => {
    const [before, rec] = [recordOf(b, A1, 2), recordOf(b, A1, 3)];
    return (
      num(before.body.activeMs) +
      (rec.t - before.t) +
      CLOCK_SLACK_MS +
      (b.settlements[0] as SignedSettlement).settlement.frames * FRAME_MS
    );
  };

  it("names a survivor's clock 1 ms past the bound, and passes the bound", () => {
    const b = golden();
    const over = clockBound(b) + 1 - num(recordOf(b, A1, 3).body.activeMs);
    shiftA1Clock(b, over);
    expect(fightsOf(b)).toEqual([at(A1, 3, 'fight-clock')]);
    const c = golden();
    shiftA1Clock(c, over - 1);
    expect(fightsOf(c)).toEqual([]);
  });

  it("names a survivor's biomass less its winnings beyond the reach, and passes the reach", () => {
    const b = golden();
    const [before, rec] = [recordOf(b, A1, 2), recordOf(b, A1, 3)];
    const elapsed = clockBound(b) - num(before.body.activeMs);
    const reach = reachAt(num(before.body.biomass), growthOf(b, A1), elapsed);
    const withBiomass = (biomass: number) => {
      const c = golden();
      const signed = c.settlements[0] as SignedSettlement;
      const settlement = structuredClone(signed.settlement);
      const result = settlement.results.find((r) => r.creature === A1);
      if (!result) throw new Error('no result for A1');
      result.biomass = biomass;
      c.settlements = [signSettlement(AUTH_SECRET, settlement)];
      rewrite(c, A1, 3, (r) => {
        r.body.biomass = biomass;
      });
      return fightsOf(c);
    };
    const reward = num(rec.body.reward);
    expect(withBiomass(reach + reward)).toEqual([]);
    expect(withBiomass(reach + reward + 1)).toEqual([at(A1, 3, 'fight-growth')]);
  });

  it("bounds a settlement's checkpoint before a death from the record before the fight", () => {
    const b = bundleOf(history, B0);
    const [before, death] = [recordOf(b, B0, 3), recordOf(b, B0, 4)];
    const frames = (b.settlements[0] as SignedSettlement).settlement.frames;
    const elapsed = death.t - before.t + frames * FRAME_MS + CLOCK_SLACK_MS;
    const reach = reachAt(num(before.body.biomass), growthOf(b, B0), elapsed);
    const withCheckpoint = (biomass: number, activeMs = num(death.body.activeMs)) => {
      const c = bundleOf(history, B0);
      // The last report: the mating's condition, grown to `biomass`, with the clock at the end.
      const { energy, health } = before.body;
      const body = { activeMs, biomass, energy, health } as LedgerRecord['body'];
      retail(c, B0, 4, [
        { kind: 'checkpoint', t: death.t, body },
        { kind: 'death', t: death.t, body: { ...death.body, activeMs } },
      ]);
      return verifyLineage(c).problems;
    };
    expect(withCheckpoint(num(before.body.biomass))).toEqual([]);
    expect(withCheckpoint(reach)).toEqual([]);
    expect(withCheckpoint(reach + 1)).toEqual([at(B0, 4, 'fight-growth')]);
    const clock = num(before.body.activeMs) + elapsed;
    expect(withCheckpoint(num(before.body.biomass), clock)).toEqual([]);
    // The death is bound from the same record before the fight, not from the checkpoint.
    expect(withCheckpoint(num(before.body.biomass), clock + 1)).toEqual([
      at(B0, 4, 'fight-clock'),
      at(B0, 5, 'fight-clock'),
    ]);
  });
});

describe('a fight replayed from its log', () => {
  it('names one input changed in the log', () => {
    const log = structuredClone(LOG);
    const row = log.frames[0] as (number | null)[];
    row[0] = 0;
    expect(fightsOf(golden(), replaying(log))).toContainEqual(at(A1, 3, 'replay:root'));
  });

  it("names a fighter's start beyond the reach from its record, and passes the reach", () => {
    const b = golden();
    const before = recordOf(b, A1, 2);
    const reach = reachAt(num(before.body.biomass), growthOf(b, A1), LOG.start.at - before.t);
    const startingAt = (biomass: number) =>
      refight((log) => {
        const f = log.start.fighters.find((x) => x.creature === A1);
        if (!f) throw new Error('A1 does not fight');
        f.biomass = biomass / 100;
      });
    const over = startingAt(reach + 1);
    expect(verifyLineage(over.b, replaying(over.log)).problems).toEqual([
      at(A1, 3, 'start-growth'),
    ]);
    const met = startingAt(reach);
    expect(verifyLineage(met.b, replaying(met.log)).problems).toEqual([]);
  });

  it('names a locked time that is not the frames fought, within what the wall time allows', () => {
    const b = golden();
    const before = recordOf(b, A1, 2);
    const locked = LOG.frames.length * FRAME_MS;
    const lockClock = num(before.body.activeMs) + (LOG.start.at - before.t) + CLOCK_SLACK_MS;
    const honest = num(recordOf(b, A1, 3).body.activeMs);
    const withClock = (activeMs: number) => {
      const c = golden();
      shiftA1Clock(c, activeMs - honest);
      return fightsOf(c, replaying());
    };
    expect(withClock(lockClock + locked)).toEqual([]);
    expect(withClock(lockClock + locked + 1)).toEqual([at(A1, 3, 'locked-time')]);
    const least = num(before.body.activeMs) + locked;
    expect(withClock(least)).toEqual([]);
    expect(withClock(least - 1)).toEqual([at(A1, 3, 'locked-time')]);
  });
});

describe('problemText for the fights', () => {
  it('has a sentence for every code the family names, and for each replay problem', () => {
    const fields = [
      'rules',
      'creature',
      'player',
      'kind',
      'outcome',
      'frames',
      'biomass',
      'energy',
      'health',
      'reward',
      'cause',
      'by',
    ];
    const replay = [
      'start',
      'joins',
      'frames',
      'root',
      'width',
      'rules-retired',
      'rules-unknown',
      'replay',
      'hash',
      'result',
    ];
    const codes = [
      'settlement-missing',
      'fight-clock',
      'fight-growth',
      'start-growth',
      'locked-time',
      ...fields.map((f) => `settled:${f}`),
      ...replay.map((c) => `replay:${c}`),
    ];
    for (const code of codes) {
      expect(Object.hasOwn(PROBLEM_TEXT, code), code).toBe(true);
      expect(problemText(at(A1, 3, code))).toBe(PROBLEM_TEXT[code]);
    }
    expect(problemText(at(A1, 3, 'replay:width:12'))).toBe(PROBLEM_TEXT['replay:width']);
    expect(problemText(at(A1, 3, 'replay:result:1:biomass'))).toBe(PROBLEM_TEXT['replay:result']);
    expect(problemText(at(A1, 3, 'settled:new-field'))).toBe(PROBLEM_TEXT.settled);
  });
});
