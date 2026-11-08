import { runInDurableObject } from 'cloudflare:test';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { afterEach, beforeEach, expect, vi } from 'vitest';
import { genomeFromBase64url, genomeHash } from '../src/genome/codec';
import type { Identity } from '../src/ledger/identity';
import { recordHash } from '../src/ledger/record';
import { signSnap } from '../src/ledger/snapshot-sig';
import { encounterStartOf } from '../src/net/encounter-start';
import {
  encodeSnapshot,
  type FighterInfo,
  genomeRefOf,
  type HubMsg,
  type SignedSnap,
  type Snapshot,
  type WorldInfo,
} from '../src/net/protocol';
import { FRAME_MS } from '../src/net/referee';
import { createEncounter } from '../src/sim/encounter/encounter';
import { engageRange, strikeDistance, strikeReach } from '../src/sim/encounter/reach';
import { RULES, TICK_HZ } from '../src/sim/rules';
import { drive, IDLE_CODE } from '../tests/encounter-fixture';
import type { Authority } from './authority';
import { type Clock, Fights, runFight } from './fights';
import type { LifeState } from './life';
import { keep, type Session } from './socket';
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
    // The world's clock starts with the hand clock, as a pond's epoch did before ponds took the
    // world's (M11): the object outlives a test, and an earlier one moved the clock past it.
    await sql('UPDATE world SET clock = ?', clock.t);
    // ... and no open fight log: recovery (the alarm runs it) would rebuild an earlier test's fight.
    await sql('UPDATE encounters SET open = 0 WHERE open = 1');
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
  pond: WorldInfo;
  creature: string;
  ref: number;
  ticks: number;
}

export async function join(id?: Identity) {
  const { c, id: who } = await signIn(id);
  const { world: pond } = await nextOf(c, 'welcome');
  const life = await nextOf(c, 'life');
  return { c, id: who, pond, life };
}

/**
 * Credits the identity `playMs` of play (20 minutes by default, past the young window, ADR 0059),
 * so it fights at worth 1: one finished creature of its own whose active time that is, replaced
 * on each call. The identity is marked told of the world's epoch, as it would be: no renewal follows.
 */
export const seasoned = async (
  p: Pick<Player, 'id'>,
  playMs = RULES.encounter.farming.youngPlayMs,
) => {
  await sql(
    `INSERT OR REPLACE INTO creatures
       (id, owner, status, seq, hash, genome, active_ms, biomass, energy, health, born_t, died_t)
     VALUES (?, ?, 'dead', 0, '', '', ?, 0, 0, 0, 0, 0)`,
    bytesToHex(sha256(new TextEncoder().encode(`played|${p.id.playerId}`))),
    p.id.playerId,
    playMs,
  );
  await sql(
    'UPDATE players SET epoch_seen = (SELECT epoch FROM world) WHERE id = ?',
    p.id.playerId,
  );
};

/** A player whose creature is newly hatched on a fresh socket; its `spawn` (`spawned`) protects it for 15 s. */
export async function rehatch(p: Pick<Player, 'c' | 'id' | 'pond'>): Promise<Player> {
  const g = await hatch(p.c, p.id);
  const genome = genomeFromBase64url(g.genome);
  if (!genome) throw new Error('genome does not decode');
  const ref = genomeRefOf(genomeHash(genome));
  return { ...p, creature: recordHash(g.record.record), ref, ticks: 0 };
}

/**
 * A signed-in player with a freshly hatched creature, not in the water yet. Its identity has
 * played past the young window, so the M7 fight tests' rewards hold (worth 1).
 */
export async function hatched(): Promise<Player> {
  const { c, id, pond } = await join();
  const p = await rehatch({ c, id, pond });
  await seasoned(p);
  return p;
}

