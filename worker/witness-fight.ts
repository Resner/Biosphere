// The authority's side of a witness-refereed fight (ADR 0058, M10 T5). On the referee's `duty-ok`
// the authority hands frames from `h = next + 3` on to the witness (W): it finalizes every frame
// before `h` itself, drops a fighter's input for W's frames as `moved`, and steps its own copy of
// the fight with each batch W sends (checked: it continues the log, every frame has its width, and
// every input carries its fighter's signature), echoing the frames to the fighters. A missed batch,
// a forged one, W's socket closing or a dispute that proves W signed another frame takes the fight
// back at once from `max(next, due) + 2`, the frames between played by the autopilot, and strikes
// W. A join, everyone away and W's own lock take it back as planned, from `due + 3`: W's final
// batch closes the gap, and nobody is struck. `fights.ts` keeps its referee loop; this file is the
// witness phase only.

import { keyVerifier } from '../src/ledger/key-verify';
import { dutyEvent, inputSigned, parseDutyEvent, witnessFrameSigned } from '../src/ledger/witness';
import { sameInputs } from '../src/net/encounter-sync';
import type { Refereeing } from '../src/net/encounter-verify';
import {
  AUTHORITY,
  BATCH_FRAMES,
  BATCH_GRACE_MS,
  handoverFrame,
  plannedTakeBackFrame,
  type RefereeSpan,
  takeBackFrame,
} from '../src/net/handover';
import type { ClientMsg, HubMsg } from '../src/net/protocol';
import { type Bundle, FRAME_MS, type InputVerdict, Referee } from '../src/net/referee';
import type { FlagKind } from './audit';
import { awayDue } from './away';
import { type Fight, type Lock, stepAll, tick } from './fights';
import { tell } from './settle';
import { type ActiveSession, type Hub, seated, sendIfOpen } from './socket';

/** The largest input code a batch may carry: `0xFFFFFFFF` is the packed log's fallback marker. */
const CODE_MAX = 0xfffffffe;

/** Why the authority takes a fight back as planned: nobody is struck. */
export type PlannedTakeBack = 'join' | 'away' | 'lock';

/** A witness's phase of one fight: from its handover until its span is closed. */
export interface WitnessRun {
  /** The duty's event (`enc:<id>`), the witness and its place in the order. */
  event: string;
  by: string;
  position: number;
  /** `h`: the first frame W referees. */
  from: number;
  /** The take-back's first frame, once announced; W's span is closing until the log reaches it. */
  until: number | null;
  /** W failed: the frames of its span the log lacks are the autopilot's, at once. */
  failed: boolean;
  /** A planned take-back's reason. */
  planned: PlannedTakeBack | null;
  /** The authority's referee for the frames before `h`, kept once a take-back's referee replaced it. */
  pre: Referee | null;
  /** Each slot's player key, tabled once for the fight. */
  keys: (ReturnType<typeof keyVerifier> | null)[];
}

/** The frame being played at hub time `now`. */
export const dueFrame = (fight: Fight, now: number): number =>
  Math.max(0, Math.floor((now - fight.start.at) / FRAME_MS));

const lockOf = (hub: Hub, enc: string): Lock | null => hub.fights.ofEncounter(enc) ?? null;

/** Slots that play frame `f`: the starters and each join from its frame on. */
function widthAt(fight: Fight, f: number): number {
  let n = fight.start.fighters.length;
  for (const j of fight.joins) if (j.f <= f) n++;
  return n;
}

/** The referee for frames before `h` while W referees, or after a take-back the one kept for them. */
const preOf = (fight: Fight, w: WitnessRun): Referee | null =>
  w.until === null ? fight.referee : w.pre;

/**
 * Where a fighter's input for frame `f` goes while a witness phase runs: before `h` to the
 * authority's referee, in W's span `moved` (dropped and counted, never taken late), and from a
 * take-back's frame on to the authority's referee again.
 */
