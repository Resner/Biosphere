// The online session: the hub, the WebRTC mesh and the traffic between them (M11 T13, ADR 0062).
// It owns no game state; `app-online.ts` supplies the handlers and decides what a snapshot or a
// claim means for the world. Links are the area of interest's: `online-links.ts` plans them from
// the known set (`neighbours.ts`). There is no roster: names come from tickets and the directory.
// Crowd instances (M12 T6, ADR 0064): `crowd-view.ts` keeps the page's instance and its peers';
// links, snapshots and game events follow the water, and a peer that leaves it is told to fade.

import type { Identity } from '../ledger/identity';
import type { PubKey } from '../ledger/record';
import { type AoiSelf, aoiRadius, queryRadius } from '../net/aoi';
import type { PondClock } from '../net/clock';
import {
  type DutyMsg,
  type FightMsg,
  type HubClient,
  type HubStatus,
  isFinalStatus,
  type LifeMsg,
  type QueuePlace,
  HubClient as RealHub,
  type SignalMsg,
  type Welcome,
  type WorldMsg,
} from '../net/hub-client';
import { OPEN_WATER } from '../net/instance';
import { PeerMesh } from '../net/peer-mesh';
import {
  type ClientMsg,
  type IceServer,
  type Member,
  type PeerEvent,
  type Pos,
  type RelayReport,
  type SignalKind,
  type SignedSnap,
  type Snapshot,
  type WireClass,
  wireCoord,
  wireRadius,
} from '../net/protocol';
import { RELAY_READ_MS, RelayStats } from '../net/relay-stats';
import { type RelayEvent, SignalRoute, type SignalStats } from '../net/signal-route';
import {
  FULL_RATE,
  RateAsker,
  SendRates,
  type SnapshotRate,
  wantedRate,
} from '../net/snapshot-rates';
import { crowdList, WhereReporter } from '../net/where';
import type { SwarmPoint } from '../render/swarms';
import { viewHalfHeight } from '../sim/size';
import { CrowdView, type InstanceInfo } from './crowd-view';
import { type MapSighting, sightings } from './map-view';
import { type KnownCounts, Neighbours, NO_SWARM } from './neighbours';
import { type DutyLink, type LinkInfo, Links, YOUNG_MS } from './online-links';

export type { DutyLink, LinkInfo } from './online-links';

export type OnlineHub = Pick<
  HubClient,
  | 'status'
  | 'queue'
  | 'clock'
  | 'ticket'
  | 'connect'
  | 'close'
  | 'send'
  | 'onStatus'
  | 'onSignal'
  | 'onWelcome'
  | 'onWorld'
  | 'onLife'
  | 'onFight'
  | 'onDuty'
>;

export type OnlineMesh = Pick<
  PeerMesh,
  | 'connect'
  | 'disconnect'
  | 'setIce'
  | 'close'
  | 'peers'
  | 'isOpen'
  | 'isUp'
  | 'ticketOf'
  | 'instanceOf'
  | 'stats'
  | 'sendState'
  | 'sendEvent'
  | 'handleSignal'
  | 'onPeerJoined'
  | 'onPeerLeft'
  | 'onState'
  | 'onEvent'
  | 'onProxy'
> &
  Partial<Pick<PeerMesh, 'linkStats'>>;

export interface OnlineHandlers {
  /** Every welcome, including after a reconnect. */
  welcome(w: Welcome): void;
  /** A link's hello passed: the peer is linked, under the name its ticket gives. */
  peerOpen(id: string, name: string): void;
  /** A linked peer's link closed. */
  peerLeft(id: string): void;
  /** A peer's snapshot, with its signed form (unverified) when it came as a 93-byte frame. */
  state(id: string, snapshot: Snapshot, signed: SignedSnap | null): void;
  event(id: string, event: PeerEvent): void;
  /** A linked peer's proxy of `player`'s away fighter (M8 T11), unchecked. */
  proxy(id: string, player: string, snapshot: Snapshot): void;
  /** The hub's word about this player's creature (resume, genesis, acks, death). */
  life(msg: LifeMsg): void;
  /** The hub's word about fights; a `lock-ask` is answered before this returns (M7 T7). */
  fight(msg: FightMsg): void;
  /** A witness duty's offer or end, or a fighter's duty link (M10); the session opens and closes the links itself. */
  duty?(msg: DutyMsg): void;
  /** A linked creature stopped (`shown` false: it fades out) or started again being drawn (M12 T6). */
  water?(id: string, shown: boolean): void;
  /** The page's own instance left the open water, at most once a minute: the busy toast (M12 T6). */
  busy?(): void;
}

