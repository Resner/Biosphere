import { DurableObject } from 'cloudflare:workers';
import { type Genome, genomeFromBase64url, genomeToBase64url } from '../src/genome/codec';
import { express } from '../src/genome/express';
import { speciesName } from '../src/genome/names';
import { offspringPair } from '../src/genome/offspring';
import { buildCreature } from '../src/genome/stats';
import { type GenesisAsk, verifyGenesisAsk } from '../src/ledger/ask';
import type { Canonical } from '../src/ledger/canonical';
import { randomnessOf } from '../src/ledger/drand';
import { genesisFor, genesisRequest } from '../src/ledger/genesis';
import {
  fromBase64Url,
  HELLO_DOMAIN,
  helloMessage,
  toBase64Url,
  verify,
} from '../src/ledger/identity';
import { birthRequest, checkMatePair, type MateAsk, signedBy } from '../src/ledger/mating';
import { kinship } from '../src/ledger/pedigree';
import type { StoredRecord } from '../src/ledger/record';
import {
  type Born,
  byteLength,
  CLOSE_BAD_HELLO,
  CLOSE_RATE_LIMITED,
  CLOSE_REPLACED,
  type ClientMsg,
  HISTORY_MAX,
  type HubMsg,
  type IceServer,
  isCause,
  isOtherVersionHello,
  type LifeInfo,
  type Member,
  NONCE_BYTES,
  type PondInfo,
  parseClientMsg,
  SDP_MAX_BYTES,
  type SignedCommit,
  SPAWN_GOLDEN_ANGLE,
  type Vec2,
} from '../src/net/protocol';
import { isProfane } from '../src/net/text';
import { lifespanMs } from '../src/sim/life';
import { hatchling } from '../src/sim/mating';
import { RULES, RULES_VERSION } from '../src/sim/rules';
import { sizeTier } from '../src/sim/size';
import type { DeathCause } from '../src/sim/types';
import { maxHealth } from '../src/sim/vitals';
import { type BeaconSource, Beacons, liveSource, type SignedCommitment } from './beacons';
import { type BirthChild, type Head, type KeyEntry, Ledger } from './ledger';
import {
  applyReport,
  bindLife,
  checkpointDue,
  creditTicks,
  isOld,
  type LifeState,
  unsaved,
} from './life';
import {
  askLive,
  type Court,
  cooldownFor,
  fixtureScale,
  mateRequests,
  matureAtMsOf,
  refusalFor,
  repeatWindowMs,
  viewOf,
} from './mating';
import { migrate, type PondRow } from './schema';
import { TurnCredentials } from './turn';
import { UsageMeter } from './usage';

const HELLO_TIMEOUT_MS = 10_000;
const RATE_WINDOW_MS = 10_000;
const RATE_MAX_MESSAGES = 20;
/** Signals have their own window cap: joining a pond of 24 sends one offer per member (at most 23), plus retries. */
const RATE_MAX_SIGNALS = 60;
const POND_CAPACITY = 24;
/** New sessions queue once the day's requests reach this share of the budget (DESIGN §8). */
const BUDGET_SHARE = 0.9;
/** A queued session's estimated wait per place, until M13 measures it. */
const ETA_S_PER_PLACE = 30;
/** While anyone waits, the object looks at the queue this often (the budget resets at midnight UTC without any message). */
const QUEUE_TICK_MS = 15_000;
const DEFAULT_MAX_SESSIONS = 200;
const DEFAULT_DAILY_REQUEST_BUDGET = 100_000;
/** A joiner takes the first free slot `i` of its pond: angle `i · SPAWN_GOLDEN_ANGLE`, radius `RING_BASE + RING_STEP · i` (DESIGN.md). */
const RING_BASE = 300;
const RING_STEP = 40;

/** Per-socket state, kept in the hibernation attachment (survives eviction, never touches SQLite). */
type Session = (
  | { phase: 'challenged'; nonce: string }
  | {
      phase: 'active';
      playerId: string;
      name: string;
      pondId: string;
      slot: number;
      /** The creature this connection is playing and what it has reported (absent without one). */
      life?: LifeState | undefined;
      /** The mating this player has offered, until the partner answers (lazy expiry, no timer). */
      court?: Court | undefined;
    }
  | {
      /** Signed in, but admission is full: waits for a place and is in no pond. */
      phase: 'queued';
      playerId: string;
      name: string;
      /** Arrival order; the lowest ticket is next. */
      ticket: number;
      /** The place last announced (1 = next), so only a change is sent again. */
      place: number;
    }
  | { phase: 'retired' }
) & { openedAt: number; windowStart: number; count: number; signals: number };

