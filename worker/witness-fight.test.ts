import { describe, expect, it } from 'vitest';
import type { SignedSettlement } from '../src/ledger/settlement';
import { signWitnessFrame } from '../src/ledger/witness';
import { encounterStartOf } from '../src/net/encounter-start';
import { settlementOf } from '../src/net/encounter-verify';
import { AUTHORITY, RefereeSpans } from '../src/net/handover';
import type { HubMsg } from '../src/net/protocol';
import { FRAME_MS } from '../src/net/referee';
import type { BatchMsg } from '../src/net/witness-referee';
import { createEncounter, stepFrame } from '../src/sim/encounter/encounter';
import { RULES } from '../src/sim/rules';
import { drive, IDLE_CODE } from '../tests/encounter-fixture';
import { AWAY_GRACE_MS } from './away';
import { witnessView } from './duty';
import {
  advance,
  advanceTo,
  authority,
  clock,
  type EncEnd,
  type EncStart,
  fighters,
  hatched,
  lockIn,
  NEAR,
  outOfReach,
  type Player,
  slotOf,
  snap,
  useFightHub,
  within,
} from './fight-test-kit';
import { recoverFights } from './recover';
import { publish, sql } from './test-hub';
import { commitWitnesses, STRIKE_MS } from './witness-pool';
import {
  byPlayer,
  orderOf,
  refereeDuty,
  type ScriptedWitness,
  useWitnessHub,
  type Witness,
  witnessCommit,
  witnesses,
} from './witness-test-kit';

// M10 T5: the authority hands fights to witnesses and takes them back (ADR 0058), on the hand
// clock. A locks B in and hunts it while B idles; the witness commitment's round is published at
// once, so the referee duty is offered before frame 0. A scripted witness (`ScriptedWitness`)
// takes it, referees from `h`, and batches to the hub; the fighters' inputs reach it directly.

useFightHub();
useWitnessHub();

const E = RULES.encounter;
type EncReferee = Extract<HubMsg, { t: 'enc-referee' }>;

/** A fighter's view of the fight's wire: its frames, handovers and end, and everything else it heard. */
class Seat {
  readonly frames: (number | null)[][] = [];
  readonly referees: EncReferee[] = [];
  readonly spans = new RefereeSpans();
  readonly other: HubMsg[] = [];
  end: EncEnd | null = null;

  constructor(
    readonly p: Player,
    readonly enc: string,
  ) {}

  private take(m: HubMsg): void {
    if (m.t === 'enc-frame' && m.enc === this.enc) {
      expect(m.f, 'frames arrive in order').toBe(this.frames.length);
      this.frames.push(m.i);
    } else if (m.t === 'enc-referee' && m.enc === this.enc) {
      this.referees.push(m);
      this.spans.hand(m.by, m.from);
    } else if (m.t === 'enc-end' && m.enc === this.enc) {
      this.end = m;
    } else if (m.t === 'enc-start' && m.enc === this.enc) {
      // A resync: the history follows from frame 0.
      this.frames.length = 0;
    } else {
      this.other.push(m);
    }
  }

  drain(): void {
    for (const m of this.p.c.inbox.splice(0)) this.take(m);
  }

  async until(done: () => boolean, what: string): Promise<void> {
    this.drain();
    while (!done()) this.take(await within(this.p.c.next(), what));
  }

  /** Waits until it holds frame `f` (or the fight ended). */
  frame(f: number): Promise<void> {
    return this.until(() => this.frames.length > f || this.end !== null, `frame ${f}`);
  }
}

interface Run {
  a: Player;
  b: Player;
  start: EncStart;
  event: string;
  commitId: string;
  ws: Witness[];
  /** The witness at each position of the order. */
  at: (position: number) => Witness;
  seats: [Seat, Seat];
  /** The next frame to play. */
  next: number;
  plan: (f: number) => [number, number];
}

/** A hunts: it swims at B with its weapon aimed, while B idles (codes by slot). */
function hunt(start: EncStart, b: Player): (f: number) => number[] {
  const a = drive(0, 15, { stance: 'aggressive', target: slotOf(start, b) });
  return () => (slotOf(start, b) === 1 ? [a, IDLE_CODE] : [IDLE_CODE, a]);
}

