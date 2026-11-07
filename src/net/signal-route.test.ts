import { beforeAll, describe, expect, it } from 'vitest';
import { createIdentity, type Identity, memoryKeyStore } from '../ledger/identity';
import { signalSigned, signSignal } from '../ledger/seat';
import type { Heard } from './gossip';
import type { Pos } from './protocol';
import {
  RELAY_ANSWER_MS,
  RELAY_PER_S,
  RELAY_REPLAY_MS,
  RELAY_SKEW_MS,
  type RelayEvent,
  SignalRoute,
} from './signal-route';

// Relayed signaling (M11 T9, ADR 0062), one route alone with fake callbacks. The chain of real
// meshes is in `signal-chain.test.ts`.

const T = 1_700_000_000_000;
const C = 131_072;
let A: Identity;
let B: Identity;
let Cc: Identity;
let D: Identity;

beforeAll(async () => {
  const got = await Promise.all(
    [1, 2, 3, 4].map((n) => createIdentity(memoryKeyStore(new Uint8Array(32).fill(n)))),
  );
  [A, B, Cc, D] = got as [Identity, Identity, Identity, Identity];
});

const posOf = (n: number): Pos => [C + n, C, 10];

/** A relay from `from` to `to`, signed by `from`. */
function relay(
  from: Identity,
  to: Identity,
  kind: 'offer' | 'answer',
  at: number,
  sdp = 'v=0 fake',
): RelayEvent {
  const pos = posOf(1);
  return {
    t: 'relay',
    from: from.playerId,
    to: to.playerId,
    kind,
    sdp,
    at,
    pos,
    sig: signSignal(from, to.playerId, kind, at, pos, sdp),
  };
}

interface Rig {
  route: SignalRoute;
  clock: { now: number };
  linked: Set<string>;
  heard: Map<string, Heard[]>;
  places: Map<string, { x: number; y: number }>;
  peerSent: [via: string, m: RelayEvent][];
  hubSent: [to: string, kind: string, sdp: string][];
  delivered: [from: string, kind: string, sdp: string, pos: Pos | null][];
  /** Whether a peer send succeeds. */
  sendOk: boolean;
}

function rig(self: Identity, linked: Identity[] = []): Rig {
  const r = {
    clock: { now: T },
    linked: new Set(linked.map((i) => i.playerId)),
    heard: new Map(),
    places: new Map(),
    peerSent: [],
    hubSent: [],
    delivered: [],
    sendOk: true,
  } as unknown as Rig;
  r.route = new SignalRoute({
    selfId: self.playerId,
    now: () => r.clock.now,
    pos: () => posOf(0),
    sign: (to, kind, at, pos, sdp) => signSignal(self, to, kind, at, pos, sdp),
    verify: signalSigned,
    linked: (id) => r.linked.has(id),
    heard: (id) => r.heard.get(id) ?? [],
    placeOf: (id) => r.places.get(id) ?? null,
    sendPeer: (via, m) => {
      if (!r.sendOk) return false;
      r.peerSent.push([via, m]);
      return true;
    },
    sendHub: (to, kind, sdp) => r.hubSent.push([to, kind, sdp]),
    deliver: (from, kind, sdp, pos) => r.delivered.push([from, kind, sdp, pos]),
  });
  return r;
}

const fix = (x: number, at = T) => ({ x, y: C, r: 10, at });

