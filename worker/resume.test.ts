import { afterEach, describe, expect, it } from 'vitest';
import { type Identity, toBase64Url } from '../src/ledger/identity';
import { signMateAsk } from '../src/ledger/mating';
import { REQUEST_DOMAIN, type RecordRequest, requestMessage } from '../src/ledger/record';
import { CLOSE_REPLACED, type HubMsg } from '../src/net/protocol';
import { FRAME_MS } from '../src/net/referee';
import { RULES, RULES_VERSION, TICK_HZ } from '../src/sim/rules';
import { IDLE_CODE } from '../tests/encounter-fixture';
import {
  advance,
  advanceTo,
  authority,
  type EncStart,
  engage,
  fighters,
  hatched,
  join,
  lifeOn,
  locked,
  lockIn,
  logRow,
  NEAR,
  outOfReach,
  type Plan,
  type Player,
  play,
  rowsBesideLog,
  setEnv,
  snap,
  useFightHub,
  within,
} from './fight-test-kit';
import type { Session } from './socket';
import {
  CALM,
  type Client,
  flush,
  freshNonce,
  genesisRequest,
  nextOf,
  report,
  signIn,
  sql,
} from './test-hub';

// M8 T6: a player who signs in again during its fight returns to it (ADR 0053): its seat in the
// fight's pond was held, `life` names the fight, and the fight follows from its start; its locks
// hold across the sign-in, and nothing of its life is credited or written until the settlement.

const E = RULES.encounter;
type EncFrame = Extract<HubMsg, { t: 'enc-frame' }>;

useFightHub();

afterEach(() =>
  authority((o) => {
    (o.env as unknown as Record<string, string | undefined>).MAX_SESSIONS = undefined;
  }),
);

const IDLE: Plan = () => [IDLE_CODE, IDLE_CODE];

/** Closes a player's socket, as a reload or a lost connection does. */
async function leave(p: Player): Promise<void> {
  p.c.ws.close(1000, 'gone');
  await p.c.closed;
}

/** What a sign-in got: everything up to the answer to a ping, member news aside. */
async function signInAgain(p: Player): Promise<{ c: Client; got: HubMsg[] }> {
  const { c } = await signIn(p.id);
  const got = (await flush(c)).filter((m) => m.t !== 'member');
  return { c, got };
}

/** The fight the player is locked in, as the object holds it. */
const fightOf = (p: Player) =>
  authority((o) => {
    const fight = o.fights.ofPlayer(p.id.playerId)?.fight;
    return fight ? { next: fight.referee.next, history: fight.history, pond: fight.pond } : null;
  });

/** The resume sequence: `welcome` for the fight's pond, `life` naming the fight, `enc-start`, then the history. */
async function expectResume(got: HubMsg[], p: Player, start: EncStart): Promise<void> {
  const fight = await fightOf(p);
  if (!fight) throw new Error('no fight');
  expect(got.map((m) => m.t)).toEqual([
    'welcome',
    'life',
    'enc-start',
    ...fight.history.map((m) => m.t),
  ]);
  const [welcome, life, encStart, ...rest] = got;
  expect(welcome?.t === 'welcome' && welcome.world.id).toBe(fight.pond);
  expect(life).toMatchObject({ t: 'life', fight: start.enc, life: { creature: p.creature } });
  expect(encStart).toEqual(start);
  expect(rest).toEqual(fight.history);
}

/** Moves every seated session of these players into another pond, made for them. */
async function moveTo(pond: string, players: Player[]): Promise<void> {
  await sql(
    "INSERT INTO ponds (id, seed, epoch, cx, cy, created) VALUES (?, 'other', 0, 4000, 4000, 0)",
    pond,
  );
  const ids = new Set(players.map((p) => p.id.playerId));
  await authority((o) => {
    for (const ws of o.ctx.getWebSockets()) {
      const s = ws.deserializeAttachment() as Session | null;
      if (s?.phase === 'active' && ids.has(s.playerId))
        ws.serializeAttachment({ ...s, pondId: pond });
    }
  });
}

