// Genome exchange (M3 T16): each side sends its own genome once when a link opens and again after
// a rehatch. A receiver takes at most one genome per peer per 2 s and only from peers it has a link
// to (open or coming up); everything else is counted in `dropped`.

import type { PeerEvent } from './protocol';

export const GENOME_MIN_INTERVAL_MS = 2000;

export interface GenomeSyncOptions {
  /** Sends to one open link. */
  send(id: string, event: PeerEvent): void;
  /** Sends to every open link. */
  broadcast(event: PeerEvent): void;
  /**
   * Whether there is a link to this peer, open or still coming up: the other side may see its
   * channels open and send before this side's connection reports `connected`.
   */
  hasLink(id: string): boolean;
  /** Takes a peer's genome text; false means it was no genome, which does not use up the peer's allowance. */
  accept(id: string, data: string): boolean;
}

export class GenomeSync {
  /** Genome events ignored: too frequent, or from a peer with no open link. */
  dropped = 0;
  private own: PeerEvent | null = null;
  private readonly lastAt = new Map<string, number>();

  constructor(private readonly opts: GenomeSyncOptions) {}

  /** The genome of the current life; it goes to every open link now and to links that open later. */
  setOwn(data: string): void {
    this.own = { t: 'genome', data };
    this.opts.broadcast(this.own);
  }

  /** A link to `id` just opened. */
  peerOpen(id: string): void {
    this.lastAt.delete(id);
    if (this.own) this.opts.send(id, this.own);
  }

  forget(id: string): void {
    this.lastAt.delete(id);
  }

  /** Hands a peer's genome to `accept`, or counts it as dropped. `nowMs` is this tab's wall clock. */
  receive(id: string, event: PeerEvent, nowMs: number): void {
    if (event.t !== 'genome') return;
    const last = this.lastAt.get(id);
    // The rate check goes first: it is the cheap one, and a flood is what it is for.
    if ((last !== undefined && nowMs - last < GENOME_MIN_INTERVAL_MS) || !this.opts.hasLink(id)) {
      this.dropped += 1;
      return;
    }
    if (this.opts.accept(id, event.data)) this.lastAt.set(id, nowMs);
  }
}
