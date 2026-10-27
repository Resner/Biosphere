import type { Canonical } from '../src/ledger/canonical';
import { fromBase64Url, verify } from '../src/ledger/identity';
import {
  authorityKeyId,
  authorityPublicKey,
  authoritySign,
  creatureId,
  type LedgerRecord,
  type PubKey,
  REQUEST_DOMAIN,
  type RecordRequest,
  recordHash,
  recordProblems,
  requestHash,
  requestMessage,
  type Status,
  type StoredRecord,
  transitionOutcome,
} from '../src/ledger/record';
import { RULES_VERSION } from '../src/sim/rules';

// The ledger store (ADR 0019): plain functions over SQLite, so tests need no sockets. Every
// accepted record is one transaction that appends to a creature's chain and moves its head.

const SECRET_BYTES = 32;
/** The genesis bucket: a burst of 3 hatches that refills one per 5 minutes. */
export const HATCH_BUCKET = 3;
export const HATCH_REFILL_MS = 300_000;

export interface AcceptInput {
  request: RecordRequest;
  /** Base64url signature of `requestMessage(request)` when the owner started the transition. */
  ownerSig?: string | null;
  /** Genesis only: the genome text the record's genome hash names. */
  genome?: string;
}

export type AcceptResult =
  | { ok: true; stored: StoredRecord; fresh: boolean }
  | { ok: false; reason: string };

export interface Head {
  id: string;
  owner: string;
  status: Status;
  seq: number;
  hash: string;
  genome: string;
  activeMs: number;
  biomass: number;
  energy: number;
  health: number;
  bornT: number;
  diedT: number | null;
  generation: number;
  parentA: string | null;
  parentB: string | null;
  /** The creature that was active when this one was promoted (the checkpoint chain, ADR 0021). */
  chainParent: string | null;
  cooldownUntilMs: number;
}

/** What a record body saves of a creature's state. */
export interface Condition {
  activeMs: number;
  biomass: number;
  energy: number;
  health: number;
  cooldownUntilMs: number;
}

/** When a frozen creature has too little life left to be worth restoring (ADR 0021). */
export interface Exhaustion {
  lifespanOf(head: Head): number;
  restoreMinMs: number;
}

export interface MateInput {
  commit: string;
  round: number;
  /** A's then B's `mate-commit` request, already carrying the costs and the cooldown. */
  requests: [RecordRequest, RecordRequest];
}

export type MateResult =
  | { ok: true; stored: [StoredRecord, StoredRecord]; fresh: boolean }
  | { ok: false; reason: string; conflict?: true };

export interface BirthChild {
  request: RecordRequest;
  genome: string;
  /** The hatchling's condition; its `activeMs` and cooldown start at zero. */
  condition: Pick<Condition, 'biomass' | 'energy' | 'health'>;
}

export interface BirthInput {
  commit: string;
  /** The courting player's child, then the accepting player's. */
  children: [BirthChild, BirthChild];
}

export type BirthResult =
  | { ok: true; stored: [StoredRecord, StoredRecord]; fresh: boolean }
  | { ok: false; reason: string };

export type PromoteResult =
  | { ok: true; stored: StoredRecord; frozen: StoredRecord | null; fresh: boolean }
  | { ok: false; reason: string };

export interface Fallback {
  pending: Head | null;
  ancestor: Head | null;
  /** Frozen creatures walked over that have too little life left; callers mark them dead. */
  exhausted: Head[];
}

export interface PastLifeRow {
  creature: string;
  genome: string;
  activeMs: number;
  bornT: number;
  diedT: number;
  cause: Canonical | null | undefined;
}

export interface Flag {
  kind: string;
  owner: string;
  creature: string;
  hash: string;
  t: number;
}

export interface KeyEntry extends PubKey {
  /** When the authority first used this key, ms. */
  from: number;
}

type Row = Record<string, SqlStorageValue>;

interface Storage {
  sql: SqlStorage;
  transactionSync<T>(fn: () => T): T;
}

const asHead = (r: Row): Head => ({
  id: r.id as string,
  owner: r.owner as string,
  status: r.status as Head['status'],
  seq: r.seq as number,
  hash: r.hash as string,
  genome: r.genome as string,
  activeMs: r.active_ms as number,
  biomass: r.biomass as number,
  energy: r.energy as number,
  health: r.health as number,
  bornT: r.born_t as number,
  diedT: r.died_t as number | null,
  generation: r.generation as number,
  parentA: r.parent_a as string | null,
  parentB: r.parent_b as string | null,
  chainParent: r.chain_parent as string | null,
  cooldownUntilMs: r.cooldown_until_ms as number,
});

const asStored = (r: Row): StoredRecord => ({
  record: JSON.parse(r.json as string) as LedgerRecord,
  hash: r.hash as string,
  ownerSig: r.owner_sig as string | null,
  authSig: r.auth_sig as string,
  keyId: r.key_id as string,
});