/** A signed-in player with no creature, as a `Player` (only its socket and identity are used). */
async function newcomer(): Promise<Player> {
  const { c, id, pond } = await join();
  return { c, id, pond, creature: '', ref: 0, ticks: 0 };
}

describe('back to the fight', () => {
  it('a sign-in mid-fight gets the fight’s pond (though another is fuller), `life` with the fight, then `enc-start`, every frame and every join', async () => {
    const [a, b] = await fighters();
    const c = await hatched();
    await advance(16_000);
    await sql("UPDATE ponds SET seed = 'timeout' WHERE id = ?", c.pond.id);
    c.pond = { ...c.pond, seed: 'timeout' };
    const others = [await newcomer(), await newcomer(), await newcomer()];
    await moveTo('fuller', others);
    const [start] = await lockIn(a, b, snap(b, ...NEAR.b, { health: 0.5, energy: 0 }));
    await play(a, b, start, IDLE, 2);
    c.c.send({
      t: 'engage',
      target: a.id.playerId,
      mine: snap(c, 1000, 1012, { health: 0.01, energy: 0 }),
      theirs: snap(a, ...NEAR.a),
    });
    const joined = await within(nextOf(a.c, 'enc-join'), 'the join');
    expect(joined.fighter.player).toBe(c.id.playerId);
    await leave(b);
    await advanceTo(start.at + 5 * FRAME_MS + E.inputDeadlineMs + 1);
    // The fight's pond holds A and C, the other three, with B away: B still goes back to its fight.
    const { got } = await signInAgain(b);
    expect(await locked(b)).toBe(true);
    await expectResume(got, b, start);
    const fight = await fightOf(b);
    expect(fight?.history).toContainEqual(joined);
    expect(fight?.history.filter((m) => m.t === 'enc-frame').map((m) => m.f)).toEqual([
      ...Array(fight?.next).keys(),
    ]);
  });

  it('takes B’s input from the referee’s next frame on; one for a final frame is `late`, and B’s frames while away are null', async () => {
    const [a, b] = await fighters();
    const start = await outOfReach(a, b);
    await play(a, b, start, IDLE, 5);
    await leave(b);
    // A plays on; B's frames are the autopilot's.
    for (let f = 5; f < 10; f++) {
      await advanceTo(start.at + (f - 1) * FRAME_MS);
      a.c.send({ t: 'input', enc: start.enc, f, i: IDLE_CODE });
      await advanceTo(start.at + f * FRAME_MS + E.inputDeadlineMs + 1);
      await within(nextOf(a.c, 'enc-frame'), `frame ${f}`);
    }
    const back = await signInAgain(b);
    await expectResume(back.got, b, start);
    // The encounter seats fighters in creature-id order, not the start's.
    const sb = (await authority((o) => o.fights.ofPlayer(b.id.playerId)?.fight?.players))?.indexOf(
      b.id.playerId,
    ) as number;
    const away = (await fightOf(b))?.history.filter((m): m is EncFrame => m.t === 'enc-frame');
    expect(away?.slice(5).map((m) => m.i[sb])).toEqual([null, null, null, null, null]);
    expect(away?.slice(0, 5).every((m) => m.i[sb] === IDLE_CODE)).toBe(true);

    const next = (await fightOf(b))?.next ?? 0;
    expect(next).toBe(10);
    back.c.send({ t: 'input', enc: start.enc, f: next - 1, i: 7 });
    back.c.send({ t: 'input', enc: start.enc, f: next, i: 7 });
    a.c.send({ t: 'input', enc: start.enc, f: next, i: IDLE_CODE });
    const frame = await within(nextOf(back.c, 'enc-frame'), 'the next frame');
    expect(frame.f).toBe(next);
    expect(frame.i[sb]).toBe(7);
    const verdict = await authority((o) => {
      const f = o.fights.ofPlayer(b.id.playerId)?.fight;
      return f?.referee.input(sb, next - 1, 7, o.clock.now());
    });
    expect(verdict).toBe('late');
    expect(away?.[next - 1]?.i[sb]).toBeNull();
    const history = (await fightOf(b))?.history ?? [];
    expect(history.find((m) => m.t === 'enc-frame' && m.f === next - 1)).toEqual(away?.[next - 1]);
  });

  it('a replacing second tab gets the same sequence, and the first socket is closed 4001', async () => {
    const [a, b] = await fighters();
    const start = await outOfReach(a, b);
    await play(a, b, start, IDLE, 3);
    const second = await signInAgain(b);
    expect(await b.c.closed).toBe(CLOSE_REPLACED);
    await expectResume(second.got, b, start);
  });
});

