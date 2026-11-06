import { describe, expect } from 'vitest';
import { keyVerifier } from '../src/ledger/key-verify';
import { inputSigned, signInput } from '../src/ledger/witness';
import { encounterStartOf } from '../src/net/encounter-start';
import { handoverFrame } from '../src/net/handover';
import type { HubMsg } from '../src/net/protocol';
import { FRAME_MS } from '../src/net/referee';
import { createEncounter, stepFrame } from '../src/sim/encounter/encounter';
import { RULES } from '../src/sim/rules';
import { drive, IDLE_CODE } from '../tests/encounter-fixture';
import { heavyTest, speedTest } from '../tests/heavy';
import { total as sum } from '../tools/witness-report';
import {
  advanceTo,
  authority,
  type EncEnd,
  fighters,
  outOfReach,
  type Player,
  slotOf,
  useFightHub,
  within,
} from './fight-test-kit';
import { nextOf, publish } from './test-hub';
import { commitWitnesses } from './witness-pool';
import {
  attestAuditor,
  byPlayer,
  orderOf,
  refereeDuty,
  useWitnessHub,
  waitFor,
  witnessCommit,
  witnesses,
} from './witness-test-kit';

// M10 T14 (ADR 0058): what a witnessed fight costs the authority, in incoming messages. A hunter
// locks a victim in and hunts it until it dies, once with the authority refereeing alone (nobody
// is eligible) and once with a scripted witness that takes the duty 3 s after the lock and an
// auditor that attests afterwards. The fight is the same one (same inputs, same frames), so the
// counts compare. `WITNESS_MEASURE` is what `npm run report:witness` turns into `docs/perf/witness.md`.

useFightHub();
useWitnessHub();

const E = RULES.encounter;
/** The duel the report prices: 30 s of 10 frames a second. */
const DUEL_FRAMES = 300;
/** The scripted witness takes its duty this long after the lock (the round's wait, ADR 0058). */
const HANDOVER_MS = 3000;

/** The messages the authority counts, by type, without protocol pings. */
type Counts = Record<string, number>;
const received = (): Promise<Counts> =>
  authority((o) => {
    const out: Counts = {};
    for (const [t, n] of o.received) if (t !== 'ping') out[t] = n;
    return out;
  });
const minus = (after: Counts, before: Counts): Counts => {
  const out: Counts = {};
  for (const [t, n] of Object.entries(after)) {
    const d = n - (before[t] ?? 0);
    if (d > 0) out[t] = d;
  }
  return out;
};

/** A fighter's wire: the frames it heard, in order, and the end. */
class Seat {
  readonly frames: (number | null)[][] = [];
  end: EncEnd | null = null;

  constructor(
    readonly p: Player,
    readonly enc: string,
  ) {}

  private take(m: HubMsg): void {
    if (m.t === 'enc-frame' && m.enc === this.enc) this.frames.push(m.i);
    else if (m.t === 'enc-end' && m.enc === this.enc) this.end = m;
  }

  drain(): void {
    for (const m of this.p.c.inbox.splice(0)) this.take(m);
  }

  /** Waits until it holds frame `f`, or the fight ended. */
  async frame(f: number): Promise<void> {
    this.drain();
    while (this.frames.length <= f && !this.end)
      this.take(await within(this.p.c.next(), `frame ${f}`));
  }

  async over(): Promise<void> {
    this.drain();
    while (!this.end) this.take(await within(this.p.c.next(), 'enc-end'));
  }
}

interface Duel {
  /** The fight's frames, and the first frame a witness refereed (the frame count when none did). */
  frames: number;
  from: number;
  /** Incoming messages before the witness's span, during it, and after the fight (the audit). */
  before: Counts;
  span: Counts;
  after: Counts;
}

/**
 * One hunt to the victim's death. With `witnessed`, two eligible witnesses are online: the first
 * referees from `HANDOVER_MS` on (its 4 signals, `duty-ok` and batches are real messages), the
 * second audits. `spanFrom` marks where the span starts when nobody refereed, to compare alike.
 */