export function routeInput(
  fight: Fight,
  slot: number,
  f: number,
  code: number,
  now: number,
): InputVerdict | 'moved' {
  const w = fight.witness;
  if (!w) return fight.referee.input(slot, f, code, now);
  if (f < w.from) return preOf(fight, w)?.input(slot, f, code, now) ?? 'late';
  if (w.until === null || f < w.until) return 'moved';
  return fight.referee.input(slot, f, code, now);
}

/** Sends `msg` to the witness of the phase, when it is connected. */
function toWitness(hub: Hub, w: WitnessRun, msg: HubMsg): void {
  const found = seated(hub, w.by);
  if (found) sendIfOpen(found[0], msg);
}

/** Who referees, saved with the fight's log so a restart keeps it. */
function saveSpans(hub: Hub, fight: Fight): void {
  try {
    hub.fightStore.referees(fight);
  } catch (error) {
    console.error('fight referees write failed', error);
  }
}

/**
 * The referee's `duty-ok` (`hub.duties.onReferee`): W referees the fight from `h = next + 3`. Both
 * fighters and W hear `enc-referee`, the span is saved, and W gets the frames finalized since its
 * duty was offered (then every one before `h` as it comes). A duty whose fight is over, already
 * in a witness's hands, joined since the offer, or whose witness is locked or gone, ends.
 */
export function handOver(hub: Hub, event: string, witness: string, position: number): void {
  const ev = parseDutyEvent(event);
  const lock = ev?.kind === 'enc' ? lockOf(hub, ev.id) : null;
  const fight = lock?.fight;
  const offered = hub.duties.offeredHistory(event);
  const since = fight ? fight.history.slice(offered) : [];
  if (
    !lock ||
    !fight ||
    fight.enc.over ||
    fight.witness ||
    since.some((m) => m.t === 'enc-join') ||
    hub.fights.playerLocked(witness) ||
    !seated(hub, witness)
  ) {
    hub.duties.end(event, 'referee', fight && !fight.enc.over ? 'replaced' : 'done');
    if (fight && !fight.enc.over && !fight.witness) hub.duties.reoffer(event);
    return;
  }
  const h = handoverFrame(fight.referee.next);
  const w: WitnessRun = {
    event,
    by: witness,
    position,
    from: h,
    until: null,
    failed: false,
    planned: null,
    pre: null,
    keys: fight.players.map((p) => keyVerifier(p)),
  };
  fight.witness = w;
  fight.spans.push({ by: witness, from: h, position });
  saveSpans(hub, fight);
  const msg: HubMsg = { t: 'enc-referee', enc: fight.enc.id, from: h, by: witness };
  tell(hub, lock, msg);
  toWitness(hub, w, msg);
  for (const m of since) if (m.t === 'enc-frame') toWitness(hub, w, m);
  witnessTick(hub, lock, fight, hub.clock.now());
}

/**
 * Steps the fight with `bundles` (as `fights.ts` does), echoing each frame before `h` to W too. True
 * once the fight settled.
 */
function step(hub: Hub, lock: Lock, fight: Fight, w: WitnessRun, bundles: Bundle[]): boolean {
  const before = fight.history.length;
  const settled = stepAll(hub, lock, fight, bundles);
  if (!w.failed) {
    for (const m of fight.history.slice(before)) {
      if (m.t === 'enc-frame' && m.f < w.from) toWitness(hub, w, m);
    }
  }
  const pre = preOf(fight, w);
  if (pre && pre !== fight.referee) {
    for (const f of fight.enc.fighters) if (f.status !== 'in') pre.retire(f.slot);
  }
  return settled;
}

/** The autopilot's frames from `from` (the log's end by default) to `until − 1`, the fallback marker in every slot. */
function fallback(fight: Fight, until: number, from = fight.enc.frame): Bundle[] {
  const out: Bundle[] = [];
  for (let f = from; f < until; f++) {
    out.push({ f, i: new Array<number | null>(widthAt(fight, f)).fill(null) });
  }
  return out;
}

