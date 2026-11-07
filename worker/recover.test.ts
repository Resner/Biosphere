import { runDurableObjectAlarm } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { type Identity, toBase64Url } from '../src/ledger/identity';
import { signMateAsk } from '../src/ledger/mating';
import { REQUEST_DOMAIN, type RecordRequest, requestMessage } from '../src/ledger/record';
import { encounterStartOf } from '../src/net/encounter-start';
import type { HubMsg } from '../src/net/protocol';
import { FRAME_MS } from '../src/net/referee';
import { hashEncounter } from '../src/sim/encounter/encounter';
import { replayEncounter } from '../src/sim/encounter/replay';
import { RULES, RULES_VERSION, TICK_HZ } from '../src/sim/rules';
import { IDLE_CODE } from '../tests/encounter-fixture';
import {
  advance,
  advanceTo,
  authority,
  CALM_SEED,
  CENTRE,
  clock,
  type EncEnd,
  type EncStart,
  engage,
  fighters,
  hatched,
  locked,
  lockIn,
  logRow,
  NEAR,
  outOfReach,
  type Plan,
  type Player,
  play,
  setEnv,
  slotOf,
  snap,
  useFightHub,
  within,
} from './fight-test-kit';
import { recoverFights } from './recover';
import {
  CALM,
  type Client,
  flush,
  freshNonce,
  genesisRequest,
  nextOf,
  report,
  sql,
  stub,
} from './test-hub';

// M8 T5: recovery after an authority restart (ADR 0053). A restart is simulated as the
// constructor sees it: the in-memory fights and locks are gone (their timers with them), the hub
// clock moves on by the outage, and `recoverFights` rebuilds every open fight from its saved log.

const E = RULES.encounter;
type EncFrame = Extract<HubMsg, { t: 'enc-frame' }>;
type EncJoin = Extract<HubMsg, { t: 'enc-join' }>;

useFightHub();

const IDLE: Plan = () => [IDLE_CODE, IDLE_CODE];

/** A restart after `outageMs` with the object down: nothing ticks in between. */
const restart = (outageMs = 0) =>
  authority((o) => {
    o.fights.clear();
    clock.advance(outageMs);
    recoverFights(o, o.clock.now());
  });

const fightOf = (p: Player) => authority((o) => o.fights.ofPlayer(p.id.playerId)?.fight ?? null);
const encHash = (p: Player) =>
  authority((o) => {
    const fight = o.fights.ofPlayer(p.id.playerId)?.fight;
    return fight ? hashEncounter(fight.enc) : null;
  });
const timers = () => authority((o) => o.fights.timers());

/** Every message `c` receives up to and including the next `enc-end`. */
async function untilEnd(c: Client): Promise<HubMsg[]> {
  const out: HubMsg[] = [];
  for (;;) {
    const msg = await within(c.next(), 'enc-end');
    out.push(msg);
    if (msg.t === 'enc-end') return out;
  }
}

/** What a client holds after the last resync: the repeated `enc-start`, then the frames and joins that follow. */
function afterResync(messages: HubMsg[], enc: string) {
  const at = messages.findLastIndex((m) => m.t === 'enc-start' && m.enc === enc);
  expect(at).toBeGreaterThanOrEqual(0);
  const rest = messages.slice(at + 1);
  return {
    start: messages[at] as EncStart,
    frames: rest.filter((m): m is EncFrame => m.t === 'enc-frame'),
    joins: rest.filter((m): m is EncJoin => m.t === 'enc-join'),
    end: rest.find((m): m is EncEnd => m.t === 'enc-end') ?? null,
  };
}

/** The fight replayed from what a client received, as the client steps it. */
function replayed(p: Player, held: ReturnType<typeof afterResync>): string {
  const start = encounterStartOf(held.start, p.pond.seed);
  if (!start) throw new Error('the start does not build');
  return replayEncounter({ rules: RULES_VERSION, start, frames: held.frames.map((m) => m.i) }).hash;
}

/** The records of encounter `enc` on the creature's chain. */
const encounterRecords = (creature: string, enc: string) =>
  sql<{ kind: string }>(
    "SELECT kind FROM records WHERE creature = ? AND json_extract(json, '$.body.enc') = ?",
    creature,
    enc,
  );