/** The one authority object (ADR 0008). Handles messages and alarms only: no game loop. */
export class Authority extends DurableObject<Env> {
  readonly turn = new TurnCredentials();
  readonly ledger: Ledger;
  readonly beacons: Beacons;
  readonly usage: UsageMeter;
  private rearming: Promise<void> = Promise.resolve();
  /** Genesis requests run one at a time per player, so a second can't slip past the checks of the first. */
  private readonly asking = new Map<string, Promise<void>>();
  private source: BeaconSource;
  /** Promotions run one at a time: each reads who is waiting and how much room there is fresh. */
  private promoting: Promise<void> = Promise.resolve();
  /** Acceptances run one at a time: each commits to a round and then re-reads both creatures. */
  private matingQueue: Promise<void> = Promise.resolve();
  private nextTicket = 0;
  /** When the queue is looked at next; null while nobody waits (then no alarm is held for it). */
  private queueTickAt: number | null = null;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.ledger = new Ledger(ctx.storage);
    this.usage = new UsageMeter(ctx.storage.sql, () => this.ledger.rowsWritten);
    for (const ws of ctx.getWebSockets()) {
      const session = sessionOf(ws);
      if (session?.phase === 'queued')
        this.nextTicket = Math.max(this.nextTicket, session.ticket + 1);
    }
    this.source = this.beaconSource();
    this.beacons = new Beacons({
      storage: ctx.storage,
      // Looked up on each use, so a test can swap the source of a live object.
      source: { now: () => this.source.now(), fetch: (round) => this.source.fetch(round) },
      countersign: (hash) => this.ledger.countersign(hash),
      rearm: () => this.rearm(),
    });
    ctx.blockConcurrencyWhile(async () => migrate(ctx.storage.sql));
  }

  /** Live drand by default; the E2E entry (`worker/e2e-entry.ts`) overrides it with recorded rounds. */
  protected beaconSource(): BeaconSource {
    return liveSource();
  }

  /** The public halves of every authority key (`GET /v1/pubkeys`). */
  pubkeys(): KeyEntry[] {
    return this.ledger.pubkeys();
  }

  override async fetch(): Promise<Response> {
    const pair = new WebSocketPair();
    this.ctx.acceptWebSocket(pair[1]);
    const now = Date.now();
    this.usage.upgrade(now);
    const nonce = randomToken(NONCE_BYTES);
    pair[1].serializeAttachment({
      phase: 'challenged',
      nonce,
      openedAt: now,
      windowStart: now,
      count: 0,
      signals: 0,
    } satisfies Session);
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
    this.usage.message(now);
    const msg = typeof data === 'string' ? parseClientMsg(data) : null;
    if (now - session.windowStart >= RATE_WINDOW_MS) {
      session.windowStart = now;
      session.count = 0;
      session.signals = 0;
    }
    const signal = msg?.t === 'signal';
    // `?? 0`: a hibernated session from before signals were counted has no counter.
    if (signal) session.signals = (session.signals ?? 0) + 1;
    else session.count++;
    if (signal ? session.signals > RATE_MAX_SIGNALS : session.count > RATE_MAX_MESSAGES) {
      this.drop(ws, CLOSE_RATE_LIMITED, 'rate limited');
      return;
    }
    ws.serializeAttachment(session);
    if (session.phase === 'challenged') {
      if (msg?.t !== 'hello') {
        // A client on another protocol version is told so, to show "Update available".
        if (typeof data === 'string' && isOtherVersionHello(data))
          send(ws, { t: 'error', code: 'version' });
        ws.close(CLOSE_BAD_HELLO, 'hello expected');
        return;
      }
      this.hello(ws, session, msg).catch(() => this.drop(ws, 1011, 'hello failed'));
      return;
    }
    if (!msg) {
      send(ws, { t: 'error', code: 'bad-message' });
      return;
    }
    if (session.phase === 'queued') {
      // A waiting session may keep the link alive or leave; everything else needs a place first.
      if (msg.t === 'ping') send(ws, { t: 'pong', id: msg.id, now });
      else if (msg.t === 'leave') this.drop(ws, 1000, 'bye');
      else if (msg.t === 'hello') this.drop(ws, CLOSE_BAD_HELLO, 'already signed in');
      else send(ws, { t: 'refused', reason: 'queued' });
      return;
    }
    switch (msg.t) {
      case 'ping':
        send(ws, { t: 'pong', id: msg.id, now });
        return;
      case 'leave':
        this.drop(ws, 1000, 'bye');
        return;
      case 'hello':
        this.drop(ws, CLOSE_BAD_HELLO, 'already signed in');
        return;
      case 'signal':
        this.relay(ws, session, msg);
        return;
      case 'genesis-request':
        this.queueGenesis(ws, session, msg);
        return;
      case 'progress':
        this.progress(ws, session, msg, now);
        return;
      case 'death':
        this.death(ws, session, msg, now);
        return;
      case 'history':
        this.history(ws, session.playerId);
        return;
      case 'mate-check':
        this.mateCheck(ws, session, msg.partner);
        return;
      case 'court':
        this.court(ws, session, msg.ask, now);
        return;
      case 'accept':
        this.queueAccept(ws, msg.ask);
        return;
      case 'decline':
        this.decline(ws, session, msg.partner);
        return;
    }
  }

  override webSocketClose(ws: WebSocket, code: number): void {
    // A close frame can't echo the reserved "no status" code 1005.
    this.drop(ws, code === 1005 ? 1000 : code);
  }

  override webSocketError(ws: WebSocket): void {
    this.drop(ws, 1011, 'error');
  }

  /** Closes sockets that never said hello, resolves due commitments, and re-arms for whatever is still waiting. */
  override async alarm(): Promise<void> {
    const now = Date.now();
    for (const ws of this.ctx.getWebSockets()) {
      const session = sessionOf(ws);
      if (session?.phase === 'challenged' && session.openedAt + HELLO_TIMEOUT_MS <= now) {
        ws.close(CLOSE_BAD_HELLO, 'hello timeout');
      }
    }
    try {
      // The budget resets at midnight with no message to say so, so the queue is looked at on a timer.
      // Reset first, so the re-arm inside `promote` doesn't read the tick that just fired; it arms the next one if anyone still waits.
      this.queueTickAt = null;
      if (this.queued().length > 0) await this.promote();
      for (const id of await this.beacons.alarm()) {
        // One commitment failing must not strand the others this pass resolved.
        await this.deliverGenesis(id).catch(() => {});
      }
      // Matings whose round is published, including one marked resolved whose children were not written (an eviction in between).
      for (const id of this.ledger.openMatingCommits()) {
        if (this.beacons.status(id) === 'ready') await this.deliverBirth(id).catch(() => {});
      }
    } finally {
      await this.rearm();
    }
  }

  /** Starts a genesis request after any earlier one from the same player has finished. */
  private queueGenesis(
    ws: WebSocket,
    session: ActiveSession,
    msg: ClientMsg & { t: 'genesis-request' },
  ): void {
    const earlier = this.asking.get(session.playerId) ?? Promise.resolve();
    const run: Promise<void> = earlier
      .then(() => this.genesisRequest(ws, session.playerId, msg))
      .catch(() => sendIfOpen(ws, { t: 'error', code: 'genesis-failed' }))
      .finally(() => {
        if (this.asking.get(session.playerId) === run) this.asking.delete(session.playerId);
      });
    this.asking.set(session.playerId, run);
  }

  /**
   * ADR 0019: commits to a future round for the player's next creature. The same request returns the
   * same commitment, and a player who already has one waiting gets that one back, never a second round.
   */
  private async genesisRequest(ws: WebSocket, owner: string, ask: GenesisAsk): Promise<void> {
    if (!verifyGenesisAsk(owner, ask)) {
      sendIfOpen(ws, { t: 'refused', reason: 'bad-signature' });
      return;
    }
    const data = { nonce: ask.nonce, sig: ask.sig };
    const bucket = this.ledger.hatches(owner, Date.now());
    let hatchesLeft = bucket.left;
    let commit = this.beacons.find('genesis', owner, data);
    if (
      commit &&
      commit.id !== this.ledger.pendingCommit(owner) &&
      !this.isActiveBirth(owner, commit.id)
    ) {
      // A signed ask is good for one creature: replaying it after that creature is gone gets nothing.
      sendIfOpen(ws, { t: 'refused', reason: 'used' });
      return;
    }
    if (!commit) {
      const waiting = this.ledger.pendingCommit(owner);
      commit = waiting ? this.beacons.commitment(waiting) : null;
    }
    if (!commit) {
      if (this.ledger.active(owner)) {
        // The client may have missed it (a late genesis): the creature comes first, then the refusal.
        this.sendLife(ws, owner);
        sendIfOpen(ws, { t: 'refused', reason: 'active' });
        return;
      }
      if (hatchesLeft < 1) {
        sendIfOpen(ws, { t: 'refused', reason: 'limit', genesisIn: bucket.genesisIn });
        return;
      }
      commit = await this.beacons.commit('genesis', owner, data);
      hatchesLeft = this.ledger.takeHatch(owner, commit.id, Date.now());
    }
    sendIfOpen(ws, { t: 'commit', commit: signedOf(commit), hatchesLeft });
    await this.deliverGenesis(commit.id);
  }

  /** Whether the player's active creature came from this commitment. */
  private isActiveBirth(owner: string, commitId: string): boolean {
    const head = this.ledger.active(owner);
    return head !== null && this.ledger.chain(head.id)[0]?.record.body.commit === commitId;
  }

  /** Writes the genesis record once the commitment's beacon exists (idempotent) and sends it to the owner's open sessions. */
  private async deliverGenesis(commitId: string): Promise<void> {
    const commit = this.beacons.commitment(commitId);
    if (commit?.commitment.kind !== 'genesis') return;
    const beacon = await this.beacons.beaconFor(commitId);
    if (!beacon) return;
    const owner = commit.commitment.owner;
    const genome = genesisFor(randomnessOf(beacon), commitId);
    const request = genesisRequest(RULES_VERSION, commit.commitment, genome);
    const text = genomeToBase64url(genome);
    const accepted = this.ledger.accept({ request, genome: text });
    if (!accepted.ok) {
      // Nothing will ever follow: give the hatch back and free the player to ask again instead of waiting on a dead commitment.
      this.ledger.refundHatch(owner, commitId, Date.now());
      for (const [other, theirs] of this.activeSessions()) {
        if (theirs.playerId === owner) sendIfOpen(other, { t: 'refused', reason: accepted.reason });
      }
      return;
    }
    const ask = commit.commitment.data as GenesisAsk;
    const msg: HubMsg = {
      t: 'genesis',
      record: accepted.stored,
      ownerRequest: { nonce: ask.nonce, sig: ask.sig },
      commit: signedOf(commit),
      beacon,
      genome: text,
    };
    const head = this.ledger.head(accepted.stored.hash);
    for (const [other, theirs] of this.activeSessions()) {
      if (theirs.playerId !== owner) continue;
      // A new creature starts its clock when it reaches the player; a repeat delivery leaves it be.
      if (head && theirs.life?.creature !== head.id) {
        const life = this.bindHead(head, Date.now());
        other.serializeAttachment({ ...theirs, life } satisfies Session);
      }
      sendIfOpen(other, msg);
    }
  }

  /**
   * Writes a mating's two `birth` records once its round is published (idempotent) and sends each
   * owner their child. The children are recomputed from the beacon and the parents' genomes, never
   * taken from anywhere else.
   */
  private async deliverBirth(commitId: string): Promise<void> {
    const commit = this.beacons.commitment(commitId);
    if (commit?.commitment.kind !== 'mate') return;
    const beacon = await this.beacons.beaconFor(commitId);
    if (!beacon) return;
    const { a: askA, b: askB } = commit.commitment.data as unknown as { a: MateAsk; b: MateAsk };
    const owners: [string, string] = [commit.commitment.owner, askA.partner];
    const parentIds: [string, string] = [askA.creature, askB.creature];
    const heads = parentIds.map((id) => this.ledger.head(id));
    const [headA, headB] = heads;
    const genomes = heads.map((h) => (h ? genomeFromBase64url(h.genome) : null));
    const [genomeA, genomeB] = genomes;
    if (!headA || !headB || !genomeA || !genomeB) return;
    const mates = parentIds.map((id) => this.mateRecord(id, commitId));
    if (!mates[0] || !mates[1]) return;
    const { children, slots } = offspringPair(randomnessOf(beacon), commitId, genomeA, genomeB);
    const generation = Math.max(headA.generation, headB.generation) + 1;
    const mateHashes: [string, string] = [mates[0].hash, mates[1].hash];
    const result = this.ledger.birth({
      commit: commitId,
      children: children.map((child, i) => {
        const { biomass, energy } = hatchling(buildCreature(child).phys.maxBiomass);
        return {
          request: birthRequest(
            RULES_VERSION,
            commit.commitment,
            mateHashes,
            slots[i] as number,
            parentIds,
            child,
            generation,
            owners[i] as string,
          ),
          genome: genomeToBase64url(child),
          condition: {
            biomass: Math.floor(biomass * 100),
            energy: Math.floor(energy * 100),
            health: Math.floor(maxHealth(biomass) * 100),
          },
        };
      }) as [BirthChild, BirthChild],
    });
    if (!result.ok || !result.fresh) return;
    for (const [i, stored] of result.stored.entries()) {
      const child = this.ledger.head(stored.hash);
      const born = child ? this.bornFor(child) : null;
      if (!born) continue;
      for (const [other, theirs] of this.activeSessions()) {
        if (theirs.playerId === owners[i]) sendIfOpen(other, { t: 'born', ...born });
      }
    }
  }

  /** The `mate-commit` record the creature's chain holds for this commitment. */
  private mateRecord(creature: string, commitId: string): StoredRecord | undefined {
    return this.ledger
      .chain(creature)
      .find((r) => r.record.kind === 'mate-commit' && r.record.body.commit === commitId);
  }

  /** Everything a client needs to check a pending child: its record, commitment, beacon and both parents. */
  private bornFor(child: Head): Born | null {
    const record = this.ledger.chain(child.id)[0];
    const commitId = record?.record.kind === 'birth' ? String(record.record.body.commit) : '';
    const commit = this.beacons.commitment(commitId);
    const beacon = commit ? this.beacons.stored(commit.commitment.round) : null;
    const ids = record?.record.body.parents as [string, string] | undefined;
    if (!record || !commit || !beacon || !ids) return null;
    const parents = ids.map((id) => this.ledger.head(id)?.genome);
    const mates = ids.map((id) => this.mateRecord(id, commitId));
    const [p0, p1] = parents;
    const [m0, m1] = mates;
    return p0 && p1 && m0 && m1
      ? {
          record,
          commit: signedOf(commit),
          beacon,
          genome: child.genome,
          parents: [p0, p1],
          mates: [m0, m1],
        }
      : null;
  }

  /**
   * Credits a life report to the connection's creature (ADR 0019). It writes no record by itself:
   * the condition waits in the socket attachment until a checkpoint is due or the socket closes.
   */
  private progress(
    ws: WebSocket,
    session: ActiveSession,
    msg: ClientMsg & { t: 'progress' },
    now: number,
  ): void {
    // No creature bound (none yet, or it is gone): nothing to credit.
    if (!session.life || msg.n <= session.life.n) return;
    if (session.life.over) {
      sendIfOpen(ws, { t: 'refused', reason: 'dead' });
      return;
    }
    const { life, newFlags } = applyReport(session.life, msg, now);
    for (const kind of newFlags) {
      this.ledger.flagImplausible(kind, session.playerId, life.creature, now);
    }
    let next = checkpointDue(life) ? this.checkpoint(life, session.playerId) : life;
    sendIfOpen(ws, {
      t: 'ack',
      n: msg.n,
      activeMs: next.activeMs,
      lifespanMs: next.lifespanMs,
      matureAtMs: next.matureAtMs,
      cooldownUntilMs: next.cooldownUntilMs,
    });
    // Old age is decided here, on the authority's clock: the client counts down, but never has the last word.
    if (isOld(next)) next = this.finish(ws, next, session.playerId, 'old-age');
    ws.serializeAttachment({ ...session, life: next } satisfies Session);
  }

  /** A client's report that its creature died; the ticks since its last report are credited first. */
  private death(
    ws: WebSocket,
    session: ActiveSession,
    msg: ClientMsg & { t: 'death' },
    now: number,
  ): void {
    if (msg.cause === 'old-age') {
      sendIfOpen(ws, { t: 'refused', reason: 'cause' });
      return;
    }
    if (!session.life) {
      // Nothing of this player's to end: note it once and say nothing.
      this.ledger.flagStray(session.playerId, now);
      return;
    }
    if (session.life.over) {
      // A repeat gets the first answer, whatever cause it names.
      const record = this.ledger.deathRecord(session.life.creature);
      if (record) sendIfOpen(ws, { t: 'died', cause: causeOf(record.record.body.cause), record });
      return;
    }
    // The checkpoint keeps what the last report said; the stretch since then is credited to the death.
    const saved = unsaved(session.life)
      ? this.checkpoint(session.life, session.playerId)
      : session.life;
    // Ticks that spend the last of the lifespan are old age whatever the client says: the authority's clock decides.
    const credited = creditTicks(saved, msg.ticks, now);
    const cause = isOld(credited) ? 'old-age' : msg.cause;
    const life = this.finish(ws, credited, session.playerId, cause);
    ws.serializeAttachment({ ...session, life } satisfies Session);
  }

  /**
   * Ends the creature's life: a checkpoint of its last condition (when it has played since the last
   * record), then the `death` record, and `died` to the owner. A ledger that refuses leaves the
   * creature as it was, and the next report or request tries again.
   */
  private finish(ws: WebSocket, life: LifeState, owner: string, cause: DeathCause): LifeState {
    const saved = unsaved(life) ? this.checkpoint(life, owner) : life;
    const head = this.ledger.head(life.creature);
    if (head?.status !== 'active' || head.owner !== owner) return { ...saved, over: true };
    const accepted = this.ledger.append(head, 'death', {
      cause,
      activeMs: saved.activeMs,
      biomass: saved.biomass,
    });
    if (!accepted.ok) return saved;
    sendIfOpen(ws, { t: 'died', cause, record: accepted.stored });
    return { ...saved, savedMs: saved.activeMs, savedN: saved.n, over: true };
  }

  /** The other seated session of `playerId` in the sender's pond, or null. */
  private peerOf(ws: WebSocket, session: ActiveSession, playerId: string) {
    for (const [other, theirs] of this.activeSessions(ws)) {
      if (theirs.pondId === session.pondId && theirs.playerId === playerId) {
        return { ws: other, session: theirs };
      }
    }
    return null;
  }

  /** The peer, when it is playing a creature (the `life` is narrowed for the caller). */
  private partnerOf(ws: WebSocket, session: ActiveSession, playerId: string) {
    const peer = this.peerOf(ws, session, playerId);
    return peer?.session.life
      ? { ws: peer.ws, session: peer.session, life: peer.session.life }
      : null;
  }

  /** Why these two sessions' creatures cannot mate now (the first player's view first), or null. */
  private mateRefusal(
    a: { playerId: string; life?: LifeState | undefined },
    b: { playerId: string; life?: LifeState | undefined },
  ): string | null {
    if (!a.life || !b.life) return 'no-creature';
    const view = (s: { playerId: string }, life: LifeState) =>
      viewOf(life, s.playerId, this.ledger.head(life.creature), {
        pending: this.ledger.pending(s.playerId) !== null,
        inFlight: this.ledger.hasOpenMating(s.playerId),
      });
    return refusalFor(view(a, a.life), view(b, b.life));
  }

  /** What the mate card shows about a partner: kinship, generation and size tier, and the longer cooldown left. */
  private cardOf(a: LifeState, b: LifeState) {
    const pedigree = this.ledger.pedigree([a.creature, b.creature]);
    return {
      kinship: kinship(pedigree, a.creature, b.creature),
      generation: this.ledger.head(b.creature)?.generation ?? 0,
      tier: sizeTier(b.biomass / 100),
      cooldownLeftMs: Math.max(0, a.cooldownUntilMs - a.activeMs, b.cooldownUntilMs - b.activeMs),
    };
  }

  private mateCheck(ws: WebSocket, session: ActiveSession, partnerId: string): void {
    const other = session.life ? this.partnerOf(ws, session, partnerId) : null;
    if (!session.life || !other) {
      sendIfOpen(ws, {
        t: 'mate-info',
        partner: partnerId,
        reason: 'not-here',
        kinship: 0,
        generation: 0,
        tier: 0,
        cooldownLeftMs: 0,
      });
      return;
    }
    sendIfOpen(ws, {
      t: 'mate-info',
      partner: partnerId,
      reason: this.mateRefusal(session, other.session),
      ...this.cardOf(session.life, other.life),
    });
  }

  /** The courting player offers a mating: kept in the session's attachment until the partner answers. */
  private court(ws: WebSocket, session: ActiveSession, ask: MateAsk, now: number): boolean {
    const refuse = (reason: string): false => {
      sendIfOpen(ws, { t: 'refused', reason });
      return false;
    };
    if (!session.life) return refuse('no-creature');
    if (ask.partner === session.playerId) return refuse('self');
    if (ask.creature !== session.life.creature || !signedBy(session.playerId, ask)) {
      return refuse('bad-signature');
    }
    const other = this.partnerOf(ws, session, ask.partner);
    if (!other) return refuse('not-here');
    if (ask.partnerCreature !== other.life.creature) return refuse('pair-mismatch');
    if (this.ledger.nonceUsed(ask.nonce)) return refuse('used');
    const reason = this.mateRefusal(session, other.session);
    if (reason) return refuse(reason);
    // A second court replaces the first: the earlier invitation is void.
    ws.serializeAttachment({ ...session, court: { ask, sentAt: now } } satisfies Session);
    const card = this.cardOf(session.life, other.life);
    sendIfOpen(other.ws, {
      t: 'invite',
      from: session.playerId,
      ask,
      kinship: card.kinship,
      generation: this.ledger.head(session.life.creature)?.generation ?? 0,
    });
    return true;
  }

  private decline(ws: WebSocket, session: ActiveSession, courter: string): void {
    const peer = this.peerOf(ws, session, courter);
    const court = peer?.session.court;
    if (peer && court && 'ask' in court && court.ask.partner === session.playerId) {
      peer.ws.serializeAttachment({ ...peer.session, court: undefined } satisfies Session);
      sendIfOpen(peer.ws, { t: 'declined', by: session.playerId });
    }
  }

  /** Runs an acceptance after any earlier one has finished. */
  private queueAccept(ws: WebSocket, ask: MateAsk): void {
    const run = this.matingQueue
      .then(async () => {
        await this.accept(ws, ask);
      })
      .catch(() => sendIfOpen(ws, { t: 'error', code: 'mate-failed' }));
    this.matingQueue = run;
  }

  /**
   * ADR 0021: the accepting player's ask turns the courtship into one commitment to a future round
   * and two `mate-commit` records. Nothing is written until every check passes, and nothing reverses it.
   */
  private async accept(ws: WebSocket, ask: MateAsk): Promise<boolean> {
    const refuse = (reason: string): false => {
      sendIfOpen(ws, { t: 'refused', reason });
      return false;
    };
    const me = sessionOf(ws);
    if (me?.phase !== 'active' || !me.life) return refuse('no-creature');
    if (ask.partner === me.playerId) return refuse('self');
    if (ask.creature !== me.life.creature || !signedBy(me.playerId, ask)) {
      return refuse('bad-signature');
    }
    const found = this.peerOf(ws, me, ask.partner);
    if (!found) return refuse('no-court');
    const { court } = found.session;
    if (court && 'done' in court) {
      // The same acceptance again: the same commitment, nothing written.
      if (court.nonce !== ask.nonce) return refuse('no-court');
      this.resend(ws, me.life.creature, court.done);
      return true;
    }
    if (!court || court.ask.partner !== me.playerId) return refuse('no-court');
    if (!askLive(court.sentAt, Date.now())) return refuse('expired');
    if (this.ledger.nonceUsed(ask.nonce)) return refuse('used');
    const failures = checkMatePair(court.ask, found.session.playerId, ask, me.playerId);
    if (failures.length > 0) return refuse(failures[0] as string);
    const reason = this.mateRefusal(me, found.session);
    if (reason) return refuse(reason);

    const scale = fixtureScale(this.env, this.env.MATING_SCALE);
    const prior = this.ledger.pairMatings(
      found.session.playerId,
      me.playerId,
      Date.now() - repeatWindowMs(scale),
    );
    const data = { a: court.ask, b: ask } as unknown as Canonical;
    const commit = await this.beacons.commit('mate', found.session.playerId, data);

    // The network call let others in: read both sessions and their creatures again.
    const [mine, theirs] = [sessionOf(ws), sessionOf(found.ws)];
    if (mine?.phase !== 'active' || theirs?.phase !== 'active' || !mine.life || !theirs.life) {
      return refuse('not-here');
    }
    const again = theirs.court;
    // The same offer, and the same two creatures: a re-court, a decline or a death during the wait voids it.
    if (!again || 'done' in again || again.sentAt !== court.sentAt) return refuse('no-court');
    if (mine.life.creature !== ask.creature || theirs.life.creature !== court.ask.creature) {
      return refuse('pair-mismatch');
    }
    const stale = this.mateRefusal(mine, theirs);
    if (stale) return refuse(stale);
    const [headA, headB] = [
      this.ledger.head(theirs.life.creature),
      this.ledger.head(mine.life.creature),
    ];
    const [genomeA, genomeB] = [headA, headB].map((h) =>
      h ? genomeFromBase64url(h.genome) : null,
    );
    if (!headA || !headB || !genomeA || !genomeB) return refuse('unknown-creature');
    const cooldown = cooldownFor(prior, scale);
    const requests = mateRequests(
      { id: commit.id, round: commit.commitment.round },
      { head: headA, life: theirs.life, genome: genomeA },
      { head: headB, life: mine.life, genome: genomeB },
      cooldown,
    );
    const result = this.ledger.mate({
      commit: commit.id,
      round: commit.commitment.round,
      requests,
    });
    if (!result.ok) {
      sendIfOpen(found.ws, { t: 'refused', reason: result.reason });
      return refuse(result.reason);
    }
    const signed = signedOf(commit);
    const settle = (socket: WebSocket, s: ActiveSession, i: 0 | 1, court?: Court) => {
      const body = (requests[i] as { body: Record<string, number> }).body;
      const life = s.life as LifeState;
      socket.serializeAttachment({
        ...s,
        court,
        life: {
          ...life,
          biomass: body.biomass as number,
          energy: body.energy as number,
          health: body.health as number,
          cooldownUntilMs: body.cooldownUntilMs as number,
          // The record covers everything reported so far.
          savedMs: life.activeMs,
          savedN: life.n,
        },
      } satisfies Session);
      sendIfOpen(socket, { t: 'mating', commit: signed, record: result.stored[i] });
    };
    if (result.fresh) {
      settle(found.ws, theirs, 0, { done: commit.id, nonce: ask.nonce });
      settle(ws, mine, 1);
    } else {
      this.resend(ws, mine.life.creature, commit.id);
    }
    return true;
  }

  /** Sends a player the commitment and their `mate-commit` record of an earlier mating again. */
  private resend(ws: WebSocket, creature: string, commitId: string): void {
    const commit = this.beacons.commitment(commitId);
    const record = this.ledger
      .chain(creature)
      .find((r) => r.record.kind === 'mate-commit' && r.record.body.commit === commitId);
    if (commit && record) sendIfOpen(ws, { t: 'mating', commit: signedOf(commit), record });
  }

  /** The player's finished lives, newest first. */
  private history(ws: WebSocket, playerId: string): void {
    // Field by field: this is a network message, so a column added to the row later isn't sent by accident.
    const lives = this.ledger.history(playerId, HISTORY_MAX).flatMap((row) => {
      const genome = genomeFromBase64url(row.genome);
      if (!genome) return [];
      const { creature, activeMs, bornT, diedT } = row;
      return [
        {
          creature,
          species: speciesName(genome),
          cause: causeOf(row.cause),
          activeMs,
          bornT,
          diedT,
        },
      ];
    });
    sendIfOpen(ws, { t: 'history', lives });
  }

  /** The head as the client resumes it. */
  private lifeOf(head: Head): LifeInfo {
    const genome = genomeFromBase64url(head.genome);
    return {
      creature: head.id,
      seq: head.seq,
      genome: head.genome,
      biomass: head.biomass,
      energy: head.energy,
      health: head.health,
      activeMs: head.activeMs,
      lifespanMs: genome ? this.lifespanOf(genome) : 0,
      matureAtMs: genome ? this.matureAtMsOf(genome) : 0,
      cooldownUntilMs: head.cooldownUntilMs,
    };
  }

  /** The active time from which a creature of this genome may mate, shortened by `MATING_SCALE` in fixture mode only. */
  private matureAtMsOf(genome: Genome): number {
    return matureAtMsOf(
      lifespanMs(express(genome).physiology.lifespan),
      fixtureScale(this.env, this.env.MATING_SCALE),
    );
  }

  /** The lifespan this object gives a genome: its trait, shortened by `LIFESPAN_SCALE` in fixture mode only. */
  private lifespanOf(genome: Genome): number {
    const shortened = fixtureScale(this.env, this.env.LIFESPAN_SCALE);
    return Math.round(lifespanMs(express(genome).physiology.lifespan) * shortened);
  }

  /** The player's active creature as a fresh connection state, or undefined without one. */
  private bind(playerId: string, now: number): LifeState | undefined {
    const head = this.ledger.active(playerId);
    return head ? this.bindHead(head, now) : undefined;
  }

  /** A connection's state for `head`; none when its genome doesn't decode, so nothing is credited to it. */
  private bindHead(head: Head, now: number): LifeState | undefined {
    const genome = genomeFromBase64url(head.genome);
    return genome
      ? bindLife(head, genome, now, this.lifespanOf(genome), this.matureAtMsOf(genome))
      : undefined;
  }

  /** Writes the creature's condition as a checkpoint record; the state comes back marked saved only if the ledger took it. */
  private checkpoint(life: LifeState, owner: string): LifeState {
    const head = this.ledger.head(life.creature);
    if (head?.status !== 'active' || head.owner !== owner) return life;
    const accepted = this.ledger.append(head, 'checkpoint', {
      biomass: life.biomass,
      energy: life.energy,
      health: life.health,
      activeMs: life.activeMs,
    });
    return accepted.ok ? { ...life, savedMs: life.activeMs, savedN: life.n } : life;
  }

  /** When the earliest socket that hasn't said hello times out, or null. Sockets already closing don't count. */
  private helloDue(): number | null {
    let next: number | null = null;
    for (const ws of this.ctx.getWebSockets()) {
      const session = sessionOf(ws);
      if (session?.phase !== 'challenged' || ws.readyState > WebSocket.READY_STATE_OPEN) continue;
      const due = session.openedAt + HELLO_TIMEOUT_MS;
      next = Math.min(next ?? due, due);
    }
    return next;
  }

  /** When the admission queue is looked at next, or null while it is empty. */
  private queueDue(): number | null {
    if (this.queued().length === 0) {
      this.queueTickAt = null;
      return null;
    }
    this.queueTickAt ??= Date.now() + QUEUE_TICK_MS;
    return this.queueTickAt;
  }

  /** The object has one alarm: it is set for the earliest of the hello timeout, the next beacon and the queue tick, and cleared when none is needed. */
  private rearm(): Promise<void> {
    // One at a time, each reading fresh deadlines, so a slow caller can't overwrite a sooner alarm.
    const run = this.rearming.then(() => this.setAlarmForNext());
    this.rearming = run.catch(() => {});
    return run;
  }

  private async setAlarmForNext(): Promise<void> {
    const hello = this.helloDue();
    const beacon = this.beacons.nextDue();
    const queue = this.queueDue();
    const next = earliest(hello, beacon, queue);
    const current = await this.ctx.storage.getAlarm();
    if (next === null) {
      if (current !== null) await this.ctx.storage.deleteAlarm();
    } else if (current === null || Math.abs(current - next) > 50) {
      await this.ctx.storage.setAlarm(next);
    }
  }

  private async hello(
    ws: WebSocket,
    session: Session & { phase: 'challenged' },
    msg: ClientMsg & { t: 'hello' },
  ): Promise<void> {
    if (isProfane(msg.name)) {
      ws.close(CLOSE_BAD_HELLO, 'name not allowed');
      return;
    }
    const message = helloMessage(session.nonce, msg.name);
    if (!message) {
      ws.close(CLOSE_BAD_HELLO, 'bad nonce');
      return;
    }
    const sig = fromBase64Url(msg.sig);
    if (!sig || !verify(msg.playerId, HELLO_DOMAIN, message, sig)) {
      ws.close(CLOSE_BAD_HELLO, 'bad hello');
      return;
    }
    const { ice, turn } = await this.turn.ice(this.env);
    // The socket may have closed, said hello again or sent messages while the lookup ran: go on
    // from its current state. From here to the welcome there is no await, so nobody can relay a
    // signal to the joiner or learn of it first.
    const current = ws.readyState === WebSocket.OPEN ? sessionOf(ws) : null;
    if (current?.phase !== 'challenged') return;
    // The new tab takes over the old one's place: its pond seat, or its spot in line.
    let held: LiveSession | undefined;
    for (const [other, theirs] of this.liveSessions(ws)) {
      if (theirs.playerId !== msg.playerId) continue;
      if (theirs.phase === 'active' || held?.phase !== 'active') held = theirs;
      // Quietly: the new socket takes over the place, so nobody moves up and no seat is offered.
      this.drop(other, CLOSE_REPLACED, 'replaced by a newer session', true);
    }
    const who = { playerId: msg.playerId, name: msg.name };
    // Admission never drops or re-queues a player who already has a seat.
    if (held?.phase !== 'active' && (this.queued().length > 0 || !this.canAdmit(Date.now()))) {
      const ticket = held?.phase === 'queued' ? held.ticket : this.nextTicket++;
      ws.serializeAttachment({
        ...current,
        phase: 'queued',
        ...who,
        ticket,
        place: 0,
      } satisfies Session);
    } else {
      this.enter(ws, current, who, { ice, turn });
    }
    this.announceQueue();
    await this.rearm();
  }

  /** Whether one more session fits: under the session cap and short of 90% of the day's request budget. */
  private canAdmit(now: number): boolean {
    const sessions = [...this.activeSessions()].length;
    return (
      sessions < limit(this.env.MAX_SESSIONS, DEFAULT_MAX_SESSIONS) &&
      this.usage.requests(now) <
        BUDGET_SHARE * limit(this.env.DAILY_REQUEST_BUDGET, DEFAULT_DAILY_REQUEST_BUDGET)
    );
  }

  /** The waiting sessions, next first. */
  private queued(): [WebSocket, Session & { phase: 'queued' }][] {
    const out: [WebSocket, Session & { phase: 'queued' }][] = [];
    for (const [ws, session] of this.liveSessions()) {
      if (session.phase === 'queued') out.push([ws, session]);
    }
    return out.sort((a, b) => a[1].ticket - b[1].ticket);
  }

  /** Tells each waiting session its place when that changed (the first time included). */
  private announceQueue(): void {
    this.queued().forEach(([ws, session], i) => {
      const place = i + 1;
      if (session.place === place) return;
      ws.serializeAttachment({ ...session, place } satisfies Session);
      sendIfOpen(ws, { t: 'queued', position: place, etaS: place * ETA_S_PER_PLACE });
    });
  }

  /** Seats waiting sessions, in arrival order, for as long as there is room. */
  private promote(): Promise<void> {
    const run = this.promoting.then(() => this.promoteWaiting());
    this.promoting = run.catch(() => {});
    return run;
  }

  private async promoteWaiting(): Promise<void> {
    try {
      for (;;) {
        const first = this.queued()[0];
        if (!first || !this.canAdmit(Date.now())) return;
        const { ice, turn } = await this.turn.ice(this.env);
        // The line may have changed while the lookup ran. No await from here to the welcome.
        const next = this.queued()[0];
        if (next?.[0] !== first[0] || !this.canAdmit(Date.now())) continue;
        const [ws, session] = next;
        this.enter(ws, session, { playerId: session.playerId, name: session.name }, { ice, turn });
      }
    } finally {
      this.announceQueue();
      await this.rearm();
    }
  }

  /** Seats a signed-in session in a pond and welcomes it. */
  private enter(
    ws: WebSocket,
    from: Pick<Session, 'openedAt' | 'windowStart' | 'count' | 'signals'>,
    who: { playerId: string; name: string },
    link: { ice: IceServer[]; turn: boolean },
  ): void {
    const { pond, spawnHint, members, slot } = this.place();
    const { openedAt, windowStart, count, signals } = from;
    ws.serializeAttachment({
      phase: 'active',
      openedAt,
      windowStart,
      count,
      signals,
      ...who,
      pondId: pond.id,
      slot,
      life: this.bind(who.playerId, Date.now()),
    } satisfies Session);
    this.broadcast(pond.id, ws, { t: 'member', op: 'join', member: who });
    sendIfOpen(ws, {
      t: 'welcome',
      pond,
      you: { spawnHint },
      members,
      ice: link.ice,
      turn: link.turn,
      now: Date.now(),
    });
    this.sendLife(ws, who.playerId);
  }

  /** The player's active creature (null for a new player) and when the next recorded hatch is allowed. */
  private sendLife(ws: WebSocket, playerId: string): void {
    const head = this.ledger.active(playerId);
    const { left, genesisIn } = this.ledger.hatches(playerId, Date.now());
    const child = this.ledger.pending(playerId);
    const pending = child ? this.bornFor(child) : null;
    sendIfOpen(ws, {
      t: 'life',
      life: head ? this.lifeOf(head) : null,
      genesisIn,
      ...(pending ? { pending } : {}),
    });
    // A mating whose children were never written (an eviction between its round and the write) is finished now.
    for (const id of this.ledger.openMatingCommits(playerId)) {
      if (this.beacons.status(id) === 'ready') this.deliverBirth(id).catch(() => {});
    }
    // A genesis still waiting on its round is announced again, and its creature follows when the round comes.
    const waiting = this.ledger.pendingCommit(playerId);
    const commit = waiting ? this.beacons.commitment(waiting) : null;
    if (commit) {
      sendIfOpen(ws, {
        t: 'commit',
        commit: signedOf(commit),
        hatchesLeft: left,
      });
      this.deliverGenesis(commit.id).catch(() => {});
    }
  }

  /** Picks the fullest pond with a free place (creating one if none), and the joiner's spawn hint. */
  private place(): { pond: PondInfo; spawnHint: Vec2; members: Member[]; slot: number } {
    const sql = this.ctx.storage.sql;
    const counts = new Map<string, number>();
    for (const [, theirs] of this.activeSessions()) {
      counts.set(theirs.pondId, (counts.get(theirs.pondId) ?? 0) + 1);
    }
    let best: PondRow | null = null;
    for (const row of sql.exec<PondRow>('SELECT * FROM ponds ORDER BY created, id')) {
      const n = counts.get(row.id) ?? 0;
      if (n < POND_CAPACITY && (!best || n > (counts.get(best.id) ?? 0))) best = row;
    }
    if (!best) {
      const centre = RULES.world.size / 2;
      const now = Date.now();
      best = {
        id: randomToken(6),
        seed: randomToken(12),
        epoch: now,
        cx: centre,
        cy: centre,
        created: now,
      };
      sql.exec(
        'INSERT INTO ponds (id, seed, epoch, cx, cy, created) VALUES (?, ?, ?, ?, ?, ?)',
        best.id,
        best.seed,
        best.epoch,
        best.cx,
        best.cy,
        best.created,
      );
    }
    const members: Member[] = [];
    const taken = new Set<number>();
    for (const [, theirs] of this.activeSessions()) {
      if (theirs.pondId !== best.id) continue;
      members.push({ playerId: theirs.playerId, name: theirs.name });
      // A session hibernated before slots existed has none.
      if (theirs.slot !== undefined) taken.add(theirs.slot);
    }
    let slot = 0;
    while (taken.has(slot)) slot++;
    const angle = slot * SPAWN_GOLDEN_ANGLE;
    const radius = slot === 0 ? 0 : RING_BASE + RING_STEP * slot;
    return {
      pond: {
        id: best.id,
        seed: best.seed,
        epoch: best.epoch,
        centre: { x: best.cx, y: best.cy },
        size: RULES.world.size,
      },
      spawnHint: { x: best.cx + radius * Math.cos(angle), y: best.cy + radius * Math.sin(angle) },
      members,
      slot,
    };
  }

  /** Every logged-in socket (except `except`) with its session. A joiner is still `challenged` until placed. */
  private *activeSessions(except?: WebSocket): Generator<[WebSocket, ActiveSession]> {
    for (const other of this.ctx.getWebSockets()) {
      if (other === except) continue;
      const theirs = sessionOf(other);
      if (theirs?.phase === 'active') yield [other, theirs];
    }
  }

  /** Every signed-in socket (except `except`), seated or waiting. */
  private *liveSessions(except?: WebSocket): Generator<[WebSocket, LiveSession]> {
    for (const other of this.ctx.getWebSockets()) {
      if (other === except) continue;
      const theirs = sessionOf(other);
      if (theirs?.phase === 'active' || theirs?.phase === 'queued') yield [other, theirs];
    }
  }

  private broadcast(pondId: string, except: WebSocket, msg: HubMsg): void {
    for (const [other, theirs] of this.activeSessions(except)) {
      if (theirs.pondId === pondId) send(other, msg);
    }
  }

  /** Forwards a signal to a member of the sender's pond, stamped with the verified sender. */
  private relay(ws: WebSocket, session: ActiveSession, msg: ClientMsg & { t: 'signal' }): void {
    if (byteLength(msg.sdp) > SDP_MAX_BYTES) {
      send(ws, { t: 'error', code: 'too-big' });
      return;
    }
    for (const [other, theirs] of this.activeSessions(ws)) {
      if (theirs.pondId === session.pondId && theirs.playerId === msg.to) {
        send(other, { t: 'signal', from: session.playerId, kind: msg.kind, sdp: msg.sdp });
        return;
      }
    }
    send(ws, { t: 'error', code: 'no-peer' });
  }

  /** A connection that reported anything since the last record leaves its condition behind as a checkpoint. */
  private saveOnClose({ life, playerId }: ActiveSession): void {
    if (life && unsaved(life)) this.checkpoint(life, playerId);
  }

  /** Closes a socket; an active one first leaves its pond so the others see it go exactly once. */
  private drop(ws: WebSocket, code: number, reason?: string, replaced = false): void {
    const session = sessionOf(ws);
    if (session?.phase === 'queued') {
      ws.serializeAttachment({ ...session, phase: 'retired' } satisfies Session);
      if (!replaced) {
        this.announceQueue();
        this.rearm().catch(() => {});
      }
    }
    if (session?.phase === 'active') {
      ws.serializeAttachment({ ...session, phase: 'retired' } satisfies Session);
      try {
        this.saveOnClose(session);
      } catch {
        // A failed save must not keep the others from seeing this player leave; the next login resumes from the last record.
      }
      this.broadcast(session.pondId, ws, {
        t: 'member',
        op: 'leave',
        member: { playerId: session.playerId, name: session.name },
      });
      // The seat is free: the first in line takes it.
      if (!replaced && this.queued().length > 0) this.promote().catch(() => {});
    }
    try {
      ws.close(code, reason);
    } catch {
      // already closed
    }
  }
}

