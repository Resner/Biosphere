import { describe, expect, it } from 'vitest';
import type { SettledFighter, SignedSettlement } from '../ledger/settlement';
import { createRng, seedFromString } from '../sim/prng';
import {
  ENC_END_MAX_BYTES,
  type FighterInfo,
  type FighterOutcome,
  type FightReport,
  type LifeInfo,
  parseHubMsg,
} from './protocol';

// Protocol 8 (M8 T3): a fighter's worth, the fight in `life`, away reports and the signed settlement
// in `enc-end` (docs/specs/M8-disconnect-safe-settlement.md).

const PID = 'A'.repeat(43);
const PID2 = 'B'.repeat(43);
const HEX = 'ab'.repeat(32);
const HEX2 = 'cd'.repeat(32);
const SIG = 'c'.repeat(86);
const STATE_HASH = '13cf1b2deb89cfd6';
const WORTHS = [1, 0.5, 0.25, 0.125, 0.0625, 0.03125, 0.015625, 0.0078125];

const info = (over: Partial<FighterInfo> = {}): FighterInfo => ({
  player: PID,
  creature: HEX,
  genome: 'Ab-_09'.repeat(10),
  x: 4100.5,
  y: 10,
  vx: -1.25,
  vy: 0,
  heading: 1,
  biomass: 412.5,
  energy: 1033.5,
  health: 77.125,
  elder: false,
  egg: false,
  worth: 0.25,
  ...over,
});
const outcome = (over: Partial<FighterOutcome> = {}): FighterOutcome => ({
  player: PID,
  creature: HEX,
  x: 8192,
  y: 12.5,
  vx: 0,
  vy: 3.75,
  heading: 6.2,
  biomass: 600.5,
  energy: 0,
  health: 0,
  outcome: 'killed',
  cause: 'killed',
  by: 1,
  egg: 'eaten',
  eggBy: 1,
  ...over,
});
const result = (over: Partial<SettledFighter> = {}): SettledFighter => ({
  player: PID,
  creature: HEX,
  outcome: 'killed',
  cause: 'killed',
  by: 1,
  frame: 312,
  egg: 'eaten',
  eggBy: 1,
  biomass: 60_050,
  energy: 0,
  health: 0,
  reward: 0,
  ...over,
});
const stood = (): SettledFighter => {
  const {
    cause: _c,
    by: _b,
    eggBy: _e,
    ...rest
  } = result({
    player: PID2,
    creature: HEX2,
    outcome: 'stood',
    egg: 'none',
    biomass: 41_250,
    energy: 103_350,
    health: 7712,
    reward: 24_020,
  });
  return rest;
};
const signed = (results = [result(), stood(), stood()], joins = [HEX2]): SignedSettlement => ({
  settlement: {
    v: 1,
    kind: 'settlement',
    rules: 10,
    enc: HEX,
    pondSeed: 'Ab3_-xyzQ12w',
    start: HEX2,
    joins,
    frames: 313,
    root: HEX,
    hash: STATE_HASH,
    referee: 'authority',
    results,
    t: 1_700_000_005_000,
  },
  hash: HEX2,
  authSig: SIG,
  keyId: 'AbCdEf_-',
});
const report = (over: Partial<FightReport> = {}): FightReport => ({
  enc: HEX,
  outcome: 'killed',
  cause: 'killed',
  by: 'Alice_9',
  egg: 'eaten',
  eggBy: 'Bob-the-3rd',
  frames: 312,
  ...over,
});
const life: LifeInfo = {
  creature: HEX,
  seq: 4,
  genome: 'Ab-_09'.repeat(10),
  biomass: 41_250,
  energy: 9000,
  health: 7712,
  activeMs: 120_000,
  lifespanMs: 3_600_000,
  matureAtMs: 600_000,
  cooldownUntilMs: 0,
};

