const DAY_MS = 86_400_000;
const FLUSH_EVERY_MS = 60_000;
/** One incoming message costs this many request-equivalents (Cloudflare bills 20 WebSocket messages as 1 request). */
const MESSAGES_PER_REQUEST = 20;

interface UsageRow extends Record<string, SqlStorageValue> {
  requests: number;
  messages: number;
  rows_written: number;
}

/**
 * The day's usage against the free tier (ADR 0008): upgrades, incoming messages and SQLite row writes,
 * counted in memory and flushed to the `usage` table at most once a minute and only when something changed.
 * A flush lost to eviction costs at most a minute of counts. Admission reads `requests` before any limit is reached.
 */
export class UsageMeter {
  private day = '';
  /** Requests in 1/20ths, so counting stays in integers. */
  private ticks = 0;
  private messages = 0;
  private rows = 0;
  private rowsSeen = 0;
  private dirty = false;
  private flushedAt = 0;

  /** `writes` reads the running total of rows this object has written (the ledger's counter). */
  constructor(
    private readonly sql: SqlStorage,
    private readonly writes: () => number,
  ) {}

  upgrade(now: number): void {
    this.touch(now);
    this.ticks += MESSAGES_PER_REQUEST;
    this.changed(now);
  }

  message(now: number): void {
    this.touch(now);
    this.ticks++;
    this.messages++;
    this.changed(now);
  }

  /** Request-equivalents counted today (UTC). */
  requests(now: number): number {
    this.touch(now);
    return this.ticks / MESSAGES_PER_REQUEST;
  }

  /** Writes the day's row if anything changed since the last flush. */
  flush(now: number): void {
    const delta = this.writes() - this.rowsSeen;
    if (!this.dirty && delta === 0) return;
    // The flush's own row is counted with the rows it reports.
    this.rows += delta + 1;
    this.rowsSeen += delta;
    this.sql.exec(
      `INSERT INTO usage (day, requests, messages, rows_written) VALUES (?, ?, ?, ?)
       ON CONFLICT (day) DO UPDATE SET requests = excluded.requests, messages = excluded.messages, rows_written = excluded.rows_written`,
      this.day,
      Math.round(this.ticks / MESSAGES_PER_REQUEST),
      this.messages,
      this.rows,
    );
    this.dirty = false;
    this.flushedAt = now;
  }

  private changed(now: number): void {
    this.dirty = true;
    if (now - this.flushedAt >= FLUSH_EVERY_MS) this.flush(now);
  }

  /** Moves to the day of `now`: the finished day's row is written, the new day's row (if the object was evicted) is picked up. */
  private touch(now: number): void {
    const day = new Date(Math.floor(now / DAY_MS) * DAY_MS).toISOString().slice(0, 10);
    if (day === this.day) return;
    if (this.day !== '') this.flush(now);
    this.day = day;
    const [stored] = this.sql
      .exec<UsageRow>('SELECT requests, messages, rows_written FROM usage WHERE day = ?', day)
      .toArray();
    this.ticks = (stored?.requests ?? 0) * MESSAGES_PER_REQUEST;
    this.messages = stored?.messages ?? 0;
    this.rows = stored?.rows_written ?? 0;
    this.rowsSeen = this.writes();
    this.dirty = false;
    this.flushedAt = now;
  }
}
