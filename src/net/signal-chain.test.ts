import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createIdentity, type Identity, memoryKeyStore } from '../ledger/identity';
import { authorityKeyId, authorityPublicKey, type PubKey } from '../ledger/record';
import { SEAT_TTL_MS, seatValid, signalSigned, signSeat, signSignal } from '../ledger/seat';
import { type Fix, Gossip } from './gossip';
import { PeerMesh } from './peer-mesh';
import type { Pos, SignalKind } from './protocol';
import { FakePc, fakePcs, settle } from './rtc-test-kit';
import { RELAY_ANSWER_MS, type RelayEvent, SignalRoute } from './signal-route';

// A link made through a peer both sides hold (M11 T9, ADR 0062): with A–B and B–C linked, A learns
// of C from B's gossip, and A–C opens with its offer and answer relayed by B, signed end to end.

const T = 1_700_000_000_000;
const WORLD = 'w0rldSeed_123456';
const CENTRE = 131_072;
const secret = new Uint8Array(32).fill(7);
const keys: PubKey[] = [
  { id: authorityKeyId(authorityPublicKey(secret)), publicKey: authorityPublicKey(secret) },
];

interface Page {
  id: string;
  identity: Identity;
  mesh: PeerMesh;
  gossip: Gossip;
  route: SignalRoute;
  pos: Pos;
  /** This page's newest snapshot of each peer, as its snapshots would set them. */
  fixes: Map<string, Fix>;
  /** Changes a relay this page passes on (a dishonest middle peer). */
  tamper: ((m: RelayEvent) => RelayEvent) | null;
}

interface HubSignal {
  from: string;
  to: string;
  kind: SignalKind;
}

let ids: Identity[] = [];

beforeEach(async () => {
  vi.useFakeTimers();
  vi.setSystemTime(T);
  fakePcs.clear();
  FakePc.autoGather = true;
  ids = await Promise.all(
    [1, 2, 3].map((n) => createIdentity(memoryKeyStore(new Uint8Array(32).fill(n)))),
  );
});
afterEach(() => {
  vi.useRealTimers();
});

function world() {
  const pages = new Map<string, Page>();
  const hub: HubSignal[] = [];
  const make = (identity: Identity, x: number): Page => {
    const id = identity.playerId;
    const ticket = signSeat(secret, {
      v: 1,
      kind: 'seat',
      player: id,
      name: `P${x < 0 ? 'west' : x > 0 ? 'east' : 'mid'}`,
      world: WORLD,
      t: T,
      until: T + SEAT_TTL_MS,
    });
    const page = { id, identity, pos: [CENTRE + x, CENTRE, 10], fixes: new Map() } as Page;
    page.tamper = null;
    page.gossip = new Gossip(id);
    page.mesh = new PeerMesh({
      selfId: id,
      signal: (to, kind, sdp) => void page.route.send(to, kind, sdp, 2),
      createPeerConnection: (config) => new FakePc(config),
      hello: {
        ticket: () => ticket,
        check: (peer, t) => seatValid(t, keys, { world: WORLD, player: peer, now: Date.now() }),
      },
    });
    page.route = new SignalRoute({
      selfId: id,
      now: () => Date.now(),
      pos: () => page.pos,
      sign: (to, kind, cls, at, pos, sdp) => signSignal(identity, to, kind, cls, at, pos, sdp),
      verify: signalSigned,
      linked: (peer) => page.mesh.isOpen(peer),
      heard: (peer) => page.gossip.heard(peer, Date.now()),
      placeOf: (peer) => page.fixes.get(peer) ?? null,
      sendPeer: (via, m) =>
        page.mesh.sendEvent(via, page.tamper && m.from !== id ? page.tamper(m) : m),
      sendHub: (to, kind, sdp) => {
        hub.push({ from: id, to, kind });
        pages.get(to)?.route.fromHub(id, kind, sdp);
      },
      deliver: (from, kind, sdp) => {
        if (kind !== 'refuse') void page.mesh.handleSignal(from, kind, sdp);
      },
    });
    page.mesh.onEvent((from, e) => {
      if (e.t === 'relay') page.route.fromPeer(from, e);
      else if (e.t === 'peers') page.gossip.receive(from, e, Date.now());
    });
    pages.set(id, page);
    return page;
  };
  const a = make(ids[0] as Identity, -5000);
  const b = make(ids[1] as Identity, 0);
  const c = make(ids[2] as Identity, 5000);
  /** Every page's snapshots of its linked peers, fresh now. */
  const see = () => {
    for (const p of pages.values()) {
      for (const other of pages.values()) {
        if (p !== other && p.mesh.isOpen(other.id)) {
          const [x, y, r] = other.pos;
          p.fixes.set(other.id, { x, y, r, at: Date.now() });
        }
      }
    }
  };
  /** Each page sends the gossip due now. */
  const gossip = () => {
    for (const p of pages.values()) {
      for (const [to, e] of p.gossip.due(p.mesh.peers(), p.fixes, Date.now())) {
        p.mesh.sendEvent(to, e);
      }
    }
  };
  const settleAll = async () => {
    for (let i = 0; i < 5; i++) await settle();
  };
  const between = (x: Page, y: Page) =>
    hub.filter((s) => (s.from === x.id && s.to === y.id) || (s.from === y.id && s.to === x.id));
  return { a, b, c, hub, see, gossip, settleAll, between };
}

