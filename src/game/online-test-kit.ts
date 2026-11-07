// The online session's fakes (M11 T13): a hub and a mesh the tests drive by hand, and a session
// on them with a page clock moved in 100 ms ticks.

import { vi } from 'vitest';
import type { SignedSeat } from '../ledger/seat-doc';
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
import type { ClientMsg, NearPeer, PeerEvent, SignedSnap, Snapshot } from '../net/protocol';
import { type CreatureNow, type OnlineHub, type OnlineMesh, OnlineSession } from './online';
import { YOUNG_MS } from './online-links';

export class FakeHub implements OnlineHub {
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
export class FakeMesh implements OnlineMesh {
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

export const C = 131_072;

export const welcome = (worldId = 'world1'): Welcome => ({
  t: 'welcome',
  world: { id: worldId, seed: 'seed1', epoch: 1000, centre: { x: C, y: C }, size: 262_144 },
  you: { spawnHint: { x: C + 200, y: C } },
  ice: [{ urls: 'stun:example.test' }],
  turn: false,
  now: 5000,
});

export const LEAF = { x: 0, y: 0, size: 262_144 };
export const nearMsg = (peers: [id: string, dx: number][], age = 0): WorldMsg => ({
  t: 'near',
  leaf: LEAF,
  peers: peers.map(
    ([id, dx]): NearPeer => ({ id, name: id.toUpperCase(), x: C + dx, y: C, r: 10, age }),
  ),
  swarm: [],
});

/** A starter's snapshot `dx` wu east of the world's centre. */
export const snap = (dx: number, biomass = 100): Snapshot =>
  ({ seq: 1, x: C + dx, y: C, biomass, alive: true }) as Snapshot;

export function setup(over: { creature?: CreatureNow | null } = {}) {
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
export function settled(over: { creature?: CreatureNow | null } = {}) {
  const rig = setup(over);
  rig.hub.welcome(welcome());
  rig.run(YOUNG_MS + 100);
  rig.hub.sent.length = 0;
  return rig;
}
