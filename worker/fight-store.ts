// A running fight's log in SQLite (ADR 0053, M8 T2): the `encounters` row is inserted before
// `enc-start` goes out, each join is written before its `enc-join`, the final frames follow in
// batches of `BATCH_FRAMES` (and at once when a participant's socket closes), and the settlement's
// transaction writes the tail with the countersigned document and closes the row (`seal`).
// Recovery after a restart (`recover.ts`) reads it back.

import { type FightLog, parseRefereeSpans, type SignedSettlement } from '../src/ledger/settlement';
import type { EncJoin, EncStart } from '../src/net/encounter-start';
import type { RefereeSpan } from '../src/net/handover';
import { packFrames, unpackFrames } from './fight-pack';
import type { Fight } from './fights';
import { DAY_MS } from './usage';

/** Final frames are written once this many have gathered since the last write (M13 may raise it). */
export const BATCH_FRAMES = 10;

/** A slot's fighter as its fight began (or its join): its player's name and its life clock. */
export interface SlotClock {
  /** The player's name, '' when it was away. */
  name: string;
  activeMs: number;
  lifespanMs: number;
}

/** A settled fight's log is kept this many days (ADR 0056); later settlements prune the expired ones. */
export const LOG_KEEP_DAYS = 14;
/** Expired logs one settlement's transaction prunes at most, so pruning costs a bounded number of writes. */
export const PRUNE_PER_SETTLEMENT = 4;

/** An `encounters` row, read back (a pruned row has no log to read: `read` answers null). */
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
  /** Who refereed which frames (ADR 0058), as last saved; null until a handover. */
  referees: RefereeSpan[] | null;
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
  referees: string;
}

/** The final frames' inputs, in order, as the fight's history holds them. */
const framesOf = (fight: Fight): (number | null)[][] =>
  fight.history.flatMap((m) => (m.t === 'enc-frame' ? [m.i] : []));

const joinsOf = (fight: Fight): EncJoin[] =>
  fight.history.filter((m): m is EncJoin => m.t === 'enc-join');

/** The fight as its settlement document names it (ADR 0054): its pond, start, joins and every final frame. */
export const logOf = (fight: Fight): FightLog => ({
  pondSeed: fight.pondSeed,
  start: fight.start,
  joins: joinsOf(fight),
  frames: framesOf(fight),
});

/** A stored row, parsed. */
const rowOf = (row: StoredRow): FightRow => {
  const start = JSON.parse(row.start) as EncStart;
  const joins = JSON.parse(row.joins) as EncJoin[];
  return {
    id: row.id,
    pond: row.pond,
    start,
    joins,
    frames: unpackFrames(row.frames, start.fighters.length, joins),
    persisted: row.persisted,
    fighters: JSON.parse(row.fighters) as SlotClock[],
    open: row.open === 1,
    t: row.t,
    settlement: row.settlement,
    referees: spansOf(row.referees),
  };
};

/** The saved spans, or null when none were saved (or they no longer read). */
function spansOf(text: string): RefereeSpan[] | null {
  if (!text) return null;
  try {
    return parseRefereeSpans(JSON.parse(text));
  } catch {
    return null;
  }
}

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
    // `referee.next` counts the final frames, so a tick that finishes no batch builds nothing.
    const upTo = fight.referee.next - (fight.referee.next % BATCH_FRAMES);
    if (upTo > fight.persisted) this.frames(fight, framesOf(fight).slice(0, upTo));
  }

  /** Saves who referees which frames (a handover or a take-back, ADR 0058): one row; throws when it can't. */
  referees(fight: Fight): void {
    this.run(
      'UPDATE encounters SET referees = ? WHERE id = ?',
      JSON.stringify(fight.spans),
      fight.start.enc,
    );
  }

  /** Writes every final frame not yet written (a participant's socket closed). */
  flush(fight: Fight): void {
    const frames = framesOf(fight);
    if (frames.length > fight.persisted) this.frames(fight, frames);
  }

  /**
   * Writes the tail, the countersigned settlement and `open = 0` in one update, then prunes the
   * logs that expired by the settlement's time, inside the settlement's transaction
   * (`Ledger.settle`); throws when it can't, so the records roll back too.
   */
  seal(fight: Fight, frames: ReturnType<typeof framesOf>, signed: SignedSettlement): void {
    this.run(
      'UPDATE encounters SET frames = ?, persisted = ?, open = 0, settlement = ? WHERE id = ?',
      packFrames(frames),
      frames.length,
      JSON.stringify(signed),
      fight.start.enc,
    );
    fight.persisted = frames.length;
    this.prune(signed.settlement.t);
  }

  /**
   * Blanks the start, joins, frames and fighters of the oldest settled rows started more than
   * `LOG_KEEP_DAYS` before `now` (at most `PRUNE_PER_SETTLEMENT`), keeping id, pond, time, frame
   * count and the settlement: what a proof still needs. `GET /v1/fight` then answers `log: null`.
   */
  prune(now: number): void {
    const expired = this.sql
      .exec<{ id: string }>(
        `SELECT id FROM encounters WHERE start <> '' AND settlement IS NOT NULL AND t <= ?
         ORDER BY t, id LIMIT ?`,
        now - LOG_KEEP_DAYS * DAY_MS,
        PRUNE_PER_SETTLEMENT,
      )
      .toArray();
    for (const { id } of expired) {
      this.run(
        "UPDATE encounters SET start = '', joins = '', frames = '', fighters = '' WHERE id = ?",
        id,
      );
    }
  }

  /** The fight's countersigned settlement, once it is settled. */
  settlement(id: string): SignedSettlement | null {
    const row = this.sql
      .exec<{ settlement: string | null }>('SELECT settlement FROM encounters WHERE id = ?', id)
      .toArray()[0];
    return row?.settlement ? (JSON.parse(row.settlement) as SignedSettlement) : null;
  }

  /** The fight's row, or null. */
  read(id: string): FightRow | null {
    const row = this.sql.exec<StoredRow>('SELECT * FROM encounters WHERE id = ?', id).toArray()[0];
    return row && row.start !== '' ? rowOf(row) : null;
  }

  /** Every row still open (through the open index), oldest first: what recovery rebuilds. */
  openRows(): FightRow[] {
    return this.sql
      .exec<StoredRow>('SELECT * FROM encounters WHERE open = 1 ORDER BY t, id')
      .toArray()
      .map(rowOf);
  }

  /** Takes a row out of the open index without touching its log: one that is settled or can't be rebuilt. */
  closeRow(id: string): void {
    this.run('UPDATE encounters SET open = 0 WHERE id = ? AND open = 1', id);
  }

  /**
   * Rewrites the row's frames (the whole log so far: a batch's write costs one row whatever it
   * holds). A failed write is logged and the fight goes on; the next batch writes it again.
   */
  private frames(fight: Fight, frames: (number | null)[][]): void {
    try {
      // `open` is left to `seal`: setting the indexed column costs index rows on every batch.
      this.run(
        'UPDATE encounters SET frames = ?, persisted = ? WHERE id = ?',
        packFrames(frames),
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
