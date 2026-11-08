import { toBase64Url } from '../src/ledger/identity';
import { type ClientMsg, type HubMsg, isCause, type SignedCommit } from '../src/net/protocol';
import type { DeathCause } from '../src/sim/types';
import type { Beacons, SignedCommitment } from './beacons';
import type { Crowds } from './crowds';
import type { Directory } from './directory';
import type { Duties } from './duty';
import type { FightStore } from './fight-store';
import type { Clock, Fights } from './fights';
import type { Ledger } from './ledger';
import type { LifeState } from './life';
import type { Court } from './mating';
import type { Anchor, RecentSpawn, Spawned } from './spawn';
import type { TurnCredentials } from './turn';
import type { UsageMeter } from './usage';
import type { WhereAt } from './where';

/**
 * What the message handlers (`sessions.ts`, `lives.ts`, `offspring.ts`) reach of the one
 * `Authority` object, which keeps this state and passes itself in.
 */
export interface Hub {
  readonly ctx: DurableObjectState;
  readonly env: Env;
  readonly turn: TurnCredentials;
  readonly ledger: Ledger;
  readonly beacons: Beacons;
  readonly usage: UsageMeter;
  readonly asking: Map<string, Promise<void>>;
  promoting: Promise<void>;
  matingQueue: Promise<void>;
  nextTicket: number;
  /** The time and timers of lock-in and fights (hub tests swap in a hand-moved clock). */
  readonly clock: Clock;
  /** Who is locked in a fight, in memory (ADR 0050). */
  readonly fights: Fights;
  /** Each fight's log in SQLite as it runs (ADR 0053). */
  readonly fightStore: FightStore;
  /** Witness duties in memory: offers, who holds one, strikes (ADR 0058, `duty.ts`). */
  readonly duties: Duties;
  /** Who is where (M11 T6, `where.ts`), in memory and rebuilt from the attachments on a wake; hub tests swap in a larger world's. */
  directory: Directory;
  /** Crowd instances beside the directory (M12 T5, `where.ts`), in memory and rebuilt from the attachments on a wake. */
  crowds: Crowds;
  /** The crowds' one split timer on `hub.clock`, for `crowds.due()` (`armCrowds`). */
  crowdTimer: { at: number; handle: unknown } | null;
  /** Fighters whose page left the water during their fight: their instance is kept until it ends. */
  readonly crowdsKept: Set<string>;
  /** Signals the hub relayed, by unordered pair (`GET /v1/e2e/directory`). */
  readonly relays: Map<string, number>;
  /** The spawns given in the last minute (at most 256), in memory: a wake starts with none (M12 T4). */
  readonly spawns: RecentSpawn[];
  /** Messages dropped without closing the socket, by type (a `where` jump among them). */
  readonly dropped: Map<ClientMsg['t'], number>;
  /** The one way to set or clear the object's alarm (`.claude/rules/worker.md`). */
  rearm(): Promise<void>;
}