/** When W's next batch is due at the latest: 1 s past the start of the frame 10 after the log's end. */
const batchDue = (fight: Fight, w: WitnessRun): number =>
  fight.referee.start(Math.max(fight.enc.frame, w.from) + BATCH_FRAMES) + BATCH_GRACE_MS;

/** When a planned take-back stops waiting for W's final batch: 1 s past its span's last frame. */
const gapDue = (fight: Fight, until: number): number => fight.referee.start(until) + BATCH_GRACE_MS;

/**
 * The witness phase's tick, run for every deadline, batch and input (through `tick`): the
 * authority's frames before `h`, then the away check, a take-back's gap, the watchdog, and the
 * phase's close once the log reaches the take-back's frame. It keeps the fight's one timer.
 */
export function witnessTick(hub: Hub, lock: Lock, fight: Fight, now: number): void {
  const w = fight.witness;
  if (!w) return;
  const pre = preOf(fight, w);
  if (pre && fight.enc.frame < w.from) {
    const own = pre.due(now).filter((b) => b.f < w.from);
    if (step(hub, lock, fight, w, own)) return;
  }
  // Everyone left: the authority takes the fight back and plays the rest out at once (ADR 0053).
  if (awayDue(hub, fight, now)) {
    takeBack(hub, lock, fight, 'away');
    const own = ownRest(fight, w);
    const gap = fallback(fight, w.until ?? 0, fight.enc.frame + own.length);
    if (step(hub, lock, fight, w, [...own, ...gap])) return;
  }
  const L = fight.enc.frame;
  if (
    w.until !== null &&
    L >= w.from &&
    L < w.until &&
    (w.failed || now >= gapDue(fight, w.until))
  ) {
    if (step(hub, lock, fight, w, fallback(fight, w.until))) return;
    hub.fightStore.flush(fight);
  }
  if (w.until === null && !w.failed && now >= batchDue(fight, w)) {
    fail(hub, lock, fight, 'witness-silent');
    return;
  }
  if (w.until !== null && fight.enc.frame >= w.until) {
    close(hub, fight, w);
    tick(hub, lock.id, now);
    return;
  }
  // The authority's own frames before `h` are written every `BATCH_FRAMES`, as `fights.ts` does.
  if (fight.enc.frame >= fight.persisted + BATCH_FRAMES) hub.fightStore.flush(fight);
  hub.fights.arm(lock, wakeAt(fight, w), () => tick(hub, lock.id, hub.clock.now()));
}

/** Every frame before `h` the authority has yet to finalize, each as at its deadline (a fast-forward). */
function ownRest(fight: Fight, w: WitnessRun): Bundle[] {
  const pre = preOf(fight, w);
  const out: Bundle[] = [];
  if (!pre || fight.enc.frame >= w.from) return out;
  while (pre.next < w.from) out.push(...pre.due(pre.nextDeadline()).filter((b) => b.f < w.from));
  return out;
}

/** When the phase next has something to do. */
function wakeAt(fight: Fight, w: WitnessRun): number {
  const times: number[] = [];
  const pre = preOf(fight, w);
  if (pre && fight.enc.frame < w.from) times.push(pre.nextDeadline());
  if (w.until === null) times.push(batchDue(fight, w));
  else if (!w.failed) times.push(gapDue(fight, w.until));
  if (fight.awayDue !== null) times.push(fight.awayDue);
  return times.length > 0 ? Math.min(...times) : fight.referee.nextDeadline();
}

/**
 * Announces a take-back from frame `until`: the span goes to the authority, a referee restored at
 * `until` takes the fighters' inputs from there (the one before `h` is kept for its frames), and
 * the fighters and W hear `enc-referee { by: 'authority' }`.
 */
