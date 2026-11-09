import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { decodeGenome, genomeFromBase64url, genomeHash, genomeToBase64url } from '../genome/codec';
import { describeCreature } from '../genome/describe';
import { develop, hashPlan } from '../genome/develop';
import { express } from '../genome/express';
import { genesisGenome } from '../genome/genesis';
import { breed, offspringSeed } from '../genome/inherit';
import { offspringPair } from '../genome/offspring';
import { rarityOf } from '../genome/rarity';
import { buildCreature, hashStats } from '../genome/stats';
import { type Beacon, randomnessOf } from '../ledger/drand';
import { entryHash } from '../ledger/frozen';
import { growthReach } from '../ledger/gates';
import { genesisFor } from '../ledger/genesis';
import type { ProofBundle } from '../ledger/proof';
import { type LedgerRecord, recordHash, requestHash, type StoredRecord } from '../ledger/record';
import {
  checkSettledRecords,
  checkSettlementSig,
  type SignedSettlement,
} from '../ledger/settlement';
import { verifyLineage } from '../ledger/verify';
import { type EncounterLog, replayEncounter } from '../sim/encounter/replay';
import { atan2, cos, exp, log, pow, sin } from '../sim/math';
import { seedFromString } from '../sim/prng';
import { type InputLog, replay } from '../sim/replay';

// The golden sets (M14 T5): each recomputes, in the page's own bundle, what a golden file pins.
// `window.__bs.goldens.run(set, input)` loads this module on first use; `tests/goldens-catalogue.ts`
// builds each set's input and expected output in Node, and `tests/goldens-catalogue.test.ts` runs the
// same functions in Node, so the page and the unit tests share one implementation.

const view = new DataView(new ArrayBuffer(8));
const bits = (x: number): string => {
  view.setFloat64(0, x);
  return view.getBigUint64(0).toString(16).padStart(16, '0');
};
const fromBits = (hex: string): number => {
  view.setBigUint64(0, BigInt(`0x${hex}`));
  return view.getFloat64(0);
};

const MATH: Record<string, (...a: number[]) => number> = {
  sin: (a) => sin(a as number),
  cos: (a) => cos(a as number),
  atan2: (y, x) => atan2(y as number, x as number),
  exp: (a) => exp(a as number),
  log: (a) => log(a as number),
  pow: (a, b) => pow(a as number, b as number),
};

const hexBytes = (hex: string): Uint8Array =>
  Uint8Array.from({ length: hex.length / 2 }, (_, i) =>
    Number.parseInt(hex.slice(2 * i, 2 * i + 2), 16),
  );

const genomeOf = (text: string) => {
  const g = genomeFromBase64url(text);
  if (!g) throw new RangeError('not a base64url genome');
  return g;
};

type Fn = (input: never) => unknown;

