// Riding the current (M12 T7, ADR 0064): a player alone for long enough asks to be carried to the
// best group of the others. The hub judges every refusal itself (a fight, a court, a recent fight,
// company, nobody to ride to), so the ride is never an escape; a granted ride is a protected
// `spawn { why: 'ride' }` at `place()`, anchored there, the member in the directory at its arrival.

import { queryRadius } from '../src/net/aoi';
import type { HubMsg, RideNo } from '../src/net/protocol';
import { createRng, seedFromBytes } from '../src/sim/prng';
import { RULES } from '../src/sim/rules';
import { linkTiers } from '../src/sim/size';
import { pondTick } from './engage';
import { protectionEnds } from './life';
import { askLive } from './mating';
import { place } from './placement';
import { type ActiveSession, activeSessions, type Hub, sendIfOpen } from './socket';
import { othersOf, remember, spawnerOf } from './spawn';
import { bindingOf, sharesWater, tellMoved, whereIn } from './where';
import { worldRow } from './world';

/** How long a player is alone before it may ride: 120 s, or `RIDE_ALONE_MS` (at least 1,000) in fixture mode. */
export const RIDE_ALONE_MS = 120_000;

export function rideAloneMsOf(env: { DRAND_SOURCE?: string; RIDE_ALONE_MS?: string }): number {
  const n = env.DRAND_SOURCE === 'fixture' ? Number(env.RIDE_ALONE_MS) : Number.NaN;
  return Number.isInteger(n) && n >= 1000 ? n : RIDE_ALONE_MS;
}

/**
 * When the session has been alone since, after a `near` with `peers` linkable peers sharing its
 * water: none keeps the time it began (or starts it now), any clears it.
 */
export const aloneAfter = (since: number | undefined, peers: number, now: number) =>
  peers > 0 ? undefined : (since ?? now);

/** Whether a court involving the player waits for its answer: its own, or one naming it. */
function courting(hub: Hub, player: string): boolean {
  const now = Date.now();
  for (const [, s] of activeSessions(hub)) {
    const c = s.court;
    if (!c || !('ask' in c) || !askLive(c.sentAt, now)) continue;
    if (s.playerId === player || c.ask.partner === player) return true;
  }
  return false;
}

/** Whether the directory places a member the player can link with, sharing its water, within its `Q`. */
function company(hub: Hub, player: string): boolean {
  const self = hub.directory.member(player);
  if (!self) return false;
  const q = queryRadius(self.aoi);
  return hub.directory.around(self.x, self.y, q).some((id) => {
    const m = id === player ? null : hub.directory.member(id);
    return (
      m !== null &&
      Math.hypot(m.x - self.x, m.y - self.y) <= q &&
      linkTiers(self.r, m.r) &&
      sharesWater(hub, player, id)
    );
  });
}

/**
 * Why a ride is refused, in order (ADR 0064): `locked` in a fight or a lock; `busy` with a court
 * outstanding; `soon` within 120 s of its last fight's end or alone for less than the wait;
 * `company` with a linkable member sharing its water within its Q; `soon` again when the hub has
 * not seen it alone yet (or it is not in the water). Null: it may ride.
 */
export function rideRefusal(hub: Hub, session: ActiveSession, now: number): RideNo | null {
  const id = session.playerId;
  if (hub.fights.playerLocked(id)) return 'locked';
  if (courting(hub, id)) return 'busy';
  const since = session.aloneSince;
  if (hub.fights.lastFightEnd(id) !== null) return 'soon';
  if (since !== undefined && now - since < rideAloneMsOf(hub.env)) return 'soon';
  if (company(hub, id)) return 'company';
  if (since === undefined || !hub.directory.member(id)) return 'soon';
  return null;
}

/**
 * Answers a `ride` (ADR 0064): a refusal as `ride-no`, else `spawn { why: 'ride', protect: true }`
 * at `place()` around the best group of the others (no group, or none with room around it, is
 * `none`). The arrival is anchored, protected for 15 s, remembered as a recent spawn, and the member
 * is in the directory there at once, so two lone players asking together don't swap places. The
 * alone time starts again. Writes no row.
 */
export function ride(hub: Hub, ws: WebSocket, session: ActiveSession): void {
  const now = hub.clock.now();
  const no = (why: RideNo) => sendIfOpen(ws, { t: 'ride-no', why });
  const refused = rideRefusal(hub, session, now);
  if (refused) {
    no(refused);
    return;
  }
  const self = hub.directory.member(session.playerId);
  if (!self) {
    no('soon');
    return;
  }
  const spawner = spawnerOf(session.life, self);
  const row = worldRow(hub);
  const at = place({
    members: othersOf(hub, session.playerId),
    recent: hub.spawns,
    spawner,
    centre: { x: row.cx, y: row.cy },
    world: { seed: row.seed, size: RULES.world.size, tick: Math.max(0, pondTick(now, row.epoch)) },
    now,
    rng: createRng(seedFromBytes(crypto.getRandomValues(new Uint8Array(16))), 'ride'),
  });
  if (at.group === null || at.fallback !== 'none') {
    no('none');
    return;
  }
  const bind = bindingOf(session.life);
  remember(hub, { x: at.x, y: at.y, r: spawner.r, aoi: spawner.aoi, t: now });
  const next: ActiveSession = {
    ...session,
    anchor: { x: at.x, y: at.y, t: now, bind },
    protectedUntil: protectionEnds(now),
    aloneSince: undefined,
  };
  const moved = whereIn(hub, ws, next, {
    x: at.x,
    y: at.y,
    r: self.r,
    aoi: self.aoi,
    t: now,
    bind,
  });
  const answer: HubMsg = { t: 'spawn', x: at.x, y: at.y, why: 'ride', protect: true };
  sendIfOpen(ws, answer);
  tellMoved(hub, moved);
}
