import { DurableObject } from 'cloudflare:workers';
import {
  CLOSE_BAD_HELLO,
  CLOSE_RATE_LIMITED,
  type ClientMsg,
  isOtherVersionHello,
  NONCE_BYTES,
  parseClientMsg,
} from '../src/net/protocol';
import { Admission } from './admission';
import { attest } from './attest';
import type { AuditReport } from './audit';
import { type BeaconSource, Beacons, liveSource } from './beacons';
import type { Crowds } from './crowds';
import type { Directory } from './directory';
import { Duties } from './duty';
import { engage, LOCK_BARRED, lockAnswer, lockedOut } from './engage';
import { FightStore } from './fight-store';
import { type Clock, Fights, fightInput, realClock, tick } from './fights';
import { type KeyEntry, Ledger } from './ledger';
import {
  death,
  deliverGenesis,
  history,
  lineage,
  owns,
  progress,
  promoteChild,
  queueGenesis,
  restoreAncestor,
} from './lives';
import { meteredSql, type RowCounter } from './metered-sql';
import { type Metrics, metricsOf } from './metrics';
import { court, decline, deliverBirth, mateCheck, queueAccept } from './offspring';
import { limitsOf } from './plan';
import { meterRead, type Served, serveFight, serveProof } from './proof';
import { recoverFights } from './recover';
import { ride } from './ride';
import { migrate } from './schema';
import { renewSeat } from './seat';
import { Seats } from './seats';
import { drop, hello, meterSeats, promote, queued, relay } from './sessions';
import { type Hub, keep, randomToken, send, sessionOf, socketsOf } from './socket';
import { type RecentSpawn, spawn } from './spawn';
import { TurnCredentials } from './turn';
import { UsageMeter } from './usage';
import { armCrowds, gone, rebuildCrowds, rebuildDirectory, where } from './where';
import { witnessBatch, witnessDispute } from './witness-fight';
import { avail, ipHash, playOf } from './witness-pool';

// The message handlers live by area in `sessions.ts` (sessions and signaling), `lives.ts` (genesis
// and life), `offspring.ts` (mating and offspring) and `engage.ts` (lock-in, with the locks in
// `fights.ts`); this object keeps the state, the alarm and the dispatch.

const HELLO_TIMEOUT_MS = 10_000;
const RATE_WINDOW_MS = 10_000;
const RATE_MAX_MESSAGES = 20;
/** Signals have their own window cap: joining a pond of 24 sends one offer per member (at most 23), plus retries. */
const RATE_MAX_SIGNALS = 60;
/** A fighter's inputs have their own window cap: 10 a second, with room for a burst (M7). */
const RATE_MAX_INPUTS = 130;
/**
 * A witness referee's batches and a fighter's disputes have their own window cap (ADR 0058): a
 * batch a second, with room for a catch-up and a few disputes. Past it they are dropped and counted
 * (`dropped`), and the socket stays open: a referee's frames are worth more than its link.
 */
const RATE_MAX_REFEREE = 30;
/** While anyone waits, the object looks at the queue this often (the budget resets at midnight UTC without any message). */
const QUEUE_TICK_MS = 15_000;

