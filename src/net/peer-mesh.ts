// WebRTC peer mesh: perfect negotiation over the hub's signal relay, non-trickle ICE, and two data
// channels per peer (`state`: unordered, lossy; `event`: ordered, reliable).

import {
  byteLength,
  decodeSnapshot,
  EVENT_MAX_BYTES,
  type PeerEvent,
  parsePeerEvent,
  SNAPSHOT_BYTES,
  type Snapshot,
} from './protocol';

/** The slice of `RTCDataChannel` the mesh uses, so tests can fake it. */
export interface DataChannelLike {
  readonly label: string;
  readonly readyState: string;
  binaryType: string;
  onopen: (() => void) | null;
  onclose: (() => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  send(data: string | ArrayBuffer | Uint8Array): void;
  close(): void;
}

/** The slice of `RTCPeerConnection` the mesh uses, so tests can fake it. */
export interface PeerConnectionLike {
  readonly connectionState: string;
  readonly iceGatheringState: string;
  readonly localDescription: { sdp: string } | null;
  ondatachannel: ((ev: { channel: DataChannelLike }) => void) | null;
  onicegatheringstatechange: (() => void) | null;
  onconnectionstatechange: (() => void) | null;
  createDataChannel(label: string, init?: RTCDataChannelInit): DataChannelLike;
  setLocalDescription(): Promise<void>;
  setRemoteDescription(desc: { type: 'offer' | 'answer'; sdp: string }): Promise<void>;
  close(): void;
}

export type PeerConnectionFactory = (config: RTCConfiguration) => PeerConnectionLike;

export const browserPeerConnection: PeerConnectionFactory = (config) =>
  new RTCPeerConnection(config) as unknown as PeerConnectionLike;

export interface PeerMeshOptions {
  selfId: string;
  /** Sends an offer or answer to `to` through the hub. */
  signal: (to: string, kind: 'offer' | 'answer', sdp: string) => void;
  createPeerConnection?: PeerConnectionFactory;
  iceServers?: RTCIceServer[];
}

export interface PeerMeshStats {
  /** Inbound messages dropped as malformed, oversized or on the wrong channel. */
  dropped: number;
  /** Peers with both channels open. */
  open: number;
}

/** A connection that is not up by then is closed. */
export const CONNECT_TIMEOUT_MS = 12_000;
export const RETRY_DELAY_MS = 3_000;
/** A link that was up and dropped is re-called this many times, the wait doubling each time. */
export const RECOVERY_MAX_ATTEMPTS = 5;
const RETRY_DELAY_MAX_MS = 30_000;
/** Offers and answers wait this long for ICE gathering before they go out. */
export const GATHER_TIMEOUT_MS = 2_000;

const STATE_CHANNEL = 'state';
const EVENT_CHANNEL = 'event';

interface Link {
  readonly peerId: string;
  readonly pc: PeerConnectionLike;
  readonly caller: boolean;
  state: DataChannelLike | null;
  event: DataChannelLike | null;
  opened: boolean;
  closed: boolean;
  /** Serialises the offer and answer steps of this connection. */
  chain: Promise<void>;
  timeout: ReturnType<typeof setTimeout> | null;
  /** Failed attempts in a row as caller (a link that was up counts as the first). */
  attempt: number;
  /** Whether this link replaces one that was up (more attempts than a first connection). */
  recovering: boolean;
}

export class PeerMesh {
  private readonly links = new Map<string, Link>();
  private readonly retries = new Map<string, ReturnType<typeof setTimeout>>();
  private droppedCount = 0;
  private joinedListeners: ((id: string) => void)[] = [];
  private leftListeners: ((id: string) => void)[] = [];
  private stateListeners: ((id: string, s: Snapshot) => void)[] = [];
  private eventListeners: ((id: string, e: PeerEvent) => void)[] = [];
  private readonly factory: PeerConnectionFactory;
  private iceServers: RTCIceServer[];

  constructor(private readonly opts: PeerMeshOptions) {
    this.iceServers = opts.iceServers ?? [];
    this.factory = opts.createPeerConnection ?? browserPeerConnection;
  }

  onPeerJoined(fn: (id: string) => void): void {
    this.joinedListeners.push(fn);
  }
  onPeerLeft(fn: (id: string) => void): void {
    this.leftListeners.push(fn);
  }
  onState(fn: (id: string, s: Snapshot) => void): void {
    this.stateListeners.push(fn);
  }
  onEvent(fn: (id: string, e: PeerEvent) => void): void {
    this.eventListeners.push(fn);
  }

  stats(): PeerMeshStats {
    let open = 0;
    for (const l of this.links.values()) if (l.opened) open += 1;
    return { dropped: this.droppedCount, open };
  }

