// The combat HUD (M7 T12, DESIGN §3 and §10), shown only while the player is locked in a fight:
// three stance buttons with their keys (the current one lit), a brace button with its cooldown
// ring, a thin health arc round each opponent, and an escape ring round the player that fills
// while it is out of every opponent's escape range. The buttons sit in the bottom centre and count
// in the 6% HUD budget; the arcs and the ring live in the world, like the labels.

import type { Encounter, Stance } from '../sim/encounter/types';
import { RULES } from '../sim/rules';
import { maxHealth } from '../sim/vitals';
import { pick } from './dom';
import { type LabelProjection, screenX, screenY } from './labels';

const E = RULES.encounter;

/** The stances in key order (1, 2, 3). */
export const STANCES: readonly Stance[] = ['aggressive', 'balanced', 'evasive'];

/** An opponent's arc sits this many of its radii out, and the escape ring this many of the player's. */
export const ARC_RADII = 1.3;
export const ESCAPE_RADII = 1.55;

/** What the combat HUD shows, for `state().encounter.hud`. */
export interface CombatHudView {
  shown: boolean;
  /** The stance the player's input carries. */
  stance: Stance;
  brace: {
    /** A brace would start now: off cooldown, with the energy for it. */
    ready: boolean;
    /** 0..1, the share of the cooldown still to run (0 once off cooldown). */
    cooldown: number;
    /** The brace window is open now. */
    active: boolean;
  };
  /** Each living opponent's health as a share of its maximum, in slot order. */
  opponents: { player: string; health: number }[];
  /** 0..1, how far the escape has run (the player out of every opponent's escape range). */
  escape: number;
}

const HIDDEN: CombatHudView = {
  shown: false,
  stance: 'balanced',
  brace: { ready: false, cooldown: 0, active: false },
  opponents: [],
  escape: 0,
};

/** The HUD for the player in slot `own` of a fight, or hidden when it is not locked in one. */
export function combatHudOf(
  enc: Encounter | null,
  own: number,
  stance: Stance,
  locked: boolean,
): CombatHudView {
  const me = enc?.fighters[own];
  if (!enc || !me || !locked || me.status !== 'in') return HIDDEN;
  const tick = enc.world.tick;
  const { fx, body } = me;
  const left = Math.max(0, fx.braceReady - tick);
  const energy = body.energy >= E.brace.energyPerBiomass * body.biomass;
  return {
    shown: true,
    stance,
    brace: {
      ready: left === 0 && energy,
      cooldown: Math.min(1, left / E.brace.cooldownTicks),
      active: fx.braceUntil >= tick,
    },
    opponents: enc.fighters
      .filter((f) => f.slot !== own && f.status === 'in')
      .map((f) => ({
        player: f.player,
        health: Math.min(1, Math.max(0, f.body.health / maxHealth(f.body.biomass))),
      })),
    escape: Math.min(1, me.outside / E.escapeTicks),
  };
}

/** A drawn creature: where it is and its radius, in wu. */
export interface Drawn {
  id: string;
  x: number;
  y: number;
  radius: number;
}

const SVG = 'http://www.w3.org/2000/svg';
/** Arcs start at the top and run clockwise. */
const TOP = -90;

/** One ring on the marks layer: a faint track and the arc over it. */
class Ring {
  readonly group = document.createElementNS(SVG, 'g');
  private readonly track = document.createElementNS(SVG, 'circle');
  private readonly arc = document.createElementNS(SVG, 'circle');
  private key = '';

  constructor(parent: SVGSVGElement, kind: string) {
    this.group.setAttribute('class', `combat-ring ${kind}`);
    this.track.setAttribute('class', 'track');
    this.arc.setAttribute('class', 'arc');
    this.arc.setAttribute('pathLength', '100');
    this.group.append(this.track, this.arc);
    this.group.style.display = 'none';
    parent.append(this.group);
  }

