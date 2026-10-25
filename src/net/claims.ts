// Shared food (ADR 0016): the claim with the lower tick wins a contested item, then the lower
// playerId, and every client ends up with the same `World.consumed`. Pure and DOM-free.

import { applyRemoteClaim, claimPlausible, consumedPlausible, isFoodSlot } from '../sim/food';
import type { World } from '../sim/types';
import { CONSUMED_MAX_ENTRIES, type PeerEvent } from './protocol';

export type ClaimEvent = Extract<PeerEvent, { t: 'claim' }>;
export type ConsumedEvent = Extract<PeerEvent, { t: 'consumed' }>;

/** The bite a client had to give back because another player's claim won. */
export interface Stolen {
  slot: string;
  k: number;
  /** The energy the bite gave; the caller takes it back. */
  value: number;
}

interface Winner {
  k: number;
  tick: number;
  by: string;
  value: number;
}

const beats = (tick: number, id: string, w: Winner): boolean =>
  tick < w.tick || (tick === w.tick && id < w.by);

/** Who holds each slot's latest eaten cycle, as far as this client knows. */
export class ClaimBook {
  private readonly winners = new Map<string, Winner>();
  /** Claims dropped for a cycle or tick outside the window of this client's clock. */
  ignored = 0;

  constructor(private readonly self: string) {}

  /** Records this client's own bite (after `consumeFood`); `value` is the energy it gave. */
  local(claim: { slot: string; k: number; tick: number }, value: number): void {
    this.winners.set(claim.slot, { k: claim.k, tick: claim.tick, by: this.self, value });
  }

  /** Applies a peer's claim to `world`. Returns the bite to reverse when it beats this client's. */
  remote(world: World, claim: ClaimEvent, from: string): Stolen | null {
    if (!claimPlausible(world, claim.k, claim.tick)) {
      this.ignored += 1;
      return null;
    }
    const held = this.winners.get(claim.slot);
    if (held !== undefined && claim.k < held.k) return null;
    const contested = held !== undefined && held.k === claim.k;
    // A cycle the world already counts as eaten without a known winner came from a consumed set.
    const settled = held === undefined && claim.k + 1 === (world.consumed[claim.slot]?.k ?? 0);
    if (settled || (contested && !beats(claim.tick, from, held))) return null;
    if (!applyRemoteClaim(world, claim)) return null;
    this.winners.set(claim.slot, { k: claim.k, tick: claim.tick, by: from, value: 0 });
    return contested && held.by === this.self
      ? { slot: claim.slot, k: claim.k, value: held.value }
      : null;
  }
}

/** The eaten slots as `consumed` messages of at most 40 entries, in a stable order. */
export function consumedParts(world: World): ConsumedEvent[] {
  const slots = Object.keys(world.consumed).sort();
  const of = Math.max(1, Math.ceil(slots.length / CONSUMED_MAX_ENTRIES));
  const parts: ConsumedEvent[] = [];
  for (let part = 0; part < of; part++) {
    const entries = slots
      .slice(part * CONSUMED_MAX_ENTRIES, (part + 1) * CONSUMED_MAX_ENTRIES)
      .map((slot) => {
        const e = world.consumed[slot] as { k: number; until: number };
        return [slot, e.k, e.until] as [string, number, number];
      });
    parts.push({ t: 'consumed', part, of, entries });
  }
  return parts;
}

/**
 * Merges the consumed sets peers send a late joiner. Every part is merged on arrival (a later
 * cycle wins, then the earlier respawn), so duplicates and any order are harmless; `complete`
 * turns true once one peer has delivered all its parts. Until then, the next peer's set fills
 * the gaps.
 */
export class ConsumedJoin {
  private readonly senders = new Map<string, { of: number; seen: Set<number> }>();
  private done = false;
  /** Entries dropped for a cycle or respawn tick outside the window of this client's clock. */
  ignored = 0;

  get complete(): boolean {
    return this.done;
  }

  receive(world: World, from: string, event: ConsumedEvent): void {
    let sender = this.senders.get(from);
    if (sender === undefined) {
      sender = { of: event.of, seen: new Set() };
      this.senders.set(from, sender);
    }
    if (sender.of !== event.of) return;
    let whole = true;
    for (const [slot, k, until] of event.entries) {
      if (!isFoodSlot(world, slot)) continue;
      if (!consumedPlausible(world, k, until)) {
        this.ignored += 1;
        whole = false;
        continue;
      }
      const have = world.consumed[slot];
      if (have === undefined || k > have.k || (k === have.k && until < have.until)) {
        world.consumed[slot] = { k, until };
      }
    }
    // A part with dropped entries does not count, so the next peer's set can fill the gaps.
    if (whole) sender.seen.add(event.part);
    if (sender.seen.size === sender.of) this.done = true;
  }
}
