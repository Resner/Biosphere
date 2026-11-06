import type { SignedCommit } from '../net/protocol-defs';
import type { Beacon } from './drand';
import { isScaled } from './gates';
import { commitmentId } from './genesis';
import type { AuthorityKey, ProofBundle } from './proof';
import { authorityKeyId, type PubKey, type StoredRecord } from './record';
import type { FightLog, SignedSettlement } from './settlement';
import { creatureOf, verifyChain, verifySignatures } from './verify-chain';
import { fightsOf, verifyFights } from './verify-fights';
import { verifyGates } from './verify-gates';
import { reachOf, verifyOrigin } from './verify-origin';
import { verifyWitness } from './verify-witness';

// The lineage verifier (ADR 0055): a proof bundle checked in six families, with no trust in the
// authority beyond its signing keys and none in any player. Each family lives in its own file as
// `(index, opts) => Problem[]`; this one indexes the bundle, runs them and writes the report. Pure
// and shared by the card, the CLI and the tests: no DOM, no Node APIs, no `src/net` at run time.

export type Family = 'chain' | 'signature' | 'origin' | 'gates' | 'fights' | 'witness';

/**
 * What witnesses saw of one held fight (`enc:`), mating or genesis (ADR 0058). `selection` is
 * `checked` when its witness commitment is held and draws the order, `unchecked` when it is not
 * held (pruned or not served), and `none` when there was no pool.
 */
export interface WitnessEvent {
  event: string;
  /** Held creatures with a part in it. */
  creatures: string[];
  /** A witness refereed some of its frames. */
  refereed: boolean;
  /** A witness's attestation agrees with it. */
  audited: boolean;
  /** A witness's attestation disagrees: the authority's result stands. */
  overruled: boolean;
  /** Neither refereed nor audited: only the authority checked it. */
  authorityOnly: boolean;
  selection: 'checked' | 'unchecked' | 'none';
}

