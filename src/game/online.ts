// The online session: hub roster, WebRTC mesh and the traffic between them. It owns no game state;
// `app.ts` supplies the handlers and decides what a snapshot or a claim means for the world.

import type { Identity } from '../ledger/identity';
import type { PondClock } from '../net/clock';
import {
  type HubClient,
  type HubStatus,
  isFinalStatus,
  type LifeMsg,
  type QueuePlace,
  HubClient as RealHub,
  type SignalMsg,
  type Welcome,
} from '../net/hub-client';
import { PeerMesh } from '../net/peer-mesh';
import type { ClientMsg, IceServer, Member, PeerEvent, Snapshot } from '../net/protocol';

export type OnlineHub = Pick<
  HubClient,
  | 'status'
  | 'queue'
  | 'clock'
  | 'connect'
  | 'close'
  | 'send'
  | 'onStatus'
  | 'onSignal'
  | 'onMember'
  | 'onWelcome'
  | 'onLife'
>;

export type OnlineMesh = Pick<
  PeerMesh,
  | 'connect'
  | 'disconnect'
  | 'setIce'
  | 'close'
  | 'peers'
  | 'isOpen'
  | 'sendState'
  | 'sendEvent'
  | 'handleSignal'
  | 'onPeerJoined'
  | 'onState'
  | 'onEvent'
>;

export interface OnlineHandlers {
  /** Every welcome, including after a reconnect. */
  welcome(w: Welcome): void;
  /** A roster change; a welcome reports each member it adds or drops the same way. */
  member(op: 'join' | 'leave', member: Member): void;
  /** Both data channels to a roster member are open. */
  peerOpen(id: string): void;
  state(id: string, snapshot: Snapshot): void;
  event(id: string, event: PeerEvent): void;
  /** The hub's word about this player's creature (resume, genesis, acks, death). */
  life(msg: LifeMsg): void;
}

export interface OnlineOptions {
  selfId: string;
  hub: OnlineHub;
  createMesh(
    ice: IceServer[],
    signal: (to: string, kind: 'offer' | 'answer', sdp: string) => void,
  ): OnlineMesh;
  handlers: OnlineHandlers;
}

const READY_POLL_MS = 50;

export class OnlineSession {
  private readonly roster = new Map<string, Member>();
  private mesh: OnlineMesh | null = null;
  private last: Welcome | null = null;

  constructor(private readonly opts: OnlineOptions) {
    const { hub } = opts;
    hub.onWelcome((w) => this.welcomed(w));
    hub.onMember((op, member) => this.member(op, member));
    hub.onSignal((m) => this.signalled(m));
    hub.onLife((m) => opts.handlers.life(m));
    // Rejections (replaced, closed) are reported through the status, not here.
    hub.connect().catch(() => {});
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

  /** Players in the pond, this one included. */
  get count(): number {
    return this.roster.size + 1;
  }

  /** The name of a roster member (not this player), or undefined. */
  nameOf(id: string): string | undefined {
    return this.roster.get(id)?.name;
  }

  others(): Member[] {
    return [...this.roster.values()];
  }

  /** Whether there is a connection to this roster member, open or coming up. */
  hasLink(id: string): boolean {
    return this.roster.has(id) && this.mesh?.peers().includes(id) === true;
  }

  openCount(): number {
    let open = 0;
    this.eachOpen(() => open++);
    return open;
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

  broadcastState(bytes: Uint8Array): void {
    this.eachOpen((id, mesh) => mesh.sendState(id, bytes));
  }

  broadcastEvent(event: PeerEvent): void {
    this.eachOpen((id, mesh) => mesh.sendEvent(id, event));
  }

  sendEvent(id: string, event: PeerEvent): void {
    this.mesh?.sendEvent(id, event);
  }

  /** Leaves the pond and closes every connection. */
  dispose(): void {
    this.opts.hub.send({ t: 'leave' } satisfies ClientMsg);
    this.opts.hub.close();
    this.mesh?.close();
    this.mesh = null;
  }

  private eachOpen(fn: (id: string, mesh: OnlineMesh) => void): void {
    const { mesh } = this;
    if (!mesh) return;
    for (const id of this.roster.keys()) if (mesh.isOpen(id)) fn(id, mesh);
  }

  private welcomed(w: Welcome): void {
    const { selfId, handlers } = this.opts;
    const samePond = this.last?.pond.id === w.pond.id;
    this.last = w;
    const now = new Map(w.members.filter((m) => m.playerId !== selfId).map((m) => [m.playerId, m]));
    for (const [id, member] of [...this.roster]) {
      if (samePond && now.has(id)) continue;
      this.drop(id, member);
    }
    if (this.mesh) this.mesh.setIce(w.ice);
    else this.mesh = this.makeMesh(w.ice);
    for (const [id, member] of now) {
      if (this.roster.has(id)) {
        // A reconnect: the peers dropped this client on the hub's `leave` and now wait for its
        // offer, so start every link again from the caller.
        this.mesh.disconnect(id);
      } else {
        this.roster.set(id, member);
        handlers.member('join', member);
      }
      this.mesh.connect(id);
    }
    handlers.welcome(w);
  }

  private member(op: 'join' | 'leave', member: Member): void {
    if (member.playerId === this.opts.selfId) return;
    if (op === 'join') {
      // The joiner offers to us (it connects to everyone in its welcome), so we wait.
      this.roster.set(member.playerId, member);
      this.opts.handlers.member('join', member);
    } else {
      this.drop(member.playerId, member);
    }
  }

  private drop(id: string, member: Member): void {
    this.roster.delete(id);
    this.mesh?.disconnect(id);
    this.opts.handlers.member('leave', member);
  }

  private signalled(m: SignalMsg): void {
    if (this.roster.has(m.from)) void this.mesh?.handleSignal(m.from, m.kind, m.sdp);
  }

  private makeMesh(ice: IceServer[]): OnlineMesh {
    const { hub, handlers } = this.opts;
    const mesh = this.opts.createMesh(ice, (to, kind, sdp) =>
      hub.send({ t: 'signal', to, kind, sdp } satisfies ClientMsg),
    );
    mesh.onPeerJoined((id) => {
      if (this.roster.has(id)) handlers.peerOpen(id);
    });
    mesh.onState((id, s) => {
      if (this.roster.has(id)) handlers.state(id, s);
    });
    mesh.onEvent((id, e) => {
      if (this.roster.has(id)) handlers.event(id, e);
    });
    return mesh;
  }
}

export interface RealSessionOptions {
  url: string;
  identity: Identity;
  name: string;
  handlers: OnlineHandlers;
}

/** The session with the real hub client and `PeerMesh`, clocked by `performance.now`. */
export function connectOnline(opts: RealSessionOptions): OnlineSession {
  const { identity } = opts;
  const hub = new RealHub({
    url: opts.url,
    identity,
    name: opts.name,
    now: () => performance.now(),
  });
  return new OnlineSession({
    selfId: identity.playerId,
    hub,
    handlers: opts.handlers,
    createMesh: (ice, signal) =>
      new PeerMesh({
        selfId: identity.playerId,
        signal,
        iceServers: ice as RTCIceServer[],
      }),
  });
}