/** Polls until `read` gives a value. */
async function waitFor<T>(read: () => Promise<T | null>, what: string): Promise<T> {
  for (let i = 0; i < 100; i++) {
    const v = await read();
    if (v !== null) return v;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`never got ${what}`);
}

/**
 * A fight with `n` witnesses online, its witness round published. `hunt`: A locks B in (B at
 * `health`) and hunts it until B dies. `calm`: both idle out of reach (`outOfReach`), which even
 * the autopilot keeps calm for its 90 s, so frames the autopilot plays never end it early.
 */
async function witnessed(n: number, kind: 'hunt' | 'calm', health = 0.3): Promise<Run> {
  const [a, b] = await fighters();
  const ws = await witnesses(n);
  let start: EncStart;
  if (kind === 'hunt') {
    [start] = await lockIn(a, b, snap(b, ...NEAR.b, { health }), snap(a, ...NEAR.a, { health: 1 }));
  } else {
    start = await outOfReach(a, b);
    await authority((o) => commitWitnesses(o, 'enc', start.enc, [a.id.playerId, b.id.playerId]));
  }
  const event = `enc:${start.enc}`;
  const commit = await waitFor(() => witnessCommit(event), 'the witness commitment');
  const order = orderOf(commit, commit.id);
  await publish(commit.commitment.round);
  const seats: [Seat, Seat] = [new Seat(a, start.enc), new Seat(b, start.enc)];
  const slots = [slotOf(start, a), slotOf(start, b)];
  const plan = kind === 'hunt' ? hunt(start, b) : () => [IDLE_CODE, IDLE_CODE];
  return {
    a,
    b,
    start,
    event,
    commitId: commit.id,
    ws,
    at: (p) => byPlayer(ws, order[p]),
    seats,
    next: 0,
    // Codes by player (A, B), whatever their slots.
    plan: (f) => {
      const codes = plan(f);
      return [codes[slots[0] as number] as number, codes[slots[1] as number] as number];
    },
  };
}

/** Both fighters leave: the authority plays the rest out after the wait (ADR 0053); its settlement. */
async function settleAway(r: Run) {
  for (const p of [r.a, r.b]) {
    p.c.ws.close(1000, 'bye');
    await p.c.closed;
  }
  await advance(AWAY_GRACE_MS + 1000);
  const signed = await waitFor(
    () => authority((o) => o.fightStore.settlement(r.start.enc)),
    'the settlement',
  );
  return signed.settlement;
}

const startOfFrame = (r: Run, f: number) => r.start.at + f * FRAME_MS;

/**
 * Plays frames up to `to − 1` (or the fight's end): each fighter's input goes one frame ahead to the
 * frame's referee as the fighters heard it (the hub, or the witness, signed). A hub frame is waited
 * for; a witness's batch, unless `echo` is off, is waited for as the hub's echo.
 */
async function playTo(r: Run, to: number, sw: ScriptedWitness | null, echo = true): Promise<void> {
  for (let f = r.next; f < to && !r.seats[0].end; f++) {
    await advanceTo(startOfFrame(r, f) - FRAME_MS);
    for (const s of r.seats) s.drain();
    const codes = r.plan(f);
    r.next = f + 1;
    if (r.seats[0].spans.refereeOf(f) === AUTHORITY) {
      [r.a, r.b].forEach((p, k) =>
        p.c.send({ t: 'input', enc: r.start.enc, f, i: codes[k] as number }),
      );
      await Promise.all(r.seats.map((s) => s.frame(f)));
      continue;
    }
    if (!sw) throw new Error('no witness');
    await sw.catchUp();
    const before = sw.sent.length;
    [r.a, r.b].forEach((p, k) => sw.input(p, f, codes[k] as number));
    sw.tick();
    const batch = sw.sent[sw.sent.length - 1];
    if (echo && batch && sw.sent.length > before) {
      const last = batch.f + batch.i.length - 1;
      await Promise.all(r.seats.map((s) => s.frame(last)));
    }
  }
}

