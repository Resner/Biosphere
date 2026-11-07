import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createIdentity, memoryKeyStore } from '../ledger/identity';
import { authorityKeyId, authorityPublicKey, type PubKey } from '../ledger/record';
import { SEAT_TTL_MS, type SignedSeat, seatValid, signSeat } from '../ledger/seat';
import { HELLO_MS, PeerMesh } from './peer-mesh';
import { encodeSnapshot, type PeerEvent, type Snapshot } from './protocol';
import { FakePc, fakePcs, settle } from './rtc-test-kit';

// The hello gate (M11 T9, ADR 0062): each link's first event, each way, is the sender's seat
// ticket, and nothing else from a peer is delivered until its ticket holds for it.

const T = 1_700_000_000_000;
const WORLD = 'w0rldSeed_123456';
const secret = new Uint8Array(32).fill(7);
const keys: PubKey[] = [
  { id: authorityKeyId(authorityPublicKey(secret)), publicKey: authorityPublicKey(secret) },
];
const ticketFor = (player: string, name = 'Swimmer'): SignedSeat =>
  signSeat(secret, {
    v: 1,
    kind: 'seat',
    player,
    name,
    world: WORLD,
    t: T,
    until: T + SEAT_TTL_MS,
  });

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
  spawnProtected: false,
  fighting: false,
  genomeRef: 0x1234,
};

let A = '';
let B = '';
let Cid = '';

beforeEach(async () => {
  vi.useFakeTimers();
  vi.setSystemTime(T);
  fakePcs.clear();
  FakePc.autoGather = true;
  const got = await Promise.all(
    [1, 2, 3].map(
      async (n) => (await createIdentity(memoryKeyStore(new Uint8Array(32).fill(n)))).playerId,
    ),
  );
  [A, B, Cid] = got as [string, string, string];
});
afterEach(() => {
  vi.useRealTimers();
});

interface Page {
  mesh: PeerMesh;
  ticket: SignedSeat | null;
  joined: string[];
  left: string[];
  states: Snapshot[];
  events: PeerEvent[];
  pcs: FakePc[];
  offers: number;
}

/** Two gated pages; `ticket` is each one's own ticket (null: it has none to show). */
function pair(tickets: { a?: SignedSeat | null; b?: SignedSeat | null } = {}) {
  const pages = new Map<string, Page>();
  const make = (self: string, ticket: SignedSeat | null) => {
    const page: Page = {
      ticket,
      joined: [],
      left: [],
      states: [],
      events: [],
      pcs: [],
      offers: 0,
      mesh: new PeerMesh({
        selfId: self,
        signal: (to, kind, sdp) => {
          if (kind === 'offer') page.offers += 1;
          void pages.get(to)?.mesh.handleSignal(self, kind, sdp);
        },
        createPeerConnection: (config) => {
          const pc = new FakePc(config);
          page.pcs.push(pc);
          return pc;
        },
        hello: {
          ticket: () => page.ticket,
          check: (peer, t) => seatValid(t, keys, { world: WORLD, player: peer, now: Date.now() }),
        },
      }),
    };
    page.mesh.onPeerJoined((id) => page.joined.push(id));
    page.mesh.onPeerLeft((id) => page.left.push(id));
    page.mesh.onState((_, s) => page.states.push(s));
    page.mesh.onEvent((_, e) => page.events.push(e));
    pages.set(self, page);
    return page;
  };
  const a = make(A, tickets.a === undefined ? ticketFor(A, 'Alice') : tickets.a);
  const b = make(B, tickets.b === undefined ? ticketFor(B, 'Bob') : tickets.b);
  return { a, b };
}

const firstEvent = (pc: FakePc | undefined) =>
  JSON.parse(String(pc?.channels.find((c) => c.label === 'event')?.sent[0])) as PeerEvent;

