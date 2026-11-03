import { describe, expect, it } from 'vitest';
import { signMateAsk } from '../src/ledger/mating';
import { encounterStartOf } from '../src/net/encounter-start';
import { CLOSE_RATE_LIMITED, type FighterInfo, type HubMsg } from '../src/net/protocol';
import { FRAME_MS } from '../src/net/referee';
import { createEncounter } from '../src/sim/encounter/encounter';
import { engageRange, strikeDistance, strikeReach } from '../src/sim/encounter/reach';
import { replayEncounter } from '../src/sim/encounter/replay';
import { RULES, RULES_VERSION, TICK_HZ } from '../src/sim/rules';
import { drive, IDLE_CODE } from '../tests/encounter-fixture';
import { heavyTest } from '../tests/heavy';
import {
  advance,
  authority,
  clock,
  editLife,
  hatched,
  lockIn,
  NEAR,
  type Player,
  pair,
  setEnv,
  snap,
  useFightHub,
} from './fight-test-kit';
import { runFight } from './fights';
import type { LifeState } from './life';
import type { Session } from './socket';
import {
  CALM,
  type Client,
  flush,
  freshNonce,
  nextOf,
  report,
  rowsWritten,
  signIn,
  sql,
} from './test-hub';

// M7 T9: the referee's frame clock on the authority, driven by the hand-moved clock of
// `fight-test-kit.ts`: deadlines, the fallback marker, bundles, the end and life while locked.

const E = RULES.encounter;

useFightHub();

type EncStart = Extract<HubMsg, { t: 'enc-start' }>;
type EncFrame = Extract<HubMsg, { t: 'enc-frame' }>;
type EncEnd = Extract<HubMsg, { t: 'enc-end' }>;

/** A player's input for frame `f`: a code, or null to stay silent. */
type Plan = (f: number, start: EncStart) => [number | null, number | null];

interface Played {
  /** Each player's bundles, in the order they arrived. */
  frames: [EncFrame[], EncFrame[]];
  ends: [EncEnd, EncEnd] | null;
}