/** The own creature as the links and the directory see it; `inWater` false on the death screen or in a hidden tab. */
export interface CreatureNow extends AoiSelf {
  inWater: boolean;
}

/** A link in `state().net.links`: `hz` the rate this page sends it, `wanted` the rate it asked (M11 T15). */
export interface NetLink extends LinkInfo {
  hz: SnapshotRate;
  wanted: SnapshotRate;
}

/** What `state().net` shows of the links (M11 T13). */
export interface NetLinks {
  links: NetLink[];
  known: KnownCounts;
  crowded: boolean;
  where: { sent: number; leaf: { x: number; y: number; size: number } | null };
  signals: Pick<SignalStats, 'hub' | 'relayed' | 'forwarded' | 'forged'>;
  helloFailed: number;
  /** The page's crowd instance (M12 T6). */
  instance: InstanceInfo;
}

export interface OnlineOptions {
  selfId: string;
  hub: OnlineHub;
  createMesh(
    ice: IceServer[],
    signal: (to: string, kind: 'offer' | 'answer', sdp: string) => void,
  ): OnlineMesh;
  handlers: OnlineHandlers;
  /** The own creature in this session's world, or null with none (the title). */
  creature?: () => CreatureNow | null;
  /** Signs a relayed signal (`signSignal`); without it relays go out unsigned and fail their check. */
  sign?: (
    to: string,
    kind: SignalKind,
    cls: WireClass,
    at: number,
    pos: Pos,
    sdp: string,
  ) => string;
  /** Checks a relay's signature (`signalSigned`). */
  verify?: (m: RelayEvent) => boolean;
  /** Whether the page can show and check tickets yet (the authority's keys came); default true. */
  canLink?: () => boolean;
  /** The page clock, ms; default `performance.now`. */
  now?: () => number;
  /** How often the links tick (ms); without it nothing ticks them (tests call `tick`). */
  tickMs?: number;
}

const READY_POLL_MS = 50;
const TICK_MS = 100;
const NO_CANDIDATES: ReadonlySet<string> = new Set();
/** What a linked peer that doesn't share water still brings: its duty (M12 T6). */
const DUTY_EVENTS: ReadonlySet<PeerEvent['t']> = new Set(['finput', 'probe', 'wframe']);

export class OnlineSession {
  /** The page's crowd instance and each known creature's (M12 T6). */
  readonly crowd = new CrowdView();
  readonly neighbours: Neighbours;
  readonly links: Links;
  private readonly route: SignalRoute;
  /** The rate each link asked of this page, and the rate this page asked of each (M11 T15). */
  private readonly sendRates = new SendRates();
  private readonly asker = new RateAsker();
  private reporter = new WhereReporter();
  /** Whether the page was alone at the last report check (`alone()`). */
  private wasAlone = false;
  private wheres = 0;
  private mesh: OnlineMesh | null = null;
  private last: Welcome | null = null;
  /** When the creature last went into the water, or null while it is out. */
  private inWaterSince: number | null = null;
  /** The links' relay reads since the last report (M13 T4): when the last began, whether it held links, the one running. */
  private readonly relayStats = new RelayStats();
  private relayReadAt = Number.NEGATIVE_INFINITY;
  private relayHeld = false;
  private relayReading: Promise<void> | null = null;
  private readonly timer: ReturnType<typeof setInterval> | null;

