import { runInDurableObject } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { genomeFromBase64url, genomeHash } from '../src/genome/codec';
import { type Beacon, randomnessOf } from '../src/ledger/drand';
import { encounterSeed } from '../src/ledger/encounter';
import { createIdentity, type Identity, memoryKeyStore, toBase64Url } from '../src/ledger/identity';
import { signMateAsk } from '../src/ledger/mating';
import {
  REQUEST_DOMAIN,
  type RecordRequest,
  recordHash,
  requestMessage,
} from '../src/ledger/record';
import { signSnap } from '../src/ledger/snapshot-sig';
import {
  encodeSnapshot,
  genomeRefOf,
  type HubMsg,
  type PondInfo,
  type SignedSnap,
  type Snapshot,
} from '../src/net/protocol';
import { RULES, RULES_VERSION, TICK_HZ } from '../src/sim/rules';
import type { Authority } from './authority';
import type { BeaconSource } from './beacons';
import { type Clock, Fights } from './fights';
import type { LifeState } from './life';
import type { Session } from './socket';
import {
  CALM,
  type Client,
  closeSockets,
  flush,
  freshNonce,
  genesisRequest,
  hatch,
  nextOf,
  report,
  rowsWritten,
  signIn,
  source,
  sql,
  stub,
  useFakeBeacons,
} from './test-hub';

// M7 T8: lock-in on the authority. A hand-moved clock drives the lock answer's window, frame 0's
// time and spawn protection (and `Date.now`, so everything agrees); no test waits on real time.

const E = RULES.encounter;

/** A clock that moves only when told, running the timers that fall due on the way. */
class HandClock implements Clock {
  private readonly timers = new Map<number, { at: number; run: () => void }>();
  private nextId = 1;
  constructor(public t: number) {}
  now(): number {
    return this.t;
  }
  after(ms: number, run: () => void): unknown {
    const id = this.nextId++;
    this.timers.set(id, { at: this.t + ms, run });
    return id;
  }
  cancel(handle: unknown): void {
    this.timers.delete(handle as number);
  }
  advance(ms: number): void {
    const end = this.t + ms;
    for (;;) {
      let due: [number, { at: number; run: () => void }] | null = null;
      for (const entry of this.timers) {
        if (entry[1].at <= end && (!due || entry[1].at < due[1].at)) due = entry;
      }
      if (!due) break;
      this.timers.delete(due[0]);
      this.t = due[1].at;
      due[1].run();
    }
    this.t = end;
  }
}

let clock: HandClock;
const authority = <T>(fn: (a: Authority) => T) =>
  runInDurableObject(stub(), (a) => fn(a as unknown as Authority));
/** Moves the hub's clock inside the object, so the timers it runs can reach its sockets. */
const advance = (ms: number) => authority(() => clock.advance(ms));

const setEnv = (on: boolean) =>
  authority((a) => {
    const e = a.env as unknown as Record<string, string | undefined>;
    e.DRAND_SOURCE = on ? 'fixture' : undefined;
    e.MATING_SCALE = on ? '0.01' : undefined;
  });

beforeEach(async () => {
  clock = new HandClock(Date.now());
  vi.spyOn(Date, 'now').mockImplementation(() => clock.t);
  await useFakeBeacons();
  await authority((a) => {
    a.clock = clock;
    // Each test starts with no locks (the object outlives a test, and its timers ran on the last clock).
    (a as { fights: Fights }).fights = new Fights(() => a.clock);
  });
  await sql('DELETE FROM matings');
});

afterEach(async () => {
  vi.restoreAllMocks();
  await setEnv(false);
  await closeSockets();
});

interface Player {
  c: Client;
  id: Identity;
  pond: PondInfo;
  creature: string;
  ref: number;
  ticks: number;
}

async function join(id?: Identity) {
  const { c, id: who } = await signIn(id);
  const { pond } = await nextOf(c, 'welcome');
  const life = await nextOf(c, 'life');
  return { c, id: who, pond, life };
}

