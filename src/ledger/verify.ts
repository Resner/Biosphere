import type { SignedCommit } from '../net/protocol-defs';
import type { Beacon } from './drand';
import { commitmentId } from './genesis';
import type { AuthorityKey, ProofBundle } from './proof';
import { authorityKeyId, type PubKey, type StoredRecord } from './record';
import type { FightLog, SignedSettlement } from './settlement';
import { creatureOf, verifyChain, verifySignatures } from './verify-chain';
import { fightsOf, verifyFights } from './verify-fights';
import { verifyGates } from './verify-gates';
import { reachOf, verifyOrigin } from './verify-origin';

// The lineage verifier (ADR 0055): a proof bundle checked in five families, with no trust in the
// authority beyond its signing keys and none in any player. Each family lives in its own file as
// `(index, opts) => Problem[]`; this one indexes the bundle, runs them and writes the report. Pure
// and shared by the card, the CLI and the tests: no DOM, no Node APIs, no `src/net` at run time.

export type Family = 'chain' | 'signature' | 'origin' | 'gates' | 'fights';

/** One thing that does not hold: on a creature, at a record (`seq`) or on the creature as a whole (null). */
export interface Problem {
  creature: string;
  seq: number | null;
  family: Family;
  code: string;
}

export interface LineageReport {
  subject: string;
  /** Empty when everything checked holds. */
  problems: Problem[];
  /** Creatures checked. */
  held: number;
  /** `bundle.more`: parents not in the bundle, so not checked. */
  missing: string[];
  /** Every ancestor path of the subject ends at a held, checked genesis. */
  toGenesis: boolean;
  /** Generations back from the subject the checked graph reaches. */
  generations: number;
  fights: { settled: number; replayed: number; pruned: number; unreplayed: number };
  /** A scale below 1: a test world. */
  scaled: boolean;
  /** Whose keys the countersignatures were checked against: the bundle's, or ones the caller pinned. */
  keys: 'bundle' | 'pinned';
}

export interface VerifyOptions {
  /** Pinned keys in place of the bundle's. */
  keys?: readonly AuthorityKey[];
  /** Fight logs by encounter id; null for a pruned one. */
  logs?: ReadonlyMap<string, FightLog | null>;
  /** Replays a settlement from its log (`verifyEncounter`, which lives in `src/net`). */
  replay?: (s: SignedSettlement, log: FightLog, keys: readonly PubKey[]) => string[];
}

/** The bundle looked up the ways the families need it. Records of a creature are in `seq` order. */
export interface BundleIndex {
  bundle: ProofBundle;
  /** Held creatures in bundle order: id to genome text. */
  creatures: ReadonlyMap<string, string>;
  /** Each creature's records (by `record.creature`, or a first record's hash), sorted by `seq`. */
  records: ReadonlyMap<string, readonly StoredRecord[]>;
  /** Records of no held creature. */
  stray: readonly StoredRecord[];
  /** Commitments by their id (`commitmentId`). */
  commits: ReadonlyMap<string, SignedCommit>;
  beacons: ReadonlyMap<number, Beacon>;
  /** Settlements by encounter id. */
  settlements: ReadonlyMap<string, SignedSettlement>;
  /** The keys in force, by id: `opts.keys`, else the bundle's, each only if its id derives from its key. */
  keys: ReadonlyMap<string, AuthorityKey>;
  /** A held creature's biological parents (its birth's), or null for a genesis creature or none known. */
  parents: ReadonlyMap<string, readonly [string, string] | null>;
  /** A held creature's chain parent (its child `promote`'s), or null. */
  chainParent: ReadonlyMap<string, string | null>;
}

function keysInForce(keys: readonly AuthorityKey[]): Map<string, AuthorityKey> {
  const out = new Map<string, AuthorityKey>();
  for (const k of keys) {
    try {
      if (!out.has(k.id) && authorityKeyId(k.publicKey) === k.id) out.set(k.id, k);
    } catch {
      // A key that is no key is in force for nothing.
    }
  }
  return out;
}

export function indexBundle(bundle: ProofBundle, opts: VerifyOptions = {}): BundleIndex {
  const creatures = new Map<string, string>();
  for (const c of bundle.creatures) if (!creatures.has(c.id)) creatures.set(c.id, c.genome);
  const records = new Map<string, StoredRecord[]>();
  const stray: StoredRecord[] = [];
  for (const s of bundle.records) {
    const id = creatureOf(s);
    if (!creatures.has(id)) {
      stray.push(s);
      continue;
    }
    const chain = records.get(id);
    if (chain) chain.push(s);
    else records.set(id, [s]);
  }
  for (const chain of records.values()) chain.sort((a, b) => a.record.seq - b.record.seq);
  const commits = new Map<string, SignedCommit>();
  for (const c of bundle.commits) {
    try {
      commits.set(commitmentId(c.commitment), c);
    } catch {
      // A commitment that does not hash names nothing.
    }
  }
  const parents = new Map<string, readonly [string, string] | null>();
  const chainParent = new Map<string, string | null>();
  for (const id of creatures.keys()) {
    const chain = records.get(id) ?? [];
    const first = chain[0]?.record;
    const named = first?.kind === 'birth' ? first.body.parents : null;
    parents.set(
      id,
      Array.isArray(named) && named.length === 2 ? (named as [string, string]) : null,
    );
    const promote = chain.find(
      (s) => s.record.kind === 'promote' && s.record.body.role === 'child',
    );
    const parent = promote?.record.body.parent;
    chainParent.set(id, typeof parent === 'string' ? parent : null);
  }
  return {
    bundle,
    creatures,
    records,
    stray,
    commits,
    beacons: new Map(bundle.beacons.map((b) => [b.round, b])),
    settlements: new Map(bundle.settlements.map((s) => [s.settlement.enc, s])),
    keys: keysInForce(opts.keys ?? bundle.keys),
    parents,
    chainParent,
  };
}

