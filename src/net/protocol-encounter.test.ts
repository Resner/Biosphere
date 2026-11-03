import { describe, expect, it } from 'vitest';
import { GENOME_TEXT_LENGTH } from '../genome/codec';
import { createRng, seedFromString } from '../sim/prng';
import {
  ENC_END_MAX_BYTES,
  ENC_START_MAX_BYTES,
  type FighterInfo,
  type FighterOutcome,
  GENOME_DATA_MAX_CHARS,
  HUB_MAX_BYTES,
  isCause,
  parseClientMsg,
  parseHubMsg,
  type SignedSnap,
} from './protocol';

// Protocol 7 (M7 T6): the encounter messages and shapes of docs/specs/M7-encounters.md, with
// protocol 8's worth (M8 T3; the rest of protocol 8 is in `protocol-fight.test.ts`).

const PID = 'A'.repeat(43);
const PID2 = 'B'.repeat(43);
const HEX = 'ab'.repeat(32);
const HEX2 = 'cd'.repeat(32);
const LOCK = '0123456789abcdef'.repeat(2);
const GENOME = 'Ab-_09'.repeat(100);
const SIG = 'c'.repeat(86);
const SNAP = 'x'.repeat(33) + 'A';
const mine: SignedSnap = { snap: SNAP, sig: SIG };
const theirs: SignedSnap = { snap: `${'y'.repeat(33)}w`, sig: 'd'.repeat(86) };

