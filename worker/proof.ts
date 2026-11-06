import {
  type AuditFlag,
  type AuthorityKey,
  type FightProof,
  PROOF_CAPS,
  PROOF_MAX_BYTES,
  PROOF_MAX_CREATURES,
  type ProofBundle,
} from '../src/ledger/proof';
import { HEX64, type StoredRecord } from '../src/ledger/record';
import type { FightLog, SignedSettlement } from '../src/ledger/settlement';
import type { SignedAttestation } from '../src/ledger/witness-doc';
import type { EncJoin, EncStart } from '../src/net/encounter-start';
import type { SignedCommit } from '../src/net/protocol-defs';
import { byteLength } from '../src/net/protocol-kit';
import { RULES_VERSION } from '../src/sim/rules';
import { requestKey } from './beacons';
import { unpackFrames } from './fight-pack';
import { asStored, type Row } from './ledger-types';
import { scalesOf } from './mating';
import { requestBudget } from './sessions';
import type { Hub } from './socket';

// What verification needs, served from the ledger alone (ADR 0055, M9 T7): a creature's proof
// bundle (`GET /v1/proof/<creature>`) and a fight's settlement with its log (`GET /v1/fight/<enc>`).
// Reads only: every query goes through `read`, which counts any row written as `Ledger.run` does,
// so a test sees that nothing is. A bundle (version 2) also holds the witness commitment of each
// event its records hold (a fight, a genesis, a mating) while it is kept, and every attestation of
// them (ADR 0058, M10 T10).

/** How far a bundle may grow: `PROOF_MAX_CREATURES`, `PROOF_MAX_BYTES` and `PROOF_CAPS.records` (tests pass smaller ones). */
export interface ProofLimits {
  creatures: number;
  bytes: number;
  records?: number;
}

const LIMITS: ProofLimits = {
  creatures: PROOF_MAX_CREATURES,
  bytes: PROOF_MAX_BYTES,
  records: PROOF_CAPS.records,
};

/** How often a bundle was assembled: a test sees that growing one assembles it once (M10 T15). */
export const proofStats = { assembles: 0 };

function read(hub: Hub, query: string, ...bindings: SqlStorageValue[]): Row[] {
  const cursor = hub.ctx.storage.sql.exec<Row>(query, ...bindings);
  const rows = cursor.toArray();
  hub.ledger.rowsWritten += cursor.rowsWritten;
  return rows;
}

/** One held creature: its genome text and whole chain (a prefix of it goes into the bundle). */
interface Known {
  id: string;
  genome: string;
  status: string;
  chain: StoredRecord[];
  /** Its birth's parents, empty for a genesis creature. */
  parents: string[];
  /** The parent its child `promote` names, or null. */
  chainParent: string | null;
}

const signedOf = (row: Row): SignedCommit => ({
  commitment: JSON.parse(row.json as string),
  authSig: row.auth_sig as string,
  keyId: row.key_id as string,
});

/**
 * The witness events a held record names, as the verifier's witness family holds them: a genesis
 * creature's first record, a mating's `mate-commit` or `birth`, and a fight's record (only once its
 * settlement is held, which `settled` says).
 */
function eventsOf(s: StoredRecord, settled: (enc: string) => boolean): string[] {
  const { kind, seq, body } = s.record;
  const out: string[] = [];
  if (typeof body.commit === 'string') {
    if (kind === 'genesis' && seq === 0) out.push(`genesis:${body.commit}`);
    else if (kind === 'mate-commit' || kind === 'birth') out.push(`mating:${body.commit}`);
  }
  if (typeof body.enc === 'string' && settled(body.enc)) out.push(`enc:${body.enc}`);
  return out;
}

/** The JSON size of a value in UTF-8 bytes, plus the comma that follows it in a list. */
const sizeOf = (v: unknown): number => byteLength(JSON.stringify(v)) + 1;

