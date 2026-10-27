import { type Canonical, canonicalize, hashWithDomain } from '../src/ledger/canonical';
import { type Beacon, fetchBeacon, roundAt, roundTime, verifyBeacon } from '../src/ledger/drand';
import { type Commitment, commitmentId } from '../src/ledger/genesis';

// The beacon service (ADR 0010): verified drand beacons cached in SQLite, and commitments that
// name a future round before it exists. A commitment's round is fixed when it is made; nothing in
// this module can change it, cancel it or substitute a value.

const REQUEST_DOMAIN = 'bs/creq/v1';
/** After a round is due, the network is given this long to publish it before the first fetch. */
const ALARM_MARGIN_MS = 500;
/** Between failed fetches of a due round: doubles from the first to the cap while the network stays down. */
const RETRY_MS = 5000;
const RETRY_MAX_MS = 60_000;
const RECENT_MAX = 8;

/** Where beacons come from, and what time it is for them. Tests and the e2e entry fake both. */
export interface BeaconSource {
  now(): number;
  /** A beacon for the round (or the newest one); throws when unavailable. Callers verify it. */
  fetch(round: number | 'latest'): Promise<Beacon>;
}

export function liveSource(): BeaconSource {
  return { now: () => Date.now(), fetch: (round) => fetchBeacon(round, (...a) => fetch(...a)) };
}

export interface SignedCommitment {
  commitment: Commitment;
  id: string;
  authSig: string;
  keyId: string;
  status: CommitStatus;
}

export type CommitStatus = 'awaiting' | 'ready';
const statusOf = (resolved: SqlStorageValue | undefined): CommitStatus =>
  resolved === null ? 'awaiting' : 'ready';

type Row = Record<string, SqlStorageValue>;

const requestKey = (kind: string, owner: string, data: Canonical): string =>
  hashWithDomain(REQUEST_DOMAIN, canonicalize({ kind, owner, data }));

const asSigned = (row: Row): SignedCommitment => ({
  commitment: JSON.parse(row.json as string) as Commitment,
  id: row.id as string,
  authSig: row.auth_sig as string,
  keyId: row.key_id as string,
  status: statusOf(row.resolved),
});

export interface BeaconsDeps {
  storage: {
    sql: SqlStorage;
    transactionSync<T>(fn: () => T): T;
  };
  source: BeaconSource;
  countersign(hash: string): { authSig: string; keyId: string };
  /** Called after the pending set grows, so the owner of the alarm slot can re-arm it. */
  rearm(): Promise<void>;
}

export class Beacons {
  rowsWritten = 0;
  /** Verified beacons fetched for `latest()`, kept in memory so they cost no row writes. */
  private readonly recent = new Map<number, Beacon>();
  private readonly inFlight = new Map<number, Promise<Beacon | null>>();
  private retryAt = 0;
  private retryMs = RETRY_MS;
  /** Unresolved commitments (id to round), loaded once so the alarm paths never scan the table. */
  private waiting: Map<string, number> | null = null;

  constructor(private readonly deps: BeaconsDeps) {}

  /** The newest verified beacon the clock says is published; null when none can be had. */
  async latest(): Promise<Beacon | null> {
    const target = roundAt(this.deps.source.now());
    for (const round of [target, target - 1]) {
      const beacon = round >= 1 ? (this.cached(round) ?? (await this.verified(round))) : null;
      if (beacon) return beacon;
    }
    const newest = await this.fetchVerified('latest');
    if (newest && newest.round <= target) {
      this.remember(newest);
      return newest;
    }
    return this.cachedBefore(target);
  }

  /** A verified beacon for `round`, from the table or fetched and stored; null when unavailable. */
  async get(round: number): Promise<Beacon | null> {
    const cached = this.cached(round);
    if (cached) return cached;
    const running = this.inFlight.get(round);
    if (running) return running;
    const work = this.verified(round).then((beacon) => {
      if (beacon) this.store(beacon);
      return beacon;
    });
    this.inFlight.set(round, work);
    try {
      return await work;
    } finally {
      this.inFlight.delete(round);
    }
  }

  /** A beacon the table already holds (every resolved commitment's is), or null. Never fetches. */
  stored(round: number): Beacon | null {
    return this.cached(round);
  }