  constructor(private readonly opts: OnlineOptions) {
    const { hub, selfId } = opts;
    const now = () => this.now();
    this.neighbours = new Neighbours(selfId, (id) => this.crowd.sighting(id));
    this.route = new SignalRoute({
      selfId,
      now: () => hub.clock.hubNow(now()),
      pos: () => this.pos(),
      sign: opts.sign ?? (() => ''),
      verify: opts.verify ?? (() => false),
      linked: (id) => this.mesh?.isOpen(id) === true,
      heard: (id) => this.neighbours.gossip.heard(id, now()),
      placeOf: (id) => this.neighbours.fixOf(id),
      sendPeer: (via, m) => this.mesh?.sendEvent(via, m) === true,
      sendHub: (to, kind, sdp, cls) => hub.send({ t: 'signal', to, kind, sdp, cls }),
      deliver: (from, kind, sdp, pos, cls) => this.links.signal(from, kind, sdp, pos, cls),
    });
    const noMesh = {
      connect: () => {},
      disconnect: () => {},
      peers: () => [],
      isOpen: () => false,
      isUp: () => false,
      handleSignal: async () => {},
    };
    this.links = new Links({
      selfId,
      mesh: {
        connect: (id) => (this.mesh ?? noMesh).connect(id),
        disconnect: (id) => (this.mesh ?? noMesh).disconnect(id),
        peers: () => (this.mesh ?? noMesh).peers(),
        isOpen: (id) => (this.mesh ?? noMesh).isOpen(id),
        isUp: (id) => (this.mesh ?? noMesh).isUp(id),
        handleSignal: (from, kind, sdp) => (this.mesh ?? noMesh).handleSignal(from, kind, sdp),
      },
      neighbours: this.neighbours,
      send: (to, kind, sdp, cls, viaHub) => this.route.send(to, kind, sdp, cls, viaHub),
      now,
      self: () => {
        const c = opts.creature?.();
        return c ? { ...c, n: this.crowd.own } : null;
      },
      shares: (id) => this.crowd.shares(id),
      young: () => this.inWaterSince !== null && now() - this.inWaterSince < YOUNG_MS,
      ready: () =>
        this.mesh !== null &&
        this.last !== null &&
        (opts.canLink?.() ?? true) &&
        hub.ticket !== null,
    });
    hub.onWelcome((w) => this.welcomed(w));
    hub.onSignal((m) => this.signalled(m));
    hub.onWorld((m) => this.world(m));
    hub.onLife((m) => opts.handlers.life(m));
    hub.onFight((m) => {
      opts.handlers.fight(m);
      // Only a fight's fighters hear its `enc-start` and `enc-join` (a joiner its catch-up first).
      if (m.t === 'enc-start')
        this.links.fight(
          m.enc,
          m.fighters.map((f) => f.player),
        );
      else if (m.t === 'enc-join') this.links.joined(m.enc, m.fighter.player);
      else if (m.t === 'enc-end') this.links.endFight(m.enc);
    });
    hub.onDuty((m) => {
      if (m.t === 'duty-peer') this.links.duty(m.enc, m.peer, m.on);
      else if (m.t === 'duty-end' && m.event.startsWith('enc:'))
        this.links.endDuty(m.event.slice(4));
      opts.handlers.duty?.(m);
    });
    this.timer = opts.tickMs === undefined ? null : setInterval(() => this.tick(), opts.tickMs);
    // Rejections (replaced, closed) are reported through the status, not here.
    hub.connect().catch(() => {});
  }

  private now(): number {
    return (this.opts.now ?? (() => performance.now()))();
  }

  get status(): HubStatus {
    return this.opts.hub.status;
  }

  /** The place in the hub's admission line while it keeps this session waiting, else null. */
  get queue(): QueuePlace | null {
    return this.opts.hub.queue;
  }

  /** The pond clock, sampled by the hub client's pings. */
  get clock(): PondClock {
    return this.opts.hub.clock;
  }

  get welcome(): Welcome | null {
    return this.last;
  }

  /** The linked players, not this one: the status line's count. */
  get count(): number {
    return this.openCount();
  }

  /** Offers this page refused (no class for the caller, or no room). */
  get strangers(): number {
    return this.links.refused;
  }

  /** A player's name: a linked peer's ticket, or the directory's word. */
  nameOf(id: string): string | undefined {
    return this.mesh?.ticketOf(id)?.seat.name ?? this.neighbours.nameOf(id);
  }

  /** The players this page knows of but has no drawn link to, newest sighting each: the map's hollow marks. */
  sightings(linked: { has(id: string): boolean }): MapSighting[] {
    const now = this.now();
    const known = this.neighbours.known(now);
    return sightings(known, linked, this.opts.selfId, (id) => this.nameOf(id), now);
  }

  /** The linked peers, with their names: the menu's Players list. */
  others(): Member[] {
    return this.openPeers().map((playerId) => ({ playerId, name: this.nameOf(playerId) ?? '' }));
  }

  /**
   * Whether a player's page is here, so its fighter is not away: it is linked (a fight's players
   * hold each other as P0, and a closed page drops its links).
   */
  present(id: string): boolean {
    return this.mesh?.isOpen(id) === true;
  }