/** Plays the fight to its end, then both fighters' `enc-end`. */
async function playOut(r: Run, sw: ScriptedWitness | null): Promise<EncEnd> {
  await playTo(r, E.timeoutFrames, sw);
  await Promise.all(r.seats.map((s) => s.until(() => s.end !== null, 'enc-end')));
  return r.seats[0].end as EncEnd;
}

/** The fight's witness phase on the object. */
const phaseOf = (r: Run) =>
  authority((o) => {
    const fight = o.fights.ofPlayer(r.a.id.playerId)?.fight;
    return fight ? { next: fight.referee.next, frames: fight.enc.frame, spans: fight.spans } : null;
  });

/** The fight handed to the referee at position 0, played to the frame before its span. */
async function handedOver(n = 1, kind: 'hunt' | 'calm' = 'calm') {
  const r = await witnessed(n, kind);
  const sw = await refereeDuty(r.at(0));
  const msg = await sw.accept();
  await Promise.all(r.seats.map((s) => s.until(() => s.referees.length === 1, 'the handover')));
  await playTo(r, msg.from, sw);
  return { r, sw, h: msg.from };
}

const flags = (kind: string, key: string) =>
  sql<{ n: number }>('SELECT COUNT(*) AS n FROM flags WHERE kind = ? AND hash = ?', kind, key).then(
    (rows) => rows[0]?.n ?? 0,
  );
const struckUntil = (player: string) =>
  sql<{ s: number }>('SELECT struck_until AS s FROM players WHERE id = ?', player).then(
    (rows) => rows[0]?.s ?? 0,
  );
const settlementOfEnd = (end: EncEnd) => (end.settlement as SignedSettlement).settlement;

/** The authority-only settlement of the same start and frames: the log replayed with no witness. */
function authorityOnly(r: Run, frames: (number | null)[][], t: number) {
  const start = encounterStartOf(r.start, r.a.pond.seed);
  if (!start) throw new Error('no start');
  const enc = createEncounter(start);
  for (const i of frames) stepFrame(enc, i);
  return settlementOf({ pondSeed: r.a.pond.seed, start: r.start, joins: [], frames }, enc, t);
}

describe('the handover', () => {
  it('hands the fight to the witness from next + 3, and drops a fighter’s input for h as moved', async () => {
    const r = await witnessed(1, 'hunt');
    const w = r.at(0);
    const sw = await refereeDuty(w);
    const next = (await phaseOf(r))?.next as number;
    const msg = await sw.accept();
    expect(msg).toEqual({ t: 'enc-referee', enc: r.start.enc, from: next + 3, by: w.id.playerId });
    for (const s of r.seats) {
      await s.until(() => s.referees.length === 1, 'the handover');
      expect(s.referees[0]).toEqual(msg);
    }
    const h = msg.from;
    const moved = await authority((o) => o.fights.witnessed.moved);
    r.a.c.send({ t: 'input', enc: r.start.enc, f: h, i: IDLE_CODE });
    // The authority finalizes every frame before h, and the witness hears each one.
    await playTo(r, h, sw);
    expect(r.seats[0].frames).toHaveLength(h);
    await sw.catchUp();
    expect(sw.referee?.encounter.frame).toBe(h);
    expect(await authority((o) => o.fights.witnessed.moved)).toBe(moved + 1);
    // Frame h is the witness's: without its batch, the authority finalizes nothing past its deadline.
    await advanceTo(startOfFrame(r, h) + E.inputDeadlineMs + 500);
    for (const s of r.seats) s.drain();
    expect(r.seats[0].frames).toHaveLength(h);
    expect((await phaseOf(r))?.frames).toBe(h);
  });
});