describe('SignalRoute: the way out', () => {
  it('sends an offer through the linked peer nearest the target whose gossip placed it, else the hub', () => {
    const r = rig(A, [B, D]);
    r.places.set(B.playerId, { x: C + 4000, y: C });
    r.places.set(D.playerId, { x: C + 1000, y: C });
    r.heard.set(Cc.playerId, [
      { via: B.playerId, fix: fix(C + 5000) },
      { via: D.playerId, fix: fix(C + 5000) },
      { via: 'stranger'.padEnd(43, 'x'), fix: fix(C + 5000) }, // not linked
    ]);
    r.route.send(Cc.playerId, 'offer', 'sdp-1');
    expect(r.hubSent).toEqual([]);
    expect(r.peerSent).toHaveLength(1);
    const [via, m] = r.peerSent[0] as [string, RelayEvent];
    expect(via).toBe(B.playerId); // B is nearer C than D is
    expect(m).toMatchObject({ from: A.playerId, to: Cc.playerId, kind: 'offer', sdp: 'sdp-1' });
    expect(m.at).toBe(T);
    expect(m.pos).toEqual(posOf(0));
    expect(signalSigned(m)).toBe(true);
    // Nobody placed D's own id: the hub carries it.
    r.route.send(D.playerId, 'offer', 'sdp-2');
    expect(r.hubSent).toEqual([[D.playerId, 'offer', 'sdp-2']]);
    expect(r.route.stats()).toMatchObject({ relayed: 1, hub: 1 });
  });

  it('goes through the hub when the peer send fails', () => {
    const r = rig(A, [B]);
    r.heard.set(Cc.playerId, [{ via: B.playerId, fix: fix(C) }]);
    r.sendOk = false;
    r.route.send(Cc.playerId, 'offer', 'sdp');
    expect(r.hubSent).toEqual([[Cc.playerId, 'offer', 'sdp']]);
  });

  it('an offer unanswered after 4 s goes once more through the hub; an answered one does not', () => {
    const r = rig(A, [B]);
    r.heard.set(Cc.playerId, [{ via: B.playerId, fix: fix(C) }]);
    r.heard.set(D.playerId, [{ via: B.playerId, fix: fix(C) }]);
    r.route.send(Cc.playerId, 'offer', 'sdp-c');
    r.route.send(D.playerId, 'offer', 'sdp-d');
    r.clock.now = T + 100;
    r.route.fromPeer(B.playerId, relay(D, A, 'answer', T + 100));
    r.clock.now = T + RELAY_ANSWER_MS - 1;
    r.route.tick();
    expect(r.hubSent).toEqual([]);
    r.clock.now = T + RELAY_ANSWER_MS;
    r.route.tick();
    r.clock.now = T + 3 * RELAY_ANSWER_MS;
    r.route.tick();
    expect(r.hubSent).toEqual([[Cc.playerId, 'offer', 'sdp-c']]);
    expect(r.route.stats().fallback).toBe(1);
  });

  it('sends the answer back the way the offer came', () => {
    const r = rig(Cc, [B]);
    r.route.fromPeer(B.playerId, relay(A, Cc, 'offer', T, 'offer-a'));
    expect(r.delivered).toEqual([[A.playerId, 'offer', 'offer-a', posOf(1)]]);
    r.route.send(A.playerId, 'answer', 'answer-c');
    expect(r.peerSent.map(([via, m]) => [via, m.to, m.kind, m.sdp])).toEqual([
      [B.playerId, A.playerId, 'answer', 'answer-c'],
    ]);
    // An offer from the hub is answered through the hub.
    r.route.fromHub(D.playerId, 'offer', 'offer-d', [C, C, 12]);
    expect(r.delivered[1]).toEqual([D.playerId, 'offer', 'offer-d', [C, C, 12]]);
    r.route.send(D.playerId, 'answer', 'answer-d');
    expect(r.hubSent).toEqual([[D.playerId, 'answer', 'answer-d']]);
    // The relay's link closed meanwhile: the hub carries the answer.
    r.route.fromPeer(B.playerId, relay(A, Cc, 'offer', T + 1, 'offer-a2'));
    r.linked.delete(B.playerId);
    r.route.send(A.playerId, 'answer', 'answer-c2');
    expect(r.hubSent.at(-1)).toEqual([A.playerId, 'answer', 'answer-c2']);
  });
});