  /** Whether there is a connection to this peer, open or coming up. */
  hasLink(id: string): boolean {
    return this.mesh?.peers().includes(id) === true;
  }

  openCount(): number {
    return this.openPeers().length;
  }

  /**
   * The directory's newest swarm while the creature is in the water (M11 T17): the players two or
   * more tiers smaller in its AoI, which the scene draws as faint clouds. A new answer is a new array.
   */
  swarm(): readonly SwarmPoint[] {
    return this.opts.creature?.()?.inWater ? this.neighbours.swarm : NO_SWARM;
  }

  /**
   * Reports where the creature is as soon as the reports' gap allows (M12 T7): a ride's arrival,
   * so the hub's `near` names the group there at once.
   */
  reportSoon(): void {
    this.reporter.nudge();
  }

  /** Whether nobody is linked and nobody is known within the creature's query radius. */
  alone(): boolean {
    if (this.openCount() > 0) return false;
    const c = this.opts.creature?.();
    if (!c) return true;
    const q = queryRadius(aoiRadius(c.r, c.adultR));
    return !this.neighbours.anyWithin(c.x, c.y, q, this.now());
  }

  /**
   * Resolves with the welcome once the hub is online and the pond clock has a sample, or with null
   * after `timeoutMs` or as soon as the hub is known to be unreachable.
   */
  whenReady(timeoutMs: number): Promise<Welcome | null> {
    const { hub } = this.opts;
    return new Promise((resolve) => {
      const finish = (w: Welcome | null): void => {
        clearTimeout(timeout);
        clearInterval(poll);
        unsubscribe();
        resolve(w);
      };
      const check = (): void => {
        if (hub.status === 'offline' || isFinalStatus(hub.status)) finish(null);
        else if (hub.status === 'online' && this.last && hub.clock.offset !== null)
          finish(this.last);
      };
      const timeout = setTimeout(() => finish(null), timeoutMs);
      const unsubscribe = hub.onStatus(check);
      const poll = setInterval(check, READY_POLL_MS);
      check();
    });
  }

  /** A message to the hub itself (not a peer): genesis asks, progress, death. */
  send(msg: ClientMsg): void {
    this.opts.hub.send(msg);
  }

  /**
   * Snapshot `n` (`SnapshotSender`) to the linked peers it falls due for at the rate each asked
   * (M11 T15); the 93-byte `signed` frame, when there is one, goes to every one of `candidates`
   * whatever its rate, so they keep a signed frame every 200 ms. Without `n` it goes to every peer.
   */
  broadcastState(
    bytes: Uint8Array,
    signed: Uint8Array | null = null,
    candidates: ReadonlySet<string> = NO_CANDIDATES,
    n?: number,
  ): void {
    const rates = this.sendRates;
    if (n !== undefined) rates.frame(n);
    this.eachOpen((id, mesh) => {
      if (!this.drawn(id)) return;
      if (signed && candidates.has(id)) mesh.sendState(id, signed);
      else if (n === undefined || rates.due(id)) mesh.sendState(id, bytes);
    });
  }

  /** The linked peers (their hello passed). */
  openPeers(): string[] {
    const ids: string[] = [];
    this.eachOpen((id) => ids.push(id));
    return ids;
  }

  /** State-channel bytes (a proxy frame, M8 T11) to one linked peer. */
  sendState(id: string, bytes: Uint8Array): void {
    if (this.mesh?.isOpen(id)) this.mesh.sendState(id, bytes);
  }

  /** A game event to every linked peer that shares water (a duty link in other water carries only its duty). */
  broadcastEvent(event: PeerEvent): void {
    this.eachOpen((id, mesh) => {
      if (this.drawn(id)) mesh.sendEvent(id, event);
    });
  }

  sendEvent(id: string, event: PeerEvent): void {
    this.mesh?.sendEvent(id, event);
  }

  /** Opens (or closes) a duty link to `peer` for fight `enc` (M10 T6): P0 through the plan. */
  dutyPeer(enc: string, peer: string, on: boolean): void {
    this.links.duty(enc, peer, on);
  }

  /** The creatures this page wants linked as P0 or P1: a witness duty needs at most 28 (M11 T16). */
  protectedLinks(): number {
    return this.links.protectedCount();
  }

  /** The duty links, by peer. */
  dutyLinks(): DutyLink[] {
    return this.links.dutyLinks();
  }

