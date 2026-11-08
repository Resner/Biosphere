import type { RelayReport } from '../src/net/protocol';

export const DAY_MS = 86_400_000;

/** The start of the UTC day holding `now`. */
export const dayStartOf = (now: number): number => Math.floor(now / DAY_MS) * DAY_MS;
const FLUSH_EVERY_MS = 60_000;
/** One incoming message costs this many request-equivalents (Cloudflare bills 20 WebSocket messages as 1 request). */
const MESSAGES_PER_REQUEST = 20;
/** `GET /v1/metrics` lists this many earlier days. */
const HISTORY_DAYS = 31;

/** One UTC day as the `usage` row and `GET /v1/metrics` hold it (M13 T1, ADR 0067). */
export interface UsageDay {
  /** YYYY-MM-DD. */
  day: string;
  /** Request-equivalents, rounded up. */
  requests: number;
  messages: number;
  /** Incoming messages by `ClientMsg['t']`, plus `bad` for an unparsed one. */
  byType: Record<string, number>;
  upgrades: number;
  /** Public reads that reached the object (proofs, fights, the audit, the metrics). */
  reads: number;
  rowsWritten: number;
  rowsRead: number;
  /** The database's size at the day's first flush. */
  dbBytes: number;
  /** Seated session-milliseconds. */
  playerMs: number;
  peakSeated: number;
  peakQueued: number;
  /** Sessions seated from the line, and their summed waits. */
  waits: number;
  waitMs: number;
  /** The relay traffic that pages report (M13 T4). */
  relay: { reports: number; links: number; relayed: number; kb: number };
}

interface UsageRow extends Record<string, SqlStorageValue> {
  day: string;
  requests: number;
  messages: number;
  rows_written: number;
  db_bytes: number;
  by_type: string;
  upgrades: number;
  reads: number;
  rows_read: number;
  player_ms: number;
  peak_seated: number;
  peak_queued: number;
  waits: number;
  wait_ms: number;
  relay_reports: number;
  relay_links: number;
  relay_relayed: number;
  relay_kb: number;
}

const COLUMNS = `day, requests, messages, rows_written, db_bytes, by_type, upgrades, reads, rows_read,
  player_ms, peak_seated, peak_queued, waits, wait_ms, relay_reports, relay_links, relay_relayed, relay_kb`;

/** A stored `by_type`, tolerating anything unreadable as no counts. */
function parseByType(text: string): Record<string, number> {
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== 'object' || parsed === null) return {};
    const out: Record<string, number> = {};
    for (const [k, v] of Object.entries(parsed)) if (Number.isFinite(v)) out[k] = v as number;
    return out;
  } catch {
    return {};
  }
}

const emptyDay = (day: string): UsageDay => ({
  day,
  requests: 0,
  messages: 0,
  byType: {},
  upgrades: 0,
  reads: 0,
  rowsWritten: 0,
  rowsRead: 0,
  dbBytes: 0,
  playerMs: 0,
  peakSeated: 0,
  peakQueued: 0,
  waits: 0,
  waitMs: 0,
  relay: { reports: 0, links: 0, relayed: 0, kb: 0 },
});

const dayOfRow = (row: UsageRow): UsageDay => ({
  day: row.day,
  requests: row.requests,
  messages: row.messages,
  byType: parseByType(row.by_type),
  upgrades: row.upgrades,
  reads: row.reads,
  rowsWritten: row.rows_written,
  rowsRead: row.rows_read,
  dbBytes: row.db_bytes,
  playerMs: row.player_ms,
  peakSeated: row.peak_seated,
  peakQueued: row.peak_queued,
  waits: row.waits,
  waitMs: row.wait_ms,
  relay: {
    reports: row.relay_reports,
    links: row.relay_links,
    relayed: row.relay_relayed,
    kb: row.relay_kb,
  },
});

/**
 * The day's usage against the plan's limits (ADR 0008, 0067): upgrades, incoming messages by type,
 * SQLite rows written and read, seated time and the line's waits, counted in memory and flushed to
 * the `usage` table at most once a minute and only when something changed. A flush lost to
 * eviction costs at most a minute of counts. Admission reads `requests` before any limit is reached.
 */
export class UsageMeter {
  private day = '';
  /** The day's span in ms, so the common call is two comparisons. */
  private dayStart = 0;
  private dayEnd = 0;
  /** Requests in 1/20ths, so counting stays in integers (stored rounded up, so a reload never under-counts). */
  private ticks = 0;
  private messages = 0;
  private byType: Record<string, number> = {};
  private upgrades = 0;
  private reads = 0;
  private rows = 0;
  private rowsSeen = 0;
  /** Rows read as the day's row holds them. */
  private rowsReadStored = 0;
  private readsSeen = 0;
  private playerMs = 0;
  private peakSeated = 0;
  private peakQueued = 0;
  private waits = 0;
  private waitMs = 0;
  private relay = { reports: 0, links: 0, relayed: 0, kb: 0 };
  /** Sessions seated and waiting now, and when the seated time was last added up. */
  private seatedNow = 0;
  private queuedNow = 0;
  private seatedAt = 0;
  /** The database's size recorded for the day, 0 until the day's first flush. */
  private bytes = 0;
  private dirty = false;
  private flushedAt = 0;