function announce(hub: Hub, lock: Lock, fight: Fight, w: WitnessRun, until: number): void {
  w.until = until;
  w.pre = fight.referee;
  fight.spans.push({ by: AUTHORITY, from: until });
  const referee = new Referee({
    startAt: fight.start.at,
    slots: fight.start.fighters.length,
    next: until,
    joins: fight.joins.map((j) => j.f),
  });
  for (const f of fight.enc.fighters) if (f.status !== 'in') referee.retire(f.slot);
  fight.referee = referee;
  saveSpans(hub, fight);
  const msg: HubMsg = { t: 'enc-referee', enc: fight.enc.id, from: until, by: AUTHORITY };
  tell(hub, lock, msg);
  toWitness(hub, w, msg);
}

/**
 * A planned take-back (a join, everyone away, W's own lock) from `due + 3`: W's final batch closes
 * the gap, or the autopilot does once it is a second late. Nobody is struck.
 */
export function takeBack(hub: Hub, lock: Lock, fight: Fight, why: PlannedTakeBack): void {
  const w = fight.witness;
  if (!w || w.until !== null) return;
  w.planned = why;
  const until = Math.max(plannedTakeBackFrame(dueFrame(fight, hub.clock.now())), w.from + 1);
  announce(hub, lock, fight, w, until);
  if (why !== 'away') witnessTick(hub, lock, fight, hub.clock.now());
}

/**
 * W failed (`kind`): the fight is the authority's again from `max(next, due) + 2` (never inside
 * the frames before `h`), the frames between are the autopilot's at once, W is struck (flagged
 * once for the event) and hears `duty-end`, and the next position may referee once the span closes.
 */
function fail(hub: Hub, lock: Lock, fight: Fight, kind: FlagKind): void {
  const w = fight.witness;
  if (!w || w.failed) return;
  if (w.until === null) {
    const now = hub.clock.now();
    const until = Math.max(takeBackFrame(fight.enc.frame, dueFrame(fight, now)), w.from + 1);
    announce(hub, lock, fight, w, until);
  }
  w.failed = true;
  hub.duties.strike(w.by, kind, w.event);
  witnessTick(hub, lock, fight, hub.clock.now());
}

/**
 * The span is closed (the log reached the take-back's frame): the phase is over. A planned
 * take-back's W hears `duty-end { why: 'taken-back' }`, and unless everyone left, the next
 * position may referee (at most 3 per fight, `duty.ts`).
 */
function close(hub: Hub, fight: Fight, w: WitnessRun): void {
  fight.witness = null;
  if (!w.failed) hub.duties.end(w.event, 'referee', 'taken-back');
  if (w.planned !== 'away' && !fight.enc.over) hub.duties.reoffer(w.event);
}

/**
 * A witness's `batch`. Only the fight's W (not failed) may send one; a repeat is ignored. It must
 * continue the log, have each frame's width and carry a valid signature for every input, or W has
 * forged it. Frames past a take-back's frame are left out. The authority steps its encounter with
 * the frames, echoes them, writes them (one row) and settles when its encounter ends.
 */
export function witnessBatch(hub: Hub, session: ActiveSession, msg: ClientMsg & { t: 'batch' }) {
  const lock = lockOf(hub, msg.enc);
  const fight = lock?.fight;
  const w = fight?.witness;
  if (!lock || !fight || !w || w.by !== session.playerId || w.failed) {
    hub.fights.witnessed.strays++;
    return;
  }
  const L = fight.enc.frame;
  if (msg.f < L && msg.f + msg.i.length <= L) {
    hub.fights.witnessed.repeats++;
    return;
  }
  const take = Math.min(msg.i.length, (w.until ?? Number.POSITIVE_INFINITY) - msg.f);
  if (msg.f !== L || msg.f < w.from || take <= 0 || !signed(fight, w, msg, take)) {
    fail(hub, lock, fight, 'witness-forged');
    return;
  }
  hub.fights.witnessed.batches++;
  const bundles = msg.i.slice(0, take).map((i, k) => ({ f: msg.f + k, i: [...i] }));
  const last = fight.batched[fight.batched.length - 1];
  if (last && last.by === w.by && last.to === msg.f) last.to += take;
  else fight.batched.push({ by: w.by, from: msg.f, to: msg.f + take });
  if (step(hub, lock, fight, w, bundles)) return;
  // One row per batch, as the authority's own batches cost.
  hub.fightStore.flush(fight);
  witnessTick(hub, lock, fight, hub.clock.now());
}

