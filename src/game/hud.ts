import { RULES } from '../sim/rules';
import type { CreatureState } from '../sim/types';
import { maxEnergy, maxHealth } from '../sim/vitals';
import { pick } from './dom';
import type { LifeClock } from './life';
import { remainingText, stageWord } from './life-text';
import { LOW_ENERGY } from './low-energy';
import type { ZoneReadout } from './zone-readout';

/** Writes only when the text changed, so a steady readout costs no DOM work. */
function setText(element: HTMLElement, text: string): void {
  if (element.textContent !== text) element.textContent = text;
}

function setAttr(element: HTMLElement, name: string, value: string): void {
  if (element.getAttribute(name) !== value) element.setAttribute(name, value);
}

function setHidden(element: HTMLElement, hidden: boolean): void {
  if (element.hidden !== hidden) element.hidden = hidden;
}

const clamp01 = (fraction: number): number => Math.min(1, Math.max(0, fraction));

function percent(fraction: number): string {
  return `${Math.round(clamp01(fraction) * 100)}%`;
}

function setBar(bar: HTMLElement, fraction: number): void {
  const width = percent(fraction);
  if (bar.style.width !== width) bar.style.width = width;
}

/** The chips beside the bars, in the order they sit (M6b T9). */
export type Chip = 'egg' | 'ready' | 'practice' | 'offline';
const CHIPS: readonly Chip[] = ['egg', 'ready', 'practice', 'offline'];

/** What the stat bars show, each 0..1 as drawn; `life` is null while its bar is hidden. */
export interface HudBars {
  health: number;
  energy: number;
  size: number;
  life: number | null;
}

/** One thin bar on the play screen: a meter whose value is also its tooltip. */
class StatBar {
  value = 0;
  private readonly fill: HTMLElement;

  constructor(
    readonly root: HTMLElement,
    fill: string,
  ) {
    this.fill = pick(`[data-bar="${fill}"]`);
  }

  get bar(): HTMLElement {
    return this.fill;
  }

  set(fraction: number, tip: string): void {
    this.value = clamp01(fraction);
    setBar(this.fill, this.value);
    setAttr(this.root, 'aria-valuenow', String(Math.round(this.value * 100)));
    setAttr(this.root, 'aria-valuetext', tip);
    setAttr(this.root, 'title', tip);
  }
}

/**
 * The play screen's status (M6b T9): four thin stat bars and a compact depth bar in the bottom-left
 * corner, chips beside them only while they apply, and the numbers in words inside the menu. Each
 * bar has its own icon shape, so colour is never the only signal.
 */
export class Hud {
  private readonly biomass = pick('[data-testid="hud-biomass"]');
  private readonly energy = pick('[data-testid="hud-energy"]');
  private readonly health = pick('[data-testid="hud-health"]');
  private readonly growth = pick('[data-testid="hud-growth"]');
  private readonly healthBar = new StatBar(pick('[data-testid="hud-bar-health"]'), 'health');
  private readonly energyBar = new StatBar(pick('[data-testid="hud-bar-energy"]'), 'energy');
  private readonly sizeBar = new StatBar(pick('[data-testid="hud-bar-size"]'), 'growth');
  private readonly lifeBar = new StatBar(pick('[data-testid="hud-bar-life"]'), 'life');
  private readonly depthBar = new StatBar(pick('[data-testid="hud-depth"]'), 'depth');

  private readonly energyMeter = pick('[data-meter="energy"]');
  private readonly species = pick('[data-testid="hud-species"]');
  private readonly lifeRows = pick('[data-testid="hud-life"]');
  private readonly stage = pick('[data-testid="hud-stage"]');
  private readonly lifeLeft = pick('[data-testid="hud-remaining"]');
  private readonly ready = pick('[data-testid="hud-ready"]');
  private readonly toastElement = pick('[data-testid="toast"]');
  private readonly zone = pick('[data-testid="hud-zone"]');
  private readonly zoneWarning = pick('[data-testid="hud-zone-warning"]');
  private readonly uvCue = pick('[data-testid="uv-cue"]');
  private readonly pressureCue = pick('[data-testid="pressure-cue"]');
  private readonly chips: Record<Chip, HTMLElement> = {
    egg: pick('[data-testid="hud-egg"]'),
    ready: pick('[data-testid="hud-mate-ready"]'),
    practice: pick('[data-testid="practice-badge"]'),
    offline: pick('[data-testid="hud-offline"]'),
  };
  private toastTimer: ReturnType<typeof setTimeout> | undefined;
  private low = false;

  constructor() {
    // The size bar's tick: the share of the adult size maturity needs.
    const tick = this.sizeBar.root.querySelector<HTMLElement>('.tick');
    if (tick) tick.style.left = percent(RULES.life.matureBiomassShare);
  }

  /** Names the body of the life that has just started. */
  setBody(label: string): void {
    setText(this.species, label);
  }

