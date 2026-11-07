import { describe, expect, it, vi } from 'vitest';
import { createIdentity, memoryKeyStore } from '../ledger/identity';
import type { SignedSeat } from '../ledger/seat-doc';
import { decodeStateFrame, verifySnap } from '../ledger/snapshot-sig';
import { UNWANTED_GRACE_MS } from '../net/aoi';
import { PondClock } from '../net/clock';
import type {
  DutyMsg,
  FightMsg,
  HubStatus,
  LifeMsg,
  SignalMsg,
  Welcome,
  WorldMsg,
} from '../net/hub-client';
import type { PeerMeshStats } from '../net/peer-mesh';
import { type SnapshotFields, SnapshotSender } from '../net/pond-sync';
import {
  type ClientMsg,
  encodeSnapshot,
  type NearPeer,
  type PeerEvent,
  SIGNED_FRAME_BYTES,
  type SignedSnap,
  SNAPSHOT_BYTES,
  type Snapshot,
} from '../net/protocol';
import { SignedSnaps } from '../net/signed-snaps';
import { TICK_HZ } from '../sim/rules';
import { CandidateSigner, lockState } from './engage';
import { type CreatureNow, type OnlineHub, type OnlineMesh, OnlineSession } from './online';
import { REFUSED_BACKOFF_MS, YOUNG_MS } from './online-links';

class FakeHub implements OnlineHub {
  status: HubStatus = 'connecting';
  queue = null;
  readonly clock = new PondClock();
  ticket: SignedSeat | null = {} as SignedSeat;
  sent: ClientMsg[] = [];
  closed = false;
  private statusFns: ((s: HubStatus) => void)[] = [];
  private signalFns: ((m: SignalMsg) => void)[] = [];
  private welcomeFns: ((w: Welcome) => void)[] = [];
  private worldFns: ((m: WorldMsg) => void)[] = [];
  private lifeFns: ((m: LifeMsg) => void)[] = [];
  private fightFns: ((m: FightMsg) => void)[] = [];
  private dutyFns: ((m: DutyMsg) => void)[] = [];
  connect(): Promise<Welcome> {
    return new Promise(() => {});
  }
  close(): void {
    this.closed = true;
  }
  send(msg: ClientMsg): void {
    this.sent.push(msg);
  }
  onStatus(fn: (s: HubStatus) => void) {
    this.statusFns.push(fn);
    return () => {};
  }
  onSignal(fn: (m: SignalMsg) => void) {
    this.signalFns.push(fn);
    return () => {};
  }
  onWorld(fn: (m: WorldMsg) => void) {
    this.worldFns.push(fn);
    return () => {};
  }
  onLife(fn: (m: LifeMsg) => void) {
    this.lifeFns.push(fn);
    return () => {};
  }
  onWelcome(fn: (w: Welcome) => void) {
    this.welcomeFns.push(fn);
    return () => {};
  }
  onFight(fn: (m: FightMsg) => void) {
    this.fightFns.push(fn);
    return () => {};
  }
  onDuty(fn: (m: DutyMsg) => void) {
    this.dutyFns.push(fn);
    return () => {};
  }
  fight(m: FightMsg): void {
    for (const fn of this.fightFns) fn(m);
  }
  duty(m: DutyMsg): void {
    for (const fn of this.dutyFns) fn(m);
  }
  setStatus(s: HubStatus): void {
    this.status = s;
    for (const fn of this.statusFns) fn(s);
  }
  welcome(w: Welcome): void {
    this.setStatus('online');
    for (const fn of this.welcomeFns) fn(w);
  }
  world(m: WorldMsg): void {
    for (const fn of this.worldFns) fn(m);
  }
  life(m: LifeMsg): void {
    for (const fn of this.lifeFns) fn(m);
  }
  signal(m: SignalMsg): void {
    for (const fn of this.signalFns) fn(m);
  }
  /** The signals sent through the hub, as `[to, kind, cls]`. */
  signals(): [string, string, number | undefined][] {
    return this.sent.flatMap((m) => (m.t === 'signal' ? [[m.to, m.kind, m.cls]] : []));
  }
}

