// A witness's referee (ADR 0058, M10 T3): it referees a fight from frame `h` on, as the authority
// would. It runs the same `Referee` on its own estimate of the hub's clock, restored at `h` with the
// fight's joins, and steps its own copy of the encounter with every final frame, so it knows who
// is out and when the fight ends. Each final frame goes to every fighter as a signed `wframe`, and
// every `BATCH_FRAMES` frames (and at once at the end or a stop) the authority gets a `batch` with
// each input's signature. Pure: the clock, the signer and the sends are injected.

import type { Creature } from '../genome/stats';
import type { KeyVerify } from '../ledger/key-verify';
import { keyVerifier } from '../ledger/key-verify';
import { inputSigned } from '../ledger/witness';
import { createEncounter, hashEncounter, stepFrame } from '../sim/encounter/encounter';
import { applyJoins } from '../sim/encounter/join';
import type { Encounter, EncounterJoin } from '../sim/encounter/types';
import { bodyFromText, encounterStartOf, fighterStartOf } from './encounter-start';
import { BATCH_FRAMES } from './handover';
import type { ClientMsg, HubMsg, PeerEvent } from './protocol-defs';
import { type Bundle, type InputVerdict, Referee } from './referee';

export type RefereeDuty = Extract<HubMsg, { t: 'duty'; role: 'referee' }>;
export type FighterInput = Extract<PeerEvent, { t: 'finput' }>;
export type WitnessFrame = Extract<PeerEvent, { t: 'wframe' }>;
export type BatchMsg = Extract<ClientMsg, { t: 'batch' }>;

/**
 * What became of a fighter's input: the referee's verdict, or `stray` (not a fighter, or another
 * encounter), `forged` (its signature fails) or `moved` (a frame past the witness's stop).
 */
export type WitnessVerdict = InputVerdict | 'stray' | 'forged' | 'moved';

export interface WitnessRefereeOptions {
  /** The referee duty: the fight's start, its history, the pond's seed and the fighters by slot. */
  duty: Pick<RefereeDuty, 'start' | 'history' | 'pondSeed' | 'fighters'>;
  /** The first frame this witness referees (`enc-referee.from`). */
  from: number;
  /** The witness's estimate of the hub's clock. */
  now(): number;
  /** The witness's signature on final frame `f` (`signWitnessFrame`). */
  signFrame(f: number, inputs: readonly (number | null)[]): string;
  /** A final frame, signed, for every fighter. */
  sendFrame(ev: WitnessFrame): void;
  sendBatch(msg: BatchMsg): void;
  /** A fighter's key; `keyVerifier` by default, tabled once per fighter. */
  keyOf?(player: string): KeyVerify | null;
  bodies?(genome: string): Creature | null;
  /**
   * Whether a taken input finalizes what is due at once (the default). A page passes false and
   * calls `tick` itself in a task of its own, so checking an input's signature and signing a frame
   * never share one handler (M10 T7).
   */
  tickOnInput?: boolean;
}

export class WitnessReferee {
  /** The fight's id. */
  readonly enc: string;
  /** The witness's copy of the fight. */
  readonly encounter: Encounter;
  /** The first frame it referees. */
  readonly from: number;
  /** Inputs taken, frames finalized and batches sent. */
  taken = 0;
  frames = 0;
  batches = 0;
  /** Inputs dropped, by verdict. */
  readonly dropped: Partial<Record<Exclude<WitnessVerdict, 'ok'>, number>> = {};
  /** No more frames are finalized: the fight ended, a stop was reached, or `stop()`. */
  done = false;

  private readonly opts: WitnessRefereeOptions;
  private readonly referee: Referee;
  private readonly joins: EncounterJoin[];
  private readonly players: string[];
  private readonly keys: (KeyVerify | null)[];
  /** The signature of each taken input of a frame not yet final. */
  private readonly sigs = new Map<number, (string | null)[]>();
  private batch: { f: number; i: (number | null)[][]; s: (string | null)[][] } | null = null;
  /** The first frame not this witness's (`stopAt`). */
  private limit = Number.POSITIVE_INFINITY;

  /** Throws a `RangeError` for a duty that does not build, or a start before its history's end. */
  constructor(opts: WitnessRefereeOptions) {
    this.opts = opts;
    const { start, history, pondSeed, fighters } = opts.duty;
    const bodies = opts.bodies ?? bodyFromText;
    const first = encounterStartOf(start, pondSeed, bodies);
    if (!first) throw new RangeError('the start does not build');
    this.enc = start.enc;
    this.encounter = createEncounter(first);
    this.joins = [];
    this.players = start.fighters.map((f) => f.player);
    for (const h of history) {
      if (h.t !== 'enc-join') continue;
      const fighter = fighterStartOf(h.fighter, bodies);
      if (!fighter) throw new RangeError('a join does not build');
      this.joins.push({ f: h.f, fighter });
      this.players.push(h.fighter.player);
    }
    if (fighters.length !== this.players.length || fighters.some((p, s) => p !== this.players[s])) {
      throw new RangeError('the fighters are not the start’s and the joins’');
    }
    for (const h of history) {
      if (h.t === 'enc-frame' && !this.step(h.f, h.i)) {
        throw new RangeError(`history frame ${h.f} out of order`);
      }
    }
    if (!Number.isInteger(opts.from) || opts.from < this.encounter.frame) {
      throw new RangeError(`a handover at ${opts.from}, with ${this.encounter.frame} frames final`);
    }
    this.from = opts.from;
    this.referee = new Referee({
      startAt: start.at,
      slots: start.fighters.length,
      next: opts.from,
      joins: this.joins.map((j) => j.f),
    });
    this.retireOut();
    const keyOf = opts.keyOf ?? keyVerifier;
    this.keys = this.players.map((p) => keyOf(p));
  }