const fighter = (over: Partial<FighterInfo> = {}): FighterInfo => ({
  player: PID,
  creature: HEX,
  genome: GENOME,
  x: 4100.123456789,
  y: 0,
  vx: -61.25,
  vy: 0.1,
  heading: -3.0001,
  biomass: 412.3456,
  energy: 1033.5,
  health: 77.125,
  elder: false,
  egg: true,
  worth: 0.5,
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

const clientMsgs = [
  { t: 'engage', target: PID2, mine, theirs },
  { t: 'lock-state', lock: LOCK, mine },
  { t: 'input', enc: HEX, f: 0, i: 0 },
  { t: 'input', enc: HEX, f: 1000, i: 0xffffffff },
];

const hubMsgs = [
  { t: 'lock-ask', lock: LOCK },
  {
    t: 'enc-start',
    enc: HEX,
    seed: HEX2,
    round: 0,
    t0: 123_456,
    at: 1_700_000_000_150,
    fighters: [fighter(), fighter({ player: PID2, creature: HEX2, elder: true, egg: false })],
  },
  { t: 'enc-frame', enc: HEX, f: 7, i: [0x41234, null] },
  { t: 'enc-frame', enc: HEX, f: 900, i: [null, null, 1, 0xffffffff] },
  { t: 'enc-join', enc: HEX, f: 12, fighter: fighter({ player: PID2 }) },
  {
    t: 'enc-end',
    enc: HEX,
    f: 312,
    hash: '13cf1b2deb89cfd6',
    fighters: [
      outcome({ outcome: 'stood', cause: null, by: null, egg: 'none', eggBy: null }),
      outcome(),
      outcome({ outcome: 'escaped', cause: null, by: null, egg: 'kept', eggBy: null }),
      outcome({ outcome: 'died', cause: 'toxin', by: null, egg: 'kept', eggBy: null }),
    ],
  },
  { t: 'carrion', enc: HEX, x: 1.5, y: 8000, biomass: 160.25, radius: 14.5, tick: 99_000 },
];

const STORED = {
  record: {
    v: 1,
    rules: 9,
    kind: 'death',
    creature: HEX,
    seq: 3,
    prev: HEX2,
    owner: PID,
    t: 1_700_000_005_000,
    body: { cause: 'killed' },
  },
  hash: HEX,
  ownerSig: null,
  authSig: SIG,
  keyId: 'AbCdEf_-',
};

describe('protocol 7 encounter messages', () => {
  it.each(clientMsgs)('client %j round trips', (m) => {
    expect(parseClientMsg(JSON.stringify(m))).toEqual(m);
  });
  it.each(hubMsgs)('hub %j round trips', (m) => {
    expect(parseHubMsg(JSON.stringify(m))).toEqual(m);
  });

  it('round trips the killer named on `died`, and the eaten cause', () => {
    const died = { t: 'died', cause: 'killed', record: STORED, by: 'Alice_9' };
    expect(parseHubMsg(JSON.stringify(died))).toEqual(died);
    const eaten = { ...died, cause: 'eaten' };
    expect(parseHubMsg(JSON.stringify(eaten))).toEqual(eaten);
    expect(parseHubMsg(JSON.stringify({ ...died, by: 'no' }))).toBeNull();
    expect(parseHubMsg(JSON.stringify({ ...died, by: 7 }))).toBeNull();
    expect(isCause('eaten')).toBe(true);
  });

  it('strips unknown fields from the encounter shapes', () => {
    const start = hubMsgs[1] as { fighters: FighterInfo[] };
    const raw = JSON.stringify({
      ...start,
      extra: 1,
      fighters: start.fighters.map((f) => ({ ...f, phys: { thrust: 9 } })),
    });
    expect(parseHubMsg(raw)).toEqual(start);
    expect(parseClientMsg(JSON.stringify({ ...clientMsgs[0], mine: { ...mine, x: 1 } }))).toEqual(
      clientMsgs[0],
    );
  });
});

describe('encounter ranges', () => {
  const hub = (m: object) => parseHubMsg(JSON.stringify(m));
  const client = (m: object) => parseClientMsg(JSON.stringify(m));
  const [engage, lockState, input] = clientMsgs as [object, object, object];
  const [lockAsk, start, frame, , join, end, carrion] = hubMsgs as [
    object,
    { fighters: FighterInfo[] },
    object,
    object,
    object,
    { fighters: FighterOutcome[] },
    object,
  ];

  it('takes frames 0–1,000 and inputs as u32 only', () => {
    for (const f of [-1, 1001, 1.5, '3', null]) {
      expect(client({ ...input, f }), String(f)).toBeNull();
      expect(hub({ ...frame, f }), String(f)).toBeNull();
      expect(hub({ ...join, f }), String(f)).toBeNull();
      expect(hub({ ...end, f }), String(f)).toBeNull();
    }
    for (const i of [-1, 2 ** 32, 0.5, '1', true]) {
      expect(client({ ...input, i }), String(i)).toBeNull();
      expect(hub({ ...frame, i: [0, i] }), String(i)).toBeNull();
    }
    // A bundle's null is the fallback marker; an input always names its code.
    expect(client({ ...input, i: null })).toBeNull();
  });

  it('takes 2–4 fighters and slots 0–3', () => {
    const f = fighter();
    expect(hub({ ...start, fighters: [f] })).toBeNull();
    expect(hub({ ...start, fighters: [f, f, f, f] })).not.toBeNull();
    expect(hub({ ...start, fighters: [f, f, f, f, f] })).toBeNull();
    expect(hub({ ...frame, i: [1] })).toBeNull();
    expect(hub({ ...frame, i: [1, 2, 3, 4, 5] })).toBeNull();
    const o = outcome();
    expect(hub({ ...end, fighters: [o] })).toBeNull();
    expect(hub({ ...end, fighters: [o, o, o, o, o] })).toBeNull();
    for (const slot of [-1, 4, 1.5, '1']) {
      expect(hub({ ...end, fighters: [o, outcome({ by: slot as number })] })).toBeNull();
      expect(hub({ ...end, fighters: [o, outcome({ eggBy: slot as number })] })).toBeNull();
    }
  });

  it('rejects non-finite or out-of-range numbers in the fighter shapes and carrion', () => {
    for (const [key, value] of [
      ['x', -0.5],
      ['x', 8192.5],
      ['y', 1e300],
      ['vx', 1e6],
      ['heading', 7],
      ['biomass', -1],
      ['energy', -0.01],
      ['health', 2e9],
    ] as const) {
      expect(hub({ ...start, fighters: [fighter({ [key]: value }), fighter()] }), key).toBeNull();
      expect(hub({ ...end, fighters: [outcome({ [key]: value }), outcome()] }), key).toBeNull();
    }
    // JSON has no NaN or Infinity: they serialize as null, and a huge exponent overflows to Infinity.
    expect(hub({ ...start, fighters: [fighter({ x: Number.NaN }), fighter()] })).toBeNull();
    expect(parseHubMsg(JSON.stringify(carrion).replace('"x":1.5', '"x":1e999'))).toBeNull();
    for (const [key, value] of [
      ['x', -1],
      ['y', 9000],
      ['biomass', -1],
      ['radius', 0],
      ['radius', 1e6],
      ['tick', 1.5],
      ['tick', 2 ** 32],
    ] as const) {
      expect(hub({ ...carrion, [key]: value }), key).toBeNull();
    }
  });

  it('takes ids as hex, player ids as player ids, and genomes within the text cap', () => {
    expect(hub({ ...start, enc: HEX.toUpperCase() })).toBeNull();
    expect(hub({ ...start, seed: 'ab' })).toBeNull();
    // The hash is the encounter's `hashEncounter`: 16 hex characters.
    expect(hub({ ...end, hash: HEX })).toBeNull();
    expect(hub({ ...end, hash: '13cf1b2deb89cfd' })).toBeNull();
    expect(hub({ ...lockAsk, lock: 'not-hex!' })).toBeNull();
    expect(hub({ ...lockAsk, lock: 'abc' })).toBeNull();
    expect(client({ ...lockState, lock: 'g'.repeat(32) })).toBeNull();
    expect(client({ ...engage, target: 'short' })).toBeNull();
    expect(hub({ ...start, fighters: [fighter({ player: 'x' }), fighter()] })).toBeNull();
    expect(hub({ ...start, fighters: [fighter({ creature: 'x' }), fighter()] })).toBeNull();
    const long = fighter({ genome: 'A'.repeat(GENOME_DATA_MAX_CHARS + 1) });
    expect(hub({ ...join, fighter: long })).toBeNull();
    expect(hub({ ...join, fighter: fighter({ genome: 'not base64!' }) })).toBeNull();
    expect(hub({ ...start, round: -1 })).toBeNull();
    expect(hub({ ...start, at: 1.5 })).toBeNull();
    expect(hub({ ...start, t0: 2 ** 32 })).toBeNull();
  });

  it('takes signed snapshots only as 25 bytes and 64 bytes of base64url', () => {
    for (const s of [
      { snap: SNAP.slice(1), sig: SIG },
      { snap: `${SNAP}A`, sig: SIG },
      { snap: SNAP, sig: SIG.slice(1) },
      { snap: `${SNAP.slice(1)}+`, sig: SIG },
      { snap: SNAP },
      'x',
      null,
    ]) {
      expect(client({ ...engage, mine: s }), JSON.stringify(s)).toBeNull();
      expect(client({ ...engage, theirs: s }), JSON.stringify(s)).toBeNull();
      expect(client({ ...lockState, mine: s }), JSON.stringify(s)).toBeNull();
    }
  });

  it('takes only the known outcomes, causes and egg states', () => {
    for (const over of [
      { outcome: 'won' },
      { cause: 'boredom' },
      { egg: 'cracked' },
      { egg: true },
      { outcome: null },
    ]) {
      expect(hub({ ...end, fighters: [outcome(over as never), outcome()] })).toBeNull();
    }
    expect(hub({ ...start, fighters: [fighter({ elder: 1 as never }), fighter()] })).toBeNull();
  });

  it('fits four fighters with karyotype v2 genomes in ENC_START_MAX_BYTES, and caps both ends', () => {
    const big = (n: number) =>
      fighter({
        player: String.fromCharCode(65 + n).repeat(43),
        genome: 'A'.repeat(GENOME_TEXT_LENGTH),
        x: 4096.123456789012,
        y: 4096.123456789012,
        vx: -123.45678901234,
        vy: -123.45678901234,
        heading: -3.141592653589793,
        biomass: 2_457_599.123456789,
        energy: 7_372_799.123456789,
        health: 123_456.123456789,
      });
    const worst = { ...start, fighters: [0, 1, 2, 3].map(big) };
    const raw = JSON.stringify(worst);
    expect(raw.length).toBeLessThanOrEqual(ENC_START_MAX_BYTES);
    expect(parseHubMsg(raw)).toEqual(worst);
    expect(ENC_START_MAX_BYTES).toBe(8192);
    // Past the 4 KB of other hub messages, still within its own cap, to the byte: `,"pad":""` is 9.
    const room = ENC_START_MAX_BYTES - raw.length - 9;
    expect(raw.length + 9 + room).toBeGreaterThan(HUB_MAX_BYTES);
    expect(hub({ ...worst, pad: 'x'.repeat(room) })).toEqual(worst);
    expect(hub({ ...worst, pad: 'x'.repeat(room + 1) })).toBeNull();

    const worstEnd = {
      ...end,
      fighters: [0, 1, 2, 3].map((n) => {
        const { genome: _g, elder: _e, egg: _egg, worth: _w, ...rest } = big(n);
        return { ...rest, outcome: 'killed', cause: 'pressure', by: 3, egg: 'eaten', eggBy: 3 };
      }),
    };
    const rawEnd = JSON.stringify(worstEnd);
    expect(rawEnd.length).toBeLessThanOrEqual(ENC_END_MAX_BYTES);
    expect(parseHubMsg(rawEnd)).toEqual(worstEnd);
    expect(ENC_END_MAX_BYTES).toBe(8192);
    expect(hub({ ...worstEnd, pad: 'x'.repeat(ENC_END_MAX_BYTES) })).toBeNull();
    expect(hub({ ...join, pad: 'x'.repeat(HUB_MAX_BYTES) })).toBeNull();
    expect(client({ ...engage, pad: 'x'.repeat(HUB_MAX_BYTES) })).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------
// Fuzz: a value no field of any encounter shape accepts, and random JSON or bytes.

/** Each is wrong for every field: no regex takes '' or '!', no range 1e300, no list fewer than 2. */
const POISON: unknown[] = ['', '!', {}, [], 1e300, -1e300, 'A'.repeat(5000), [[]]];

type Path = (string | number)[];
function leaves(v: unknown, path: Path = []): Path[] {
  if (Array.isArray(v)) return v.flatMap((x, i) => leaves(x, [...path, i]));
  if (typeof v === 'object' && v !== null)
    return Object.entries(v).flatMap(([k, x]) => leaves(x, [...path, k]));
  return [path];
}
function withLeaf(v: unknown, path: Path, value: unknown, remove: boolean): unknown {
  const copy = structuredClone(v) as Record<string | number, unknown>;
  let at = copy;
  for (const key of path.slice(0, -1)) at = at[key] as Record<string | number, unknown>;
  const last = path.at(-1) as string | number;
  if (remove && !Array.isArray(at)) delete at[last];
  else at[last] = value;
  return copy;
}

describe('encounter fuzz', () => {
  it('parses nothing malformed: 10,000 valid messages with one field poisoned or removed', () => {
    const rng = createRng(seedFromString('fuzz-encounter'), 'net');
    const samples = [
      ...clientMsgs.map((m) => ({ m, parse: parseClientMsg })),
      ...hubMsgs.map((m) => ({ m, parse: parseHubMsg })),
    ];
    const parsed: unknown[] = [];
    for (let n = 0; n < 10_000; n++) {
      const { m, parse } = samples[rng.int(0, samples.length - 1)] as (typeof samples)[number];
      const paths = leaves(m);
      const path = paths[rng.int(0, paths.length - 1)] as Path;
      const remove = rng.int(0, 3) === 0;
      const bad = withLeaf(m, path, POISON[rng.int(0, POISON.length - 1)], remove);
      if (parse(JSON.stringify(bad)) !== null) parsed.push(bad);
    }
    expect(parsed).toEqual([]);
  });

  it('never throws on 10,000 random JSON values, and what parses is stable', () => {
    const rng = createRng(seedFromString('fuzz-encounter-json'), 'net');
    const keys = ['t', 'enc', 'f', 'i', 'fighters', 'mine', 'snap', 'sig', 'lock', 'x', 'by'];
    const types = ['engage', 'lock-state', 'input', 'lock-ask', 'enc-start', 'enc-frame'];
    const value = (depth: number): unknown => {
      switch (rng.int(0, depth > 2 ? 3 : 5)) {
        case 0:
          return rng.int(-5, 5) * 10 ** rng.int(0, 12);
        case 1:
          return [null, true, false][rng.int(0, 2)];
        case 2:
          return [HEX, PID, LOCK, SNAP, SIG, 'x', ...types][rng.int(0, 7 + types.length - 1)];
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
      for (const parse of [parseClientMsg, parseHubMsg]) {
        const got = parse(raw);
        if (got) expect(parse(JSON.stringify(got))).toEqual(got);
      }
    }
  });

  it('never throws on 10,000 random byte strings', () => {
    const rng = createRng(seedFromString('fuzz-encounter-bytes'), 'net');
    let parsed = 0;
    for (let n = 0; n < 10_000; n++) {
      const bytes = Array.from({ length: rng.int(0, 200) }, () => rng.int(0, 255));
      const raw = String.fromCharCode(...bytes);
      if (parseClientMsg(raw) || parseHubMsg(raw)) parsed++;
    }
    expect(parsed).toBe(0);
  });
});
