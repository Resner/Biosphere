import { describe, expect, it } from 'vitest';
import { genomeToBase64url } from '../src/genome/codec';
import { starterGenome } from '../src/genome/starter';
import type { PubKey } from '../src/ledger/record';
import type { FightLog, SignedSettlement } from '../src/ledger/settlement';
import { encounterStartOf } from '../src/net/encounter-start';
import { verifyEncounter } from '../src/net/encounter-verify';
import type { FighterInfo, HubMsg } from '../src/net/protocol';
import { FRAME_MS } from '../src/net/referee';
import { createEncounter, hashEncounter, stepFrame } from '../src/sim/encounter/encounter';
import { RULES, TICK_HZ } from '../src/sim/rules';
import { ARCHETYPES } from '../tests/archetypes';
import { IDLE_CODE } from '../tests/encounter-fixture';
import { AWAY_GRACE_MS, awayGraceMs } from './away';
import {
  advance,
  advanceTo,
  authority,
  clock,
  type EncStart,
  editSession,
  fighters,
  hatched,
  join,
  lifeOn,
  locked,
  logRow,
  NEAR,
  type Plan,
  type Player,
  play,
  STAGE,
  startFight,
  startOf,
  useFightHub,
  within,
} from './fight-test-kit';
import { runFight } from './fights';
import { bear, mated, must } from './ledger-test-kit';
import { sendLife } from './lives';
import type { Session } from './socket';
import { type Client, flush, nextOf, placed, signIn, sql } from './test-hub';

// M8 T9: everyone left (ADR 0053). Once no fighter still in has a connected player, the fight runs
// on in real time for 10 s, then the authority finalizes the rest at once with the autopilot and
// settles it; a participant away at the end hears what happened at its next sign-in.

const E = RULES.encounter;
const STARTER = genomeToBase64url(starterGenome());
const HUNTER = genomeToBase64url(ARCHETYPES.hunter as NonNullable<typeof ARCHETYPES.hunter>);
const IDLE: Plan = () => [IDLE_CODE, IDLE_CODE];

useFightHub();

/** A fighter as lock-in would send it, in full health and energy, with the genome given. */
const info = (p: Player, genome: string, x: number, y: number, over: Partial<FighterInfo> = {}) =>
  ({
    player: p.id.playerId,
    creature: p.creature,
    genome,
    x,
    y,
    vx: 0,
    vy: 0,
    heading: 0,
    biomass: RULES.starter.biomass,
    energy: 150,
    health: 100,
    elder: false,
    egg: false,
    worth: 1,
    ...over,
  }) satisfies FighterInfo;

/** Two starter cells 30 wu apart: on the autopilot alone they fight for more than 30 s. */
const duel = (a: Player, b: Player) =>
  startFight(
    a,
    b,
    startOf(a, [info(a, STARTER, STAGE.x, STAGE.y), info(b, STARTER, STAGE.x + 30, STAGE.y)]),
  );

/** A's hunter beside B's starter at 1 hp: the autopilot kills B within a few frames. */
const hunt = (a: Player, b: Player, egg = false) =>
  startFight(
    a,
    b,
    startOf(a, [
      info(a, HUNTER, ...NEAR.a, { egg }),
      info(b, STARTER, ...NEAR.b, { health: 0.01, egg }),
    ]),
  );

/** Closes a player's socket, as closing the tab does. */
async function leave(p: Player): Promise<void> {
  p.c.ws.close(1000, 'gone');
  await p.c.closed;
}

/** Every message the client receives from now on, in order. */
function log(c: Client): HubMsg[] {
  const seen: HubMsg[] = [];
  c.ws.addEventListener('message', (e) => {
    seen.push(JSON.parse(String(e.data)) as HubMsg);
  });
  return seen;
}

/** The final frames the referee has given out for the fight A is in (null once it is over). */
const finalFrames = (p: Player) =>
  authority((o) => o.fights.ofPlayer(p.id.playerId)?.fight?.referee.next ?? null);

/** How many frames have passed their deadline in real time by now. */
const realFrames = (start: EncStart) =>
  Math.max(0, Math.floor((clock.t - start.at - E.inputDeadlineMs - 1) / FRAME_MS) + 1);

const pubkeys = () =>
  authority((o): PubKey[] => o.ledger.pubkeys().map((k) => ({ id: k.id, publicKey: k.publicKey })));