/** The creature enters the water: the hub's `spawn` answer (M12 T4), which starts a genesis's protection. */
export async function spawned(p: Pick<Player, 'c'>) {
  p.c.send({ t: 'spawn', r: 10, aoi: 233 });
  return nextOf(p.c, 'spawn');
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

/** The spawn centre: every hub test stages its fights there, where the water is twilight. */
export const CENTRE = RULES.world.size / 2;
export const NEAR = { a: [CENTRE, CENTRE], b: [CENTRE + 12, CENTRE] } as const;
/** The away tests' staging spot (a fight 1,104 wu east and 1,096 wu north of the centre). */
export const STAGE = { x: CENTRE + 1104, y: CENTRE - 1096 } as const;

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

/**
 * B answers A's `lock-ask` in time with its own state, as a client that has A on its screen does:
 * `seen` holds A's snapshots (by default one at `NEAR.a` now); `[]` sends an empty list and `null`
 * none at all (ADR 0062: either is refused `engage:unseen`).
 */
export async function answer(
  a: Player,
  b: Player,
  opts: { mine?: SignedSnap; seen?: SignedSnap[] | null } = {},
) {
  const ask = await nextOf(b.c, 'lock-ask');
  expect(ask.by).toBe(a.id.playerId);
  const seen = opts.seen === undefined ? [snap(a, ...NEAR.a)] : opts.seen;
  b.c.send({
    t: 'lock-state',
    lock: ask.lock,
    mine: opts.mine ?? snap(b, ...NEAR.b),
    ...(seen ? { seen } : {}),
  });
  return ask;
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
      if (s?.phase === 'active' && s.playerId === p.id.playerId) keep(a, ws, edit(s));
    }
  });

export const editLife = (p: Player, edit: Partial<LifeState>) =>
  editSession(p, (s) => ({ ...s, life: { ...(s.life as LifeState), ...edit } }));

/** How far the current can carry a body in `ticks`. */
export const drift = (ticks: number) =>
  (RULES.currents.maxSpeed * Math.abs(ticks)) / TICK_HZ + 0.01;

export type EncStart = Extract<HubMsg, { t: 'enc-start' }>;
export type EncFrame = Extract<HubMsg, { t: 'enc-frame' }>;
export type EncEnd = Extract<HubMsg, { t: 'enc-end' }>;

/** A player's input for frame `f`: a code, or null to stay silent. */
export type Plan = (f: number, start: EncStart) => [number | null, number | null];

export interface Played {
  /** Each player's bundles, in the order they arrived. */
  frames: [EncFrame[], EncFrame[]];
  ends: [EncEnd, EncEnd] | null;
}

