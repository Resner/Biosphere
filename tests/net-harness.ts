// The jitter and loss harness (M8 T13): one in-process scripted referee and 2-4 `EncounterSync`
// clients over a seeded link model. Each client has its own one-way latency, jitter and hub-clock
// error; loss shows as a delay spike (WebSocket head-of-line: the messages behind it queue); a
// disconnect window drops messages both ways and ends with the authority's resync. Every fighter's
// input is scripted from a seeded stream. Deterministic: the same options give the same result.
//
// A witness phase (M10 T3, ADR 0058): a `WitnessReferee` takes the fight over from a frame and may
// hand it back. It has its own link to each fighter and its own error on the hub clock; the hub
// hears it over the hub's link, takes its batches and echoes them. Each fighter routes its inputs
// through a `RefereeRoute`. Signatures are stubbed: their checks are the documents' tests.

import { toBase64Url } from '../src/ledger/identity';
import { encounterStartOf } from '../src/net/encounter-start';
import { EncounterSync, type EncStartMsg, type InputMsg } from '../src/net/encounter-sync';
import { AUTHORITY, HANDOVER_AHEAD } from '../src/net/handover';
import type { DutyHistory, HubMsg, PeerEvent } from '../src/net/protocol';
import { FRAME_MS } from '../src/net/referee';
import { type DisputeMsg, RefereeRoute } from '../src/net/referee-route';
import { type BatchMsg, WitnessReferee } from '../src/net/witness-referee';
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

/** A witness referees frames `from` to `until − 1` (to the fight's end without `until`). */
export interface WitnessPhase {
  from: number;
  /** The authority's planned take-back: it announces it 3 frames ahead, as `due + 3`. */
  until?: number;
  /** The link between the witness and each fighter, each way. */
  oneWayMs: number;
  jitterMs: number;
  /** The witness's error on the hub clock (signed: negative is early). */
  clockErrMs: number;
}

export interface HarnessOptions {
  seed: string;
  /** Fighters and clients, 2 to 4. */
  clients: number;
  link: LinkModel;
  disconnect?: Disconnect;
  witness?: WitnessPhase;
  /** Calm scripts (`scriptedInputs`): a long fight, for a witness phase. */
  calm?: boolean;
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
  /** Authority frames that overruled a witness's, and disputes sent (M10 T3). */
  overruled: number;
  disputes: number;
  hash: string | null;
}

