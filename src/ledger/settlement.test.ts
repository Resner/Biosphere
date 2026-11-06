import { readFileSync } from 'node:fs';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import { describe, expect, it } from 'vitest';
import type { EncJoin, EncStart } from '../net/encounter-start';
import { canonicalize, hashWithDomain } from './canonical';
import type { PubKey, StoredRecord } from './record';
import {
  checkSettledRecords,
  checkSettlementSig,
  type FightLog,
  f64Hex,
  frameLeaf,
  joinHash,
  merkleProof,
  merkleRoot,
  parseRefereeSpans,
  REFEREE_SPANS_MAX,
  type RefereeSpan,
  refereeSpanProblems,
  refereesOf,
  type SettlementV1,
  type SettlementV2,
  type SignedSettlement,
  settlementHash,
  startHash,
  verifyProof,
} from './settlement';

// ADR 0054: the settlement's leaves, its RFC 6962 tree, its hashes and the records it must agree
// with. `src/net/encounter-verify.test.ts` builds the golden and replays it.

interface GoldenFight {
  log: FightLog;
  settlement: SignedSettlement;
  records: StoredRecord[];
}
const golden = JSON.parse(
  readFileSync(new URL('./__golden__/settlement.json', import.meta.url), 'utf8'),
) as { keys: PubKey[]; fights: Record<'duel' | 'join', GoldenFight> };

const bytes = (hex: string) => hexToBytes(hex);

describe('frameLeaf', () => {
  it('tags the frame, its width and each slot: 0xFF for the fallback marker, else 0x00 and the u32', () => {
    const tag = new TextEncoder().encode('bs/enc/frame/v1');
    const leaf = frameLeaf(258, [null, 0x01020304]);
    expect(leaf.subarray(0, tag.length)).toEqual(tag);
    expect(bytesToHex(leaf.subarray(tag.length))).toBe('010202' + 'ff' + '0001020304');
    expect(bytesToHex(frameLeaf(0, []).subarray(tag.length))).toBe('000000');
  });

  it('refuses what it cannot encode', () => {
    expect(() => frameLeaf(-1, [])).toThrow(RangeError);
    expect(() => frameLeaf(65_536, [])).toThrow(RangeError);
    expect(() => frameLeaf(1, [2 ** 32])).toThrow(RangeError);
    expect(() => frameLeaf(1, [1.5])).toThrow(RangeError);
  });
});

describe('the Merkle tree (RFC 6962)', () => {
  // The Certificate Transparency reference vectors: eight leaves and the root of each prefix.
  const LEAVES = [
    '',
    '00',
    '10',
    '2021',
    '3031',
    '40414243',
    '5051525354555657',
    '606162636465666768696a6b6c6d6e6f',
  ].map(bytes);
  const ROOTS: Record<number, string> = {
    1: '6e340b9cffb37a989ca544e6bb780a2c78901d3fb33738768511a30617afa01d',
    2: 'fac54203e7cc696cf0dfcb42c92a1d9dbaf70ad9e621f4bd8d98662f00e3c125',
    3: 'aeb6bcfe274b70a14fb067a5e5578264db0fa9b51af5e0ba159158f329e06e77',
    7: 'ddb89be403809e325750d3d263cd78929c2942b7942a34b77e122c9594a74c8c',
  };

  it('gives the reference roots for 1, 2, 3 and 7 leaves, and SHA-256 of nothing for none', () => {
    for (const [n, root] of Object.entries(ROOTS)) {
      expect(merkleRoot(LEAVES.slice(0, Number(n)))).toBe(root);
    }
    expect(merkleRoot([])).toBe(bytesToHex(sha256(new Uint8Array(0))));
  });

  it('proves every leaf of every tree from 1 to 33 leaves, and nothing else', () => {
    for (let count = 1; count <= 33; count++) {
      const leaves = Array.from({ length: count }, (_, f) => frameLeaf(f, [f, null]));
      const root = merkleRoot(leaves);
      for (let i = 0; i < count; i++) {
        const leaf = leaves[i] as Uint8Array;
        const proof = merkleProof(leaves, i);
        expect(verifyProof(root, leaf, i, count, proof), `${i} of ${count}`).toBe(true);
        if (count > 1) {
          const other = (i + 1) % count;
          expect(verifyProof(root, leaf, other, count, proof), `index ${other}`).toBe(false);
          expect(verifyProof(root, leaves[other] as Uint8Array, i, count, proof)).toBe(false);
        }
        expect(verifyProof(root, frameLeaf(i, [i, 0]), i, count, proof)).toBe(false);
        expect(verifyProof(root, leaf, count, count, proof)).toBe(false);
      }
    }
    expect(() => merkleProof([frameLeaf(0, [])], 1)).toThrow(RangeError);
  });

  it('never throws on a malformed proof', () => {
    const leaves = [frameLeaf(0, [1]), frameLeaf(1, [2])];
    const root = merkleRoot(leaves);
    const leaf = leaves[0] as Uint8Array;
    expect(verifyProof(root, leaf, 0, 2, ['zz'])).toBe(false);
    expect(verifyProof('nope', leaf, 0, 2, merkleProof(leaves, 0))).toBe(false);
    expect(verifyProof(root, leaf, 0.5, 2, merkleProof(leaves, 0))).toBe(false);
    expect(verifyProof(root, leaf, 0, 2, [...merkleProof(leaves, 0), root])).toBe(false);
  });
});

