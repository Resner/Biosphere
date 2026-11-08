// Browser-less WebRTC for unit tests: a fake `RTCPeerConnection` whose offers carry the caller's id
// and whose answers wire both ends' data channels together, so meshes talk with no network.

import type { DataChannelLike, PeerConnectionLike } from './peer-mesh';

export class FakeChannel implements DataChannelLike {
  readyState = 'connecting';
  binaryType = 'blob';
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  other: FakeChannel | null = null;
  sent: unknown[] = [];
  constructor(
    readonly label: string,
    readonly init: RTCDataChannelInit | undefined,
  ) {}
  send(data: string | ArrayBuffer | Uint8Array) {
    if (this.readyState !== 'open') throw new Error('InvalidStateError');
    this.sent.push(data);
    const copy = typeof data === 'string' ? data : (data as Uint8Array).slice().buffer;
    this.other?.onmessage?.({ data: copy });
  }
  open() {
    this.readyState = 'open';
    this.onopen?.();
  }
  close() {
    if (this.readyState === 'closed') return;
    this.readyState = 'closed';
    this.onclose?.();
  }
}

let nextId = 0;
/** Every fake connection by id, so an answer finds its answerer; clear it before each test. */
export const fakePcs = new Map<string, FakePc>();

/** A browser-less RTCPeerConnection: offers carry the caller's id, answers link the pair. */
export class FakePc implements PeerConnectionLike {
  readonly id = `pc${++nextId}`;
  connectionState = 'new';
  iceGatheringState = 'new';
  localDescription: { sdp: string } | null = null;
  ondatachannel: ((ev: { channel: DataChannelLike }) => void) | null = null;
  onicegatheringstatechange: (() => void) | null = null;
  onconnectionstatechange: (() => void) | null = null;
  channels: FakeChannel[] = [];
  remote: FakePc | null = null;
  closed = false;
  /** What `getStats()` answers (M13 T4), and whether it rejects instead. */
  stats: Record<string, unknown>[] = [];
  statsFail = false;
  private remoteOffer: string | null = null;
  /** Tests that exercise the 2 s gather fallback set this to false. */
  static autoGather = true;

  constructor(readonly config: RTCConfiguration) {
    fakePcs.set(this.id, this);
  }
  createDataChannel(label: string, init?: RTCDataChannelInit) {
    const ch = new FakeChannel(label, init);
    this.channels.push(ch);
    return ch;
  }
  async setLocalDescription() {
    this.localDescription = {
      sdp: this.remoteOffer ? `answer:${this.id}:${this.remoteOffer}` : `offer:${this.id}`,
    };
    if (FakePc.autoGather) this.finishGathering();
  }
  finishGathering() {
    this.iceGatheringState = 'complete';
    this.onicegatheringstatechange?.();
  }
  async setRemoteDescription(desc: { type: 'offer' | 'answer'; sdp: string }) {
    if (desc.type === 'offer') {
      this.remoteOffer = desc.sdp.split(':')[1] ?? null;
      return;
    }
    // The answer reaches the caller: wire both ends up.
    const answerer = fakePcs.get(desc.sdp.split(':')[1] ?? '');
    if (!answerer || answerer.closed || this.closed) return;
    this.remote = answerer;
    answerer.remote = this;
    for (const mine of this.channels) {
      const theirs = new FakeChannel(mine.label, mine.init);
      mine.other = theirs;
      theirs.other = mine;
      answerer.channels.push(theirs);
      answerer.ondatachannel?.({ channel: theirs });
    }
    queueMicrotask(() => {
      for (const pc of [this, answerer]) {
        pc.connectionState = 'connected';
        pc.onconnectionstatechange?.();
        for (const ch of pc.channels) ch.open();
      }
    });
  }
  async getStats() {
    if (this.statsFail) throw new Error('InvalidStateError');
    return new Map(this.stats.map((s) => [String(s.id), { ...s }]));
  }
  fail() {
    this.connectionState = 'failed';
    this.onconnectionstatechange?.();
  }
  close() {
    this.closed = true;
    this.connectionState = 'closed';
    for (const ch of this.channels) ch.readyState = 'closed';
    // The far side notices the close like a browser would.
    const far = this.remote;
    this.remote = null;
    if (far && !far.closed) {
      far.connectionState = 'closed';
      far.onconnectionstatechange?.();
    }
  }
}

/** Lets queued promise steps run (the mesh's offer and answer chains). */
export const settle = async () => {
  for (let i = 0; i < 40; i++) await Promise.resolve();
};
