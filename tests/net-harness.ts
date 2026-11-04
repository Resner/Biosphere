// The jitter and loss harness (M8 T13): one in-process scripted referee and 2-4 `EncounterSync`
// clients over a seeded link model. Each client has its own one-way latency, jitter and hub-clock
// error; loss shows as a delay spike (WebSocket head-of-line: the messages behind it queue); a
// disconnect window drops messages both ways and ends with the authority's resync. Every fighter's
// input is scripted from a seeded stream. Deterministic: the same options give the same result.

import { encounterStartOf } from '../src/net/encounter-start';
import { EncounterSync, type EncStartMsg, type InputMsg } from '../src/net/encounter-sync';
import type { HubMsg } from '../src/net/protocol';
import { FRAME_MS } from '../src/net/referee';
import type { FrameInput, Stance } from '../src/sim/encounter/types';
import { createRng, type Rng, seedFromString } from '../src/sim/prng';
import { RULES } from '../src/sim/rules';
import { ScriptedReferee, startMsg, TEST_POND } from './scripted-referee';

const E = RULES.encounter;

/** The simulated clock moves in steps of this many ms. */
const TICK_MS = 2;
/** A client plays a frame every ~16 ms (a 60 Hz display). */
const STEP_MS = 16;
/** A message hit by a loss waits this long (a retransmit), and those behind it queue. */
const SPIKE_MS: readonly [number, number] = [200, 600];

export interface LinkModel {
  /** One way, hub to client or back, in ms. */
  oneWayMs: number;
  /** Each message waits a further 0 to this many ms. */
  jitterMs: number;
  /** Chance a message is hit by a delay spike. */
  loss: number;
  /** Each client's estimate of the hub clock is off by this much, alternately early and late. */
  clockErrMs: number;
}

export interface Disconnect {
  /** The client that loses its connection. */
  client: number;
  /** Hub ms after the fight's start at which it drops, and at which the authority resyncs it. */
  from: number;
  to: number;
}

export interface HarnessOptions {
  seed: string;
  /** Fighters and clients, 2 to 4. */
  clients: number;
  link: LinkModel;
  disconnect?: Disconnect;
}

export interface ClientStats {
  /** Own inputs that reached the referee while their fighter was still in (a disconnect swallows some). */
  sent: number;
  /** ... of which the referee took for their frame. */
  onTime: number;
  rollbacks: number;
  longestRollback: number;
  resyncs: number;
  rejoins: number;
  desyncs: number;
  hash: string | null;
}

export interface HarnessResult {
  clients: ClientStats[];
  /** The referee's final hash (`enc-end`). */
  refereeHash: string;
  /** Frames the referee finalized. */
  frames: number;
  seconds: number;
  /** Inputs the referee refused as late or early, over every client. */
  late: number;
  early: number;
  /** The inputs each finalized frame used, by frame (null: the autopilot). */
  bundles: (number | null)[][];
  /** Every client ended on the referee's hash. */
  converged: boolean;
}

/** Messages in flight one way, in order; a loss is a delay spike that holds the messages behind it. */
class SpikeLink<T> {
  private readonly queue: { at: number; msg: T }[] = [];
  private last = 0;
  private readonly rng: Rng;

  constructor(
    private readonly model: Pick<LinkModel, 'oneWayMs' | 'jitterMs' | 'loss'>,
    seed: string,
  ) {
    this.rng = createRng(seedFromString(seed), 'net-link');
  }

  send(now: number, msg: T): void {
    const { oneWayMs, jitterMs, loss } = this.model;
    let at = now + oneWayMs + this.rng.range(0, jitterMs);
    if (this.rng.next() < loss) at += this.rng.range(SPIKE_MS[0], SPIKE_MS[1]);
    at = Math.max(at, this.last);
    this.last = at;
    this.queue.push({ at, msg });
  }

  take(now: number): T[] {
    let n = 0;
    while (n < this.queue.length && (this.queue[n] as { at: number }).at <= now) n++;
    return this.queue.splice(0, n).map((q) => q.msg);
  }

  /** Drops what is in flight (a connection that closed). */
  clear(): void {
    this.queue.length = 0;
  }
}

const STANCES: readonly Stance[] = ['balanced', 'aggressive', 'evasive'];

/** A seeded script of one fighter's inputs: it holds a input for a few frames, then picks another. */
export function scriptedInputs(seed: string): (f: number) => FrameInput {
  const rng = createRng(seedFromString(seed), 'net-script');
  const made: FrameInput[] = [];
  return (f) => {
    for (let i = made.length; i <= f; i++) {
      const prev = made[i - 1];
      if (prev && rng.next() < 0.6) {
        made.push({ ...prev, dash: false, brace: false });
        continue;
      }
      made.push({
        steer: rng.int(0, 255),
        throttle: rng.int(0, 15),
        dash: rng.next() < 0.15,
        stance: STANCES[rng.int(0, 2)] as Stance,
        target: rng.int(0, 3),
        brace: rng.next() < 0.2,
      });
    }
    return made[f] as FrameInput;
  };
}