  /** Peers that are connected or being connected. */
  peers(): string[] {
    return [...this.links.keys()];
  }

  isOpen(id: string): boolean {
    return this.links.get(id)?.opened === true;
  }

  /** Replaces the ICE servers (fresh TURN credentials) for connections and recoveries from now on. */
  setIce(iceServers: RTCIceServer[]): void {
    this.iceServers = iceServers;
  }

  /** Starts a connection as the caller. Does nothing when one is already under way. */
  connect(peerId: string): void {
    if (peerId === this.opts.selfId || this.links.has(peerId)) return;
    this.clearRetry(peerId);
    this.startCall(peerId, 0, false);
  }

  /** Closes the connection to a peer that left the roster. */
  disconnect(peerId: string): void {
    this.clearRetry(peerId);
    const link = this.links.get(peerId);
    if (link) this.teardown(link);
  }

  close(): void {
    for (const id of [...this.retries.keys()]) this.clearRetry(id);
    for (const link of [...this.links.values()]) this.teardown(link);
  }

  /** Sends a snapshot on the lossy channel. Returns false when it was not sent. */
  sendState(peerId: string, bytes: Uint8Array): boolean {
    return this.sendOn(this.links.get(peerId)?.state ?? null, bytes);
  }

  /** Sends an event on the reliable channel. Returns false when it was not sent. */
  sendEvent(peerId: string, event: PeerEvent): boolean {
    const text = JSON.stringify(event);
    if (byteLength(text) > EVENT_MAX_BYTES) return false;
    return this.sendOn(this.links.get(peerId)?.event ?? null, text);
  }

  /** Feeds an offer or answer relayed by the hub. */
  handleSignal(from: string, kind: 'offer' | 'answer', sdp: string): Promise<void> {
    if (from === this.opts.selfId) return Promise.resolve();
    const link = this.links.get(from);
    if (kind === 'answer') {
      if (!link || !link.caller || link.opened) return Promise.resolve();
      return this.enqueue(link, async () => {
        await link.pc.setRemoteDescription({ type: 'answer', sdp });
      });
    }
    if (link?.caller && !link.opened && this.isPolite(from) === false) {
      // Glare: both sides offered and we are the impolite one, so our offer stands.
      return Promise.resolve();
    }
    if (link) this.teardown(link);
    this.clearRetry(from);
    const callee = this.createLink(from, false);
    return this.enqueue(callee, async () => {
      await callee.pc.setRemoteDescription({ type: 'offer', sdp });
      await callee.pc.setLocalDescription();
      await this.sendLocal(callee, 'answer');
    });
  }

  /** The side with the higher id yields on glare. */
  private isPolite(peerId: string): boolean {
    return this.opts.selfId > peerId;
  }

  private startCall(peerId: string, attempt: number, recovering: boolean): void {
    const link = this.createLink(peerId, true);
    link.attempt = attempt;
    link.recovering = recovering;
    link.state = this.watch(
      link,
      link.pc.createDataChannel(STATE_CHANNEL, { ordered: false, maxRetransmits: 0 }),
    );
    link.event = this.watch(link, link.pc.createDataChannel(EVENT_CHANNEL, { ordered: true }));
    void this.enqueue(link, async () => {
      await link.pc.setLocalDescription();
      await this.sendLocal(link, 'offer');
    });
  }

  private createLink(peerId: string, caller: boolean): Link {
    const pc = this.factory({ iceServers: this.iceServers });
    const link: Link = {
      peerId,
      pc,
      caller,
      state: null,
      event: null,
      opened: false,
      closed: false,
      chain: Promise.resolve(),
      timeout: null,
      attempt: 0,
      recovering: false,
    };
    this.links.set(peerId, link);
    pc.ondatachannel = ({ channel }) => {
      if (link.closed) return;
      if (channel.label === STATE_CHANNEL && !link.state) link.state = this.watch(link, channel);
      else if (channel.label === EVENT_CHANNEL && !link.event)
        link.event = this.watch(link, channel);
      else channel.close();
    };
    pc.onconnectionstatechange = () => {
      if (link.closed) return;
      const s = pc.connectionState;
      if (s === 'failed' || s === 'closed') this.failed(link);
      else this.checkOpen(link);
    };
    link.timeout = setTimeout(() => this.failed(link), CONNECT_TIMEOUT_MS);
    return link;
  }

  private watch(link: Link, channel: DataChannelLike): DataChannelLike {
    channel.binaryType = 'arraybuffer';
    channel.onopen = () => this.checkOpen(link);
    channel.onclose = () => {
      if (link.opened) this.failed(link);
    };
    channel.onmessage = (ev) => this.receive(link, channel.label, ev.data);
    return channel;
  }

