// Glue between the sim's eat events and the pond's food claims (ADR 0016). The online session
// supplies `send` for the peers' `event` channels; this holds no network code of its own.

import { ClaimBook, ConsumedJoin, type Stolen } from '../net/claims';
import type { PeerEvent } from '../net/protocol';
import type { StepEvent, World } from '../sim/types';

const FOOD_ID = /^(c\d+_\d+_s\d+)_k(\d+)$/;

export class PondFood {
  private readonly book: ClaimBook;
  readonly join = new ConsumedJoin();

  constructor(
    selfId: string,
    private readonly send: (event: PeerEvent) => void,
  ) {
    this.book = new ClaimBook(selfId);
  }

  /** Announces the bites the player just took; `tick` is the tick the step ran at. */
  onEat(events: readonly StepEvent[], tick: number): void {
    for (const event of events) {
      const m = event.type === 'eat' ? FOOD_ID.exec(event.food) : null;
      if (event.type !== 'eat' || !m) continue;
      const claim = { slot: m[1] as string, k: Number(m[2]), tick };
      this.book.local(claim, event.value);
      this.send({ t: 'claim', ...claim });
    }
  }

  /** Applies a peer's food event to `world`; returns a bite the player has to give back. */
  receive(world: World, from: string, event: PeerEvent): Stolen | null {
    if (event.t === 'claim') return this.book.remote(world, event, from);
    if (event.t === 'consumed') this.join.receive(world, from, event);
    return null;
  }
}