/** The counts of `LineageReport.events`. */
export interface Witnessed {
  events: number;
  refereed: number;
  audited: number;
  authorityOnly: number;
  overruled: number;
  unchecked: number;
}

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
  /** Held creatures whose birth was not recomputed, because a parent is not in the bundle. */
  unchecked: string[];
  fights: { settled: number; replayed: number; pruned: number; unreplayed: number };
  witnessed: Witnessed;
  /** One per held fight, mating and genesis. */
  events: WitnessEvent[];
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
  /** Every settlement by encounter id, in bundle order: more than one is `settlement-duplicate`. */
  settlements: ReadonlyMap<string, readonly SignedSettlement[]>;
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
  const settlements = new Map<string, SignedSettlement[]>();
  for (const s of bundle.settlements) {
    const copies = settlements.get(s.settlement.enc);
    if (copies) copies.push(s);
    else settlements.set(s.settlement.enc, [s]);
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
    settlements,
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
 * Checks a proof bundle in six families: chains, signatures and key history, origins (T4), time
 * gates, costs and growth (T5), fights (T6), and witnesses (ADR 0058). Pass `opts.keys` to check against pinned
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
    unchecked: [],
    fights: { settled: 0, replayed: 0, pruned: 0, unreplayed: 0 },
    witnessed: { events: 0, refereed: 0, audited: 0, authorityOnly: 0, overruled: 0, unchecked: 0 },
    events: [],
    scaled: scales !== undefined && isScaled(scales),
    keys: opts.keys ? 'pinned' : 'bundle',
  };
  try {
    const index = indexBundle(bundle, opts);
    const witness = verifyWitness(index, opts);
    const problems = distinct([
      ...verifyChain(index, opts),
      ...verifySignatures(index, opts),
      ...verifyOrigin(index, opts),
      ...verifyGates(index, opts),
      ...verifyFights(index, opts),
      ...witness.problems,
    ]);
    return {
      ...base,
      problems,
      held: index.creatures.size,
      missing: [...bundle.more],
      ...reachOf(index),
      fights: fightsOf(index, opts),
      witnessed: witness.witnessed,
      events: witness.events,
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
  // The gates family.
  'clock-back': "The creature's life clock runs backwards.",
  'clock-fast': "The creature's life clock runs faster than real time allows.",
  'after-lifespan': 'A record comes after the creature had outlived its lifespan.',
  'old-age-early': 'The creature is said to have died of old age before its time was up.',
  'pending-clock': "An unhatched offspring's life clock moved before it was brought to life.",
  'mature-time': 'The creature mated before it was old enough.',
  'mature-size': 'The creature mated before it was big enough.',
  'mate-energy': 'The creature mated without the energy mating needs.',
  cooldown: 'The creature mated again before its cooldown was over.',
  'cooldown-length': 'A mating set a cooldown of a length the rules never give.',
  cost: 'A mating did not cost what the rules say it costs.',
  growth: 'The creature grew faster than its genes allow.',
  vitals: 'The creature holds more energy or health than its body allows.',
  'restore-changed': 'A restored creature did not come back as it was put aside.',
  'restore-exhausted': 'A creature was restored with too little of its life left.',
  'promote-cooldown': "A parent's mating cooldown changed when it was put aside.",
  'frozen-changed': 'A creature changed while it was put aside.',
  // The origin family.
  'origin-unreadable': "A creature's origin could not be read.",
  'genome-text': "A creature's DNA in the proof is not the DNA its first record names.",
  'commit-missing': "The proof lacks the randomness commitment a creature's origin rests on.",
  'beacon-missing': "The proof lacks the drand round a creature's origin was committed to.",
  'round-not-future': 'A randomness commitment named a drand round that was already published.',
  'beacon-round': 'A drand round in the proof is not the one its commitment named.',
  'bad-beacon': "A drand round in the proof does not carry drand's signature.",
  'not-genesis': 'A genesis creature rests on a commitment made for something else.',
  'not-mate': 'A birth rests on a commitment made for something other than a mating.',
  'bad-commit': "A mating's commitment does not hold both players' requests.",
  'owner-mismatch': 'A creature belongs to a player its commitment does not name.',
  'bad-ask': 'The request for a genesis creature is not signed by its player.',
  'commit-mismatch': 'A creature names a commitment other than the one it rests on.',
  'round-mismatch': 'A creature names a drand round other than the one its commitment chose.',
  'body-mismatch': "A genesis creature's DNA is not what its committed drand round produces.",
  'rules-mismatch': 'A birth and the mating it came from were made under different rules.',
  'parent-missing': 'A birth names a parent the proof neither holds nor lists as left out.',
  'mate-not-held': "A birth names a mating record its parents' chains in the proof do not hold.",
  'parent-genome': "A parent's DNA in the proof is not the DNA that parent's first record names.",
  'mate-generation': 'A mating record names a generation its creature does not have.',
  'parent-mismatch': 'A birth names parents other than the two creatures that agreed to mate.',
  'mate-commit-mismatch': 'A birth rests on a mating record that does not belong to its mating.',
  'parent-genome-mismatch': "A mating record names DNA that is not its creature's.",
  'mate-hash': 'A birth names mating records that do not match their contents.',
  'slot-mismatch':
    'A birth claims a place among the offspring other than the one its drand round gave.',
  'genome-mismatch':
    "A newborn's DNA is not what its parents and its committed drand round produce.",
  'generation-mismatch': "A birth claims a generation other than the one after its parents'.",
  'karyotype-mismatch': "A birth claims a genome layout this world's rules do not use.",
  'pair:bad-ask': 'A mating rests on requests that are malformed.',
  'pair:self': 'A mating pairs a player with themselves.',
  'pair:pair-mismatch': "A mating's two requests do not name each other.",
  'pair:bad-signature': 'A request to mate is not signed by its player.',
  // The fights family.
  'settlement-missing': "The proof lacks the settlement of a fight a creature's record names.",
  'settlement-duplicate': 'The proof holds more than one settlement of the same fight.',
  settled: "A creature's record of a fight does not agree with the fight's settlement.",
  'settled:rules': 'A fight record and its settlement were made under different rules.',
  'settled:creature': 'A creature has a record of a fight its settlement gives it no part in.',
  'settled:player':
    "A fight record belongs to a player other than the fighter's in its settlement.",
  'settled:kind':
    "A creature's record of a fight is not the kind its result in the settlement calls for.",
  'settled:outcome': "A fight record's outcome is not the settlement's.",
  'settled:frames': "A fight record's length is not the settlement's.",
  'settled:biomass': "A fight record's size is not the settlement's.",
  'settled:energy': "A fight record's energy is not the settlement's.",
  'settled:health': "A fight record's health is not the settlement's.",
  'settled:reward': "A fight record's winnings are not the settlement's.",
  'settled:cause': "A fight death's cause is not the settlement's.",
  'settled:by': "A fight death names a killer other than the settlement's.",
  'fight-clock':
    "The creature's life clock ran further around a fight than the fight and real time allow.",
  'fight-growth': 'The creature came out of a fight bigger than its genes and its winnings allow.',
  'start-growth': 'The creature went into a fight bigger than its genes allow.',
  'locked-time': 'A fight record does not count the time the creature was locked in the fight.',
  replay: "A fight's replay from its log does not match its settlement.",
  'replay:start': "A fight's log does not begin as its settlement says.",
  'replay:joins': "A fight's log does not hold the fighters who joined as its settlement says.",
  'replay:frames': "A fight's log does not last as long as its settlement says.",
  'replay:root': "A fight's log does not hold the inputs its settlement was signed over.",
  'replay:width': "A fight's log holds a frame with the wrong number of inputs.",
  'replay:rules-retired': 'A fight was settled under rules that a world renewal retired.',
  'replay:rules-unknown': 'A fight was settled under rules this verifier does not know.',
  'replay:replay': "A fight's log does not play through to the end its settlement records.",
  'replay:hash': "A fight's replay does not end where its settlement says it ended.",
  'replay:result': "A fight's replay does not give the results its settlement records.",
  // The witness family.
  'spans-start':
    "A fight's settlement does not begin with the authority refereeing from the first frame.",
  'spans-order': "A fight's settlement lists who refereed which frames out of order.",
  'spans-frames': "A fight's settlement hands the refereeing over after the fight was over.",
  'spans-position':
    "A fight's settlement names a witness referee without its place in the draw, or the authority with one.",
  'witness-commit-key-unknown':
    'A witness draw is countersigned with a key that is not an authority key.',
  'witness-commit-key-not-yet':
    'A witness draw is countersigned with an authority key before that key came into use.',
  'witness-commit-sig': "The authority's countersignature on a witness draw does not verify.",
  'witness-data': 'A witness draw does not name its event and its pool of witnesses properly.',
  'witness-data:pool-size':
    'A witness draw names an empty pool, or more witnesses than a pool holds.',
  'witness-data:pool-order': "A witness draw's pool is not in order, or names a witness twice.",
  'witness-data:pool-id': "A witness draw's pool names something that is not a player.",
  'witness-event': 'A witness draw was made for another event.',
  'witness-duty': "A fight's settlement names a witness draw other than the one made for it.",
  'witness-commit-duplicate': 'The same event has more than one witness draw.',
  'witness-round-not-future': 'A witness draw named a drand round that was already published.',
  'witness-round':
    "A birth's or a hatch's witness draw names a drand round other than the event's own.",
  'witness-beacon-missing': 'The proof lacks the drand round a witness draw was committed to.',
  'witness-bad-beacon': "A witness draw's drand round does not carry drand's signature.",
  'referee-unselected':
    'A fight was refereed by a witness although no witnesses were drawn for it.',
  'referee-position': 'A fight was refereed by a witness the draw did not pick for that place.',
  'attest-sig': "A witness's signature on its check of an event does not verify.",
  'attest-duty': "A witness's check names a witness draw other than its event's.",
  'attest-position': "A witness's check comes from a place in the draw that witness does not hold.",
  'attest-subject': "A witness's check is about something other than the event it names.",
  'position-twice': 'One place in a witness draw served more than once.',
});