describe('an away fighter keeps its seat', () => {
  it('in its pond’s 24: a 24th player who signs in while B is away goes to another pond', async () => {
    const [a, b] = await fighters();
    await outOfReach(a, b);
    const crowd: Player[] = [];
    for (let i = 0; i < 22; i++) crowd.push(await newcomer());
    expect(crowd.every((p) => p.pond.id === a.pond.id)).toBe(true);
    await leave(b);
    const late = await newcomer();
    expect(late.pond.id).not.toBe(a.pond.id);
    const { got } = await signInAgain(b);
    expect(got[0]?.t === 'welcome' && got[0].world.id).toBe(a.pond.id);
  });

  it('in `MAX_SESSIONS`: B is seated at once and a newcomer is queued', async () => {
    const [a, b] = await fighters();
    const start = await outOfReach(a, b);
    await leave(b);
    const seated = await authority((o) => {
      let n = 0;
      for (const ws of o.ctx.getWebSockets()) {
        if ((ws.deserializeAttachment() as Session | null)?.phase === 'active') n++;
      }
      (o.env as unknown as Record<string, string>).MAX_SESSIONS = String(n + 1);
      return n;
    });
    expect(seated).toBe(1);
    const { c } = await signIn();
    expect((await c.next()).t).toBe('queued');
    const { got } = await signInAgain(b);
    await expectResume(got, b, start);
  });
});

describe('a lock still asking', () => {
  it('is free play: `progress` credits, a close writes the checkpoint, and the fight’s clock starts from it', async () => {
    const [a, b] = await fighters();
    const before = await lifeOn(b);
    if (!before) throw new Error('no life');
    engage(a, b);
    await nextOf(b.c, 'lock-ask');
    const asking = () => authority((o) => o.fights.ofPlayer(b.id.playerId)?.asking != null);
    expect(await asking()).toBe(true);
    b.ticks += TICK_HZ;
    report(b.c, b.ticks, CALM);
    expect((await nextOf(b.c, 'ack')).activeMs).toBe(before.activeMs + 1000);
    expect((await lifeOn(b))?.activeMs).toBe(before.activeMs + 1000);
    expect(await asking()).toBe(true);
    await leave(b);
    const head = await authority((o) => o.ledger.head(b.creature));
    expect(head).toMatchObject({ activeMs: before.activeMs + 1000, biomass: CALM.biomass });
    const kinds = await sql<{ kind: string }>(
      'SELECT kind FROM records WHERE creature = ? ORDER BY seq',
      b.creature,
    );
    expect(kinds.map((r) => r.kind)).toEqual(['genesis', 'checkpoint']);
    // The window closes unanswered: the fight starts from the clock the checkpoint holds.
    await advance(E.lockAnswerMs);
    const start = await nextOf(a.c, 'enc-start');
    const row = await logRow(start.enc);
    const slot = start.fighters.findIndex((f) => f.player === b.id.playerId);
    expect(row?.fighters[slot]?.activeMs).toBe(before.activeMs + 1000);
  });
});

