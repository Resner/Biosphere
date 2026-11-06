import {
  type AuditFlag,
  type AuthorityKey,
  type FightProof,
  PROOF_MAX_BYTES,
  PROOF_MAX_CREATURES,
  type ProofBundle,
} from '../src/ledger/proof';
import { HEX64, type StoredRecord } from '../src/ledger/record';
import type { FightLog, SignedSettlement } from '../src/ledger/settlement';
import type { EncJoin, EncStart } from '../src/net/encounter-start';
import type { SignedCommit } from '../src/net/protocol-defs';
import { byteLength } from '../src/net/protocol-kit';
import { RULES_VERSION } from '../src/sim/rules';
import { asStored, type Row } from './ledger-types';
import { scalesOf } from './mating';
import { requestBudget } from './sessions';
import type { Hub } from './socket';

// What verification needs, served from the ledger alone (ADR 0055, M9 T7): a creature's proof
// bundle (`GET /v1/proof/<creature>`) and a fight's settlement with its log (`GET /v1/fight/<enc>`).
// Reads only: every query goes through `read`, which counts any row written as `Ledger.run` does,
// so a test sees that nothing is.

/** How far a bundle may grow: `PROOF_MAX_CREATURES` and `PROOF_MAX_BYTES` (tests pass smaller ones). */
export interface ProofLimits {
  creatures: number;
  bytes: number;
}

const LIMITS: ProofLimits = { creatures: PROOF_MAX_CREATURES, bytes: PROOF_MAX_BYTES };

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

/** The JSON size of a value in UTF-8 bytes, plus the comma that follows it in a list. */
const sizeOf = (v: unknown): number => byteLength(JSON.stringify(v)) + 1;