/** The stored settlement and log of a settled fight. */
async function settled(start: EncStart, pondSeed: string) {
  const row = await logRow(start.enc);
  if (!row?.settlement) throw new Error('no settlement stored');
  const fight: FightLog = { pondSeed, start: row.start, joins: row.joins, frames: row.frames };
  return { row, signed: JSON.parse(row.settlement) as SignedSettlement, log: fight };
}

/** Whether the creature's chain holds a record of the encounter. */
const holds = async (creature: string, enc: string) =>
  (
    await sql(
      "SELECT 1 FROM records WHERE creature = ? AND json_extract(json, '$.body.enc') = ?",
      creature,
      enc,
    )
  ).length > 0;

/** What a sign-in got: everything up to the answer to a ping. */
async function signInAgain(p: Player): Promise<{ c: Client; got: HubMsg[] }> {
  const { c } = await signIn(p.id);
  return { c, got: await flush(c) };
}

const lifeIn = (got: HubMsg[]) =>
  got.find((m): m is Extract<HubMsg, { t: 'life' }> => m.t === 'life');

/** Renames the player on its seated socket (the name its fight's log will hold). */
const rename = (p: Player, name: string) => editSession(p, (s) => ({ ...s, name }));

const setGrace = (ms: string | undefined) =>
  authority((o) => {
    const e = o.env as unknown as Record<string, string | undefined>;
    e.DRAND_SOURCE = ms === undefined ? undefined : 'fixture';
    e.AWAY_GRACE_MS = ms;
  });

describe('the wait', () => {
  it('is 10 s, shortened by `AWAY_GRACE_MS` only in fixture mode', () => {
    expect(AWAY_GRACE_MS).toBe(10_000);
    expect(awayGraceMs({})).toBe(10_000);
    expect(awayGraceMs({ AWAY_GRACE_MS: '500' })).toBe(10_000);
    expect(awayGraceMs({ DRAND_SOURCE: 'fixture', AWAY_GRACE_MS: '500' })).toBe(500);
    for (const bad of ['0', '-5', 'soon', '20000', '1.5', ''])
      expect(awayGraceMs({ DRAND_SOURCE: 'fixture', AWAY_GRACE_MS: bad })).toBe(10_000);
  });
});