describe('relayed signaling through a peer both sides hold', () => {
  async function linkedChain() {
    const w = world();
    w.a.mesh.connect(w.b.id);
    w.b.mesh.connect(w.c.id);
    await w.settleAll();
    expect(w.a.mesh.isOpen(w.b.id)).toBe(true);
    expect(w.b.mesh.isOpen(w.c.id)).toBe(true);
    expect(w.a.mesh.isOpen(w.c.id)).toBe(false);
    w.see();
    w.gossip();
    // A learns of C from B's gossip.
    expect(w.a.gossip.known(Date.now()).map((k) => k.id)).toEqual([w.c.id]);
    expect(w.a.gossip.heard(w.c.id, Date.now()).map((h) => h.via)).toEqual([w.b.id]);
    return w;
  }

  it('A’s offer to C goes through B, C answers through B, and A–C opens with no hub signal', async () => {
    const w = await linkedChain();
    w.a.mesh.connect(w.c.id);
    await w.settleAll();
    expect(w.a.mesh.isOpen(w.c.id)).toBe(true);
    expect(w.c.mesh.isOpen(w.a.id)).toBe(true);
    expect(w.c.mesh.ticketOf(w.a.id)?.seat.player).toBe(w.a.id);
    expect(w.between(w.a, w.c)).toEqual([]);
    expect(w.a.route.stats()).toMatchObject({ relayed: 2, forged: 0 });
    expect(w.c.route.stats()).toMatchObject({ relayed: 2, forged: 0 });
    expect(w.b.route.stats().forwarded).toBe(2);
    // Nothing falls back once answered.
    await vi.advanceTimersByTimeAsync(RELAY_ANSWER_MS);
    w.a.route.tick();
    expect(w.between(w.a, w.c)).toEqual([]);
  });

  for (const [what, tamper] of [
    ['the SDP', (m: RelayEvent): RelayEvent => ({ ...m, sdp: `${m.sdp}x` })],
    ['the pos', (m: RelayEvent): RelayEvent => ({ ...m, pos: [m.pos[0] + 1, m.pos[1], m.pos[2]] })],
  ] as const) {
    it(`B changing ${what} makes C drop the relay as forged, and A goes through the hub after 4 s`, async () => {
      const w = await linkedChain();
      w.b.tamper = tamper;
      w.a.mesh.connect(w.c.id);
      await w.settleAll();
      expect(w.c.route.stats().forged).toBe(1);
      expect(w.a.mesh.isOpen(w.c.id)).toBe(false);
      expect(w.between(w.a, w.c)).toEqual([]);
      await vi.advanceTimersByTimeAsync(RELAY_ANSWER_MS - 1);
      w.a.route.tick();
      expect(w.between(w.a, w.c)).toEqual([]);
      await vi.advanceTimersByTimeAsync(1);
      w.a.route.tick();
      await w.settleAll();
      expect(w.between(w.a, w.c)).toEqual([
        { from: w.a.id, to: w.c.id, kind: 'offer' },
        { from: w.c.id, to: w.a.id, kind: 'answer' },
      ]);
      expect(w.a.mesh.isOpen(w.c.id)).toBe(true);
      expect(w.c.mesh.isOpen(w.a.id)).toBe(true);
      expect(w.a.route.stats().fallback).toBe(1);
    });
  }
});
