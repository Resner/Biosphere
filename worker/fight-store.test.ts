import { describe, expect, it, vi } from 'vitest';
import { encounterStartOf } from '../src/net/encounter-start';
import type { HubMsg } from '../src/net/protocol';
import { FRAME_MS } from '../src/net/referee';
import { hashEncounter } from '../src/sim/encounter/encounter';
import { replayEncounter } from '../src/sim/encounter/replay';
import { RULES, RULES_VERSION } from '../src/sim/rules';
import { IDLE_CODE } from '../tests/encounter-fixture';
import { heavyTest } from '../tests/heavy';
import { BATCH_FRAMES, type FightRow } from './fight-store';
import {
  advance,
  advanceTo,
  authority,
  type EncEnd,
  type EncFrame,
  type EncStart,
  engage,
  fighters,
  hatched,
  lifeOn,
  locked,
  lockIn,
  logRow,
  NEAR,
  outOfReach,
  type Plan,
  type Player,
  play,
  slotOf,
  snap,
  useFightHub,
  within,
} from './fight-test-kit';
import type { Session } from './socket';
import { flush, nextOf, rowsWritten, sql } from './test-hub';

// M8 T2: the authority saves each fight's log as it runs (ADR 0053): the row is in before
// `enc-start`, frames follow in batches of `BATCH_FRAMES`, a join is in before `enc-join`, a
// participant's close flushes the tail, and the end closes the row.

const E = RULES.encounter;
type EncJoin = Extract<HubMsg, { t: 'enc-join' }>;

useFightHub();

const IDLE: Plan = () => [IDLE_CODE, IDLE_CODE];

/** The row, which must exist. */
async function rowOf(enc: string): Promise<FightRow> {
  const row = await logRow(enc);
  if (!row) throw new Error(`no row for ${enc}`);
  return row;
}

/** The saved log replayed from its start, frames and joins, as a verifier would. */
function replayed(row: FightRow, seed: string): string {
  const start = encounterStartOf(row.start, seed);
  if (!start) throw new Error('the saved start does not build');
  return replayEncounter({ rules: RULES_VERSION, start, frames: row.frames }).hash;
}

const encounterRows = () =>
  sql<{ n: number }>('SELECT COUNT(*) AS n FROM encounters').then((r) => r[0]?.n ?? 0);

/** The player's name on its session. */
const nameOf = (p: Player) =>
  authority((o) => {
    for (const ws of o.ctx.getWebSockets()) {
      const s = ws.deserializeAttachment() as Session | null;
      if (s?.phase === 'active' && s.playerId === p.id.playerId) return s.name;
    }
    return '';
  });