describe('PeerMesh hello gate', () => {
  it('opens a link once both hellos pass: each side’s first event is its ticket', async () => {
    const { a, b } = pair();
    a.mesh.connect(B);
    await settle();
    expect(a.joined).toEqual([B]);
    expect(b.joined).toEqual([A]);
    expect(firstEvent(a.pcs[0])).toEqual({ t: 'hello', ticket: a.ticket, n: 0 });
    expect(firstEvent(b.pcs[0])).toEqual({ t: 'hello', ticket: b.ticket, n: 0 });
    expect(a.mesh.ticketOf(B)?.seat.name).toBe('Bob');
    expect(b.mesh.ticketOf(A)?.seat.name).toBe('Alice');
    // The hellos are the mesh's own: listeners never see them.
    expect(a.events).toEqual([]);
    expect(a.mesh.sendState(B, encodeSnapshot(SNAP))).toBe(true);
    expect(a.mesh.sendEvent(B, { t: 'chat', text: 'hi' })).toBe(true);
    expect(b.states).toHaveLength(1);
    expect(b.events).toEqual([{ t: 'chat', text: 'hi' }]);
    expect(a.mesh.stats().helloFailed).toBe(0);
  });

  it('closes a link with no hello within 5 s and counts it; its side never calls again', async () => {
    const { a, b } = pair({ b: null });
    a.mesh.connect(B);
    await settle();
    expect(b.joined).toEqual([A]); // a's ticket holds for b
    expect(a.joined).toEqual([]);
    expect(a.mesh.isOpen(B)).toBe(false);
    expect(a.mesh.peers()).toEqual([B]);
    await vi.advanceTimersByTimeAsync(HELLO_MS - 1);
    expect(a.mesh.peers()).toEqual([B]);
    await vi.advanceTimersByTimeAsync(1);
    expect(a.mesh.peers()).toEqual([]);
    expect(a.mesh.stats().helloFailed).toBe(1);
    expect(a.left).toEqual([]); // it never joined
    await settle();
    expect(b.left).toEqual([A]);
    await vi.advanceTimersByTimeAsync(600_000);
    expect(a.offers).toBe(1);
    expect(a.joined).toEqual([]);
  });

  it('delivers no snapshot before the hello, and delivers them after it', async () => {
    const { a, b } = pair({ b: null });
    a.mesh.connect(B);
    await settle();
    expect(b.mesh.sendState(A, encodeSnapshot(SNAP))).toBe(true);
    expect(a.states).toEqual([]);
    expect(a.mesh.stats().dropped).toBe(1);
    // b's hello comes late but in time.
    expect(b.mesh.sendEvent(A, { t: 'hello', ticket: ticketFor(B), n: 0 })).toBe(true);
    expect(a.joined).toEqual([B]);
    expect(b.mesh.sendState(A, encodeSnapshot(SNAP))).toBe(true);
    expect(a.states).toHaveLength(1);
    // A second hello is not the listeners' either.
    b.mesh.sendEvent(A, { t: 'hello', ticket: ticketFor(B), n: 0 });
    expect(a.events).toEqual([]);
    await vi.advanceTimersByTimeAsync(HELLO_MS * 2);
    expect(a.mesh.isOpen(B)).toBe(true);
    expect(a.mesh.stats().helloFailed).toBe(0);
  });

  it('fails a ticket naming another player, and a first event that is not a hello', async () => {
    const firsts: PeerEvent[] = [
      { t: 'hello', ticket: ticketFor(Cid), n: 0 },
      { t: 'chat', text: 'hi' },
    ];
    for (const first of firsts) {
      const { a, b } = pair({ b: null });
      a.mesh.connect(B);
      await settle();
      b.mesh.sendEvent(A, first);
      expect(a.mesh.peers(), first.t).toEqual([]);
      expect(a.joined).toEqual([]);
      expect(a.events).toEqual([]);
      expect(a.mesh.stats().helloFailed).toBe(1);
      b.mesh.close();
    }
  });

  it('a ticket that expired by the time it is checked fails', async () => {
    const { a, b } = pair({ b: null });
    a.mesh.connect(B);
    await settle();
    vi.setSystemTime(T + SEAT_TTL_MS);
    b.mesh.sendEvent(A, { t: 'hello', ticket: ticketFor(B), n: 0 });
    expect(a.mesh.peers()).toEqual([]);
    expect(a.mesh.stats().helloFailed).toBe(1);
  });
});