  /**
   * Commits to the round after the newest published one. The same `kind`, `owner` and `data` always
   * return the same commitment, so callers put a fresh nonce in `data` for each new request.
   */
  async commit(kind: string, owner: string, data: Canonical): Promise<SignedCommitment> {
    const req = requestKey(kind, owner, data);
    const known = this.byReq(req);
    if (known) return known;
    const latest = await this.latest();
    const now = this.deps.source.now();
    // Without a latest beacon the clock still bounds it: `roundAt(now)` is never ahead of the network.
    const round = Math.max((latest?.round ?? roundAt(now)) + 2, roundAt(now) + 1);
    const out = this.deps.storage.transactionSync(() => {
      // Another call with the same request may have finished while this one waited for the network.
      const winner = this.byReq(req);
      if (winner) return winner;
      const commitment: Commitment = { v: 1, kind, owner, round, req, t: now, data };
      const id = commitmentId(commitment);
      const { authSig, keyId } = this.deps.countersign(id);
      this.run(
        `INSERT INTO commitments (id, kind, owner, round, req, json, auth_sig, key_id, created, resolved)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
        id,
        kind,
        owner,
        round,
        req,
        JSON.stringify(commitment),
        authSig,
        keyId,
        now,
      );
      return { commitment, id, authSig, keyId, status: 'awaiting' as const };
    });
    if (out.status === 'awaiting') this.pendingSet().set(out.id, out.commitment.round);
    await this.deps.rearm();
    return out;
  }

  /** The commitment an earlier `commit` with the same arguments made, or null. Writes nothing. */
  find(kind: string, owner: string, data: Canonical): SignedCommitment | null {
    return this.byReq(requestKey(kind, owner, data));
  }

  /** A commitment by id, or null. */
  commitment(id: string): SignedCommitment | null {
    const row = this.run('SELECT * FROM commitments WHERE id = ?', id)[0];
    return row ? asSigned(row) : null;
  }

  status(id: string): CommitStatus | null {
    const row = this.run('SELECT resolved FROM commitments WHERE id = ?', id)[0];
    return row ? statusOf(row.resolved) : null;
  }

  /** The commitment's beacon once its round is published; null while it is not (or unknown). */
  async beaconFor(id: string): Promise<Beacon | null> {
    const row = this.run('SELECT round, resolved FROM commitments WHERE id = ?', id)[0];
    if (!row) return null;
    const round = row.round as number;
    if (row.resolved === null && roundTime(round) > this.deps.source.now()) return null;
    const beacon = await this.get(round);
    if (beacon && row.resolved === null) {
      this.run('UPDATE commitments SET resolved = ? WHERE id = ?', this.deps.source.now(), id);
      this.pendingSet().delete(id);
    }
    return beacon;
  }

  pending(): number {
    return this.pendingSet().size;
  }

  /** The wall-clock time of the next alarm this service needs, or null when nothing is pending. */
  nextDue(): number | null {
    let first = Infinity;
    for (const round of this.pendingSet().values()) first = Math.min(first, round);
    if (first === Infinity) return null;
    const due = Math.max(roundTime(first) + ALARM_MARGIN_MS, this.retryAt);
    return Date.now() + Math.max(0, due - this.deps.source.now());
  }

  /** Resolves every pending commitment whose round the network now serves, and returns their ids. */
  async alarm(): Promise<string[]> {
    const current = roundAt(this.deps.source.now());
    const due = [...this.pendingSet()].filter(([, round]) => round <= current);
    due.sort((a, b) => a[1] - b[1]);
    // A round that failed is not asked again in this pass, however many commitments name it.
    const failed = new Set<number>();
    const resolved: string[] = [];
    for (const [id, round] of due) {
      if (failed.has(round)) continue;
      if (await this.beaconFor(id)) resolved.push(id);
      else failed.add(round);
    }
    if (failed.size === 0) {
      this.retryAt = 0;
      this.retryMs = RETRY_MS;
    } else {
      this.retryAt = this.deps.source.now() + this.retryMs;
      this.retryMs = Math.min(this.retryMs * 2, RETRY_MAX_MS);
    }
    return resolved;
  }

  private pendingSet(): Map<string, number> {
    this.waiting ??= new Map(
      this.run('SELECT id, round FROM commitments WHERE resolved IS NULL').map((r) => [
        r.id as string,
        r.round as number,
      ]),
    );
    return this.waiting;
  }

  private byReq(req: string): SignedCommitment | null {
    const row = this.run('SELECT * FROM commitments WHERE req = ?', req)[0];
    return row ? asSigned(row) : null;
  }

  private cached(round: number): Beacon | null {
    const row = this.run('SELECT signature FROM beacons WHERE round = ?', round)[0];
    return row ? { round, signature: row.signature as string } : null;
  }

  private cachedBefore(target: number): Beacon | null {
    const row = this.run(
      'SELECT round, signature FROM beacons WHERE round <= ? ORDER BY round DESC LIMIT 1',
      target,
    )[0];
    return row ? { round: row.round as number, signature: row.signature as string } : null;
  }

  private store(beacon: Beacon): void {
    this.run(
      'INSERT OR IGNORE INTO beacons (round, signature) VALUES (?, ?)',
      beacon.round,
      beacon.signature,
    );
  }

  /** A beacon for `round` that verified, from memory or the source; never stored here. */
  private async verified(round: number): Promise<Beacon | null> {
    const held = this.recent.get(round);
    if (held) return held;
    const beacon = await this.fetchVerified(round);
    if (beacon) this.remember(beacon);
    return beacon;
  }

  private async fetchVerified(round: number | 'latest'): Promise<Beacon | null> {
    try {
      const beacon = await this.deps.source.fetch(round);
      if (round !== 'latest' && beacon.round !== round) return null;
      return verifyBeacon(beacon) ? { round: beacon.round, signature: beacon.signature } : null;
    } catch {
      return null;
    }
  }

  private remember(beacon: Beacon): void {
    this.recent.set(beacon.round, beacon);
    if (this.recent.size > RECENT_MAX)
      this.recent.delete(this.recent.keys().next().value as number);
  }

  private run(query: string, ...bindings: SqlStorageValue[]): Row[] {
    const cursor = this.deps.storage.sql.exec<Row>(query, ...bindings);
    const rows = cursor.toArray();
    this.rowsWritten += cursor.rowsWritten;
    return rows;
  }
}