/** Each problem once, in the order found. */
function distinct(problems: Problem[]): Problem[] {
  const seen = new Set<string>();
  return problems.filter((p) => {
    const key = `${p.creature}|${p.seq}|${p.family}|${p.code}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Checks a proof bundle in five families: chains, signatures and key history, origins (T4), time
 * gates, costs and growth (T5), and fights (T6). Pass `opts.keys` to check against pinned
 * authority keys instead of the ones the bundle lists. Never throws: a bundle that cannot be read
 * reports `unreadable`.
 */
export function verifyLineage(bundle: ProofBundle, opts: VerifyOptions = {}): LineageReport {
  const subject = String((bundle as Partial<ProofBundle> | null)?.subject ?? '');
  const scales = (bundle as Partial<ProofBundle> | null)?.world?.scales;
  const base: LineageReport = {
    subject,
    problems: [],
    held: 0,
    missing: [],
    toGenesis: false,
    generations: 0,
    fights: { settled: 0, replayed: 0, pruned: 0, unreplayed: 0 },
    scaled: scales !== undefined && (scales.lifespan < 1 || scales.mating < 1),
    keys: opts.keys ? 'pinned' : 'bundle',
  };
  try {
    const index = indexBundle(bundle, opts);
    const problems = distinct([
      ...verifyChain(index, opts),
      ...verifySignatures(index, opts),
      ...verifyOrigin(index, opts),
      ...verifyGates(index, opts),
      ...verifyFights(index, opts),
    ]);
    return {
      ...base,
      problems,
      held: index.creatures.size,
      missing: [...bundle.more],
      ...reachOf(index),
      fights: fightsOf(index, opts),
    };
  } catch {
    return {
      ...base,
      problems: [{ creature: subject, seq: null, family: 'chain', code: 'unreadable' }],
    };
  }
}

/**
 * Every code a family reports, with the sentence a reader sees. A family's later codes are added
 * here with it; `problemText` falls back to the family's sentence for one it lacks.
 */
export const PROBLEM_TEXT: Readonly<Record<string, string>> = Object.freeze({
  // The chain family.
  unreadable: 'The proof could not be read.',
  subject: 'The proof does not begin with the creature it is about.',
  'no-records': 'The proof holds no records for this creature.',
  stray: 'The proof holds a record that belongs to none of its creatures.',
  shape: 'A record is malformed.',
  'rules-retired': 'A record was made under rules that a world renewal retired.',
  'rules-unknown': 'A record names rules this verifier does not know.',
  hash: 'A record has been changed since it was written.',
  'creature-id': "The creature's identity is not the fingerprint of its first record.",
  'seq-gap': 'A record is missing from the chain.',
  fork: 'Two different records claim the same place in the chain.',
  prev: 'A record does not follow on from the one before it.',
  owner: 'The chain changes hands partway, which no record allows.',
  role: 'A promotion names neither a child nor a parent.',
  'status:none': 'A record comes before the creature existed.',
  'status:pending': 'A record comes while the creature was still an unhatched offspring.',
  'status:active': 'A record comes while the creature was alive, where it is not allowed.',
  'status:checkpoint': 'A record comes while the creature was frozen, where it is not allowed.',
  'status:dead': 'A record comes after the creature died.',
  // The signature family.
  'owner-sig-missing': 'A step only the owner may take was not signed by the owner.',
  'owner-sig-refused': 'A record only the authority writes carries an owner signature.',
  'owner-sig': "The owner's signature on a record does not verify.",
  'key-unknown': 'A record is countersigned with a key that is not an authority key.',
  'key-not-yet': 'A record is countersigned with an authority key before that key came into use.',
  'auth-sig': "The authority's countersignature on a record does not verify.",
  'commit-key-unknown':
    'A randomness commitment is countersigned with a key that is not an authority key.',
  'commit-key-not-yet':
    'A randomness commitment is countersigned with an authority key before that key came into use.',
  'commit-sig': "The authority's countersignature on a randomness commitment does not verify.",
  'settlement-key-unknown':
    "A fight's settlement is countersigned with a key that is not an authority key.",
  'settlement-key-not-yet':
    "A fight's settlement is countersigned with an authority key before that key came into use.",
  'settlement-sig': "The authority's countersignature on a fight's settlement does not verify.",
});

/** The sentence for a code a family reports that `PROBLEM_TEXT` does not list. */
export const FAMILY_TEXT: Readonly<Record<Family, string>> = Object.freeze({
  chain: 'The chain of records does not hold together.',
  signature: 'A signature in the history does not hold.',
  origin: "The creature's origin could not be confirmed from its randomness and its parents.",
  gates: 'A time limit, cost or growth limit in the history does not hold.',
  fights: "A fight's records do not agree with its settlement.",
});

/** One plain sentence for a problem, with no raw code in it. */
export function problemText(p: Problem): string {
  return (
    (Object.hasOwn(PROBLEM_TEXT, p.code) ? PROBLEM_TEXT[p.code] : undefined) ??
    (Object.hasOwn(FAMILY_TEXT, p.family) ? FAMILY_TEXT[p.family] : undefined) ??
    'Something in this history does not hold.'
  );
}