describe('the start, join and settlement hashes', () => {
  const { duel, join } = golden.fights;

  it('writes doubles as the 16 hex digits of their IEEE-754 bits', () => {
    expect(f64Hex(1)).toBe('3ff0000000000000');
    expect(f64Hex(-0)).toBe('8000000000000000');
    expect(f64Hex(Math.PI)).toBe('400921fb54442d18');
  });

  it('cover every field of the start, and the pond', () => {
    const start = duel.log.start;
    const h = startHash(duel.log.pondSeed, start);
    expect(h).toBe(duel.settlement.settlement.start);
    expect(startHash('other-pond', start)).not.toBe(h);
    const fighter = start.fighters[0] as EncStart['fighters'][number];
    const tweaks: Partial<EncStart>[] = [{ t0: start.t0 + 1 }, { at: start.at + 1 }, { round: 1 }];
    for (const tweak of tweaks)
      expect(startHash(duel.log.pondSeed, { ...start, ...tweak })).not.toBe(h);
    for (const key of ['x', 'heading', 'worth', 'elder', 'genome'] as const) {
      const value = fighter[key];
      const changed =
        typeof value === 'number' ? value + 1 : typeof value === 'boolean' ? !value : `${value}A`;
      const fighters = [{ ...fighter, [key]: changed }, ...start.fighters.slice(1)];
      expect(startHash(duel.log.pondSeed, { ...start, fighters }), key).not.toBe(h);
    }
    // A structured clone hashes the same.
    expect(startHash(duel.log.pondSeed, structuredClone(start))).toBe(h);
  });

  it('cover a join and its frame', () => {
    const j = join.log.joins[0] as EncJoin;
    expect(join.settlement.settlement.joins).toEqual([joinHash(j)]);
    expect(joinHash({ ...j, f: j.f + 1 })).not.toBe(joinHash(j));
  });

  it('hash the document under bs/settle/v1, and check its countersignature', () => {
    const s = duel.settlement;
    expect(s.hash).toBe(hashWithDomain('bs/settle/v1', canonicalize(s.settlement as never)));
    expect(settlementHash(s.settlement)).toBe(s.hash);
    expect(checkSettlementSig(s, golden.keys)).toEqual([]);
    expect(checkSettlementSig({ ...s, keyId: 'AAAAAAAA' }, golden.keys)).toEqual(['key']);
    expect(checkSettlementSig({ ...s, hash: 'f'.repeat(64) }, golden.keys)).toEqual(['signature']);
    expect(checkSettlementSig({ ...s, authSig: 'x' }, golden.keys)).toEqual(['signature']);
    expect(
      checkSettlementSig({ ...s, settlement: { ...s.settlement, t: 1 } }, golden.keys),
    ).toEqual(['signature']);
  });
});