async function duel(witnessed: boolean, spanFrom = 0): Promise<Duel> {
  const [a, b] = await fighters();
  const ws = witnessed ? await witnesses(2) : [];
  const start = await outOfReach(a, b);
  if (witnessed) {
    await authority((o) => commitWitnesses(o, 'enc', start.enc, [a.id.playerId, b.id.playerId]));
  }
  const event = `enc:${start.enc}`;
  const slots = [slotOf(start, a), slotOf(start, b)];
  const hunter = drive(0, 15, { stance: 'aggressive', target: slotOf(start, b) });
  // Codes by slot, the hunter being A's.
  const codesBy = (h: number): [number, number] => {
    const c = slotOf(start, b) === 1 ? [h, IDLE_CODE] : [IDLE_CODE, h];
    return [c[0] as number, c[1] as number];
  };
  // Both idle, then the hunter strikes at `huntFrom`: played in the sim from this very start
  // (bodies differ per identity, and idle bodies drift) until the fight ends near frame 300.
  const first = encounterStartOf(start, a.pond.seed);
  if (!first) throw new Error('no start');
  const endOf = (from: number) => {
    const enc = createEncounter(first);
    while (!enc.over && enc.frame < E.timeoutFrames) {
      stepFrame(enc, codesBy(enc.frame >= from ? hunter : IDLE_CODE));
    }
    return enc.frame;
  };
  let huntFrom = DUEL_FRAMES - endOf(0);
  let end = endOf(huntFrom);
  for (let i = 0; i < 12 && Math.abs(end - DUEL_FRAMES) > 2; i++) {
    huntFrom += DUEL_FRAMES - end;
    end = endOf(huntFrom);
  }
  expect(Math.abs(end - DUEL_FRAMES), 'a hunt that ends near frame 300').toBeLessThanOrEqual(2);
  // Codes by player (A, B), whatever their slots.
  const codesOf = (f: number): [number, number] => {
    const c = codesBy(f >= huntFrom ? hunter : IDLE_CODE);
    return [c[slots[0] as number] as number, c[slots[1] as number] as number];
  };
  const commit = witnessed ? await waitFor(() => witnessCommit(event), 'the commitment') : null;
  const commitId = commit?.id ?? '';
  const order = commit ? orderOf(commit, commit.id) : [];
  if (commit) await publish(commit.commitment.round);
  const seats = [new Seat(a, start.enc), new Seat(b, start.enc)] as const;
  const at = (k: number) => byPlayer(ws, order[k]);
  const duty = witnessed ? await refereeDuty(at(0)) : null;

  let handFrom = Number.POSITIVE_INFINITY;
  let before: Counts = {};
  let mark: Counts | null = null;
  const base = await received();
  const startOf = (f: number) => start.at + f * FRAME_MS;
  let f = 0;
  for (; ; f++) {
    await advanceTo(startOf(f) - FRAME_MS);
    for (const s of seats) s.drain();
    if (seats[0].end) break;
    if (duty && !duty.referee && startOf(f) >= start.at + HANDOVER_MS) {
      // The links come up through the relay (an offer and an answer to each fighter), then `duty-ok`.
      for (const p of [a, b]) {
        at(0).c.send({ t: 'signal', to: p.id.playerId, kind: 'offer', sdp: 'v=0' });
        p.c.send({ t: 'signal', to: at(0).id.playerId, kind: 'answer', sdp: 'v=0' });
      }
      await Promise.all([a, b].map((p) => nextOf(p.c, 'signal')));
      await nextOf(at(0).c, 'signal');
      const handover = await duty.accept();
      handFrom = handover.from;
    }
    if (f === spanFrom && !witnessed) before = minus(await received(), base);
    const codes = codesOf(f);
    if (f < handFrom) {
      for (const [k, p] of [a, b].entries()) {
        p.c.send({ t: 'input', enc: start.enc, f, i: codes[k] as number });
      }
      await Promise.all(seats.map((s) => s.frame(f)));
      continue;
    }
    if (!duty) throw new Error('no witness');
    if (!mark) {
      mark = await received();
      before = minus(mark, base);
    }
    await duty.catchUp();
    const sent = duty.sent.length;
    for (const [k, p] of [a, b].entries()) duty.input(p, f, codes[k] as number);
    duty.tick();
    const batch = duty.sent[duty.sent.length - 1];
    if (batch && duty.sent.length > sent) {
      await Promise.all(seats.map((s) => s.frame(batch.f + batch.i.length - 1)));
    }
  }
  await Promise.all(seats.map((s) => s.over()));
  const frames = seats[0].frames.length;
  const ended = await received();
  if (!witnessed) {
    const since = minus(ended, base);
    return {
      frames,
      from: spanFrom,
      before,
      span: minus(since, before),
      after: {},
    };
  }
  const spanCounts = minus(ended, mark ?? ended);

  // The auditor attests the settled fight.
  await attestAuditor(at(1), event, commitId, await authority((o) => o.pubkeys()));
  return {
    frames,
    from: handFrom,
    before,
    span: spanCounts,
    after: minus(await received(), ended),
  };
}