/** A condition field of a record body, or the head's current value when the body has none. */
function field(body: LedgerRecord['body'], key: string, fallback: number): number {
  const value = body[key];
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : fallback;
}

export class Ledger {
  /** Rows written through this ledger since it was made (the usage meter and the write-budget tests read it). */
  rowsWritten = 0;
  private signing: { id: string; secret: Uint8Array } | null = null;

  constructor(
    readonly storage: Storage,
    private readonly now: () => number = Date.now,
  ) {}

  /**
   * Callers (the hub) have already authenticated `request.owner`; `ownerSig` is for transitions the owner starts.
   * The key is made before the transaction, so a rollback can't leave a cached key that `keys` doesn't hold.
   */
  accept(input: AcceptInput): AcceptResult {
    this.key();
    return this.storage.transactionSync(() => this.acceptInTransaction(input, false));
  }

  /**
   * Starts a mating (ADR 0021): both `mate-commit` records, both heads and the `matings` row in one
   * transaction, or nothing. The caller has checked the pair against its view and built the
   * requests (costs and cooldown included); this checks that they agree with each other, with the
   * heads and with the rules a store can see. A head that moved is a `conflict`.
   */
  mate(input: MateInput): MateResult {
    this.key();
    return this.storage.transactionSync(() => this.mateInTransaction(input));
  }

  /** Delivers a mating's two children as `pending` creatures, once; the parents' chains are untouched. */
  birth(input: BirthInput): BirthResult {
    this.key();
    return this.storage.transactionSync(() => this.birthInTransaction(input));
  }

  /**
   * Promotes a pending child (`request` is owner-signed, role `child`): the child becomes active and
   * its chain parent is the creature named in the body, which is frozen in the same transaction when
   * it is still active (`freeze` overrides the condition it keeps, otherwise its head's).
   */
  promote(
    request: RecordRequest,
    ownerSig: string,
    freeze: Partial<Condition> = {},
  ): PromoteResult {
    this.key();
    return this.storage.transactionSync(() => this.promoteInTransaction(request, ownerSig, freeze));
  }

  /** Makes the nearest surviving ancestor active again with its saved condition (`request` is owner-signed). */
  restore(request: RecordRequest, ownerSig: string, rule: Exhaustion): AcceptResult {
    this.key();
    return this.storage.transactionSync(() => this.restoreInTransaction(request, ownerSig, rule));
  }

  /** Ends a frozen creature whose remaining life is under `restoreMinMs`, with cause `old-age`. */
  markExhausted(creature: string, rule: Exhaustion): AcceptResult {
    this.key();
    return this.storage.transactionSync(() => {
      const head = this.head(creature);
      if (!head) return refuse('unknown-creature');
      if (head.status === 'dead') {
        const death = this.deathRecord(creature);
        return death && death.record.body.cause === 'old-age' && death.ownerSig === null
          ? { ok: true, stored: death, fresh: false }
          : refuse('dead');
      }
      if (head.status !== 'checkpoint') return refuse(`status:${head.status}`);
      if (!isExhausted(head, rule)) return refuse('not-exhausted');
      return this.acceptInTransaction(
        {
          request: {
            v: 1,
            rules: RULES_VERSION,
            kind: 'death',
            creature,
            seq: head.seq + 1,
            prev: head.hash,
            owner: head.owner,
            body: {
              cause: 'old-age',
              activeMs: head.activeMs,
              biomass: head.biomass,
              energy: head.energy,
              health: head.health,
            },
          },
        },
        true,
      );
    });
  }

  /**
   * What the player can fall back on after `creature` (usually just dead): their pending child, and
   * the nearest surviving ancestor on the checkpoint chain. Frozen creatures with too little life
   * left are skipped and listed; this is read only, so the caller marks them.
   */
  fallback(creature: string, rule: Exhaustion): Fallback {
    const start = this.head(creature);
    if (!start) return { pending: null, ancestor: null, exhausted: [] };
    const pendingRow = this.run(
      "SELECT * FROM creatures WHERE owner = ? AND status = 'pending'",
      start.owner,
    )[0];
    const pending = pendingRow ? asHead(pendingRow) : null;
    const exhausted: Head[] = [];
    const seen = new Set<string>([creature]);
    for (let at = start.chainParent; at && !seen.has(at); ) {
      seen.add(at);
      const head = this.head(at);
      if (!head) break;
      if (head.status === 'checkpoint') {
        if (!isExhausted(head, rule)) return { pending, ancestor: head, exhausted };
        exhausted.push(head);
      }
      at = head.chainParent;
    }
    return { pending, ancestor: null, exhausted };
  }