/** A mesh whose links come up when the test says (`join`), with tickets naming each peer. */
class FakeMesh implements OnlineMesh {
  connects: string[] = [];
  ices: unknown[] = [];
  disconnects: string[] = [];
  signals: SignalMsg[] = [];
  /** Links coming up, and links whose hello passed. */
  readonly pending = new Set<string>();
  readonly open = new Set<string>();
  states: [string, Uint8Array][] = [];
  events: [string, PeerEvent][] = [];
  closed = false;
  joined: (id: string) => void = () => {};
  leftFn: (id: string) => void = () => {};
  state: (id: string, s: Snapshot, signed: SignedSnap | null) => void = () => {};
  event: (id: string, e: PeerEvent) => void = () => {};
  proxy: (id: string, player: string, s: Snapshot) => void = () => {};
  connect(id: string): void {
    this.connects.push(id);
    if (!this.open.has(id)) this.pending.add(id);
  }
  setIce(ice: unknown[]): void {
    this.ices.push(ice);
  }
  disconnect(id: string): void {
    this.disconnects.push(id);
    this.pending.delete(id);
    if (this.open.delete(id)) this.leftFn(id);
  }
  close(): void {
    this.closed = true;
  }
  /** A link's hello passes. */
  join(id: string): void {
    this.pending.delete(id);
    this.open.add(id);
    this.joined(id);
  }
  peers(): string[] {
    return [...this.pending, ...this.open];
  }
  isOpen(id: string): boolean {
    return this.open.has(id);
  }
  isUp(id: string): boolean {
    return this.open.has(id);
  }
  ticketOf(id: string): SignedSeat | null {
    return this.open.has(id) ? ({ seat: { name: id.toUpperCase() } } as SignedSeat) : null;
  }
  stats(): PeerMeshStats {
    return { dropped: 0, open: this.open.size, helloFailed: 0 };
  }
  sendState(id: string, bytes: Uint8Array): boolean {
    this.states.push([id, bytes]);
    return true;
  }
  sendEvent(id: string, e: PeerEvent): boolean {
    this.events.push([id, e]);
    return true;
  }
  async handleSignal(from: string, kind: 'offer' | 'answer', sdp: string): Promise<void> {
    this.signals.push({ t: 'signal', from, kind, sdp });
  }
  onPeerJoined(fn: (id: string) => void): void {
    this.joined = fn;
  }
  onPeerLeft(fn: (id: string) => void): void {
    this.leftFn = fn;
  }
  onState(fn: (id: string, s: Snapshot, signed: SignedSnap | null) => void): void {
    this.state = fn;
  }
  onEvent(fn: (id: string, e: PeerEvent) => void): void {
    this.event = fn;
  }
  onProxy(fn: (id: string, player: string, s: Snapshot) => void): void {
    this.proxy = fn;
  }
}

const C = 131_072;

const welcome = (worldId = 'world1'): Welcome => ({
  t: 'welcome',
  world: { id: worldId, seed: 'seed1', epoch: 1000, centre: { x: C, y: C }, size: 262_144 },
  you: { spawnHint: { x: C + 200, y: C } },
  ice: [{ urls: 'stun:example.test' }],
  turn: false,
  now: 5000,
});

const LEAF = { x: 0, y: 0, size: 262_144 };
const nearMsg = (
  peers: [id: string, dx: number][],
  age = 0,
  swarm: [x: number, y: number][] = [],
): WorldMsg => ({
  t: 'near',
  leaf: LEAF,
  peers: peers.map(
    ([id, dx]): NearPeer => ({ id, name: id.toUpperCase(), x: C + dx, y: C, r: 10, age }),
  ),
  swarm,
});

/** A starter's snapshot `dx` wu east of the world's centre. */
const snap = (dx: number, biomass = 100): Snapshot =>
  ({ seq: 1, x: C + dx, y: C, biomass, alive: true }) as Snapshot;

function setup(over: { creature?: CreatureNow | null } = {}) {
  const hub = new FakeHub();
  const mesh = new FakeMesh();
  const made: {
    ice: unknown;
    signal: (to: string, kind: 'offer' | 'answer', sdp: string) => void;
  }[] = [];
  const clock = { now: 100_000 };
  let creature: CreatureNow | null =
    over.creature === undefined
      ? { x: C, y: C, vx: 0, vy: 0, r: 10, adultR: 20, inWater: true }
      : over.creature;
  const handlers = {
    welcome: vi.fn(),
    peerOpen: vi.fn(),
    peerLeft: vi.fn(),
    state: vi.fn(),
    event: vi.fn(),
    proxy: vi.fn(),
    life: vi.fn(),
    fight: vi.fn(),
  };
  const session = new OnlineSession({
    selfId: 'me',
    hub,
    createMesh: (ice, signal) => {
      made.push({ ice, signal });
      return mesh;
    },
    handlers,
    creature: () => creature,
    now: () => clock.now,
  });
  /** Moves the page clock on in 100 ms ticks. */
  const run = (ms: number) => {
    for (let t = 0; t < ms; t += 100) {
      clock.now += 100;
      session.tick();
    }
  };
  const setCreature = (c: CreatureNow | null) => {
    creature = c;
  };
  return { hub, mesh, made, handlers, session, clock, run, setCreature };
}

/** A session welcomed and in the water past its young dialling, with nothing known yet. */
function settled(over: { creature?: CreatureNow | null } = {}) {
  const rig = setup(over);
  rig.hub.welcome(welcome());
  rig.run(YOUNG_MS + 100);
  rig.hub.sent.length = 0;
  return rig;
}