/** `promise`, or a failure naming `what` if it takes more than 3 s of real time. */
async function within<T>(promise: Promise<T>, what: string): Promise<T> {
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

const locked = (p: Player) => authority((o) => o.fights.playerLocked(p.id.playerId));
const held = (p: Player) =>
  authority((o) => o.fights.ofPlayer(p.id.playerId)?.fight?.referee.held() ?? 0);

/** Moves the hub's clock forward to `t` (never back). */
const advanceTo = (t: number) => advance(Math.max(0, t - clock.t));

/** Waits (by polling the object) until the referee holds `n` frames of inputs. */
async function holding(p: Player, n: number): Promise<void> {
  for (let i = 0; i < 200; i++) if ((await held(p)) >= n) return;
  throw new Error(`the referee never held ${n} frames of inputs`);
}

/**
 * Plays the fight frame by frame for at most `frames` frames: each player sends what `plan` says
 * one frame ahead of the frame's start; a frame with a silent player waits for its deadline.
 */
async function play(
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

/** The fight replayed from its start and bundles, as every client steps it. */
function replay(a: Player, start: EncStart, frames: EncFrame[]) {
  const encStart = encounterStartOf(start, a.pond.seed);
  if (!encStart) throw new Error('no start');
  return replayEncounter({ rules: RULES_VERSION, start: encStart, frames: frames.map((b) => b.i) });
}

/** The fight's outcomes, sorted: who escaped depends on whose range the other left first (T1). */
const outcomes = (played: Played) => played.ends?.[0].fighters.map((f) => f.outcome).sort();

const slotOf = (start: EncStart, p: Player) =>
  start.fighters.findIndex((f) => f.player === p.id.playerId);

/** `p`'s outcome in `end`. */
function outcomeOf(end: EncEnd, p: Player) {
  const found = end.fighters.find((f) => f.player === p.id.playerId);
  if (!found) throw new Error(`no outcome for ${p.id.playerId}`);
  return found;
}

/** The player's life state on the object. */
const lifeOn = (p: Player) =>
  authority((o) => {
    for (const ws of o.ctx.getWebSockets()) {
      const s = ws.deserializeAttachment() as Session | null;
      if (s?.phase === 'active' && s.playerId === p.id.playerId) return s.life as LifeState;
    }
    return undefined;
  });

/** Counts every message a client receives from now on. */
function counter(c: Client): { n: number } {
  const count = { n: 0 };
  c.ws.addEventListener('message', () => {
    count.n++;
  });
  return count;
}

const hundredths = (f: { biomass: number; energy: number; health: number }) => ({
  biomass: Math.floor(f.biomass * 100),
  energy: Math.floor(f.energy * 100),
  health: Math.floor(f.health * 100),
});

/** The condition a life state holds. */
const conditionOf = (l: LifeState | undefined) => ({
  biomass: l?.biomass,
  energy: l?.energy,
  health: l?.health,
});

const IDLE: Plan = () => [IDLE_CODE, IDLE_CODE];

/**
 * A fight started on the object directly (lock-in is T8's, tested in `engage.test.ts`): two bodies
 * of A's genome, idle and in full health, B east of A with 1.5 x the strike reach between them, so
 * neither can strike nor escape. Both get its `enc-start`.
 */
async function outOfReach(a: Player, b: Player): Promise<EncStart> {
  const genome = await authority((o) => o.ledger.head(a.creature)?.genome ?? '');
  const at = clock.t + E.startDelayMs;
  const base = { vx: 0, vy: 0, heading: 0, elder: false, egg: false, genome, y: 3000 };
  const vitals = { biomass: RULES.starter.biomass, energy: 150, health: 100 };
  const fighters: FighterInfo[] = [a, b].map((p, k) => ({
    ...base,
    ...vitals,
    player: p.id.playerId,
    creature: p.creature,
    x: 5200 + 100 * k,
  }));
  const msg: EncStart = {
    t: 'enc-start',
    enc: 'e'.repeat(64),
    seed: '5'.repeat(64),
    round: 0,
    t0: Math.floor(((at - a.pond.epoch) * TICK_HZ) / 1000),
    at,
    fighters,
  };
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
  let x = 5300;
  while (x > 5200 && probe(x - 0.5).gap >= 1.5 * probe(x).reach) x -= 0.5;
  const { gap, reach, away } = probe(x);
  expect(gap).toBeGreaterThan(1.4 * reach);
  expect(gap).toBeLessThan(away * 0.9);
  for (const f of fighters) if (f.player === b.id.playerId) f.x = x;
  await authority((o) => {
    const lock = o.fights.open(
      msg.enc,
      [a.id.playerId, b.id.playerId],
      [a.creature, b.creature],
      0,
      () => {},
    );
    expect(runFight(o, lock, msg, a.pond.seed)).toBe(true);
    for (const ws of o.ctx.getWebSockets()) {
      const s = ws.deserializeAttachment() as Session | null;
      if (s?.phase === 'active') ws.send(JSON.stringify(msg));
    }
  });
  await Promise.all([nextOf(a.c, 'enc-start'), nextOf(b.c, 'enc-start')]);
  return msg;
}

/**
 * Two players whose hatch protection is over, in a pond seeded `timeout`: no UV or pressure at
 * `NEAR`, and a current that shears little (the seed of T1's timeout test).
 */
async function fighters(): Promise<[Player, Player]> {
  const [a, b] = await pair();
  await sql("UPDATE ponds SET seed = 'timeout' WHERE id = ?", a.pond.id);
  for (const p of [a, b]) p.pond = { ...p.pond, seed: 'timeout' };
  return [a, b];
}

describe('the frame clock', () => {
  it('sends both fighters identical bundles from frame 0, with null for a silent slot', async () => {
    const [a, b] = await fighters();
    const [start] = await lockIn(a, b);
    const played = await play(a, b, start, (f) => [drive(f % 256, 4), f >= 3 ? null : drive(9)], 6);
    expect(played.frames[0].map((m) => m.f)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(played.frames[0]).toEqual(played.frames[1]);
    const sa = slotOf(start, a);
    const sb = slotOf(start, b);
    for (const [f, bundle] of played.frames[0].entries()) {
      expect(bundle.i[sa]).toBe(drive(f % 256, 4));
      expect(bundle.i[sb]).toBe(f >= 3 ? null : drive(9));
    }
  });

  it('a fighter at 1 hp with no energy starves: both get `enc-end` with the replayed hash', async () => {
    const [a, b] = await fighters();
    const rows = await rowsWritten();
    const [start] = await lockIn(a, b, snap(b, ...NEAR.b, { energy: 0, health: 0.01 }));
    const played = await play(a, b, start, IDLE);
    expect(played.ends).not.toBeNull();
    const [ea, eb] = played.ends as [EncEnd, EncEnd];
    expect(ea).toEqual(eb);
    const sb = slotOf(start, b);
    expect(ea.fighters[sb]).toMatchObject({ outcome: 'died', cause: 'starved', by: null });
    expect(ea.fighters[slotOf(start, a)]?.outcome).toBe('stood');
    const replayed = replay(a, start, played.frames[0]);
    expect(ea.hash).toBe(replayed.hash);
    expect(ea.f).toBe(played.frames[0].length);
    expect(ea.fighters.map((f) => f.outcome)).toEqual(replayed.results.map((r) => r.outcome));
    // The locks are gone with their timer, and nothing was written to SQLite.
    expect(await locked(a)).toBe(false);
    expect(await authority((o) => o.fights.creatureLocked(b.creature))).toBe(false);
    expect(await authority((o) => o.fights.timers())).toBe(0);
    expect(await rowsWritten()).toBe(rows);
  });

  it('a kill by a strike ends the same way, and each life takes the result’s condition', async () => {
    const [a, b] = await fighters();
    const rows = await rowsWritten();
    const [start] = await lockIn(
      a,
      b,
      snap(b, ...NEAR.b, { health: 0.01 }),
      snap(a, ...NEAR.a, { health: 1 }),
    );
    const target = slotOf(start, b);
    // A swims at B with its weapon aimed; B idles.
    const hunt: Plan = () => [drive(0, 15, { stance: 'aggressive', target }), IDLE_CODE];
    const played = await play(a, b, start, hunt);
    const [end] = played.ends as [EncEnd, EncEnd];
    expect(end.fighters[target]).toMatchObject({
      outcome: 'killed',
      cause: 'killed',
      by: slotOf(start, a),
    });
    expect(end.hash).toBe(replay(a, start, played.frames[0]).hash);
    for (const p of [a, b]) {
      expect(conditionOf(await lifeOn(p))).toEqual(hundredths(outcomeOf(end, p)));
    }
    expect(await rowsWritten()).toBe(rows);
  });

  it('frees both to court again once the fight is over', async () => {
    await setEnv(true);
    const [a, b] = await fighters();
    for (const p of [a, b]) {
      p.ticks += 16 * TICK_HZ;
      report(p.c, p.ticks, CALM);
      await nextOf(p.c, 'ack');
    }
    const [start] = await lockIn(a, b);
    // B swims away west until one of them is out of the other's range; A idles.
    const flee: Plan = () => [IDLE_CODE, drive(128, 15, { stance: 'evasive' })];
    const played = await play(a, b, start, flee);
    expect(outcomes(played)).toEqual(['escaped', 'stood']);
    expect(await authority((o) => o.fights.timers())).toBe(0);
    // The fight cost energy: a fresh report (as a client sends after the fight) fills it again.
    for (const p of [a, b]) {
      p.ticks += 10 * TICK_HZ;
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
    expect(await flush(a.c)).toEqual([]);
    expect((await within(nextOf(b.c, 'invite'), 'the invitation')).ask.creature).toBe(a.creature);
  });
});

describe('life while locked', () => {
  it('credits progress but keeps the condition, ignores a death report, and applies old age after the end', async () => {
    const [a, b] = await fighters();
    const [start] = await lockIn(a, b);
    await play(a, b, start, IDLE, 5);
    const before = await lifeOn(a);
    // The life clock runs out during the fight.
    await editLife(a, { lifespanMs: (before?.activeMs ?? 0) + 1000 });
    a.ticks += 3 * TICK_HZ;
    report(a.c, a.ticks, { biomass: 1, energy: 1, health: 1 });
    expect((await nextOf(a.c, 'ack')).activeMs).toBeGreaterThan(before?.activeMs ?? 0);
    const during = await lifeOn(a);
    expect(conditionOf(during)).toEqual(conditionOf(before));
    expect(during?.over).toBe(false);
    a.c.send({ t: 'death', cause: 'starved', ticks: a.ticks });
    expect((await flush(a.c)).filter((m) => m.t === 'died' || m.t === 'refused')).toEqual([]);
    expect((await sql('SELECT status FROM creatures WHERE id = ?', a.creature))[0]?.status).toBe(
      'active',
    );

    // A swims away until one of them is out of the other's range; old age that fell due in the
    // fight ends A after `enc-end`.
    const flee: Plan = () => [drive(128, 15, { stance: 'evasive' }), IDLE_CODE];
    const played = await play(a, b, start, flee, E.timeoutFrames, 5);
    expect(outcomes(played)).toEqual(['escaped', 'stood']);
    expect((await nextOf(a.c, 'died')).cause).toBe('old-age');
  });

  it('runs a disconnected fighter’s fight to its end; its reconnect gets `life` after `enc-end`, with the result', async () => {
    const [a, b] = await fighters();
    const [start] = await lockIn(a, b, snap(b, ...NEAR.b, { energy: 0, health: 0.3 }));
    b.c.ws.close(1000, 'gone');
    await b.c.closed;
    await advanceTo(start.at + 3 * FRAME_MS);
    const again = await signIn(b.id);
    await nextOf(again.c, 'welcome');
    expect((await flush(again.c)).map((m) => m.t)).not.toContain('life');
    // Both are silent now: every frame is the autopilot's, until B starves or one side wins.
    for (let i = 0; i < 100 && (await locked(a)); i++) await advance(1000);
    const end = await nextOf(a.c, 'enc-end');
    expect(await nextOf(again.c, 'enc-end')).toEqual(end);
    const life = await nextOf(again.c, 'life');
    expect(life.life?.creature).toBe(b.creature);
    const { biomass, energy, health } = life.life ?? { biomass: 0, energy: 0, health: 0 };
    expect({ biomass, energy, health }).toEqual(hundredths(outcomeOf(end, b)));
  });

  it('writes an absent fighter’s result as a checkpoint, so it resumes from it', async () => {
    const [a, b] = await fighters();
    const [start] = await lockIn(a, b, snap(b, ...NEAR.b, { energy: 0, health: 0.3 }));
    b.c.ws.close(1000, 'gone');
    await b.c.closed;
    for (let i = 0; i < 100 && (await locked(a)); i++) await advance(1000);
    const end = await nextOf(a.c, 'enc-end');
    const again = await signIn(b.id);
    await nextOf(again.c, 'welcome');
    const life = await nextOf(again.c, 'life');
    const { biomass, energy, health } = life.life ?? { biomass: 0, energy: 0, health: 0 };
    expect({ biomass, energy, health }).toEqual(hundredths(outcomeOf(end, b)));
  });
});

describe('inputs', () => {
  it('count in their own window while locked (130 per 10 s), and strays are dropped and counted', async () => {
    const [a, b] = await fighters();
    const c = await hatched();
    const [start] = await lockIn(a, b);
    // 129 inputs (early, repeated or taken) pass where 21 other messages would not.
    for (let i = 0; i < 129; i++) a.c.send({ t: 'input', enc: start.enc, f: i % 10, i: 1 });
    // The 130th names another fight, and C is in none: both are strays.
    a.c.send({ t: 'input', enc: 'f'.repeat(64), f: 0, i: 1 });
    c.c.send({ t: 'input', enc: start.enc, f: 0, i: 1 });
    await flush(c.c);
    await flush(a.c);
    expect(await authority((o) => o.fights.strays)).toBe(2);
    // The 131st input in the window is one too many.
    a.c.send({ t: 'input', enc: start.enc, f: 0, i: 1 });
    expect(await a.c.closed).toBe(CLOSE_RATE_LIMITED);
  });

  heavyTest(
    'a 30 s duel costs each participant at most 11 messages a second, each way',
    async () => {
      const [a, b] = await fighters();
      const start = await outOfReach(a, b);
      const sent = [0, 0];
      const got = [counter(a.c), counter(b.c)];
      const frames = 300;
      const played = await play(
        a,
        b,
        start,
        (f) => {
          sent[0] = (sent[0] ?? 0) + 1;
          sent[1] = (sent[1] ?? 0) + 1;
          // A progress report every 10 s, as a client sends them.
          if (f % 100 === 50) {
            for (const p of [a, b]) {
              p.ticks += 10 * TICK_HZ;
              report(p.c, p.ticks, CALM);
              sent[[a, b].indexOf(p)] = (sent[[a, b].indexOf(p)] ?? 0) + 1;
            }
          }
          return [IDLE_CODE, IDLE_CODE];
        },
        frames,
      );
      expect(played.ends).toBeNull();
      expect(played.frames[0]).toHaveLength(frames);
      const seconds = (frames * FRAME_MS) / 1000;
      for (const k of [0, 1] as const) {
        expect(played.frames[k]).toHaveLength(frames);
        expect((sent[k] ?? 0) / seconds).toBeLessThanOrEqual(11);
        expect((got[k]?.n ?? 0) / seconds).toBeLessThanOrEqual(11);
      }
    },
  );
});
