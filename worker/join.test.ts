import { describe, expect, it } from 'vitest';
import { encounterStartOf, fighterStartOf } from '../src/net/encounter-start';
import type { HubMsg } from '../src/net/protocol';
import { FRAME_MS } from '../src/net/referee';
import { replayEncounter } from '../src/sim/encounter/replay';
import { RULES, RULES_VERSION } from '../src/sim/rules';
import { maxHealth } from '../src/sim/vitals';
import { IDLE_CODE } from '../tests/encounter-fixture';
import {
  advance,
  advanceTo,
  authority,
  CALM_SEED,
  drift,
  type EncEnd,
  type EncStart,
  hatched,
  locked,
  lockIn,
  NEAR,
  type Player,
  pondTick,
  refusal,
  snap,
  useFightHub,
  within,
} from './fight-test-kit';
import { nextOf, sql } from './test-hub';

// M7 T15: an engage where one side is already fighting joins that fight. The joiner takes the
// next slot from the current frame + 2: everyone hears `enc-join`, and the joiner first gets the
// fight's `enc-start` and every bundle and join so far, so it steps the same encounter.

const E = RULES.encounter;
type EncJoin = Extract<HubMsg, { t: 'enc-join' }>;
type EncFrame = Extract<HubMsg, { t: 'enc-frame' }>;

useFightHub();

/** `n` players whose hatch protection is over, in the calm `timeout` pond. */
async function players(n: number): Promise<Player[]> {
  const out: Player[] = [];
  for (let i = 0; i < n; i++) out.push(await hatched());
  await advance(16_000);
  await sql('UPDATE ponds SET seed = ? WHERE id = ?', CALM_SEED, (out[0] as Player).pond.id);
  for (const p of out) p.pond = { ...p.pond, seed: CALM_SEED };
  return out;
}

/** `c` engages `target`, already fighting; `c` stands at (x, y). */
function engageInto(
  c: Player,
  target: Player,
  at: readonly [number, number],
  tx: readonly [number, number] = NEAR.a,
) {
  c.c.send({
    t: 'engage',
    target: target.id.playerId,
    mine: snap(c, at[0], at[1], { health: 0.01, energy: 0 }),
    theirs: snap(target, tx[0], tx[1]),
  });
}

/** What the joiner hears on joining: the start, the history, then its own join (in that order). */
async function joinerHears(
  c: Player,
): Promise<{ start: EncStart; frames: EncFrame[]; join: EncJoin }> {
  const start = await within(nextOf(c.c, 'enc-start'), 'the joiner’s enc-start');
  const frames: EncFrame[] = [];
  for (;;) {
    const msg = await within(c.c.next(), 'the joiner’s history');
    if (msg.t === 'enc-frame') frames.push(msg);
    else if (msg.t === 'enc-join' && msg.fighter.player === c.id.playerId)
      return { start, frames, join: msg };
  }
}

