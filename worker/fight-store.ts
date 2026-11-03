// A running fight's log in SQLite (ADR 0053, M8 T2): the `encounters` row is inserted before
// `enc-start` goes out, each join is written before its `enc-join`, the final frames follow in
// batches of `BATCH_FRAMES` (and at once when a participant's socket closes), and the end writes
// the tail and closes the row. Recovery after a restart (T5) and the settlement (T8) read it back.

import type { EncJoin, EncStart } from '../src/net/encounter-start';
import type { Fight } from './fights';

/** Final frames are written once this many have gathered since the last write (M13 may raise it). */
export const BATCH_FRAMES = 10;

/** A slot's fighter as its fight began (or its join): its player's name and its life clock. */
export interface SlotClock {
  /** The player's name, '' when it was away. */
  name: string;
  activeMs: number;
  lifespanMs: number;
}

/** An `encounters` row, read back. */
export interface FightRow {
  id: string;
  pond: string;
  start: EncStart;
  joins: EncJoin[];
  /** `frames[f][slot]`: each final frame's input codes, null for the fallback marker. */
  frames: (number | null)[][];
  /** How many frames `frames` holds. */
  persisted: number;
  fighters: SlotClock[];
  open: boolean;
  /** When the row was inserted (hub time). */
  t: number;
  settlement: string | null;
}

interface StoredRow extends Record<string, SqlStorageValue> {
  id: string;
  pond: string;
  start: string;
  joins: string;
  frames: string;
  persisted: number;
  fighters: string;
  open: number;
  t: number;
  settlement: string | null;
}

/** The final frames' inputs, in order, as the fight's history holds them. */
const framesOf = (fight: Fight): (number | null)[][] =>
  fight.history.flatMap((m) => (m.t === 'enc-frame' ? [m.i] : []));

const joinsOf = (fight: Fight): EncJoin[] =>
  fight.history.filter((m): m is EncJoin => m.t === 'enc-join');

export class FightStore {
  /** Rows this store has written (also added to the ledger's count, which the usage meter reads). */
  rowsWritten = 0;

  constructor(
    private readonly sql: SqlStorage,
    private readonly counted: (rows: number) => void,
  ) {}

  /** Inserts the fight's row before its `enc-start` is sent; throws when it can't be written. */
  open(fight: Fight, now: number): void {
    this.run(
      `INSERT INTO encounters (id, pond, start, joins, frames, persisted, fighters, open, t, settlement)
       VALUES (?, ?, ?, '[]', '[]', 0, ?, 1, ?, NULL)`,
      fight.start.enc,
      fight.pond,
      JSON.stringify(fight.start),
      JSON.stringify(fight.slots),
      now,
    );
  }

  /** Writes a join (and the joiner's clock) before its `enc-join` is sent; throws when it can't. */
  join(fight: Fight, msg: EncJoin, clock: SlotClock): void {
    this.run(
      'UPDATE encounters SET joins = ?, fighters = ? WHERE id = ?',
      JSON.stringify([...joinsOf(fight), msg]),
      JSON.stringify([...fight.slots, clock]),
      fight.start.enc,
    );
  }

  /** Writes the final frames up to the last whole batch, when a batch has gathered since the last write. */
  append(fight: Fight): void {
    const frames = framesOf(fight);
    const upTo = frames.length - (frames.length % BATCH_FRAMES);
    if (upTo > fight.persisted) this.frames(fight, frames.slice(0, upTo), true);
  }

  /** Writes every final frame not yet written (a participant's socket closed). */
  flush(fight: Fight): void {
    const frames = framesOf(fight);
    if (frames.length > fight.persisted) this.frames(fight, frames, true);
  }

  /** Writes the tail and closes the row, just before the fight is settled. */
  close(fight: Fight): void {
    this.frames(fight, framesOf(fight), false);
  }

  /** The fight's row, or null. */
  read(id: string): FightRow | null {
    const row = this.sql.exec<StoredRow>('SELECT * FROM encounters WHERE id = ?', id).toArray()[0];
    if (!row) return null;
    return {
      id: row.id,
      pond: row.pond,
      start: JSON.parse(row.start) as EncStart,
      joins: JSON.parse(row.joins) as EncJoin[],
      frames: JSON.parse(row.frames) as (number | null)[][],
      persisted: row.persisted,
      fighters: JSON.parse(row.fighters) as SlotClock[],
      open: row.open === 1,
      t: row.t,
      settlement: row.settlement,
    };
  }

  /**
   * Rewrites the row's frames (the whole log so far: a batch's write costs one row whatever it
   * holds); `close` also takes the row out of the open index. A failed write is logged and the
   * fight goes on; the next batch writes it again.
   */
  private frames(fight: Fight, frames: (number | null)[][], open: boolean): void {
    try {
      // `open` is set only at the close: setting the indexed column costs index rows on every batch.
      this.run(
        `UPDATE encounters SET frames = ?, persisted = ?${open ? '' : ', open = 0'} WHERE id = ?`,
        JSON.stringify(frames),
        frames.length,
        fight.start.enc,
      );
      fight.persisted = frames.length;
    } catch (error) {
      console.error('fight log write failed', error);
    }
  }

  private run(query: string, ...bindings: SqlStorageValue[]): void {
    const cursor = this.sql.exec(query, ...bindings);
    cursor.toArray();
    this.rowsWritten += cursor.rowsWritten;
    this.counted(cursor.rowsWritten);
  }
}