describe('recovery rebuilds the locks', () => {
  const signed = (who: Identity, req: RecordRequest) =>
    toBase64Url(who.sign(REQUEST_DOMAIN, requestMessage(req)));

  it('still refuses court, accept, mate-check, promote, restore and genesis with `locked`', async () => {
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
    await lockIn(a, b);
    await restart();
    expect(await locked(a)).toBe(true);
    expect(await locked(b)).toBe(true);
    expect(await authority((o) => o.fights.creatureLocked(b.creature))).toBe(true);

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
  });

  it('lets a third fighter join as before, refuses an engage between two fighters, and recovers the join', async () => {
    const [a, b] = await fighters();
    const c = await hatched();
    await advance(16_000);
    await sql('UPDATE ponds SET seed = ? WHERE id = ?', CALM_SEED, c.pond.id);
    c.pond = { ...c.pond, seed: CALM_SEED };
    const [start] = await lockIn(a, b, snap(b, ...NEAR.b, { health: 0.5, energy: 0 }));
    await play(a, b, start, IDLE, 2);
    await restart();
    // The two frames sent were not yet written: the referee resumes where the log ends.
    expect((await fightOf(a))?.referee.next).toBe((await logRow(start.enc))?.persisted);

    // Both already fighting: as before, nobody joins.
    engage(a, b);
    expect((await nextOf(a.c, 'refused')).reason).toBe('engage:locked');
    c.c.send({
      t: 'engage',
      target: a.id.playerId,
      mine: snap(c, CENTRE, CENTRE + 12, { health: 0.01, energy: 0 }),
      theirs: snap(a, ...NEAR.a),
    });
    expect(await within(nextOf(c.c, 'enc-start'), 'the joiner’s enc-start')).toEqual(start);
    const join = await within(nextOf(a.c, 'enc-join'), 'the join');
    expect(join.fighter.player).toBe(c.id.playerId);

    // Past the join's frame, the log flushed: a second restart rebuilds the joined fight exactly.
    await advanceTo(start.at + (join.f + 3) * FRAME_MS + E.inputDeadlineMs + 1);
    const before = await authority((o) => {
      const fight = o.fights.ofPlayer(a.id.playerId)?.fight;
      if (!fight) return null;
      o.fightStore.flush(fight);
      return { hash: hashEncounter(fight.enc), history: fight.history, next: fight.referee.next };
    });
    // The fight is seeded: it is still running here, past the join's frame.
    if (!before) throw new Error('the fight ended before the join');
    expect(before.next).toBeGreaterThan(join.f);
    await restart();
    expect(await locked(c)).toBe(true);
    const after = await fightOf(a);
    expect(after?.players).toHaveLength(3);
    expect(after?.referee.next).toBe(before.next);
    expect(after?.referee.width(join.f)).toBe(3);
    expect(after?.history).toEqual(before.history);
    expect(await encHash(a)).toBe(before.hash);
    // The joiner hears the fight again too, from its start.
    const heard = afterResync(await flush(c.c), start.enc);
    expect(heard.joins).toEqual([join]);
    expect(heard.frames.map((m) => m.f)).toEqual([...Array(before.next).keys()]);
  });
});