/** A signed-in player with a freshly hatched creature (spawn-protected for 15 s). */
async function hatched(): Promise<Player> {
  const { c, id, pond } = await join();
  const g = await hatch(c, id);
  const genome = genomeFromBase64url(g.genome);
  if (!genome) throw new Error('genome does not decode');
  const ref = genomeRefOf(genomeHash(genome));
  return { c, id, pond, creature: recordHash(g.record.record), ref, ticks: 0 };
}

/** Two players whose hatch protection is over. */
async function pair(): Promise<[Player, Player]> {
  const a = await hatched();
  const b = await hatched();
  await advance(16_000);
  return [a, b];
}

const pondTick = (p: Player) => Math.floor(((clock.t - p.pond.epoch) * TICK_HZ) / 1000);

/** `p`'s own signed snapshot: at rest at (x, y) now, with the starter's size unless told otherwise. */
function snap(p: Player, x: number, y: number, over: Partial<Snapshot> = {}): SignedSnap {
  const s: Snapshot = {
    seq: 1,
    tick: pondTick(p),
    x,
    y,
    heading: 0,
    vx: 0,
    vy: 0,
    biomass: RULES.starter.biomass,
    energy: 0.5,
    health: 0.5,
    alive: true,
    dashing: false,
    ready: false,
    egg: false,
    spawnProtected: false,
    fighting: false,
    genomeRef: p.ref,
    ...over,
  };
  return signSnap(p.id, p.pond.id, encodeSnapshot(s));
}

const NEAR = { a: [1000, 1000], b: [1012, 1000] } as const;

function engage(a: Player, b: Player, theirs = snap(b, ...NEAR.b), mine = snap(a, ...NEAR.a)) {
  a.c.send({ t: 'engage', target: b.id.playerId, mine, theirs });
}

/** Engages and returns the refusal reason. */
async function refusal(a: Player, b: Player, theirs?: SignedSnap, mine?: SignedSnap) {
  engage(a, b, theirs, mine);
  return (await nextOf(a.c, 'refused')).reason;
}

/** Engages, lets the window close unanswered and returns what both players got. */
async function lockIn(a: Player, b: Player, theirs?: SignedSnap, mine?: SignedSnap) {
  engage(a, b, theirs, mine);
  await nextOf(b.c, 'lock-ask');
  await advance(E.lockAnswerMs);
  return Promise.all([nextOf(a.c, 'enc-start'), nextOf(b.c, 'enc-start')]);
}

/** Edits a player's session on the object (its pond, or its creature's condition). */
const editSession = (p: Player, edit: (s: Session & { phase: 'active' }) => Session) =>
  authority((a) => {
    for (const ws of a.ctx.getWebSockets()) {
      const s = ws.deserializeAttachment() as Session | null;
      if (s?.phase === 'active' && s.playerId === p.id.playerId) ws.serializeAttachment(edit(s));
    }
  });

const editLife = (p: Player, edit: Partial<LifeState>) =>
  editSession(p, (s) => ({ ...s, life: { ...(s.life as LifeState), ...edit } }));

/** How far the current can carry a body in `ticks`. */
const drift = (ticks: number) => (RULES.currents.maxSpeed * Math.abs(ticks)) / TICK_HZ + 0.01;