describe('everyone left', () => {
  it('runs on null frames for 10 s, then finalizes the rest at once and settles it as playing them out would', async () => {
    const [a, b] = await fighters();
    const start = await duel(a, b);
    await play(a, b, start, IDLE, 5);
    await leave(a);
    await leave(b);
    const left = clock.t;
    // The watchdog holds the object's alarm no later than the fast-forward.
    const due = await authority((o) => o.fights.watchDue());
    expect(due).not.toBeNull();
    expect(due as number).toBeLessThanOrEqual(left + AWAY_GRACE_MS);

    await advanceTo(left + AWAY_GRACE_MS - 150);
    expect(await locked(a)).toBe(true);
    // Real time: no frame is final before its deadline.
    expect(await finalFrames(a)).toBe(realFrames(start));

    await advanceTo(left + AWAY_GRACE_MS + 150);
    expect(await locked(a)).toBe(false);
    expect(await locked(b)).toBe(false);
    expect(await authority((o) => o.fights.timers())).toBe(0);
    expect(await authority((o) => o.fights.watchDue())).toBeNull();

    const { row, signed, log: fight } = await settled(start, a.pond.seed);
    expect(row.open).toBe(false);
    expect(signed.settlement.frames).toBe(row.frames.length);
    // It ran far past the present: the duel lasts more than 30 s.
    expect(row.frames.length).toBeGreaterThan(realFrames(start) + 100);
    expect(row.frames.slice(5).every((i) => i.every((code) => code === null))).toBe(true);
    expect(verifyEncounter(signed, fight, await pubkeys())).toEqual([]);
    expect(await holds(a.creature, start.enc)).toBe(true);
    expect(await holds(b.creature, start.enc)).toBe(true);

    // The same fight played out in real time with nobody there: the 5 frames, then null to the end.
    const enc = createEncounter(must(encounterStartOf(start, a.pond.seed)));
    for (const i of row.frames.slice(0, 5)) stepFrame(enc, i);
    while (!enc.over) stepFrame(enc, [null, null]);
    expect(enc.frame).toBe(signed.settlement.frames);
    expect(hashEncounter(enc)).toBe(signed.settlement.hash);
  });

  it('a sign-in at 9 s resumes the fight, and no fast-forward happens', async () => {
    const [a, b] = await fighters();
    const start = await duel(a, b);
    await play(a, b, start, IDLE, 3);
    await leave(a);
    await leave(b);
    const left = clock.t;
    await advanceTo(left + 9000);
    const back = await signInAgain(b);
    expect(lifeIn(back.got)?.fight).toBe(start.enc);
    await advanceTo(left + AWAY_GRACE_MS + 2000);
    expect(await locked(b)).toBe(true);
    expect(await finalFrames(b)).toBe(realFrames(start));
    expect((await logRow(start.enc))?.open).toBe(true);
    // B leaves again: a new wait, from then.
    await leave({ ...b, c: back.c });
    const again = clock.t;
    await advanceTo(again + AWAY_GRACE_MS - 150);
    expect(await locked(b)).toBe(true);
    await advanceTo(again + AWAY_GRACE_MS + 150);
    expect(await locked(b)).toBe(false);
  });

  it('a fighter that escaped but stays connected doesn’t hold the fight in real time', async () => {
    const [a, b] = await fighters();
    const c = await hatched();
    await advance(16_000);
    const msg = startOf(a, [
      info(a, STARTER, STAGE.x, STAGE.y),
      info(b, STARTER, STAGE.x + 30, STAGE.y),
      // Far outside everyone's escape range: it escapes within its first frames.
      info(c, STARTER, STAGE.x, STAGE.y + 900),
    ]);
    const lives = await Promise.all([a, b, c].map((p) => lifeOn(p)));
    await authority((o) => {
      const players = [a, b, c].map((p) => p.id.playerId);
      const lock = o.fights.open(
        msg.enc,
        players,
        [a.creature, b.creature, c.creature],
        0,
        () => {},
      );
      expect(
        runFight(
          o,
          lock,
          msg,
          a.pond,
          lives.map((l) => must(l)),
        ),
      ).toBe(true);
      for (const ws of o.ctx.getWebSockets()) {
        if ((ws.deserializeAttachment() as Session | null)?.phase === 'active')
          ws.send(JSON.stringify(msg));
      }
    });
    await nextOf(c.c, 'enc-start');
    await advanceTo(msg.at + 4000);
    const status = await authority(
      (o) =>
        o.fights
          .ofPlayer(c.id.playerId)
          ?.fight?.enc.fighters.find((f) => f.player === c.id.playerId)?.status,
    );
    expect(status).toBe('escaped');
    await leave(a);
    await leave(b);
    const left = clock.t;
    await advanceTo(left + AWAY_GRACE_MS - 150);
    expect(await locked(c)).toBe(true);
    await advanceTo(left + AWAY_GRACE_MS + 150);
    expect(await locked(c)).toBe(false);
    const end = await within(nextOf(c.c, 'enc-end'), 'enc-end');
    expect(end.f).toBeGreaterThan(realFrames(msg) + 100);
  });
});

