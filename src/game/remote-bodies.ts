// The bodies of other players (M3 T16): genomes arrive on the event channel, snapshots say which
// genome a creature has now (`genomeRef`), and a remote is drawn with its body only when the two
// agree. Until then, or when the genome never comes, it stays the tinted fallback cell.

import { parseGenomeText } from '../genome/codec';
import type { Creature } from '../genome/stats';
import type { RemoteView } from '../net/pond-sync';
import { type Body, hatchBody } from './body';

/** After a creature's ref changes its old body stays up this long, waiting for the new genome. */
export const GENOME_WAIT_MS = 5000;
/** Genomes kept per peer: the current one, the one it replaced and a spare. */
const KEPT_PER_PEER = 3;

/** A remote as the renderer and the test hook read it. */
export interface DrawnRemote extends RemoteView {
  /** The body to draw, or null for the fallback cell. */
  body: Creature | null;
  genomeHash: string | null;
  species: string | null;
}

interface Peer {
  /** By ref, oldest first. */
  known: Map<number, Body>;
  shown: Body | null;
  /** Wall-clock ms when `shown` stopped matching the snapshots, or null while it matches. */
  staleSince: number | null;
  drawn: DrawnRemote;
}

export class RemoteBodies {
  /** Genomes that were not valid text or could not be built. */
  dropped = 0;
  private readonly peers = new Map<string, Peer>();
  private readonly out: DrawnRemote[] = [];

  /** Builds and keeps a peer's genome. Returns false (and counts it) for text that is no genome. */
  add(id: string, text: string): boolean {
    const genome = parseGenomeText(text);
    let body: Body | null = null;
    if (genome) {
      try {
        body = hatchBody(genome);
      } catch {
        // A hostile genome that breaks the builder is dropped like malformed text.
      }
    }
    if (!body) {
      this.dropped += 1;
      return false;
    }
    const peer = this.peer(id);
    const { ref } = body;
    peer.known.delete(ref);
    peer.known.set(ref, body);
    if (peer.known.size > KEPT_PER_PEER) {
      peer.known.delete(peer.known.keys().next().value as number);
    }
    return true;
  }

  remove(id: string): void {
    this.peers.delete(id);
  }

  /** Fills in the body of each view. The array and its objects are reused between calls. */
  resolve(views: readonly RemoteView[], nowMs: number): readonly DrawnRemote[] {
    this.out.length = 0;
    for (const view of views) {
      const peer = this.peer(view.id);
      const match = peer.known.get(view.genomeRef) ?? null;
      if (match) {
        peer.shown = match;
        peer.staleSince = null;
      } else if (peer.shown) {
        peer.staleSince ??= nowMs;
        if (nowMs - peer.staleSince > GENOME_WAIT_MS) peer.shown = null;
      }
      const { drawn } = peer;
      Object.assign(drawn, view);
      drawn.body = peer.shown?.creature ?? null;
      drawn.genomeHash = peer.shown?.hash ?? null;
      drawn.species = peer.shown?.species ?? null;
      this.out.push(drawn);
    }
    return this.out;
  }

  private peer(id: string): Peer {
    let peer = this.peers.get(id);
    if (!peer) {
      peer = {
        known: new Map(),
        shown: null,
        staleSince: null,
        drawn: { body: null, genomeHash: null, species: null } as unknown as DrawnRemote,
      };
      this.peers.set(id, peer);
    }
    return peer;
  }
}
