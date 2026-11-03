// Back into a running fight after a reload or a second tab (M8 T10, ADR 0053). The hub's `life`
// names the fight the creature is locked in, and its `enc-start` and history follow at once. On the
// title screen they wait here; "Back to the fight" plays them in order, straight into the fight.
// DOM-free: the app shows the button and feeds what it takes to the fight.

import type { FightMsg } from '../net/hub-client';

/** The messages held for a fight: its start, frames, joins and end. */
export type HeldMsg = Extract<FightMsg, { t: 'enc-start' | 'enc-frame' | 'enc-join' | 'enc-end' }>;

const isHeld = (msg: FightMsg): msg is HeldMsg =>
  msg.t === 'enc-start' || msg.t === 'enc-frame' || msg.t === 'enc-join' || msg.t === 'enc-end';

export class FightResume {
  /** The running fight the hub's last `life` named, while this page does not play it; else null. */
  offered: string | null = null;
  private held: HeldMsg[] = [];

  /**
   * `takes(fight)`: this page takes the fight's messages as they come, because it plays the fight
   * already (a network-only reconnect, whose resync goes to the running fight and leaves the
   * fighter's state to it) or a life is playing that would begin it.
   */
  constructor(private readonly takes: (fight: string) => boolean) {}

  /**
   * A `life` from the hub: its `fight` is offered unless this page takes it as it comes. Each
   * sign-in resends the whole history, so what was held before is dropped.
   */
  life(fight: string | undefined): void {
    this.held = [];
    this.offered = fight !== undefined && !this.takes(fight) ? fight : null;
  }

  /** Keeps a message of the offered fight until the player resumes; false for anything else. */
  hold(msg: FightMsg): boolean {
    if (this.offered === null || !isHeld(msg) || msg.enc !== this.offered) return false;
    this.held.push(msg);
    return true;
  }

  /** The player resumes: the held messages in the order they came, and nothing is offered after. */
  take(): HeldMsg[] {
    const out = this.held;
    this.held = [];
    this.offered = null;
    return out;
  }
}
