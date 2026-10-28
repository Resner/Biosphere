// The growth meter and its cues (M6 T18): how far a creature is from its adult size, in plain words,
// and a signal each time it passes another tenth of it. Presentation only: it reads the sim, never
// feeds it.

import type { LifeStage } from '../sim/life';
import { RULES } from '../sim/rules';
import { sizeTier } from '../sim/size';
import { clock } from './mate-text';

/** Size is measured in biomass, the quantity maturity needs `RULES.life.matureBiomassShare` of. */
const STEPS = 10;
/** Keeps a share like 0.58 from flooring to 57% on float error. */
const EPS = 1e-9;

/** The share of the adult size, 0..1. */
export const sizeShare = (biomass: number, maxBiomass: number): number =>
  maxBiomass > 0 ? Math.min(1, biomass / maxBiomass) : 1;

export interface GrowthReading {
  biomass: number;
  maxBiomass: number;
  /** Active time so far, and the active time from which the creature counts as mature (0 = unknown). */
  activeMs: number;
  matureAtMs: number;
  stage: LifeStage;
}

/** "Size 62% of adult", plus "Mature in 4:10" once the size is enough and only time is missing. */
export function growthText(r: GrowthReading): string {
  const share = sizeShare(r.biomass, r.maxBiomass);
  const text = `Size ${Math.floor(share * 100 + EPS)}% of adult`;
  const waiting = r.stage === 'young' && r.matureAtMs > 0 && r.activeMs < r.matureAtMs;
  return share >= RULES.life.matureBiomassShare && waiting
    ? `${text} · Mature in ${clock(r.matureAtMs - r.activeMs)}`
    : text;
}

export type GrowthCue = 'step' | 'tier';

/** Tells when the size passes another tenth of the adult size, or into the next size tier. */
export class GrowthWatch {
  private step = -1;
  private tier = -1;

  /** The cue for this reading: a tier beats a step; the first reading of a life only sets the baseline. */
  update(biomass: number, maxBiomass: number): GrowthCue | null {
    const step = Math.floor(sizeShare(biomass, maxBiomass) * STEPS + EPS);
    const tier = sizeTier(biomass);
    const first = this.step < 0;
    const tierUp = tier > this.tier;
    const stepUp = step > this.step;
    // High-water marks: size lost to a mating or a bite does not cue again when it is regained.
    this.step = Math.max(this.step, step);
    this.tier = Math.max(this.tier, tier);
    if (first) return null;
    return tierUp ? 'tier' : stepUp ? 'step' : null;
  }

  reset(): void {
    this.step = -1;
    this.tier = -1;
  }
}
