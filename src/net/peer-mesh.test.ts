import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CONNECT_TIMEOUT_MS,
  type DataChannelLike,
  GATHER_TIMEOUT_MS,
  type PeerConnectionLike,
  PeerMesh,
  RECOVERY_MAX_ATTEMPTS,
  RETRY_DELAY_MS,
} from './peer-mesh';
import { EVENT_MAX_BYTES, encodeSnapshot, SNAPSHOT_BYTES, type Snapshot } from './protocol';

const SNAP: Snapshot = {
  seq: 7,
  tick: 90,
  x: 100,
  y: 200,
  heading: 1,
  vx: 10,
  vy: -10,
  biomass: 5,
  energy: 0.5,
  health: 1,
  alive: true,
  dashing: false,
  ready: false,
  egg: false,
  genomeRef: 0x1234,
};

class FakeChannel implements DataChannelLike {
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
const registry = new Map<string, FakePc>();

/** A browser-less RTCPeerConnection: offers carry the caller's id, answers link the pair. */
class FakePc implements PeerConnectionLike {
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
  private remoteOffer: string | null = null;
  /** Tests that exercise the 2 s gather fallback set this to false. */
  static autoGather = true;

  constructor(readonly config: RTCConfiguration) {
    registry.set(this.id, this);
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
    const answerer = registry.get(desc.sdp.split(':')[1] ?? '');
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

interface Net {
  meshes: Map<string, PeerMesh>;
  signals: { from: string; to: string; kind: string; sdp: string }[];
  pcs: FakePc[];
  /** Delivers queued signals until none are left. */
  flush(): Promise<void>;
  hold: boolean;
  held: { from: string; to: string; kind: 'offer' | 'answer'; sdp: string }[];
}

function network(ids: string[]): Net {
  const net: Net = {
    meshes: new Map(),
    signals: [],
    pcs: [],
    hold: false,
    held: [],
    flush: async () => {},
  };
  const deliver = (m: { from: string; to: string; kind: 'offer' | 'answer'; sdp: string }) =>
    net.meshes.get(m.to)?.handleSignal(m.from, m.kind, m.sdp);
  for (const id of ids) {
    net.meshes.set(
      id,
      new PeerMesh({
        selfId: id,
        signal: (to, kind, sdp) => {
          const m = { from: id, to, kind, sdp };
          net.signals.push(m);
          if (net.hold) net.held.push(m);
          else void deliver(m);
        },
        createPeerConnection: (config) => {
          const pc = new FakePc(config);
          net.pcs.push(pc);
          return pc;
        },
      }),
    );
  }
  // Releases held signals in send order; replies stay held until the next round.
  net.flush = async () => {
    for (let i = 0; i < 20; i++) await Promise.resolve();
    for (let round = 0; round < 4 && net.held.length > 0; round++) {
      const held = net.held.splice(0);
      for (const m of held) await deliver(m);
      for (let i = 0; i < 20; i++) await Promise.resolve();
    }
    net.hold = false;
  };
  return net;
}

const settle = async () => {
  for (let i = 0; i < 40; i++) await Promise.resolve();
};

beforeEach(() => {
  vi.useFakeTimers();
  registry.clear();
  FakePc.autoGather = true;
});
afterEach(() => {
  vi.useRealTimers();
});

describe('PeerMesh negotiation', () => {
  for (const [caller, callee] of [
    ['a', 'b'],
    ['b', 'a'],
  ] as const) {
    it(`connects when ${caller} calls ${callee}, with exactly two signals`, async () => {
      const net = network(['a', 'b']);
      const joined: string[] = [];
      net.meshes.get('a')?.onPeerJoined((id) => joined.push(`a:${id}`));
      net.meshes.get('b')?.onPeerJoined((id) => joined.push(`b:${id}`));
      net.meshes.get(caller)?.connect(callee);
      await settle();
      expect(net.signals.map((s) => s.kind)).toEqual(['offer', 'answer']);
      expect(joined.sort()).toEqual(['a:b', 'b:a']);
      expect(net.meshes.get('a')?.stats().open).toBe(1);
    });
  }

  it('opens an unordered lossy state channel and an ordered reliable event channel', async () => {
    const net = network(['a', 'b']);
    net.meshes.get('a')?.connect('b');
    await settle();
    const caller = net.pcs[0];
    const state = caller?.channels.find((c) => c.label === 'state');
    const event = caller?.channels.find((c) => c.label === 'event');
    expect(state?.init).toEqual({ ordered: false, maxRetransmits: 0 });
    expect(event?.init).toEqual({ ordered: true });
    expect(state?.binaryType).toBe('arraybuffer');
  });

  it('resolves simultaneous offers to one connection; the higher id yields', async () => {
    const net = network(['a', 'b']);
    net.hold = true;
    net.meshes.get('a')?.connect('b');
    net.meshes.get('b')?.connect('a');
    await settle();
    expect(net.held.map((m) => m.kind)).toEqual(['offer', 'offer']);
    await net.flush();
    await settle();
    expect(net.signals.filter((s) => s.kind === 'offer')).toHaveLength(2);
    expect(net.signals.filter((s) => s.kind === 'answer')).toHaveLength(1);
    expect(net.signals.find((s) => s.kind === 'answer')?.from).toBe('b');
    expect(net.meshes.get('a')?.stats().open).toBe(1);
    expect(net.meshes.get('b')?.stats().open).toBe(1);
    // b's own pc was replaced; only the winning pair is live.
    const live = net.pcs.filter((p) => !p.closed);
    expect(live).toHaveLength(2);
  });

  it('sends the offer after 2 s when ICE gathering never completes', async () => {
    FakePc.autoGather = false;
    const net = network(['a', 'b']);
    net.meshes.get('a')?.connect('b');
    await settle();
    expect(net.signals).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(GATHER_TIMEOUT_MS - 1);
    expect(net.signals).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(2);
    expect(net.signals.map((s) => s.kind)).toContain('offer');
  });

  it('sends the offer as soon as gathering completes', async () => {
    FakePc.autoGather = false;
    const net = network(['a', 'b']);
    net.meshes.get('a')?.connect('b');
    await settle();
    net.pcs[0]?.finishGathering();
    await settle();
    expect(net.signals.map((s) => s.kind)).toEqual(['offer']);
  });

  it('passes the ICE servers to every connection', async () => {
    const seen: RTCConfiguration[] = [];
    const mesh = new PeerMesh({
      selfId: 'a',
      signal: () => {},
      iceServers: [{ urls: 'stun:example.invalid' }],
      createPeerConnection: (config) => {
        seen.push(config);
        return new FakePc(config);
      },
    });
    mesh.connect('b');
    await settle();
    expect(seen[0]?.iceServers).toEqual([{ urls: 'stun:example.invalid' }]);
  });

  it('uses the newest ICE servers for connections made after setIce', async () => {
    const seen: RTCConfiguration[] = [];
    const mesh = new PeerMesh({
      selfId: 'a',
      signal: () => {},
      iceServers: [{ urls: 'stun:old.invalid' }],
      createPeerConnection: (config) => {
        seen.push(config);
        return new FakePc(config);
      },
    });
    mesh.connect('b');
    mesh.setIce([{ urls: 'turn:new.invalid', username: 'u', credential: 'c' }]);
    mesh.connect('c');
    await settle();
    expect(seen[0]?.iceServers).toEqual([{ urls: 'stun:old.invalid' }]);
    expect(seen[1]?.iceServers).toEqual([
      { urls: 'turn:new.invalid', username: 'u', credential: 'c' },
    ]);
  });
});

describe('PeerMesh timeouts and loss', () => {
  it('closes a connection that is not up in 12 s, retries once after 3 s, then drops it', async () => {
    const net = network(['a', 'b']);
    net.meshes.get('b')?.disconnect('a');
    net.hold = true; // the answer never arrives
    net.meshes.get('a')?.connect('b');
    await settle();
    expect(net.pcs).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(CONNECT_TIMEOUT_MS);
    expect(net.pcs[0]?.closed).toBe(true);
    expect(net.meshes.get('a')?.peers()).toEqual([]);
    await vi.advanceTimersByTimeAsync(RETRY_DELAY_MS);
    expect(net.pcs).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(CONNECT_TIMEOUT_MS);
    expect(net.pcs[1]?.closed).toBe(true);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(net.pcs).toHaveLength(2);
    expect(net.meshes.get('a')?.peers()).toEqual([]);
  });

  it('connects again after the roster changes (an explicit connect resets the retry)', async () => {
    const net = network(['a', 'b']);
    net.hold = true;
    net.meshes.get('a')?.connect('b');
    await vi.advanceTimersByTimeAsync(CONNECT_TIMEOUT_MS + RETRY_DELAY_MS + CONNECT_TIMEOUT_MS);
    expect(net.meshes.get('a')?.peers()).toEqual([]);
    net.hold = false;
    net.meshes.get('a')?.connect('b');
    await settle();
    expect(net.meshes.get('a')?.isOpen('b')).toBe(true);
  });

  it('emits peer-left once when a connection fails or closes', async () => {
    const net = network(['a', 'b']);
    const left: string[] = [];
    net.meshes.get('a')?.onPeerLeft((id) => left.push(id));
    net.meshes.get('a')?.connect('b');
    await settle();
    net.pcs[0]?.fail();
    net.pcs[0]?.fail();
    net.pcs[0]?.close();
    expect(left).toEqual(['b']);
    expect(net.meshes.get('a')?.isOpen('b')).toBe(false);
  });

  it('emits peer-left on the far side when one side closes', async () => {
    const net = network(['a', 'b']);
    const left: string[] = [];
    net.meshes.get('b')?.onPeerLeft((id) => left.push(id));
    net.meshes.get('a')?.connect('b');
    await settle();
    net.meshes.get('a')?.disconnect('b');
    expect(left).toEqual(['a']);
  });

  it('drops a send on a closed channel without throwing', async () => {
    const net = network(['a', 'b']);
    net.meshes.get('a')?.connect('b');
    await settle();
    const mesh = net.meshes.get('a');
    mesh?.disconnect('b');
    expect(mesh?.sendState('b', encodeSnapshot(SNAP))).toBe(false);
    expect(mesh?.sendEvent('b', { t: 'emote', id: 1 })).toBe(false);
    expect(mesh?.sendState('nobody', encodeSnapshot(SNAP))).toBe(false);
  });

  it('a reload of the far side (a fresh offer) replaces the old connection', async () => {
    const net = network(['a', 'b']);
    const left: string[] = [];
    net.meshes.get('b')?.onPeerLeft((id) => left.push(id));
    net.meshes.get('a')?.connect('b');
    await settle();
    const fresh = new PeerMesh({
      selfId: 'a',
      signal: (to, kind, sdp) => void net.meshes.get(to)?.handleSignal('a', kind, sdp),
      createPeerConnection: (config) => {
        const pc = new FakePc(config);
        net.pcs.push(pc);
        return pc;
      },
    });
    net.meshes.set('a', fresh);
    fresh.connect('b');
    await settle();
    expect(left).toEqual(['a']);
    expect(net.meshes.get('b')?.isOpen('a')).toBe(true);
  });
});

describe('PeerMesh recovery of a dropped link', () => {
  it('re-establishes an open link that dropped: the lower id calls, both come back without a reload', async () => {
    const net = network(['a', 'b']);
    const joined: string[] = [];
    const left: string[] = [];
    for (const [id, mesh] of net.meshes) {
      mesh.onPeerJoined((p) => joined.push(`${id}+${p}`));
      mesh.onPeerLeft((p) => left.push(`${id}-${p}`));
    }
    net.meshes.get('b')?.connect('a'); // b joined later and called a
    await settle();
    expect(net.meshes.get('a')?.isOpen('b')).toBe(true);
    net.pcs[0]?.fail();
    await settle();
    expect(left.sort()).toEqual(['a-b', 'b-a']);
    expect(net.meshes.get('a')?.isOpen('b')).toBe(false);
    await vi.advanceTimersByTimeAsync(RETRY_DELAY_MS);
    await settle();
    expect(net.meshes.get('a')?.isOpen('b')).toBe(true);
    expect(net.meshes.get('b')?.isOpen('a')).toBe(true);
    expect(net.signals.filter((m) => m.kind === 'offer').map((m) => m.from)).toEqual(['b', 'a']);
    expect(joined.sort()).toEqual(['a+b', 'a+b', 'b+a', 'b+a']);
  });

  it('leaves the call to the lower id: the higher id waits and sends no offer', async () => {
    const net = network(['a', 'b']);
    net.meshes.get('a')?.connect('b');
    await settle();
    const offers = () => net.signals.filter((m) => m.kind === 'offer').length;
    expect(offers()).toBe(1);
    net.meshes.get('b')?.disconnect('a'); // b drops the link; only a's side may call again
    await vi.advanceTimersByTimeAsync(RETRY_DELAY_MS * 4);
    await settle();
    expect(net.signals.filter((m) => m.kind === 'offer' && m.from === 'b')).toHaveLength(0);
    expect(net.meshes.get('b')?.isOpen('a')).toBe(true);
  });

  it('backs off between attempts and gives up after the limit', async () => {
    const net = network(['a', 'b']);
    net.meshes.get('a')?.connect('b');
    await settle();
    net.hold = true; // no answer reaches a from now on
    net.pcs[0]?.fail();
    const gaps: number[] = [];
    let seen = net.pcs.length;
    let last = 0;
    for (let t = 0; t < 600_000; t += 500) {
      await vi.advanceTimersByTimeAsync(500);
      if (net.pcs.length > seen) {
        gaps.push(t + 500 - last);
        seen = net.pcs.length;
        last = t + 500;
      }
    }
    expect(net.pcs).toHaveLength(2 + RECOVERY_MAX_ATTEMPTS); // the first pair, then one call per attempt
    // The wait before an attempt doubles each time (3 s, 6 s, ...) on top of the 12 s timeout.
    const waits = gaps.map((g, i) => g - (i === 0 ? 0 : CONNECT_TIMEOUT_MS));
    expect(waits[0]).toBeGreaterThanOrEqual(RETRY_DELAY_MS);
    expect(waits[0]).toBeLessThan(RETRY_DELAY_MS + 1000);
    expect(waits[1]).toBeGreaterThanOrEqual(RETRY_DELAY_MS * 2);
    expect(net.meshes.get('a')?.peers()).toEqual([]);
  });

  it('stops retrying when the peer leaves the roster', async () => {
    const net = network(['a', 'b']);
    net.meshes.get('a')?.connect('b');
    await settle();
    net.pcs[0]?.fail();
    net.meshes.get('a')?.disconnect('b');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(net.pcs).toHaveLength(2); // only the first pair, no new call
  });

  it('starts over with a fresh budget after a recovered link drops again', async () => {
    const net = network(['a', 'b']);
    net.meshes.get('a')?.connect('b');
    await settle();
    for (let i = 0; i < RECOVERY_MAX_ATTEMPTS + 2; i++) {
      net.pcs[net.pcs.length - 1]?.fail();
      await vi.advanceTimersByTimeAsync(RETRY_DELAY_MS);
      await settle();
      expect(net.meshes.get('a')?.isOpen('b')).toBe(true);
    }
  });
});

describe('PeerMesh inbound hygiene', () => {
  async function pair() {
    const net = network(['a', 'b']);
    net.meshes.get('a')?.connect('b');
    await settle();
    const a = net.meshes.get('a') as PeerMesh;
    const b = net.meshes.get('b') as PeerMesh;
    const rx = { states: [] as Snapshot[], events: [] as unknown[] };
    b.onState((_, s) => rx.states.push(s));
    b.onEvent((_, e) => rx.events.push(e));
    const raw = (label: 'state' | 'event', data: unknown) => {
      const ch = net.pcs[0]?.channels.find((c) => c.label === label)?.other;
      ch?.onmessage?.({ data });
    };
    // Messages arrive at b, which is the callee: its channels are the `other` ends.
    const toB = (label: 'state' | 'event', data: unknown) => {
      const ch = net.pcs[1]?.channels.find((c) => c.label === label);
      ch?.onmessage?.({ data });
    };
    return { a, b, rx, raw, toB };
  }

  it('delivers snapshots and events across the channels', async () => {
    const { a, rx, b } = await pair();
    expect(a.sendState('b', encodeSnapshot(SNAP))).toBe(true);
    expect(a.sendEvent('b', { t: 'chat', text: 'hi' })).toBe(true);
    expect(rx.states).toHaveLength(1);
    expect(rx.states[0]?.seq).toBe(7);
    expect(rx.events).toEqual([{ t: 'chat', text: 'hi' }]);
    expect(b.stats().dropped).toBe(0);
  });

  it('a throwing listener neither stops the others nor escapes the channel handler', async () => {
    const { a, b } = await pair();
    const seen: string[] = [];
    b.onState(() => {
      throw new Error('boom');
    });
    b.onState(() => seen.push('state'));
    b.onEvent(() => {
      throw new Error('boom');
    });
    b.onEvent(() => seen.push('event'));
    expect(() => {
      a.sendState('b', encodeSnapshot(SNAP));
      a.sendEvent('b', { t: 'chat', text: 'hi' });
    }).not.toThrow();
    expect(seen).toEqual(['state', 'event']);
  });

  it('counts malformed, oversized and misrouted messages and never delivers them', async () => {
    const { b, rx, toB } = await pair();
    toB('event', 'not json');
    toB('event', JSON.stringify({ t: 'chat', text: 'x'.repeat(EVENT_MAX_BYTES) }));
    toB('event', JSON.stringify({ t: 'nope' }));
    toB('event', new Uint8Array(SNAPSHOT_BYTES).buffer);
    toB('state', new Uint8Array(SNAPSHOT_BYTES - 1).buffer);
    toB('state', new Uint8Array(SNAPSHOT_BYTES + 1).buffer);
    toB('state', 'text on the state channel');
    const bad = new Uint8Array(SNAPSHOT_BYTES);
    bad[11] = 0xff; // unknown flag bits
    toB('state', bad.buffer);
    expect(b.stats().dropped).toBe(8);
    expect(rx.states).toHaveLength(0);
    expect(rx.events).toHaveLength(0);
  });

  it('does not send an event over 2 KB', async () => {
    const { a } = await pair();
    expect(a.sendEvent('b', { t: 'chat', text: 'x'.repeat(EVENT_MAX_BYTES) })).toBe(false);
  });
});

describe('PeerMesh in a full pond', () => {
  const ids = Array.from({ length: 24 }, (_, i) => `p${String(i).padStart(2, '0')}`);

  it('connects 24 peers pairwise, reaches all with a snapshot round, and drops one link per peer on a leave', async () => {
    const net = network(ids);
    const meshes = ids.map((id) => net.meshes.get(id) as PeerMesh);
    const heard = new Map<string, Set<string>>(ids.map((id) => [id, new Set()]));
    const left = new Map<string, string[]>(ids.map((id) => [id, []]));
    for (const [i, mesh] of meshes.entries()) {
      const self = ids[i] as string;
      mesh.onState((from) => heard.get(self)?.add(from));
      mesh.onPeerLeft((id) => left.get(self)?.push(id));
    }
    // The roster tells everyone about the others; each side dials the peers listed after it.
    for (const [i, mesh] of meshes.entries()) {
      for (const other of ids.slice(i + 1)) mesh.connect(other);
    }
    await settle();
    for (const mesh of meshes) expect(mesh.stats().open).toBe(23);

    for (const [i, mesh] of meshes.entries()) {
      for (const other of ids) if (other !== ids[i]) mesh.sendState(other, encodeSnapshot(SNAP));
    }
    for (const id of ids) expect(heard.get(id)?.size).toBe(23);

    // The last peer leaves: everyone else loses exactly that one connection.
    const leaver = ids[23] as string;
    net.meshes.get(leaver)?.close();
    await settle();
    for (const id of ids.slice(0, 23)) {
      expect(net.meshes.get(id)?.stats().open).toBe(22);
      expect(left.get(id)).toEqual([leaver]);
    }
  });
});