const SETS: Record<string, Fn> = {
  /** `{ fn: [[input bits…]] }` -> `{ fn: [output bits] }`. */
  math: (input: Record<string, string[][]>) =>
    Object.fromEntries(
      Object.entries(input).map(([name, rows]) => {
        const fn = MATH[name];
        if (!fn) throw new RangeError(`unknown function ${name}`);
        return [name, rows.map((ins) => bits(fn(...ins.map(fromBits))))];
      }),
    ),
  /** `{ name: InputLog }` -> `{ name: { hash, events } }`. */
  replay: (input: Record<string, InputLog>) =>
    Object.fromEntries(
      Object.entries(input).map(([name, log]) => {
        const { hash, events } = replay(log);
        return [name, { hash, events }];
      }),
    ),
  /** `{ name: EncounterLog }` -> `{ name: { hash, results } }`. */
  encounter: (input: Record<string, EncounterLog>) =>
    Object.fromEntries(
      Object.entries(input).map(([name, log]) => {
        const { hash, results } = replayEncounter(log);
        return [name, { hash, results }];
      }),
    ),
  /** `{ name: genome bytes (hex) }` -> `{ name: plan hash }`. */
  develop: (input: Record<string, string>) =>
    Object.fromEntries(
      Object.entries(input).map(([name, hex]) => [
        name,
        hashPlan(develop(express(decodeGenome(hexBytes(hex))))),
      ]),
    ),
  /** `{ name: genome bytes (hex) }` -> `{ name: sha-256 of the traits' JSON }`. */
  express: (input: Record<string, string>) =>
    Object.fromEntries(
      Object.entries(input).map(([name, hex]) => [
        name,
        bytesToHex(
          sha256(new TextEncoder().encode(JSON.stringify(express(decodeGenome(hexBytes(hex)))))),
        ),
      ]),
    ),
  /** `{ name: genome (base64url) }` -> `{ name: { genome, planHash, statsHash } }`. */
  stats: (input: Record<string, string>) =>
    Object.fromEntries(
      Object.entries(input).map(([name, bytes]) => {
        const g = genomeOf(bytes);
        const c = buildCreature(g);
        return [
          name,
          {
            genome: genomeToBase64url(g),
            planHash: hashPlan(c.plan),
            statsHash: hashStats(c.stats),
          },
        ];
      }),
    ),
  /** `{ seed text }[]` -> `{ seed: genome hash of its genesis }`. */
  genesis: (input: string[]) =>
    Object.fromEntries(input.map((s) => [s, genomeHash(genesisGenome(seedFromString(s)))])),
  /** `{ name: bytes (hex) }` -> `{ name: genome hash }`, over the bytes decoded as a genome. */
  'genome-hash': (input: Record<string, string>) =>
    Object.fromEntries(
      Object.entries(input).map(([name, hex]) => [name, genomeHash(decodeGenome(hexBytes(hex)))]),
    ),
  /** `{ name: { a, b, fill, label } }` (parent seeds, a randomness fill byte, a commit id) -> `{ name: child hash }`. */
  inherit: (input: Record<string, { a: string; b: string; fill: number; label: string }>) =>
    Object.fromEntries(
      Object.entries(input).map(([name, { a, b, fill, label }]) => [
        name,
        genomeHash(
          breed(
            genesisGenome(seedFromString(a)),
            genesisGenome(seedFromString(b)),
            offspringSeed(new Uint8Array(32).fill(fill), label, 0),
          ),
        ),
      ]),
    ),
  /** `{ beacons, pairs, rounds }`: the drand fixture beacons, parent pair indices and rounds -> the pair vectors. */
  offspring: (input: { beacons: Beacon[]; rounds: number[]; pairs: number[] }) => {
    const hex = (i: number) => i.toString(16).padStart(64, '0');
    const beacon0 = randomnessOf(input.beacons[0] as Beacon);
    return input.rounds.flatMap((round) =>
      input.pairs.map((pair) => {
        const a = genesisFor(beacon0, hex(10 * pair + 1));
        const b = genesisFor(beacon0, hex(10 * pair + 2));
        const beacon = input.beacons[round] as Beacon;
        const { children, slots } = offspringPair(randomnessOf(beacon), hex(100 + round), a, b);
        return {
          round: beacon.round,
          parents: [genomeHash(a), genomeHash(b)],
          children: children.map(genomeHash),
          slots,
        };
      }),
    );
  },
  /** `{ name: genome (base64url) }` -> `{ name: rarity }`, the score to 6 decimals. */
  rarity: (input: Record<string, string>) =>
    Object.fromEntries(
      Object.entries(input).map(([name, text]) => {
        const r = rarityOf(genomeOf(text));
        return [name, { ...r, score: Number(r.score.toFixed(6)) }];
      }),
    ),
  /** `{ name: genome (base64url) }` -> `{ name: sentences }`. */
  describe: (input: Record<string, string>) =>
    Object.fromEntries(
      Object.entries(input).map(([name, text]) => [
        name,
        describeCreature(buildCreature(genomeOf(text))),
      ]),
    ),
  /** `{ name: record }` -> `{ name: { record, hash, requestHash } }`. */
  records: (input: Record<string, LedgerRecord>) =>
    Object.fromEntries(
      Object.entries(input).map(([name, record]) => [
        name,
        { record, hash: recordHash(record), requestHash: requestHash(record) },
      ]),
    ),
  /** `{ name: record }` -> `{ name: { record, hash } }`. */
  kinds: (input: Record<string, LedgerRecord>) =>
    Object.fromEntries(
      Object.entries(input).map(([name, record]) => [name, { record, hash: recordHash(record) }]),
    ),
  /**
   * `{ keys, fights: { name: { settlement, records } } }` -> per fight the authority signature's
   * problems, the settled records' problems and the hash of each record.
   */
  settlement: (input: {
    keys: Parameters<typeof checkSettlementSig>[1];
    fights: Record<string, { settlement: SignedSettlement; records: StoredRecord[] }>;
  }) =>
    Object.fromEntries(
      Object.entries(input.fights).map(([name, fight]) => [
        name,
        {
          signature: checkSettlementSig(fight.settlement, input.keys),
          records: checkSettledRecords(fight.settlement.settlement, fight.records),
          hashes: fight.records.map((r) => recordHash(r.record)),
        },
      ]),
    ),
  /** A proof bundle -> the verifier's report, in part. */
  lineage: (input: ProofBundle) => {
    const { problems, subject, held, missing, scaled, keys } = verifyLineage(input);
    return { problems, subject, held, missing, scaled, keys };
  },
  /**
   * `{ files: { path: text }, entries: { version: { path: hash } } }` -> the SHA-256 of each
   * file's bytes and the hash of each version's entry (`src/ledger/frozen.ts`).
   */
  frozen: (input: {
    files: Record<string, string>;
    entries: Record<string, Record<string, string>>;
  }) => ({
    files: Object.fromEntries(
      Object.entries(input.files).map(([path, text]) => [
        path,
        bytesToHex(sha256(new TextEncoder().encode(text))),
      ]),
    ),
    entries: Object.fromEntries(
      Object.entries(input.entries).map(([version, entry]) => [version, entryHash(entry)]),
    ),
  }),
  /** `{ seed, from, activeMs }[]` -> the same with `reach`. */
  'growth-reach': (input: { seed: string; from: number; activeMs: number }[]) =>
    input.map(({ seed, from, activeMs }) => ({
      seed,
      from,
      activeMs,
      reach: growthReach(from, genesisGenome(seedFromString(seed)), activeMs),
    })),
};

/** The sets this module computes, for the test that keeps `golden-names.ts` in step. */
export const COMPUTED_SETS: readonly string[] = Object.keys(SETS);

/** Runs one set on its input (JSON in, JSON out). */
export function runGolden(set: string, input: unknown): unknown {
  const fn = SETS[set];
  if (!fn) throw new RangeError(`unknown golden set ${set}`);
  return (fn as (i: unknown) => unknown)(input);
}
