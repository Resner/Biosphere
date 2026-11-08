// Crowd instances in the page (M12 T6, ADR 0064): the page's own instance as the hub last said it,
// each known creature's as its freshest word gave it (the directory's `near`, a link's `hello` and
// `instance` events; gossip carries its own), whether the page is crowded, and which linked peers
// it no longer draws. Pure: `online.ts` feeds it and acts on what it returns; the fade itself lives
// in `RemoteSet` and the toast in the HUD.

import { CROWD_AT, OPEN_WATER, sameWater } from '../net/instance';

/** The toast when the page's own instance leaves the open water. */
export const BUSY_TEXT = 'Busy waters: you see part of the crowd here';
/** The busy toast shows at most once in this long. */
export const BUSY_EVERY_MS = 60_000;
/** A link that drops this soon after the page's own instance changed closed for the water. */
export const WATER_CHANGE_MS = 3000;
/** `debug.crowdAt` takes 2 to `CROWD_AT`. */
export const CROWD_AT_MIN = 2;

/** Checks a `crowdAt` (`debug.crowdAt`): a whole number from 2 to `CROWD_AT`. */
export function checkCrowdAt(n: number): number {
  if (!Number.isInteger(n) || n < CROWD_AT_MIN || n > CROWD_AT) {
    throw new RangeError(`crowdAt takes ${CROWD_AT_MIN} to ${CROWD_AT}, got ${n}`);
  }
  return n;
}

/** An instance as one source gave it (page ms). */
export interface WaterSighting {
  n: number;
  at: number;
}

/** What `state().net.instance` shows. */
export interface InstanceInfo {
  /** The page's own instance (0: the open water). */
  n: number;
  /** How often it changed. */
  changes: number;
  /** Whether the page's wanted P0 + P1 that share its water reach `CROWD_AT`. */
  crowded: boolean;
  /** The `where` reports that carried a crowd list. */
  crowdSent: number;
}

export class CrowdView {
  own = OPEN_WATER;
  changes = 0;
  crowded = false;
  crowdSent = 0;
  private threshold = CROWD_AT;
  private changedAt = Number.NEGATIVE_INFINITY;
  private busyAt = Number.NEGATIVE_INFINITY;
  private readonly water = new Map<string, WaterSighting>();
  /** Linked peers this page doesn't draw now. */
  private readonly apart = new Set<string>();

  /** How many P0 + P1 that share water make the page crowded. */
  get crowdAt(): number {
    return this.threshold;
  }

  /** Sets `crowdAt` (`debug.crowdAt`, `checkCrowdAt`). */
  setCrowdAt(n: number): void {
    this.threshold = checkCrowdAt(n);
  }

  /**
   * The hub named this page's instance. `changed` when it differs from the last; `busy` when it
   * left the open water and the busy toast hasn't shown in the last minute.
   */
  setOwn(n: number, now: number): { changed: boolean; busy: boolean } {
    if (n === this.own) return { changed: false, busy: false };
    const busy = this.own === OPEN_WATER && now - this.busyAt >= BUSY_EVERY_MS;
    if (busy) this.busyAt = now;
    this.own = n;
    this.changes++;
    this.changedAt = now;
    return { changed: true, busy };
  }

  /** Whether the page's own instance changed in the last `WATER_CHANGE_MS`. */
  changedLately(now: number): boolean {
    return now - this.changedAt < WATER_CHANGE_MS;
  }

  /** A creature's instance as a source gave it at `at`; a later word replaces an earlier one. */
  see(id: string, n: number, at: number): void {
    const seen = this.water.get(id);
    if (!seen || at >= seen.at) this.water.set(id, { n, at });
  }

  /** The freshest word of a creature's instance, if any. */
  sighting(id: string): WaterSighting | undefined {
    return this.water.get(id);
  }

  /** A creature's instance by the freshest word; the open water with none. */
  of(id: string): number {
    return this.water.get(id)?.n ?? OPEN_WATER;
  }

  /** Whether a creature shares water with this page. */
  shares(id: string): boolean {
    return sameWater(this.own, this.of(id));
  }

  /** Whether two creatures share water with each other, by the freshest word of each. */
  between(a: string, b: string): boolean {
    return sameWater(this.of(a), this.of(b));
  }

  /**
   * Which of the linked `ids` start or stop being drawn: `[id, false]` for one that stopped (its
   * fade starts), `[id, true]` for one drawn again. Each change is told once.
   */
  sort(ids: Iterable<string>, drawn: (id: string) => boolean): [id: string, shown: boolean][] {
    const out: [string, boolean][] = [];
    for (const id of ids) {
      const shown = drawn(id);
      if (!shown && !this.apart.has(id)) {
        this.apart.add(id);
        out.push([id, false]);
      } else if (shown && this.apart.delete(id)) {
        out.push([id, true]);
      }
    }
    return out;
  }

  /** A link closed; true when the page had already stopped drawing it. */
  left(id: string): boolean {
    return this.apart.delete(id);
  }

  info(): InstanceInfo {
    return { n: this.own, changes: this.changes, crowded: this.crowded, crowdSent: this.crowdSent };
  }
}