describe('a witnessed duel', () => {
  it('runs to its end on the witness’s signed batches, and settles as the authority alone would', async () => {
    const { r, sw, h } = await handedOver(1, 'hunt');
    const received = await authority((o) => new Map(o.received));
    const end = await playOut(r, sw);
    const s = settlementOfEnd(end);
    expect(s.v).toBe(2);
    if (s.v !== 2) throw new Error('not version 2');
    expect(s.referees).toEqual([
      { by: AUTHORITY, from: 0 },
      { by: sw.player, from: h, position: 0 },
    ]);
    expect(s.duty).toBe(r.commitId);
    // Every frame holds the inputs the plan sent, none late: the same inputs, refereed by the authority alone.
    const frames = r.seats[0].frames;
    expect(frames.length).toBeGreaterThan(h + 10);
    expect(r.seats[1].frames).toEqual(frames);
    const slots = [slotOf(r.start, r.a), slotOf(r.start, r.b)];
    for (const [f, i] of frames.entries()) {
      const codes = r.plan(f);
      expect(i[slots[0] as number]).toBe(codes[0]);
      expect(i[slots[1] as number]).toBe(codes[1]);
    }
    const alone = authorityOnly(r, frames, s.t);
    expect(s.hash).toBe(alone.hash);
    expect(s.root).toBe(alone.root);
    expect(s.results).toEqual(alone.results);
    expect(sw.referee?.hash()).toBe(end.hash);
    // The witness is done.
    await sw.until(() => sw.ended !== null, 'duty-end');
    expect(sw.ended).toBe('done');
    // The cost: while the witness refereed, the authority heard its batches and nothing else.
    const after = await authority((o) => new Map(o.received));
    const delta = (t: string) => (after.get(t as never) ?? 0) - (received.get(t as never) ?? 0);
    const span = frames.length - h;
    expect(delta('input')).toBe(0);
    expect(delta('batch')).toBe(sw.sent.length);
    expect(sw.sent.length).toBeLessThanOrEqual(Math.ceil(span / 10) + 1);
    for (const t of after.keys()) {
      if (t !== 'batch' && t !== 'ping') expect(delta(t), t).toBe(0);
    }
  });
});

type Failure = 'silent' | 'signature' | 'gap' | 'width' | 'close' | 'dispute';

/** Flips one byte of the first input signature of the batch. */
function flipped(b: BatchMsg): BatchMsg {
  const s = b.s.map((x) => [...x]);
  const row = s[0] as (string | null)[];
  const k = row.findIndex((x) => x !== null);
  const sig = row[k] as string;
  row[k] = `${sig[0] === 'A' ? 'B' : 'A'}${sig.slice(1)}`;
  return { ...b, s };
}

