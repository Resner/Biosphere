// A fight on screen and in the ears (M7 T12): the combat HUD, the telegraphs, the fight's eggs and
// its cues, wired to the app. The rules live in `combat-hud.ts`, `fight-cues.ts`,
// `render/telegraph.ts` and `eggs.ts`; this reads the fight each tick and each frame and hands
// them what they draw.

import type { CellView } from '../render/cell';
import { type TelegraphMark, Telegraphs, windupGlow } from '../render/telegraph';
import { EGG_CODE } from '../sim/encounter/egg';
import type { EncounterEvent } from '../sim/encounter/types';
import { RULES } from '../sim/rules';
import { maxHealth } from '../sim/vitals';
import type { App } from './app';
import type { EncounterView } from './app-encounter';
import { CombatHud, type CombatHudView, combatHudOf } from './combat-hud';
import type { FightEgg } from './eggs';
import { FightCues } from './fight-cues';
import type { LabelProjection } from './labels';

const E = RULES.encounter;
/** The escape ring's anchor when no own body is drawn (the ring only shows in a fight). */
const NO_SELF = { x: 0, y: 0, radius: 1 };

/** `state().encounter` with the HUD and the cues counted (M7 T12). */
export interface FightShowView extends EncounterView {
  hud: CombatHudView & { windups: number; blocks: number; hits: number };
}

export class FightShow {
  readonly telegraphs = new Telegraphs();
  readonly cues: FightCues;
  readonly hud: CombatHud;
  /** The fight eggs handed to the eggs each frame, by carrier (`self` for the player), reused. */
  private readonly eggs = new Map<string, FightEgg>();
  /** When each carrier's egg was first seen eaten (ms on the egg clock), for the fight `fightId`. */
  private readonly eaten = new Map<string, number>();
  private fightId = '';
  /** The player's eaten egg and the pending child it held: a later child's egg is not that one. */
  private ownEaten: { child: unknown; at: number } | null = null;
  readonly fightEgg = (player: string): FightEgg | null => this.eggOf(player);

  constructor(private readonly app: App) {
    this.cues = new FightCues({
      cue: (cue, at) => app.sound.cue(cue, { x: at.x, y: at.y }),
      hurt: (amount, struck) => {
        const { session, shake, fx, cueWatch } = app;
        // A hit in a fight is a strike's; anything else there is the water's (a plume, starving).
        const cause = struck ? 'killed' : 'toxin';
        if (!shake.hit(cause, amount, session.ticks)) return;
        fx.hurtFlash(shake.hitDamage);
        cueWatch.hit(cause, session.ticks);
      },
      flash: (player) => this.telegraphs.flash(player),
      spark: (x, y, radius) => this.telegraphs.spark(x, y, radius),
      stagger: (player) => this.telegraphs.wobble(player),
    });
    this.hud = new CombatHud({
      stance: (stance) => {
        if (app.fight.fighting) app.fight.stance = stance;
      },
      brace: () => app.fight.brace(),
    });
  }

  /** The events of each frame the fight simulates. */
  onEvents(events: readonly EncounterEvent[]): void {
    const { sync } = this.app.fight;
    if (sync?.enc) this.cues.events(sync.enc, sync.slot, events);
  }

  /** Each game tick the fight moved the player: windups aimed at it, and its own damage. */
  tick(): void {
    const { sync } = this.app.fight;
    if (sync?.enc) this.cues.tick(sync.enc, sync.slot);
  }