describe('engage', () => {
  it('locks both in with the target’s own state when it answers within the window', async () => {
    const [a, b] = await pair();
    const rows = await rowsWritten();
    const engagedAt = clock.t;
    engage(a, b);
    const ask = await nextOf(b.c, 'lock-ask');
    expect(ask.lock).toMatch(/^[0-9a-f]{32}$/);
    await advance(50);
    b.c.send({ t: 'lock-state', lock: ask.lock, mine: snap(b, 1013, 1001) });
    const [sa, sb] = await Promise.all([nextOf(a.c, 'enc-start'), nextOf(b.c, 'enc-start')]);
    expect(sa).toEqual(sb);
    expect(sa.at).toBe(engagedAt + 50 + E.startDelayMs);
    expect(sa.t0).toBe(Math.floor(((sa.at - a.pond.epoch) * TICK_HZ) / 1000));
    const ids = sa.fighters.map((f) => f.creature);
    expect(ids).toEqual([a.creature, b.creature].sort());
    const fb = sa.fighters.find((f) => f.player === b.id.playerId);
    const fa = sa.fighters.find((f) => f.player === a.id.playerId);
    // The target's answer, carried to frame 0 by the current alone (it was at rest).
    const ticks = sa.t0 - pondTick(b) + 1;
    expect(Math.abs((fb?.x ?? 0) - 1013)).toBeLessThanOrEqual(drift(ticks));
    expect(Math.abs((fb?.y ?? 0) - 1001)).toBeLessThanOrEqual(drift(ticks));
    expect(Math.abs((fa?.x ?? 0) - 1000)).toBeLessThanOrEqual(drift(ticks));
    expect(fa?.genome).toBeTruthy();
    expect(fa?.egg).toBe(false);
    expect(fa?.elder).toBe(false);
    expect(fa?.biomass).toBeCloseTo(RULES.starter.biomass, 1);
    expect(await rowsWritten()).toBe(rows);
  });

  it('uses the attacker’s copy when the target is silent, with frame 0 at most 300 ms after the engage', async () => {
    const [a, b] = await pair();
    const fetches = { n: 0 };
    const counting: BeaconSource = {
      now: () => source.now(),
      fetch: (round) => {
        fetches.n++;
        return source.fetch(round);
      },
    };
    await authority((o) => {
      (o as unknown as { source: BeaconSource }).source = counting;
    });
    const rows = await rowsWritten();
    const engagedAt = clock.t;
    const [sa, sb] = await lockIn(a, b, snap(b, 1012, 1003));
    expect(sa).toEqual(sb);
    expect(sa.at).toBe(engagedAt + E.lockAnswerMs + E.startDelayMs);
    expect(sa.at - engagedAt).toBeLessThanOrEqual(300);
    const fb = sa.fighters.find((f) => f.player === b.id.playerId);
    expect(Math.abs((fb?.y ?? 0) - 1003)).toBeLessThanOrEqual(drift(sa.t0 - pondTick(b) + 10));

    // The seed: the newest beacon the object held, and nothing fetched for it.
    const newest = await authority((o) => o.beacons.newestKnown());
    expect(newest).not.toBeNull();
    expect(sa.round).toBe((newest as Beacon).round);
    expect(sa.seed).toBe(encounterSeed(randomnessOf(newest as Beacon), sa.enc));
    expect(fetches.n).toBe(0);
    expect(await rowsWritten()).toBe(rows);
  });

  it('holds one timer per lock, and frees both at the timeout with no result (until T9)', async () => {
    const [a, b] = await pair();
    await lockIn(a, b);
    expect(await authority((o) => o.fights.timers())).toBe(1);
    expect(await authority((o) => o.fights.playerLocked(a.id.playerId))).toBe(true);
    await advance(E.startDelayMs + (E.timeoutFrames * E.frameTicks * 1000) / TICK_HZ);
    expect(await authority((o) => o.fights.timers())).toBe(0);
    expect(await authority((o) => o.fights.playerLocked(a.id.playerId))).toBe(false);
    expect(await authority((o) => o.fights.creatureLocked(b.creature))).toBe(false);
  });
});