  /** The life bar, stage word and time left; null hides them (a practice cell has no lifespan). */
  setLife(clock: LifeClock | null): void {
    setHidden(this.lifeRows, clock === null);
    setHidden(this.lifeBar.root, clock === null);
    if (!clock) {
      // A new life starts without the last one's toast.
      clearTimeout(this.toastTimer);
      this.toastElement.hidden = true;
      return;
    }
    const stage = stageWord(clock.stage);
    const left = remainingText(clock.remainingMs);
    setText(this.stage, stage);
    setText(this.lifeLeft, left);
    const share = clock.remainingMs / clock.lifespanMs;
    this.lifeBar.set(share, `Life ${percent(share)} left · ${stage}${left ? ` · ${left}` : ''}`);
    const old = clock.stage === 'old';
    if (this.lifeBar.root.hasAttribute('data-old') !== old)
      this.lifeBar.root.toggleAttribute('data-old', old);
  }

  /** The size line in the menu ("Size 62% of adult · Mature in 4:10") and the size bar. */
  setGrowth(text: string, share: number): void {
    setText(this.growth, text);
    this.sizeBar.set(share, text);
  }

  /** The mating readiness in the menu: "Ready to mate", "Ready in 2:10", or nothing. */
  setReady(text: string): void {
    setText(this.ready, text);
  }

  /** The heart chip: mature, rested and free to mate (the mark peers see). */
  setMateReady(ready: boolean): void {
    setHidden(this.chips.ready, !ready);
  }

  /**
   * The compact depth bar (the zone's name as its tooltip and in the menu), the hazard in words
   * beside it, and the UV shimmer and pressure vignette over the view while that hazard hurts.
   */
  setZone(readout: ZoneReadout): void {
    setText(this.zone, readout.name);
    this.depthBar.set(readout.depth, `Depth · ${readout.name}`);
    setText(this.zoneWarning, readout.uv ? 'UV burns' : readout.pressure ? 'Pressure crushes' : '');
    if (this.uvCue.hidden === readout.uv) this.uvCue.hidden = !readout.uv;
    if (this.pressureCue.hidden === readout.pressure) this.pressureCue.hidden = !readout.pressure;
  }

  /** The egg chip ("H" to hatch) while a pending child is carried (M6 T20). */
  setEgg(carried: boolean): void {
    setHidden(this.chips.egg, !carried);
  }

  /** "Not recorded" on a practice cell. */
  setPractice(practice: boolean): void {
    setHidden(this.chips.practice, !practice);
  }

  /** The offline dot, with the status line as its name and tooltip; null hides it. */
  setOffline(status: string | null): void {
    setHidden(this.chips.offline, status === null);
    if (status === null) return;
    const label = status.startsWith('Offline') ? status : `Offline · ${status}`;
    setAttr(this.chips.offline, 'aria-label', label);
    setAttr(this.chips.offline, 'title', label);
  }

  /**
   * The price of a mating lands (M6 T20): the energy and size bars drain from their old shares to
   * their new ones with a warm highlight, so the cost is felt as well as read.
   */
  drain(from: { energy: number; size: number }, to: { energy: number; size: number }): void {
    const highlight = 'brightness(2) drop-shadow(0 0 6px #ffd27a)';
    for (const [bar, a, b] of [
      [this.energyBar.bar, from.energy, to.energy],
      [this.sizeBar.bar, from.size, to.size],
    ] as const) {
      bar.animate(
        [
          { width: percent(a), filter: highlight },
          { width: percent(a), filter: highlight, offset: 0.25 },
          { width: percent(b), filter: 'none' },
        ],
        { duration: 1100, easing: 'ease-in-out' },
      );
    }
  }

  /** A short line in the middle of the screen. */
  toast(text: string, ms = 4000): void {
    this.toastElement.textContent = text;
    this.toastElement.hidden = false;
    clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => {
      this.toastElement.hidden = true;
    }, ms);
  }

  /** Restarts the short brightening of the energy bar after eating. */
  pulseEnergy(): void {
    for (const part of [this.energyBar.root, this.energy]) {
      part.animate(
        [{ filter: 'brightness(2.2) drop-shadow(0 0 6px #8de88a)' }, { filter: 'none' }],
        { duration: 450, easing: 'ease-out' },
      );
    }
  }

  update(creature: CreatureState): void {
    const energy = Math.max(0, creature.energy / maxEnergy(creature.biomass));
    const health = creature.health / maxHealth(creature.biomass);
    const low = energy < LOW_ENERGY;
    if (low !== this.low) {
      this.low = low;
      this.energyMeter.toggleAttribute('data-low', low);
      this.energyBar.root.toggleAttribute('data-low', low);
    }
    setText(this.biomass, String(Math.round(creature.biomass)));
    setText(this.energy, `${Math.round(energy * 100)}%`);
    setText(this.health, String(Math.round(creature.health)));
    this.energyBar.set(energy, `Energy ${percent(energy)}`);
    this.healthBar.set(health, `Health ${percent(health)}`);
  }

  /** The bars and chips as drawn, for `state().hud`. */
  view(): { bars: HudBars; chips: Chip[] } {
    return {
      bars: {
        health: this.healthBar.value,
        energy: this.energyBar.value,
        size: this.sizeBar.value,
        life: this.lifeBar.root.hidden ? null : this.lifeBar.value,
      },
      chips: CHIPS.filter((chip) => !this.chips[chip].hidden),
    };
  }
}