/** The bundle's reads, each made once, and the size of each document. */
class Reader {
  private readonly creatures = new Map<string, Known | null>();
  private readonly commits = new Map<string, SignedCommit | null>();
  private readonly beacons = new Map<number, { round: number; signature: string } | null>();
  private readonly settlements = new Map<string, SignedSettlement | null>();
  private readonly flags = new Map<string, AuditFlag[]>();
  private readonly witnesses = new Map<string, SignedCommit | null>();
  private readonly attested = new Map<string, SignedAttestation[]>();
  readonly sizes = new Map<unknown, number>();

  constructor(private readonly hub: Hub) {}

  creature(id: string): Known | null {
    if (!this.creatures.has(id)) this.creatures.set(id, this.readCreature(id));
    return this.creatures.get(id) ?? null;
  }

  commit(id: string): SignedCommit | null {
    if (!this.commits.has(id)) {
      const row = read(
        this.hub,
        'SELECT json, auth_sig, key_id FROM commitments WHERE id = ?',
        id,
      )[0];
      this.commits.set(id, row ? signedOf(row) : null);
    }
    return this.commits.get(id) ?? null;
  }

  beacon(round: number): { round: number; signature: string } | null {
    if (!this.beacons.has(round)) {
      const row = read(this.hub, 'SELECT signature FROM beacons WHERE round = ?', round)[0];
      this.beacons.set(round, row ? { round, signature: row.signature as string } : null);
    }
    return this.beacons.get(round) ?? null;
  }

  settlement(enc: string): SignedSettlement | null {
    if (!this.settlements.has(enc)) this.settlements.set(enc, settlementOf(this.hub, enc));
    return this.settlements.get(enc) ?? null;
  }

  /** The event's witness commitment while it is kept (found by its request key, the event's), or null. */
  witness(event: string): SignedCommit | null {
    if (!this.witnesses.has(event)) {
      const row = read(
        this.hub,
        'SELECT json, auth_sig, key_id FROM commitments WHERE req = ?',
        requestKey('witness', '', { event }),
      )[0];
      this.witnesses.set(event, row ? signedOf(row) : null);
    }
    return this.witnesses.get(event) ?? null;
  }

  /** Every attestation stored for the event, by position. */
  attestations(event: string): SignedAttestation[] {
    let out = this.attested.get(event);
    if (!out) {
      out = read(
        this.hub,
        'SELECT json FROM attestations WHERE event = ? ORDER BY position',
        event,
      ).map((r) => JSON.parse(r.json as string) as SignedAttestation);
      this.attested.set(event, out);
    }
    return out;
  }

  flagsOf(creature: string): AuditFlag[] {
    let out = this.flags.get(creature);
    if (!out) {
      out = read(
        this.hub,
        'SELECT kind, t FROM flags WHERE creature = ? ORDER BY id',
        creature,
      ).map((r) => ({ creature, kind: r.kind as string, t: r.t as number }));
      this.flags.set(creature, out);
    }
    return out;
  }

  /** A document's JSON size in the bundle, measured once. */
  size(doc: object): number {
    let n = this.sizes.get(doc);
    if (n === undefined) {
      n = sizeOf(doc);
      this.sizes.set(doc, n);
    }
    return n;
  }

  private readCreature(id: string): Known | null {
    const row = read(this.hub, 'SELECT genome, status FROM creatures WHERE id = ?', id)[0];
    if (!row) return null;
    const chain = read(this.hub, 'SELECT * FROM records WHERE creature = ? ORDER BY seq', id).map(
      asStored,
    );
    const first = chain[0]?.record;
    const parents =
      first?.kind === 'birth' && Array.isArray(first.body.parents)
        ? (first.body.parents as string[])
        : [];
    const promote = chain.find(
      (s) => s.record.kind === 'promote' && s.record.body.role === 'child',
    );
    const parent = promote?.record.body.parent;
    return {
      id,
      genome: row.genome as string,
      status: row.status as string,
      chain,
      parents,
      chainParent: typeof parent === 'string' ? parent : null,
    };
  }
}