describe('life across a sign-in during the fight', () => {
  it('`progress` writes nothing through a close and a sign-in, and the condition and clock stay as at the lock', async () => {
    const [a, b] = await fighters();
    const start = await outOfReach(a, b);
    await play(a, b, start, IDLE, 3);
    const atLock = await lifeOn(b);
    if (!atLock) throw new Error('no life');
    const rows = await rowsBesideLog();
    b.ticks += 3 * TICK_HZ;
    report(b.c, b.ticks, { biomass: 1, energy: 1, health: 1 });
    expect((await nextOf(b.c, 'ack')).activeMs).toBe(atLock.activeMs);
    const vitals = ({ biomass, energy, health, activeMs, n, savedN }: typeof atLock) => ({
      biomass,
      energy,
      health,
      activeMs,
      unsaved: n > savedN,
    });
    expect(vitals((await lifeOn(b)) ?? atLock)).toEqual(vitals(atLock));
    await leave(b);
    const back = await signInAgain(b);
    await expectResume(back.got, b, start);
    expect(await rowsBesideLog()).toBe(rows);
    const life = back.got.find((m) => m.t === 'life');
    expect(life?.t === 'life' && life.life?.activeMs).toBe(atLock.activeMs);
    expect(vitals((await lifeOn(b)) ?? atLock)).toEqual(vitals(atLock));
  });

  it('refuses every locked action after the sign-in, and allows them after the end', async () => {
    await setEnv(true);
    const [a, b] = await fighters();
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
    // B starves within a few seconds of the fight.
    await lockIn(a, b, snap(b, ...NEAR.b, { energy: 0, health: 0.01 }));
    await leave(b);
    const back = await signInAgain(b);
    expect(back.got.map((m) => m.t).slice(0, 3)).toEqual(['welcome', 'life', 'enc-start']);
    const answer = signMateAsk(b.id, {
      creature: b.creature,
      partner: a.id.playerId,
      partnerCreature: a.creature,
      nonce: ask.nonce,
    });
    const actions = lockedActions(b, answer);

    for (const send of actions) {
      send(back.c);
      const got = await flush(back.c);
      expect(got.filter((m) => m.t === 'refused' || m.t === 'mate-info')).toEqual([
        expect.objectContaining({ reason: 'locked' }),
      ]);
    }
    for (let i = 0; i < 30 && (await locked(b)); i++) await advance(1000);
    expect(await locked(b)).toBe(false);
    // A new rate window for the second round of messages.
    await advance(10_000);
    await flush(back.c);
    for (const send of actions) {
      send(back.c);
      const got = await flush(back.c);
      expect(got.filter((m) => 'reason' in m && m.reason === 'locked')).toEqual([]);
    }
  });
});

/** B's court, accept, mate-check, promote, restore and genesis, each a sender. */
function lockedActions(b: Player, answer: ReturnType<typeof signMateAsk>): ((c: Client) => void)[] {
  const signed = (who: Identity, req: RecordRequest) =>
    toBase64Url(who.sign(REQUEST_DOMAIN, requestMessage(req)));
  const promote: RecordRequest = {
    v: 1,
    rules: RULES_VERSION,
    kind: 'promote',
    creature: 'c'.repeat(64),
    seq: 1,
    prev: 'c'.repeat(64),
    owner: b.id.playerId,
    body: { role: 'child', parent: b.creature },
  };
  const restore: RecordRequest = {
    ...promote,
    kind: 'restore',
    body: {
      from: b.creature,
      activeMs: 0,
      biomass: 100,
      energy: 100,
      health: 100,
      cooldownUntilMs: 0,
    },
  };
  const court = signMateAsk(b.id, {
    creature: b.creature,
    partner: answer.partner,
    partnerCreature: answer.partnerCreature,
    nonce: freshNonce(),
  });
  return [
    (c) => c.send({ t: 'mate-check', partner: answer.partner }),
    (c) => c.send({ t: 'accept', ask: answer }),
    (c) => c.send({ t: 'court', ask: court }),
    (c) => c.send({ t: 'promote', request: promote, sig: signed(b.id, promote) }),
    (c) => c.send({ t: 'restore', request: restore, sig: signed(b.id, restore) }),
    (c) => c.send(genesisRequest(b.id)),
  ];
}