/** The bundle's reads, each made once, and the size of each document. */
class Reader {
  private readonly creatures = new Map<string, Known | null>();
  private readonly commits = new Map<string, SignedCommit | null>();
  private readonly beacons = new Map<number, { round: number; signature: string } | null>();
  private readonly settlements = new Map<string, SignedSettlement | null>();
  private readonly flags = new Map<string, AuditFlag[]>();
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
      this.commits.set(
        id,
        row
          ? {
              commitment: JSON.parse(row.json as string),
              authSig: row.auth_sig as string,
              keyId: row.key_id as string,
            }
          : null,
      );
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

/** The bundle of `held` (the subject first, then ancestors nearest first). */
function assemble(reader: Reader, frame: Frame, held: readonly Known[]): ProofBundle {
  const chains = prefixes(held);
  const records = held.flatMap((k) => chains.get(k.id) ?? []);
  const named = (field: string) =>
    [
      ...new Set(records.map((s) => s.record.body[field]).filter((v) => typeof v === 'string')),
    ] as string[];
  const commits = named('commit')
    .map((id) => reader.commit(id))
    .filter((c): c is SignedCommit => c !== null);
  const rounds = [...new Set(commits.map((c) => c.commitment.round))].sort((x, y) => x - y);
  const ids = new Set(held.map((k) => k.id));
  const more = [...new Set(held.flatMap(parentsOf))].filter((id) => !ids.has(id));
  return {
    v: 1,
    kind: 'proof',
    subject: held[0]?.id ?? '',
    world: frame.world,
    keys: frame.keys,
    creatures: held.map((k) => ({ id: k.id, genome: k.genome })),
    records,
    commits,
    beacons: rounds.map((r) => reader.beacon(r)).filter((b) => b !== null),
    settlements: named('enc')
      .map((enc) => reader.settlement(enc))
      .filter((s): s is SignedSettlement => s !== null),
    flags: held.flatMap((k) => reader.flagsOf(k.id)),
    more,
    t: frame.t,
  };
}

/** An upper bound of the bundle's JSON size: its frame, and each list item with a comma. */
function sizeBound(reader: Reader, b: ProofBundle): number {
  const frame = byteLength(
    JSON.stringify({
      ...b,
      creatures: [],
      records: [],
      commits: [],
      beacons: [],
      settlements: [],
      flags: [],
      more: [],
    }),
  );
  let n = frame;
  for (const list of [b.records, b.commits, b.beacons, b.settlements, b.flags]) {
    for (const item of list) n += reader.size(item);
  }
  for (const c of b.creatures) n += sizeOf(c);
  for (const id of b.more) n += id.length + 3;
  return n;
}

/**
 * `creature`'s proof bundle, or null for an unknown creature: its whole chain, then its ancestors
 * breadth-first (nearest first, ties by id), each up to the record that ties it to its descendant
 * (the longer when reached twice), with the commitments, beacons and settlements those records
 * name, the keys, the world and the held creatures' flags. At `limits` creatures, or before the
 * bundle would pass `limits.bytes`, it stops; `more` names the parents it left out.
 */
export function proofBundle(
  hub: Hub,
  creature: string,
  now: number,
  limits: ProofLimits = LIMITS,
): ProofBundle | null {
  return buildBundle(hub, creature, now, limits)?.bundle ?? null;
}

/** `proofBundle`, with whether its subject is dead (so the bundle can never change). */
function buildBundle(
  hub: Hub,
  creature: string,
  now: number,
  limits: ProofLimits,
): { bundle: ProofBundle; final: boolean } | null {
  const reader = new Reader(hub);
  const subject = reader.creature(creature);
  if (!subject) return null;
  const held: Known[] = [subject];
  const seen = new Set([subject.id]);
  let level: Known[] = [subject];
  const frame = frameOf(hub, now);
  let bundle = assemble(reader, frame, held);
  grow: while (level.length > 0) {
    const ids = [...new Set(level.flatMap(parentsOf))].filter((id) => !seen.has(id)).sort();
    const next: Known[] = [];
    for (const id of ids) {
      const k = reader.creature(id);
      if (!k) continue;
      if (held.length >= limits.creatures) break grow;
      const tried = assemble(reader, frame, [...held, k]);
      if (sizeBound(reader, tried) > limits.bytes) break grow;
      held.push(k);
      seen.add(id);
      next.push(k);
      bundle = tried;
    }
    level = next;
  }
  return { bundle, final: subject.status === 'dead' };
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
  const log: FightLog | null = start
    ? {
        pondSeed: settlement.settlement.pondSeed,
        start: JSON.parse(start) as EncStart,
        joins: JSON.parse(row.joins as string) as EncJoin[],
        frames: JSON.parse(row.frames as string) as (number | null)[][],
      }
    : null;
  return { settlement, log };
}

/** A proof read as the Worker serves it: the JSON, and whether it can never change (cached a day). */
export type Served = { status: 200; body: string; final: boolean } | { status: 404 | 503 };

/** Past this share of the day's request budget, proof reads are refused so the game keeps its room. */
const BUSY_SHARE = 0.8;

/** Counts the request, then answers `busy` past 80% of the day's budget, else what `answer` reads. */
function serve(hub: Hub, answer: () => { body: unknown; final: boolean } | null): Served {
  const now = Date.now();
  hub.usage.request(now);
  if (hub.usage.requests(now) > BUSY_SHARE * requestBudget(hub.env)) return { status: 503 };
  const found = answer();
  return found
    ? { status: 200, body: JSON.stringify(found.body), final: found.final }
    : { status: 404 };
}

/** `GET /v1/proof/<creature>`: a dead creature's bundle never changes. */
export function serveProof(hub: Hub, creature: string): Served {
  return serve(hub, () => {
    if (!HEX64.test(creature)) return null;
    const built = buildBundle(hub, creature, hub.clock.now(), LIMITS);
    return built && { body: built.bundle, final: built.final };
  });
}

/** `GET /v1/fight/<enc>`: only a settled fight has a proof, and it is final. */
export function serveFight(hub: Hub, enc: string): Served {
  return serve(hub, () => {
    const proof = HEX64.test(enc) ? fightProof(hub, enc) : null;
    return proof && { body: proof, final: true };
  });
}
