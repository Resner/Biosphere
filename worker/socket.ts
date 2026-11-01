import { toBase64Url } from '../src/ledger/identity';
import { type HubMsg, isCause, type SignedCommit } from '../src/net/protocol';
import type { DeathCause } from '../src/sim/types';
import type { Beacons, SignedCommitment } from './beacons';
import type { Ledger } from './ledger';
import type { LifeState } from './life';
import type { Court } from './mating';
import type { TurnCredentials } from './turn';
import type { UsageMeter } from './usage';

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
      pondId: string;
      slot: number;
      /** The creature this connection is playing and what it has reported (absent without one). */
      life?: LifeState | undefined;
      /** The mating this player has offered, until the partner answers (lazy expiry, no timer). */
      court?: Court | undefined;
    }
  | {
      /** Signed in, but admission is full: waits for a place and is in no pond. */
      phase: 'queued';
      playerId: string;
      name: string;
      /** Arrival order; the lowest ticket is next. */
      ticket: number;
      /** The place last announced (1 = next), so only a change is sent again. */
      place: number;
    }
  | { phase: 'retired' }
) & { openedAt: number; windowStart: number; count: number; signals: number };

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

/** Sends unless the socket closed in the meantime. */
export function sendIfOpen(ws: WebSocket, msg: HubMsg): void {
  try {
    send(ws, msg);
  } catch {
    // closed while waiting
  }
}