  /**
   * Each frame, before the scene draws: the telegraphs' marks (returned), the flashes and wobbles
   * on the drawn bodies, and the HUD. `self` is the player's drawn body, null when none is.
   */
  frame(dt: number, self: CellView | null, p: LabelProjection): readonly TelegraphMark[] {
    const { app, telegraphs } = this;
    const { fight, remoteViews } = app;
    const reduced = app.motionReduced();
    const sync = fight.sync;
    const enc = fight.fighting ? sync?.enc : null;
    telegraphs.update(dt);
    telegraphs.begin();
    const me = app.playerId ?? '';
    for (const r of remoteViews) {
      const inFight = enc ? enc.fighters.some((f) => f.player === r.id) : false;
      if (!inFight) {
        // A creature fighting elsewhere wears a faint ring; its snapshot's health drops flash it.
        telegraphs.watchHealth(r.id, r.health);
        if (r.fighting && r.alpha >= 0.01) telegraphs.ring(r.x, r.y, r.radius);
      }
      r.hurt = telegraphs.hurt(r.id);
      r.heading += telegraphs.wobbleOf(r.id, reduced);
    }
    if (self) self.heading += telegraphs.wobbleOf(me, reduced);
    if (enc && sync) {
      const tick = enc.world.tick;
      for (const f of enc.fighters) {
        if (f.status !== 'in' || f.fx.windupEnd < 0) continue;
        const drawn = f.slot === sync.slot ? self : remoteViews.find((r) => r.id === f.player);
        if (!drawn) continue;
        const glow = windupGlow(f.fx.windupEnd - tick);
        telegraphs.glow(
          drawn.x,
          drawn.y,
          drawn.heading,
          drawn.radius,
          f.combat.reach,
          f.combat.arc,
          glow,
        );
      }
    }
    // The player's target, where a fight offers a choice (M7 T15): on the body as drawn, or its egg.
    const aim = enc && sync ? fight.aim() : null;
    if (aim && sync) {
      const slot = aim.code % EGG_CODE;
      const carrier = enc?.fighters[slot];
      if (aim.code >= EGG_CODE) {
        const at = sync.eggAt(slot, fight.hubNow());
        const radius = carrier?.eggBody?.radius ?? 0;
        if (at) telegraphs.target(at.x, at.y, radius, aim.chosen);
      } else {
        const drawn = remoteViews.find((r) => r.id === carrier?.player);
        if (drawn) telegraphs.target(drawn.x, drawn.y, drawn.radius, aim.chosen);
      }
    }
    const marks = telegraphs.end();
    const own = sync?.slot ?? -1;
    const view = combatHudOf(sync?.enc ?? null, own, fight.stance, fight.fighting);
    this.hud.update(view, self ?? NO_SELF, remoteViews, p);
    return marks;
  }

  /** A carrier's egg in the player's fight, as the eggs draw it; null leaves it on its tether. */
  private eggOf(player: string): FightEgg | null {
    const { app } = this;
    const sync = app.fight.sync;
    const enc = sync?.enc;
    if (!sync || !enc) return null;
    const now = app.eggClock();
    if (enc.id !== this.fightId) {
      this.fightId = enc.id;
      this.eaten.clear();
    }
    const id = player === 'self' ? app.playerId : player;
    const f = enc.fighters.find((x) => x.player === id);
    const egg = f?.eggBody;
    if (!f || !egg) return null;
    const eaten = egg.by >= 0;
    if (!sync.running && !eaten) return null;
    let eatenAt: number | null = null;
    if (eaten) {
      eatenAt = this.eaten.get(player) ?? now;
      this.eaten.set(player, eatenAt);
      if (player === 'self') {
        const child = app.offspring.child();
        if (this.ownEaten?.at !== eatenAt) this.ownEaten = { child, at: eatenAt };
        // A new pending child is not the eaten one: its egg hangs on its tether.
        else if (this.ownEaten.child !== child) return null;
      }
    }
    // An eaten egg of a peer stays gone until its snapshots stop saying it carries one.
    if (eaten && player !== 'self' && !sync.running) {
      const r = app.remoteViews.find((v) => v.id === player);
      if (!r?.egg) return null;
    }
    const at = sync.eggAt(f.slot, app.fight.hubNow()) ?? egg;
    const full = E.egg.healthShare * maxHealth(f.body.biomass);
    const lost = full > 0 ? 1 - Math.max(0, egg.health) / full : 0;
    return this.reuse(player, at.x, at.y, egg.radius, lost, eatenAt);
  }

  private reuse(
    player: string,
    x: number,
    y: number,
    radius: number,
    lost: number,
    eatenAt: number | null,
  ): FightEgg {
    let egg = this.eggs.get(player);
    if (!egg) {
      egg = { x, y, radius, lost, eatenAt };
      this.eggs.set(player, egg);
    }
    egg.x = x;
    egg.y = y;
    egg.radius = radius;
    egg.lost = Math.min(1, Math.max(0, lost));
    egg.eatenAt = eatenAt;
    return egg;
  }

  /** `state().encounter`: the fight with its HUD and the cues counted; null before the first. */
  view(): FightShowView | null {
    const view = this.app.fight.view();
    if (!view) return null;
    const { cues } = this;
    return {
      ...view,
      hud: { ...this.hud.view, windups: cues.windups, blocks: cues.blocks, hits: cues.hits },
    };
  }
}