describe('a witness that fails', () => {
  const cases: [Failure, string][] = [
    ['silent', 'witness-silent'],
    ['signature', 'witness-forged'],
    ['gap', 'witness-forged'],
    ['width', 'witness-forged'],
    ['close', 'witness-silent'],
    ['dispute', 'witness-equivocated'],
  ];
  it.each(cases)(
    '%s: takes the fight back at max(next, due) + 2, the autopilot between, and strikes the witness',
    async (failure, kind) => {
      const { r, sw, h } = await handedOver();
      const event = r.event;
      let next = h;
      let failAt = 0;
      if (failure === 'silent') {
        sw.silent = true;
        await playTo(r, h + 10, sw);
        failAt = startOfFrame(r, h + 10) + 1000;
        await advanceTo(failAt);
      } else if (failure === 'signature' || failure === 'gap' || failure === 'width') {
        sw.tamper = (b) =>
          failure === 'signature'
            ? flipped(b)
            : failure === 'gap'
              ? { ...b, f: b.f + 1, i: b.i.slice(1), s: b.s.slice(1) }
              : { ...b, i: b.i.map((x) => [...x, null]), s: b.s.map((x) => [...x, null]) };
        await playTo(r, h + 10, sw, false);
        failAt = clock.t;
      } else {
        await playTo(r, h + 12, sw);
        next = h + 10;
        failAt = clock.t;
        if (failure === 'close') {
          sw.w.c.ws.close(1000, 'bye');
          await sw.w.c.closed;
        } else {
          const f = h + 2;
          const held = r.seats[0].frames[f] as (number | null)[];
          const other = held.map((x) => (x === null ? IDLE_CODE : x ^ 1));
          r.a.c.send({
            t: 'dispute',
            enc: r.start.enc,
            f,
            i: other,
            sig: signWitnessFrame(sw.w.id, r.start.enc, f, other),
          });
        }
      }
      const due = Math.floor((failAt - r.start.at) / FRAME_MS);
      const from = Math.max(next, due) + 2;
      for (const s of r.seats) {
        await s.until(() => s.referees.length === 2, 'the take-back');
        expect(s.referees[1]).toEqual({ t: 'enc-referee', enc: r.start.enc, from, by: AUTHORITY });
        await s.frame(from - 1);
        for (let f = next; f < from; f++) expect(s.frames[f]).toEqual([null, null]);
      }
      expect(await flags(kind, event)).toBe(1);
      expect(await struckUntil(sw.player)).toBe(failAt + STRIKE_MS);
      if (failure !== 'close') {
        await sw.until(() => sw.ended !== null, 'duty-end');
        expect(sw.ended).toBe('struck');
      }
      expect(
        await authority((o) => witnessView(o, event)?.offers.map((x) => [x.position, x.outcome])),
      ).toEqual([[0, 'failed']]);
      // The fight goes on, the authority's, to a settlement whose spans show the take-back.
      r.next = Math.max(r.next, from);
      await playTo(r, from + 5, null);
      const s = await settleAway(r);
      if (s.v !== 2) throw new Error('not version 2');
      expect(s.referees).toEqual([
        { by: AUTHORITY, from: 0 },
        { by: sw.player, from: h, position: 0 },
        { by: AUTHORITY, from },
      ]);
    },
  );

  it('changes nothing for a dispute whose frame equals the committed one', async () => {
    const { r, sw, h } = await handedOver();
    await playTo(r, h + 10, sw);
    const f = h + 3;
    const held = sw.frames.find((x) => x.f === f);
    if (!held) throw new Error('no witness frame');
    const disputes = await authority((o) => o.fights.witnessed.disputes);
    r.b.c.send({ t: 'dispute', enc: r.start.enc, f, i: held.i, sig: held.sig });
    await playTo(r, h + 20, sw);
    expect(await authority((o) => o.fights.witnessed.disputes)).toBe(disputes + 1);
    expect(r.seats[0].referees).toHaveLength(1);
    expect(await struckUntil(sw.player)).toBe(0);
  });

  it('offers position 2 after a failure, which referees again; after 3 referees the authority keeps the fight', async () => {
    const r = await witnessed(4, 'calm');
    const spans: { by: string; from: number }[] = [];
    for (const position of [0, 2, 3]) {
      const sw = await refereeDuty(r.at(position));
      expect(sw.duty.position).toBe(position);
      const msg = await sw.accept();
      spans.push({ by: sw.player, from: msg.from });
      await Promise.all(
        r.seats.map((s) => s.until(() => s.referees.length === spans.length * 2 - 1, 'handover')),
      );
      sw.tamper = flipped;
      await playTo(r, msg.from + 10, sw, false);
      await Promise.all(
        r.seats.map((s) => s.until(() => s.referees.length === spans.length * 2, 'take-back')),
      );
      r.next = Math.max(r.next, (r.seats[0].referees.at(-1) as EncReferee).from);
    }
    expect(
      await authority((o) => witnessView(o, r.event)?.offers.map((x) => [x.position, x.outcome])),
    ).toEqual([
      [0, 'failed'],
      [2, 'failed'],
      [3, 'failed'],
    ]);
    // No fourth: the authority referees the rest.
    await playTo(r, r.next + 5, null);
    const s = await settleAway(r);
    if (s.v !== 2) throw new Error('not version 2');
    expect(s.referees.filter((x) => x.by !== AUTHORITY).map((x) => x.position)).toEqual([0, 2, 3]);
  });
});