describe('the away report', () => {
  it('tells a participant away at the end once, in its next `life`, for one row; a connected one hears none', async () => {
    const [a, b] = await fighters();
    await rename(a, 'Nimbus');
    const start = await hunt(a, b);
    await leave(b);
    for (let i = 0; i < 30 && (await locked(a)); i++) await advance(FRAME_MS);
    expect(await locked(a)).toBe(false);
    const end = await nextOf(a.c, 'enc-end');
    const victim = end.fighters.find((f) => f.player === b.id.playerId);
    expect(victim).toMatchObject({ outcome: 'killed', egg: 'none' });

    const rows = () => authority((o) => o.ledger.rowsWritten);
    const before = await rows();
    const first = await signInAgain(b);
    const told = (await rows()) - before;
    expect(lifeIn(first.got)?.report).toEqual({
      enc: start.enc,
      outcome: 'killed',
      cause: 'killed',
      by: 'Nimbus',
      egg: 'none',
      eggBy: null,
      frames: end.f,
    });
    await leave({ ...b, c: first.c });
    const between = await rows();
    const second = await signInAgain(b);
    expect(lifeIn(second.got)?.report).toBeUndefined();
    // Telling costs one row more than a sign-in with nothing to tell.
    expect(told - ((await rows()) - between)).toBe(1);

    // A was there to see the end: nothing waits for it.
    await leave(a);
    const killer = await signInAgain(a);
    expect(lifeIn(killer.got)?.life?.creature).toBe(a.creature);
    expect(lifeIn(killer.got)?.report).toBeUndefined();
  });

  it('a socket that closes before its `life` is sent keeps the report, and the next sign-in hears it once', async () => {
    const [a, b] = await fighters();
    const start = await hunt(a, b);
    await leave(b);
    for (let i = 0; i < 30 && (await locked(a)); i++) await advance(FRAME_MS);
    expect(await locked(a)).toBe(false);
    const stored = () =>
      sql<{ fight_report: string }>(
        'SELECT fight_report FROM players WHERE id = ?',
        b.id.playerId,
      ).then((rows) => rows[0]?.fight_report ?? '');
    const kept = await stored();
    expect(kept).not.toBe('');
    // A sign-in whose socket closed before its `life` went out (seated from the queue as it left).
    await authority((o) => {
      const [, server] = Object.values(new WebSocketPair()) as [WebSocket, WebSocket];
      server.accept();
      server.close(1000, 'gone');
      sendLife(o, server, b.id.playerId);
    });
    expect(await stored()).toBe(kept);
    const first = await signInAgain(b);
    expect(lifeIn(first.got)?.report).toMatchObject({ enc: start.enc, outcome: 'killed' });
    expect(await stored()).toBe('');
    await leave({ ...b, c: first.c });
    expect(lifeIn((await signInAgain(b)).got)?.report).toBeUndefined();
  });

  it('a player killed while away gets `life: null`, a fallback that never offers its eaten child, and the report naming the killer', async () => {
    const [a, b] = await fighters();
    await authority((o) => {
      const heads = [must(o.ledger.head(a.creature)), must(o.ledger.head(b.creature))];
      bear(o.ledger, mated(o.ledger, heads[0] as never, heads[1] as never));
    });
    await rename(a, 'Nimbus');
    const start = await hunt(a, b, true);
    await leave(b);
    for (let i = 0; i < 30 && (await locked(a)); i++) await advance(FRAME_MS);
    const end = await nextOf(a.c, 'enc-end');
    expect(end.fighters.find((f) => f.player === b.id.playerId)).toMatchObject({
      outcome: 'killed',
      egg: 'eaten',
    });
    const { got } = await signInAgain(b);
    const life = lifeIn(got);
    expect(life?.life).toBeNull();
    expect(life?.pending).toBeUndefined();
    expect(life?.fallback?.pending ?? false).toBe(false);
    expect(life?.report).toMatchObject({
      enc: start.enc,
      outcome: 'killed',
      by: 'Nimbus',
      egg: 'eaten',
      eggBy: 'Nimbus',
    });
  });

  it('both away: each hears its own result', async () => {
    await setGrace('50');
    try {
      const [a, b] = await fighters();
      await rename(a, 'Nimbus');
      await rename(b, 'Mote');
      const start = await hunt(a, b);
      await leave(a);
      await leave(b);
      for (let i = 0; i < 30 && (await locked(a)); i++) await advance(FRAME_MS);
      expect(await locked(a)).toBe(false);
      const [ra, rb] = [lifeIn((await signInAgain(a)).got), lifeIn((await signInAgain(b)).got)];
      expect(ra?.report).toMatchObject({ enc: start.enc, outcome: 'stood', by: null });
      expect(rb?.report).toMatchObject({ enc: start.enc, outcome: 'killed', by: 'Nimbus' });
    } finally {
      await setGrace(undefined);
    }
  });
});

describe('carrion of a fast-forwarded kill', () => {
  it('reaches a spectator near the kill at the current tick, not the kill’s future one', async () => {
    await setGrace('50');
    try {
      const [a, b] = await fighters();
      const spectator = await join();
      await placed(spectator);
      const seen = log(spectator.c);
      const start = await hunt(a, b);
      // Both leave before frame 0 starts: the kill a few frames in is played at once.
      await leave(a);
      await leave(b);
      for (let i = 0; i < 30 && (await locked(a)); i++) await advance(FRAME_MS);
      expect(await locked(a)).toBe(false);
      const { signed } = await settled(start, a.pond.seed);
      const killTick = start.t0 + signed.settlement.frames * E.frameTicks;
      const now = Math.floor(((signed.settlement.t - a.pond.epoch) * TICK_HZ) / 1000);
      expect(now).toBeLessThan(killTick);
      const dropped = seen.filter((m) => m.t === 'carrion');
      expect(dropped).toHaveLength(1);
      expect(dropped[0]).toMatchObject({ enc: start.enc, tick: now });
    } finally {
      await setGrace(undefined);
    }
  });
});