describe('the saved fight log', () => {
  it('writes nothing in the lock-answer window, then holds the `enc-start` the clients got', async () => {
    const [a, b] = await fighters();
    const rows = await rowsWritten();
    const count = await encounterRows();
    engage(a, b);
    await nextOf(b.c, 'lock-ask');
    await advance(E.lockAnswerMs - 1);
    expect(await rowsWritten()).toBe(rows);
    expect(await encounterRows()).toBe(count);
    await advance(1);
    const [sa, sb] = await Promise.all([nextOf(a.c, 'enc-start'), nextOf(b.c, 'enc-start')]);
    expect(sa).toEqual(sb);
    const row = await rowOf(sa.enc);
    expect(row).toMatchObject({
      id: sa.enc,
      pond: a.pond.id,
      start: sa,
      joins: [],
      frames: [],
      persisted: 0,
      open: true,
      settlement: null,
    });
    // Each slot's name and life clock at the start.
    for (const p of [a, b]) {
      const life = await lifeOn(p);
      expect(row.fighters[slotOf(sa, p)]).toEqual({
        name: await nameOf(p),
        activeMs: life?.activeMs,
        lifespanMs: life?.lifespanMs,
      });
    }
    expect(await authority((o) => o.fights.ofPlayer(a.id.playerId)?.fight?.persisted)).toBe(0);
    // Migration 7 also gives every player an empty away report (told from T9).
    const [player] = await sql('SELECT fight_report FROM players WHERE id = ?', a.id.playerId);
    expect(player?.fight_report).toBe('');
  });

  it('sends no `enc-start` when the insert fails: the lock goes and the attacker is refused', async () => {
    const [a, b] = await fighters();
    await authority((o) => {
      vi.spyOn(o.fightStore, 'open').mockImplementation(() => {
        throw new Error('disk full');
      });
    });
    engage(a, b);
    await nextOf(b.c, 'lock-ask');
    await advance(E.lockAnswerMs);
    expect((await nextOf(a.c, 'refused')).reason).toBe('engage:stale');
    expect((await flush(a.c)).map((m) => m.t)).not.toContain('enc-start');
    expect((await flush(b.c)).map((m) => m.t)).not.toContain('enc-start');
    expect(await locked(a)).toBe(false);
    expect(await locked(b)).toBe(false);
    expect(await authority((o) => o.fights.timers())).toBe(0);
  });

  it('holds 30 frames after 35 and 40 after 40, which replay to the authority’s hash', async () => {
    const [a, b] = await fighters();
    const start = await outOfReach(a, b);
    const first = await play(a, b, start, IDLE, 35);
    expect(first.ends).toBeNull();
    // The bundles keep their order through the batch writes.
    expect(first.frames[0].map((m) => m.f)).toEqual([...Array(35).keys()]);
    let row = await rowOf(start.enc);
    expect(row.persisted).toBe(30);
    expect(row.frames).toEqual(first.frames[0].slice(0, 30).map((m) => m.i));
    expect(await authority((o) => o.fights.ofPlayer(a.id.playerId)?.fight?.persisted)).toBe(30);

    const second = await play(a, b, start, IDLE, 5, 35);
    expect(second.ends).toBeNull();
    row = await rowOf(start.enc);
    expect(row.persisted).toBe(40);
    expect(row.frames).toEqual([...first.frames[0], ...second.frames[0]].map((m) => m.i));
    const hash = await authority((o) => {
      const fight = o.fights.ofPlayer(a.id.playerId)?.fight;
      return fight ? hashEncounter(fight.enc) : '';
    });
    expect(replayed(row, a.pond.seed)).toBe(hash);
  });

  it('flushes every final frame when a participant’s socket closes', async () => {
    const [a, b] = await fighters();
    const start = await outOfReach(a, b);
    const played = await play(a, b, start, IDLE, 13);
    expect((await rowOf(start.enc)).persisted).toBe(10);
    b.c.ws.close(1000, 'gone');
    await b.c.closed;
    let row = await rowOf(start.enc);
    for (let i = 0; i < 50 && row.persisted < 13; i++) row = await rowOf(start.enc);
    expect(row.persisted).toBe(13);
    expect(row.frames).toEqual(played.frames[0].map((m) => m.i));
    expect(row.open).toBe(true);
  });

  it('closes the row at the end with the whole log', async () => {
    const [a, b] = await fighters();
    const [start] = await lockIn(a, b, snap(b, ...NEAR.b, { energy: 0, health: 0.01 }));
    const played = await play(a, b, start, IDLE);
    const [end] = played.ends as [EncEnd, EncEnd];
    const row = await rowOf(start.enc);
    expect(row.open).toBe(false);
    expect(row.persisted).toBe(end.f);
    expect(row.frames).toEqual(played.frames[0].map((m) => m.i));
    expect(replayed(row, a.pond.seed)).toBe(end.hash);
    expect(await sql('SELECT id FROM encounters WHERE open = 1 AND id = ?', start.enc)).toEqual([]);
  });

  heavyTest(
    'a 30 s duel with no close writes at most 34 rows from the lock to its end, beside the settlement',
    async () => {
      const [a, b] = await fighters();
      const settled = { rows: 0 };
      await authority((o) => {
        const ledger = o.ledger;
        const settle = ledger.settle.bind(ledger);
        vi.spyOn(ledger, 'settle').mockImplementation((input) => {
          const before = ledger.rowsWritten;
          try {
            return settle(input);
          } finally {
            settled.rows += ledger.rowsWritten - before;
          }
        });
      });
      const rows = await rowsWritten();
      const start = await outOfReach(a, b);
      const frames = 300 - 1;
      const first = await play(a, b, start, IDLE, frames);
      expect(first.ends).toBeNull();
      // Out of reach nobody can end it: B starves on the authority's copy in the 30th second.
      await authority((o) => {
        const fight = o.fights.ofPlayer(a.id.playerId)?.fight;
        const body = fight?.enc.fighters[slotOf(start, b)]?.body;
        if (!body) throw new Error('no fight');
        body.energy = 0;
        body.health = 0.001;
      });
      const rest = await play(a, b, start, IDLE, 20, frames);
      const ends = rest.ends as [EncEnd, EncEnd];
      expect(ends).not.toBeNull();
      expect(ends[0].f).toBeGreaterThanOrEqual(300);
      expect(ends[0].f).toBeLessThan(310);
      expect(settled.rows).toBeGreaterThan(0);
      const used = (await rowsWritten()) - rows - settled.rows;
      console.log(`fight log rows for a ${ends[0].f}-frame duel: ${used}`);
      expect(used).toBeLessThanOrEqual(34);
      expect((await rowOf(start.enc)).open).toBe(false);
    },
  );
});