  /** Sets how many P0 + P1 sharing water make the page crowded (`debug.crowdAt`, 2 to 24). */
  setCrowdAt(n: number): void {
    this.crowd.setCrowdAt(n);
  }

  /** Whether `peer` shares water with `player`, by the freshest word of each: an away fighter's proxies. */
  sharesWith(peer: string, player: string): boolean {
    return this.crowd.between(peer, player);
  }

  /** Sets the room for P2 to P4 (`debug.netCap`). */
  setCap(cap: number): void {
    this.links.setCap(cap);
  }

  /** The links as `state().net` shows them. */
  netInfo(): NetLinks {
    const s = this.route.stats();
    return {
      links: this.links.info().map((l) => ({
        ...l,
        hz: this.sendRates.hz(l.id),
        wanted: this.asker.wanted(l.id),
      })),
      known: this.neighbours.counts(this.now()),
      crowded: this.links.crowded,
      where: { sent: this.wheres, leaf: this.neighbours.leaf ? { ...this.neighbours.leaf } : null },
      signals: { hub: s.hub, relayed: s.relayed, forwarded: s.forwarded, forged: s.forged },
      helloFailed: this.mesh?.stats().helloFailed ?? 0,
      instance: this.crowd.info(),
    };
  }

  /**
   * Reads the links' stats into the relay totals (M13 T4): every `RELAY_READ_MS` while the page
   * holds links (and once after the last closes, for its last stats), and now for
   * `debug.progressNow`. A read waits for the one running.
   */
  readRelay(): Promise<void> {
    const mesh = this.mesh;
    if (!mesh?.linkStats) return Promise.resolve();
    this.relayReadAt = this.now();
    const run = (this.relayReading ?? Promise.resolve())
      .then(() => mesh.linkStats?.() ?? [])
      .then(
        (links) => {
          this.relayStats.read(links);
          this.relayHeld = links.some((l) => !l.closed);
        },
        () => {},
      );
    this.relayReading = run;
    void run.then(() => {
      if (this.relayReading === run) this.relayReading = null;
    });
    return run;
  }

  /** The totals of the relay reads since the last call (`LifeFlow.report`), or null with none. */
  takeRelay(): RelayReport | null {
    return this.relayStats.take();
  }

  /**
   * One step of the links: the directory report, gossip, the route's resends, offers past their
   * time and the plan (every 500 ms), and the relay reads. The session's timer calls it; tests call
   * it by hand.
   */
  tick(): void {
    const now = this.now();
    this.report(now);
    if (
      this.relayReading === null &&
      now - this.relayReadAt >= RELAY_READ_MS &&
      (this.relayHeld || this.openCount() > 0)
    ) {
      void this.readRelay();
    }
    const mesh = this.mesh;
    if (mesh) {
      for (const [to, event] of this.neighbours.gossip.due(
        this.openPeers(),
        this.neighbours.linkedFixes(),
        now,
      )) {
        mesh.sendEvent(to, event);
      }
    }
    this.route.tick();
    this.links.tick();
    this.askRates(now);
  }

  /**
   * Asks each linked peer for the snapshot rate this page wants of it now (M11 T15), by its class
   * and its newest snapshot's distance; 10 Hz with no creature.
   */
  private askRates(now: number): void {
    const mesh = this.mesh;
    if (!mesh) return;
    const c = this.opts.creature?.() ?? null;
    const halfHeight = c ? viewHalfHeight(c.r, c.adultR) : 0;
    const wants: [string, SnapshotRate][] = [];
    this.eachOpen((id) => {
      if (!c) {
        wants.push([id, FULL_RATE]);
        return;
      }
      const fix = this.neighbours.fixOf(id);
      // No snapshot heard yet: stay at 10 Hz rather than ask a newcomer's rate down on no distance.
      if (!fix) {
        wants.push([id, FULL_RATE]);
        return;
      }
      const d = Math.hypot(fix.x - c.x, fix.y - c.y);
      wants.push([id, wantedRate(this.links.classOf(id), d, halfHeight)]);
    });
    for (const [id, hz] of this.asker.update(now, wants)) mesh.sendEvent(id, { t: 'rate', hz });
  }

  /** Drops both ends' rate state for `id`: a link always starts again at 10 Hz. */
  private forgetRates(id: string): void {
    this.sendRates.forget(id);
    this.asker.forget(id);
  }