describe('engage refusals', () => {
  it('signature: a flipped bit in the target’s snapshot signature', async () => {
    const [a, b] = await pair();
    const theirs = snap(b, ...NEAR.b);
    const flipped = theirs.sig.startsWith('A')
      ? `B${theirs.sig.slice(1)}`
      : `A${theirs.sig.slice(1)}`;
    expect(await refusal(a, b, { ...theirs, sig: flipped })).toBe('engage:signature');
  });

  it('signature: a snapshot signed for another pond', async () => {
    const [a, b] = await pair();
    const elsewhere = { ...b, pond: { ...b.pond, id: 'elsewhere' } };
    expect(await refusal(a, b, snap(elsewhere, ...NEAR.b))).toBe('engage:signature');
  });

  it('stale: a target snapshot older than the window', async () => {
    const [a, b] = await pair();
    const old = snap(b, ...NEAR.b, { tick: pondTick(b) - E.snapshotMaxAge - 4 });
    expect(await refusal(a, b, old)).toBe('engage:stale');
    // At the edge of the slack it is still fresh.
    const edge = snap(b, ...NEAR.b, { tick: pondTick(b) - E.snapshotMaxAge - 3 });
    engage(a, b, edge);
    await nextOf(b.c, 'lock-ask');
  });

  it('stale: a snapshot of another genome', async () => {
    const [a, b] = await pair();
    const other = snap(b, ...NEAR.b, { genomeRef: (b.ref + 1) & 0xffff });
    expect(await refusal(a, b, other)).toBe('engage:stale');
  });

  it('pond: the target sits in another pond', async () => {
    const [a, b] = await pair();
    await editSession(b, (s) => ({ ...s, pondId: 'another' }));
    expect(await refusal(a, b)).toBe('engage:pond');
  });

  it('target: the target is not here', async () => {
    const [a, b] = await pair();
    const stranger = await createIdentity(memoryKeyStore());
    const theirs = snap(b, ...NEAR.b);
    a.c.send({ t: 'engage', target: stranger.playerId, mine: snap(a, ...NEAR.a), theirs });
    expect((await nextOf(a.c, 'refused')).reason).toBe('engage:target');
  });

  it('self: the attacker names itself', async () => {
    const [a] = await pair();
    expect(await refusal(a, a, snap(a, ...NEAR.b))).toBe('engage:self');
  });

  it('tier: a gap of two size tiers', async () => {
    const [a, b] = await pair();
    // Tier 2 starts at a radius of 128 (biomass 16,384).
    await editLife(b, { biomass: 2_000_000, maxBiomass: 30_000 });
    const big = snap(b, 1150, 1000, { biomass: 20_000 });
    expect(await refusal(a, b, big)).toBe('engage:tier');
  });

  it('protected: a target hatched 10 s ago', async () => {
    const a = await hatched();
    await advance(6_000);
    const b = await hatched();
    await advance(10_000);
    expect(await refusal(a, b)).toBe('engage:protected');
  });

  it('locked: either side already in a fight', async () => {
    const [a, b] = await pair();
    await lockIn(a, b);
    expect(await refusal(a, b)).toBe('engage:locked');
    expect(await refusal(b, a, snap(a, ...NEAR.a), snap(b, ...NEAR.b))).toBe('engage:locked');
  });

  it('range: the target is out of reach', async () => {
    const [a, b] = await pair();
    expect(await refusal(a, b, snap(b, 1500, 1000))).toBe('engage:range');
  });
});

describe('spawn protection', () => {
  it('ends for the attacker when it engages', async () => {
    const a = await hatched();
    const b = await hatched();
    // Both are protected: b's engage ends b's own protection, and is refused by a's.
    expect(await refusal(b, a, snap(a, ...NEAR.a), snap(b, ...NEAR.b))).toBe('engage:protected');
    // a's engage, out of range, ends a's.
    expect(await refusal(a, b, snap(b, 1500, 1000))).toBe('engage:range');
    engage(b, a, snap(a, ...NEAR.a), snap(b, ...NEAR.b));
    await nextOf(a.c, 'lock-ask');
  });

  it('is never granted by a resume after a reload', async () => {
    const a = await hatched();
    const b = await hatched();
    // a reloads: the new tab resumes the creature, unprotected.
    const again = await join(a.id);
    expect(again.life.life?.creature).toBe(a.creature);
    const resumed = { ...a, c: again.c, pond: again.pond };
    await advance(1_000);
    engage(b, resumed, snap(resumed, ...NEAR.b), snap(b, ...NEAR.a));
    await nextOf(resumed.c, 'lock-ask');
  });
});