describe('recovery rebuilds the fight', () => {
  it('replays the log to the hash the authority had at the row’s frame', async () => {
    const [a, b] = await fighters();
    const start = await outOfReach(a, b);
    await play(a, b, start, IDLE, 20);
    expect((await logRow(start.enc))?.persisted).toBe(20);
    const hash = await encHash(a);
    // The encounter seats fighters in creature-id order, so the slots are not the start's order.
    const seated = (await fightOf(a))?.players;
    expect(seated).toHaveLength(2);
    await restart();
    const fight = await fightOf(a);
    expect(fight?.referee.next).toBe(20);
    expect(fight?.persisted).toBe(20);
    expect(fight?.players).toEqual(seated);
    expect(await encHash(a)).toBe(hash);
    expect(await timers()).toBe(1);
  });

  it('finalizes the frames of the outage as null, resyncs the connected, and plays on to the end', async () => {
    const [a, b] = await fighters();
    const start = await outOfReach(a, b);
    // 25 frames sent, 20 written: the last 5 are lost with the object.
    await play(a, b, start, IDLE, 25);
    expect((await logRow(start.enc))?.persisted).toBe(20);
    const down = clock.t;
    await restart(2000);
    const due = Math.floor((down + 2000 - start.at - E.inputDeadlineMs - 1) / FRAME_MS) + 1;
    const fight = await fightOf(a);
    expect(fight?.referee.next).toBe(due);
    const row = await logRow(start.enc);
    expect(row?.frames.slice(20)).toEqual(
      Array.from({ length: (row?.persisted ?? 0) - 20 }, () => [null, null]),
    );
    // To the timeout, every frame null from here on.
    await advanceTo(start.at + E.timeoutFrames * FRAME_MS + E.inputDeadlineMs + 1);
    for (const p of [a, b]) {
      const held = afterResync(await untilEnd(p.c), start.enc);
      expect(held.start).toEqual(start);
      expect(held.frames.map((m) => m.f)).toEqual([...Array(held.end?.f).keys()]);
      for (const m of held.frames.slice(20)) expect(m.i).toEqual([null, null]);
      expect(held.frames.slice(0, 20).every((m) => m.i.every((i) => i === IDLE_CODE))).toBe(true);
      expect(replayed(p, held)).toBe(held.end?.hash);
    }
    expect(await locked(a)).toBe(false);
    expect(await timers()).toBe(0);
    expect((await logRow(start.enc))?.open).toBe(false);
  });

  it('takes no input for a frame finalized before or during the outage: `late`, and the bundle keeps null', async () => {
    const [a, b] = await fighters();
    const start = await outOfReach(a, b);
    await play(a, b, start, IDLE, 20);
    await restart(1000);
    const fight = await fightOf(a);
    const next = fight?.referee.next ?? 0;
    expect(next).toBeGreaterThan(25);
    const sa = slotOf(start, a);
    // Through the socket: nothing changes.
    a.c.send({ t: 'input', enc: start.enc, f: 22, i: 7 });
    a.c.send({ t: 'input', enc: start.enc, f: 5, i: 7 });
    await flush(a.c);
    const after = await authority((o) => {
      const f = o.fights.ofPlayer(a.id.playerId)?.fight;
      if (!f) return null;
      return {
        verdicts: [5, 22, next - 1].map((frame) => f.referee.input(sa, frame, 7, o.clock.now())),
        bundles: f.history.flatMap((m) => (m.t === 'enc-frame' ? [m] : [])),
      };
    });
    expect(after?.verdicts).toEqual(['late', 'late', 'late']);
    expect(after?.bundles[22]?.i[sa]).toBeNull();
    expect(after?.bundles[5]?.i[sa]).toBe(IDLE_CODE);
  });

  it('settles at recovery a fight whose timeout passed while the object was down', async () => {
    const [a, b] = await fighters();
    const start = await outOfReach(a, b);
    await play(a, b, start, IDLE, 5);
    await restart(E.timeoutFrames * FRAME_MS + 1000);
    expect(await locked(a)).toBe(false);
    expect(await timers()).toBe(0);
    const row = await logRow(start.enc);
    expect(row?.open).toBe(false);
    expect(row?.frames.slice(5).every((i) => i.every((code) => code === null))).toBe(true);
    for (const p of [a, b]) {
      const held = afterResync(await untilEnd(p.c), start.enc);
      // The autopilot may end it before the timeout, whatever the outcome.
      expect(held.end?.f).toBe(row?.persisted);
      expect(held.end?.f).toBeLessThanOrEqual(E.timeoutFrames);
      expect(replayed(p, held)).toBe(held.end?.hash);
      expect((await encounterRecords(p.creature, start.enc)).length).toBeGreaterThan(0);
    }
  });

  it('with no socket and no message, the watchdog alarm wakes recovery and the fight settles', async () => {
    const [a, b] = await fighters();
    const start = await outOfReach(a, b);
    await play(a, b, start, IDLE, 5);
    const watch = start.at + E.timeoutFrames * FRAME_MS + 1000;
    expect(await authority((o) => o.fights.watchDue())).toBe(watch);
    expect(await authority((o) => o.ctx.storage.getAlarm())).toBe(watch);
    for (const p of [a, b]) {
      p.c.ws.close(1000, 'gone');
      await p.c.closed;
    }
    // Evicted: the fight is gone from memory, and nothing wakes the object until its alarm.
    await authority((o) => o.fights.clear());
    await advanceTo(watch);
    expect(await runDurableObjectAlarm(stub())).toBe(true);
    expect((await logRow(start.enc))?.open).toBe(false);
    for (const p of [a, b]) {
      expect((await encounterRecords(p.creature, start.enc)).length).toBeGreaterThan(0);
    }
    expect(await locked(a)).toBe(false);
    expect(await timers()).toBe(0);
    expect(await authority((o) => o.fights.watchDue())).toBeNull();
    expect(await authority((o) => o.ctx.storage.getAlarm())).not.toBe(watch);
  });
});

