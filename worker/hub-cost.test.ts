import { afterEach, beforeEach, describe, expect } from 'vitest';
import { FRAME_MS } from '../src/net/referee';
import { RULES } from '../src/sim/rules';
import { IDLE_CODE } from '../tests/encounter-fixture';
import { speedTest } from '../tests/heavy';
import { type HubCost, inBudget } from '../tools/hub-report';
import type { Authority } from './authority';
import {
  advanceTo,
  authority,
  CENTRE,
  clock,
  type EncStart,
  join,
  NEAR,
  outOfReach,
  type Player,
  pair,
  snap,
  useFightHub,
  within,
} from './fight-test-kit';
import { must } from './ledger-test-kit';
import { anchorAt, flush, nextOf, placed, publish, sql } from './test-hub';
import { commitWitnesses } from './witness-pool';
import {
  byPlayer,
  editWitness,
  orderOf,
  refereeDuty,
  useWitnessHub,
  waitFor,
  witness,
  witnessCommit,
} from './witness-test-kit';

// M13 T6 (ADR 0067): what each kind of message costs the real object, with 50, 200 and 500 sessions
// seated. A batch goes through the object's own dispatch (`webSocketMessage`) inside the object and
// is timed on the runtime's clock, which steps by 1 ms, so a batch of 200 resolves 0.005 ms per
// message. The hub's clock moves 1 s per message (a message a second is what the rate limit takes),
// and the timers that fall due run after the batch, outside the timing. Production can't measure
// this: its clocks stand still while code runs. `HUB_COST` is what `npm run report:hub` turns into
// `docs/perf/hub.md`.

useFightHub();
useWitnessHub();

const SIZES = [50, 200, 500];
const BATCH = 200;
const REPEATS = 5;
/** Frames of the authority-refereed duel and of the witnessed one. */
const DUEL_FRAMES = 200;
const WITNESS_FRAMES = 300;
const STARTER = { r: 10, aoi: 233 };
/** Far out east, where nobody else reports. */
const FAR = { x: CENTRE + 40_000, y: CENTRE };
const SEED = '5'.repeat(64);
/** Past the rate window's tenth: one message a second keeps every session under every limit. */
const MESSAGE_GAP_MS = 1000;

const wall = () => performance.now();
const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] as number;

const setSessions = (n: number) =>
  authority((o) => {
    (o.env as unknown as Record<string, string>).MAX_SESSIONS = String(n);
  });

beforeEach(async () => {
  await sql('UPDATE world SET seed = ?', SEED);
  await setSessions(1000);
});
afterEach(() => setSessions(200));

/** The session's server-side socket on the object. */
const socketOf = (o: Authority, player: string): WebSocket => must(o.seats.socketOf(player));

/**
 * `count` messages, the `i`th from `from(i)`, through the object's dispatch, the hub's clock a
 * second apart: ms per message. The timers that fell due run after, outside the timing.
 */
function timed(
  o: Authority,
  from: (i: number) => string,
  make: (i: number) => unknown,
  count = BATCH,
): number {
  const batch = Array.from({ length: count }, (_, i) => ({
    ws: socketOf(o, from(i)),
    raw: JSON.stringify(make(i)),
  }));
  const t0 = wall();
  for (const { ws, raw } of batch) {
    clock.t += MESSAGE_GAP_MS;
    o.webSocketMessage(ws, raw);
  }
  const ms = (wall() - t0) / count;
  clock.advance(0);
  return ms;
}

/** The median of `REPEATS` batches from one player. */
const typical = (o: Authority, player: string, make: (i: number) => unknown): number =>
  median(Array.from({ length: REPEATS }, () => timed(o, () => player, make)));

type Seated = Pick<Player, 'c' | 'id'>;

/** Anchors and reports `c` at (x, y), taking its `near`. */
async function standAt(p: Seated, x: number, y: number) {
  await anchorAt(p.id.playerId, x, y);
  p.c.send({ t: 'where', x, y, ...STARTER });
  await nextOf(p.c, 'near');
}

/**
 * The `i`th spot of the populated area: a 25-wide grid of 500 wu from the centre, so that the
 * directory's leaves hold a few each, as a spread-out crowd would leave them.
 */
const spot = (i: number) => ({ x: CENTRE + (i % 25) * 500, y: CENTRE + Math.floor(i / 25) * 500 });

let counter = 10_000;

interface Round {
  ms: Record<string, number>;
  frameMs: number;
}

