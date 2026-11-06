import { describe, expect, it } from 'vitest';
import { playerIdOf, publicKeyFromSecret } from '../ledger/identity';
import type { SettledFighter } from '../ledger/settlement';
import { createRng, seedFromString } from '../sim/prng';
import {
  BATCH_MAX_BYTES,
  DUTY_MAX_BYTES,
  EVENT_MAX_BYTES,
  type FighterInfo,
  parseClientMsg,
  parseHubMsg,
  parsePeerEvent,
} from './protocol';

// Protocol 10 (M10 T2, ADR 0058): duties, batches, disputes, attestations, and the signed inputs and
// frames on a duty link (docs/specs/M10-witnesses-audits-and-anti-farming.md).

/** Real player ids: a pool and an attestation take only keys some player could hold. */
const idOf = (n: number) => playerIdOf(publicKeyFromSecret(new Uint8Array(32).fill(n + 1)));
/** 16 of them, sorted as a pool is. */
const IDS = Array.from({ length: 16 }, (_, n) => idOf(n)).sort();
const [PID, PID2, PID3, PID4] = IDS as [string, string, string, string];
const HEX = 'ab'.repeat(32);
const HEX2 = 'cd'.repeat(32);
/** Signatures in canonical base64url: the spare bits of the last character are zero. */
const SIG = `${'c'.repeat(85)}A`;
const SIG2 = `${'D'.repeat(85)}g`;
const NONCE = 'd'.repeat(22);
const KEY_ID = 'AbCdEf_-';
const GENOME = 'Ab-_09'.repeat(100);
const ROUND = 33_409_900;
const U32 = 0xffffffff;
const ENC = `enc:${HEX}`;

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

const witnessCommit = (event = ENC, pool = [PID, PID2, PID3]) => ({
  commitment: {
    v: 1,
    kind: 'witness',
    owner: '',
    round: ROUND,
    req: HEX,
    t: 1_700_000_000_000,
    data: { event, pool },
  },
  authSig: SIG,
  keyId: KEY_ID,
});
const beacon = { round: ROUND, signature: 'cd'.repeat(48) };
const start = {
  t: 'enc-start',
  enc: HEX,
  seed: HEX2,
  round: 0,
  t0: 123_456,
  at: 1_700_000_000_150,
  fighters: [info(), info({ player: PID2, creature: HEX2, worth: 1 })],
};

const refereeDuty = {
  t: 'duty',
  event: ENC,
  role: 'referee',
  position: 0,
  commit: witnessCommit(),
  beacon,
  pondSeed: 'Ab3_-xyzQ12w',
  fighters: [PID, PID2],
  start,
  history: [
    { t: 'enc-frame', f: 0, i: [7, null] },
    { t: 'enc-frame', f: 1, i: [U32 - 1, 0] },
    { t: 'enc-join', f: 4, fighter: info({ player: PID3, worth: 0.5 }) },
    { t: 'enc-frame', f: 2, i: [null, null] },
  ],
};

const stood = (player: string): SettledFighter => ({
  player,
  creature: HEX,
  outcome: 'stood',
  frame: 312,
  egg: 'none',
  biomass: 41_250,
  energy: 103_350,
  health: 7712,
  reward: 0,
});
const settlement = {
  settlement: {
    v: 1,
    kind: 'settlement',
    rules: 11,
    enc: HEX,
    pondSeed: 'Ab3_-xyzQ12w',
    start: HEX2,
    joins: [],
    frames: 3,
    root: HEX,
    hash: '13cf1b2deb89cfd6',
    referee: 'authority',
    results: [stood(PID), stood(PID2)],
    t: 1_700_000_005_000,
  },
  hash: HEX2,
  authSig: SIG,
  keyId: KEY_ID,
};
const fightAudit = {
  t: 'duty',
  event: ENC,
  role: 'auditor',
  position: 1,
  commit: witnessCommit(),
  beacon,
  audit: {
    kind: 'enc',
    log: {
      pondSeed: 'Ab3_-xyzQ12w',
      start,
      joins: [{ t: 'enc-join', enc: HEX, f: 2, fighter: info({ player: PID3 }) }],
      frames: [
        [1, 2],
        [null, U32 - 1],
        [3, 4, null],
      ],
    },
    settlement,
  },
};