  /** Whether the player has a creature that is not dead: active, pending or frozen. */
  alive(owner: string): boolean {
    return (
      this.run("SELECT 1 FROM creatures WHERE owner = ? AND status != 'dead' LIMIT 1", owner)
        .length > 0
    );
  }

  /** Matings between the two players (either way round) made at or after `since`. */
  pairMatings(ownerA: string, ownerB: string, since: number): number {
    const row = this.run(
      `SELECT COUNT(*) AS n FROM matings WHERE t >= ?3 AND
         ((owner_a = ?1 AND owner_b = ?2) OR (owner_a = ?2 AND owner_b = ?1))`,
      ownerA,
      ownerB,
      since,
    )[0];
    return row ? (row.n as number) : 0;
  }

  head(creature: string): Head | null {
    const row = this.run('SELECT * FROM creatures WHERE id = ?', creature)[0];
    return row ? asHead(row) : null;
  }

  /** Appends an authority-started record to a creature's chain (`checkpoint` or `death`), on top of the head the caller read. */
  append(head: Head, kind: 'checkpoint' | 'death', body: LedgerRecord['body']): AcceptResult {
    return this.accept({
      request: {
        v: 1,
        rules: RULES_VERSION,
        kind,
        creature: head.id,
        seq: head.seq + 1,
        prev: head.hash,
        owner: head.owner,
        body,
      },
    });
  }

  /** The player's active creature, or null. */
  active(owner: string): Head | null {
    const row = this.run("SELECT * FROM creatures WHERE owner = ? AND status = 'active'", owner)[0];
    return row ? asHead(row) : null;
  }

  /** Hatches left at `now`, and the ms until the next one when none is. */
  hatches(owner: string, now: number): { left: number; genesisIn: number } {
    const row = this.run('SELECT hatches, hatch_t FROM players WHERE id = ?', owner)[0];
    return row ? reconcile(row.hatches as number, row.hatch_t as number, now).state : FULL_BUCKET;
  }

  /** The commitment the player's genesis is waiting on, or ''. */
  pendingCommit(owner: string): string {
    const row = this.run('SELECT pending FROM players WHERE id = ?', owner)[0];
    return row ? (row.pending as string) : '';
  }

  /**
   * Forgets a pending commitment that can't become a creature and gives its hatch back (never above
   * the full bucket). Only a commitment still pending is refunded, so a repeat delivery refunds nothing.
   */
  refundHatch(owner: string, commitId: string, now: number): void {
    this.storage.transactionSync(() => {
      const row = this.run('SELECT hatches, hatch_t, pending FROM players WHERE id = ?', owner)[0];
      if (!row || row.pending !== commitId) return;
      const { state, t } = reconcile(row.hatches as number, row.hatch_t as number, now);
      this.run(
        "UPDATE players SET pending = '', hatches = ?, hatch_t = ? WHERE id = ?",
        Math.min(HATCH_BUCKET, state.left + 1),
        t,
        owner,
      );
    });
  }

  /** Spends one hatch for a new commitment and remembers it as the player's pending one. */
  takeHatch(owner: string, commitId: string, now: number): number {
    const row = this.run('SELECT hatches, hatch_t FROM players WHERE id = ?', owner)[0];
    const { state, hatches, t } = reconcile(
      row ? (row.hatches as number) : HATCH_BUCKET,
      row ? (row.hatch_t as number) : now,
      now,
    );
    const left = Math.max(0, state.left - 1);
    // A full bucket restarts its clock when it first drops; otherwise the fraction of a refill already earned is kept.
    this.run(
      `INSERT INTO players (id, first_seen, last_seen, hatches, hatch_t, pending) VALUES (?1, ?2, ?2, ?3, ?4, ?5)
       ON CONFLICT (id) DO UPDATE SET last_seen = ?2, hatches = ?3, hatch_t = ?4, pending = ?5`,
      owner,
      now,
      left,
      hatches >= HATCH_BUCKET ? now : t,
      commitId,
    );
    return left;
  }

  /** The record that ended the creature's life, or null while it lives. */
  deathRecord(creature: string): StoredRecord | null {
    const row = this.run(
      "SELECT * FROM records WHERE creature = ? AND kind = 'death'",
      creature,
    )[0];
    return row ? asStored(row) : null;
  }

  /** The player's finished lives, newest death first, with the cause their death record names. */
  history(owner: string, limit: number): PastLifeRow[] {
    return this.run(
      `SELECT c.id, c.genome, c.active_ms, c.born_t, c.died_t,
         (SELECT json FROM records r WHERE r.creature = c.id AND r.seq = c.seq AND r.kind = 'death') AS death
       FROM creatures c WHERE c.owner = ? AND c.status = 'dead'
       ORDER BY c.died_t DESC, c.born_t DESC LIMIT ?`,
      owner,
      limit,
    ).map((r) => ({
      creature: r.id as string,
      genome: r.genome as string,
      activeMs: r.active_ms as number,
      bornT: r.born_t as number,
      diedT: r.died_t as number,
      cause: r.death ? (JSON.parse(r.death as string) as LedgerRecord).body.cause : null,
    }));
  }

