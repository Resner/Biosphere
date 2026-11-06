// The movement check at lock-in (ADR 0059, M10 T11): the attacker's own signed snapshots that the
// target held, in tick order with its engage snapshot, must never be further apart than it could
// swim. Pure; `engage.ts` verifies the snapshots and decides what a jump costs.

import type { Snapshot } from '../src/net/protocol';
import type { PhysStats } from '../src/sim/body';
import { RULES, TICK_HZ } from '../src/sim/rules';

const M = RULES.movement;

/** The top speed's margin in the bound: an evasive stance thrusts 1.2 ×, and the wall's push adds a little. */
export const SPEED_MARGIN = 1.25;
/** The bound's slack in wu: position quantisation and a body's rounding either way. */
export const MOVE_SLACK_WU = 8;

/**
 * An attacker whose own fight ended this recently is not checked: the target's `seen` (2 s) may
 * still hold its fight's snapshots, moved by the referee's collisions and the client's rollbacks.
 */
export const AFTER_FIGHT_MS = 3000;

/** What the check reads of a snapshot. */
export type PathPoint = Pick<Snapshot, 'tick' | 'x' | 'y'>;

/** Speed through still water at full thrust (thrust ÷ drag), in wu/s, at `biomass`. */
export function swimSpeed(phys: PhysStats, biomass: number): number {
  const scale = (biomass / RULES.starter.biomass) ** M.thrustExp;
  return (M.thrust * phys.thrust * scale) / (M.drag * phys.drag);
}

/** The speed a dash adds, in wu/s, at `biomass` (`applyMovement`). */
export function dashSpeedOf(phys: PhysStats, biomass: number): number {
  const scale = (biomass / RULES.starter.biomass) ** M.dashExp;
  return M.dashSpeed * scale * Math.sqrt(phys.thrust / phys.drag);
}

/** The furthest an honest body swims in `seconds`: (1.25 × top speed + dash + strongest current) × time + 8 wu. */
export function moveBound(phys: PhysStats, biomass: number, seconds: number): number {
  const speed =
    SPEED_MARGIN * swimSpeed(phys, biomass) + dashSpeedOf(phys, biomass) + RULES.currents.maxSpeed;
  return speed * seconds + MOVE_SLACK_WU;
}

/** Whether two neighbours of the path, ordered by tick, are further apart than the bound. */
export function jumped(path: readonly PathPoint[], phys: PhysStats, biomass: number): boolean {
  const sorted = [...path].sort((a, b) => a.tick - b.tick);
  for (let i = 1; i < sorted.length; i++) {
    const a = sorted[i - 1] as PathPoint;
    const b = sorted[i] as PathPoint;
    const apart = Math.hypot(b.x - a.x, b.y - a.y);
    if (apart > moveBound(phys, biomass, (b.tick - a.tick) / TICK_HZ)) return true;
  }
  return false;
}
