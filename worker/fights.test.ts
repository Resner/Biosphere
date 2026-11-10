import { describe, expect, it } from 'vitest';
import { signMateAsk } from '../src/ledger/mating';
import { encounterStartOf } from '../src/net/encounter-start';
import { CLOSE_RATE_LIMITED } from '../src/net/protocol';
import { FRAME_MS } from '../src/net/referee';
import { replayEncounter } from '../src/sim/encounter/replay';
import { RULES, RULES_VERSION, TICK_HZ } from '../src/sim/rules';
import { drive, IDLE_CODE } from '../tests/encounter-fixture';
import { heavyTest } from '../tests/heavy';
import {
  advance,
  advanceTo,
  authority,
  type EncEnd,
  type EncFrame,
  type EncStart,
  editLife,
  fighters,
  hatched,
  hundredths,
  lifeOn,
  locked,
  lockIn,
  NEAR,
  outcomeOf,
  outOfReach,
  type Plan,
  type Played,
  type Player,
  play,
  rowsBesideLog,
  setEnv,
  slotOf,
  snap,
  useFightHub,
  within,
} from './fight-test-kit';
import type { LifeState } from './life';
import {
  CALM,
  type Client,
  flush,
  freshNonce,
  nextOf,
  placed,
  report,
  signIn,
  sql,
} from './test-hub';

// M7 T9: the referee's frame clock on the authority, driven by the hand-moved clock of
// `fight-test-kit.ts`: deadlines, the fallback marker, bundles, the end and life while locked.

const E = RULES.encounter;

useFightHub();

/** The fight replayed from its start and bundles, as every client steps it. */
function replay(a: Player, start: EncStart, frames: EncFrame[]) {
  const encStart = encounterStartOf(start, a.pond.seed);
  if (!encStart) throw new Error('no start');
  return replayEncounter({ rules: RULES_VERSION, start: encStart, frames: frames.map((b) => b.i) });
}

/** The fight's outcomes, sorted: who escaped depends on whose range the other left first (T1). */
const outcomes = (played: Played) => played.ends?.[0].fighters.map((f) => f.outcome).sort();

/** Counts every message a client receives from now on. */
function counter(c: Client): { n: number } {
  const count = { n: 0 };
  c.ws.addEventListener('message', () => {
    count.n++;
  });
  return count;
}

/** The condition a life state holds. */
const conditionOf = (l: LifeState | undefined) => ({
  biomass: l?.biomass,
  energy: l?.energy,
  health: l?.health,
});

const IDLE: Plan = () => [IDLE_CODE, IDLE_CODE];

/** Full health and energy, so a flee test can't end in a kill by a random body's spines or ram. */
const FULL = { health: 1, energy: 1 };
/** Hungry and hurt: a fighter left to its autopilot starves within the fight. */
const WEAK = { energy: 0, health: 0.3 };

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
    const rows = await rowsBesideLog();
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
    // The locks are gone with their timer, and beside the fight's log (M8 T2) SQLite holds only the
    // settlement (T13): B's death (with its dead index entry) and A's encounter record.
    expect(await locked(a)).toBe(false);
    expect(await authority((o) => o.fights.creatureLocked(b.creature))).toBe(false);
    expect(await authority((o) => o.fights.timers())).toBe(0);
    // And the lock's `authority-only` flag (no witness online, M10).
    expect((await rowsBesideLog()) - rows).toBeLessThanOrEqual(6);
  });

  it('a kill by a strike ends the same way, and each life takes the result’s condition', async () => {
    const [a, b] = await fighters();
    const rows = await rowsBesideLog();
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
    // And the lock's `authority-only` flag (no witness online, M10).
    expect((await rowsBesideLog()) - rows).toBeLessThanOrEqual(6);
  });

  it('frees both to court again once the fight is over', async () => {
    await setEnv(true);
    const [a, b] = await fighters();
    for (const p of [a, b]) {
      p.ticks += 16 * TICK_HZ;
      report(p.c, p.ticks, CALM);
      await nextOf(p.c, 'ack');
    }
    const [start] = await lockIn(a, b, snap(b, ...NEAR.b, FULL), snap(a, ...NEAR.a, FULL));
    // B (east of A) swims away east until one of them is out of the other's range; A idles. West
    // would take B through A, where some hatched bodies' contact ends the fight in a kill.
    const flee: Plan = () => [IDLE_CODE, drive(0, 15, { stance: 'evasive' })];
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
    await placed(a, b);
    a.c.send({ t: 'court', ask });
    expect(await flush(a.c)).toEqual([]);
    expect((await within(nextOf(b.c, 'invite'), 'the invitation')).ask.creature).toBe(a.creature);
  });
});