/**
 * The index of the last record of `parent`'s chain that ties it to `child`: its `mate-commit` of
 * the child's mating, its parent `promote` naming the child, or (for a chain parent that was
 * already dead when the child took over) its death. -1 when none does.
 */
function tieOf(parent: Known, child: Known): number {
  const first = child.chain[0];
  const mates =
    first?.record.kind === 'birth'
      ? ((first.record.body.mates as unknown[] | undefined) ?? [])
      : [];
  const childId = first?.hash;
  const handover = parent.chain.findLastIndex(
    (s) =>
      s.record.kind === 'promote' &&
      s.record.body.role === 'parent' &&
      s.record.body.child === childId,
  );
  // A chain parent that was alive when the child took over is cut at that promote (a restore and
  // a later death are its own); one that had died is cut at its death.
  const death =
    handover < 0 && child.chainParent === parent.id
      ? parent.chain.findLastIndex((s) => s.record.kind === 'death')
      : -1;
  const mating = parent.chain.findLastIndex((s) => mates.includes(s.hash));
  return Math.max(handover, death, mating);
}

/** Each held creature's records in the bundle: the subject's whole chain, an ancestor's to its last tie. */
function prefixes(held: readonly Known[]): Map<string, StoredRecord[]> {
  const out = new Map<string, StoredRecord[]>();
  const [subject, ...ancestors] = held;
  if (subject) out.set(subject.id, subject.chain);
  for (const a of ancestors) {
    let end = -1;
    for (const child of held) {
      if (parentsOf(child).includes(a.id)) end = Math.max(end, tieOf(a, child));
    }
    out.set(a.id, a.chain.slice(0, end + 1));
  }
  return out;
}

const parentsOf = (k: Known): string[] =>
  k.chainParent && !k.parents.includes(k.chainParent) ? [...k.parents, k.chainParent] : k.parents;

/** What every bundle of the object holds alike: the world and the keys. */
type Frame = Pick<ProofBundle, 'world' | 'keys' | 't'>;

function frameOf(hub: Hub, now: number): Frame {
  const world = read(hub, 'SELECT epoch FROM world LIMIT 1')[0];
  return {
    world: {
      epoch: (world?.epoch as number) ?? 0,
      rules: RULES_VERSION,
      scales: scalesOf(hub.env),
    },
    keys: keysOf(hub),
    t: now,
  };
}

/** The bundle with its lists empty: the world, the keys and the time, which every bundle holds alike. */
const shellOf = (frame: Frame, subject: string): ProofBundle => ({
  v: 2,
  kind: 'proof',
  subject,
  world: frame.world,
  keys: frame.keys,
  creatures: [],
  records: [],
  commits: [],
  beacons: [],
  settlements: [],
  flags: [],
  more: [],
  witnessCommits: [],
  attestations: [],
  t: frame.t,
});

/** The bundle of `held` (the subject first, then ancestors nearest first). */
function assemble(reader: Reader, frame: Frame, held: readonly Known[]): ProofBundle {
  proofStats.assembles++;
  const chains = prefixes(held);
  const records = held.flatMap((k) => chains.get(k.id) ?? []);
  const named = (field: string) =>
    [
      ...new Set(records.map((s) => s.record.body[field]).filter((v) => typeof v === 'string')),
    ] as string[];
  const commits = named('commit')
    .map((id) => reader.commit(id))
    .filter((c): c is SignedCommit => c !== null);
  const settlements = named('enc')
    .map((enc) => reader.settlement(enc))
    .filter((s): s is SignedSettlement => s !== null);
  const settled = new Set(settlements.map((s) => s.settlement.enc));
  const events = [...new Set(records.flatMap((s) => eventsOf(s, (enc) => settled.has(enc))))];
  const witnessCommits = events
    .map((e) => reader.witness(e))
    .filter((c): c is SignedCommit => c !== null);
  const rounds = [...new Set([...commits, ...witnessCommits].map((c) => c.commitment.round))].sort(
    (x, y) => x - y,
  );
  return {
    ...shellOf(frame, held[0]?.id ?? ''),
    creatures: held.map((k) => ({ id: k.id, genome: k.genome })),
    records,
    commits,
    beacons: rounds.map((r) => reader.beacon(r)).filter((b) => b !== null),
    settlements,
    flags: held.flatMap((k) => reader.flagsOf(k.id)),
    more: moreOf(held),
    witnessCommits,
    attestations: events.flatMap((e) => reader.attestations(e)),
  };
}