  /**
   * `writes` and `reads` read the running totals of rows this object has written and read (the
   * metered handle's counts, `metered-sql.ts`); `sql` is the raw handle, so a flush isn't counted twice.
   */
  constructor(
    private readonly sql: SqlStorage,
    private readonly writes: () => number,
    private readonly readTotal: () => number = () => 0,
  ) {}

  /** A WebSocket upgrade is one request. */
  upgrade(now: number): void {
    this.touch(now);
    this.upgrades++;
    this.count(now, MESSAGES_PER_REQUEST, 0);
  }

  /** A public read that reached the object (a proof, the audit, the metrics): one request, no message. */
  request(now: number): void {
    this.touch(now);
    this.reads++;
    this.count(now, MESSAGES_PER_REQUEST, 0);
  }

  /** An incoming message of `type` (`bad` for one that didn't parse); no type counts it in `messages` only. */
  message(now: number, type?: string): void {
    this.touch(now);
    if (type !== undefined) this.byType[type] = (this.byType[type] ?? 0) + 1;
    this.count(now, 1, 1);
  }

  /** The number of sessions seated now: the seated time is added up to `now` first. */
  setSeated(now: number, seated: number): void {
    this.touch(now);
    this.integrate(now);
    this.seatedNow = seated;
    this.peakSeated = Math.max(this.peakSeated, seated);
    this.dirty = true;
  }

  /** The number of sessions waiting in line now. */
  setQueued(now: number, queued: number): void {
    this.touch(now);
    this.queuedNow = queued;
    this.peakQueued = Math.max(this.peakQueued, queued);
    this.dirty = true;
  }

  /** A session was seated from the line after `ms`. */
  waited(now: number, ms: number): void {
    this.touch(now);
    this.waits++;
    this.waitMs += Math.max(0, Math.round(ms));
    this.dirty = true;
  }