  /** Draws it round (x, y) at radius `r` CSS px, filled to `share`; whole pixels and percents only. */
  show(x: number, y: number, r: number, share: number): void {
    const cx = Math.round(x);
    const cy = Math.round(y);
    const radius = Math.max(4, Math.round(r));
    const fill = Math.round(Math.min(1, Math.max(0, share)) * 100);
    const key = `${cx},${cy},${radius},${fill}`;
    if (this.group.style.display !== '') this.group.style.display = '';
    if (key === this.key) return;
    this.key = key;
    for (const c of [this.track, this.arc]) {
      c.setAttribute('cx', String(cx));
      c.setAttribute('cy', String(cy));
      c.setAttribute('r', String(radius));
    }
    this.arc.setAttribute('stroke-dasharray', `${fill} 100`);
    this.arc.setAttribute('transform', `rotate(${TOP} ${cx} ${cy})`);
  }

  hide(): void {
    if (this.group.style.display !== 'none') this.group.style.display = 'none';
  }
}

/** The DOM side: the buttons, the arcs and the escape ring. */
export class CombatHud {
  private readonly panel = pick('[data-testid="combat-hud"]');
  private readonly stances = STANCES.map((s) =>
    pick<HTMLButtonElement>(`[data-testid="stance-${s}"]`),
  );
  private readonly braceButton = pick<HTMLButtonElement>('[data-testid="brace"]');
  private readonly cooldown = pick<SVGCircleElement>('[data-testid="brace-cooldown"]');
  private readonly marks = pick<SVGSVGElement>('[data-testid="combat-marks"]');
  private readonly arcs: Ring[] = [];
  private readonly escapeRing: Ring;
  private lastStance: Stance | null = null;
  private lastCooldown = -1;
  private lastReady: boolean | null = null;
  private lastActive: boolean | null = null;
  view: CombatHudView = HIDDEN;

  constructor(actions: { stance(stance: Stance): void; brace(): void }) {
    this.escapeRing = new Ring(this.marks, 'escape');
    this.stances.forEach((button, i) => {
      button.addEventListener('click', () => actions.stance(STANCES[i] as Stance));
    });
    this.braceButton.addEventListener('click', () => actions.brace());
  }

  /**
   * Each frame: the panel and the rings for `view`. `self` is the player's drawn body, and
   * `drawn` the remotes as drawn (the fight places its fighters there).
   */
  update(
    view: CombatHudView,
    self: { x: number; y: number; radius: number },
    drawn: readonly Drawn[],
    p: LabelProjection,
  ): void {
    this.view = view;
    if (this.panel.hidden !== !view.shown) this.panel.hidden = !view.shown;
    if (this.marks.style.display !== (view.shown ? '' : 'none')) {
      this.marks.style.display = view.shown ? '' : 'none';
    }
    if (!view.shown) return;
    this.updateButtons(view);
    let used = 0;
    for (const o of view.opponents) {
      const r = drawn.find((d) => d.id === o.player);
      if (!r) continue;
      let ring = this.arcs[used];
      if (!ring) {
        ring = new Ring(this.marks, 'health');
        this.arcs[used] = ring;
      }
      used++;
      ring.show(screenX(r.x, p), screenY(r.y, p), ARC_RADII * r.radius * p.pxPerWu, o.health);
    }
    for (let i = used; i < this.arcs.length; i++) this.arcs[i]?.hide();
    if (view.escape > 0) {
      const r = ESCAPE_RADII * self.radius * p.pxPerWu;
      this.escapeRing.show(screenX(self.x, p), screenY(self.y, p), r, view.escape);
    } else this.escapeRing.hide();
  }

  private updateButtons(view: CombatHudView): void {
    if (view.stance !== this.lastStance) {
      this.lastStance = view.stance;
      this.stances.forEach((button, i) => {
        button.setAttribute('aria-pressed', String(STANCES[i] === view.stance));
      });
    }
    const { brace } = view;
    const cooldown = Math.round(brace.cooldown * 100);
    if (cooldown !== this.lastCooldown) {
      this.lastCooldown = cooldown;
      this.cooldown.setAttribute('stroke-dasharray', `${cooldown} 100`);
    }
    if (brace.ready !== this.lastReady) {
      this.lastReady = brace.ready;
      this.braceButton.toggleAttribute('data-ready', brace.ready);
    }
    if (brace.active !== this.lastActive) {
      this.lastActive = brace.active;
      this.braceButton.toggleAttribute('data-active', brace.active);
    }
  }
}