describe('what a witnessed fight costs the authority (ADR 0058)', () => {
  heavyTest(
    'cuts a 30 s duel at least 4 times, and the witness’s span at least 10 times per participant-second',
    async () => {
      const withWitness = await duel(true);
      const alone = await duel(false, withWitness.from);
      // The bodies differ per identity, so the two fights differ by a few frames: compare per frame.
      const frames = withWitness.frames;
      for (const n of [frames, alone.frames]) {
        expect(n, 'about 30 s of play').toBeGreaterThan(290);
        expect(n).toBeLessThan(310);
      }
      // Without a witness the authority hears exactly one input per fighter and frame (the model's `alone`).
      expect(sum(alone.before) + sum(alone.span)).toBe(2 * alone.frames);
      expect(withWitness.from).toBe(handoverFrame(HANDOVER_MS / FRAME_MS));
      const messages = (d: Duel) => sum(d.before) + sum(d.span) + sum(d.after);
      const perFrameAlone = messages(alone) / alone.frames;
      const perFrameWith = messages(withWitness) / frames;
      expect(perFrameAlone / perFrameWith).toBeGreaterThanOrEqual(4);

      // While the witness referees the authority hears its batches and nothing else.
      const seconds = (d: Duel) => ((d.frames - withWitness.from) * FRAME_MS) / 1000;
      const perSecondAlone = sum(alone.span) / (2 * seconds(alone));
      const perSecondWith = sum(withWitness.span) / (2 * seconds(withWitness));
      expect(perSecondAlone / perSecondWith).toBeGreaterThanOrEqual(10);
      expect(Object.keys(withWitness.span)).toEqual(['batch']);
      expect(withWitness.after).toEqual({ 'duty-ok': 1, attest: 1 });
      expect(withWitness.before).toMatchObject({ signal: 4, 'duty-ok': 1 });

      console.log(
        `WITNESS_MEASURE ${JSON.stringify({
          frames,
          from: withWitness.from,
          before: withWitness.before,
          span: withWitness.span,
          after: withWitness.after,
          aloneBefore: alone.before,
          aloneSpan: alone.span,
          handoverMs: HANDOVER_MS,
        })}`,
      );
    },
  );
});

describe('the signature checks of a batch (workerd)', () => {
  speedTest('take under 10 ms for the 20 inputs of a 30 s duel’s batch', async () => {
    const [a, b] = await fighters();
    const enc = 'ab'.repeat(32);
    const keys = new Map([a, b].map((p) => [p, keyVerifier(p.id.playerId)]));
    const key = (p: Player) => keys.get(p) as NonNullable<ReturnType<typeof keyVerifier>>;
    // A batch of 10 frames of two fighters' inputs, signed as the fighters sign them.
    const rows = Array.from({ length: 10 }, (_, f) =>
      [a, b].map((p) => ({ p, f, code: 100 + f, sig: signInput(p.id, enc, f, 100 + f) })),
    ).flat();
    expect(rows).toHaveLength(20);
    const run = () => {
      for (const r of rows) {
        if (!inputSigned(key(r.p), enc, r.f, r.code, r.sig)) throw new Error('bad signature');
      }
    };
    run();
    const times: number[] = [];
    for (let i = 0; i < 15; i++) {
      const t = performance.now();
      run();
      times.push(performance.now() - t);
    }
    times.sort((x, y) => x - y);
    const median = times[7] as number;
    expect(median).toBeLessThan(10);
    console.log(`WITNESS_CPU ${JSON.stringify({ batchMs: Math.round(median * 10) / 10 })}`);
  });
});
