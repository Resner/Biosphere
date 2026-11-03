import { describe, expect, it } from 'vitest';
import type { HubMsg } from '../src/net/protocol';
import { RULES } from '../src/sim/rules';
import { drive, IDLE_CODE } from '../tests/encounter-fixture';
import {
  authority,
  type EncEnd,
  type EncStart,
  fighters,
  hundredths,
  lifeOn,
  lockIn,
  NEAR,
  outcomeOf,
  type Plan,
  type Player,
  play,
  slotOf,
  snap,
  useFightHub,
} from './fight-test-kit';
import { bear, mated, must } from './ledger-test-kit';
import { type Client, nextOf, rowsWritten, signIn, sql } from './test-hub';

// M7 T13: a fight's results as records, on the hub (ADR 0052): the settlement's records, `died`
// with the killer and the fallback before `enc-end`, and what a reconnect gets after the end.

const E = RULES.encounter;

useFightHub();

/** Every message the client receives from now on, in order. */
function log(c: Client): HubMsg[] {
  const seen: HubMsg[] = [];
  c.ws.addEventListener('message', (e) => {
    seen.push(JSON.parse(String(e.data)) as HubMsg);
  });
  return seen;
}

const chain = (creature: string) =>
  sql<{ kind: string; json: string }>(
    'SELECT kind, json FROM records WHERE creature = ? ORDER BY seq',
    creature,
  ).then((rows) => rows.map((r) => ({ kind: r.kind, body: JSON.parse(r.json).body })));

const headOf = (creature: string) => authority((o) => must(o.ledger.head(creature)));