  /** The next frame to finalize. */
  get next(): number {
    return this.referee.next;
  }

  /** The witness's `hashEncounter`. */
  hash(): string {
    return hashEncounter(this.encounter);
  }

  /**
   * A final frame from the authority, before `from` (it sends them up to `from − 1` after the
   * handover). In order only; false for anything else.
   */
  hubFrame(msg: { f: number; i: (number | null)[] }): boolean {
    if (msg.f >= this.from || !this.step(msg.f, msg.i)) return false;
    this.retireOut();
    this.tick();
    return true;
  }

  /** A fighter's input; `from` is the peer it came from. */
  input(from: string, ev: FighterInput): WitnessVerdict {
    const verdict = this.take(from, ev);
    if (verdict === 'ok') {
      this.taken++;
      if (this.opts.tickOnInput !== false) this.tick();
    } else {
      this.dropped[verdict] = (this.dropped[verdict] ?? 0) + 1;
    }
    return verdict;
  }

  private take(from: string, ev: FighterInput): WitnessVerdict {
    const slot = this.players.indexOf(from);
    if (ev.enc !== this.enc || slot < 0) return 'stray';
    if (ev.f < this.from) return 'late';
    if (ev.f >= this.limit) return 'moved';
    if (this.done) return 'late';
    const key = this.keys[slot];
    if (!key || !inputSigned(key, this.enc, ev.f, ev.i, ev.sig)) return 'forged';
    const verdict = this.referee.input(slot, ev.f, ev.i, this.opts.now());
    if (verdict === 'ok') {
      let sigs = this.sigs.get(ev.f);
      if (!sigs) {
        sigs = new Array<string | null>(this.referee.width(ev.f)).fill(null);
        this.sigs.set(ev.f, sigs);
      }
      sigs[slot] = ev.sig;
    }
    return verdict;
  }

  /**
   * Finalizes every frame due by now, once the authority's frames before `from` are in: each is
   * stepped, signed and sent, and batched. The fight's end or the stop closes the last batch.
   */
  tick(): void {
    if (this.done || this.encounter.frame < this.from) return;
    if (this.referee.next >= this.limit) {
      this.finish();
      return;
    }
    for (const bundle of this.referee.due(this.opts.now())) {
      if (bundle.f >= this.limit) break;
      this.finalize(bundle);
      if (this.encounter.over) break;
    }
    if (this.encounter.over || this.referee.next >= this.limit) this.finish();
  }

  /** When `tick` next has a frame to finalize: its deadline, or never once done or still waiting for the authority's frames. */
  nextDeadline(): number {
    if (this.done || this.encounter.frame < this.from) return Number.POSITIVE_INFINITY;
    return this.referee.nextDeadline();
  }

  /**
   * A planned take-back from frame `h`: the witness finalizes frames up to `h − 1` as they come
   * due, then sends its final batch. Frames it finalized from `h` on stay out of it.
   */
  stopAt(h: number): void {
    if (this.done) return;
    this.limit = Math.min(this.limit, Math.max(h, this.from));
    this.trim();
    this.tick();
  }

  /** Stops at once (a `duty-end`, a failed take-back): nothing more is sent. */
  stop(): void {
    this.done = true;
    this.batch = null;
  }

  private finalize(bundle: Bundle): void {
    const { f, i } = bundle;
    this.step(f, i);
    this.retireOut();
    const sigs = this.sigs.get(f);
    this.sigs.delete(f);
    const s = i.map((code, slot) => (code === null ? null : (sigs?.[slot] ?? null)));
    this.frames++;
    this.opts.sendFrame({
      t: 'wframe',
      enc: this.enc,
      f,
      i: [...i],
      sig: this.opts.signFrame(f, i),
    });
    if (!this.batch) this.batch = { f, i: [], s: [] };
    this.batch.i.push([...i]);
    this.batch.s.push(s);
    // The fight's last frame, and the stop's, go in the final batch.
    const last = this.encounter.over || f + 1 >= this.limit;
    if (this.batch.i.length >= BATCH_FRAMES && !last) this.flush(false);
  }

  /** Steps the witness's encounter with frame `f`, in order and of the right width; false otherwise. */
  private step(f: number, inputs: readonly (number | null)[]): boolean {
    const enc = this.encounter;
    if (enc.over || f !== enc.frame) return false;
    applyJoins(enc, this.joins);
    if (inputs.length !== enc.fighters.length) return false;
    stepFrame(enc, inputs);
    return true;
  }

  /** Fighters who are out hold no frame back. */
  private retireOut(): void {
    for (const fighter of this.encounter.fighters) {
      if (fighter.status !== 'in') this.referee.retire(fighter.slot);
    }
  }

  /** Drops batched frames from the limit on. */
  private trim(): void {
    const b = this.batch;
    if (!b) return;
    const keep = Math.max(0, this.limit - b.f);
    b.i.length = Math.min(b.i.length, keep);
    b.s.length = b.i.length;
    if (b.i.length === 0) this.batch = null;
  }

  private flush(end: boolean): void {
    const b = this.batch;
    this.batch = null;
    if (!b) return;
    this.batches++;
    this.opts.sendBatch({ t: 'batch', enc: this.enc, f: b.f, i: b.i, s: b.s, end });
  }

  /** The last batch, marked as the end of the span; with nothing left in it, none is sent. */
  private finish(): void {
    this.trim();
    this.flush(true);
    this.done = true;
  }
}