/** The sentence for a code a family reports that `PROBLEM_TEXT` does not list. */
export const FAMILY_TEXT: Readonly<Record<Family, string>> = Object.freeze({
  chain: 'The chain of records does not hold together.',
  signature: 'A signature in the history does not hold.',
  origin: "The creature's origin could not be confirmed from its randomness and its parents.",
  gates: 'A time limit, cost or growth limit in the history does not hold.',
  fights: "A fight's records do not agree with its settlement.",
  witness: "The witnesses' part in an event does not hold.",
});

/** The sentence for `code`, or for its longest listed prefix (`replay:result:0:biomass` reads as `replay:result`). */
function listedText(code: string): string | undefined {
  for (let c = code; ; c = c.slice(0, c.lastIndexOf(':'))) {
    if (Object.hasOwn(PROBLEM_TEXT, c)) return PROBLEM_TEXT[c];
    if (!c.includes(':')) return undefined;
  }
}

/** One plain sentence for a problem, with no raw code in it. */
export function problemText(p: Problem): string {
  return (
    (typeof p.code === 'string' ? listedText(p.code) : undefined) ??
    (Object.hasOwn(FAMILY_TEXT, p.family) ? FAMILY_TEXT[p.family] : undefined) ??
    'Something in this history does not hold.'
  );
}

/**
 * What witnesses saw, in one line (M10 T10): the card's details and the CLI both print it, e.g.
 * "Witnesses: 4 of 6 events seen by a witness; 2 checked by the authority alone".
 */
export function witnessedLine(w: Witnessed): string {
  if (w.events === 0) return 'Witnesses: no fights, births or hatches in this history';
  const parts = [
    `${w.events - w.authorityOnly} of ${w.events} ${w.events === 1 ? 'event' : 'events'} seen by a witness`,
    `${w.authorityOnly} checked by the authority alone`,
  ];
  if (w.overruled > 0)
    parts.push(`${w.overruled} where a witness disagreed and the authority's result stands`);
  if (w.unchecked > 0)
    parts.push(`${w.unchecked} whose draw of witnesses is no longer kept, so not checked`);
  return `Witnesses: ${parts.join('; ')}`;
}
