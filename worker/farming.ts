// A victim's worth as prey (ADR 0054, M8 T7): the authority sets it at lock-in and at each join,
// from the ledger alone, so farming an alternate identity pays less and less within a day.

import { RULES } from '../src/sim/rules';
import type { Hub } from './socket';

const F = RULES.encounter.farming;

/**
 * The kills of the player's creatures in the window (at most `maxHalvings`), through the dead
 * index, and when the identity was first seen. A death's cause is in its record, the creature's last.
 */
const WORTH_FACTS = `SELECT
  (SELECT COUNT(*) FROM (
    SELECT 1 FROM creatures c JOIN records r ON r.creature = c.id AND r.seq = c.seq
    WHERE c.owner = ?1 AND c.status = 'dead' AND c.died_t > ?2 AND r.kind = 'death'
      AND json_extract(r.json, '$.body.cause') = 'killed'
    LIMIT ?3)) AS kills,
  (SELECT first_seen FROM players WHERE id = ?1) AS first_seen`;

/**
 * `0.5^k`: `k` counts the player's creatures killed (cause `killed`, by anyone) in the 24 h before
 * `now`, at most 6, plus 1 while the identity was first seen under 30 minutes before `now` (or
 * has no row yet). One read, and no write.
 */
export function worthOf(hub: Hub, player: string, now: number): number {
  const row = hub.ctx.storage.sql
    .exec<{ kills: number; first_seen: number | null }>(
      WORTH_FACTS,
      player,
      now - F.windowMs,
      F.maxHalvings,
    )
    .one();
  const young = row.first_seen === null || now - row.first_seen < F.youngMs ? 1 : 0;
  return 0.5 ** (row.kills + young);
}