  /** Leaves the hub and closes every connection. */
  dispose(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.opts.hub.send({ t: 'leave' } satisfies ClientMsg);
    this.opts.hub.close();
    this.mesh?.close();
    this.mesh = null;
  }

  /** `where` and `gone` by `WhereReporter`, once the hub has welcomed this session. */
  private report(now: number): void {
    const c = this.opts.creature?.() ?? null;
    const inWater = c?.inWater === true;
    if (!inWater) this.inWaterSince = null;
    else this.inWaterSince ??= now;
    const { crowd } = this;
    // Crowded: the P0 + P1 wanted that share its water reach `crowdAt` (M12 T6).
    crowd.crowded = inWater && this.links.protectedCount((id) => crowd.shares(id)) >= crowd.crowdAt;
    if (!this.last || this.opts.hub.status !== 'online') return;
    // Turning alone reports at once (M12 T7): the hub times a ride's wait from that report.
    const lonely = inWater && this.alone();
    if (lonely && !this.wasAlone) this.reporter.nudge();
    this.wasAlone = lonely;
    const msg = this.reporter.update(
      {
        inWater,
        x: c?.x ?? 0,
        y: c?.y ?? 0,
        r: c?.r ?? 1,
        aoi: c ? aoiRadius(c.r, c.adultR) : 1,
        now,
      },
      this.neighbours.leaf,
      c && crowd.crowded
        ? () => crowdList(this.opts.selfId, { ...c, n: crowd.own }, this.neighbours.linkedFixes())
        : null,
    );
    if (!msg) return;
    if (msg.t === 'where') {
      this.wheres++;
      if (msg.crowd) crowd.crowdSent++;
    }
    this.opts.hub.send(msg);
  }

  private pos(): Pos {
    const c = this.opts.creature?.();
    const centre = this.last?.world.centre ?? { x: 0, y: 0 };
    return c
      ? [wireCoord(c.x), wireCoord(c.y), wireRadius(c.r)]
      : [wireCoord(centre.x), wireCoord(centre.y), 1];
  }

  private eachOpen(fn: (id: string, mesh: OnlineMesh) => void): void {
    const { mesh } = this;
    if (!mesh) return;
    for (const id of mesh.peers()) if (mesh.isOpen(id)) fn(id, mesh);
  }

  private welcomed(w: Welcome): void {
    const { handlers } = this.opts;
    this.last = w;
    // A new hub session: the directory forgot this page, so it reports again. Links stay: they are
    // the peers' own.
    this.reporter = new WhereReporter();
    this.neighbours.resetDirectory();
    // Its fights end in 3 s unless the hub resends them (it does at once for a running one).
    this.links.endFights();
    if (this.mesh) this.mesh.setIce(w.ice);
    else this.mesh = this.makeMesh(w.ice);
    // A new hub session starts in the open water; the hub names the instance again if it keeps one.
    this.ownWater(OPEN_WATER);
    handlers.welcome(w);
  }

  private world(m: WorldMsg): void {
    if (m.t === 'leaf') {
      this.neighbours.leaf = m.leaf;
      return;
    }
    if (m.t === 'instance') {
      this.ownWater(m.n);
      return;
    }
    const now = this.now();
    for (const p of m.peers) this.crowd.see(p.id, p.n, now);
    this.neighbours.near(m.leaf, m.peers, m.swarm, now);
    this.waterChanged();
  }

  /** Whether this page draws a linked peer: it shares water, or fights beside it (M12 T6). */
  private drawn(id: string): boolean {
    return this.crowd.shares(id) || this.links.fighter(id);
  }

  /**
   * The hub named this page's instance (M12 T6): every link hears it before any closes, the busy
   * toast shows on leaving the open water (at most once a minute), and the links follow the water.
   */
  private ownWater(n: number): void {
    const { changed, busy } = this.crowd.setOwn(n, this.now());
    if (!changed) return;
    this.reporter.nudge();
    this.eachOpen((id, mesh) => mesh.sendEvent(id, { t: 'instance', n }));
    if (busy) this.opts.handlers.busy?.();
    this.waterChanged();
  }

  /** Tells the app which linked peers stopped or started being drawn, then plans: links follow the water. */
  private waterChanged(): void {
    for (const [id, shown] of this.crowd.sort(this.openPeers(), (id) => this.drawn(id))) {
      this.opts.handlers.water?.(id, shown);
    }
    this.links.plan();
  }