describe('start states', () => {
  it('clamps biomass past the growth curve, and flags growth-too-fast once', async () => {
    const [a, b] = await pair();
    await editLife(a, { maxBiomass: 100_000 });
    const greedy = () => snap(a, ...NEAR.a, { biomass: 400, energy: 0.1, health: 0.1 });
    const [start] = await lockIn(a, b, undefined, greedy());
    const fa = start.fighters.find((f) => f.player === a.id.playerId);
    // 16 s of growth from 100 wu reaches nowhere near 400.
    expect(fa?.biomass).toBeLessThan(200);
    expect(fa?.biomass).toBeGreaterThan(RULES.starter.biomass);
    // A second claim (refused, since both are locked) notes nothing new.
    expect(await refusal(a, b, undefined, greedy())).toBe('engage:locked');
    const flags = await authority((o) => o.ledger.flags(a.creature));
    expect(flags.map((f) => f.kind)).toEqual(['growth-too-fast']);
  });
});

describe('while locked', () => {
  const signed = (who: Identity, req: RecordRequest) =>
    toBase64Url(who.sign(REQUEST_DOMAIN, requestMessage(req)));

  it('refuses court, accept, mate-check, promote, restore and genesis with `locked`', async () => {
    await setEnv(true);
    const [a, b] = await pair();
    for (const p of [a, b]) {
      p.ticks += 16 * TICK_HZ;
      report(p.c, p.ticks, CALM);
      await nextOf(p.c, 'ack');
    }
    const ask = signMateAsk(a.id, {
      creature: a.creature,
      partner: b.id.playerId,
      partnerCreature: b.creature,
      nonce: freshNonce(),
    });
    a.c.send({ t: 'court', ask });
    await nextOf(b.c, 'invite');
    await lockIn(a, b);

    b.c.send({ t: 'mate-check', partner: a.id.playerId });
    expect((await nextOf(b.c, 'mate-info')).reason).toBe('locked');
    const answer = signMateAsk(b.id, {
      creature: b.creature,
      partner: a.id.playerId,
      partnerCreature: a.creature,
      nonce: ask.nonce,
    });
    b.c.send({ t: 'accept', ask: answer });
    expect((await nextOf(b.c, 'refused')).reason).toBe('locked');
    a.c.send({ t: 'court', ask: { ...ask } });
    expect((await nextOf(a.c, 'refused')).reason).toBe('locked');

    const promote: RecordRequest = {
      v: 1,
      rules: RULES_VERSION,
      kind: 'promote',
      creature: 'c'.repeat(64),
      seq: 1,
      prev: 'c'.repeat(64),
      owner: a.id.playerId,
      body: { role: 'child', parent: a.creature },
    };
    a.c.send({ t: 'promote', request: promote, sig: signed(a.id, promote) });
    expect((await nextOf(a.c, 'refused')).reason).toBe('locked');
    const restore: RecordRequest = {
      ...promote,
      kind: 'restore',
      body: {
        from: a.creature,
        activeMs: 0,
        biomass: 100,
        energy: 100,
        health: 100,
        cooldownUntilMs: 0,
      },
    };
    a.c.send({ t: 'restore', request: restore, sig: signed(a.id, restore) });
    expect((await nextOf(a.c, 'refused')).reason).toBe('locked');
    a.c.send(genesisRequest(a.id));
    expect((await nextOf(a.c, 'refused')).reason).toBe('locked');
    // Nothing else came of any of them.
    const rest: HubMsg[] = await flush(a.c);
    expect(rest.filter((m) => m.t === 'commit' || m.t === 'promoted')).toEqual([]);
  });
});