  /** A creature's records in order. */
  chain(creature: string): StoredRecord[] {
    return this.run('SELECT * FROM records WHERE creature = ? ORDER BY seq', creature).map(
      asStored,
    );
  }

  flags(creature: string): Flag[] {
    return this.run('SELECT * FROM flags WHERE creature = ? ORDER BY id', creature).map((r) => ({
      kind: r.kind as string,
      owner: r.owner as string,
      creature: r.creature as string,
      hash: r.hash as string,
      t: r.t as number,
    }));
  }

  /** Countersigns a hash (a commitment id) with the current key, making the key on first use. The secret stays here. */
  countersign(hash: string): { authSig: string; keyId: string } {
    const key = this.key();
    return { authSig: authoritySign(key.secret, hash), keyId: key.id };
  }

  /** Every authority key ever used, public halves only; makes the first key when there is none. */
  pubkeys(): KeyEntry[] {
    this.key();
    return this.run('SELECT id, public_key, from_t FROM keys ORDER BY from_t, id').map((r) => ({
      id: r.id as string,
      publicKey: r.public_key as string,
      from: r.from_t as number,
    }));
  }

  /** `frozenDeath` lets a `death` follow a `checkpoint` creature; only `markExhausted` sets it. */
  private acceptInTransaction(
    { request, ownerSig = null, genome = '' }: AcceptInput,
    frozenDeath: boolean,
  ): AcceptResult {
    const t = this.now();
    if (request.kind !== 'genesis' && request.creature === '') return refuse('no-creature');
    // The kinds that touch two chains or need an owner's word have their own operations.
    if (!SINGLE_RECORD_KINDS.includes(request.kind)) return refuse('use-operation');
    const problems = recordProblems({ ...request, t });
    if (problems.length > 0) return refuse(`invalid-record:${problems[0]}`);
    const req = requestHash(request);
    if (ownerSig !== null && !verifySig(request.owner, requestMessage(request), ownerSig)) {
      return refuse('bad-owner-signature');
    }
    return request.kind === 'genesis'
      ? this.genesis(request, req, ownerSig, genome, t)
      : this.transition(request, req, ownerSig, t, frozenDeath);
  }

  /** The reason an owner-signed request is refused before any state is read; null when it is fine. */
  private ownerSigned(request: RecordRequest, ownerSig: string, t: number): string | null {
    const problems = recordProblems({ ...request, t });
    if (problems.length > 0) return `invalid-record:${problems[0]}`;
    return verifySig(request.owner, requestMessage(request), ownerSig)
      ? null
      : 'bad-owner-signature';
  }

  private genesis(
    request: RecordRequest,
    req: string,
    ownerSig: string | null,
    genome: string,
    t: number,
  ): AcceptResult {
    const known = this.run('SELECT creature FROM genesis_log WHERE req = ?', req)[0];
    if (known) {
      const first = this.run(
        'SELECT * FROM records WHERE creature = ? AND seq = 0',
        known.creature as string,
      )[0];
      if (first) return { ok: true, stored: asStored(first), fresh: false };
    }
    if (this.active(request.owner)) return refuse('already-active');
    const record: LedgerRecord = { ...request, t };
    const hash = creatureId(record);
    const stored = this.store(record, hash, req, ownerSig, hash);
    this.run(
      `INSERT INTO players (id, first_seen, last_seen) VALUES (?1, ?2, ?2)
       ON CONFLICT (id) DO UPDATE SET last_seen = ?2,
         pending = CASE WHEN pending = ?3 THEN '' ELSE pending END`,
      request.owner,
      t,
      String(request.body.commit ?? ''),
    );
    this.run(
      `INSERT INTO creatures
         (id, owner, status, seq, hash, genome, active_ms, biomass, energy, health, born_t, died_t, generation)
       VALUES (?, ?, 'active', 0, ?, ?, 0, 0, 0, 0, ?, NULL, ?)`,
      hash,
      request.owner,
      hash,
      genome,
      t,
      field(request.body, 'generation', 0),
    );
    this.run(
      'INSERT INTO genesis_log (req, creature, owner, t) VALUES (?, ?, ?, ?)',
      req,
      hash,
      request.owner,
      t,
    );
    return { ok: true, stored, fresh: true };
  }