/** Client `i`'s hub-clock error: alternately early (negative) and late. */
export const clockErrorOf = (i: number, errMs: number): number => (i % 2 === 0 ? -errMs : errMs);

type Up = InputMsg & { slot: number };

export function runHarness(opts: HarnessOptions): HarnessResult {
  const { link, disconnect } = opts;
  const msg: EncStartMsg = startMsg(10_000, 5200, 3000, opts.clients);
  const start = encounterStartOf(msg, TEST_POND.seed);
  if (!start) throw new Error('no start');
  const referee = new ScriptedReferee(start, msg.at);
  const ups: SpikeLink<Up>[] = [];
  const downs: SpikeLink<HubMsg>[] = [];
  const syncs: EncounterSync[] = [];
  const stats: ClientStats[] = [];
  const dropped = (i: number, t: number): boolean =>
    disconnect !== undefined &&
    disconnect.client === i &&
    t >= msg.at + disconnect.from &&
    t < msg.at + disconnect.to;
  let now = 0;
  for (let i = 0; i < opts.clients; i++) {
    const me = `p${'abcd'[i]}`;
    const script = scriptedInputs(`${opts.seed}-input-${i}`);
    const stat: ClientStats = {
      sent: 0,
      onTime: 0,
      rollbacks: 0,
      longestRollback: 0,
      resyncs: 0,
      rejoins: 0,
      desyncs: 0,
      hash: null,
    };
    stats.push(stat);
    ups.push(new SpikeLink(link, `${opts.seed}-up-${i}`));
    downs.push(new SpikeLink(link, `${opts.seed}-down-${i}`));
    const sync = new EncounterSync({
      me,
      sample: script,
      // What the client measures: the round trip's half, jitter included.
      oneWayMs: () => link.oneWayMs + link.jitterMs / 2,
      send: (m) => {
        if (dropped(i, now)) return;
        (ups[i] as SpikeLink<Up>).send(now, { ...m, slot: referee.slotOf(me) });
      },
    });
    syncs.push(sync);
    sync.start(msg, TEST_POND);
  }

  let ended = false;
  let resynced = false;
  const limit = msg.at + (E.timeoutFrames + 20) * FRAME_MS + 10_000;
  for (now = msg.at - 300; now < limit; now += TICK_MS) {
    for (let i = 0; i < opts.clients; i++) {
      for (const m of (ups[i] as SpikeLink<Up>).take(now)) {
        // A fighter that is out sends on (the page still samples), but no frame waits for it.
        if (referee.enc.fighters[m.slot]?.status !== 'in') continue;
        const stat = stats[i] as ClientStats;
        const before = referee.late + referee.early;
        referee.input(m.slot, m.f, m.i, now);
        stat.sent++;
        if (referee.late + referee.early === before) stat.onTime++;
      }
    }
    for (const bundle of referee.due(now)) {
      for (let i = 0; i < opts.clients; i++) {
        if (!dropped(i, now)) (downs[i] as SpikeLink<HubMsg>).send(now, bundle);
      }
    }
    if (referee.enc.over && !ended) {
      ended = true;
      const end = referee.endMsg();
      for (let i = 0; i < opts.clients; i++) {
        if (!dropped(i, now)) (downs[i] as SpikeLink<HubMsg>).send(now, end);
      }
    }
    if (disconnect && !resynced && now >= msg.at + disconnect.to) {
      resynced = true;
      const down = downs[disconnect.client] as SpikeLink<HubMsg>;
      (ups[disconnect.client] as SpikeLink<Up>).clear();
      down.clear();
      down.send(now, msg);
      referee.bundles.forEach((i, f) => {
        down.send(now, { t: 'enc-frame', enc: msg.enc, f, i });
      });
      if (referee.enc.over) down.send(now, referee.endMsg());
    }
    for (let i = 0; i < opts.clients; i++) {
      const sync = syncs[i] as EncounterSync;
      for (const m of (downs[i] as SpikeLink<HubMsg>).take(now)) {
        if (m.t === 'enc-start') sync.start(m, TEST_POND);
        if (m.t === 'enc-frame') sync.receive(m);
        if (m.t === 'enc-end') sync.end(m);
      }
      if ((now + 5 * i) % STEP_MS < TICK_MS) {
        sync.step(now + clockErrorOf(i, link.clockErrMs));
      }
    }
    if (ended && syncs.every((s) => s.over)) break;
  }
  if (!ended || !syncs.every((s) => s.over)) throw new Error('the fight never ended');

  const refereeHash = referee.endMsg().hash;
  syncs.forEach((s, i) => {
    const st = stats[i] as ClientStats;
    st.rollbacks = s.rollbacks;
    st.longestRollback = s.longestRollback;
    st.resyncs = s.resyncs;
    st.rejoins = s.rejoins;
    st.desyncs = s.desyncs;
    st.hash = s.hash;
  });
  return {
    clients: stats,
    refereeHash,
    frames: referee.next,
    seconds: (referee.next * FRAME_MS) / 1000,
    late: referee.late,
    early: referee.early,
    bundles: referee.bundles,
    converged: stats.every((s) => s.hash === refereeHash),
  };
}