/** The authority-refereed duel: both inputs for each frame, a frame ahead, the second one stepping it. */
async function duel(c: Player, d: Player): Promise<{ input: number; frame: number }> {
  const start = await outOfReach(c, d);
  return authority((o) => {
    const [cs, ds] = [socketOf(o, c.id.playerId), socketOf(o, d.id.playerId)];
    let input = 0;
    let frame = 0;
    for (let f = 0; f < DUEL_FRAMES; f++) {
      clock.advance(Math.max(0, start.at + f * FRAME_MS - FRAME_MS - clock.t));
      const raw = JSON.stringify({ t: 'input', enc: start.enc, f, i: IDLE_CODE });
      const t0 = wall();
      o.webSocketMessage(cs, raw);
      const t1 = wall();
      o.webSocketMessage(ds, raw);
      const t2 = wall();
      input += t1 - t0;
      frame += t2 - t1;
    }
    // Every frame was stepped, not dropped as early or late.
    expect(o.fights.ofPlayer(c.id.playerId)?.fight?.enc.frame).toBe(DUEL_FRAMES);
    return { input: input / DUEL_FRAMES, frame: frame / DUEL_FRAMES };
  });
}

/** A witnessed duel: ms per `batch` the witness sends, each dispatched as soon as it is made. */
async function witnessed(e: Player, f: Player, w: Awaited<ReturnType<typeof witness>>) {
  const start: EncStart = await outOfReach(e, f);
  const event = `enc:${start.enc}`;
  await authority((o) => commitWitnesses(o, 'enc', start.enc, [e.id.playerId, f.id.playerId]));
  const commit = await waitFor(() => witnessCommit(event), 'the witness commitment');
  const order = orderOf(commit, commit.id);
  expect(byPlayer([w], order[0]).id.playerId).toBe(w.id.playerId);
  await publish(commit.commitment.round);
  const sw = await refereeDuty(w);
  const made: unknown[] = [];
  sw.tamper = (b) => {
    made.push(b);
    return null;
  };
  const handover = await sw.accept();
  const startOf = (n: number) => start.at + n * FRAME_MS;
  // The hub referees the frames before the handover.
  for (let n = 0; n < handover.from; n++) {
    await advanceTo(startOf(n) - FRAME_MS);
    for (const p of [e, f]) p.c.send({ t: 'input', enc: start.enc, f: n, i: IDLE_CODE });
    await within(Promise.all([nextOf(e.c, 'enc-frame'), nextOf(f.c, 'enc-frame')]), `frame ${n}`);
  }
  await sw.catchUp();
  let total = 0;
  let count = 0;
  for (let n = handover.from; n < handover.from + WITNESS_FRAMES; n++) {
    await advanceTo(startOf(n) - FRAME_MS);
    for (const p of [e, f]) sw.input(p, n, IDLE_CODE);
    sw.tick();
    for (const b of made.splice(0)) {
      total += await authority((o) => {
        const ws = socketOf(o, w.id.playerId);
        const raw = JSON.stringify(b);
        const t0 = wall();
        o.webSocketMessage(ws, raw);
        return wall() - t0;
      });
      count++;
    }
  }
  expect(count).toBeGreaterThanOrEqual(WITNESS_FRAMES / 20);
  return total / count;
}

/** Seats sessions up to `n`, all in the populated area. Resolves with the ones this call added. */
async function seat(have: Seated[], n: number): Promise<Seated[]> {
  const added: Seated[] = [];
  while (have.length + added.length < n) {
    const p = await join();
    const { x, y } = spot(have.length + added.length);
    await standAt(p, x, y);
    added.push(p);
  }
  return added;
}

