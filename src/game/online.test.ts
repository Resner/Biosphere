import { describe, expect, it, vi } from 'vitest';
import { PondClock } from '../net/clock';
import type { HubStatus, LifeMsg, SignalMsg, Welcome } from '../net/hub-client';
import type { Member, PeerEvent, Snapshot } from '../net/protocol';
import { type OnlineHub, type OnlineMesh, OnlineSession } from './online';

class FakeHub implements OnlineHub {
  status: HubStatus = 'connecting';
  queue = null;
  readonly clock = new PondClock();
  sent: unknown[] = [];
  closed = false;
  private statusFns: ((s: HubStatus) => void)[] = [];
  private signalFns: ((m: SignalMsg) => void)[] = [];
  private memberFns: ((op: 'join' | 'leave', m: Member) => void)[] = [];
  private welcomeFns: ((w: Welcome) => void)[] = [];
  private lifeFns: ((m: LifeMsg) => void)[] = [];
  connect(): Promise<Welcome> {
    return new Promise(() => {});
  }
  close(): void {
    this.closed = true;
  }
  send(msg: unknown): void {
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
  onMember(fn: (op: 'join' | 'leave', m: Member) => void) {
    this.memberFns.push(fn);
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
  setStatus(s: HubStatus): void {
    this.status = s;
    for (const fn of this.statusFns) fn(s);
  }
  welcome(w: Welcome): void {
    this.setStatus('online');
    for (const fn of this.welcomeFns) fn(w);
  }
  member(op: 'join' | 'leave', m: Member): void {
    for (const fn of this.memberFns) fn(op, m);
  }
  life(m: LifeMsg): void {
    for (const fn of this.lifeFns) fn(m);
  }
  signal(m: SignalMsg): void {
    for (const fn of this.signalFns) fn(m);
  }
}

class FakeMesh implements OnlineMesh {
  connects: string[] = [];
  ices: unknown[] = [];
  disconnects: string[] = [];
  signals: SignalMsg[] = [];
  open = new Set<string>();
  states: [string, Uint8Array][] = [];
  events: [string, PeerEvent][] = [];
  closed = false;
  joined: (id: string) => void = () => {};
  state: (id: string, s: Snapshot) => void = () => {};
  event: (id: string, e: PeerEvent) => void = () => {};
  connect(id: string): void {
    this.connects.push(id);
  }
  setIce(ice: unknown[]): void {
    this.ices.push(ice);
  }
  disconnect(id: string): void {
    this.disconnects.push(id);
    this.open.delete(id);
  }
  close(): void {
    this.closed = true;
  }
  peers(): string[] {
    return [...this.open];
  }
  isOpen(id: string): boolean {
    return this.open.has(id);
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
  onState(fn: (id: string, s: Snapshot) => void): void {
    this.state = fn;
  }
  onEvent(fn: (id: string, e: PeerEvent) => void): void {
    this.event = fn;
  }
}

const welcome = (members: string[], pondId = 'pond1'): Welcome => ({
  t: 'welcome',
  pond: { id: pondId, seed: 'seed1', epoch: 1000, centre: { x: 500, y: 500 }, size: 1000 },
  you: { spawnHint: { x: 700, y: 500 } },
  members: members.map((playerId) => ({ playerId, name: playerId.toUpperCase() })),
  ice: [{ urls: 'stun:example.test' }],
  turn: false,
  now: 5000,
});

function setup() {
  const hub = new FakeHub();
  const mesh = new FakeMesh();
  const made: { ice: unknown }[] = [];
  const handlers = {
    welcome: vi.fn(),
    member: vi.fn(),
    peerOpen: vi.fn(),
    state: vi.fn(),
    event: vi.fn(),
    life: vi.fn(),
  };
  const session = new OnlineSession({
    selfId: 'me',
    hub,
    createMesh: (ice) => {
      made.push({ ice });
      return mesh;
    },
    handlers,
  });
  return { hub, mesh, made, handlers, session };
}

describe('OnlineSession', () => {
  it('connects to every member of the welcome, but not to itself', () => {
    const { hub, mesh, made, handlers, session } = setup();
    hub.welcome(welcome(['a', 'me', 'b']));
    expect(mesh.connects.sort()).toEqual(['a', 'b']);
    expect(made).toHaveLength(1);
    expect(made[0]?.ice).toEqual([{ urls: 'stun:example.test' }]);
    expect(session.others().map((m) => m.playerId)).toEqual(['a', 'b']);
    expect(session.count).toBe(3);
    expect(handlers.welcome).toHaveBeenCalledTimes(1);
  });

  it('waits for a joiner to connect to it, and drops a member who leaves', () => {
    const { hub, mesh, handlers, session } = setup();
    hub.welcome(welcome(['a']));
    hub.member('join', { playerId: 'c', name: 'C' });
    expect(mesh.connects).toEqual(['a']);
    expect(session.count).toBe(3);
    expect(handlers.member).toHaveBeenCalledWith('join', { playerId: 'c', name: 'C' });
    hub.member('leave', { playerId: 'a', name: 'A' });
    expect(mesh.disconnects).toEqual(['a']);
    expect(session.count).toBe(2);
    expect(handlers.member).toHaveBeenLastCalledWith('leave', { playerId: 'a', name: 'A' });
  });

  it('reconciles a second welcome for the same pond and moves to a new pond', () => {
    const { hub, mesh, handlers, session } = setup();
    hub.welcome(welcome(['a', 'b']));
    mesh.connects.length = 0;
    hub.welcome(welcome(['b', 'c']));
    expect(mesh.connects.sort()).toEqual(['b', 'c']);
    expect(mesh.disconnects.sort()).toEqual(['a', 'b']);
    expect(handlers.member).toHaveBeenCalledWith('leave', { playerId: 'a', name: 'A' });
    mesh.disconnects.length = 0;
    hub.welcome(welcome(['d'], 'pond2'));
    expect(mesh.disconnects.sort()).toEqual(['b', 'c']);
    expect(session.others().map((m) => m.playerId)).toEqual(['d']);
    expect(session.welcome?.pond.id).toBe('pond2');
  });

  it('re-calls the members it already knew when a reconnect welcomes it into the same pond', () => {
    const { hub, mesh, handlers } = setup();
    hub.welcome(welcome(['a', 'b']));
    mesh.open.add('a');
    mesh.connects.length = 0;
    mesh.disconnects.length = 0;
    handlers.member.mockClear();
    hub.welcome(welcome(['a', 'b']));
    // Peers dropped this client on the hub's `leave`, so every link starts again from the caller.
    expect(mesh.disconnects.sort()).toEqual(['a', 'b']);
    expect(mesh.connects.sort()).toEqual(['a', 'b']);
    expect(handlers.member).not.toHaveBeenCalled();
  });

  it('hands the newest ICE servers to the mesh on a later welcome', () => {
    const { hub, mesh } = setup();
    hub.welcome(welcome(['a']));
    expect(mesh.ices).toEqual([]);
    const second = { ...welcome(['a']), ice: [{ urls: 'turn:fresh.test', username: 'u' }] };
    hub.welcome(second);
    expect(mesh.ices).toEqual([[{ urls: 'turn:fresh.test', username: 'u' }]]);
  });

  it('routes signals from roster members to the mesh and ignores strangers', () => {
    const { hub, mesh } = setup();
    hub.welcome(welcome(['a']));
    hub.signal({ t: 'signal', from: 'a', kind: 'offer', sdp: 'x' });
    hub.signal({ t: 'signal', from: 'zed', kind: 'offer', sdp: 'y' });
    expect(mesh.signals.map((s) => s.from)).toEqual(['a']);
  });

  it('passes on peer traffic from roster members only', () => {
    const { hub, mesh, handlers } = setup();
    hub.welcome(welcome(['a']));
    mesh.joined('a');
    expect(handlers.peerOpen).toHaveBeenCalledWith('a');
    mesh.event('a', { t: 'emote', id: 1 });
    mesh.event('zed', { t: 'emote', id: 2 });
    expect(handlers.event).toHaveBeenCalledTimes(1);
    const snapshot = { seq: 1 } as Snapshot;
    mesh.state('a', snapshot);
    mesh.state('zed', snapshot);
    expect(handlers.state).toHaveBeenCalledTimes(1);
  });

  it('passes the hub’s word about the creature on, and sends the player’s own messages', () => {
    const { hub, handlers, session } = setup();
    hub.life({ t: 'life', life: null, genesisIn: 0 });
    expect(handlers.life).toHaveBeenCalledWith({ t: 'life', life: null, genesisIn: 0 });
    session.send({ t: 'history' });
    expect(hub.sent).toContainEqual({ t: 'history' });
  });

  it('broadcasts to open peers only', () => {
    const { hub, mesh, session } = setup();
    hub.welcome(welcome(['a', 'b']));
    mesh.open.add('a');
    session.broadcastState(new Uint8Array(24));
    session.broadcastEvent({ t: 'emote', id: 3 });
    expect(mesh.states.map(([id]) => id)).toEqual(['a']);
    expect(mesh.events).toEqual([['a', { t: 'emote', id: 3 }]]);
    expect(session.openCount()).toBe(1);
  });

  it('has a link to roster members the mesh holds, open or not', () => {
    const { hub, mesh, session } = setup();
    hub.welcome(welcome(['a', 'b']));
    mesh.open.add('a');
    mesh.open.add('stranger');
    expect(session.hasLink('a')).toBe(true);
    expect(session.hasLink('b')).toBe(false);
    expect(session.hasLink('stranger')).toBe(false);
  });

  it('reports ready once online with a clock sample', async () => {
    const { hub, session } = setup();
    vi.useFakeTimers();
    try {
      const ready = session.whenReady(4000);
      hub.welcome(welcome([]));
      await vi.advanceTimersByTimeAsync(200);
      let done: Welcome | null | undefined;
      void ready.then((w) => {
        done = w;
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(done).toBeUndefined();
      hub.clock.addSample(0, 40, 5000);
      await vi.advanceTimersByTimeAsync(100);
      expect(done?.pond.id).toBe('pond1');
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

  it('says goodbye and closes everything on dispose', () => {
    const { hub, mesh, session } = setup();
    hub.welcome(welcome(['a']));
    session.dispose();
    expect(hub.sent).toContainEqual({ t: 'leave' });
    expect(hub.closed).toBe(true);
    expect(mesh.closed).toBe(true);
  });
});