describe('OnlineSession: links by area of interest (M11 T13)', () => {
  it('reports where it is, and links all three peers of a near', () => {
    const { hub, mesh, session, run } = setup();
    hub.welcome(welcome());
    run(100);
    expect(hub.sent.filter((m) => m.t === 'where')).toHaveLength(1);
    expect(session.netInfo().where.sent).toBe(1);
    hub.world(
      nearMsg([
        ['a', 300],
        ['b', 2000],
        ['c', 6000],
      ]),
    );
    expect(mesh.connects.sort()).toEqual(['a', 'b', 'c']);
    expect(session.netInfo().where.leaf).toEqual(LEAF);
    expect(session.netInfo().known.directory).toBe(3);
    // P1 goes through the hub, carrying its class.
    expect(session.links.classOf('a')).toBe(1);
  });

  it('closes a peer that moves beyond Q after 3 s, not before', () => {
    const { mesh, session, run } = settled();
    mesh.connect('b');
    mesh.join('b');
    mesh.state('b', snap(1000), null);
    run(600);
    expect(session.links.classOf('b')).toBe(4);
    // Past 1.1 × Q (8,192 wu for a starter): no class.
    mesh.state('b', snap(10_000), null);
    run(UNWANTED_GRACE_MS - 400);
    expect(mesh.disconnects).toEqual([]);
    run(1000);
    expect(mesh.disconnects).toEqual(['b']);
  });

  it('with a cap of 2 and three peers (one P1, two P4), holds the P1 and the nearer P4', () => {
    const { hub, mesh, session, run } = setup();
    hub.welcome(welcome());
    run(100);
    session.setCap(2);
    hub.world(
      nearMsg([
        ['b', 300],
        ['c', 5000],
        ['d', 6000],
      ]),
    );
    expect(mesh.connects.sort()).toEqual(['b', 'c']);
    for (const id of ['b', 'c']) mesh.join(id);
    mesh.state('d', snap(6000), null);
    expect(session.links.info().map((l) => [l.id, l.class, l.hello])).toEqual([
      ['b', 1, true],
      ['c', 4, true],
    ]);
  });

  it('a duty link with 24 links held evicts the farthest P4, and the total never passes 32', () => {
    const { hub, mesh, session, run } = settled();
    const far = Array.from({ length: 24 }, (_, i) => `p${String(i).padStart(2, '0')}`);
    hub.world(nearMsg(far.map((id, i) => [id, 3000 + 100 * i])));
    for (const id of far) mesh.join(id);
    run(600);
    expect(mesh.open.size).toBe(24);
    hub.duty({ t: 'duty-peer', enc: 'e'.repeat(64), peer: 'w', on: true });
    expect(mesh.connects).toContain('w');
    expect(mesh.disconnects).toEqual(['p23']);
    expect(mesh.peers()).toHaveLength(24);
    expect(session.dutyLinks()).toEqual([{ peer: 'w', open: false, encs: ['e'.repeat(64)] }]);

    // 32 creatures that can interact, then a duty: P0 and the nearest 31 P1, crowded.
    const { hub: hub2, mesh: mesh2, session: s2, run: run2 } = settled();
    const close = Array.from({ length: 32 }, (_, i) => `q${String(i).padStart(2, '0')}`);
    hub2.world(nearMsg(close.map((id, i) => [id, 100 + 10 * i])));
    for (const id of close) mesh2.join(id);
    run2(600);
    expect(mesh2.peers()).toHaveLength(32);
    expect(s2.links.crowded).toBe(false);
    hub2.duty({ t: 'duty-peer', enc: 'e'.repeat(64), peer: 'w', on: true });
    expect(mesh2.peers()).toHaveLength(32);
    expect(mesh2.peers()).toContain('w');
    expect(mesh2.disconnects).toEqual(['q31']);
    expect(s2.links.crowded).toBe(true);
  });

  it('admits an offer by the caller’s class and refuses one with no room, answering the refusal', () => {
    const { hub, mesh, session } = settled();
    session.setCap(1);
    hub.world(nearMsg([['a', 5000]]));
    mesh.join('a');
    // A stranger far beyond Q calling as P4: no room under a cap of 1.
    hub.signal({
      t: 'signal',
      from: 'z',
      kind: 'offer',
      sdp: 'v=0',
      cls: 4,
      at: [C + 7000, C, 10],
    });
    expect(mesh.signals).toEqual([]);
    expect(hub.signals()).toEqual([['z', 'refuse', 4]]);
    expect(session.strangers).toBe(1);
    // Calling as P1 (its directory position may be 30 s old): admitted, past the worst P4.
    hub.signal({
      t: 'signal',
      from: 'z',
      kind: 'offer',
      sdp: 'v=1',
      cls: 1,
      at: [C + 7000, C, 10],
    });
    expect(mesh.signals.map((m) => [m.from, m.kind, m.sdp])).toEqual([['z', 'offer', 'v=1']]);
    expect(mesh.disconnects).toEqual(['a']);
  });

  it('backs off a refused P4 for 5 s, then asks again', () => {
    const { hub, mesh, run } = settled();
    hub.world(nearMsg([['a', 6000]]));
    // 'me' > 'a': the lower id calls first; after 1.5 s this page calls.
    run(1600);
    expect(mesh.connects).toEqual(['a']);
    expect(hub.signals()).toEqual([]); // the fake mesh sends no offer by itself
    hub.signal({ t: 'signal', from: 'a', kind: 'refuse', sdp: '', cls: 4 });
    expect(mesh.disconnects).toEqual(['a']);
    hub.world(nearMsg([['a', 6000]]));
    run(REFUSED_BACKOFF_MS - 600);
    expect(mesh.connects).toEqual(['a']);
    hub.world(nearMsg([['a', 6000]]));
    run(1000);
    expect(mesh.connects).toEqual(['a', 'a']);
  });

  it('sends the mesh’s offers with the class: a P1 through the hub, and drops one unanswered after 8 s', () => {
    const { hub, mesh, made, run } = setup();
    hub.welcome(welcome());
    hub.world(nearMsg([['a', 300]]));
    expect(mesh.connects).toEqual(['a']);
    made[0]?.signal('a', 'offer', 'sdp-a');
    expect(hub.signals()).toEqual([['a', 'offer', 1]]);
    run(7900);
    expect(mesh.disconnects).toEqual([]);
    run(200);
    expect(mesh.disconnects).toEqual(['a']);
  });

  it('says gone once out of the water, and reports again on the way back', () => {
    const { hub, session, run, setCreature } = settled();
    setCreature({ x: C, y: C, vx: 0, vy: 0, r: 10, adultR: 20, inWater: false });
    run(2100);
    expect(hub.sent.filter((m) => m.t === 'gone' || m.t === 'where')).toEqual([{ t: 'gone' }]);
    setCreature({ x: C, y: C, vx: 0, vy: 0, r: 10, adultR: 20, inWater: true });
    run(2100);
    expect(hub.sent.filter((m) => m.t === 'where')).toHaveLength(1);
    expect(session.netInfo().where.sent).toBe(2);
  });

  it('keeps the newest near’s swarm while in the water, and forgets it out of it or on a new hub session (M11 T17)', () => {
    const { hub, session, setCreature } = settled();
    expect(session.swarm()).toEqual([]);
    const swarm: [number, number][] = [
      [C + 500, C],
      [C - 800, C + 200],
    ];
    hub.world(nearMsg([], 0, swarm));
    expect(session.swarm()).toEqual(swarm);
    // A newer answer replaces it as a whole.
    hub.world(nearMsg([], 0, [[C, C + 900]]));
    expect(session.swarm()).toEqual([[C, C + 900]]);
    setCreature({ x: C, y: C, vx: 0, vy: 0, r: 10, adultR: 20, inWater: false });
    expect(session.swarm()).toEqual([]);
    setCreature({ x: C, y: C, vx: 0, vy: 0, r: 10, adultR: 20, inWater: true });
    expect(session.swarm()).toEqual([[C, C + 900]]);
    hub.welcome(welcome());
    expect(session.swarm()).toEqual([]);
  });

  it('gossips to linked peers and takes theirs, and passes a relay to the route', () => {
    const { mesh, session, run } = settled();
    for (const id of ['a', 'b']) {
      mesh.connect(id);
      mesh.join(id);
    }
    mesh.state('a', snap(300), null);
    mesh.state('b', snap(600), null);
    run(100);
    const told = mesh.events.filter(([, e]) => e.t === 'peers');
    expect(told.map(([to]) => to).sort()).toEqual(['a', 'b']);
    mesh.event('a', { t: 'peers', list: [['c', C + 900, C, 10]] });
    expect(session.netInfo().known.gossip).toBe(1);
    // A forged relay (the fake signs nothing) is dropped and counted.
    mesh.event('a', {
      t: 'relay',
      from: 'c',
      to: 'me',
      kind: 'offer',
      sdp: 'v=0',
      cls: 2,
      at: 100_000,
      pos: [C, C, 10],
      sig: 'x',
    });
    expect(session.netInfo().signals.forged).toBe(1);
  });

  it('names linked peers from their tickets, lists them as the players, and tells the app of links', () => {
    const { hub, mesh, handlers, session } = settled();
    expect(session.count).toBe(0);
    // A fighter is present while its link is open, not by a name the directory once gave.
    hub.world(nearMsg([['n', 9000]]));
    expect(session.nameOf('n')).toBe('N');
    expect(session.present('n')).toBe(false);
    mesh.connect('a');
    expect(session.present('a')).toBe(false);
    mesh.join('a');
    expect(session.present('a')).toBe(true);
    expect(session.count).toBe(1);
    expect(handlers.peerOpen).toHaveBeenCalledWith('a', 'A');
    expect(session.others()).toEqual([{ playerId: 'a', name: 'A' }]);
    mesh.disconnect('a');
    expect(handlers.peerLeft).toHaveBeenCalledWith('a');
    expect(session.others()).toEqual([]);
    expect(session.present('a')).toBe(false);
    expect(session.count).toBe(0);
  });

  it('is alone with nothing linked and nothing known within Q', () => {
    const { hub, mesh, session } = settled();
    expect(session.alone()).toBe(true);
    hub.world(nearMsg([['a', 9000]]));
    expect(session.alone()).toBe(true);
    hub.world(nearMsg([['a', 8000]]));
    expect(session.alone()).toBe(false);
    hub.world(nearMsg([]));
    mesh.join('a');
    expect(session.alone()).toBe(false);
  });

  it('dials nobody and refuses every offer before it can check tickets', () => {
    const { hub, mesh } = setup();
    hub.ticket = null;
    hub.welcome(welcome());
    hub.world(nearMsg([['a', 300]]));
    expect(mesh.connects).toEqual([]);
    hub.signal({ t: 'signal', from: 'a', kind: 'offer', sdp: 'v=0', cls: 1 });
    expect(hub.signals()).toEqual([['a', 'refuse', 1]]);
  });

  it('holds only duty links with no creature (the title)', () => {
    const { hub, mesh, run } = settled({ creature: null });
    hub.world(nearMsg([['a', 300]]));
    expect(mesh.connects).toEqual([]);
    hub.duty({ t: 'duty-peer', enc: 'e'.repeat(64), peer: 'w', on: true });
    expect(mesh.connects).toEqual(['w']);
    mesh.join('w');
    hub.fight({ t: 'enc-end', enc: 'e'.repeat(64) } as FightMsg);
    run(UNWANTED_GRACE_MS + 600);
    expect(mesh.disconnects).toEqual(['w']);
  });
});