describe('a join', () => {
  /** Three players whose hatch protection is over, in the calm `timeout` pond. */
  async function three(): Promise<[Player, Player, Player]> {
    const out: Player[] = [];
    for (let i = 0; i < 3; i++) out.push(await hatched());
    await advance(16_000);
    await sql("UPDATE ponds SET seed = 'calm-79' WHERE id = ?", (out[0] as Player).pond.id);
    for (const p of out) p.pond = { ...p.pond, seed: 'calm-79' };
    return out as [Player, Player, Player];
  }

  /** A and B fight with two frames final, then C engages A from close by. */
  async function joining(): Promise<{ a: Player; b: Player; c: Player; start: EncStart }> {
    const [a, b, c] = await three();
    const [start] = await lockIn(a, b, snap(b, ...NEAR.b, { health: 0.5, energy: 0 }));
    await advanceTo(start.at + FRAME_MS + E.inputDeadlineMs + 1);
    for (const p of [a, b]) {
      await within(Promise.all([nextOf(p.c, 'enc-frame'), nextOf(p.c, 'enc-frame')]), 'two frames');
    }
    c.c.send({
      t: 'engage',
      target: a.id.playerId,
      mine: snap(c, 1000, 1012, { health: 0.01, energy: 0 }),
      theirs: snap(a, ...NEAR.a),
    });
    return { a, b, c, start };
  }

  it('is in the row, with the joiner’s clock, by the time the joiner hears the fight', async () => {
    const { a, c, start } = await joining();
    const heard = await within(nextOf(c.c, 'enc-start'), 'the joiner’s enc-start');
    expect(heard).toEqual(start);
    const row = await rowOf(start.enc);
    expect(row.joins).toHaveLength(1);
    const join = row.joins[0] as EncJoin;
    expect(join.fighter.player).toBe(c.id.playerId);
    expect(await within(nextOf(a.c, 'enc-join'), 'the join')).toEqual(join);
    const life = await lifeOn(c);
    expect(row.fighters[2]).toEqual({
      name: await nameOf(c),
      activeMs: life?.activeMs,
      lifespanMs: life?.lifespanMs,
    });
  });

  it('sends nothing when the write fails: the joiner is refused and nobody hears a join', async () => {
    await authority((o) => {
      vi.spyOn(o.fightStore, 'join').mockImplementation(() => {
        throw new Error('disk full');
      });
    });
    const { a, b, c, start } = await joining();
    expect((await nextOf(c.c, 'refused')).reason).toBe('engage:stale');
    expect((await flush(c.c)).map((m) => m.t)).not.toContain('enc-start');
    for (const p of [a, b]) {
      expect((await flush(p.c)).map((m) => m.t)).not.toContain('enc-join');
    }
    expect(await locked(c)).toBe(false);
    expect((await rowOf(start.enc)).joins).toEqual([]);
    expect(await authority((o) => o.fights.ofPlayer(a.id.playerId)?.fight?.players.length)).toBe(2);
  });
});

describe('a fight that runs on', () => {
  it('appends in batches while a fighter is away, and only frames the referee made final', async () => {
    const [a, b] = await fighters();
    const start = await outOfReach(a, b);
    // Both silent: each frame waits for its deadline.
    await advanceTo(start.at + (BATCH_FRAMES + 2) * FRAME_MS + E.inputDeadlineMs + 1);
    const frames: EncFrame[] = [];
    for (let i = 0; i < BATCH_FRAMES + 3; i++) frames.push(await nextOf(a.c, 'enc-frame'));
    const row = await rowOf(start.enc);
    expect(row.persisted).toBe(BATCH_FRAMES);
    expect(row.frames).toEqual(frames.slice(0, BATCH_FRAMES).map((m) => m.i));
  });
});