  private transition(
    request: RecordRequest,
    req: string,
    ownerSig: string | null,
    t: number,
    frozenDeath = false,
  ): AcceptResult {
    const head = this.head(request.creature);
    if (!head) return refuse('unknown-creature');
    if (head.owner !== request.owner) {
      this.flag('wrong-owner', request, req, t);
      return refuse('wrong-owner');
    }
    const again = this.run(
      'SELECT * FROM records WHERE creature = ? AND seq = ? AND req = ?',
      request.creature,
      request.seq,
      req,
    )[0];
    if (again) return { ok: true, stored: asStored(again), fresh: false };
    if (head.status === 'dead') return refuse('dead');
    const role = request.kind === 'promote' ? String(request.body.role) : null;
    const outcome = transitionOutcome(request.kind, role, head.status);
    if (!outcome.ok) return refuse(outcome.reason);
    // A frozen creature dies only when it is exhausted, which `markExhausted` has checked.
    if (request.kind === 'death' && head.status === 'checkpoint' && !frozenDeath) {
      return refuse('not-exhausted');
    }
    if (request.seq !== head.seq + 1 || request.prev !== head.hash) {
      this.flag('conflict', request, req, t);
      return refuse('conflict');
    }
    const record: LedgerRecord = { ...request, t };
    const stored = this.store(record, recordHash(record), req, ownerSig, request.creature);
    this.advance(head, record, stored.hash, outcome.next, t);
    return { ok: true, stored, fresh: true };
  }

  /**
   * Moves a head to the record just stored: the condition the body saves, and the status when it
   * changes. `status` is in partial indexes, so it is only assigned when it changes.
   */
  private advance(head: Head, record: LedgerRecord, hash: string, next: Status, t: number): void {
    const condition = [
      record.seq,
      hash,
      field(record.body, 'activeMs', head.activeMs),
      field(record.body, 'biomass', head.biomass),
      field(record.body, 'energy', head.energy),
      field(record.body, 'health', head.health),
      field(record.body, 'cooldownUntilMs', head.cooldownUntilMs),
    ];
    if (next === head.status) {
      this.run(
        `UPDATE creatures SET seq = ?, hash = ?, active_ms = ?, biomass = ?, energy = ?, health = ?,
           cooldown_until_ms = ? WHERE id = ?`,
        ...condition,
        head.id,
      );
      return;
    }
    this.run(
      `UPDATE creatures SET seq = ?, hash = ?, active_ms = ?, biomass = ?, energy = ?, health = ?,
         cooldown_until_ms = ?, status = ?, died_t = ? WHERE id = ?`,
      ...condition,
      next,
      next === 'dead' ? t : head.diedT,
      head.id,
    );
  }

