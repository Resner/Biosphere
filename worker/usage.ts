export const DAY_MS = 86_400_000;

/** The start of the UTC day holding `now`. */
export const dayStartOf = (now: number): number => Math.floor(now / DAY_MS) * DAY_MS;
const FLUSH_EVERY_MS = 60_000;
/** One incoming message costs this many request-equivalents (Cloudflare bills 20 WebSocket messages as 1 request). */
const MESSAGES_PER_REQUEST = 20;

interface UsageRow extends Record<string, SqlStorageValue> {
  requests: number;
  messages: number;
  rows_written: number;
  db_bytes: number;
}

/** The free plan's SQLite storage per Durable Object (ADR 0008): the limit the audit shows the size against. */
export const STORAGE_LIMIT_BYTES = 5_000_000_000;

/**
 * The day's usage against the free tier (ADR 0008): upgrades, incoming messages and SQLite row writes,
 * counted in memory and flushed to the `usage` table at most once a minute and only when something changed.
 * A flush lost to eviction costs at most a minute of counts. Admission reads `requests` before any limit is reached.
 */
export class UsageMeter {
  private day = '';
  /** The day's span in ms, so the common call is two comparisons. */
  private dayStart = 0;
  private dayEnd = 0;
  /** Requests in 1/20ths, so counting stays in integers (stored rounded up, so a reload never under-counts). */
  private ticks = 0;
  private messages = 0;
  private rows = 0;
  private rowsSeen = 0;
  /** The database's size recorded for the day, 0 until the day's first flush. */
  private bytes = 0;
  private dirty = false;
  private flushedAt = 0;

  /** `writes` reads the running total of rows this object has written (the ledger's counter). */
  constructor(
    private readonly sql: SqlStorage,
    private readonly writes: () => number,
  ) {}

  /** A WebSocket upgrade is one request. */
  upgrade(now: number): void {
    this.request(now);
  }

  /** A request that reached the object (an upgrade, a proof read): one request, no message. */
  request(now: number): void {
    this.count(now, MESSAGES_PER_REQUEST, 0);
  }

  message(now: number): void {
    this.count(now, 1, 1);
  }

  /** Request-equivalents counted today (UTC). */
  requests(now: number): number {
    this.touch(now);
    return this.ticks / MESSAGES_PER_REQUEST;
  }

  /** The database's size as the day's row holds it, or as it is now before the day's first flush. */
  databaseBytes(now: number): number {
    this.touch(now);
    return this.bytes || this.sql.databaseSize;
  }

  /** Writes the day's row if anything changed since the last flush. */
  flush(now: number): void {
    const delta = this.writes() - this.rowsSeen;
    if (!this.dirty && delta === 0) return;
    // The flush's own row is counted with the rows it reports.
    this.rows += delta + 1;
    this.rowsSeen += delta;
    // Once a day, with the first flush of its row (the one after midnight): a size is a read, free.
    this.bytes ||= this.sql.databaseSize;
    this.sql.exec(
      `INSERT INTO usage (day, requests, messages, rows_written, db_bytes) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (day) DO UPDATE SET requests = excluded.requests, messages = excluded.messages, rows_written = excluded.rows_written, db_bytes = excluded.db_bytes`,
      this.day,
      Math.ceil(this.ticks / MESSAGES_PER_REQUEST),
      this.messages,
      this.rows,
      this.bytes,
    );
    this.dirty = false;
    this.flushedAt = now;
  }

  private count(now: number, ticks: number, messages: number): void {
    this.touch(now);
    this.ticks += ticks;
    this.messages += messages;
    this.dirty = true;
    if (now - this.flushedAt >= FLUSH_EVERY_MS) this.flush(now);
  }

  /** Moves to the day of `now`: the finished day's row is written, the new day's row (if the object was evicted) is picked up. */
  private touch(now: number): void {
    if (now >= this.dayStart && now < this.dayEnd) return;
    this.dayStart = dayStartOf(now);
    this.dayEnd = this.dayStart + DAY_MS;
    const day = new Date(this.dayStart).toISOString().slice(0, 10);
    if (this.day !== '') this.flush(now);
    this.day = day;
    const [stored] = this.sql
      .exec<UsageRow>(
        'SELECT requests, messages, rows_written, db_bytes FROM usage WHERE day = ?',
        day,
      )
      .toArray();
    this.ticks = (stored?.requests ?? 0) * MESSAGES_PER_REQUEST;
    this.messages = stored?.messages ?? 0;
    this.rows = stored?.rows_written ?? 0;
    this.bytes = stored?.db_bytes ?? 0;
    this.rowsSeen = this.writes();
    this.dirty = false;
    this.flushedAt = now;
  }
}