const start = {
  t: 'enc-start',
  enc: HEX,
  seed: HEX2,
  round: 0,
  t0: 123_456,
  at: 1_700_000_000_150,
  fighters: [info(), info({ player: PID2, creature: HEX2, worth: 1 })],
};
const join = { t: 'enc-join', enc: HEX, f: 12, fighter: info({ worth: 0.0078125 }) };
const end = {
  t: 'enc-end',
  enc: HEX,
  f: 312,
  hash: STATE_HASH,
  fighters: [
    outcome(),
    outcome({ outcome: 'stood', cause: null, by: null, egg: 'none', eggBy: null }),
    outcome({ outcome: 'stood', cause: null, by: null, egg: 'none', eggBy: null }),
  ],
  settlement: signed(),
};
const lifeFight = { t: 'life', life, genesisIn: 0, fight: HEX };
const lifeReport = {
  t: 'life',
  life: null,
  genesisIn: 5000,
  fallback: { pending: true, ancestor: null },
  report: report(),
};
const quietReport = {
  ...lifeReport,
  report: report({ outcome: 'escaped', cause: null, by: null, egg: 'kept', eggBy: null }),
};

const hubMsgs = [start, join, end, lifeFight, lifeReport, quietReport];
const hub = (m: object) => parseHubMsg(JSON.stringify(m));

describe('protocol 8 fight messages', () => {
  it.each(hubMsgs.map((m, k) => [`${m.t} #${k}`, m] as const))('%s round trips', (_, m) => {
    expect(hub(m)).toEqual(m);
  });

  it('keeps an enc-end without a settlement, and a life without fight or report', () => {
    const { settlement: _s, ...bare } = end;
    expect(hub(bare)).toEqual(bare);
    const { fight: _f, ...plain } = lifeFight;
    expect(hub(plain)).toEqual(plain);
  });

  it('takes a settlement result with no cause and no slots, and strips unknown fields', () => {
    const got = hub({
      ...end,
      settlement: {
        ...end.settlement,
        extra: 1,
        settlement: { ...end.settlement.settlement, x: 2 },
      },
    });
    expect(got).toEqual(end);
    const results = (got as { settlement: SignedSettlement }).settlement.settlement.results;
    expect(Object.keys(results[1] as object)).not.toContain('cause');
  });
});

describe('worth', () => {
  it('takes exactly 1, 0.5, …, 2^-7', () => {
    for (const worth of WORTHS) {
      expect(hub({ ...join, fighter: info({ worth }) }), String(worth)).not.toBeNull();
    }
    for (const worth of [0.3, 0, 2, -0.5, 2 ** -8, 0.25000001, Number.NaN, '1', null, true]) {
      const bad = info({ worth: worth as number });
      expect(hub({ ...join, fighter: bad }), String(worth)).toBeNull();
      expect(hub({ ...start, fighters: [bad, info()] }), String(worth)).toBeNull();
    }
    const { worth: _w, ...missing } = info();
    expect(hub({ ...join, fighter: missing })).toBeNull();
  });

  it('is not part of an outcome', () => {
    const got = hub({ ...end, fighters: end.fighters.map((f) => ({ ...f, worth: 1 })) });
    expect(got).toEqual(end);
  });
});

describe('life: the running fight and the away report', () => {
  it('takes the fight as an encounter id only', () => {
    for (const fight of ['', 'ab', HEX.toUpperCase(), 7, null, true]) {
      expect(hub({ ...lifeFight, fight }), String(fight)).toBeNull();
    }
  });

  it('checks the report names like display names, and every other field', () => {
    for (const over of [
      { by: 'x'.repeat(200) },
      { by: 'x'.repeat(17) },
      { by: 'ab' },
      { by: 'bad name' },
      { eggBy: 'x'.repeat(200) },
      { eggBy: 7 },
      { enc: 'ab' },
      { outcome: 'won' },
      { cause: 'boredom' },
      { egg: 'cracked' },
      { frames: 1001 },
      { frames: -1 },
      { frames: 1.5 },
    ]) {
      expect(
        hub({ ...lifeReport, report: report(over as never) }),
        JSON.stringify(over),
      ).toBeNull();
    }
    expect(hub({ ...lifeReport, report: 'killed' })).toBeNull();
    expect(hub({ ...lifeReport, report: null })).toBeNull();
  });
});