async function round(size: number, pop: Seated[]): Promise<Round> {
  const ms: Record<string, number> = {};
  // A pair of its own: the crowd batch below moves its sender and whoever is near into instances.
  const [a, b] = await pair();
  // The 8 actors seated at the measuring (a, b, c, d, e, f, the witness and g) are part of the size.
  const fresh = await seat(pop, size - 8);
  pop.push(...fresh);
  const at = a.id.playerId;
  const crowd = pop.slice(0, 16).map((p) => p.id.playerId);

  await placed(a, b);
  const toB = b.id.playerId;
  await authority((o) => {
    ms.ping = typical(o, at, (i) => ({ t: 'ping', id: 5000 + i }));
    ms.avail = typical(o, at, (i) => ({ t: 'avail', on: i % 2 === 0 }));
    ms.progress = typical(o, at, () => ({
      t: 'progress',
      n: ++counter,
      ticks: 30,
      biomass: 10_000,
      energy: 12_000,
      health: 10_000,
    }));
    ms.signal = typical(o, at, (i) => ({
      t: 'signal',
      to: toB,
      kind: 'offer',
      sdp: `${i}`.padEnd(1500, 'v'),
    }));
    const stale = snap(a, ...NEAR.a);
    ms['lock-state'] = typical(o, at, () => ({
      t: 'lock-state',
      lock: '0'.repeat(64),
      mine: stale,
    }));
  });
  await flush(a.c);
  expect((await flush(b.c)).filter((m) => m.t === 'signal').length).toBe(BATCH * REPEATS);

  // The ride: refused `company`, the group a few wu away.
  await editWitness(a, (s) => ({ ...s, aloneSince: clock.t - 2 * RULES.world.size }));
  await authority((o) => {
    ms.ride = typical(o, at, () => ({ t: 'ride' }));
    ms.where = typical(o, at, () => ({ t: 'where', x: CENTRE, y: CENTRE, ...STARTER }));
  });
  // A crowd list, from a swimmer far out east: nobody is near it, so no crowd forms and moves the others.
  const g = await join();
  await standAt(g, FAR.x, FAR.y);
  await authority((o) => {
    ms.whereCrowd = typical(o, g.id.playerId, () => ({
      t: 'where',
      ...FAR,
      ...STARTER,
      crowd,
    }));
  });
  // Every ride was refused for company, and no `where` was dropped.
  const heard = await flush(a.c);
  expect(heard.filter((m) => m.t === 'ride-no').length).toBe(BATCH * REPEATS);
  expect(new Set(heard.flatMap((m) => (m.t === 'ride-no' ? [m.why] : [])))).toEqual(
    new Set(['company']),
  );
  expect(heard.filter((m) => m.t === 'near').length).toBe(BATCH * REPEATS);
  expect((await flush(g.c)).filter((m) => m.t === 'near').length).toBe(BATCH * REPEATS);

  // A first spawn for each session this round seated.
  ms.spawn = await authority((o) =>
    timed(
      o,
      (i) => must(fresh[i]).id.playerId,
      () => ({ t: 'spawn', ...STARTER }),
      fresh.length,
    ),
  );

  const [c, d] = await pair();
  const authorityDuel = await duel(c, d);
  ms.input = authorityDuel.input;
  const [e, f] = await pair();
  // A witness of its own, seated after the hatches: a genesis audit would be offered to it first.
  const w = await witness();
  ms.batch = await witnessed(e, f, w);
  const actors = [a, b, c, d, e, f, w, g];
  for (const p of actors) p.c.ws.close(1000, 'done');
  await Promise.all(actors.map((p) => p.c.closed));
  return { ms, frameMs: authorityDuel.frame };
}

describe('the hub’s cost per message', () => {
  speedTest('is flat from 50 to 500 seated sessions', async () => {
    const pop: Seated[] = [];
    const rounds: Round[] = [];
    for (const size of SIZES) rounds.push(await round(size, pop));
    const types = Object.keys(must(rounds[0]).ms);
    const msPerMessage: Record<string, number[]> = {};
    for (const t of types) msPerMessage[t] = rounds.map((r) => must(r.ms[t]));
    const bytes = await authority((o) => {
      const sizes: number[] = [];
      const encoder = new TextEncoder();
      for (const [, ws] of o.seats.seated())
        sizes.push(encoder.encode(JSON.stringify(ws.deserializeAttachment())).length);
      return sizes.sort((x, y) => x - y);
    });
    const cost: HubCost = {
      sessions: SIZES,
      msPerMessage,
      frameMs: rounds.map((r) => r.frameMs),
      attachmentBytes: {
        median: must(bytes[Math.floor(bytes.length / 2)]),
        p95: must(bytes[Math.floor(bytes.length * 0.95)]),
        max: must(bytes[bytes.length - 1]),
      },
      clockStepMs: 1,
    };
    console.log(`HUB_COST ${JSON.stringify(cost)}`);
    for (const [t, ms] of [...Object.entries(msPerMessage), ['frame', cost.frameMs] as const]) {
      expect(
        inBudget(t, ms, SIZES),
        `${t} at ${SIZES[2]} against ${SIZES[0]}: ${JSON.stringify(ms)}`,
      ).toBe(true);
    }
  });
});