describe('life while locked', () => {
  it('acknowledges progress but credits and keeps nothing, ignores a death report, and applies old age after the end', async () => {
    const [a, b] = await fighters();
    const [start] = await lockIn(a, b, snap(b, ...NEAR.b, FULL), snap(a, ...NEAR.a, FULL));
    // From the lock on, which wrote its `authority-only` flag (no witness online, M10).
    const rows = await rowsBesideLog();
    await play(a, b, start, IDLE, 5);
    const before = await lifeOn(a);
    // The life clock has run out by the end of the fight (M8 credits the locked time at the end).
    await editLife(a, { lifespanMs: before?.activeMs ?? 0 });
    a.ticks += 3 * TICK_HZ;
    report(a.c, a.ticks, { biomass: 1, energy: 1, health: 1 });
    expect((await nextOf(a.c, 'ack')).activeMs).toBe(before?.activeMs);
    const during = await lifeOn(a);
    expect(conditionOf(during)).toEqual(conditionOf(before));
    expect(during?.activeMs).toBe(before?.activeMs);
    expect(during?.over).toBe(false);
    a.c.send({ t: 'death', cause: 'starved', ticks: a.ticks });
    expect((await flush(a.c)).filter((m) => m.t === 'died' || m.t === 'refused')).toEqual([]);
    expect((await sql('SELECT status FROM creatures WHERE id = ?', a.creature))[0]?.status).toBe(
      'active',
    );
    // Nothing is written while the fight runs, beside its log (M8 T2).
    expect(await rowsBesideLog()).toBe(rows);

    // A swims away until one of them is out of the other's range; old age that fell due in the
    // fight ends A after `enc-end`.
    const flee: Plan = () => [drive(128, 15, { stance: 'evasive' }), IDLE_CODE];
    const played = await play(a, b, start, flee, E.timeoutFrames, 5);
    expect(outcomes(played)).toEqual(['escaped', 'stood']);
    expect((await nextOf(a.c, 'died')).cause).toBe('old-age');
  });

  it('runs a disconnected fighter’s fight to its end; its reconnect returns to the fight, and its life takes the result', async () => {
    const [a, b] = await fighters();
    // A is the one that starves (or falls to B's autopilot), so B comes out of it alive.
    const [start] = await lockIn(a, b, snap(b, ...NEAR.b, FULL), snap(a, ...NEAR.a, WEAK));
    b.c.ws.close(1000, 'gone');
    await b.c.closed;
    await advanceTo(start.at + 3 * FRAME_MS);
    const again = await signIn(b.id);
    await nextOf(again.c, 'welcome');
    const life = await nextOf(again.c, 'life');
    expect(life.fight).toBe(start.enc);
    expect(life.life?.creature).toBe(b.creature);
    expect(await nextOf(again.c, 'enc-start')).toEqual(start);
    // Both are silent now: every frame is the autopilot's, until A starves or one side wins.
    for (let i = 0; i < 100 && (await locked(a)); i++) await advance(1000);
    const end = await nextOf(a.c, 'enc-end');
    expect(await nextOf(again.c, 'enc-end')).toEqual(end);
    // The client takes the result from `enc-end`; the connection's life holds it too.
    expect((await flush(again.c)).map((m) => m.t)).not.toContain('life');
    expect(conditionOf(await lifeOn(b))).toEqual(hundredths(outcomeOf(end, b)));
  });

  it('writes an absent fighter’s result as its encounter record, so it resumes from it', async () => {
    const [a, b] = await fighters();
    await lockIn(a, b, snap(b, ...NEAR.b, FULL), snap(a, ...NEAR.a, WEAK));
    b.c.ws.close(1000, 'gone');
    await b.c.closed;
    for (let i = 0; i < 100 && (await locked(a)); i++) await advance(1000);
    const end = await nextOf(a.c, 'enc-end');
    expect(['escaped', 'stood']).toContain(outcomeOf(end, b).outcome);
    const again = await signIn(b.id);
    await nextOf(again.c, 'welcome');
    const life = await nextOf(again.c, 'life');
    const { biomass, energy, health } = life.life ?? { biomass: 0, energy: 0, health: 0 };
    expect({ biomass, energy, health }).toEqual(hundredths(outcomeOf(end, b)));
    const kinds = await sql<{ kind: string }>(
      'SELECT kind FROM records WHERE creature = ? ORDER BY seq',
      b.creature,
    );
    expect(kinds.map((r) => r.kind)).toEqual(['genesis', 'encounter']);
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

  it('count in their own window for one rate window after the fight ended: the ones in flight when it did', async () => {
    const [a, b] = await fighters();
    const [start] = await lockIn(a, b, snap(b, ...NEAR.b, FULL), snap(a, ...NEAR.a, WEAK));
    for (let i = 0; i < 100 && (await locked(a)); i++) await advance(1000);
    await nextOf(a.c, 'enc-end');
    // 25 inputs would be 5 too many as ordinary messages.
    for (let i = 0; i < 25; i++) a.c.send({ t: 'input', enc: start.enc, f: i % 10, i: 1 });
    await flush(a.c);
    expect(a.c.ws.readyState).toBe(WebSocket.OPEN);
    // A slow page keeps sending for seconds; past the window they are ordinary messages again.
    await advance(6_000);
    for (let i = 0; i < 25; i++) a.c.send({ t: 'input', enc: start.enc, f: i % 10, i: 1 });
    await flush(a.c);
    expect(a.c.ws.readyState).toBe(WebSocket.OPEN);
    await advance(10_000);
    for (let i = 0; i < 25; i++) a.c.send({ t: 'input', enc: start.enc, f: i % 10, i: 1 });
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