/** `promise`, or a failure naming `what` if it takes more than 3 s of real time. */
export async function within<T>(promise: Promise<T>, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out waiting for ${what}`)), 3000);
  });
  try {
    return await Promise.race([promise, late]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export const locked = (p: Player) => authority((o) => o.fights.playerLocked(p.id.playerId));
const held = (p: Player) =>
  authority((o) => o.fights.ofPlayer(p.id.playerId)?.fight?.referee.held() ?? 0);

/** Moves the hub's clock forward to `t` (never back). */
export const advanceTo = (t: number) => advance(Math.max(0, t - clock.t));

/** Waits (by polling the object) until the referee holds `n` frames of inputs. */
async function holding(p: Player, n: number): Promise<void> {
  for (let i = 0; i < 200; i++) if ((await held(p)) >= n) return;
  throw new Error(`the referee never held ${n} frames of inputs`);
}

/**
 * Plays the fight frame by frame for at most `frames` frames: each player sends what `plan` says
 * one frame ahead of the frame's start; a frame with a silent player waits for its deadline.
 */
export async function play(
  a: Player,
  b: Player,
  start: EncStart,
  plan: Plan,
  frames = E.timeoutFrames,
  from = 0,
): Promise<Played> {
  const seen: Played = { frames: [[], []], ends: null };
  const startOf = (f: number) => start.at + f * FRAME_MS;
  for (let f = from; f < from + frames; f++) {
    await advanceTo(startOf(f) - FRAME_MS);
    const codes = plan(f, start);
    [a, b].forEach((p, k) => {
      const code = codes[k];
      if (code !== null && code !== undefined) p.c.send({ t: 'input', enc: start.enc, f, i: code });
    });
    const sent = codes.filter((c) => c !== null).length;
    if (sent < 2) {
      if (sent === 1) await holding(a, 1);
      await advanceTo(startOf(f) + E.inputDeadlineMs + 1);
    }
    const [fa, fb] = await within(
      Promise.all([nextOf(a.c, 'enc-frame'), nextOf(b.c, 'enc-frame')]),
      `frame ${f}`,
    );
    seen.frames[0].push(fa);
    seen.frames[1].push(fb);
    if (!(await locked(a))) {
      seen.ends = await within(
        Promise.all([nextOf(a.c, 'enc-end'), nextOf(b.c, 'enc-end')]),
        `enc-end after frame ${f}`,
      );
      return seen;
    }
  }
  return seen;
}

export const slotOf = (start: EncStart, p: Player) =>
  start.fighters.findIndex((f) => f.player === p.id.playerId);

/** `p`'s outcome in `end`. */
export function outcomeOf(end: EncEnd, p: Player) {
  const found = end.fighters.find((f) => f.player === p.id.playerId);
  if (!found) throw new Error(`no outcome for ${p.id.playerId}`);
  return found;
}

/** The player's life state on the object. */
export const lifeOn = (p: Player) =>
  authority((o) => {
    for (const ws of o.ctx.getWebSockets()) {
      const s = ws.deserializeAttachment() as Session | null;
      if (s?.phase === 'active' && s.playerId === p.id.playerId) return s.life as LifeState;
    }
    return undefined;
  });

export const hundredths = (f: { biomass: number; energy: number; health: number }) => ({
  biomass: Math.floor(f.biomass * 100),
  energy: Math.floor(f.energy * 100),
  health: Math.floor(f.health * 100),
});

/**
 * An `enc-start` for these fighters in A's pond, frame 0 `startDelayMs` from now, with its own id.
 * The fighters go in creature-id order, as lock-in sends them and the encounter seats them, so
 * `slotOf` names their slots.
 */
export function startOf(a: Player, fighters: FighterInfo[]): EncStart {
  const at = clock.t + E.startDelayMs;
  return {
    t: 'enc-start',
    // Its own id: the object (and its saved fight logs) outlives a test.
    enc: bytesToHex(crypto.getRandomValues(new Uint8Array(32))),
    seed: '5'.repeat(64),
    round: 0,
    t0: Math.floor(((at - a.pond.epoch) * TICK_HZ) / 1000),
    at,
    fighters: [...fighters].sort((x, y) => (x.creature < y.creature ? -1 : 1)),
  };
}

/** Runs the fight of `msg` on the object directly (lock-in is tested in `engage.test.ts`); both get its `enc-start`. */
export async function startFight(a: Player, b: Player, msg: EncStart): Promise<EncStart> {
  const lives = await Promise.all([a, b].map((p) => lifeOn(p)));
  await authority((o) => {
    const lock = o.fights.open(
      msg.enc,
      [a.id.playerId, b.id.playerId],
      [a.creature, b.creature],
      0,
      () => {},
    );
    expect(
      runFight(
        o,
        lock,
        msg,
        a.pond,
        lives.filter((l) => l !== undefined),
      ),
    ).toBe(true);
    for (const ws of o.ctx.getWebSockets()) {
      const s = ws.deserializeAttachment() as Session | null;
      if (s?.phase === 'active') ws.send(JSON.stringify(msg));
    }
  });
  await Promise.all([nextOf(a.c, 'enc-start'), nextOf(b.c, 'enc-start')]);
  return msg;
}

/** A player's genome text, as the ledger holds it. */
export const genomeOf = (p: Player) => authority((o) => o.ledger.head(p.creature)?.genome ?? '');

/**
 * A fight started on the object directly: two bodies of A's genome, idle and in full health, B
 * east of A with 1.5 x the strike reach between them, so neither can strike nor escape. Both get
 * its `enc-start`.
 */
export async function outOfReach(a: Player, b: Player): Promise<EncStart> {
  const genome = await genomeOf(a);
  const base = { vx: 0, vy: 0, heading: 0, elder: false, egg: false, worth: 1, genome, y: STAGE.y };
  const vitals = { biomass: RULES.starter.biomass, energy: 150, health: 100 };
  const fighters: FighterInfo[] = [a, b].map((p, k) => ({
    ...base,
    ...vitals,
    player: p.id.playerId,
    creature: p.creature,
    x: STAGE.x + 100 * k,
  }));
  const msg = startOf(a, fighters);
  // Moves B in until 1.5 x the reach is left between them (both bodies are alike).
  const probe = (x: number) => {
    const start = encounterStartOf(
      { ...msg, fighters: fighters.map((f) => (f.player === b.id.playerId ? { ...f, x } : f)) },
      a.pond.seed,
    );
    if (!start) throw new Error('no start');
    const [fa, fb] = createEncounter(start).fighters;
    if (!fa || !fb) throw new Error('no fighters');
    const gap =
      fa.player === a.id.playerId
        ? strikeDistance(fa.body, fb.body)
        : strikeDistance(fb.body, fa.body);
    return { gap, reach: strikeReach(fa), away: 2 * engageRange(fa, fb) };
  };
  let x = STAGE.x + 100;
  while (x > STAGE.x && probe(x - 0.5).gap >= 1.5 * probe(x).reach) x -= 0.5;
  const { gap, reach, away } = probe(x);
  expect(gap).toBeGreaterThan(1.4 * reach);
  expect(gap).toBeLessThan(away * 0.9);
  for (const f of fighters) if (f.player === b.id.playerId) f.x = x;
  return startFight(a, b, msg);
}

/**
 * A locks B in at 1 hp (unless `start` is given); A then swims at it with its weapon aimed while B
 * idles, until B dies.
 */
export async function killB(
  a: Player,
  b: Player,
  start?: EncStart,
): Promise<{ start: EncStart; end: EncEnd }> {
  const begun =
    start ??
    (
      await lockIn(a, b, snap(b, ...NEAR.b, { health: 0.01 }), snap(a, ...NEAR.a, { health: 1 }))
    )[0];
  const target = slotOf(begun, b);
  const hunt: Plan = () => [drive(0, 15, { stance: 'aggressive', target }), IDLE_CODE];
  const played = await play(a, b, begun, hunt);
  const [end] = played.ends as [EncEnd, EncEnd];
  expect(outcomeOf(end, b)).toMatchObject({ outcome: 'killed', by: slotOf(begun, a) });
  return { start: begun, end };
}

/** Rows written outside the fight log (`fight-store.ts`), which its own tests bound. */
export const rowsBesideLog = () =>
  authority((o) => o.ledger.rowsWritten - o.fightStore.rowsWritten);

/** The fight's saved log, as the object reads it back. */
export const logRow = (enc: string) => authority((o) => o.fightStore.read(enc));

/** A pond seed with no UV, pressure or plume at `NEAR` or at the fights' staging spots (`STAGE`), and a current that shears little. Pick another with a search if a bathymetry change breaks this. */
export const CALM_SEED = 'calm-1';

/**
 * Seeds the pond of `ps` (players of one pond) `timeout`: no UV or pressure at `NEAR`, and a current
 * that shears little (the seed of T1's timeout test). A random seed puts pressure at `NEAR` in about
 * 1 pond in 100, which kills a fighter at 1 hp before it is struck.
 */
export async function calmPond(...ps: Pick<Player, 'pond'>[]): Promise<void> {
  const [first] = ps;
  if (!first) return;
  await sql('UPDATE ponds SET seed = ? WHERE id = ?', CALM_SEED, first.pond.id);
  for (const p of ps) p.pond = { ...p.pond, seed: CALM_SEED };
}

/** Two players whose hatch protection is over, in the calm pond (`calmPond`). */
export async function fighters(): Promise<[Player, Player]> {
  const [a, b] = await pair();
  await calmPond(a, b);
  return [a, b];
}
