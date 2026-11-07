// Asking the authority where a life enters the water (M12 T4, ADR 0064): one `spawn` per life in the
// hub's world, answered with the place, why and whether the creature is protected. A refusal (a
// creature locked in a fight) or no answer within the wait settles with null, and the caller begins
// the life in a local world, as an unreachable hub's.

import { aoiRadius } from '../net/aoi';
import {
  type ClientMsg,
  type HubMsg,
  type SpawnWhy,
  type Vec2,
  WIRE_AOI_MAX,
  wireRadius,
} from '../net/protocol';

/** A life waits this long for the hub's answer before it begins in a local world. */
export const SPAWN_WAIT_MS = 4000;

/** The hub's answer, as `state().spawn` shows the last one. */
export interface SpawnAnswer {
  x: number;
  y: number;
  why: SpawnWhy;
  protect: boolean;
}

/** What the hub is told of a creature it has no record of (an unrecorded cell): its radius and AoI, within the wire's ranges. */
export function spawnAskOf(biomass: number, maxBiomass: number): ClientMsg & { t: 'spawn' } {
  const r = Math.sqrt(Math.max(1, biomass));
  const adult = Math.max(r, Math.sqrt(maxBiomass));
  return {
    t: 'spawn',
    r: wireRadius(r),
    aoi: Math.min(WIRE_AOI_MAX, Math.max(1, aoiRadius(r, adult))),
  };
}

export class SpawnAsk {
  /** The last answer (`state().spawn`), null before one. */
  last: SpawnAnswer | null = null;
  private settle: ((answer: SpawnAnswer | null) => void) | null = null;

  constructor(
    private readonly timers: {
      set(run: () => void, ms: number): unknown;
      clear(handle: unknown): void;
    } = { set: (run, ms) => setTimeout(run, ms), clear: (h) => clearTimeout(h as number) },
  ) {}

  /**
   * Sends `msg` (false when there is no link to send it on) and resolves with the answer, or null
   * on a refusal, with no link, or after `waitMs`. A new ask settles the one before with null.
   */
  ask(
    send: (msg: ClientMsg) => boolean,
    msg: ClientMsg & { t: 'spawn' },
    waitMs = SPAWN_WAIT_MS,
  ): Promise<SpawnAnswer | null> {
    this.settle?.(null);
    return new Promise((resolve) => {
      const timer = this.timers.set(() => done(null), waitMs);
      const done = (answer: SpawnAnswer | null): void => {
        if (this.settle !== done) return;
        this.settle = null;
        this.timers.clear(timer);
        if (answer) this.last = answer;
        resolve(answer);
      };
      this.settle = done;
      if (!send(msg)) done(null);
    });
  }

  /** The hub's word: a `spawn` answers the ask, and a `spawn` refusal ends it. */
  receive(msg: HubMsg): void {
    if (msg.t === 'spawn') {
      const answer = { x: msg.x, y: msg.y, why: msg.why, protect: msg.protect };
      if (this.settle) this.settle(answer);
      // A ride's arrival (M12 T7) comes unasked: it is still the last answer.
      else this.last = answer;
    } else if (msg.t === 'refused' && msg.reason === 'spawn') {
      this.settle?.(null);
    }
  }

  /** A new world or a new title: the last answer belongs to the life before. */
  reset(): void {
    this.settle?.(null);
    this.last = null;
  }
}

/** Where a life in the hub's world begins: in it at `place`, or (`inPond` false) in a local world. */
export interface LifePlace {
  inPond: boolean;
  place?: { at: Vec2; protect: boolean };
}

/**
 * How a life in the hub's world starts (M12 T4): a promoted child where its parent was, asking
 * nothing; anything else where the hub's answer puts it, protected as the hub says; with no answer,
 * in a local world.
 */
export async function placeLife(
  asker: SpawnAsk,
  send: (msg: ClientMsg) => boolean,
  msg: ClientMsg & { t: 'spawn' },
  parent?: { at: Vec2; protect: boolean },
  waitMs = SPAWN_WAIT_MS,
): Promise<LifePlace> {
  if (parent) return { inPond: true, place: parent };
  const answer = await asker.ask(send, msg, waitMs);
  if (!answer) return { inPond: false };
  return { inPond: true, place: { at: { x: answer.x, y: answer.y }, protect: answer.protect } };
}
