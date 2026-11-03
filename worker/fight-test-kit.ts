import { runInDurableObject } from 'cloudflare:test';
import { afterEach, beforeEach, vi } from 'vitest';
import { genomeFromBase64url, genomeHash } from '../src/genome/codec';
import type { Identity } from '../src/ledger/identity';
import { recordHash } from '../src/ledger/record';
import { signSnap } from '../src/ledger/snapshot-sig';
import {
  encodeSnapshot,
  genomeRefOf,
  type PondInfo,
  type SignedSnap,
  type Snapshot,
} from '../src/net/protocol';
import { RULES, TICK_HZ } from '../src/sim/rules';
import type { Authority } from './authority';
import { type Clock, Fights } from './fights';
import type { LifeState } from './life';
import type { Session } from './socket';
import {
  type Client,
  closeSockets,
  hatch,
  nextOf,
  signIn,
  sql,
  stub,
  useFakeBeacons,
} from './test-hub';

// Shared by the fight hub tests (lock-in, the referee): a hand-moved clock drives the lock
// answer's window, frame 0's time, every frame's deadline and spawn protection (and `Date.now`,
// so everything agrees); no test waits on real time.

const E = RULES.encounter;

/** A clock that moves only when told, running the timers that fall due on the way. */
export class HandClock implements Clock {
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

export let clock: HandClock;
export const authority = <T>(fn: (a: Authority) => T) =>
  runInDurableObject(stub(), (a) => fn(a as unknown as Authority));
/** Moves the hub's clock inside the object, so the timers it runs can reach its sockets. */
export const advance = (ms: number) => authority(() => clock.advance(ms));

export const setEnv = (on: boolean) =>
  authority((a) => {
    const e = a.env as unknown as Record<string, string | undefined>;
    e.DRAND_SOURCE = on ? 'fixture' : undefined;
    e.MATING_SCALE = on ? '0.01' : undefined;
  });

/** The hooks of every fight hub test: a fresh hand clock (`Date.now` too), fake beacons and no locks. */
export function useFightHub(): void {
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
}

export interface Player {
  c: Client;
  id: Identity;
  pond: PondInfo;
  creature: string;
  ref: number;
  ticks: number;
}

export async function join(id?: Identity) {
  const { c, id: who } = await signIn(id);
  const { pond } = await nextOf(c, 'welcome');
  const life = await nextOf(c, 'life');
  return { c, id: who, pond, life };
}

/** A signed-in player with a freshly hatched creature (spawn-protected for 15 s). */
export async function hatched(): Promise<Player> {
  const { c, id, pond } = await join();
  const g = await hatch(c, id);
  const genome = genomeFromBase64url(g.genome);
  if (!genome) throw new Error('genome does not decode');
  const ref = genomeRefOf(genomeHash(genome));
  return { c, id, pond, creature: recordHash(g.record.record), ref, ticks: 0 };
}

/** Two players whose hatch protection is over. */
export async function pair(): Promise<[Player, Player]> {
  const a = await hatched();
  const b = await hatched();
  await advance(16_000);
  return [a, b];
}

export const pondTick = (p: Player) => Math.floor(((clock.t - p.pond.epoch) * TICK_HZ) / 1000);

/** `p`'s own signed snapshot: at rest at (x, y) now, with the starter's size unless told otherwise. */
export function snap(p: Player, x: number, y: number, over: Partial<Snapshot> = {}): SignedSnap {
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

export const NEAR = { a: [1000, 1000], b: [1012, 1000] } as const;

export function engage(
  a: Player,
  b: Player,
  theirs = snap(b, ...NEAR.b),
  mine = snap(a, ...NEAR.a),
) {
  a.c.send({ t: 'engage', target: b.id.playerId, mine, theirs });
}

/** Engages and returns the refusal reason. */
export async function refusal(a: Player, b: Player, theirs?: SignedSnap, mine?: SignedSnap) {
  engage(a, b, theirs, mine);
  return (await nextOf(a.c, 'refused')).reason;
}

/** Engages, lets the window close unanswered and returns what both players got. */
export async function lockIn(a: Player, b: Player, theirs?: SignedSnap, mine?: SignedSnap) {
  engage(a, b, theirs, mine);
  await nextOf(b.c, 'lock-ask');
  await advance(E.lockAnswerMs);
  return Promise.all([nextOf(a.c, 'enc-start'), nextOf(b.c, 'enc-start')]);
}

/** Edits a player's session on the object (its pond, or its creature's condition). */
export const editSession = (p: Player, edit: (s: Session & { phase: 'active' }) => Session) =>
  authority((a) => {
    for (const ws of a.ctx.getWebSockets()) {
      const s = ws.deserializeAttachment() as Session | null;
      if (s?.phase === 'active' && s.playerId === p.id.playerId) ws.serializeAttachment(edit(s));
    }
  });

export const editLife = (p: Player, edit: Partial<LifeState>) =>
  editSession(p, (s) => ({ ...s, life: { ...(s.life as LifeState), ...edit } }));

/** How far the current can carry a body in `ticks`. */
export const drift = (ticks: number) =>
  (RULES.currents.maxSpeed * Math.abs(ticks)) / TICK_HZ + 0.01;
