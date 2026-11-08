// The one world's row (M11 T14): the `ponds` table keeps a single row, made on first use, whose id
// names the world in snapshot signatures and fight logs, with the world's seed and clock.

import type { WorldInfo } from '../src/net/protocol';
import { RULES } from '../src/sim/rules';
import type { PondRow } from './schema';
import { type Hub, randomToken } from './socket';

/** The world's row, made on first use with the world's seed and clock and centred on the world. */
export function worldRow(hub: Pick<Hub, 'sql'>): PondRow {
  const sql = hub.sql;
  const row = sql.exec<PondRow>('SELECT * FROM ponds ORDER BY created, id LIMIT 1').toArray()[0];
  if (row) return row;
  const world = sql.exec<{ seed: string; clock: number }>('SELECT seed, clock FROM world').one();
  const centre = RULES.world.size / 2;
  const made: PondRow = {
    id: randomToken(6),
    seed: world.seed,
    epoch: world.clock,
    cx: centre,
    cy: centre,
    created: Date.now(),
  };
  sql.exec(
    'INSERT INTO ponds (id, seed, epoch, cx, cy, created) VALUES (?, ?, ?, ?, ?, ?)',
    made.id,
    made.seed,
    made.epoch,
    made.cx,
    made.cy,
    made.created,
  );
  return made;
}

/** The world as a welcome names it. */
export function worldInfo(row: PondRow): WorldInfo {
  return {
    id: row.id,
    seed: row.seed,
    epoch: row.epoch,
    centre: { x: row.cx, y: row.cy },
    size: RULES.world.size,
  };
}