/** Per-socket state, kept in the hibernation attachment (survives eviction, never touches SQLite). */
export type Session = (
  | { phase: 'challenged'; nonce: string }
  | {
      phase: 'active';
      playerId: string;
      name: string;
      /** The creature this connection is playing and what it has reported (absent without one). */
      life?: LifeState | undefined;
      /** The mating this player has offered, until the partner answers (lazy expiry, no timer). */
      court?: Court | undefined;
      /** Spawn protection lasts until this time (ADR 0050); set by a promotion or a protected spawn, ended by an engage. */
      protectedUntil?: number | undefined;
      /** The binding a genesis or restore made: its spawn answer is protected (M12 T4, ADR 0064). */
      protectBind?: string | undefined;
      /** The spawn answer under its binding, so a repeat gets the same place (M12 T4). */
      spawned?: Spawned | undefined;
      /** Where the binding must begin: its first report lies near it (M12 T4, `worker/spawn.ts`). */
      anchor?: Anchor | undefined;
      /** The last report before the creature left the water (`gone`): a promoted child's anchor. */
      left?: WhereAt | undefined;
      /** Whether the client says it can witness (`avail`, ADR 0058); off until it says on. */
      avail?: boolean | undefined;
      /** When the last `avail` that counted arrived: at most one counts every 5 s. */
      availAt?: number | undefined;
      /** When each witness duty this session accepted in the last hour began (at most `DUTIES_PER_HOUR`). */
      duties?: number[] | undefined;
      /** The last `where` the directory took (M11 T6), so a wake rebuilds it and the next is checked against it. */
      where?: WhereAt | undefined;
      /** When the session's last seat ticket was signed, on the hub's clock (M11 T7, `worker/seat.ts`). */
      seatAt?: number | undefined;
      /** Its crowd and instance (M12 T5), absent in the open water, so a wake rebuilds the crowds. */
      crowd?: { id: number; n: number } | undefined;
    }
  | {
      /** Signed in, but admission is full: waits for a place and is not in the world yet. */
      phase: 'queued';
      playerId: string;
      name: string;
      /** Arrival order; the lowest ticket is next. */
      ticket: number;
      /** The place last announced (1 = next), so only a change is sent again. */
      place: number;
    }
  | { phase: 'retired' }
) & {
  openedAt: number;
  windowStart: number;
  count: number;
  signals: number;
  /** A fighter's inputs in the current window (absent before its first). */
  inputs?: number | undefined;
  /** A referee's batches and a fighter's disputes in the current window (absent before the first). */
  referee?: number | undefined;
  /**
   * SHA-256 of the object's salt and the socket's `CF-Connecting-IP` (`ipHash`), for the
   * witnesses' independence (ADR 0058). Kept here only, never in SQLite.
   */
  ip?: string | undefined;
};

export type ActiveSession = Session & { phase: 'active' };
export type LiveSession = Session & { phase: 'active' | 'queued' };

/** Every logged-in socket (except `except`) with its session. A joiner is still `challenged` until placed. */
export function* activeSessions(
  hub: Hub,
  except?: WebSocket,
): Generator<[WebSocket, ActiveSession]> {
  for (const other of hub.ctx.getWebSockets()) {
    if (other === except) continue;
    const theirs = sessionOf(other);
    if (theirs?.phase === 'active') yield [other, theirs];
  }
}

/** The player's seated socket, if any. */
export function seated(hub: Hub, player: string): [WebSocket, ActiveSession] | null {
  for (const entry of activeSessions(hub)) if (entry[1].playerId === player) return entry;
  return null;
}

/** Every signed-in socket (except `except`), seated or waiting. */
export function* liveSessions(hub: Hub, except?: WebSocket): Generator<[WebSocket, LiveSession]> {
  for (const other of hub.ctx.getWebSockets()) {
    if (other === except) continue;
    const theirs = sessionOf(other);
    if (theirs?.phase === 'active' || theirs?.phase === 'queued') yield [other, theirs];
  }
}

/** A commitment as the wire carries it: without the id and status the client recomputes or doesn't need. */
export const signedOf = ({ commitment, authSig, keyId }: SignedCommitment): SignedCommit => ({
  commitment,
  authSig,
  keyId,
});

/** A stored death cause; anything unrecognised reads as `killed`. */
export const causeOf = (value: unknown): DeathCause => (isCause(value) ? value : 'killed');

/** `bytes` of randomness as base64url. */
export function randomToken(bytes: number): string {
  return toBase64Url(crypto.getRandomValues(new Uint8Array(bytes)));
}

export function sessionOf(ws: WebSocket): Session | null {
  return ws.deserializeAttachment() as Session | null;
}

export function send(ws: WebSocket, msg: HubMsg): void {
  ws.send(JSON.stringify(msg));
}

/** Sends unless the socket closed in the meantime; true when the message went out on an open socket. */
export function sendIfOpen(ws: WebSocket, msg: HubMsg): boolean {
  if (ws.readyState !== WebSocket.OPEN) return false;
  try {
    send(ws, msg);
    return true;
  } catch {
    // closed while waiting
    return false;
  }
}