/** The parents of the held creatures that are not held: what the bundle's `more` names. */
function moreOf(held: readonly Known[]): string[] {
  const ids = new Set(held.map((k) => k.id));
  return [...new Set(held.flatMap(parentsOf))].filter((id) => !ids.has(id));
}

/** What a growing bundle counts against the caps beside its bytes. */
interface Counts {
  records: number;
  beacons: number;
  witnessCommits: number;
  attestations: number;
}

/**
 * What a growing bundle holds, and an upper bound of its JSON size (its frame, and each list item
 * with a comma), kept as creatures are added so no candidate is assembled to be measured.
 * `add` leaves this one as it was and returns the grown copy, so a candidate that does not fit is
 * simply dropped.
 */
class Growth {
  private constructor(
    private readonly reader: Reader,
    private bytes: number,
    readonly counts: Counts,
    private readonly ends: Map<string, number>,
    private readonly commits: Set<string>,
    private readonly rounds: Set<number>,
    private readonly encs: Set<string>,
    private readonly events: Set<string>,
  ) {}

  /** The subject's whole chain, its flags and the bundle's frame. */
  static of(reader: Reader, frame: Frame, subject: Known): Growth {
    const shell = byteLength(JSON.stringify(shellOf(frame, subject.id)));
    const counts = { records: 0, beacons: 0, witnessCommits: 0, attestations: 0 };
    const g = new Growth(
      reader,
      shell,
      counts,
      new Map(),
      new Set(),
      new Set(),
      new Set(),
      new Set(),
    );
    g.hold(subject);
    g.extend(subject, subject.chain.length - 1);
    return g;
  }

  /** This growth with `k` held, the ancestors it names extended to their ties with it. */
  add(held: readonly Known[], k: Known): Growth {
    const g = new Growth(
      this.reader,
      this.bytes,
      { ...this.counts },
      new Map(this.ends),
      new Set(this.commits),
      new Set(this.rounds),
      new Set(this.encs),
      new Set(this.events),
    );
    g.hold(k);
    const children = held.filter((c) => parentsOf(c).includes(k.id));
    g.extend(k, Math.max(-1, ...children.map((c) => tieOf(k, c))));
    for (const a of held.slice(1)) {
      if (parentsOf(k).includes(a.id)) g.extend(a, tieOf(a, k));
    }
    return g;
  }

  /** The bound of the bundle's JSON size when it holds `held`, with the parents left out in `more`. */
  size(held: readonly Known[]): number {
    return this.bytes + moreOf(held).reduce((n, id) => n + id.length + 3, 0);
  }

  private hold(k: Known): void {
    this.ends.set(k.id, -1);
    this.bytes += sizeOf({ id: k.id, genome: k.genome });
    for (const flag of this.reader.flagsOf(k.id)) this.bytes += this.reader.size(flag);
  }