const record = (kind: string) => ({
  record: {
    v: 1,
    rules: 11,
    kind,
    creature: HEX,
    seq: 1,
    prev: HEX2,
    owner: PID,
    t: 1_700_000_005_000,
    body: { commit: HEX, round: ROUND },
  },
  hash: HEX,
  ownerSig: SIG,
  authSig: SIG,
  keyId: KEY_ID,
});
const genesisCommit = {
  commitment: {
    v: 1,
    kind: 'genesis',
    owner: PID,
    round: ROUND,
    req: HEX,
    t: 1_700_000_000_000,
    data: { nonce: NONCE, sig: SIG },
  },
  authSig: SIG,
  keyId: KEY_ID,
};
const mateAsk = {
  v: 1,
  kind: 'mate',
  creature: HEX,
  partner: PID2,
  partnerCreature: HEX2,
  nonce: NONCE,
  sig: SIG,
};
const mateCommit = {
  ...genesisCommit,
  commitment: {
    ...genesisCommit.commitment,
    kind: 'mate',
    data: { a: mateAsk, b: { ...mateAsk, partner: PID, creature: HEX2, partnerCreature: HEX } },
  },
};
const genesisAudit = {
  t: 'duty',
  event: `genesis:${HEX2}`,
  role: 'auditor',
  position: 0,
  commit: witnessCommit(`genesis:${HEX2}`, [PID3]),
  beacon,
  audit: { kind: 'genesis', commitment: genesisCommit, record: record('genesis'), genome: GENOME },
};
const matingAudit = {
  t: 'duty',
  event: `mating:${HEX2}`,
  role: 'auditor',
  position: 2,
  commit: witnessCommit(`mating:${HEX2}`),
  beacon,
  audit: {
    kind: 'mating',
    commitment: mateCommit,
    births: [record('birth'), record('birth')],
    mates: [record('mate-commit'), record('mate-commit')],
    parents: [GENOME, 'Zz'.repeat(300)],
  },
};

const attestation = {
  v: 1,
  kind: 'attest',
  event: ENC,
  duty: HEX2,
  position: 1,
  witness: PID3,
  subject: HEX,
  agree: true,
};

const clientMsgs = [
  { t: 'avail', on: true },
  { t: 'avail', on: false },
  { t: 'duty-ok', event: ENC },
  { t: 'duty-no', event: `mating:${HEX2}` },
  {
    t: 'batch',
    enc: HEX,
    f: 40,
    i: [
      [5, null],
      [null, null],
      [0, U32],
    ],
    s: [
      [SIG, null],
      [null, null],
      [SIG2, SIG],
    ],
    end: false,
  },
  { t: 'batch', enc: HEX, f: 1000, i: [[1, 2, 3, 4]], s: [[SIG, SIG, SIG, SIG2]], end: true },
  { t: 'dispute', enc: HEX, f: 77, i: [3, null, 9], sig: SIG },
  { t: 'attest', signed: { attestation, sig: SIG } },
  {
    t: 'attest',
    signed: { attestation: { ...attestation, agree: false, code: 'hash-mismatch' }, sig: SIG },
  },
];
const hubMsgs = [
  refereeDuty,
  fightAudit,
  genesisAudit,
  matingAudit,
  { t: 'duty-end', event: ENC, why: 'done' },
  { t: 'duty-end', event: `genesis:${HEX}`, why: 'taken-back' },
  { t: 'duty-end', event: ENC, why: 'replaced' },
  { t: 'duty-end', event: ENC, why: 'struck' },
  { t: 'duty-peer', enc: HEX, peer: PID2, on: true },
  { t: 'duty-peer', enc: HEX, peer: PID2, on: false },
  { t: 'enc-referee', enc: HEX, from: 43, by: PID3 },
  { t: 'enc-referee', enc: HEX, from: 0, by: 'authority' },
];
const peerEvents = [
  { t: 'finput', enc: HEX, f: 12, i: U32, sig: SIG },
  { t: 'wframe', enc: HEX, f: 12, i: [null, 0, 5], sig: SIG },
  { t: 'probe', n: 7, back: false },
  { t: 'probe', n: U32, back: true },
];