  /** A page's relay report (M13 T4). */
  relayed(now: number, report: RelayReport): void {
    this.touch(now);
    this.relay.reports++;
    this.relay.links += report.links;
    this.relay.relayed += report.relayed;
    this.relay.kb += report.kb;
    this.dirty = true;
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

  /** Today's counts as the meter holds them now, not as last flushed. */
  today(now: number): UsageDay {
    this.touch(now);
    this.integrate(now);
    const day = emptyDay(this.day);
    return {
      ...day,
      requests: Math.ceil(this.ticks / MESSAGES_PER_REQUEST),
      messages: this.messages,
      byType: { ...this.byType },
      upgrades: this.upgrades,
      reads: this.reads,
      // The flush's own row is counted with the rows it reports, as a flush would.
      rowsWritten: this.rows + (this.writes() - this.rowsSeen),
      rowsRead: this.rowsReadNow(),
      dbBytes: this.databaseBytes(now),
      playerMs: Math.round(this.playerMs),
      peakSeated: this.peakSeated,
      peakQueued: this.peakQueued,
      waits: this.waits,
      waitMs: this.waitMs,
      relay: { ...this.relay },
    };
  }

  /** The days before today that have rows, newest first (at most 31). */
  history(now: number): UsageDay[] {
    this.touch(now);
    return this.sql
      .exec<UsageRow>(
        `SELECT ${COLUMNS} FROM usage WHERE day < ? ORDER BY day DESC LIMIT ${HISTORY_DAYS}`,
        this.day,
      )
      .toArray()
      .map(dayOfRow);
  }

  /** The UTC month's totals before today (today's counts are added by the caller). */
  monthBefore(now: number): {
    requests: number;
    rowsWritten: number;
    rowsRead: number;
    relayKb: number;
  } {
    this.touch(now);
    const first = `${this.day.slice(0, 8)}01`;
    const [row] = this.sql
      .exec<{ r: number | null; w: number | null; rr: number | null; kb: number | null }>(
        `SELECT SUM(requests) AS r, SUM(rows_written) AS w, SUM(rows_read) AS rr, SUM(relay_kb) AS kb
           FROM usage WHERE day >= ? AND day < ?`,
        first,
        this.day,
      )
      .toArray();
    return {
      requests: row?.r ?? 0,
      rowsWritten: row?.w ?? 0,
      rowsRead: row?.rr ?? 0,
      relayKb: row?.kb ?? 0,
    };
  }

  /** Writes the day's row if anything changed since the last flush. */
  flush(now: number): void {
    if (this.day === '') return;
    const written = this.writes() - this.rowsSeen;
    const read = this.readTotal() - this.readsSeen;
    if (!this.dirty && written === 0 && read === 0) return;
    this.integrate(Math.min(now, this.dayEnd));
    this.writeRow(now, written, read);
  }

  private rowsReadNow(): number {
    return this.rowsReadStored + (this.readTotal() - this.readsSeen);
  }

  private writeRow(now: number, written: number, read: number): void {
    // The flush's own row is counted with the rows it reports.
    this.rows += written + 1;
    this.rowsSeen += written;
    this.rowsReadStored += read;
    this.readsSeen += read;
    // Once a day, with the first flush of its row (the one after midnight): a size is a read, free.
    this.bytes ||= this.sql.databaseSize;
    this.sql.exec(
      `INSERT INTO usage (${COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (day) DO UPDATE SET requests = excluded.requests, messages = excluded.messages,
         rows_written = excluded.rows_written, db_bytes = excluded.db_bytes, by_type = excluded.by_type,
         upgrades = excluded.upgrades, reads = excluded.reads, rows_read = excluded.rows_read,
         player_ms = excluded.player_ms, peak_seated = excluded.peak_seated,
         peak_queued = excluded.peak_queued, waits = excluded.waits, wait_ms = excluded.wait_ms,
         relay_reports = excluded.relay_reports, relay_links = excluded.relay_links,
         relay_relayed = excluded.relay_relayed, relay_kb = excluded.relay_kb`,
      this.day,
      Math.ceil(this.ticks / MESSAGES_PER_REQUEST),
      this.messages,
      this.rows,
      this.bytes,
      JSON.stringify(this.byType),
      this.upgrades,
      this.reads,
      this.rowsReadStored,
      Math.round(this.playerMs),
      this.peakSeated,
      this.peakQueued,
      this.waits,
      this.waitMs,
      this.relay.reports,
      this.relay.links,
      this.relay.relayed,
      this.relay.kb,
    );
    this.dirty = false;
    this.flushedAt = now;
  }

  /** Adds the seated time up to `to`, within the current day. */
  private integrate(to: number): void {
    const until = Math.min(to, this.dayEnd);
    if (until > this.seatedAt) {
      this.playerMs += this.seatedNow * (until - this.seatedAt);
      this.seatedAt = until;
    }
  }

  private count(now: number, ticks: number, messages: number): void {
    this.ticks += ticks;
    this.messages += messages;
    this.dirty = true;
    if (now - this.flushedAt >= FLUSH_EVERY_MS) this.flush(now);
  }

  /** Moves to the day of `now`: the finished day's row is written, the new day's row (if the object was evicted) is picked up. */
  private touch(now: number): void {
    if (now >= this.dayStart && now < this.dayEnd) return;
    const first = this.day === '';
    if (!first) {
      // The seated time of the finished day ends at midnight.
      this.integrate(this.dayEnd);
      const written = this.writes() - this.rowsSeen;
      const read = this.readTotal() - this.readsSeen;
      if (this.dirty || written !== 0 || read !== 0) this.writeRow(now, written, read);
    }
    this.dayStart = dayStartOf(now);
    this.dayEnd = this.dayStart + DAY_MS;
    const day = new Date(this.dayStart).toISOString().slice(0, 10);
    this.day = day;
    const [stored] = this.sql
      .exec<UsageRow>(`SELECT ${COLUMNS} FROM usage WHERE day = ?`, day)
      .toArray();
    const loaded = stored ? dayOfRow(stored) : emptyDay(day);
    this.ticks = loaded.requests * MESSAGES_PER_REQUEST;
    this.messages = loaded.messages;
    this.byType = loaded.byType;
    this.upgrades = loaded.upgrades;
    this.reads = loaded.reads;
    this.rows = loaded.rowsWritten;
    this.rowsReadStored = loaded.rowsRead;
    this.bytes = loaded.dbBytes;
    this.playerMs = loaded.playerMs;
    this.peakSeated = Math.max(loaded.peakSeated, this.seatedNow);
    this.peakQueued = Math.max(loaded.peakQueued, this.queuedNow);
    this.waits = loaded.waits;
    this.waitMs = loaded.waitMs;
    this.relay = loaded.relay;
    // Seated sessions carry over midnight; an object that just woke starts counting now.
    this.seatedAt = first ? now : this.dayStart;
    this.rowsSeen = this.writes();
    this.readsSeen = this.readTotal();
    this.dirty = false;
    this.flushedAt = now;
  }
}