/** A locks B in at 1 hp; A then swims at it with its weapon aimed while B idles, until B dies. */
async function killB(
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

describe('a kill', () => {
  it('writes the victim’s death by the killer and the killer’s encounter record', async () => {
    const [a, b] = await fighters();
    const [seenA, seenB] = [log(a.c), log(b.c)];
    const rows = await rowsWritten();
    const { start, end } = await killB(a, b);
    // Two rows per participant, and the victim's dead index entry.
    expect((await rowsWritten()) - rows).toBeLessThanOrEqual(5);

    const victim = await chain(b.creature);
    expect(victim.map((r) => r.kind)).toEqual(['genesis', 'death']);
    expect(victim[1]?.body).toMatchObject({ cause: 'killed', enc: start.enc, by: a.creature });
    expect((await headOf(b.creature)).status).toBe('dead');

    const killer = await chain(a.creature);
    expect(killer.map((r) => r.kind)).toEqual(['genesis', 'encounter']);
    const mine = outcomeOf(end, a);
    const theirs = outcomeOf(end, b);
    expect(killer[1]?.body).toEqual({
      enc: start.enc,
      outcome: 'stood',
      frames: end.f,
      ...hundredths(mine),
      // Equal sizes: the kill is worth its share of the victim's biomass.
      reward: Math.floor(E.reward.share * theirs.biomass * 100),
    });
    const head = await headOf(a.creature);
    expect({ biomass: head.biomass, energy: head.energy, health: head.health }).toEqual(
      hundredths(mine),
    );

    // The victim hears `died`, naming its killer and its fallback, before `enc-end`; the killer doesn't.
    expect(seenB.filter((m) => m.t === 'died' || m.t === 'enc-end').map((m) => m.t)).toEqual([
      'died',
      'enc-end',
    ]);
    const died = seenB.find((m) => m.t === 'died');
    expect(died).toMatchObject({ cause: 'killed', by: 'Tester', fallback: { pending: false } });
    expect(died?.t === 'died' && died.record.record.body.by).toBe(a.creature);
    expect(seenA.some((m) => m.t === 'died')).toBe(false);
    expect((await lifeOn(b))?.over).toBe(true);
  });

  it('eats the victim’s egg with it: the pending child dies, and the killer keeps its own', async () => {
    const [a, b] = await fighters();
    // Both carry a pending child, as after a mating.
    const [childA, childB] = await authority((o) => {
      const heads = [must(o.ledger.head(a.creature)), must(o.ledger.head(b.creature))];
      return bear(o.ledger, mated(o.ledger, heads[0] as never, heads[1] as never));
    });
    const seenB = log(b.c);
    const [start] = await lockIn(
      a,
      b,
      snap(b, ...NEAR.b, { health: 0.01, egg: true }),
      snap(a, ...NEAR.a, { health: 1, egg: true }),
    );
    expect(start.fighters.map((f) => f.egg)).toEqual([true, true]);
    const { end } = await killB(a, b, start);
    expect(outcomeOf(end, b)).toMatchObject({ egg: 'eaten', eggBy: slotOf(start, a) });
    expect(outcomeOf(end, a).egg).toBe('kept');

    const egg = await chain(childB.id);
    expect(egg.map((r) => r.kind)).toEqual(['birth', 'death']);
    expect(egg[1]?.body).toEqual({ cause: 'eaten', enc: start.enc, by: a.creature });
    expect((await headOf(childA.id)).status).toBe('pending');
    // The fallback is computed after the records: no pending child is left to offer.
    expect(seenB.find((m) => m.t === 'died')).toMatchObject({ fallback: { pending: false } });
    const reward = (E.reward.share + E.egg.eatShare) * outcomeOf(end, b).biomass * 100;
    expect((await chain(a.creature)).at(-1)?.body.reward).toBe(Math.floor(reward));
  });

  it('tells a victim back in the fight `died` before `enc-end`; a reconnect after the end gets the settled life', async () => {
    const [a, b] = await fighters();
    const [start] = await lockIn(
      a,
      b,
      snap(b, ...NEAR.b, { health: 0.01 }),
      snap(a, ...NEAR.a, { health: 1 }),
    );
    // B reloads before frame 0, so it is owed its life at the end, and fights on from the new socket.
    b.c.ws.close(1000, 'reload');
    await b.c.closed;
    const back = await signIn(b.id);
    await nextOf(back.c, 'welcome');
    const seen = log(back.c);
    const { end } = await killB(a, { ...b, c: back.c }, start);
    expect(seen.filter((m) => m.t !== 'enc-frame').map((m) => m.t)).toEqual(['died', 'enc-end']);

    // After the end, the killer comes back to its settled condition, and the victim to nothing.
    a.c.ws.close(1000, 'reload');
    await a.c.closed;
    const again = await signIn(a.id);
    await nextOf(again.c, 'welcome');
    const life = (await nextOf(again.c, 'life')).life;
    expect(life?.creature).toBe(a.creature);
    const { biomass, energy, health } = life ?? { biomass: 0, energy: 0, health: 0 };
    expect({ biomass, energy, health }).toEqual(hundredths(outcomeOf(end, a)));
    back.c.ws.close(1000, 'reload');
    await back.c.closed;
    const victim = await signIn(b.id);
    await nextOf(victim.c, 'welcome');
    expect((await nextOf(victim.c, 'life')).life).toBeNull();
  });

  it('keeps the pending child of a carrier that starves in the fight', async () => {
    const [a, b] = await fighters();
    const [, childB] = await authority((o) => {
      const heads = [must(o.ledger.head(a.creature)), must(o.ledger.head(b.creature))];
      return bear(o.ledger, mated(o.ledger, heads[0] as never, heads[1] as never));
    });
    const seenB = log(b.c);
    const [start] = await lockIn(a, b, snap(b, ...NEAR.b, { energy: 0, health: 0.01 }));
    const played = await play(a, b, start, () => [IDLE_CODE, IDLE_CODE]);
    const [end] = played.ends as [EncEnd, EncEnd];
    expect(outcomeOf(end, b)).toMatchObject({ outcome: 'died', cause: 'starved', egg: 'kept' });
    expect((await chain(b.creature)).at(-1)?.body).toMatchObject({
      cause: 'starved',
      enc: start.enc,
    });
    expect((await headOf(childB.id)).status).toBe('pending');
    const died = seenB.find((m) => m.t === 'died');
    expect(died).toMatchObject({ cause: 'starved', fallback: { pending: true } });
    expect(died && 'by' in died).toBe(false);
  });
});