describe('joins', () => {
  it('a third player joins at the current frame + 2 from its signed snapshot, and every hash agrees', async () => {
    const [a, b, c] = (await players(3)) as [Player, Player, Player];
    const [start] = await lockIn(a, b, snap(b, ...NEAR.b, { health: 0.5, energy: 0 }));
    // Two frames are final before C engages.
    await advanceTo(start.at + FRAME_MS + E.inputDeadlineMs + 1);
    await Promise.all([nextOf(a.c, 'enc-frame'), nextOf(a.c, 'enc-frame')]);
    await Promise.all([nextOf(b.c, 'enc-frame'), nextOf(b.c, 'enc-frame')]);
    const snapTick = pondTick(c);
    engageInto(c, a, [1000, 1012]);
    const heard = await joinerHears(c);
    expect(heard.start).toEqual(start);
    expect(heard.frames.map((m) => m.f)).toEqual([0, 1]);
    const [ja, jb] = await Promise.all([nextOf(a.c, 'enc-join'), nextOf(b.c, 'enc-join')]);
    expect(ja).toEqual(heard.join);
    expect(jb).toEqual(heard.join);
    expect(ja.f).toBe(2 + E.joinAheadFrames);
    // Its start is its own signed snapshot carried to the join's tick.
    const f = ja.fighter;
    expect(f).toMatchObject({ player: c.id.playerId, creature: c.creature, egg: false });
    expect(f.biomass).toBe(RULES.starter.biomass);
    expect(f.health).toBeGreaterThan(0);
    expect(f.health).toBeLessThan(0.02 * maxHealth(RULES.starter.biomass));
    const ticks = start.t0 + E.frameTicks * ja.f - snapTick;
    expect(Math.abs(f.x - 1000)).toBeLessThan(drift(ticks));
    expect(Math.abs(f.y - 1012)).toBeLessThan(drift(ticks));
    expect(await locked(c)).toBe(true);

    // Everyone idles until the fight is over: C and B have no energy and starve (B's 50 hp outlast
    // any hatched body's first strike, so the fight is still on at the join), A's nips may speed B
    // on. All three hear the same bundles, three wide from the join on, and the same end.
    const frames: EncFrame[] = [...heard.frames];
    const ends: EncEnd[] = [];
    for (let k = 2; k < E.timeoutFrames && ends.length === 0; k++) {
      await advanceTo(start.at + k * FRAME_MS - FRAME_MS);
      for (const p of [a, b, c]) {
        if (k >= ja.f || p !== c) p.c.send({ t: 'input', enc: start.enc, f: k, i: IDLE_CODE });
      }
      const got = await within(
        Promise.all([a, b, c].map((p) => nextOf(p.c, 'enc-frame'))),
        `frame ${k}`,
      );
      expect(got[1]).toEqual(got[0]);
      expect(got[2]).toEqual(got[0]);
      const bundle = got[0] as EncFrame;
      expect(bundle.i).toHaveLength(k >= ja.f ? 3 : 2);
      frames.push(bundle);
      if (!(await locked(a))) {
        ends.push(
          ...(await within(Promise.all([a, b, c].map((p) => nextOf(p.c, 'enc-end'))), 'enc-end')),
        );
      }
    }
    expect(ends).toHaveLength(3);
    expect(ends[1]).toEqual(ends[0]);
    expect(ends[2]).toEqual(ends[0]);
    const end = ends[0] as EncEnd;
    expect(end.fighters.map((x) => x.player)).toContain(c.id.playerId);
    const encStart = encounterStartOf(start, a.pond.seed);
    const joiner = fighterStartOf(ja.fighter);
    if (!encStart || !joiner) throw new Error('no start');
    const replayed = replayEncounter({
      rules: RULES_VERSION,
      start: encStart,
      frames: frames.map((m) => m.i),
      joins: [{ f: ja.f, fighter: joiner }],
    });
    expect(end.hash).toBe(replayed.hash);
    expect(await locked(c)).toBe(false);
    expect(await authority((o) => o.fights.timers())).toBe(0);
  });

  it('a fifth is refused `engage:full`, and a pair in different fights `engage:locked`', async () => {
    const [a, b, c, d, e, g] = (await players(6)) as Player[] as [
      Player,
      Player,
      Player,
      Player,
      Player,
      Player,
    ];
    const [start] = await lockIn(a, b);
    engageInto(c, a, [1000, 1012]);
    await nextOf(c.c, 'enc-start');
    engageInto(d, b, [1012, 1012], NEAR.b);
    await nextOf(d.c, 'enc-start');
    expect(await authority((o) => o.fights.ofPlayer(a.id.playerId)?.players.length)).toBe(4);
    engageInto(e, a, [988, 1000]);
    expect((await nextOf(e.c, 'refused')).reason).toBe('engage:full');
    expect(await locked(e)).toBe(false);
    // E and G fight each other; A, in another fight, can't engage G.
    await lockIn(e, g, snap(g, 1012, 1000), snap(e, 1000, 1000));
    expect(await refusal(g, a, snap(a, ...NEAR.a), snap(g, 1012, 1000))).toBe('engage:locked');
    expect(start.fighters).toHaveLength(2);
  });
});
