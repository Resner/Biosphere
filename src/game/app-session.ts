import type { SnapshotSender } from '../net/pond-sync';
import type { Vec2 } from '../net/protocol';
import { colliderReach } from '../sim/body';
import { RULES, TICK_HZ } from '../sim/rules';
import { findClearSpot } from '../sim/spawn';
import type { CreatureState, World } from '../sim/types';
import { createWorld, spawnCreature } from '../sim/world';
import type { Body } from './body';
import type { ScriptedRemote } from './debug';
import type { PondFood } from './pond-food';
import type { PondTime } from './pond-time';
import type { DeathSummary } from './screens';

export const MAX_THROTTLE = RULES.movement.maxThrottle;
/** The creature's condition goes to the hub every 30 s of play (ADR 0019). */
export const REPORT_EVERY_TICKS = 30 * TICK_HZ;
/** The first report comes early, so the life clock knows the hub's lifespan within seconds. */
const FIRST_REPORT_TICKS = 5 * TICK_HZ;
/** Once its time is up the creature asks the hub for the verdict every 2 s until it answers. */
export const EXPIRY_RETRY_TICKS = 2 * TICK_HZ;

/** Local storage, or null where the browser blocks it. */
export function safeStorage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

/** Tallies one item's bites and give-backs under `<type>@<id>`, so a test can follow a single item. */
export const countItem = (counts: Record<string, number>, type: string, id: string): void => {
  const key = `${type}@${id}`;
  counts[key] = (counts[key] ?? 0) + 1;
};

/** One creature in one world: the title screen's drifting cell, or a real hatch. */
export interface Session {
  world: World;
  player: CreatureState;
  /** The genome this life hatched with. */
  body: Body;
  /** The title screen's cell: harmless, fed, and steered by a script. */
  demo: boolean;
  counts: Record<string, number>;
  peakBiomass: number;
  death: DeathSummary | null;
  /** The pond this life is in; null for the title cell and for a local pond. */
  pond: Pond | null;
  /** Ticks this life has been simulated, and the count at which its next report is due. */
  ticks: number;
  nextReport: number;
  /** The tick count of the last report sent because the lifespan ran out; -1 before any. */
  lastExpiryAsk: number;
}

export interface Steering {
  target: { id?: string; x: number; y: number };
  ticksLeft: number;
  done(reached: boolean): void;
}

/** The pond this tab has joined: one seed, one clock and one set of eaten food for every life. */
export interface Pond {
  id: string;
  seed: string;
  size: number;
  /** The hub's spawn ring: centre and this player's first spawn; null without a hub. */
  ring: { centre: Vec2; hint: Vec2 } | null;
  /** Lives started in this pond, to turn the spawn point on the ring. */
  lives: number;
  time: PondTime;
  food: PondFood;
  /** Stands in for the world when a food event arrives between lives; never stepped. */
  world: World;
}

/** A scripted remote (`?debug=1` only), fed through the real snapshot codec. */
export interface Scripted {
  spec: ScriptedRemote;
  sender: SnapshotSender;
  startedMs: number;
  /** The genome ref its snapshots carry. */
  ref: number;
}

export function newSession(
  seed: string,
  demo: boolean,
  body: Body,
  pond: Pond | null = null,
  spawn: Vec2 | null = null,
  biomass: number = RULES.starter.biomass,
): Session {
  const world = createWorld({
    seed: demo ? `${seed}/title` : seed,
    hazards: !demo,
    ...(pond ? { size: pond.size } : {}),
  });
  if (pond) {
    world.consumed = pond.world.consumed;
    pond.time.join(world, performance.now());
  }
  const { phys } = body.creature;
  const reach = colliderReach(phys, biomass);
  const spot = findClearSpot(world, spawn?.x ?? world.size / 2, spawn?.y ?? world.size / 2, reach);
  const player = spawnCreature(world, { id: 'player', ...spot, phys, biomass });
  return {
    world,
    player,
    body,
    demo,
    counts: {},
    peakBiomass: player.biomass,
    death: null,
    pond,
    ticks: 0,
    nextReport: FIRST_REPORT_TICKS,
    lastExpiryAsk: -1,
  };
}

/** `prefers-reduced-motion`: the Reduce motion setting follows it until the player picks (M6 T22). */
export const motionQuery = (): MediaQueryList | null => {
  try {
    return typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : null;
  } catch {
    return null;
  }
};

export const adultRadius = (c: CreatureState): number => Math.sqrt(c.phys.maxBiomass);