  private signalled(m: SignalMsg): void {
    this.route.fromHub(m.from, m.kind, m.sdp, m.at, m.cls);
  }

  private makeMesh(ice: IceServer[]): OnlineMesh {
    const { handlers } = this.opts;
    const mesh = this.opts.createMesh(ice, (to, kind, sdp) => this.links.outgoing(to, kind, sdp));
    mesh.onPeerJoined((id) => {
      // Its hello named its instance (M12 T6).
      this.crowd.see(id, mesh.instanceOf(id), this.now());
      // A new link: both ends start again at 10 Hz.
      this.forgetRates(id);
      this.links.opened(id);
      handlers.peerOpen(id, this.nameOf(id) ?? id.slice(0, 6));
      this.waterChanged();
    });
    mesh.onPeerLeft((id) => {
      // Closed by the other side just after this page's instance changed: it left the water, and
      // fades rather than vanish (its `instance` event may not have come first).
      if (!this.crowd.left(id) && this.crowd.changedLately(this.now())) handlers.water?.(id, false);
      this.forgetRates(id);
      this.links.left(id);
      this.route.forget(id);
      handlers.peerLeft(id);
    });
    mesh.onState((id, s, signed) => {
      // A peer in other water is not drawn (a duty link carries its duty only).
      if (!this.drawn(id)) return;
      this.neighbours.snapshot(id, s.x, s.y, Math.sqrt(Math.max(1, s.biomass)), this.now());
      handlers.state(id, s, signed);
    });
    mesh.onEvent((id, e) => {
      if (e.t === 'peers') this.neighbours.gossip.receive(id, e, this.now(), this.crowd.own);
      else if (e.t === 'relay') this.route.fromPeer(id, e);
      else if (e.t === 'rate') this.sendRates.set(id, e.hz);
      else if (e.t === 'instance') {
        this.crowd.see(id, e.n, this.now());
        this.waterChanged();
      } else if (this.drawn(id) || DUTY_EVENTS.has(e.t)) handlers.event(id, e);
    });
    mesh.onProxy((id, player, s) => handlers.proxy(id, player, s));
    return mesh;
  }
}

export interface RealSessionOptions {
  url: string;
  identity: Identity;
  name: string;
  handlers: OnlineHandlers;
  creature: () => CreatureNow | null;
  /** The authority's keys (`/v1/pubkeys`), which check each peer's seat ticket. */
  keys: (() => Promise<PubKey[] | null>) | null;
}

/** The session with the real hub client and a gated `PeerMesh`, clocked by `performance.now`. */
export function connectOnline(opts: RealSessionOptions): OnlineSession {
  const { identity } = opts;
  const now = () => performance.now();
  const hub = new RealHub({ url: opts.url, identity, name: opts.name, now });
  // The checks load `@noble/curves`, which the app shell never imports statically: the page links
  // once they and the authority's keys are in.
  let seat: typeof import('../ledger/seat') | null = null;
  let keys: PubKey[] | null = null;
  let loading = false;
  const load = (): void => {
    if (loading || (seat && keys)) return;
    loading = true;
    void Promise.all([import('../ledger/seat'), opts.keys?.() ?? null]).then(
      ([module, k]) => {
        seat = module;
        keys = k;
        loading = false;
      },
      () => {
        loading = false;
      },
    );
  };
  load();
  const session: OnlineSession = new OnlineSession({
    selfId: identity.playerId,
    hub,
    handlers: opts.handlers,
    creature: opts.creature,
    tickMs: TICK_MS,
    sign: (to, kind, cls, at, pos, sdp) => {
      if (!seat) throw new Error('not ready');
      return seat.signSignal(identity, to, kind, cls, at, pos, sdp);
    },
    verify: (m) => seat?.signalSigned(m) === true,
    canLink: () => {
      load();
      return seat !== null && keys !== null;
    },
    createMesh: (ice, signal) =>
      new PeerMesh({
        selfId: identity.playerId,
        signal,
        iceServers: ice as RTCIceServer[],
        retry: false,
        hello: {
          ticket: () => hub.ticket,
          instance: () => session.crowd.own,
          check: (peer, ticket) => {
            const world = session.welcome?.world.seed;
            return (
              seat !== null &&
              keys !== null &&
              world !== undefined &&
              seat.seatValid(ticket, keys, { world, player: peer, now: hub.clock.hubNow(now()) })
            );
          },
        },
      }),
  });
  return session;
}
