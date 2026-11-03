// Proxy snapshots (ADR 0053, M8 T11): a fighter whose player left the pond stays visible. In each
// running fight the connected fighter with the lowest slot relays every away fighter's pose, from
// its last confirmed encounter state, to the pond peers outside the fight as 57-byte proxy frames
// at 5 Hz, and one last frame at the end carries the result's alive flag. Every fighter's client
// draws its away opponents from the same snapshots. A receiver takes a proxy only from a peer that
// is fighting, and only for a player that has gone quiet itself. A proxy is unsigned: it moves a
// faded body and nothing else, never an engage, a claim or a result.

import { encodeProxyFrame } from '../ledger/snapshot-sig';
import { REMOVE_AFTER_MS, type SnapshotFields } from './pond-sync';
import { encodeSnapshot, type Snapshot } from './protocol';

/** Proxies go out at 5 Hz: 57 bytes each, 285 B/s per away fighter per peer. */
export const PROXY_INTERVAL_MS = 200;
/** A proxy for a player is taken only once its own snapshots have stopped for this long. */
export const PROXY_QUIET_MS = 1000;
/** A fight has at most 4 fighters, so one peer relays at most 3 away fighters. */
export const MAX_PROXIED_PER_PEER = 3;

const SEQ_RANGE = 0x10000;

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
  /** Whether a player is in the pond now: this player, or a member of the roster. */
  present(player: string): boolean;
  /** The pond peers with an open link. */
  peers(): readonly string[];
  /** A proxy frame on the state channel to one peer. */
  send(peer: string, frame: Uint8Array): void;
  /** An away opponent's pose for this client's own view of its fight. */
  show(player: string, snapshot: Snapshot): void;
}

/** The fighter's side: the away opponents drawn here, and relayed when this client has the lowest slot. */
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
  }

  private round(fight: RelayFight, alive: ((slot: number) => boolean) | null): void {
    const { host } = this;
    const { players } = fight;
    const connected = (p: string) => p === host.self || host.present(p);
    const away: number[] = [];
    let relay = '';
    players.forEach((p, slot) => {
      if (!connected(p)) away.push(slot);
      else if (relay === '') relay = p;
    });
    if (away.length === 0) return;
    const targets = relay === host.self ? host.peers().filter((p) => !players.includes(p)) : [];
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
      for (const peer of targets) host.send(peer, frame);
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
  /** Proxies dropped: from a peer not fighting, for a player still sending, or too many. */
  dropped = 0;
  /** Per relaying peer, the players it stands in for and when it last did. */
  private readonly held = new Map<string, Map<string, number>>();

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
      this.room(from, player, localMs);
    if (!taken) {
      this.dropped++;
      return false;
    }
    target.proxy(player, snapshot, localMs);
    return true;
  }

  /** A peer that left stands in for nobody any more. */
  forget(from: string): void {
    this.held.delete(from);
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
