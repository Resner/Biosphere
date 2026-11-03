// What a fight shows and sounds (M7 T12, DESIGN §10), from the encounter the player is locked in:
// a windup aimed at the player (or its egg) ticks once; a landed hit flashes its target, and the
// player's own damage lands through the damage-hit cadence (the thud, the flash, the kick); a block
// sparks, clinks and wobbles the staggered attacker; a kill gulps; an eaten egg cracks. A rollback
// replays frames, so each event is shown once: a hit by its tick, a death or an eaten egg by its
// slot. Pure rules on the encounter's state; the shell does what the sink asks.

import type { Cue } from '../audio/cues';
import { radiusOf } from '../sim/encounter/reach';
import type { Encounter, EncounterEvent, Fighter } from '../sim/encounter/types';

export interface FightCueSink {
  /** A cue placed at a point. */
  cue(cue: Cue, at: { x: number; y: number }): void;
  /** The player's own fighter lost `amount` health this tick; `struck` when a hit did it. */
  hurt(amount: number, struck: boolean): void;
  /** A landed hit on another fighter's body. */
  flash(player: string): void;
  /** A blocked hit at (x, y) on a body or egg of `radius`. */
  spark(x: number, y: number, radius: number): void;
  /** A blocked attacker is staggered. */
  stagger(player: string): void;
}

/** Another fighter's hits thud at most this often (ticks), as the player's own (`SHAKE`'s 15). */
const THUD_GAP_TICKS = 15;
/** Shown keys kept: a fight is at most 900 frames, and this covers far more than a rollback. */
const KEPT = 512;

export class FightCues {
  private id = '';
  private readonly shown = new Set<string>();
  private readonly thudAt = new Map<number, number>();
  private health = Number.NaN;
  private struck = false;
  /** Windups heard so far, blocks and hits shown (for the hook). */
  windups = 0;
  blocks = 0;
  hits = 0;

  constructor(private readonly sink: FightCueSink) {}

  /** A fight begins (or the next one): nothing of the last carries over. */
  private begin(enc: Encounter): void {
    this.id = enc.id;
    this.shown.clear();
    this.thudAt.clear();
    this.health = Number.NaN;
    this.struck = false;
  }

  /** One simulated frame's events, the player in slot `own`. */
  events(enc: Encounter, own: number, events: readonly EncounterEvent[]): void {
    if (enc.id !== this.id) this.begin(enc);
    for (const e of events) {
      if (e.type === 'hit') this.hit(enc, own, e);
      else if (e.type === 'death') {
        // The victim hears its own death tone; everyone else hears the kill.
        if (e.cause !== 'killed' || e.slot === own || !this.once(`d${e.slot}`)) continue;
        const f = enc.fighters[e.slot];
        if (f) this.sink.cue('kill', f.body);
      } else if (e.type === 'egg') {
        if (!this.once(`e${e.slot}`)) continue;
        const egg = enc.fighters[e.slot]?.eggBody;
        if (egg) this.sink.cue('egg-eaten', egg);
      }
    }
  }

  private hit(enc: Encounter, own: number, e: Extract<EncounterEvent, { type: 'hit' }>): void {
    if (!this.once(`h${e.tick}:${e.slot}:${e.by}:${e.kind}:${e.egg ? 1 : 0}`)) return;
    const target = enc.fighters[e.slot];
    const by = enc.fighters[e.by];
    if (!target) return;
    const at = e.egg && target.eggBody ? target.eggBody : target.body;
    const radius = e.egg && target.eggBody ? target.eggBody.radius : radiusOf(target.body);
    if (e.blocked) {
      this.blocks++;
      this.sink.spark(at.x, at.y, radius);
      this.sink.cue('block', at);
      if (by && e.kind !== 'spines') this.sink.stagger(by.player);
    }
    if (e.egg) return;
    this.hits++;
    if (e.slot === own) {
      this.struck = true;
      return;
    }
    this.sink.flash(target.player);
    const last = this.thudAt.get(e.slot);
    if (last === undefined || e.tick - last >= THUD_GAP_TICKS) {
      this.thudAt.set(e.slot, e.tick);
      this.sink.cue('hurt', at);
    }
  }

  /**
   * Once per game tick of a fight: a new windup aimed at the player or its egg ticks, and the own
   * fighter's lost health lands as damage.
   */
  tick(enc: Encounter, own: number): void {
    if (enc.id !== this.id) this.begin(enc);
    const tick = enc.world.tick;
    for (const f of enc.fighters) {
      if (f.slot === own || f.status !== 'in' || !aimsAt(f, own, tick)) continue;
      if (!this.once(`w${f.slot}:${f.fx.windupEnd}`)) continue;
      this.windups++;
      this.sink.cue('windup', f.body);
    }
    const me = enc.fighters[own];
    if (!me) return;
    const health = me.body.health;
    if (health < this.health) this.sink.hurt(this.health - health, this.struck);
    if (health !== this.health) this.struck = false;
    this.health = health;
  }

  private once(key: string): boolean {
    if (this.shown.has(key)) return false;
    if (this.shown.size >= KEPT) this.shown.clear();
    this.shown.add(key);
    return true;
  }
}

/** Whether `f` is winding up a strike on slot `own`'s body or egg at `tick`. */
export function aimsAt(f: Fighter, own: number, tick: number): boolean {
  const { windupEnd, windupTarget } = f.fx;
  return windupEnd >= tick && (windupTarget === own || windupTarget === own + 4);
}