describe('checkSettledRecords', () => {
  const { duel, join } = golden.fights;
  type Body = StoredRecord['record']['body'];
  const withBody = (
    records: StoredRecord[],
    i: number,
    change: (b: Record<string, unknown>) => void,
  ) => {
    const out = structuredClone(records);
    change((out[i] as StoredRecord).record.body as Record<string, unknown>);
    return out;
  };
  const index = (records: StoredRecord[], kind: string) =>
    records.findIndex((r) => r.record.kind === kind);

  it("passes the golden's records", () => {
    expect(checkSettledRecords(duel.settlement.settlement, duel.records)).toEqual([]);
    expect(checkSettledRecords(join.settlement.settlement, join.records)).toEqual([]);
    expect(duel.records.map((r) => r.record.kind).sort()).toEqual(['death', 'encounter']);
  });

  it('names a survivor record whose condition, outcome, frames or reward disagree', () => {
    const s = duel.settlement.settlement;
    const i = index(duel.records, 'encounter');
    const cases: [string, (b: Record<string, unknown>) => void][] = [
      [
        'biomass',
        (b) => {
          b.biomass = (b.biomass as number) + 1;
        },
      ],
      [
        'energy',
        (b) => {
          b.energy = (b.energy as number) - 1;
        },
      ],
      [
        'health',
        (b) => {
          b.health = 0;
        },
      ],
      [
        'outcome',
        (b) => {
          b.outcome = b.outcome === 'stood' ? 'escaped' : 'stood';
        },
      ],
      [
        'frames',
        (b) => {
          b.frames = (b.frames as number) + 1;
        },
      ],
      [
        'reward',
        (b) => {
          b.reward = (b.reward as number) * 2 + 1;
        },
      ],
    ];
    for (const [field, change] of cases) {
      expect(checkSettledRecords(s, withBody(duel.records, i, change))).toEqual([
        `record:${i}:${field}`,
      ]);
    }
  });

  it('names a death whose cause, biomass or killer disagree', () => {
    const s = duel.settlement.settlement;
    const i = index(duel.records, 'death');
    const cases: [string, (b: Record<string, unknown>) => void][] = [
      [
        'cause',
        (b) => {
          b.cause = 'toxin';
        },
      ],
      [
        'biomass',
        (b) => {
          b.biomass = (b.biomass as number) + 1;
        },
      ],
      [
        'by',
        (b) => {
          b.by = 'f'.repeat(64);
        },
      ],
      [
        'by',
        (b) => {
          delete b.by;
        },
      ],
    ];
    for (const [field, change] of cases) {
      expect(checkSettledRecords(s, withBody(duel.records, i, change))).toEqual([
        `record:${i}:${field}`,
      ]);
    }
  });

  it('names a record of the wrong kind, owner, rules or creature, and skips other fights', () => {
    const s = duel.settlement.settlement;
    const i = index(duel.records, 'encounter');
    const swap = structuredClone(duel.records);
    const r = (swap[i] as StoredRecord).record;
    r.kind = 'death';
    expect(checkSettledRecords(s, swap)).toEqual([`record:${i}:kind`]);
    const owner = structuredClone(duel.records);
    (owner[i] as StoredRecord).record.owner = (duel.records[1 - i] as StoredRecord).record.owner;
    expect(checkSettledRecords(s, owner)).toEqual([`record:${i}:player`]);
    const rules = structuredClone(duel.records);
    (rules[i] as StoredRecord).record.rules -= 1;
    expect(checkSettledRecords(s, rules)).toEqual([`record:${i}:rules`]);
    const stranger = structuredClone(duel.records);
    (stranger[i] as StoredRecord).record.creature = '9'.repeat(64);
    expect(checkSettledRecords(s, stranger)).toEqual([`record:${i}:creature`]);
    const elsewhere = withBody(duel.records, i, (b) => {
      b.enc = '9'.repeat(64);
    });
    expect(checkSettledRecords(s, elsewhere)).toEqual([]);
  });

  it("checks an eaten egg's child against its carrier and the eater", () => {
    const s = structuredClone(duel.settlement.settlement);
    const victim = s.results[1] as (typeof s.results)[number];
    const carrier = s.results[0] as (typeof s.results)[number];
    carrier.egg = 'eaten';
    carrier.eggBy = 1;
    const child: StoredRecord = structuredClone(duel.records[0] as StoredRecord);
    child.record = {
      ...child.record,
      kind: 'death',
      creature: '8'.repeat(64),
      owner: carrier.player,
      body: { cause: 'eaten', enc: s.enc, by: victim.creature } as Body,
    };
    expect(checkSettledRecords(s, [child])).toEqual([]);
    const wrongEater = structuredClone(child);
    wrongEater.record.body.by = carrier.creature;
    expect(checkSettledRecords(s, [wrongEater])).toEqual(['record:0:by']);
    const notCarrier = structuredClone(child);
    notCarrier.record.owner = victim.player;
    expect(checkSettledRecords(s, [notCarrier])).toEqual(['record:0:creature']);
  });
});