  private mateInTransaction({ commit, round, requests }: MateInput): MateResult {
    const t = this.now();
    const hashes = requests.map((r) => requestHash(r));
    if (this.run('SELECT 1 FROM matings WHERE commit_id = ?', commit).length > 0) {
      const found = requests.map(
        (r, i) =>
          this.run(
            'SELECT * FROM records WHERE creature = ? AND seq = ? AND req = ?',
            r.creature,
            r.seq,
            hashes[i] as string,
          )[0],
      );
      const [first, second] = found;
      return first && second
        ? { ok: true, stored: [asStored(first), asStored(second)], fresh: false }
        : { ok: false, reason: 'commit-used' };
    }
    const [ra, rb] = requests;
    const [a, b] = [this.head(ra.creature), this.head(rb.creature)];
    if (!a || !b) return refuse('unknown-creature');
    const heads = [a, b];
    for (const [i, r] of requests.entries()) {
      const problems = recordProblems({ ...r, t });
      if (r.kind !== 'mate-commit' || problems.length > 0) {
        return refuse(`invalid-record:${problems[0] ?? 'kind'}`);
      }
      if ((heads[i] as Head).owner !== r.owner) {
        this.flag('wrong-owner', r, hashes[i] as string, t);
        return refuse('wrong-owner');
      }
    }
    if (a.owner === b.owner) return refuse('self');
    const agrees = (self: Head, other: Head, r: RecordRequest, role: 'a' | 'b') =>
      r.body.commit === commit &&
      r.body.round === round &&
      r.body.role === role &&
      r.body.partner === other.owner &&
      r.body.partnerCreature === other.id &&
      r.body.generation === self.generation;
    if (!agrees(a, b, ra, 'a') || !agrees(b, a, rb, 'b')) return refuse('pair-mismatch');
    for (const head of heads) {
      const outcome = transitionOutcome('mate-commit', null, head.status);
      if (!outcome.ok) return refuse(head.status === 'dead' ? 'dead' : outcome.reason);
    }
    const owners = [a.owner, b.owner];
    const [oa, ob] = owners;
    if (
      this.run(
        'SELECT 1 FROM matings WHERE resolved = 0 AND (owner_a IN (?1, ?2) OR owner_b IN (?1, ?2))',
        oa as string,
        ob as string,
      ).length > 0
    ) {
      return refuse('in-flight');
    }
    if (
      this.run(
        "SELECT 1 FROM creatures WHERE status = 'pending' AND owner IN (?1, ?2)",
        oa as string,
        ob as string,
      ).length > 0
    ) {
      return refuse('pending');
    }
    for (const [i, r] of requests.entries()) {
      const head = heads[i] as Head;
      if (r.seq !== head.seq + 1 || r.prev !== head.hash) {
        this.flag('conflict', r, hashes[i] as string, t);
        return { ok: false, reason: 'conflict', conflict: true };
      }
    }
    const stored = requests.map((r, i) => {
      const record: LedgerRecord = { ...r, t };
      const s = this.store(record, recordHash(record), hashes[i] as string, null, r.creature);
      this.advance(heads[i] as Head, record, s.hash, 'active', t);
      return s;
    }) as [StoredRecord, StoredRecord];
    this.run(
      `INSERT INTO matings (commit_id, owner_a, owner_b, creature_a, creature_b, round, t)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      commit,
      a.owner,
      b.owner,
      a.id,
      b.id,
      round,
      t,
    );
    return { ok: true, stored, fresh: true };
  }

  private birthInTransaction({ commit, children }: BirthInput): BirthResult {
    const t = this.now();
    const mating = this.run('SELECT * FROM matings WHERE commit_id = ?', commit)[0];
    if (!mating) return refuse('unknown-commit');
    const owners = [mating.owner_a as string, mating.owner_b as string];
    const hashes = children.map((c) => requestHash(c.request));
    if (mating.resolved) {
      const found = [mating.child_a, mating.child_b].map((id, i) =>
        id
          ? this.run(
              'SELECT * FROM records WHERE creature = ? AND seq = 0 AND req = ?',
              id as string,
              hashes[i] as string,
            )[0]
          : undefined,
      );
      const [first, second] = found;
      return first && second
        ? { ok: true, stored: [asStored(first), asStored(second)], fresh: false }
        : { ok: false, reason: 'resolved' };
    }
    for (const [i, child] of children.entries()) {
      const r = child.request;
      const problems = recordProblems({ ...r, t });
      if (r.kind !== 'birth' || problems.length > 0) {
        return refuse(`invalid-record:${problems[0] ?? 'kind'}`);
      }
      const parents = r.body.parents as string[];
      if (
        r.owner !== owners[i] ||
        r.body.commit !== commit ||
        r.body.round !== mating.round ||
        parents[0] !== mating.creature_a ||
        parents[1] !== mating.creature_b
      ) {
        return refuse('birth-mismatch');
      }
    }
    if (
      this.run(
        "SELECT 1 FROM creatures WHERE status = 'pending' AND owner IN (?1, ?2)",
        owners[0] as string,
        owners[1] as string,
      ).length > 0
    ) {
      return refuse('pending');
    }
    const stored = children.map((child, i) => {
      const record: LedgerRecord = { ...child.request, t };
      const hash = creatureId(record);
      const s = this.store(record, hash, hashes[i] as string, null, hash);
      this.run(
        `INSERT INTO creatures
           (id, owner, status, seq, hash, genome, active_ms, biomass, energy, health, born_t, died_t,
            generation, parent_a, parent_b, chain_parent, cooldown_until_ms)
         VALUES (?, ?, 'pending', 0, ?, ?, 0, ?, ?, ?, ?, NULL, ?, ?, ?, NULL, 0)`,
        hash,
        record.owner,
        hash,
        child.genome,
        child.condition.biomass,
        child.condition.energy,
        child.condition.health,
        t,
        field(record.body, 'generation', 0),
        mating.creature_a as string,
        mating.creature_b as string,
      );
      return s;
    }) as [StoredRecord, StoredRecord];
    this.run(
      'UPDATE matings SET resolved = 1, child_a = ?, child_b = ? WHERE commit_id = ?',
      stored[0].hash,
      stored[1].hash,
      commit,
    );
    return { ok: true, stored, fresh: true };
  }

  private promoteInTransaction(
    request: RecordRequest,
    ownerSig: string,
    freeze: Partial<Condition>,
  ): PromoteResult {
    const t = this.now();
    const bad = this.ownerSigned(request, ownerSig, t);
    if (bad) return refuse(bad);
    if (request.kind !== 'promote' || request.body.role !== 'child') return refuse('role');
    const req = requestHash(request);
    const child = this.head(request.creature);
    if (!child) return refuse('unknown-creature');
    if (child.owner !== request.owner) {
      this.flag('wrong-owner', request, req, t);
      return refuse('wrong-owner');
    }
    const again = this.run(
      'SELECT * FROM records WHERE creature = ? AND seq = ? AND req = ?',
      request.creature,
      request.seq,
      req,
    )[0];
    if (again) {
      const frozen = this.run(
        "SELECT * FROM records WHERE creature = ? AND kind = 'promote' ORDER BY seq DESC LIMIT 1",
        String(request.body.parent),
      )[0];
      const mine = frozen ? asStored(frozen) : null;
      return {
        ok: true,
        stored: asStored(again),
        frozen:
          mine?.record.body.role === 'parent' && mine.record.body.child === child.id ? mine : null,
        fresh: false,
      };
    }
    if (child.status === 'dead') return refuse('dead');
    const outcome = transitionOutcome('promote', 'child', child.status);
    if (!outcome.ok) return refuse(outcome.reason);
    if (request.seq !== child.seq + 1 || request.prev !== child.hash) {
      this.flag('conflict', request, req, t);
      return refuse('conflict');
    }
    const parent = this.head(String(request.body.parent));
    if (!parent || parent.owner !== child.owner || parent.id === child.id)
      return refuse('bad-parent');
    const active = this.active(child.owner);
    // The parent is the player's active creature (frozen now), or, with none active, the one that died last.
    if (active ? active.id !== parent.id : !this.isLastDead(parent)) return refuse('bad-parent');
    let frozen: StoredRecord | null = null;
    if (active) {
      const outcomeParent = transitionOutcome('promote', 'parent', parent.status);
      if (!outcomeParent.ok) return refuse('bad-parent');
      const record: LedgerRecord = {
        v: 1,
        rules: request.rules,
        kind: 'promote',
        creature: parent.id,
        seq: parent.seq + 1,
        prev: parent.hash,
        owner: parent.owner,
        t,
        body: {
          role: 'parent',
          child: child.id,
          activeMs: freeze.activeMs ?? parent.activeMs,
          biomass: freeze.biomass ?? parent.biomass,
          energy: freeze.energy ?? parent.energy,
          health: freeze.health ?? parent.health,
          cooldownUntilMs: freeze.cooldownUntilMs ?? parent.cooldownUntilMs,
        },
      };
      frozen = this.store(record, recordHash(record), requestHash(record), null, parent.id);
      this.advance(parent, record, frozen.hash, outcomeParent.next, t);
    }
    const record: LedgerRecord = { ...request, t };
    const stored = this.store(record, recordHash(record), req, ownerSig, request.creature);
    this.advance(child, record, stored.hash, outcome.next, t);
    this.run('UPDATE creatures SET chain_parent = ? WHERE id = ?', parent.id, child.id);
    return { ok: true, stored, frozen, fresh: true };
  }

  /** Whether `head` is the player's most recently dead creature. */
  private isLastDead(head: Head): boolean {
    if (head.status !== 'dead') return false;
    const last = this.run(
      "SELECT id FROM creatures WHERE owner = ? AND status = 'dead' ORDER BY died_t DESC, born_t DESC LIMIT 1",
      head.owner,
    )[0];
    return last?.id === head.id;
  }

  private restoreInTransaction(
    request: RecordRequest,
    ownerSig: string,
    rule: Exhaustion,
  ): AcceptResult {
    const t = this.now();
    const bad = this.ownerSigned(request, ownerSig, t);
    if (bad) return refuse(bad);
    if (request.kind !== 'restore') return refuse('kind');
    const req = requestHash(request);
    const head = this.head(request.creature);
    if (!head) return refuse('unknown-creature');
    if (head.owner !== request.owner) {
      this.flag('wrong-owner', request, req, t);
      return refuse('wrong-owner');
    }
    const again = this.run(
      'SELECT * FROM records WHERE creature = ? AND seq = ? AND req = ?',
      request.creature,
      request.seq,
      req,
    )[0];
    if (again) return { ok: true, stored: asStored(again), fresh: false };
    if (head.status === 'dead') return refuse('dead');
    const outcome = transitionOutcome('restore', null, head.status);
    if (!outcome.ok) return refuse(outcome.reason);
    if (request.seq !== head.seq + 1 || request.prev !== head.hash) {
      this.flag('conflict', request, req, t);
      return refuse('conflict');
    }
    if (this.active(head.owner)) return refuse('active-exists');
    const saved: Condition = {
      activeMs: head.activeMs,
      biomass: head.biomass,
      energy: head.energy,
      health: head.health,
      cooldownUntilMs: head.cooldownUntilMs,
    };
    if (Object.entries(saved).some(([key, value]) => request.body[key] !== value)) {
      return refuse('condition-mismatch');
    }
    const from = this.head(String(request.body.from));
    if (
      !from ||
      from.owner !== head.owner ||
      from.status !== 'dead' ||
      this.fallback(from.id, rule).ancestor?.id !== head.id
    ) {
      return refuse('not-nearest');
    }
    const record: LedgerRecord = { ...request, t };
    const stored = this.store(record, recordHash(record), req, ownerSig, request.creature);
    this.advance(head, record, stored.hash, outcome.next, t);
    return { ok: true, stored, fresh: true };
  }

  private store(
    record: LedgerRecord,
    hash: string,
    req: string,
    ownerSig: string | null,
    creature: string,
  ): StoredRecord {
    const key = this.key();
    const authSig = authoritySign(key.secret, hash);
    this.run(
      `INSERT INTO records (creature, seq, hash, req, kind, owner, t, json, owner_sig, auth_sig, key_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      creature,
      record.seq,
      hash,
      req,
      record.kind,
      record.owner,
      record.t,
      JSON.stringify(record),
      ownerSig,
      authSig,
      key.id,
    );
    return { record, hash, ownerSig, authSig, keyId: key.id };
  }

  private flag(kind: string, request: RecordRequest, hash: string, t: number): void {
    // One row per distinct request, so a replayed bad request can't grow the log.
    this.insertFlag(kind, request.owner, request.creature, hash, t, 'hash');
  }

  /** Notes a death report that names no creature of the player's: one row per player, however often it repeats. */
  flagStray(owner: string, t: number): void {
    this.insertFlag('stray-death', owner, '', owner, t, 'hash');
  }

  /** Notes an implausible report: one row per kind and creature, however many connections send it. */
  flagImplausible(kind: string, owner: string, creature: string, t: number): void {
    this.insertFlag(kind, owner, creature, '', t, 'creature');
  }

  private insertFlag(
    kind: string,
    owner: string,
    creature: string,
    hash: string,
    t: number,
    uniqueBy: 'hash' | 'creature',
  ): void {
    this.run(
      `INSERT INTO flags (kind, owner, creature, hash, t)
       SELECT ?1, ?2, ?3, ?4, ?5 WHERE NOT EXISTS (SELECT 1 FROM flags WHERE kind = ?1 AND ${uniqueBy} = ?6)`,
      kind,
      owner,
      creature,
      hash,
      t,
      uniqueBy === 'hash' ? hash : creature,
    );
  }

  /** The signing key: made on first use, then kept in `keys` and in memory. It is never returned by any public method. */
  private key(): { id: string; secret: Uint8Array } {
    if (this.signing) return this.signing;
    const row = this.run('SELECT secret FROM keys ORDER BY from_t DESC, id LIMIT 1')[0];
    const secret = row
      ? new Uint8Array(row.secret as ArrayBuffer)
      : crypto.getRandomValues(new Uint8Array(SECRET_BYTES));
    const publicKey = authorityPublicKey(secret);
    const id = authorityKeyId(publicKey);
    if (!row) {
      this.run(
        'INSERT INTO keys (id, public_key, secret, from_t) VALUES (?, ?, ?, ?)',
        id,
        publicKey,
        secret.slice().buffer,
        this.now(),
      );
    }
    this.signing = { id, secret };
    return this.signing;
  }

  /** All SQL goes through here: it drains the cursor and counts the rows written. */
  private run(query: string, ...bindings: SqlStorageValue[]): Row[] {
    const cursor = this.storage.sql.exec<Row>(query, ...bindings);
    const rows = cursor.toArray();
    this.rowsWritten += cursor.rowsWritten;
    return rows;
  }
}

/** The kinds `accept` takes: one record on one chain. The others have their own operations. */
const SINGLE_RECORD_KINDS: readonly string[] = ['genesis', 'checkpoint', 'death'];

/** Whether a frozen creature's remaining life is under the restore minimum. */
const isExhausted = (head: Head, rule: Exhaustion): boolean =>
  rule.lifespanOf(head) - head.activeMs < rule.restoreMinMs;

const FULL_BUCKET = { left: HATCH_BUCKET, genesisIn: 0 };

/** The bucket at `now` from what was stored: the count refilled, and the clock moved on by whole refills. */
function reconcile(
  stored: number,
  storedT: number,
  now: number,
): { state: { left: number; genesisIn: number }; hatches: number; t: number } {
  if (stored >= HATCH_BUCKET) return { state: FULL_BUCKET, hatches: HATCH_BUCKET, t: now };
  const earned = Math.max(0, Math.floor((now - storedT) / HATCH_REFILL_MS));
  const left = Math.min(HATCH_BUCKET, stored + earned);
  const t = storedT + earned * HATCH_REFILL_MS;
  const genesisIn = left > 0 ? 0 : Math.max(0, t + HATCH_REFILL_MS - now);
  return { state: { left, genesisIn }, hatches: left, t };
}

function refuse(reason: string): { ok: false; reason: string } {
  return { ok: false, reason };
}

function verifySig(playerId: string, message: Uint8Array, sig: string): boolean {
  const bytes = fromBase64Url(sig);
  return bytes !== null && verify(playerId, REQUEST_DOMAIN, message, bytes);
}