describe('OnlineSession', () => {
  it('passes on proxies and peer traffic from linked peers, and sends state to one open peer', () => {
    const { hub, mesh, handlers, session } = setup();
    hub.welcome(welcome());
    mesh.join('a');
    const pose = { seq: 1 } as Snapshot;
    mesh.proxy('a', 'gone', pose);
    expect(handlers.proxy.mock.calls).toEqual([['a', 'gone', pose]]);
    mesh.event('a', { t: 'emote', id: 1 });
    expect(handlers.event).toHaveBeenCalledWith('a', { t: 'emote', id: 1 });
    expect(session.openPeers()).toEqual(['a']);
    session.sendState('a', new Uint8Array([1]));
    session.sendState('b', new Uint8Array([2]));
    expect(mesh.states).toEqual([['a', new Uint8Array([1])]]);
  });

  it('makes one mesh with the welcome’s ICE servers, and hands it the newest on a later welcome', () => {
    const { hub, mesh, made, handlers } = setup();
    hub.welcome(welcome());
    expect(made).toHaveLength(1);
    expect(made[0]?.ice).toEqual([{ urls: 'stun:example.test' }]);
    expect(mesh.ices).toEqual([]);
    const second = { ...welcome(), ice: [{ urls: 'turn:fresh.test', username: 'u' }] };
    hub.welcome(second);
    expect(made).toHaveLength(1);
    expect(mesh.ices).toEqual([[{ urls: 'turn:fresh.test', username: 'u' }]]);
    expect(handlers.welcome).toHaveBeenCalledTimes(2);
  });

  it('keeps its links through a reconnect, and reports where it is again', () => {
    const { hub, mesh, session, run } = settled();
    mesh.connect('a');
    mesh.join('a');
    hub.welcome(welcome());
    run(100);
    expect(mesh.disconnects).toEqual([]);
    expect(session.netInfo().where.leaf).toBeNull();
    expect(hub.sent.filter((m) => m.t === 'where')).toHaveLength(1);
  });

  it('passes the hub’s word about the creature on, and sends the player’s own messages', () => {
    const { hub, handlers, session } = setup();
    hub.life({ t: 'life', life: null, genesisIn: 0 });
    expect(handlers.life).toHaveBeenCalledWith({ t: 'life', life: null, genesisIn: 0 });
    session.send({ t: 'history' });
    expect(hub.sent).toContainEqual({ t: 'history' });
  });

  it('broadcasts to open peers only, and has a link to every peer the mesh holds', () => {
    const { hub, mesh, session } = setup();
    hub.welcome(welcome());
    mesh.join('a');
    mesh.connect('b');
    session.broadcastState(new Uint8Array(24));
    session.broadcastEvent({ t: 'emote', id: 3 });
    expect(mesh.states.map(([id]) => id)).toEqual(['a']);
    expect(mesh.events).toEqual([['a', { t: 'emote', id: 3 }]]);
    expect(session.openCount()).toBe(1);
    expect(session.hasLink('a')).toBe(true);
    expect(session.hasLink('b')).toBe(true);
    expect(session.hasLink('c')).toBe(false);
  });

  it('reports ready once online with a clock sample', async () => {
    const { hub, session } = setup();
    vi.useFakeTimers();
    try {
      const ready = session.whenReady(4000);
      hub.welcome(welcome());
      await vi.advanceTimersByTimeAsync(200);
      let done: Welcome | null | undefined;
      void ready.then((w) => {
        done = w;
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(done).toBeUndefined();
      hub.clock.addSample(0, 40, 5000);
      await vi.advanceTimersByTimeAsync(100);
      expect(done?.world.id).toBe('world1');
    } finally {
      vi.useRealTimers();
    }
  });

  it('gives up after the timeout, and at once when the hub is unreachable', async () => {
    vi.useFakeTimers();
    try {
      const slow = setup();
      const waiting = slow.session.whenReady(4000);
      await vi.advanceTimersByTimeAsync(3999);
      slow.hub.setStatus('connecting');
      await vi.advanceTimersByTimeAsync(2);
      await expect(waiting).resolves.toBeNull();

      const refused = setup();
      const quick = refused.session.whenReady(4000);
      refused.hub.setStatus('offline');
      await expect(quick).resolves.toBeNull();
      // Already offline when asked: no waiting.
      await expect(refused.session.whenReady(4000)).resolves.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('closes a fight’s duty links once its end and the duty’s end leave them no class', () => {
    const { hub, mesh, session, run } = settled({ creature: null });
    const enc = 'e'.repeat(64);
    const other = 'f'.repeat(64);
    hub.duty({ t: 'duty-peer', enc, peer: 'w', on: true });
    hub.duty({ t: 'duty-peer', enc, peer: 'x', on: true });
    hub.duty({ t: 'duty-peer', enc: other, peer: 'x', on: true });
    for (const id of ['w', 'x']) mesh.join(id);
    hub.fight({ t: 'enc-end', enc } as FightMsg);
    run(UNWANTED_GRACE_MS + 600);
    // 'x' still serves the other fight.
    expect(mesh.disconnects).toEqual(['w']);
    hub.duty({ t: 'duty-end', event: `enc:${other}`, why: 'done' });
    expect(session.dutyLinks()).toEqual([]);
    run(UNWANTED_GRACE_MS + 600);
    expect(mesh.disconnects).toEqual(['w', 'x']);
  });

  it('says goodbye and closes everything on dispose', () => {
    const { hub, mesh, session } = setup();
    hub.welcome(welcome());
    session.dispose();
    expect(hub.sent).toContainEqual({ t: 'leave' });
    expect(hub.closed).toBe(true);
    expect(mesh.closed).toBe(true);
  });
});

const fields = (tick: number): SnapshotFields => ({
  tick,
  x: 1000,
  y: 1000,
  heading: 0,
  vx: 0,
  vy: 0,
  biomass: 400,
  energy: 1,
  health: 1,
  alive: true,
  dashing: false,
  ready: false,
  egg: false,
  spawnProtected: false,
  fighting: false,
  genomeRef: 9,
});

describe('signed snapshots between peers (M7 T7)', () => {
  it('passes a signed frame from the mesh to the handler with its snapshot', () => {
    const { hub, mesh, handlers } = setup();
    hub.welcome(welcome());
    const s = { ...fields(5), seq: 1 };
    const signed = { snap: 'x', sig: 'y' };
    mesh.state('a', s, signed);
    expect(handlers.state.mock.calls).toEqual([['a', s, signed]]);
  });

  // 5 Hz of 93-byte frames and 5 Hz of 29 bytes: M7's 600 B/s grew with the snapshot's wider
  // positions (M11 T2).
  it('sends candidates the 93-byte frame at 5 Hz and everyone else 29 bytes, within 620 B/s', async () => {
    const me = await createIdentity(memoryKeyStore(new Uint8Array(32).fill(6)));
    const { hub, mesh, session } = setup();
    hub.welcome(welcome());
    for (const id of ['near', 'far', 'giant']) mesh.join(id);
    const self = { x: 1000, y: 1000, biomass: 400 };
    const remotes = [
      { id: 'near', x: 1100, y: 1000, radius: 20 },
      { id: 'far', x: 1400, y: 1000, radius: 20 },
      { id: 'giant', x: 1050, y: 1000, radius: 200 },
    ];
    const signer = new CandidateSigner(() => ({ identity: me, pondId: 'pond1' }));
    const sender = new SnapshotSender((plain, signed) =>
      session.broadcastState(plain, signed, signer.ids),
    );
    // Each peer keeps what it hears, as the receiving client would.
    const heard = new SignedSnaps((_from, s) => verifySnap(me.playerId, 'pond1', s));
    const bytes = new Map<string, number>();
    const signedAt = new Map<string, number[]>();
    let newest = -1;
    let worstLag = 0;
    const seconds = 10;
    for (let frame = 0; frame <= seconds * 60; frame++) {
      const ms = (frame * 1000) / 60;
      const tick = Math.round((ms * TICK_HZ) / 1000);
      sender.update(
        ms,
        false,
        () => fields(tick),
        (plain) => signer.sign(plain, self, remotes),
      );
      for (const [id, data] of mesh.states.splice(0)) {
        bytes.set(id, (bytes.get(id) ?? 0) + data.length);
        expect([SNAPSHOT_BYTES, SIGNED_FRAME_BYTES]).toContain(data.length);
        const frameIn = decodeStateFrame(data);
        if (!frameIn) throw new Error('undecodable state frame');
        if (id === 'near') newest = frameIn.snapshot.tick;
        if (frameIn.signed) {
          signedAt.set(id, [...(signedAt.get(id) ?? []), ms]);
          heard.receive(id, frameIn.snapshot, frameIn.signed, ms);
        }
        if (id === 'near') {
          const stored = heard.tickOf('near');
          if (stored !== null) worstLag = Math.max(worstLag, newest - stored);
        }
      }
    }
    expect(signedAt.get('far')).toBeUndefined();
    expect(signedAt.get('giant')).toBeUndefined();
    const near = signedAt.get('near') ?? [];
    expect(near.length).toBeGreaterThanOrEqual(5 * seconds - 1);
    expect(near.length).toBeLessThanOrEqual(5 * seconds + 1);
    for (let i = 1; i < near.length; i++) {
      // 200 ms apart, give or take the frame the snapshot fell due in.
      const gap = (near[i] as number) - (near[i - 1] as number);
      expect(gap).toBeGreaterThan(180);
      expect(gap).toBeLessThan(220);
    }
    expect(heard.badSignatures).toBe(0);
    expect(worstLag).toBeLessThanOrEqual(7);
    expect((bytes.get('near') ?? 0) / seconds).toBeLessThanOrEqual(620);
    // Everyone else still hears 10 snapshots a second.
    expect((bytes.get('far') ?? 0) / seconds).toBeCloseTo(10 * SNAPSHOT_BYTES, -1);
  });

  it('keeps a candidate’s signed frames at 5 Hz when it asked for 1 Hz (M11 T15)', async () => {
    const me = await createIdentity(memoryKeyStore(new Uint8Array(32).fill(8)));
    const { hub, mesh, session } = setup();
    hub.welcome(welcome());
    mesh.join('near');
    mesh.event('near', { t: 'rate', hz: 1 });
    const signer = new CandidateSigner(() => ({ identity: me, pondId: 'pond1' }));
    const sender = new SnapshotSender((plain, signed, n) =>
      session.broadcastState(plain, signed, signer.ids, n),
    );
    const self = { x: 1000, y: 1000, biomass: 400 };
    const remotes = [{ id: 'near', x: 1100, y: 1000, radius: 20 }];
    let signedFrames = 0;
    const seconds = 10;
    for (let frame = 0; frame < seconds * 60; frame++) {
      const ms = (frame * 1000) / 60;
      sender.update(
        ms,
        false,
        () => fields(Math.round((ms * TICK_HZ) / 1000)),
        (plain) => signer.sign(plain, self, remotes),
      );
      for (const [, data] of mesh.states.splice(0)) {
        if (data.length === SIGNED_FRAME_BYTES) signedFrames++;
      }
    }
    expect(signedFrames).toBeGreaterThanOrEqual(5 * seconds - 1);
    expect(signedFrames).toBeLessThanOrEqual(5 * seconds + 1);
  });

  it('routes a lock ask to the handler, whose answer leaves before the call returns', async () => {
    const me = await createIdentity(memoryKeyStore(new Uint8Array(32).fill(7)));
    const { hub, handlers, session } = setup();
    hub.welcome(welcome());
    const now = fields(4242);
    handlers.fight.mockImplementation((msg: FightMsg) => {
      if (msg.t === 'lock-ask') {
        session.send(lockState(msg.lock, encodeSnapshot({ ...now, seq: 0 }), me, 'pond1'));
      }
    });
    hub.sent.length = 0;
    hub.fight({ t: 'lock-ask', lock: 'cd'.repeat(8), by: 'B'.repeat(43) });
    // No await: the answer is out within the same tick.
    const answer = hub.sent[0] as Extract<ClientMsg, { t: 'lock-state' }>;
    expect(answer).toMatchObject({ t: 'lock-state', lock: 'cd'.repeat(8) });
    expect(verifySnap(me.playerId, 'pond1', answer.mine)?.tick).toBe(4242);
  });
});

describe('snapshot rates by distance (M11 T15)', () => {
  /** A T2 giant: its view's half-height is about 1,977 wu, its AoI about 5,240 wu. */
  const giant: CreatureNow = { x: C, y: C, vx: 0, vy: 0, r: 400, adultR: 400, inWater: true };
  const rates = (mesh: FakeMesh) =>
    mesh.events.splice(0).flatMap(([id, e]) => (e.t === 'rate' ? [[id, e.hz]] : []));

  /** A settled giant linked to peers of radius 200 at `dx` wu east, each placed by its snapshot. */
  function linkedGiant(peers: [id: string, dx: number][]) {
    const rig = settled({ creature: giant });
    for (const [id, dx] of peers) {
      rig.mesh.connect(id);
      rig.mesh.join(id);
      rig.mesh.state(id, snap(dx, 40_000), null);
    }
    rig.run(600);
    return rig;
  }

  it('asks each class its rate, and only on a change', () => {
    const { mesh, session, run } = linkedGiant([
      ['b', 3000], // P1
      ['c', 4300], // P2, within 1.15 × the view's half-diagonal
      ['d', 5000], // P2
      ['e', 8000], // P3
      ['f', 15_000], // P4
    ]);
    expect(session.links.info().map((l) => [l.id, l.class])).toEqual([
      ['b', 1],
      ['c', 2],
      ['d', 2],
      ['e', 3],
      ['f', 4],
    ]);
    expect(rates(mesh).sort()).toEqual([
      ['d', 5],
      ['e', 2],
      ['f', 1],
    ]);
    expect(session.netInfo().links.map((l) => [l.id, l.wanted])).toEqual([
      ['b', 10],
      ['c', 10],
      ['d', 5],
      ['e', 2],
      ['f', 1],
    ]);
    run(3000);
    expect(rates(mesh)).toEqual([]);
  });

  it('keeps a link at 10 Hz until its first snapshot places it', () => {
    const { mesh, run } = settled({ creature: giant });
    mesh.connect('n');
    mesh.join('n');
    run(3000);
    expect(rates(mesh)).toEqual([]);
  });

  it('asks 10 Hz within a second of a peer crossing into the view', () => {
    const { mesh, run } = linkedGiant([['d', 5000]]);
    expect(rates(mesh)).toEqual([['d', 5]]);
    // Into the view at once after the ask: the second since it must pass first.
    mesh.state('d', snap(4000, 40_000), null);
    let askedAfter = -1;
    for (let ms = 100; ms <= 1000 && askedAfter < 0; ms += 100) {
      run(100);
      if (rates(mesh).some(([id, hz]) => id === 'd' && hz === 10)) askedAfter = ms;
    }
    expect(askedAfter).toBeGreaterThan(0);
    expect(askedAfter).toBeLessThanOrEqual(1000);
  });

  it('sends a link asking 2 Hz two snapshots a second, and 10 Hz again once its link is new', () => {
    const { hub, mesh, session } = setup();
    hub.welcome(welcome());
    for (const id of ['slow', 'full']) {
      mesh.connect(id);
      mesh.join(id);
    }
    mesh.event('slow', { t: 'rate', hz: 2 });
    const sender = new SnapshotSender((plain, signed, n) =>
      session.broadcastState(plain, signed, undefined, n),
    );
    const count = (seconds: number, from: number) => {
      const got = new Map<string, number>();
      for (let frame = 0; frame < seconds * 60; frame++) {
        const ms = from + (frame * 1000) / 60;
        sender.update(ms, false, () => fields(Math.round((ms * TICK_HZ) / 1000)));
        for (const [id] of mesh.states.splice(0)) got.set(id, (got.get(id) ?? 0) + 1);
      }
      return got;
    };
    const got = count(10, 0);
    expect(got.get('slow')).toBeGreaterThanOrEqual(19);
    expect(got.get('slow')).toBeLessThanOrEqual(21);
    expect(got.get('full')).toBeGreaterThanOrEqual(99);
    expect(session.netInfo().links.map((l) => [l.id, l.hz])).toEqual([
      ['full', 10],
      ['slow', 2],
    ]);
    // The link closes and opens again: the new one starts at 10 Hz.
    mesh.disconnect('slow');
    mesh.connect('slow');
    mesh.join('slow');
    expect(count(1, 10_000).get('slow')).toBeGreaterThanOrEqual(9);
  });
});