describe('settlement versions (ADR 0058)', () => {
  const W = 'O2onvM62pC1io6jQKm8Nc2UyFXcd4kOmOsBIoYtZ2ik';
  const v1 = (): SettlementV1 =>
    structuredClone(golden.fights.duel.settlement.settlement) as SettlementV1;
  const v2 = (referees: RefereeSpan[], frames = 100): SettlementV2 => {
    const { referee: _, ...rest } = v1();
    return { ...rest, v: 2, frames, referees, duty: 'ab'.repeat(32) };
  };

  it('reads version 1 as the authority refereeing from frame 0', () => {
    expect(v1().v).toBe(1);
    expect(refereesOf(v1())).toEqual([{ by: 'authority', from: 0 }]);
    expect(refereeSpanProblems(v1())).toEqual([]);
    expect(checkSettlementSig(golden.fights.duel.settlement, golden.keys)).toEqual([]);
  });

  it('checks the spans: from 0 with the authority, increasing, within the fight, a witness with its position', () => {
    const A = { by: 'authority', from: 0 };
    expect(refereeSpanProblems(v2([A]))).toEqual([]);
    expect(
      refereeSpanProblems(v2([A, { by: W, from: 40, position: 0 }, { by: 'authority', from: 60 }])),
    ).toEqual([]);
    expect(refereeSpanProblems(v2([]))).toEqual(['spans-start']);
    expect(refereeSpanProblems(v2([{ by: 'authority', from: 3 }]))).toEqual(['spans-start']);
    expect(refereeSpanProblems(v2([{ by: W, from: 0, position: 0 }]))).toEqual(['spans-start']);
    expect(
      refereeSpanProblems(v2([A, { by: W, from: 40, position: 0 }, { by: 'authority', from: 40 }])),
    ).toEqual(['spans-order']);
    expect(refereeSpanProblems(v2([A, { by: W, from: 100, position: 0 }]))).toEqual([
      'spans-frames',
    ]);
    expect(refereeSpanProblems(v2([A, { by: W, from: 40 }]))).toEqual(['spans-position']);
    expect(refereeSpanProblems(v2([{ ...A, position: 0 }]))).toEqual(['spans-position']);
  });

  it('parses spans by shape only, refusing unknown fields and what no span can be', () => {
    const spans = [
      { by: 'authority', from: 0 },
      { by: W, from: 40, position: 15 },
    ];
    expect(parseRefereeSpans(spans)).toEqual(spans);
    // Out of order is the verifier's to name, not the parser's.
    expect(
      parseRefereeSpans([
        { by: W, from: 9, position: 0 },
        { by: 'authority', from: 2 },
      ]),
    ).not.toBeNull();
    const bad: unknown[] = [
      [],
      Array(REFEREE_SPANS_MAX + 1).fill({ by: 'authority', from: 0 }),
      [{ by: 'someone', from: 0 }],
      [{ by: 'authority', from: -1 }],
      [{ by: 'authority', from: 65_536 }],
      [{ by: W, from: 1, position: 16 }],
      [{ by: W, from: 1, position: 1.5 }],
      [{ by: 'authority', from: 0, extra: 1 }],
      [null],
      'spans',
    ];
    for (const v of bad) expect(parseRefereeSpans(v), JSON.stringify(v)).toBeNull();
  });

  it('hashes version 2 over its spans and duty, and countersigns either', () => {
    const doc = v2([
      { by: 'authority', from: 0 },
      { by: W, from: 40, position: 0 },
    ]);
    const moved = structuredClone(doc);
    (moved.referees[1] as RefereeSpan).from = 41;
    expect(settlementHash(moved)).not.toBe(settlementHash(doc));
    expect(settlementHash({ ...doc, duty: '' })).not.toBe(settlementHash(doc));
    expect(settlementHash(doc)).not.toBe(settlementHash(v1()));
    expect(checkSettledRecords(doc, golden.fights.duel.records)).toEqual([]);
  });
});