const client = (m: unknown) => parseClientMsg(JSON.stringify(m));
const hub = (m: unknown) => parseHubMsg(JSON.stringify(m));
const peer = (m: unknown) => parsePeerEvent(JSON.stringify(m));
const label = (m: { t: string }, k: number) => [`${m.t} #${k}`, m] as const;

describe('protocol 10 round trips', () => {
  it.each(clientMsgs.map(label))('client %s', (_, m) => expect(client(m)).toEqual(m));
  it.each(hubMsgs.map(label))('hub %s', (_, m) => expect(hub(m)).toEqual(m));
  it.each(peerEvents.map(label))('peer %s', (_, m) => expect(peer(m)).toEqual(m));

  it('keeps lock-state without seen, and with up to 5 signed snapshots', () => {
    const mine = { snap: 'A'.repeat(34), sig: SIG };
    const bare = { t: 'lock-state', lock: 'ab'.repeat(16), mine };
    expect(client(bare)).toEqual(bare);
    for (const n of [0, 1, 5]) {
      const msg = { ...bare, seen: Array.from({ length: n }, () => mine) };
      expect(client(msg)).toEqual(msg);
    }
    expect(client({ ...bare, seen: Array.from({ length: 6 }, () => mine) })).toBeNull();
    expect(client({ ...bare, seen: [{ snap: 'short', sig: SIG }] })).toBeNull();
    expect(client({ ...bare, seen: mine })).toBeNull();
  });
});

