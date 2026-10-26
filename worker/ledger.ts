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
  type StoredRecord,
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
  status: 'active' | 'dead';
  seq: number;
  hash: string;
  genome: string;
  activeMs: number;
  biomass: number;
  energy: number;
  health: number;
  bornT: number;
  diedT: number | null;
}

export interface PastLifeRow {
  creature: string;
  genome: string;
  activeMs: number;
  bornT: number;
  diedT: number;
  cause: Canonical | null;
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
    return this.storage.transactionSync(() => this.acceptInTransaction(input));
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

  /** Forgets a pending commitment that can't become a creature. */
  clearPending(owner: string, commitId: string): void {
    this.run("UPDATE players SET pending = '' WHERE id = ? AND pending = ?", owner, commitId);
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
         (SELECT json FROM records r WHERE r.creature = c.id AND r.kind = 'death') AS death
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
      cause: (r.death ? (JSON.parse(r.death as string) as LedgerRecord).body.cause : null) ?? null,
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

  private acceptInTransaction({
    request,
    ownerSig = null,
    genome = '',
  }: AcceptInput): AcceptResult {
    const t = this.now();
    if (request.kind !== 'genesis' && request.creature === '') return refuse('no-creature');
    const problems = recordProblems({ ...request, t });
    if (problems.length > 0) return refuse(`invalid-record:${problems[0]}`);
    const req = requestHash(request);
    if (ownerSig !== null && !verifySig(request.owner, requestMessage(request), ownerSig)) {
      return refuse('bad-owner-signature');
    }
    return request.kind === 'genesis'
      ? this.genesis(request, req, ownerSig, genome, t)
      : this.transition(request, req, ownerSig, t);
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
         (id, owner, status, seq, hash, genome, active_ms, biomass, energy, health, born_t, died_t)
       VALUES (?, ?, 'active', 0, ?, ?, 0, 0, 0, 0, ?, NULL)`,
      hash,
      request.owner,
      hash,
      genome,
      t,
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
    if (request.seq !== head.seq + 1 || request.prev !== head.hash) {
      this.flag('conflict', request, req, t);
      return refuse('conflict');
    }
    const record: LedgerRecord = { ...request, t };
    const stored = this.store(record, recordHash(record), req, ownerSig, request.creature);
    // `status` is in a partial index, so only a death assigns it and a checkpoint costs one row less.
    this.run(
      `UPDATE creatures SET seq = ?, hash = ?, active_ms = ?, biomass = ?, energy = ?, health = ?
       WHERE id = ?`,
      request.seq,
      stored.hash,
      field(request.body, 'activeMs', head.activeMs),
      field(request.body, 'biomass', head.biomass),
      field(request.body, 'energy', head.energy),
      field(request.body, 'health', head.health),
      request.creature,
    );
    if (request.kind === 'death') {
      this.run(
        "UPDATE creatures SET status = 'dead', died_t = ? WHERE id = ?",
        t,
        request.creature,
      );
    }
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

function refuse(reason: string): AcceptResult {
  return { ok: false, reason };
}

function verifySig(playerId: string, message: Uint8Array, sig: string): boolean {
  const bytes = fromBase64Url(sig);
  return bytes !== null && verify(playerId, REQUEST_DOMAIN, message, bytes);
}