describe('a fight whose saved log no longer rebuilds', () => {
  it('is flagged once and closed; both are free to engage again and hear `enc-end` without a settlement, then `life`', async () => {
    const [a, b] = await fighters();
    const start = await outOfReach(a, b);
    await play(a, b, start, IDLE, 10);
    // The start no longer decodes: one fighter's genome is no longer base64url.
    await sql(
      "UPDATE encounters SET start = json_set(start, '$.fighters[0].genome', '*') WHERE id = ?",
      start.enc,
    );
    const records = await sql<{ n: number }>('SELECT COUNT(*) AS n FROM records');
    await restart();
    const flagged = () =>
      sql('SELECT * FROM flags WHERE kind = ? AND hash = ?', 'recover-failed', start.enc);
    expect(await flagged()).toHaveLength(1);
    expect((await logRow(start.enc))?.open).toBe(false);
    expect(await sql<{ n: number }>('SELECT COUNT(*) AS n FROM records')).toEqual(records);
    for (const p of [a, b]) {
      expect(await locked(p)).toBe(false);
      const got = (await flush(p.c)).filter((m) => m.t === 'enc-end' || m.t === 'life');
      expect(got.map((m) => m.t)).toEqual(['enc-end', 'life']);
      const [end, life] = got as [EncEnd, Extract<HubMsg, { t: 'life' }>];
      expect(end.enc).toBe(start.enc);
      expect(end.settlement).toBeUndefined();
      expect(end.fighters.map((f) => f.player).sort()).toEqual(
        [a.id.playerId, b.id.playerId].sort(),
      );
      expect(life.fight).toBeUndefined();
      expect(life.life?.creature).toBe(p.creature);
    }
    expect(await timers()).toBe(0);
    // A second recovery finds nothing open: still one flag.
    await restart();
    expect(await flagged()).toHaveLength(1);
    // Free again: A's engage asks B.
    engage(a, b);
    expect((await within(nextOf(b.c, 'lock-ask'), 'lock-ask')).t).toBe('lock-ask');
  });
});

describe('recovery leaves alone', () => {
  it('a running fight a lock-in started, whose lock has its own id: an alarm keeps its row open', async () => {
    const [a, b] = await fighters();
    const [start] = await lockIn(a, b, snap(b, ...NEAR.b, { health: 0.5 }));
    await authority((o) => recoverFights(o, o.clock.now()));
    await runDurableObjectAlarm(stub());
    expect((await logRow(start.enc))?.open).toBe(true);
    // ... so a restart still rebuilds it.
    await restart();
    expect((await fightOf(a))?.enc.id).toBe(start.enc);
  });

  it('a settled fight', async () => {
    const [a, b] = await fighters();
    const [start] = await lockIn(a, b, snap(b, ...NEAR.b, { energy: 0, health: 0.01 }));
    const played = await play(a, b, start, IDLE);
    expect(played.ends).not.toBeNull();
    await restart();
    expect(await locked(a)).toBe(false);
    expect(await locked(b)).toBe(false);
    expect(await timers()).toBe(0);
    for (const p of [a, b]) expect((await flush(p.c)).map((m) => m.t)).not.toContain('enc-start');
  });

  it('a fight whose records are written though its row stayed open (a close before M8 T8 that failed)', async () => {
    const [a, b] = await fighters();
    const [start] = await lockIn(a, b, snap(b, ...NEAR.b, { energy: 0, health: 0.01 }));
    const played = await play(a, b, start, IDLE);
    expect(played.ends).not.toBeNull();
    // The settlement closes the row in its transaction now; a row left by the earlier separate close.
    await sql('UPDATE encounters SET open = 1, settlement = NULL WHERE id = ?', start.enc);
    const rows = await encounterRecords(a.creature, start.enc);
    await restart();
    expect(await locked(a)).toBe(false);
    expect(await timers()).toBe(0);
    expect((await logRow(start.enc))?.open).toBe(false);
    expect(await encounterRecords(a.creature, start.enc)).toEqual(rows);
    for (const p of [a, b]) expect((await flush(p.c)).map((m) => m.t)).not.toContain('enc-start');
  });

  it('a lock still waiting for its answer: no lock, no row and no fight', async () => {
    const [a, b] = await fighters();
    const count = (await sql<{ n: number }>('SELECT COUNT(*) AS n FROM encounters'))[0]?.n;
    engage(a, b);
    await nextOf(b.c, 'lock-ask');
    await restart();
    expect(await locked(a)).toBe(false);
    expect(await locked(b)).toBe(false);
    expect(await timers()).toBe(0);
    await advance(E.lockAnswerMs);
    for (const p of [a, b]) expect((await flush(p.c)).map((m) => m.t)).not.toContain('enc-start');
    expect((await sql<{ n: number }>('SELECT COUNT(*) AS n FROM encounters'))[0]?.n).toBe(count);
  });
});
