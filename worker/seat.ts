// Seat tickets on the hub (M11 T7, ADR 0062): the welcome carries one, and the first `pong` at
// least `SEAT_RENEW_MS` after the session's last is followed by a fresh one. A ticket names the
// world by its seed, which every pond of the one world shares (M11 T1), so a ticket holds across
// ponds until T14 removes them. Signing goes through the ledger's `countersign` and writes no row
// (the authority's key is made once, at its first use by anything).

import { SEAT_RENEW_MS, SEAT_TTL_MS, type SignedSeat, seatHash } from '../src/ledger/seat';
import { type ActiveSession, type Hub, type Session, sendIfOpen } from './socket';

/** The world a ticket names: its seed, the one every pond row takes. */
function worldOf(hub: Hub): string {
  return hub.ctx.storage.sql.exec<{ seed: string }>('SELECT seed FROM world').one().seed;
}

/** A ticket for `who`, dated `now` on the hub's clock and good for `SEAT_TTL_MS`. */
export function seatTicket(
  hub: Hub,
  who: { playerId: string; name: string },
  now: number,
): SignedSeat {
  const seat = {
    v: 1 as const,
    kind: 'seat' as const,
    player: who.playerId,
    name: who.name,
    world: worldOf(hub),
    t: now,
    until: now + SEAT_TTL_MS,
  };
  return { seat, ...hub.ledger.countersign(seatHash(seat)) };
}

/** After a `pong`: a fresh `seat` once the session's last ticket is `SEAT_RENEW_MS` old. */
export function renewSeat(hub: Hub, ws: WebSocket, session: ActiveSession, now: number): void {
  if (now - (session.seatAt ?? 0) < SEAT_RENEW_MS) return;
  ws.serializeAttachment({ ...session, seatAt: now } satisfies Session);
  sendIfOpen(ws, { t: 'seat', ticket: seatTicket(hub, session, now) });
}
