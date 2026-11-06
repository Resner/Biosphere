// Each peer's last few signed snapshots (M7 T7, ADR 0050; M10 T11, ADR 0059). Engage candidates
// send one every 200 ms; the engager forwards the newest to the authority as the target's state,
// and a target's lock answer carries the attacker's from the last 2 s (`seen`), for the movement
// check. A frame is verified on receipt, at most `VERIFY_PER_SECOND` a second per peer, so a flood
// costs a bounded amount of work.

import { SEEN_MAX, type SignedSnap, type Snapshot } from './protocol';

/** Signature checks per peer per second; frames past it are dropped unverified. */
export const VERIFY_PER_SECOND = 10;
const WINDOW_MS = 1000;
/** Verified frames kept per peer: a lock answer's `seen` holds at most this many (`SEEN_MAX`). */
export const HELD = SEEN_MAX;
/** A lock answer's `seen` holds the attacker's frames received this recently. */
export const SEEN_MS = 2000;

interface Frame {
  signed: SignedSnap;
  /** The receiver's clock when it came. */
  at: number;
}

interface Held {
  /** Oldest first, the newest last; at most `HELD`. */
  frames: Frame[];
  tick: number;
  windowStart: number;
  checks: number;
}

export class SignedSnaps {
  /** Frames whose signature did not verify for the peer that sent them. */
  badSignatures = 0;
  /** Frames dropped unverified for the per-peer rate. */
  limited = 0;
  private readonly peers = new Map<string, Held>();

  /** `verify` gives the snapshot the peer signed for this pond, or null (`verifySnap`). */
  constructor(private readonly verify: (id: string, signed: SignedSnap) => Snapshot | null) {}

  /**
   * A signed frame from `id`, with the snapshot its bytes decode to (`decodeStateFrame`); `nowMs`
   * is the receiver's clock. True when it is now the newest held. Never throws.
   */
  receive(id: string, snapshot: Snapshot, signed: SignedSnap, nowMs: number): boolean {
    let held = this.peers.get(id);
    if (!held) {
      held = { frames: [], tick: -1, windowStart: nowMs, checks: 0 };
      this.peers.set(id, held);
    }
    const any = held.frames.length > 0;
    if (any && snapshot.tick <= held.tick) return false;
    if (!(nowMs - held.windowStart < WINDOW_MS)) {
      held.windowStart = nowMs;
      held.checks = 0;
    }
    if (held.checks >= VERIFY_PER_SECOND) {
      this.limited++;
      return false;
    }
    held.checks++;
    let verified: Snapshot | null = null;
    try {
      verified = this.verify(id, signed);
    } catch {
      verified = null;
    }
    // The signed bytes are what counts: a frame no newer than the held one is ignored after all.
    if (!verified) {
      this.badSignatures++;
      return false;
    }
    if (any && verified.tick <= held.tick) return false;
    held.frames.push({ signed, at: nowMs });
    if (held.frames.length > HELD) held.frames.shift();
    held.tick = verified.tick;
    return true;
  }

  /** The newest verified frame of `id`, as it came, to forward; null before any. */
  latest(id: string): SignedSnap | null {
    return this.peers.get(id)?.frames.at(-1)?.signed ?? null;
  }

  /** The frames of `id` received in the `SEEN_MS` before `nowMs`, oldest first: a lock answer's `seen`. */
  recent(id: string, nowMs: number): SignedSnap[] {
    const frames = this.peers.get(id)?.frames ?? [];
    return frames.filter((f) => nowMs - f.at <= SEEN_MS).map((f) => f.signed);
  }

  /** The tick of the newest verified frame of `id`, or null. */
  tickOf(id: string): number | null {
    const held = this.peers.get(id);
    return held && held.frames.length > 0 ? held.tick : null;
  }

  /** Peers with a verified frame held. */
  get size(): number {
    let n = 0;
    for (const held of this.peers.values()) if (held.frames.length > 0) n++;
    return n;
  }

  remove(id: string): void {
    this.peers.delete(id);
  }

  /** Forgets every peer: a pond change makes their frames worthless. */
  clear(): void {
    this.peers.clear();
  }
}