  private checkOpen(link: Link): void {
    if (link.closed || link.opened) return;
    if (
      link.pc.connectionState !== 'connected' ||
      link.state?.readyState !== 'open' ||
      link.event?.readyState !== 'open'
    ) {
      return;
    }
    link.opened = true;
    if (link.timeout) clearTimeout(link.timeout);
    link.timeout = null;
    for (const fn of this.joinedListeners) fn(link.peerId);
  }

  /**
   * A first connection that never came up is retried once by its caller. One that was up and
   * dropped is re-called by the lower id (the higher id waits for the offer), with a doubling wait,
   * up to `RECOVERY_MAX_ATTEMPTS` times; `disconnect` (the peer left the roster) cancels it.
   */
  private failed(link: Link): void {
    if (link.closed) return;
    const { peerId } = link;
    const wasOpen = link.opened;
    const recovering = link.recovering || wasOpen;
    const attempt = wasOpen ? 1 : link.attempt + 1;
    const caller = wasOpen ? this.opts.selfId < peerId : link.caller;
    const retry = caller && attempt <= (recovering ? RECOVERY_MAX_ATTEMPTS : 1);
    this.teardown(link);
    if (!retry) return;
    const delay = Math.min(RETRY_DELAY_MS * 2 ** (attempt - 1), RETRY_DELAY_MAX_MS);
    this.retries.set(
      peerId,
      setTimeout(() => {
        this.retries.delete(peerId);
        if (!this.links.has(peerId)) this.startCall(peerId, attempt, recovering);
      }, delay),
    );
  }

  private teardown(link: Link): void {
    if (link.closed) return;
    link.closed = true;
    if (link.timeout) clearTimeout(link.timeout);
    link.timeout = null;
    if (this.links.get(link.peerId) === link) this.links.delete(link.peerId);
    for (const ch of [link.state, link.event]) {
      if (!ch) continue;
      ch.onopen = ch.onclose = ch.onmessage = null;
      try {
        ch.close();
      } catch {
        // already closed
      }
    }
    link.pc.ondatachannel =
      link.pc.onconnectionstatechange =
      link.pc.onicegatheringstatechange =
        null;
    try {
      link.pc.close();
    } catch {
      // already closed
    }
    if (link.opened) for (const fn of this.leftListeners) fn(link.peerId);
  }

  private clearRetry(peerId: string): void {
    const t = this.retries.get(peerId);
    if (t) clearTimeout(t);
    this.retries.delete(peerId);
  }

  private enqueue(link: Link, step: () => Promise<void>): Promise<void> {
    link.chain = link.chain.then(step).catch(() => this.failed(link));
    return link.chain;
  }

  /** Waits for ICE gathering (at most 2 s), then sends the local description. */
  private async sendLocal(link: Link, kind: 'offer' | 'answer'): Promise<void> {
    const { pc } = link;
    if (pc.iceGatheringState !== 'complete') {
      await new Promise<void>((resolve) => {
        const done = () => {
          clearTimeout(timer);
          pc.onicegatheringstatechange = null;
          resolve();
        };
        const timer = setTimeout(done, GATHER_TIMEOUT_MS);
        pc.onicegatheringstatechange = () => {
          if (pc.iceGatheringState === 'complete') done();
        };
      });
    }
    if (link.closed || !pc.localDescription) return;
    this.opts.signal(link.peerId, kind, pc.localDescription.sdp);
  }

  private sendOn(channel: DataChannelLike | null, data: string | Uint8Array): boolean {
    if (!channel || channel.readyState !== 'open') return false;
    try {
      channel.send(data);
      return true;
    } catch {
      return false;
    }
  }

  private receive(link: Link, label: string, data: unknown): void {
    if (link.closed) return;
    if (label === STATE_CHANNEL) {
      const bytes = toBytes(data);
      const snapshot = bytes && bytes.byteLength === SNAPSHOT_BYTES ? decodeSnapshot(bytes) : null;
      if (!snapshot) {
        this.droppedCount += 1;
        return;
      }
      for (const fn of this.stateListeners) fn(link.peerId, snapshot);
      return;
    }
    const event =
      typeof data === 'string' && byteLength(data) <= EVENT_MAX_BYTES ? parsePeerEvent(data) : null;
    if (!event) {
      this.droppedCount += 1;
      return;
    }
    for (const fn of this.eventListeners) fn(link.peerId, event);
  }
}

function toBytes(data: unknown): Uint8Array | null {
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data))
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  return null;
}
