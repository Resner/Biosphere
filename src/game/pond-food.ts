// Glue between the sim's eat events and the pond's food claims (ADR 0016). The online session
// supplies `send` for the peers' `event` channels; this holds no network code of its own.

import { ClaimBook, ConsumedJoin, type Stolen } from '../net/claims';
import type { PeerEvent } from '../net/protocol';
import { parseFoodId } from '../sim/food';
import type { StepEvent, World } from '../sim/types';

export class PondFood {
  private readonly book: ClaimBook;
  readonly join = new ConsumedJoin();

  constructor(
    selfId: string,
    private readonly send: (event: PeerEvent) => void,
  ) {
    this.book = new ClaimBook(selfId);
  }

  /** Claims and consumed entries ignored for lying outside the window of this client's clock. */
  get ignored(): number {
    return this.book.ignored + this.join.ignored;
  }

  /** Announces the bites the player just took; `tick` is the tick the step ran at. */
  onEat(events: readonly StepEvent[], tick: number): void {
    for (const event of events) {
      if (event.type !== 'eat') continue;
      const item = parseFoodId(event.food);
      if (!item) continue;
      const claim = { ...item, tick };
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