export interface WitnessStats {
  frames: number;
  batches: number;
  taken: number;
  /** The witness's own hash, when it refereed the fight's last frame. */
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
  /** Every client (and a witness that refereed the end) ended on the referee's hash. */
  converged: boolean;
  witness: WitnessStats | null;
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

/**
 * A seeded script of one fighter's inputs: it holds a input for a few frames, then picks another.
 * `calm` keeps the throttle low and never dashes, so the fighters stay close and the fight runs long.
 */
export function scriptedInputs(seed: string, calm = false): (f: number) => FrameInput {
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
        throttle: rng.int(0, calm ? 1 : 15),
        dash: rng.next() < 0.15 && !calm,
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
type FighterInput = Extract<PeerEvent, { t: 'finput' }>;
type WitnessFrame = Extract<PeerEvent, { t: 'wframe' }>;
/** What the hub tells the witness: its duty (with the history so far), a final frame before its span, or a take-back. */
type ToWitness =
  | { t: 'duty'; history: DutyHistory[] }
  | { t: 'frame'; f: number; i: (number | null)[] }
  | { t: 'stop'; from: number };

/** The witness's player id in the harness. */
const WITNESS = 'pw';
/** Signatures are stubbed in the harness: a well-formed one that every stubbed key takes. */
const STUB_SIG = toBase64Url(new Uint8Array(64));
const STUB_KEY = () => true;

export function runHarness(opts: HarnessOptions): HarnessResult {
  const { link, disconnect, witness: phase } = opts;
  const msg: EncStartMsg = startMsg(10_000, 5200, 3000, opts.clients);
  const start = encounterStartOf(msg, TEST_POND.seed);
  if (!start) throw new Error('no start');
  const referee = new ScriptedReferee(start, msg.at);
  const players = msg.fighters.map((f) => f.player);
  const ups: SpikeLink<Up>[] = [];
  const downs: SpikeLink<HubMsg>[] = [];
  const syncs: EncounterSync[] = [];
  const routes: RefereeRoute[] = [];
  const stats: ClientStats[] = [];
  // The witness's links: to and from each fighter, and to and from the hub.
  const wLink = { oneWayMs: phase?.oneWayMs ?? 0, jitterMs: phase?.jitterMs ?? 0, loss: 0 };
  const wUps: SpikeLink<FighterInput>[] = [];
  const wDowns: SpikeLink<WitnessFrame>[] = [];
  const toWitness = new SpikeLink<ToWitness>(link, `${opts.seed}-hub-witness`);
  const fromWitness = new SpikeLink<BatchMsg>(link, `${opts.seed}-witness-hub`);
  const until = phase?.until ?? Number.POSITIVE_INFINITY;
  if (phase) {
    if (phase.from < HANDOVER_AHEAD || until <= phase.from) throw new Error('a bad witness phase');
    referee.witnessed = { from: phase.from, to: until };
  }
  /** Frame `f` is the witness's to referee. */
  const witnessed = (f: number): boolean => !!phase && f >= phase.from && f < until;
  let witness = null as WitnessReferee | null;
  let handed = false;
  let takenBack = false;
  const dropped = (i: number, t: number): boolean =>
    disconnect !== undefined &&
    disconnect.client === i &&
    t >= msg.at + disconnect.from &&
    t < msg.at + disconnect.to;
  let now = 0;
  for (let i = 0; i < opts.clients; i++) {
    const me = players[i] as string;
    const script = scriptedInputs(`${opts.seed}-input-${i}`, opts.calm);
    const stat: ClientStats = {
      sent: 0,
      onTime: 0,
      rollbacks: 0,
      longestRollback: 0,
      resyncs: 0,
      rejoins: 0,
      desyncs: 0,
      overruled: 0,
      disputes: 0,
      hash: null,
    };
    stats.push(stat);
    ups.push(new SpikeLink(link, `${opts.seed}-up-${i}`));
    downs.push(new SpikeLink(link, `${opts.seed}-down-${i}`));
    wUps.push(new SpikeLink(wLink, `${opts.seed}-witness-up-${i}`));
    wDowns.push(new SpikeLink(wLink, `${opts.seed}-witness-down-${i}`));
    const route = new RefereeRoute({
      enc: msg.enc,
      sendHub: (m: InputMsg | DisputeMsg) => {
        if (m.t !== 'input' || dropped(i, now)) return;
        (ups[i] as SpikeLink<Up>).send(now, { ...m, slot: referee.slotOf(me) });
      },
      sendWitness: (_to, ev) => (wUps[i] as SpikeLink<FighterInput>).send(now, ev),
      signInput: () => STUB_SIG,
      frameSigned: STUB_KEY,
      // What the client measures: the round trip's half, jitter included.
      oneWayMs: (by) =>
        by === AUTHORITY ? link.oneWayMs + link.jitterMs / 2 : wLink.oneWayMs + wLink.jitterMs / 2,
    });
    routes.push(route);
    const sync = new EncounterSync({
      me,
      sample: script,
      oneWayMs: () => route.oneWayMs(sync.frame),
      send: (m) => route.send(m),
    });
    syncs.push(sync);
    sync.start(msg, TEST_POND);
  }

  /** Sends a hub message to every connected client. */
  const tellAll = (m: HubMsg): void => {
    for (let i = 0; i < opts.clients; i++) {
      if (!dropped(i, now)) (downs[i] as SpikeLink<HubMsg>).send(now, m);
    }
  };

  let ended = false;
  let resynced = false;
  const limit = msg.at + (E.timeoutFrames + 20) * FRAME_MS + 10_000;
  for (now = msg.at - 300; now < limit; now += TICK_MS) {
    for (let i = 0; i < opts.clients; i++) {
      for (const m of (ups[i] as SpikeLink<Up>).take(now)) {
        // A fighter that is out sends on (the page still samples), but no frame waits for it.
        if (referee.enc.fighters[m.slot]?.status !== 'in') continue;
        // An input for the witness's frames is dropped as moved, never late.
        if (witnessed(m.f)) continue;
        const stat = stats[i] as ClientStats;
        const before = referee.late + referee.early;
        referee.input(m.slot, m.f, m.i, now);
        stat.sent++;
        if (referee.late + referee.early === before) stat.onTime++;
      }
    }
    if (witness) {
      for (let i = 0; i < opts.clients; i++) {
        for (const ev of (wUps[i] as SpikeLink<FighterInput>).take(now)) {
          const verdict = witness.input(players[i] as string, ev);
          if (!witnessed(ev.f) || witness.encounter.fighters[i]?.status !== 'in') continue;
          if (verdict !== 'ok' && verdict !== 'late' && verdict !== 'early') continue;
          const stat = stats[i] as ClientStats;
          stat.sent++;
          if (verdict === 'ok') stat.onTime++;
        }
      }
    }
    for (const b of fromWitness.take(now)) {
      for (const frame of referee.take(b.f, b.i)) tellAll(frame);
    }
    for (const bundle of referee.due(now)) {
      tellAll(bundle);
      if (handed && phase && bundle.f < phase.from) {
        toWitness.send(now, { t: 'frame', f: bundle.f, i: bundle.i });
      }
    }
    if (phase && !handed && referee.next >= phase.from - HANDOVER_AHEAD) {
      // The handover: the duty and its history, then `enc-referee` to the fighters and the witness.
      if (referee.next > phase.from) throw new Error('the handover came too late');
      handed = true;
      const history = referee.bundles.map((i, f): DutyHistory => ({ t: 'enc-frame', f, i }));
      toWitness.send(now, { t: 'duty', history });
      tellAll({ t: 'enc-referee', enc: msg.enc, from: phase.from, by: WITNESS });
    }
    if (handed && !takenBack && now >= msg.at + (until - HANDOVER_AHEAD) * FRAME_MS) {
      // A planned take-back, announced as `due + 3`.
      takenBack = true;
      toWitness.send(now, { t: 'stop', from: until });
      tellAll({ t: 'enc-referee', enc: msg.enc, from: until, by: AUTHORITY });
    }
    if (referee.enc.over && !ended) {
      ended = true;
      tellAll(referee.endMsg());
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
    for (const m of toWitness.take(now)) {
      if (m.t === 'duty' && phase) {
        witness = new WitnessReferee({
          duty: { start: msg, history: m.history, pondSeed: TEST_POND.seed, fighters: players },
          from: phase.from,
          now: () => now + phase.clockErrMs,
          signFrame: () => STUB_SIG,
          sendFrame: (ev) => {
            for (const l of wDowns) l.send(now, ev);
          },
          sendBatch: (b) => fromWitness.send(now, b),
          keyOf: () => STUB_KEY,
        });
      }
      if (m.t === 'frame') witness?.hubFrame(m);
      if (m.t === 'stop') witness?.stopAt(m.from);
    }
    witness?.tick();
    for (let i = 0; i < opts.clients; i++) {
      const sync = syncs[i] as EncounterSync;
      const route = routes[i] as RefereeRoute;
      for (const m of (downs[i] as SpikeLink<HubMsg>).take(now)) {
        if (m.t === 'enc-start') sync.start(m, TEST_POND);
        if (m.t === 'enc-frame') {
          if (route.hubFrame(m)) sync.overrule(m);
          else sync.receive(m);
        }
        if (m.t === 'enc-end') sync.end(m);
        if (m.t === 'enc-referee') route.referee(m);
      }
      for (const ev of (wDowns[i] as SpikeLink<WitnessFrame>).take(now)) {
        const frame = route.witnessFrame(WITNESS, ev);
        if (frame) sync.receive(frame);
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
    const route = routes[i] as RefereeRoute;
    st.rollbacks = s.rollbacks;
    st.longestRollback = s.longestRollback;
    st.resyncs = s.resyncs;
    st.rejoins = s.rejoins;
    st.desyncs = s.desyncs;
    st.overruled = route.resyncs;
    st.disputes = route.disputes;
    st.hash = s.hash;
  });
  const w = witness;
  const witnessStats: WitnessStats | null = w && {
    frames: w.frames,
    batches: w.batches,
    taken: w.taken,
    hash: w.encounter.over ? w.hash() : null,
  };
  return {
    clients: stats,
    refereeHash,
    frames: referee.next,
    seconds: (referee.next * FRAME_MS) / 1000,
    late: referee.late,
    early: referee.early,
    bundles: referee.bundles,
    converged:
      stats.every((s) => s.hash === refereeHash) &&
      (witnessStats?.hash ?? refereeHash) === refereeHash,
    witness: witnessStats,
  };
}