  /**
   * Holds `k`'s records up to index `end`, and what they name: commitments, beacons, settlements,
   * and each event's witness commitment and attestations.
   */
  private extend(k: Known, end: number): void {
    const from = (this.ends.get(k.id) ?? -1) + 1;
    for (let i = from; i <= end; i++) {
      const stored = k.chain[i] as StoredRecord;
      this.bytes += this.reader.size(stored);
      this.counts.records++;
      const { commit, enc } = stored.record.body;
      if (typeof commit === 'string' && !this.commits.has(commit)) {
        this.commits.add(commit);
        const signed = this.reader.commit(commit);
        if (signed) {
          this.bytes += this.reader.size(signed);
          this.beacon(signed.commitment.round);
        }
      }
      if (typeof enc === 'string' && !this.encs.has(enc)) {
        this.encs.add(enc);
        const settlement = this.reader.settlement(enc);
        if (settlement) this.bytes += this.reader.size(settlement);
      }
      for (const event of eventsOf(stored, (e) => this.reader.settlement(e) !== null)) {
        this.witness(event);
      }
    }
    this.ends.set(k.id, Math.max(end, from - 1));
  }

  private witness(event: string): void {
    if (this.events.has(event)) return;
    this.events.add(event);
    const signed = this.reader.witness(event);
    if (signed) {
      this.bytes += this.reader.size(signed);
      this.counts.witnessCommits++;
      this.beacon(signed.commitment.round);
    }
    for (const a of this.reader.attestations(event)) {
      this.bytes += this.reader.size(a);
      this.counts.attestations++;
    }
  }

  private beacon(round: number): void {
    if (this.rounds.has(round)) return;
    this.rounds.add(round);
    const beacon = this.reader.beacon(round);
    if (beacon) {
      this.bytes += this.reader.size(beacon);
      this.counts.beacons++;
    }
  }
}

/**
 * `creature`'s proof bundle, or null for an unknown creature (or one whose own chain passes the
 * limits): its whole chain, then its ancestors breadth-first (nearest first, ties by id), each up
 * to the record that ties it to its descendant (the longer when reached twice), with the
 * commitments, beacons and settlements those records name, the keys, the world and the held
 * creatures' flags. At `limits` creatures, or before the bundle would pass `limits.bytes` or
 * `limits.records`, it stops; `more` names the parents it left out.
 */
export function proofBundle(
  hub: Hub,
  creature: string,
  now: number,
  limits: ProofLimits = LIMITS,
): ProofBundle | null {
  const built = buildBundle(hub, creature, now, limits);
  return built && built !== 'too-big' ? built.bundle : null;
}

/**
 * `proofBundle`, with whether its subject is dead (so its flags and attestations are all that can
 * still arrive), or `too-big` when the subject's own bundle passes the limits.
 */
function buildBundle(
  hub: Hub,
  creature: string,
  now: number,
  limits: ProofLimits,
): { bundle: ProofBundle; final: boolean } | 'too-big' | null {
  const reader = new Reader(hub);
  const subject = reader.creature(creature);
  if (!subject) return null;
  const maxRecords = limits.records ?? PROOF_CAPS.records;
  const fits = (g: Growth, held: readonly Known[]) =>
    g.size(held) <= limits.bytes &&
    g.counts.records <= maxRecords &&
    g.counts.beacons <= PROOF_CAPS.beacons &&
    g.counts.witnessCommits <= PROOF_CAPS.witnessCommits &&
    g.counts.attestations <= PROOF_CAPS.attestations;
  const frame = frameOf(hub, now);
  const held: Known[] = [subject];
  let grown = Growth.of(reader, frame, subject);
  if (!fits(grown, held)) return 'too-big';
  const seen = new Set([subject.id]);
  let level: Known[] = [subject];
  grow: while (level.length > 0) {
    const ids = [...new Set(level.flatMap(parentsOf))].filter((id) => !seen.has(id)).sort();
    const next: Known[] = [];
    for (const id of ids) {
      const k = reader.creature(id);
      if (!k) continue;
      if (held.length >= limits.creatures) break grow;
      const tried = grown.add(held, k);
      if (!fits(tried, [...held, k])) break grow;
      held.push(k);
      seen.add(id);
      next.push(k);
      grown = tried;
    }
    level = next;
  }
  return { bundle: assemble(reader, frame, held), final: subject.status === 'dead' };
}