/** The one authority object (ADR 0008). Handles messages and alarms only: no game loop. */
export class Authority extends DurableObject<Env> implements Hub {
  // Public for the handler modules, which reach the object through `Hub`.
  declare readonly ctx: DurableObjectState<object>;
  declare readonly env: Env;
  /** Every statement's rows read and written, as the metered handle counts them (the usage meter reads it). */
  private readonly rowCount: RowCounter = { written: 0, read: 0 };
  readonly sql: SqlStorage;
  readonly turn = new TurnCredentials();
  readonly ledger: Ledger;
  readonly beacons: Beacons;
  readonly usage: UsageMeter;
  /** The line's memory (M13 T9): a wake forgets it. */
  admission = new Admission();
  private rearming: Promise<void> = Promise.resolve();
  /** Genesis requests run one at a time per player, so a second can't slip past the checks of the first. */
  readonly asking = new Map<string, Promise<void>>();
  private source: BeaconSource;
  /** Promotions run one at a time: each reads who is waiting and how much room there is fresh. */
  promoting: Promise<void> = Promise.resolve();
  /** Acceptances run one at a time: each commits to a round and then re-reads both creatures. */
  matingQueue: Promise<void> = Promise.resolve();
  nextTicket = 0;
  /** Lock-in and fights run on this clock; hub tests swap in a hand-moved one. */
  clock: Clock = realClock;
  readonly fights = new Fights(() => this.clock);
  readonly fightStore: FightStore;
  /** When the queue is looked at next; null while nobody waits (then no alarm is held for it). */
  private queueTickAt: number | null = null;
  /** Messages dropped without closing the socket, by type: past their own window's cap, a `where` refused (a jump, outside the world, past its anchor). */
  readonly dropped = new Map<ClientMsg['t'], number>();
  /** Incoming messages that parsed, by type: what a fight costs the authority (ADR 0058's cost check). */
  readonly received = new Map<ClientMsg['t'], number>();
  /** Witness duties (ADR 0058), in memory: a restart ends them all. */
  duties: Duties = new Duties(this);
  /** The sockets by seat, the line, the hellos due, the courts and the witness candidates (M13 T2): rebuilt from the attachments when the object wakes. */
  seats: Seats;
  /** Who is where (M11 T6): rebuilt from the sockets' attachments when the object wakes. */
  directory: Directory;
  /** Crowd instances (M12 T5): rebuilt from the sockets' attachments when the object wakes. */
  crowds: Crowds;
  /** The crowds' one split timer (`armCrowds` in `where.ts`). */
  crowdTimer: { at: number; handle: unknown } | null = null;
  /** Fighters whose page left the water during their fight, their instance kept until it ends. */
  readonly crowdsKept = new Set<string>();
  /** Signals the hub relayed, by unordered pair (E2E reads them). */
  readonly relays = new Map<string, number>();
  /** The spawns given in the last minute, in memory (M12 T4, `spawn.ts`). */
  readonly spawns: RecentSpawn[] = [];
  /** The salt of every session's IP hash (migration 10), read once. */
  private ipSalt: string | null = null;
  /** The owners whose indexed play the transaction running now changed, read again from SQLite if it rolls back (null outside one). */
  private playTouched: Set<string> | null = null;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // Records are dated on the hub's clock, as the fights are (hub tests swap in a hand-moved one).
    this.sql = meteredSql(ctx.storage.sql, this.rowCount);
    // The ledger and the beacons take the counted handle with the object's own transactions.
    const storage = {
      sql: this.sql,
      transactionSync: <T>(fn: () => T) => this.transaction(fn),
    };
    this.ledger = new Ledger(storage, () => this.clock.now());
    // Every record that adds active time keeps a seated player's saved play current (`seats.ts`).
    this.ledger.played = (owner, ms) => {
      if (this.seats.addPlay(owner, ms)) this.playTouched?.add(owner);
    };
    // The log's rows count with the ledger's own counter too (`rowsBesideLog` in tests reads them apart).
    this.fightStore = new FightStore(this.sql, (rows) => {
      this.ledger.rowsWritten += rows;
    });
    // The meter reads the raw handle (its own flush is counted with the rows it reports) and the metered totals.
    this.usage = new UsageMeter(
      ctx.storage.sql,
      () => this.rowCount.written,
      () => this.rowCount.read,
    );
    this.seats = new Seats(playOf(this));
    this.directory = rebuildDirectory(this);
    this.crowds = rebuildCrowds(this);
    armCrowds(this);
    this.source = this.beaconSource();
    this.beacons = new Beacons({
      storage,
      // Looked up on each use, so a test can swap the source of a live object.
      source: { now: () => this.source.now(), fetch: (round) => this.source.fetch(round) },
      countersign: (hash) => this.ledger.countersign(hash),
      rearm: () => this.rearm(),
    });
    // One transaction, so a migration (the world renewal above all) applies whole or not at all.
    // Then every fight the saved logs hold open is rebuilt before any message arrives (ADR 0053).
    ctx.blockConcurrencyWhile(async () => {
      ctx.storage.transactionSync(() => migrate(ctx.storage.sql));
      // The indexes, with each seated player's play and strike as the migrated tables hold them.
      this.rebuildSeats();
      // The seated time starts from the sockets a wake finds (the usage table exists now).
      meterSeats(this);
      recoverFights(this, this.clock.now());
    });
  }

  /** The indexes as the sockets' attachments hold them (a wake, and the E2E restart). */
  protected rebuildSeats(): void {
    const sockets = [...socketsOf(this)];
    for (const [, session] of sockets) {
      if (session?.phase === 'queued')
        this.nextTicket = Math.max(this.nextTicket, session.ticket + 1);
    }
    this.seats = new Seats(playOf(this));
    this.seats.rebuild(sockets);
  }

  /**
   * One SQLite transaction, as the ledger and the beacons run theirs: the play a record added to
   * the indexes during one that throws is read again from the rolled-back rows.
   */
  private transaction<T>(fn: () => T): T {
    const outer = this.playTouched === null;
    const touched = this.playTouched ?? new Set<string>();
    this.playTouched = touched;
    try {
      return this.ctx.storage.transactionSync(fn);
    } catch (error) {
      for (const owner of touched) this.seats.reload(owner);
      throw error;
    } finally {
      if (outer) this.playTouched = null;
    }
  }

  /** The salt of the sessions' IP hashes, which migration 10 stored in `world`. */
  private salt(): string {
    this.ipSalt ??=
      (this.sql.exec('SELECT ip_salt FROM world').toArray()[0]?.ip_salt as string | undefined) ??
      '';
    return this.ipSalt;
  }

  /** Live drand by default; the E2E entry (`worker/e2e-entry.ts`) overrides it with recorded rounds. */
  protected beaconSource(): BeaconSource {
    return liveSource();
  }

  /** The public halves of every authority key (`GET /v1/pubkeys`). */
  pubkeys(): KeyEntry[] {
    return this.ledger.pubkeys();
  }

  /** Public reads (proofs, fights, the audit) that reached the object; an edge cache hit never does (hub tests count them). */
  proofReads = 0;

  /** A creature's proof bundle (`GET /v1/proof/<creature>`, `worker/proof.ts`): reads only. */
  proof(creature: string): Served {
    this.proofReads++;
    return serveProof(this, creature);
  }

  /** A settled fight's settlement and log (`GET /v1/fight/<enc>`): reads only. */
  fight(enc: string): Served {
    this.proofReads++;
    return serveFight(this, enc);
  }

  /** The flag counts by kind for the UTC day and since the renewal (`GET /v1/audit`): no ids, reads only; null while busy. */
  audit(): AuditReport | null {
    this.proofReads++;
    if (meterRead(this)) return null;
    const bytes = this.usage.databaseBytes(Date.now());
    return {
      ...this.ledger.audit.report(this.clock.now()),
      storage: { bytes, limit: limitsOf(this.env).storageBytes },
    };
  }

  /** What the authority spends and what admission does (`GET /v1/metrics`, `worker/metrics.ts`): counted as a public read, answered even past 80% of the day's requests. */
  metrics(): Metrics {
    this.proofReads++;
    const now = Date.now();
    this.usage.request(now);
    return metricsOf(this, now);
  }

  override async fetch(request: Request): Promise<Response> {
    const pair = new WebSocketPair();
    this.ctx.acceptWebSocket(pair[1]);
    const now = Date.now();
    this.usage.upgrade(now);
    const nonce = randomToken(NONCE_BYTES);
    keep(this, pair[1], {
      phase: 'challenged',
      nonce,
      openedAt: now,
      windowStart: now,
      count: 0,
      signals: 0,
      ip: ipHash(this.salt(), request.headers.get('CF-Connecting-IP') ?? ''),
    });
    send(pair[1], { t: 'challenge', nonce });
    await this.rearm();
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  override webSocketMessage(ws: WebSocket, data: string | ArrayBuffer): void {
    const session = sessionOf(ws);
    if (!session) {
      ws.close(CLOSE_BAD_HELLO, 'no session');
      return;
    }
    if (session.phase === 'retired') return;
    const now = Date.now();
    const msg = typeof data === 'string' ? parseClientMsg(data) : null;
    this.usage.message(now, msg?.t ?? 'bad');
    if (msg) this.received.set(msg.t, (this.received.get(msg.t) ?? 0) + 1);
    if (now - session.windowStart >= RATE_WINDOW_MS) {
      session.windowStart = now;
      session.count = 0;
      session.signals = 0;
      session.inputs = 0;
      session.referee = 0;
    }
    const signal = msg?.t === 'signal';
    // Only a fighter's inputs count in their own window; anyone else's count as any message.
    const input =
      msg?.t === 'input' &&
      session.phase === 'active' &&
      this.fights.playerLocked(session.playerId);
    // Batches and disputes count in their own window only from a referee or a fighter; anyone
    // else's count as any message, so a stranger's flood still closes its socket.
    const referee =
      (msg?.t === 'batch' || msg?.t === 'dispute') &&
      session.phase === 'active' &&
      this.refereeWire(session.playerId);
    // `?? 0`: a hibernated session from before signals (or inputs) were counted has no counter.
    if (signal) session.signals = (session.signals ?? 0) + 1;
    else if (input) session.inputs = (session.inputs ?? 0) + 1;
    else if (referee) session.referee = (session.referee ?? 0) + 1;
    else session.count++;
    if (referee && msg && (session.referee ?? 0) > RATE_MAX_REFEREE) {
      this.dropped.set(msg.t, (this.dropped.get(msg.t) ?? 0) + 1);
      keep(this, ws, session);
      return;
    }
    const over = signal
      ? session.signals > RATE_MAX_SIGNALS
      : input
        ? (session.inputs ?? 0) > RATE_MAX_INPUTS
        : !referee && session.count > RATE_MAX_MESSAGES;
    if (over) {
      drop(this, ws, CLOSE_RATE_LIMITED, 'rate limited');
      return;
    }
    keep(this, ws, session);
    if (session.phase === 'challenged') {
      if (msg?.t !== 'hello') {
        // A client on another protocol version is told so, to show "Update available".
        if (typeof data === 'string' && isOtherVersionHello(data))
          send(ws, { t: 'error', code: 'version' });
        ws.close(CLOSE_BAD_HELLO, 'hello expected');
        return;
      }
      hello(this, ws, session, msg).catch(() => drop(this, ws, 1011, 'hello failed'));
      return;
    }
    if (!msg) {
      send(ws, { t: 'error', code: 'bad-message' });
      return;
    }
    if (session.phase === 'queued') {
      // A waiting session may keep the link alive or leave; everything else needs a place first.
      if (msg.t === 'ping') send(ws, { t: 'pong', id: msg.id, now });
      else if (msg.t === 'leave') drop(this, ws, 1000, 'bye');
      else if (msg.t === 'hello') drop(this, ws, CLOSE_BAD_HELLO, 'already signed in');
      else send(ws, { t: 'refused', reason: 'queued' });
      return;
    }
    if (LOCK_BARRED.has(msg.t) && lockedOut(this, ws, session)) return;
    switch (msg.t) {
      case 'ping':
        send(ws, { t: 'pong', id: msg.id, now });
        renewSeat(this, ws, session, this.clock.now());
        return;
      case 'leave':
        drop(this, ws, 1000, 'bye');
        return;
      case 'hello':
        drop(this, ws, CLOSE_BAD_HELLO, 'already signed in');
        return;
      case 'signal':
        relay(this, ws, session, msg);
        return;
      case 'genesis-request':
        queueGenesis(this, ws, session, msg);
        return;
      case 'progress':
        progress(this, ws, session, msg, this.clock.now());
        return;
      case 'death':
        death(this, ws, session, msg, this.clock.now());
        return;
      case 'history':
        history(this, ws, session.playerId);
        return;
      case 'lineage':
        lineage(this, ws, session.playerId);
        return;
      case 'promote':
        if (owns(ws, session, msg.request)) promoteChild(this, ws, session, msg, this.clock.now());
        return;
      case 'restore':
        if (owns(ws, session, msg.request))
          restoreAncestor(this, ws, session, msg, this.clock.now());
        return;
      case 'mate-check':
        mateCheck(this, ws, session, msg.partner);
        return;
      case 'court':
        court(this, ws, session, msg.ask, now);
        return;
      case 'accept':
        queueAccept(this, ws, msg.ask);
        return;
      case 'decline':
        decline(this, ws, session, msg.partner);
        return;
      case 'engage':
        engage(this, ws, session, msg);
        return;
      case 'lock-state':
        lockAnswer(this, ws, session, msg);
        return;
      case 'input':
        fightInput(this, session, msg);
        return;
      case 'avail':
        avail(this, ws, session, msg);
        return;
      case 'duty-ok':
      case 'duty-no':
        this.duties.answer(ws, session, msg);
        return;
      case 'batch':
        witnessBatch(this, session, msg);
        return;
      case 'dispute':
        witnessDispute(this, session, msg);
        return;
      case 'attest':
        attest(this, session, msg);
        return;
      case 'where':
        where(this, ws, session, msg);
        return;
      case 'gone':
        gone(this, ws, session);
        return;
      case 'spawn':
        spawn(this, ws, session, msg);
        return;
      case 'ride':
        ride(this, ws, session);
        return;
    }
  }

  /** Whether this player may send batches and disputes in their own window: it fights, or holds a referee duty. */
  private refereeWire(player: string): boolean {
    return this.fights.playerLocked(player) || this.duties.holding(player)?.role === 'referee';
  }

  override webSocketClose(ws: WebSocket, code: number): void {
    // A close frame can't echo the reserved "no status" code 1005.
    drop(this, ws, code === 1005 ? 1000 : code);
  }

  override webSocketError(ws: WebSocket): void {
    drop(this, ws, 1011, 'error');
  }

  /**
   * Closes sockets that never said hello, resolves due commitments, steps the fights due, and
   * re-arms for whatever is still waiting.
   */
  override async alarm(): Promise<void> {
    const now = Date.now();
    for (const [ws, openedAt] of [...this.seats.challenged()]) {
      if (openedAt + HELLO_TIMEOUT_MS > now) continue;
      this.seats.forgetHello(ws);
      try {
        ws.close(CLOSE_BAD_HELLO, 'hello timeout');
      } catch {
        // already closed
      }
    }
    try {
      // The fights' watchdog: an object that only its alarm woke rebuilds them, and each steps every frame due.
      recoverFights(this, this.clock.now());
      for (const lock of this.fights.running()) tick(this, lock.id, this.clock.now());
      // The budget resets at midnight with no message to say so, so the queue is looked at on a timer.
      // Reset first, so the re-arm inside `promote` doesn't read the tick that just fired; it arms the next one if anyone still waits.
      this.queueTickAt = null;
      if (queued(this).length > 0) await promote(this);
      for (const id of await this.beacons.alarm()) {
        // One commitment failing must not strand the others this pass resolved.
        await this.deliverGenesis(id).catch(() => {});
        // A witness commitment's order is drawn, and a running fight's referee offered (`duty.ts`).
        try {
          this.duties.resolved(id);
        } catch (error) {
          console.error('witness duty failed', error);
        }
      }
      // Matings whose round is published, including one marked resolved whose children were not written (an eviction in between).
      for (const id of this.ledger.openMatingCommits()) {
        if (this.beacons.status(id) === 'ready') await deliverBirth(this, id).catch(() => {});
      }
    } finally {
      await this.rearm();
    }
  }

  /** When the earliest socket that hasn't said hello times out, or null. Sockets already closing don't count. */
  private helloDue(): number | null {
    let next: number | null = null;
    for (const [ws, openedAt] of [...this.seats.challenged()]) {
      if (ws.readyState > WebSocket.READY_STATE_OPEN) {
        this.seats.forgetHello(ws);
        continue;
      }
      const due = openedAt + HELLO_TIMEOUT_MS;
      next = Math.min(next ?? due, due);
    }
    return next;
  }

  /** When the admission queue is looked at next, or null while it is empty. */
  private queueDue(): number | null {
    if (queued(this).length === 0) {
      this.queueTickAt = null;
      return null;
    }
    this.queueTickAt ??= Date.now() + QUEUE_TICK_MS;
    return this.queueTickAt;
  }

  /** Writes the genesis record once the commitment's beacon exists and sends it to the owner (`lives.ts`). */
  private deliverGenesis(commitId: string): Promise<void> {
    return deliverGenesis(this, commitId);
  }

  /**
   * The object has one alarm: it is set for the earliest of the hello timeout, the next beacon, the
   * queue tick and the fights' watchdog, and cleared when none is needed.
   */
  rearm(): Promise<void> {
    // One at a time, each reading fresh deadlines, so a slow caller can't overwrite a sooner alarm.
    const run = this.rearming.then(() => this.setAlarmForNext());
    this.rearming = run.catch(() => {});
    return run;
  }

  private async setAlarmForNext(): Promise<void> {
    const hello = this.helloDue();
    const beacon = this.beacons.nextDue();
    const queue = this.queueDue();
    const next = earliest(hello, beacon, queue, this.fights.watchDue());
    const current = await this.ctx.storage.getAlarm();
    if (next === null) {
      if (current !== null) await this.ctx.storage.deleteAlarm();
    } else if (current === null || Math.abs(current - next) > 50) {
      await this.ctx.storage.setAlarm(next);
    }
  }
}

/** The earliest of the times that are set. */
const earliest = (...times: (number | null)[]): number | null =>
  times.reduce<number | null>((a, b) => (a === null ? b : b === null ? a : Math.min(a, b)), null);