describe('enc-end: the signed settlement', () => {
  const withDoc = (over: object, results?: SettledFighter[], joins?: string[]) => {
    const doc = signed(results, joins);
    return hub({ ...end, settlement: { ...doc, settlement: { ...doc.settlement, ...over } } });
  };

  it('takes at most 4 results, and at least 2', () => {
    const four = [result(), stood(), stood(), stood()];
    const fighters = [...end.fighters, end.fighters[1]];
    expect(hub({ ...end, fighters, settlement: signed(four, [HEX2, HEX]) })).not.toBeNull();
    const five = [...four, stood()];
    expect(hub({ ...end, fighters, settlement: signed(five, [HEX2, HEX]) })).toBeNull();
    expect(hub({ ...end, settlement: signed([result()], []) })).toBeNull();
  });

  it('agrees with its enc-end: the same encounter, hash and fighters', () => {
    expect(withDoc({ enc: HEX2 })).toBeNull();
    expect(withDoc({ hash: '0000000000000000' })).toBeNull();
    expect(hub({ ...end, settlement: signed([result(), stood()], []) })).toBeNull();
    // A slot is a starter or a join: three slots from two starters need one join.
    expect(hub({ ...end, settlement: signed(undefined, [HEX2, HEX]) })).toBeNull();
  });

  it('takes hex hashes, an authority referee and the document kind only', () => {
    for (const over of [
      { v: 2 },
      { kind: 'encounter' },
      { referee: 'witness' },
      { start: 'ab' },
      { start: HEX.toUpperCase() },
      { root: STATE_HASH },
      { hash: HEX },
      { joins: ['xyz'] },
      { joins: HEX2 },
      { pondSeed: '' },
      { pondSeed: 'has space' },
      { rules: -1 },
      { rules: 1.5 },
      { frames: 1002 },
      { t: -1 },
      { t: 1.5 },
    ]) {
      expect(withDoc(over), JSON.stringify(over)).toBeNull();
    }
    const doc = signed();
    for (const over of [{ hash: STATE_HASH }, { authSig: 'short' }, { keyId: 'abc' }]) {
      expect(hub({ ...end, settlement: { ...doc, ...over } }), JSON.stringify(over)).toBeNull();
    }
    expect(hub({ ...end, settlement: null })).toBeNull();
  });

  it('takes results as integers in range, known outcomes and slots', () => {
    for (const over of [
      { biomass: 600.5 },
      { biomass: -1 },
      { reward: 2e9 },
      { energy: '1' },
      { health: Number.NaN },
      { frame: 1001 },
      { by: 4 },
      { by: null },
      { eggBy: -1 },
      { cause: null },
      { cause: 'boredom' },
      { outcome: 'won' },
      { egg: 'cracked' },
      { player: 'x' },
      { creature: 'x' },
    ]) {
      const results = [result(over as never), stood(), stood()];
      expect(withDoc({}, results), JSON.stringify(over)).toBeNull();
    }
  });

  it('fits four outcomes and a worst-case settlement in ENC_END_MAX_BYTES', () => {
    const big = (n: number) => ({
      ...outcome({
        player: String.fromCharCode(65 + n).repeat(43),
        x: 4096.123456789012,
        y: 4096.123456789012,
        vx: -123.45678901234,
        vy: -123.45678901234,
        heading: -3.141592653589793,
        biomass: 2_457_599.123456789,
        energy: 7_372_799.123456789,
        health: 123_456.123456789,
        cause: 'pressure',
        by: 3,
        eggBy: 3,
      }),
    });
    const bigResult = (n: number) =>
      result({
        player: String.fromCharCode(65 + n).repeat(43),
        cause: 'pressure',
        by: 3,
        eggBy: 3,
        frame: 1000,
        biomass: 999_999_999,
        energy: 999_999_999,
        health: 999_999_999,
        reward: 999_999_999,
      });
    const doc = signed([0, 1, 2, 3].map(bigResult), [HEX, HEX2]);
    doc.settlement.pondSeed = 'x'.repeat(64);
    doc.settlement.t = Number.MAX_SAFE_INTEGER;
    const worst = { ...end, fighters: [0, 1, 2, 3].map(big), settlement: doc };
    const raw = JSON.stringify(worst);
    expect(raw.length).toBeLessThanOrEqual(ENC_END_MAX_BYTES);
    expect(parseHubMsg(raw)).toEqual(worst);
    expect(ENC_END_MAX_BYTES).toBe(8192);
    expect(hub({ ...worst, pad: 'x'.repeat(ENC_END_MAX_BYTES) })).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------
// Fuzz: one field poisoned or removed, random JSON and random bytes.

/** Each is wrong for every field: no regex takes '' or '!', no range 1e300, no list fewer than 2. */
const POISON: unknown[] = ['', '!', {}, [], 1e300, -1e300, 'A'.repeat(5000), [[]]];

type Path = (string | number)[];
function leaves(v: unknown, path: Path = []): Path[] {
  if (Array.isArray(v)) return v.flatMap((x, i) => leaves(x, [...path, i]));
  if (typeof v === 'object' && v !== null)
    return Object.entries(v).flatMap(([k, x]) => leaves(x, [...path, k]));
  return [path];
}
/** Leaves a message may lack: the `life` fight, and a settled result's cause and slots. */
const optional = (path: Path): boolean =>
  (path.length === 1 && path[0] === 'fight') ||
  (path.includes('results') && ['cause', 'by', 'eggBy'].includes(String(path.at(-1))));
function withLeaf(v: unknown, path: Path, value: unknown, remove: boolean): unknown {
  const copy = structuredClone(v) as Record<string | number, unknown>;
  let at = copy;
  for (const key of path.slice(0, -1)) at = at[key] as Record<string | number, unknown>;
  const last = path.at(-1) as string | number;
  if (remove && !Array.isArray(at)) delete at[last];
  else at[last] = value;
  return copy;
}

describe('protocol 8 fuzz', () => {
  it('parses nothing malformed: 10,000 valid messages with one field poisoned or removed', () => {
    const rng = createRng(seedFromString('fuzz-protocol-8'), 'net');
    const parsed: unknown[] = [];
    for (let n = 0; n < 10_000; n++) {
      const m = hubMsgs[rng.int(0, hubMsgs.length - 1)] as object;
      const paths = leaves(m);
      const path = paths[rng.int(0, paths.length - 1)] as Path;
      const remove = rng.int(0, 3) === 0 && !optional(path);
      const bad = withLeaf(m, path, POISON[rng.int(0, POISON.length - 1)], remove);
      if (parseHubMsg(JSON.stringify(bad)) !== null) parsed.push({ path, bad });
    }
    expect(parsed).toEqual([]);
  });

  it('never throws on 10,000 random JSON values, and what parses is stable', () => {
    const rng = createRng(seedFromString('fuzz-protocol-8-json'), 'net');
    const keys = ['t', 'enc', 'f', 'fight', 'report', 'settlement', 'results', 'worth', 'by'];
    const types = ['life', 'enc-end', 'enc-start', 'enc-join'];
    const atoms = [HEX, PID, SIG, STATE_HASH, 'Alice_9', 'authority', 'killed', 0.5, ...types];
    const value = (depth: number): unknown => {
      switch (rng.int(0, depth > 2 ? 3 : 5)) {
        case 0:
          return rng.int(-5, 5) * 10 ** rng.int(0, 12);
        case 1:
          return [null, true, false][rng.int(0, 2)];
        case 2:
          return atoms[rng.int(0, atoms.length - 1)];
        case 3:
          return rng.int(0, 1) / 2;
        case 4:
          return Array.from({ length: rng.int(0, 5) }, () => value(depth + 1));
        default:
          return Object.fromEntries(
            Array.from({ length: rng.int(0, 6) }, () => [
              keys[rng.int(0, keys.length - 1)],
              value(depth + 1),
            ]),
          );
      }
    };
    for (let n = 0; n < 10_000; n++) {
      const v = value(0);
      const raw = JSON.stringify(
        typeof v === 'object' && v && !Array.isArray(v) && rng.int(0, 1) === 1
          ? { ...v, t: types[rng.int(0, types.length - 1)] }
          : v,
      );
      const got = parseHubMsg(raw);
      if (got) expect(parseHubMsg(JSON.stringify(got))).toEqual(got);
    }
  });

  it('never throws on 10,000 random byte strings', () => {
    const rng = createRng(seedFromString('fuzz-protocol-8-bytes'), 'net');
    let parsed = 0;
    for (let n = 0; n < 10_000; n++) {
      const bytes = Array.from({ length: rng.int(0, 300) }, () => rng.int(0, 255));
      if (parseHubMsg(String.fromCharCode(...bytes))) parsed++;
    }
    expect(parsed).toBe(0);
  });
});