describe('planned take-backs', () => {
  it('takes the fight back for a join at due + 3: the witness’s final batch closes the gap, and the joiner sits at h′ + 2', async () => {
    const { r, sw, h } = await handedOver();
    const c = await hatched();
    await playTo(r, h + 5, sw);
    const due = Math.floor((clock.t - r.start.at) / FRAME_MS);
    c.c.send({
      t: 'engage',
      target: r.a.id.playerId,
      mine: snap(c, 1000, 1012, { health: 0.01, energy: 0 }),
      theirs: snap(r.a, ...NEAR.a),
    });
    const from = due + 3;
    for (const s of r.seats) {
      await s.until(() => s.referees.length === 2, 'the take-back');
      expect(s.referees[1]).toEqual({ t: 'enc-referee', enc: r.start.enc, from, by: AUTHORITY });
    }
    await sw.until(() => sw.stoppedAt !== null, 'the take-back');
    // The witness referees to h′ − 1 and sends its final batch.
    for (let f = r.next; f < from; f++) {
      await advanceTo(startOfFrame(r, f) - FRAME_MS);
      sw.hear();
      const codes = r.plan(f);
      [r.a, r.b].forEach((p, k) => sw.input(p, f, codes[k] as number));
      sw.tick();
    }
    r.next = from;
    expect(sw.stoppedAt).toBe(from);
    expect(sw.sent.at(-1)?.end).toBe(true);
    for (const s of r.seats) {
      await s.frame(from - 1);
      // The frames up to h′ − 1 are the witness's, not the autopilot's.
      for (let f = h; f < from; f++) expect(s.frames[f]).not.toContain(null);
      await s.until(() => s.other.some((m) => m.t === 'enc-join'), 'the join');
      const join = s.other.find((m) => m.t === 'enc-join');
      expect(join?.t === 'enc-join' && join.f).toBe(from + E.joinAheadFrames);
    }
    expect(await struckUntil(sw.player)).toBe(0);
    expect(await authority((o) => o.fights.ofPlayer(r.a.id.playerId)?.fight?.spans)).toEqual([
      { by: AUTHORITY, from: 0 },
      { by: sw.player, from: h, position: 0 },
      { by: AUTHORITY, from },
    ]);
  });

  it('takes the fight back when everyone left, and plays the rest out', async () => {
    const { r, sw, h } = await handedOver();
    await playTo(r, h + 10, sw);
    // A short wait (fixture mode), so the autopilot can't end the fight first.
    const graceMs = 1000;
    await authority((o) => {
      const e = o.env as unknown as Record<string, string | undefined>;
      e.DRAND_SOURCE = 'fixture';
      e.AWAY_GRACE_MS = String(graceMs);
    });
    try {
      for (const p of [r.a, r.b]) {
        p.c.ws.close(1000, 'bye');
        await p.c.closed;
      }
      const left = clock.t;
      // The witness referees on (nobody sends it anything) until the wait is over.
      while (sw.stoppedAt === null && clock.t < left + 3 * graceMs) {
        await advanceTo(clock.t + FRAME_MS);
        await sw.until(() => true, 'nothing');
        sw.tick();
      }
      await sw.until(() => sw.ended !== null, 'duty-end');
      expect(sw.ended).toBe('taken-back');
      const from = sw.stoppedAt as number;
      expect(from).toBe(Math.floor((left + graceMs - r.start.at) / FRAME_MS) + 3);
      const s = (
        await waitFor(
          () => authority((o) => o.fightStore.settlement(r.start.enc)),
          'the settlement',
        )
      ).settlement;
      if (s.v !== 2) throw new Error('not version 2');
      expect(s.referees).toEqual([
        { by: AUTHORITY, from: 0 },
        { by: sw.player, from: h, position: 0 },
        { by: AUTHORITY, from },
      ]);
      expect(await struckUntil(sw.player)).toBe(0);
      expect(await authority((o) => o.fights.ofPlayer(r.a.id.playerId))).toBeUndefined();
    } finally {
      await authority((o) => {
        delete (o.env as unknown as Record<string, string | undefined>).AWAY_GRACE_MS;
      });
    }
  });

  it('rebuilds a fight a witness referees after a restart, refereed by the authority from the log’s end', async () => {
    const { r, sw, h } = await handedOver();
    await playTo(r, h + 10, sw);
    const logged = (await phaseOf(r))?.frames as number;
    expect(logged).toBe(h + 10);
    await authority((o) => {
      o.fights.clear();
      o.duties.clear();
      recoverFights(o, o.clock.now());
    });
    expect((await phaseOf(r))?.spans).toEqual([
      { by: AUTHORITY, from: 0 },
      { by: sw.player, from: h, position: 0 },
      { by: AUTHORITY, from: logged },
    ]);
    const s = await settleAway(r);
    if (s.v !== 2) throw new Error('not version 2');
    expect(s.referees).toEqual([
      { by: AUTHORITY, from: 0 },
      { by: sw.player, from: h, position: 0 },
      { by: AUTHORITY, from: logged },
    ]);
  });
});