type ActiveSession = Session & { phase: 'active' };
type LiveSession = Session & { phase: 'active' | 'queued' };

/** The earliest of the times that are set. */
const earliest = (...times: (number | null)[]): number | null =>
  times.reduce<number | null>((a, b) => (a === null ? b : b === null ? a : Math.min(a, b)), null);

/** A positive whole number from a `vars` entry, else the default. */
function limit(value: string | undefined, fallback: number): number {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

/** A commitment as the wire carries it: without the id and status the client recomputes or doesn't need. */
const signedOf = ({ commitment, authSig, keyId }: SignedCommitment): SignedCommit => ({
  commitment,
  authSig,
  keyId,
});

/** A stored death cause; anything unrecognised reads as `killed`. */
const causeOf = (value: unknown): DeathCause => (isCause(value) ? value : 'killed');

/** `bytes` of randomness as base64url. */
function randomToken(bytes: number): string {
  return toBase64Url(crypto.getRandomValues(new Uint8Array(bytes)));
}

function sessionOf(ws: WebSocket): Session | null {
  return ws.deserializeAttachment() as Session | null;
}

function send(ws: WebSocket, msg: HubMsg): void {
  ws.send(JSON.stringify(msg));
}

/** Sends unless the socket closed in the meantime. */
function sendIfOpen(ws: WebSocket, msg: HubMsg): void {
  try {
    send(ws, msg);
  } catch {
    // closed while waiting
  }
}