/** Every authority key ever used, public halves only. Unlike `Ledger.pubkeys`, it never makes one. */
function keysOf(hub: Hub): AuthorityKey[] {
  return read(hub, 'SELECT id, public_key, from_t FROM keys ORDER BY from_t, id').map((r) => ({
    id: r.id as string,
    publicKey: r.public_key as string,
    from: r.from_t as number,
  }));
}

function settlementOf(hub: Hub, enc: string): SignedSettlement | null {
  const row = read(hub, 'SELECT settlement FROM encounters WHERE id = ?', enc)[0];
  return row?.settlement ? (JSON.parse(row.settlement as string) as SignedSettlement) : null;
}

/**
 * A settled fight's countersigned settlement and its log as the row holds it (the pond's seed is
 * the settlement's), or null for a fight that is unknown or not settled. The log is null once its
 * row no longer holds it (pruned, ADR 0056).
 */
export function fightProof(hub: Hub, enc: string): FightProof | null {
  const row = read(
    hub,
    'SELECT start, joins, frames, settlement FROM encounters WHERE id = ?',
    enc,
  )[0];
  if (!row?.settlement) return null;
  const settlement = JSON.parse(row.settlement as string) as SignedSettlement;
  const start = row.start as string;
  const startOf = start ? (JSON.parse(start) as EncStart) : null;
  const joins = start ? (JSON.parse(row.joins as string) as EncJoin[]) : [];
  const log: FightLog | null = startOf
    ? {
        pondSeed: settlement.settlement.pondSeed,
        start: startOf,
        joins,
        frames: unpackFrames(row.frames as string, startOf.fighters.length, joins),
      }
    : null;
  return { settlement, log };
}

/**
 * How long the edge may keep a 200 (M10 T15): `settled` (a fight's proof never changes: a day),
 * `dead` (a dead creature's bundle can still gain flags and attestations: ten minutes) or `live`.
 */
export type ProofAge = 'settled' | 'dead' | 'live';

/** A proof read as the Worker serves it: the JSON and its age, 413 for a bundle too big to serve, or 404 and 503. */
export type Served = { status: 200; body: string; age: ProofAge } | { status: 404 | 413 | 503 };

/** Past this share of the day's request budget, proof reads are refused so the game keeps its room. */
const BUSY_SHARE = 0.8;

/** Counts a public read, and whether the day's budget is past 80%, so the read is refused (`busy`). */
export function meterRead(hub: Hub): boolean {
  const now = Date.now();
  hub.usage.request(now);
  return hub.usage.requests(now) > BUSY_SHARE * requestBudget(hub.env);
}

/** Counts the request, then answers `busy` past 80% of the day's budget, else what `answer` reads. */
function serve(
  hub: Hub,
  answer: () => { body: unknown; age: ProofAge } | 'too-big' | null,
): Served {
  if (meterRead(hub)) return { status: 503 };
  const found = answer();
  if (found === 'too-big') return { status: 413 };
  return found
    ? { status: 200, body: JSON.stringify(found.body), age: found.age }
    : { status: 404 };
}

/** `GET /v1/proof/<creature>`: 413 when the creature's own history passes what a bundle may hold. */
export function serveProof(hub: Hub, creature: string, limits: ProofLimits = LIMITS): Served {
  return serve(hub, () => {
    if (!HEX64.test(creature)) return null;
    const built = buildBundle(hub, creature, hub.clock.now(), limits);
    if (built === 'too-big') return built;
    return built && { body: built.bundle, age: built.final ? 'dead' : 'live' };
  });
}

/** `GET /v1/fight/<enc>`: only a settled fight has a proof, and it is final. */
export function serveFight(hub: Hub, enc: string): Served {
  return serve(hub, () => {
    const proof = HEX64.test(enc) ? fightProof(hub, enc) : null;
    return proof && { body: proof, age: 'settled' };
  });
}
