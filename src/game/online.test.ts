import { describe, expect, it, vi } from 'vitest';
import { createIdentity, memoryKeyStore } from '../ledger/identity';
import { decodeStateFrame, verifySnap } from '../ledger/snapshot-sig';
import { PondClock } from '../net/clock';
import type { DutyMsg, FightMsg, HubStatus, LifeMsg, SignalMsg, Welcome } from '../net/hub-client';
import { type SnapshotFields, SnapshotSender } from '../net/pond-sync';
import {
  type ClientMsg,
  encodeSnapshot,
  type Member,
  type PeerEvent,
  SIGNED_FRAME_BYTES,
  type SignedSnap,
  SNAPSHOT_BYTES,
  type Snapshot,
} from '../net/protocol';
import { SignedSnaps } from '../net/signed-snaps';
import { TICK_HZ } from '../sim/rules';
import { CandidateSigner, lockState } from './engage';
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
  private fightFns: ((m: FightMsg) => void)[] = [];
  private dutyFns: ((m: DutyMsg) => void)[] = [];
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
  state: (id: string, s: Snapshot, signed: SignedSnap | null) => void = () => {};
  event: (id: string, e: PeerEvent) => void = () => {};
  proxy: (id: string, player: string, s: Snapshot) => void = () => {};
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
    proxy: vi.fn(),
    life: vi.fn(),
    fight: vi.fn(),
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
  it('passes on proxies from roster members only, and sends state to one open member (M8 T11)', () => {
    const { hub, mesh, handlers, session } = setup();
    hub.welcome(welcome(['a', 'b']));
    mesh.open.add('a');
    const pose = { seq: 1 } as Snapshot;
    mesh.proxy('a', 'gone', pose);
    mesh.proxy('stranger', 'gone', pose);
    expect(handlers.proxy.mock.calls).toEqual([['a', 'gone', pose]]);
    expect(session.openPeers()).toEqual(['a']);
    session.sendState('a', new Uint8Array([1]));
    session.sendState('b', new Uint8Array([2]));
    session.sendState('stranger', new Uint8Array([3]));
    expect(mesh.states).toEqual([['a', new Uint8Array([1])]]);
  });

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
    mesh.state('a', snapshot, null);
    mesh.state('zed', snapshot, null);
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

  describe('duty links (M10 T6)', () => {
    const enc = 'e'.repeat(64);
    const offer = (from: string): SignalMsg => ({ t: 'signal', from, kind: 'offer', sdp: 'v=0' });
    const dutyPeer = (peer: string, on: boolean, e = enc) =>
      ({ t: 'duty-peer', enc: e, peer, on }) as const;

    it('connects to a duty peer outside the roster only after its duty-peer, the lower id calling', () => {
      const { hub, mesh, session } = setup();
      hub.welcome(welcome(['a']));
      // Unannounced offers from outside the pond are dropped and counted.
      hub.signal(offer('w'));
      hub.signal(offer('c'));
      expect(mesh.signals).toEqual([]);
      expect(session.strangers).toBe(2);
      hub.duty(dutyPeer('w', true));
      hub.duty(dutyPeer('c', true));
      // 'me' < 'w' calls; 'c' < 'me' calls us, and its offer now passes.
      expect(mesh.connects).toEqual(['a', 'w']);
      hub.signal(offer('c'));
      expect(mesh.signals).toEqual([offer('c')]);
      expect(session.strangers).toBe(2);
      mesh.open.add('w');
      expect(session.dutyLinks()).toEqual([
        { peer: 'c', open: false, encs: [enc] },
        { peer: 'w', open: true, encs: [enc] },
      ]);
    });

    it('holds a duty link through a roster eviction, and closes it on off', () => {
      const { hub, mesh, handlers, session } = setup();
      hub.welcome(welcome(['a']));
      hub.duty(dutyPeer('w', true));
      mesh.open.add('w');
      // A welcome to another pond drops every roster link, but not the duty one.
      hub.welcome(welcome(['b'], 'pond2'));
      expect(mesh.disconnects).toEqual(['a']);
      expect(mesh.isOpen('w')).toBe(true);
      // A duty peer's witness messages reach the handler; its pond traffic and state do not.
      const finput: PeerEvent = { t: 'finput', enc, f: 3, i: 1, sig: 's' };
      mesh.event('w', finput);
      mesh.event('w', { t: 'chat', text: 'hi' });
      mesh.state('w', { seq: 1 } as Snapshot, null);
      expect(handlers.event.mock.calls).toEqual([['w', finput]]);
      expect(handlers.state).not.toHaveBeenCalled();
      expect(session.openPeers()).toEqual([]);
      hub.duty(dutyPeer('w', false));
      expect(mesh.disconnects).toEqual(['a', 'w']);
      expect(session.dutyLinks()).toEqual([]);
      hub.signal(offer('w'));
      expect(mesh.signals).toEqual([]);
    });

    it('keeps a pond member that was also a duty peer open', () => {
      const { hub, mesh, session } = setup();
      hub.welcome(welcome(['a', 'w']));
      mesh.open.add('w');
      hub.duty(dutyPeer('w', true));
      expect(mesh.connects).toEqual(['a', 'w']);
      hub.duty(dutyPeer('w', false));
      expect(mesh.disconnects).toEqual([]);
      expect(session.openPeers()).toEqual(['w']);
      // A duty peer who leaves the pond keeps its link until the duty ends.
      hub.duty(dutyPeer('w', true));
      hub.member('leave', { playerId: 'w', name: 'W' });
      expect(mesh.disconnects).toEqual([]);
      hub.duty(dutyPeer('w', false));
      expect(mesh.disconnects).toEqual(['w']);
    });

    it('closes a fight’s duty links at its end and at the duty’s end, one fight at a time', () => {
      const { hub, mesh, session } = setup();
      hub.welcome(welcome([]));
      const other = 'f'.repeat(64);
      hub.duty(dutyPeer('w', true));
      hub.duty(dutyPeer('x', true));
      hub.duty(dutyPeer('x', true, other));
      hub.fight({ t: 'enc-end', enc } as FightMsg);
      // 'x' still serves the other fight.
      expect(mesh.disconnects).toEqual(['w']);
      hub.duty({ t: 'duty-end', event: `enc:${other}`, why: 'done' });
      expect(mesh.disconnects).toEqual(['w', 'x']);
      expect(session.dutyLinks()).toEqual([]);
    });

    it('opens no duty link past 32 connections', () => {
      const { hub, mesh, session } = setup();
      hub.welcome(welcome([]));
      for (let i = 0; i < 32; i++) mesh.open.add(`z${String(i).padStart(2, '0')}`);
      hub.duty(dutyPeer('w', true));
      expect(mesh.connects).toEqual([]);
      expect(session.dutyLinks()).toEqual([]);
    });
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
    hub.welcome(welcome(['a']));
    const s = { ...fields(5), seq: 1 };
    const signed = { snap: 'x', sig: 'y' };
    mesh.state('a', s, signed);
    mesh.state('stranger', s, signed);
    expect(handlers.state.mock.calls).toEqual([['a', s, signed]]);
  });

  it('sends candidates the 89-byte frame at 5 Hz and everyone else 25 bytes, within 600 B/s', async () => {
    const me = await createIdentity(memoryKeyStore(new Uint8Array(32).fill(6)));
    const { hub, mesh, session } = setup();
    hub.welcome(welcome(['near', 'far', 'giant']));
    for (const id of ['near', 'far', 'giant']) mesh.open.add(id);
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
    expect((bytes.get('near') ?? 0) / seconds).toBeLessThanOrEqual(600);
    // Everyone else still hears 10 snapshots a second.
    expect((bytes.get('far') ?? 0) / seconds).toBeCloseTo(10 * SNAPSHOT_BYTES, -1);
  });

  it('routes a lock ask to the handler, whose answer leaves before the call returns', async () => {
    const me = await createIdentity(memoryKeyStore(new Uint8Array(32).fill(7)));
    const { hub, handlers, session } = setup();
    hub.welcome(welcome([]));
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
