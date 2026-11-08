// Proxy snapshots (ADR 0053, M8 T11): a fighter whose player left stays visible. In each running
// fight every connected fighter relays every away fighter's pose, from its last confirmed encounter
// state, to its own linked peers outside the fight as 61-byte proxy frames at 5 Hz (M11 T16: the
// links are each page's own, so a spectator may hold only one of the fighters), and one last frame
// at the end carries the result's alive flag. Every fighter's client draws its away opponents from
// the same snapshots. A receiver takes a proxy only from a peer that is fighting, only for a player
// that has gone quiet itself, and from one sender per away player: the first heard, while it keeps
// sending. A proxy is unsigned: it moves a faded body and nothing else, never an engage, a claim or
// a result.

import { encodeProxyFrame } from '../ledger/snapshot-sig';
import { REMOVE_AFTER_MS, SEQ_RANGE, type SnapshotFields } from './pond-sync';
import { encodeSnapshot, type Snapshot } from './protocol';

/** Proxies go out at 5 Hz: 61 bytes each, 305 B/s per away fighter per peer. */
export const PROXY_INTERVAL_MS = 200;
/**
 * A proxy for a player is taken only once its own snapshots have stopped for this long, and from
 * another sender only once the one it was taken from has stopped for this long.
 */
export const PROXY_QUIET_MS = 1000;
/** A fight has at most 4 fighters, so one peer relays at most 3 away fighters. */
export const MAX_PROXIED_PER_PEER = 3;

/** The own running fight as the relay reads it. */
export interface RelayFight {
  id: string;
  /** The fighters' player ids, by slot. */
  players: readonly string[];
  /** Slot `slot`'s creature as peers would see it, from the last confirmed state; null if unknown. */
  snapshot(slot: number): SnapshotFields | null;
}

export interface RelayHost {
  /** This player's id. */
  self: string;
  /** Whether a player's page is here now: this player, or a linked peer (M11 T14). */
  present(player: string): boolean;
  /** The linked peers (their hello passed). */
  peers(): readonly string[];
  /** Whether `peer` shares water with `player` (M12 T6); every peer does without it. */
  sees?(peer: string, player: string): boolean;
  /** A proxy frame on the state channel to one peer. */
  send(peer: string, frame: Uint8Array): void;
  /** An away opponent's pose for this client's own view of its fight. */
  show(player: string, snapshot: Snapshot): void;
}

/** The fighter's side: the away opponents drawn here, and relayed to this client's own links. */
export class ProxyRelay {
  private due = 0;
  private fightId = '';
  private ended = '';
  private readonly seqs = new Map<string, number>();

  constructor(private readonly host: RelayHost) {}

  /** Call each frame while the own fight runs; at most one round every `PROXY_INTERVAL_MS`. */
  update(ms: number, fight: RelayFight): void {
    if (fight.id === this.ended) return;
    if (fight.id !== this.fightId) {
      this.fightId = fight.id;
      this.due = ms;
    }
    if (ms < this.due) return;
    // After a pause (a hidden tab), restart the schedule instead of sending the backlog.
    const late = ms - this.due > PROXY_INTERVAL_MS;
    this.due = (late ? ms : this.due) + PROXY_INTERVAL_MS;
    this.round(fight, null);
  }

  /** The fight's end: a last round whose alive flags are the result's, then nothing more for it. */
  end(fight: RelayFight, alive: (slot: number) => boolean): void {
    if (fight.id === this.ended) return;
    this.ended = fight.id;
    this.round(fight, alive);
    this.seqs.clear();
  }

  private round(fight: RelayFight, alive: ((slot: number) => boolean) | null): void {
    const { host } = this;
    const { players } = fight;
    const away: number[] = [];
    players.forEach((p, slot) => {
      if (p !== host.self && !host.present(p)) away.push(slot);
    });
    if (away.length === 0) return;
    const targets = host.peers().filter((p) => !players.includes(p));
    for (const slot of away) {
      const fields = fight.snapshot(slot);
      const player = players[slot] as string;
      if (!fields) continue;
      const seq = this.seqs.get(player) ?? 0;
      this.seqs.set(player, (seq + 1) % SEQ_RANGE);
      const snapshot: Snapshot = { ...fields, seq, alive: alive ? alive(slot) : fields.alive };
      host.show(player, snapshot);
      if (targets.length === 0) continue;
      let frame: Uint8Array;
      try {
        frame = encodeProxyFrame(player, encodeSnapshot(snapshot));
      } catch {
        continue;
      }
      for (const peer of targets) if (host.sees?.(peer, player) ?? true) host.send(peer, frame);
    }
  }
}

/** Where accepted proxies go, and what the receiver checks them against (`RemoteSet`). */
export interface ProxyTarget {
  /** Whether `id`'s newest own snapshot said it is fighting. */
  fighting(id: string): boolean;
  /** Ms since `id`'s own snapshots last brought news; Infinity when none ever did. */
  quietMs(id: string, localMs: number): number;
  proxy(id: string, snapshot: Snapshot, localMs: number): void;
}

/** The spectator's side: proxies checked, then drawn; the rest dropped and counted. */
export class ProxyReceiver {
  /** Proxies dropped: from a peer not fighting, for a player still sending, from a second sender, or too many. */
  dropped = 0;
  /** Per relaying peer, the players it stands in for and when it last did. */
  private readonly held = new Map<string, Map<string, number>>();
  /** Per away player, the one peer its proxies are taken from and when it last sent one. */
  private readonly sources = new Map<string, { from: string; at: number }>();

  constructor(
    private readonly self: () => string | null,
    private readonly target: ProxyTarget,
  ) {}

  /** A proxy of `player` from peer `from`. True when it was taken. */
  receive(from: string, player: string, snapshot: Snapshot, localMs: number): boolean {
    const { target } = this;
    const taken =
      player !== from &&
      player !== this.self() &&
      target.fighting(from) &&
      target.quietMs(player, localMs) >= PROXY_QUIET_MS &&
      this.sender(from, player, localMs) &&
      this.room(from, player, localMs);
    if (!taken) {
      this.dropped++;
      return false;
    }
    this.sources.set(player, { from, at: localMs });
    target.proxy(player, snapshot, localMs);
    return true;
  }

  /** Each away player's sender, by player (`state().net.proxyFrom`). */
  senders(): Record<string, string> {
    return Object.fromEntries([...this.sources].map(([player, s]) => [player, s.from]));
  }

  /** A peer that left stands in for nobody any more: the next sender of its players is taken at once. */
  forget(from: string): void {
    this.held.delete(from);
    for (const [player, s] of this.sources) if (s.from === from) this.sources.delete(player);
  }

  /** One sender per away player: `from` is it, or the one before has sent nothing for 1 s. */
  private sender(from: string, player: string, localMs: number): boolean {
    const s = this.sources.get(player);
    return !s || s.from === from || localMs - s.at >= PROXY_QUIET_MS;
  }

  /** A peer stands in for at most `MAX_PROXIED_PER_PEER` players at once. */
  private room(from: string, player: string, localMs: number): boolean {
    let held = this.held.get(from);
    if (!held) {
      held = new Map();
      this.held.set(from, held);
    }
    for (const [p, at] of held) if (localMs - at > REMOVE_AFTER_MS) held.delete(p);
    if (!held.has(player) && held.size >= MAX_PROXIED_PER_PEER) return false;
    held.set(player, localMs);
    return true;
  }
}