describe('SignalRoute: an inbound relay', () => {
  it('drops a forged relay: another sdp, pos, kind, to or signer', () => {
    const r = rig(Cc, [B]);
    const good = relay(A, Cc, 'offer', T);
    const forged: RelayEvent[] = [
      { ...good, sdp: `${good.sdp} ` },
      { ...good, pos: [C + 2, C, 10] },
      { ...good, kind: 'answer' },
      { ...good, from: D.playerId },
      { ...good, at: T + 1 },
      { ...good, sig: relay(D, Cc, 'offer', T).sig },
    ];
    for (const [i, m] of forged.entries()) {
      r.clock.now = T + i * 1000; // past the rate limit
      r.route.fromPeer(B.playerId, m);
    }
    expect(r.delivered).toEqual([]);
    expect(r.route.stats().forged).toBe(forged.length);
    // A forged copy does not burn the genuine one's (from, at).
    r.clock.now = T + 10_000;
    r.route.fromPeer(B.playerId, good);
    expect(r.delivered).toHaveLength(1);
  });

  it('drops a replay seen in the last 2 minutes, and an `at` more than 30 s off', () => {
    const r = rig(Cc, [B]);
    const m = relay(A, Cc, 'offer', T);
    r.route.fromPeer(B.playerId, m);
    r.clock.now = T + 2000;
    r.route.fromPeer(B.playerId, m);
    expect(r.delivered).toHaveLength(1);
    expect(r.route.stats().replayed).toBe(1);
    r.route.fromPeer(B.playerId, relay(A, Cc, 'offer', T + 2000 + RELAY_SKEW_MS + 1)); // ahead
    r.clock.now = T + RELAY_SKEW_MS;
    r.route.fromPeer(B.playerId, relay(A, Cc, 'offer', T - 1)); // behind
    expect(r.route.stats().stale).toBe(2);
    r.route.fromPeer(B.playerId, relay(A, Cc, 'offer', T + 1000));
    expect(r.delivered).toHaveLength(2);
    // A replay is remembered for 2 minutes, well past the skew a fresh one may have.
    expect(RELAY_REPLAY_MS).toBeGreaterThan(2 * RELAY_SKEW_MS);
  });

  it("charges replays and stale relays to the link's second, so a flood is throttled", () => {
    const r = rig(Cc, [B]);
    const m = relay(A, Cc, 'offer', T);
    for (let i = 0; i < RELAY_PER_S + 3; i++) r.route.fromPeer(B.playerId, m);
    expect(r.delivered).toHaveLength(1);
    expect(r.route.stats()).toMatchObject({ replayed: RELAY_PER_S - 1, limited: 3 });
  });

  it('keeps an offer and an answer from one sender in the same millisecond apart', () => {
    const r = rig(Cc, [B]);
    r.route.fromPeer(B.playerId, relay(A, Cc, 'offer', T));
    r.route.fromPeer(B.playerId, relay(A, Cc, 'answer', T));
    expect(r.delivered).toHaveLength(2);
  });

  it('drops a relay to this page from itself', () => {
    const r = rig(A, [B]);
    r.route.fromPeer(B.playerId, relay(A, A, 'offer', T));
    expect(r.delivered).toEqual([]);
    expect(r.route.stats().stray).toBe(1);
  });
});

describe('SignalRoute: forwarding', () => {
  it('forwards a relay unchanged to a linked `to`, at most 4 a second per link', () => {
    const r = rig(B, [A, Cc]);
    const sent = Array.from({ length: RELAY_PER_S + 1 }, (_, i) => relay(A, Cc, 'offer', T + i));
    for (const m of sent) r.route.fromPeer(A.playerId, m);
    expect(r.peerSent).toEqual(sent.slice(0, RELAY_PER_S).map((m) => [Cc.playerId, m]));
    expect(r.route.stats()).toMatchObject({ forwarded: RELAY_PER_S, limited: 1 });
    r.clock.now = T + 999;
    r.route.fromPeer(A.playerId, relay(A, Cc, 'offer', T + 999));
    expect(r.route.stats().limited).toBe(2);
    r.clock.now = T + 1000;
    r.route.fromPeer(A.playerId, relay(A, Cc, 'offer', T + 1000));
    expect(r.route.stats().forwarded).toBe(RELAY_PER_S + 1);
    expect(r.delivered).toEqual([]);
  });

  it('caps what one link may send a second, whoever it is for', () => {
    const r = rig(B, [A, Cc, D]);
    for (let i = 0; i < 3; i++) r.route.fromPeer(A.playerId, relay(A, Cc, 'offer', T + i));
    for (let i = 0; i < 3; i++) r.route.fromPeer(A.playerId, relay(A, D, 'offer', T + 10 + i));
    expect(r.route.stats()).toMatchObject({ forwarded: RELAY_PER_S, limited: 2 });
  });

  it('drops and counts a relay to a peer it does not hold, or one its link did not sign', () => {
    const r = rig(B, [A]);
    r.route.fromPeer(A.playerId, relay(A, Cc, 'offer', T));
    r.linked.add(Cc.playerId);
    r.route.fromPeer(A.playerId, relay(D, Cc, 'offer', T)); // A passing on D's signal
    expect(r.peerSent).toEqual([]);
    expect(r.route.stats().stray).toBe(2);
  });
});