describe('protocol 10 refusals', () => {
  const batch = clientMsgs[4] as { i: (number | null)[][]; s: (string | null)[][] };

  it('refuses an unknown field at every level the witness messages define', () => {
    for (const m of clientMsgs) expect(client({ ...m, x: 1 }), m.t).toBeNull();
    for (const m of hubMsgs) expect(hub({ ...m, x: 1 }), m.t).toBeNull();
    for (const m of peerEvents) expect(peer({ ...m, x: 1 }), m.t).toBeNull();
    const audit = fightAudit.audit;
    expect(hub({ ...fightAudit, audit: { ...audit, x: 1 } })).toBeNull();
    expect(hub({ ...fightAudit, audit: { ...audit, log: { ...audit.log, x: 1 } } })).toBeNull();
    expect(hub({ ...genesisAudit, audit: { ...genesisAudit.audit, x: 1 } })).toBeNull();
    expect(hub({ ...matingAudit, audit: { ...matingAudit.audit, x: 1 } })).toBeNull();
    const frame = { ...(refereeDuty.history[0] as object), x: 1 };
    expect(hub({ ...refereeDuty, history: [frame] })).toBeNull();
    const signed = { attestation: { ...attestation, x: 1 }, sig: SIG };
    expect(client({ t: 'attest', signed })).toBeNull();
  });

  it('refuses a batch with a signature beside a null input, a missing one, 21 frames or width 5', () => {
    expect(client({ ...batch, s: [[SIG, SIG], ...batch.s.slice(1)] })).toBeNull();
    expect(client({ ...batch, s: [[null, null], ...batch.s.slice(1)] })).toBeNull();
    expect(client({ ...batch, s: batch.s.slice(1) })).toBeNull();
    expect(client({ ...batch, s: [[SIG], ...batch.s.slice(1)] })).toBeNull();
    const frames = (n: number) => ({
      ...batch,
      f: 0,
      i: Array.from({ length: n }, () => [1, 2]),
      s: Array.from({ length: n }, () => [SIG, SIG]),
    });
    expect(client(frames(20))).toEqual(frames(20));
    expect(client(frames(21))).toBeNull();
    expect(client(frames(0))).toBeNull();
    expect(client({ ...batch, i: [[1, 2, 3, 4, 5]], s: [[SIG, SIG, SIG, SIG, SIG]] })).toBeNull();
    expect(client({ ...batch, i: [[]], s: [[]] })).toBeNull();
    // Past frame 1000 (the last any encounter has).
    expect(client({ ...frames(2), f: 999 })).toEqual({ ...frames(2), f: 999 });
    expect(client({ ...frames(2), f: 1000 })).toBeNull();
    expect(client({ ...batch, i: [[U32 + 1, 0]], s: [[SIG, SIG]] })).toBeNull();
  });

  it('caps a batch at 12 KB and a duty at 128 KB, to the byte', () => {
    expect(BATCH_MAX_BYTES).toBe(12_288);
    expect(DUTY_MAX_BYTES).toBe(131_072);
    // The largest batch the shape allows, 20 frames of 4 signed inputs, fits: about 8.2 KB.
    const full = {
      t: 'batch',
      enc: HEX,
      f: 880,
      i: Array.from({ length: 20 }, () => [U32, U32, U32, U32]),
      s: Array.from({ length: 20 }, () => [SIG, SIG, SIG, SIG]),
      end: true,
    };
    const rawBatch = JSON.stringify(full);
    expect(rawBatch.length).toBeLessThan(BATCH_MAX_BYTES * 0.75);
    // JSON allows trailing white space, which pads a message without adding a field.
    const pad = (raw: string, to: number) => raw + ' '.repeat(to - raw.length);
    expect(parseClientMsg(pad(rawBatch, BATCH_MAX_BYTES))).toEqual(full);
    expect(parseClientMsg(pad(rawBatch, BATCH_MAX_BYTES + 1))).toBeNull();

    // The worst referee duty: 900 frames of 4 inputs, 2 joins and a full pool still fit.
    const pool = IDS;
    const big = (player: string) => info({ player, genome: 'A'.repeat(1900), x: 4096.123456789 });
    const worst = {
      ...refereeDuty,
      position: 15,
      commit: witnessCommit(ENC, pool),
      fighters: [PID, PID2, PID3, PID4],
      start: { ...start, fighters: [big(PID), big(PID2)] },
      history: [
        { t: 'enc-join', f: 0, fighter: big(PID3) },
        { t: 'enc-join', f: 0, fighter: big(PID4) },
        ...Array.from({ length: 900 }, (_, f) => ({ t: 'enc-frame', f, i: [U32, U32, U32, U32] })),
      ],
    };
    const rawDuty = JSON.stringify(worst);
    expect(rawDuty.length).toBeLessThan(DUTY_MAX_BYTES * 0.75);
    expect(parseHubMsg(rawDuty)).toEqual(worst);
    expect(parseHubMsg(pad(rawDuty, DUTY_MAX_BYTES))).toEqual(worst);
    expect(parseHubMsg(pad(rawDuty, DUTY_MAX_BYTES + 1))).toBeNull();
    expect(
      hub({ ...worst, history: [...worst.history, { t: 'enc-frame', f: 900, i: [1, 2] }] }),
    ).toBeNull();
    const frames901 = [...worst.history.slice(2), { t: 'enc-frame', f: 900, i: [1, 2, 3, 4] }];
    expect(hub({ ...worst, history: frames901 })).toBeNull();
  });

  it('caps a finput at the 2 KB of any peer event', () => {
    const raw = JSON.stringify(peerEvents[0]);
    expect(parsePeerEvent(raw + ' '.repeat(EVENT_MAX_BYTES - raw.length))).toEqual(peerEvents[0]);
    expect(parsePeerEvent(raw + ' '.repeat(EVENT_MAX_BYTES - raw.length + 1))).toBeNull();
  });

  it('keeps a duty consistent with its event, commitment, beacon and pool', () => {
    expect(hub({ ...refereeDuty, event: `enc:${HEX2}` })).toBeNull();
    expect(hub({ ...refereeDuty, commit: witnessCommit(`enc:${HEX2}`) })).toBeNull();
    expect(hub({ ...refereeDuty, beacon: { ...beacon, round: ROUND + 1 } })).toBeNull();
    // Position 3 of a pool of 3, and 16 of a full pool.
    expect(hub({ ...refereeDuty, position: 3 })).toBeNull();
    const pool = IDS;
    const full = { ...refereeDuty, commit: witnessCommit(ENC, pool) };
    expect(hub({ ...full, position: 15 })).toEqual({ ...full, position: 15 });
    expect(hub({ ...full, position: 16 })).toBeNull();
    // A commitment of another kind, or a witness commitment with an owner, an unsorted or a long pool.
    expect(hub({ ...refereeDuty, commit: genesisCommit })).toBeNull();
    const owned = witnessCommit();
    owned.commitment.owner = PID;
    expect(hub({ ...refereeDuty, commit: owned })).toBeNull();
    expect(hub({ ...refereeDuty, commit: witnessCommit(ENC, [PID2, PID]) })).toBeNull();
    expect(hub({ ...refereeDuty, commit: witnessCommit(ENC, [PID, PID]) })).toBeNull();
    const long = [...pool, 'z'.repeat(42) + 'A'].sort();
    expect(hub({ ...refereeDuty, commit: witnessCommit(ENC, long) })).toBeNull();
    expect(hub({ ...refereeDuty, commit: witnessCommit(ENC, []) })).toBeNull();
    // A referee duty is an encounter's; its start is that encounter's.
    const mating = `mating:${HEX}`;
    expect(hub({ ...refereeDuty, event: mating, commit: witnessCommit(mating) })).toBeNull();
    expect(hub({ ...refereeDuty, start: { ...start, enc: HEX2 } })).toBeNull();
    expect(hub({ ...refereeDuty, role: 'judge' })).toBeNull();
    // The fighters: 2 to 4 distinct player ids.
    expect(hub({ ...refereeDuty, fighters: [PID] })).toBeNull();
    expect(hub({ ...refereeDuty, fighters: [PID, PID] })).toBeNull();
    expect(hub({ ...refereeDuty, fighters: [PID, PID2, PID3, IDS[4], IDS[5]] })).toBeNull();
  });

  it('keeps a history in order: frames from 0, and joins no earlier than the frames before them', () => {
    const frame = (f: number) => ({ t: 'enc-frame', f, i: [1, 2] });
    const join = (f: number) => ({ t: 'enc-join', f, fighter: info({ player: PID3 }) });
    const withHistory = (history: unknown[]) => ({ ...refereeDuty, history });
    expect(hub(withHistory([]))).toEqual(withHistory([]));
    expect(hub(withHistory([frame(1)]))).toBeNull();
    expect(hub(withHistory([frame(0), frame(2)]))).toBeNull();
    expect(hub(withHistory([frame(0), frame(0)]))).toBeNull();
    // A join is due at a frame not yet finalized when it is sent.
    expect(hub(withHistory([frame(0), frame(1), join(2)]))).toEqual(
      withHistory([frame(0), frame(1), join(2)]),
    );
    expect(hub(withHistory([frame(0), frame(1), join(1)]))).toBeNull();
    expect(hub(withHistory([join(3), join(3), join(3)]))).toBeNull();
    expect(hub(withHistory([{ ...frame(0), enc: HEX }]))).toBeNull();
    expect(hub(withHistory([{ ...frame(0), i: [1] }]))).toBeNull();
  });

  it("matches an audit's case to its event", () => {
    // A fight's case for a genesis event, and the other way round.
    const genesis = `genesis:${HEX}`;
    expect(hub({ ...fightAudit, event: genesis, commit: witnessCommit(genesis) })).toBeNull();
    expect(hub({ ...genesisAudit, event: ENC, commit: witnessCommit(ENC) })).toBeNull();
    expect(hub({ ...matingAudit, audit: { ...matingAudit.audit, kind: 'genesis' } })).toBeNull();
    // A log or settlement of another fight.
    const audit = fightAudit.audit;
    const other = { ...settlement, settlement: { ...settlement.settlement, enc: HEX2 } };
    expect(hub({ ...fightAudit, audit: { ...audit, settlement: other } })).toBeNull();
    const log = (over: object) => ({
      ...fightAudit,
      audit: { ...audit, log: { ...audit.log, ...over } },
    });
    expect(hub(log({ start: { ...start, enc: HEX2 } }))).toBeNull();
    expect(hub(log({ joins: [{ ...audit.log.joins[0], enc: HEX2 }] }))).toBeNull();
    expect(hub(log({ frames: [[1]] }))).toBeNull();
    expect(hub(log({ frames: Array.from({ length: 1002 }, () => [1, 2]) }))).toBeNull();
    // The wrong commitment for its kind, and pairs that are not pairs.
    const mating = matingAudit.audit;
    expect(
      hub({ ...genesisAudit, audit: { ...genesisAudit.audit, commitment: mateCommit } }),
    ).toBeNull();
    expect(hub({ ...matingAudit, audit: { ...mating, commitment: genesisCommit } })).toBeNull();
    expect(hub({ ...matingAudit, audit: { ...mating, births: [record('birth')] } })).toBeNull();
    const three = [GENOME, GENOME, GENOME];
    expect(hub({ ...matingAudit, audit: { ...mating, parents: three } })).toBeNull();
    // An auditor duty carries no referee fields, and a referee duty no case.
    expect(hub({ ...fightAudit, pondSeed: 'x' })).toBeNull();
    expect(hub({ ...refereeDuty, audit: audit })).toBeNull();
  });

  it('refuses bad events, reasons, referees and attestations', () => {
    expect(client({ t: 'duty-ok', event: HEX })).toBeNull();
    expect(client({ t: 'duty-ok', event: `fight:${HEX}` })).toBeNull();
    expect(client({ t: 'avail', on: 1 })).toBeNull();
    expect(hub({ t: 'duty-end', event: ENC, why: 'bored' })).toBeNull();
    expect(hub({ t: 'enc-referee', enc: HEX, from: 1001, by: PID })).toBeNull();
    expect(hub({ t: 'enc-referee', enc: HEX, from: 3, by: 'witness' })).toBeNull();
    const signed = (a: object) => ({ t: 'attest', signed: { attestation: a, sig: SIG } });
    expect(client(signed({ ...attestation, code: 'x' }))).toBeNull();
    expect(client(signed({ ...attestation, position: 16 }))).toBeNull();
    expect(client({ t: 'attest', signed: { attestation, sig: 'short' } })).toBeNull();
    expect(client({ t: 'dispute', enc: HEX, f: 1, i: [], sig: SIG })).toBeNull();
    expect(peer({ t: 'wframe', enc: HEX, f: 1, i: [1, 2, 3, 4, 5], sig: SIG })).toBeNull();
    expect(peer({ t: 'finput', enc: HEX, f: 1, i: null, sig: SIG })).toBeNull();
    expect(peer({ t: 'probe', n: -1, back: true })).toBeNull();
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
/**
 * Leaves a poisoned value may still fill: a record's body takes any short string, and a record's
 * creature and previous hash take `''` (a genesis's). The record parser is protocol 3's, fuzzed there.
 */
const loose = (path: Path): boolean =>
  path.includes('body') ||
  (path.includes('record') && ['creature', 'prev'].includes(String(path.at(-1))));
const leafOf = (v: unknown, path: Path): unknown =>
  path.reduce<unknown>((at, key) => (at as Record<string | number, unknown>)[key], v);
function withLeaf(v: unknown, path: Path, value: unknown, remove: boolean): unknown {
  const copy = structuredClone(v) as Record<string | number, unknown>;
  let at = copy;
  for (const key of path.slice(0, -1)) at = at[key] as Record<string | number, unknown>;
  const last = path.at(-1) as string | number;
  if (remove && !Array.isArray(at)) delete at[last];
  else at[last] = value;
  return copy;
}

describe('protocol 10 fuzz', () => {
  const samples = [
    ...clientMsgs.map((m) => ({ m, parse: parseClientMsg })),
    ...hubMsgs.map((m) => ({ m, parse: parseHubMsg })),
    ...peerEvents.map((m) => ({ m, parse: parsePeerEvent })),
  ];

  it('parses nothing malformed: 10,000 valid messages with one field poisoned or removed', () => {
    const rng = createRng(seedFromString('fuzz-protocol-10'), 'net');
    const parsed: unknown[] = [];
    for (let n = 0; n < 10_000; n++) {
      const { m, parse } = samples[rng.int(0, samples.length - 1)] as (typeof samples)[number];
      const paths = leaves(m).filter((p) => !loose(p));
      const path = paths[rng.int(0, paths.length - 1)] as Path;
      // An attestation's code may be absent (it is, beside agree: true).
      const remove = rng.int(0, 3) === 0 && path.at(-1) !== 'code';
      const poison = POISON[rng.int(0, POISON.length - 1)];
      // A witness commitment's owner is '' already, so '' leaves it as it was.
      if (!remove && poison === leafOf(m, path)) continue;
      const bad = withLeaf(m, path, poison, remove);
      if (parse(JSON.stringify(bad)) !== null) parsed.push({ path, bad });
    }
    expect(parsed).toEqual([]);
  });

  it('never throws on 10,000 random JSON values per parser, and what parses is stable', () => {
    const rng = createRng(seedFromString('fuzz-protocol-10-json'), 'net');
    const keys = ['t', 'enc', 'f', 'i', 's', 'end', 'event', 'role', 'position', 'commit'];
    keys.push('beacon', 'history', 'audit', 'kind', 'log', 'frames', 'signed', 'sig', 'n', 'on');
    const types = ['avail', 'duty-ok', 'batch', 'dispute', 'attest', 'duty', 'duty-end'];
    types.push('duty-peer', 'enc-referee', 'finput', 'wframe', 'probe', 'enc-frame', 'enc-join');
    const atoms = [HEX, PID, SIG, ENC, 'referee', 'auditor', 'authority', 'witness', 0, U32];
    const value = (depth: number): unknown => {
      switch (rng.int(0, depth > 2 ? 3 : 5)) {
        case 0:
          return rng.int(-5, 5) * 10 ** rng.int(0, 12);
        case 1:
          return [null, true, false][rng.int(0, 2)];
        case 2:
          return [...atoms, ...types][rng.int(0, atoms.length + types.length - 1)];
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
    for (const parse of [parseClientMsg, parseHubMsg, parsePeerEvent] as const) {
      for (let n = 0; n < 10_000; n++) {
        const v = value(0);
        const raw = JSON.stringify(
          typeof v === 'object' && v && !Array.isArray(v) && rng.int(0, 1) === 1
            ? { ...v, t: types[rng.int(0, types.length - 1)] }
            : v,
        );
        const got = parse(raw);
        if (got) expect(parse(JSON.stringify(got))).toEqual(got);
      }
    }
  });

  it('never throws on 10,000 random byte strings, nor on valid messages cut short', () => {
    const rng = createRng(seedFromString('fuzz-protocol-10-bytes'), 'net');
    let parsed = 0;
    for (let n = 0; n < 10_000; n++) {
      const bytes = Array.from({ length: rng.int(0, 300) }, () => rng.int(0, 255));
      const raw = String.fromCharCode(...bytes);
      if (parseClientMsg(raw) || parseHubMsg(raw) || parsePeerEvent(raw)) parsed++;
      const { m, parse } = samples[rng.int(0, samples.length - 1)] as (typeof samples)[number];
      const whole = JSON.stringify(m);
      if (parse(whole.slice(0, rng.int(0, whole.length - 1)))) parsed++;
    }
    expect(parsed).toBe(0);
  });
});