/** Whether the first `take` frames of the batch have their widths and every input its fighter's signature. */
function signed(fight: Fight, w: WitnessRun, msg: ClientMsg & { t: 'batch' }, take: number) {
  for (let k = 0; k < take; k++) {
    const f = msg.f + k;
    const inputs = msg.i[k] as (number | null)[];
    const sigs = msg.s[k] as (string | null)[];
    if (inputs.length !== widthAt(fight, f)) return false;
    for (const [slot, code] of inputs.entries()) {
      if (code === null) continue;
      const key = w.keys[slot];
      const sig = sigs[slot];
      if (code > CODE_MAX || !key || !sig || !inputSigned(key, fight.enc.id, f, code, sig))
        return false;
    }
  }
  return true;
}

/**
 * A fighter's `dispute`: a witness's signed frame that differs from the one the witness committed
 * in its batch proves it equivocated (a failure, or a strike once its phase is over). Anything
 * else (not a fighter of the fight, a frame no witness batched, a signature that fails, an equal
 * frame) is dropped and counted.
 */
export function witnessDispute(
  hub: Hub,
  session: ActiveSession,
  msg: ClientMsg & { t: 'dispute' },
): void {
  const lock = hub.fights.ofPlayer(session.playerId);
  const fight = lock?.fight;
  const by = fight?.batched.find((b) => msg.f >= b.from && msg.f < b.to)?.by;
  const committed = fight?.history.find((m) => m.t === 'enc-frame' && m.f === msg.f);
  if (
    !lock ||
    !fight ||
    fight.enc.id !== msg.enc ||
    !by ||
    committed?.t !== 'enc-frame' ||
    sameInputs(committed.i, msg.i) ||
    !witnessFrameSigned(by, msg.enc, msg.f, msg.i, msg.sig)
  ) {
    hub.fights.witnessed.disputes++;
    return;
  }
  const w = fight.witness;
  if (w && w.by === by && !w.failed) fail(hub, lock, fight, 'witness-equivocated');
  else hub.duties.strike(by, 'witness-equivocated', dutyEvent('enc', fight.enc.id));
}

/** The player's socket closed: a fight it referees is taken back (`witness-silent`). */
export function witnessLeft(hub: Hub, player: string): void {
  for (const lock of hub.fights.running()) {
    const fight = lock.fight;
    if (fight?.witness?.by === player && !fight.witness.failed) {
      fail(hub, lock, fight, 'witness-silent');
    }
  }
}

/** The players were just locked in a fight: any fight one of them referees is taken back, as planned. */
export function witnessLocked(hub: Hub, players: readonly string[]): void {
  for (const lock of hub.fights.running()) {
    const fight = lock.fight;
    const w = fight?.witness;
    if (fight && w && !w.failed && players.includes(w.by)) takeBack(hub, lock, fight, 'lock');
  }
}

/**
 * The spans and witness commitment the fight's settlement names (version 2): every span that
 * refereed one of its frames, and the commitment's id (`''` with an empty pool).
 */
export function refereeingOf(hub: Hub, fight: Fight): Refereeing {
  const frames = fight.enc.frame;
  const referees: RefereeSpan[] = fight.spans
    .filter((s, k) => k === 0 || s.from < frames)
    .map((s) => ({ ...s }));
  const commit = hub.beacons.find('witness', '', { event: dutyEvent('enc', fight.enc.id) });
  return { referees, duty: commit?.id ?? '' };
}

/** The fight ended (settled or not): a witness that refereed it is done. */
export function witnessDone(hub: Hub, fight: Fight): void {
  const w = fight.witness;
  fight.witness = null;
  if (w && !w.failed) hub.duties.end(w.event, 'referee', 'done');
}
