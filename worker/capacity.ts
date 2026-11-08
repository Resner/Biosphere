// The capacity model (M13 T8, ADR 0067 and the capacity ADR): pure arithmetic from the measured
// per-player numbers (`MEASURED` in `plan.ts`) to what a population costs, what one authority
// object serves and what each plan allows. `plan.ts` derives its allowances and session caps from
// it, and `tools/capacity-report.ts` writes `docs/CAPACITY.md` from the same functions. No Hub,
// no I/O: tests and the report run it in Node.

/** The cost tables the derivation reads (`plan.ts` holds the dated values). */
export interface Tables {
  prices: {
    base: number;
    requestsPerM: number;
    gbSecondsPerM: number;
    rowsWrittenPerM: number;
    rowsReadPerM: number;
    storageGbMonth: number;
    turnGb: number;
    workerRequestsPerM: number;
  };
  included: {
    requests: number;
    gbSeconds: number;
    rowsWritten: number;
    rowsRead: number;
    storageGbMonth: number;
    turnGb: number;
    workerRequests: number;
  };
  /** The free plan's daily limits and the monthly TURN allowance. */
  free: {
    requestsPerDay: number;
    rowsWrittenPerDay: number;
    rowsReadPerDay: number;
    gbSecondsPerDay: number;
    workerRequestsPerDay: number;
    turnGbPerMonth: number;
    storageBytes: number;
  };
  ceilingUsd: number;
}

/** Incoming messages per player-minute that pages send, by type, in the hold of the hub load (T7). */
export interface PageCadence {
  where: number;
  progress: number;
  ping: number;
  signal: number;
  avail: number;
  total: number;
}

/** Every per-player number the model multiplies. `MEASURED` in `plan.ts` holds the committed values. */
export interface Measured {
  /** World messages per player-minute in the load simulation's hold, `gone` excluded (T5). */
  world: number;
  page: PageCadence;
  /** The authority's incoming messages for a duel of `frames` frames, refereed alone and with a witness (T10 model). */
  fight: { frames: number; alone: number; witnessed: number };
  /** Rows a session writes and reads between joining and leaving (T7). */
  session: { rowsWritten: number; rowsRead: number };
  /** Rows a fight writes and reads (the log's batches, its records, its commitment and attestation). */
  fightRows: { written: number; read: number };
  /** The local runtime's CPU per incoming message, ms, before the production factor (T7). */
  cpuMsPerMessage: number;
  /** What a client receives, KB/s (T5). */
  clientKBps: number;
  /** What the hub holds for a seated session: its attachment and its directory entry, bytes (T6, T5). */
  memoryBytesPerSession: number;
  /** Stored column bytes (storage report): an hour of play, a hatch, what a fight keeps for good, what it keeps for the window. */
  bytes: { hour: number; hatch: number; settled: number; logged: number };
}

export interface Assumptions {
  /** Fights each player is in per hour (ADR 0056). */
  fightsPerHour: number;
  /** The share of fights a witness referees. */
  witnessShare: number;
  /** The share of a client's traffic that runs over a TURN relay. */
  relayShare: number;
  /** The mean session, minutes. */
  sessionMinutes: number;
  /** Public reads (a proof, an audit, a card) per session. */
  readsPerSession: number;
  /** Dollars per euro, at the worst. */
  usdPerEur: number;
  /** Minutes of active play between checkpoints (`worker/progress.ts`). */
  checkpointMinutes: number;
  /** The days fight logs and witness commitments are kept (`LOG_KEEP_DAYS`). */
  keepDays: number;
}

export const ASSUMPTIONS: Assumptions = {
  fightsPerHour: 3,
  witnessShare: 0.5,
  relayShare: 0.15,
  sessionMinutes: 30,
  readsPerSession: 2,
  usdPerEur: 0.95,
  checkpointMinutes: 15,
  keepDays: 14,
};

/** The production factor on the local runtime's CPU per message (ADR 0067). */
export const CPU_FACTOR = 2;
/** One object serves a population while its CPU stays under this share of a core, ... */
export const CORE_SHARE_MAX = 0.5;
/** ... its incoming messages a second under this, ... */
export const MESSAGES_PER_SECOND_MAX = 1000;
/** ... and the state it holds under this many bytes. */
export const MEMORY_MAX_BYTES = 64 * 1024 * 1024;
/** The object's memory limit, the basis of the duration bill, in GB. */
export const OBJECT_GB = 0.128;
/** The share of one object's capacity admission fills (ADR 0067). */
export const CAP_SHARE = 0.8;
/** The days in a month the paid plan bills. */
export const MONTH_DAYS = 30;
/** Seconds in a day. */
export const SECONDS_PER_DAY = 86_400;

/** Decimal units, as Cloudflare bills: 1 KB is 1,000 bytes. */
export const GB = 1e9;

/** The authority's messages in a fight, averaged over refereed alone and witnessed. */
export const fightMessages = (m: Measured, a: Assumptions): number =>
  a.witnessShare * m.fight.witnessed + (1 - a.witnessShare) * m.fight.alone;

/** What one player costs per hour of play. */
export interface Rates {
  messagesPerMinuteOutside: number;
  messagesPerHour: number;
  sessionsPerHour: number;
  requestsPerHour: number;
  rowsWrittenPerHour: number;
  rowsReadPerHour: number;
  workerRequestsPerHour: number;
  turnGbPerHour: number;
  /** Bytes kept for good per hour of play. */
  permanentBytesPerHour: number;
  /** Bytes kept for the log window per hour of play. */
  loggedBytesPerHour: number;
  /** Fights a player is in per hour (each fight has two sides, so a fight is half a player's). */
  fightsPerHour: number;
}

export function ratesOf(
  m: Measured,
  a: Assumptions = ASSUMPTIONS,
  over: Partial<Rates> = {},
): Rates {
  const sessionsPerHour = 60 / a.sessionMinutes;
  const outside = m.world + m.page.progress + m.page.ping + m.page.avail;
  // A fight has two sides: each player carries half of its messages, rows and bytes.
  const sides = a.fightsPerHour / 2;
  const messagesPerHour = outside * 60 + sides * fightMessages(m, a);
  const rates: Rates = {
    messagesPerMinuteOutside: outside,
    messagesPerHour,
    sessionsPerHour,
    requestsPerHour: messagesPerHour / 20 + sessionsPerHour * (1 + a.readsPerSession),
    rowsWrittenPerHour:
      sessionsPerHour * m.session.rowsWritten +
      60 / a.checkpointMinutes +
      sides * m.fightRows.written,
    rowsReadPerHour: sessionsPerHour * m.session.rowsRead + sides * m.fightRows.read,
    workerRequestsPerHour: sessionsPerHour * (1 + a.readsPerSession),
    turnGbPerHour: turnGb(1, m.clientKBps * a.relayShare, 1 / 24),
    permanentBytesPerHour: m.bytes.hour + sides * m.bytes.settled,
    loggedBytesPerHour: sides * m.bytes.logged,
    fightsPerHour: a.fightsPerHour,
  };
  return { ...rates, ...over };
}

/** TURN traffic in GB: `players` each receiving `kbps` KB/s over a relay for `days` days. */
export const turnGb = (players: number, kbps: number, days: number): number =>
  (players * kbps * 1000 * SECONDS_PER_DAY * days) / GB;

/** Messages a second that `players` around the clock send. */
export const messagesPerSecond = (r: Rates, players: number): number =>
  (players * r.messagesPerHour) / 3600;

/** Request-equivalents a day: 1 per 20 messages, plus upgrades and public reads. */
export const requestsPerDay = (r: Rates, players: number): number =>
  players * r.requestsPerHour * 24;

/** The share of one core `players` use on one object (CPU doubled for production). */
export const coreShare = (m: Measured, r: Rates, players: number): number =>
  (messagesPerSecond(r, players) * m.cpuMsPerMessage * CPU_FACTOR) / 1000;

/** What bounds one object, and the largest population it serves. */
export interface ObjectCapacity {
  byCpu: number;
  byMessages: number;
  byMemory: number;
  players: number;
  binding: 'cpu' | 'messages' | 'memory';
}

export function objectCapacity(
  m: Measured,
  a: Assumptions = ASSUMPTIONS,
  over: Partial<Rates> = {},
): ObjectCapacity {
  const r = ratesOf(m, a, over);
  const perPlayerPerSecond = r.messagesPerHour / 3600;
  const byCpu = Math.floor(
    (CORE_SHARE_MAX * 1000) / (perPlayerPerSecond * m.cpuMsPerMessage * CPU_FACTOR),
  );
  const byMessages = Math.floor(MESSAGES_PER_SECOND_MAX / perPlayerPerSecond);
  const byMemory = Math.floor(MEMORY_MAX_BYTES / m.memoryBytesPerSession);
  const players = Math.min(byCpu, byMessages, byMemory);
  const binding = players === byCpu ? 'cpu' : players === byMessages ? 'messages' : 'memory';
  return { byCpu, byMessages, byMemory, players, binding };
}

/** 80% of what one object serves: the cap admission may fill. */
export const capOf = (capacity: ObjectCapacity): number => Math.floor(CAP_SHARE * capacity.players);

/** The objects that serve `players` at the admission cap (sharding, if it were built). */
export const objectsFor = (capacity: ObjectCapacity, players: number): number =>
  Math.max(1, Math.ceil(players / capOf(capacity)));

/** One population's usage: daily figures and the month's. */
export interface Usage {
  players: number;
  objects: number;
  messagesPerSecond: number;
  requestsPerDay: number;
  rowsWrittenPerDay: number;
  rowsReadPerDay: number;
  gbSecondsPerDay: number;
  workerRequestsPerDay: number;
  turnGbPerMonth: number;
  /** Bytes the history grows by a day. */
  permanentBytesPerDay: number;
  /** The log window's steady state. */
  loggedBytesSteady: number;
  coreShare: number;
  memoryBytes: number;
}

/** `players` concurrent around the clock, one object awake all day per shard. */
export function usageOf(
  m: Measured,
  players: number,
  a: Assumptions = ASSUMPTIONS,
  over: Partial<Rates> = {},
  capacity: ObjectCapacity = objectCapacity(m, a, over),
): Usage {
  const r = ratesOf(m, a, over);
  const objects = objectsFor(capacity, players);
  return {
    players,
    objects,
    messagesPerSecond: messagesPerSecond(r, players),
    requestsPerDay: requestsPerDay(r, players),
    rowsWrittenPerDay: players * r.rowsWrittenPerHour * 24,
    rowsReadPerDay: players * r.rowsReadPerHour * 24,
    gbSecondsPerDay: players > 0 ? objects * OBJECT_GB * SECONDS_PER_DAY : 0,
    workerRequestsPerDay: players * r.workerRequestsPerHour * 24,
    turnGbPerMonth: players * r.turnGbPerHour * 24 * MONTH_DAYS,
    permanentBytesPerDay: players * r.permanentBytesPerHour * 24,
    loggedBytesSteady: players * r.loggedBytesPerHour * 24 * a.keepDays,
    coreShare: coreShare(m, r, players) / objects,
    memoryBytes: Math.ceil((players * m.memoryBytesPerSession) / objects),
  };
}

/** The paid month's bill by item, in dollars. */
export interface Bill {
  base: number;
  requests: number;
  gbSeconds: number;
  rowsWritten: number;
  rowsRead: number;
  storage: number;
  turn: number;
  workerRequests: number;
  total: number;
}

const excess = (used: number, included: number) => Math.max(0, used - included);

/** The paid month for a usage: `monthStorageBytes` is the database at the month's end. */
export function billOf(u: Usage, t: Tables, monthStorageBytes: number): Bill {
  const month = MONTH_DAYS;
  const items = {
    base: t.prices.base,
    requests: (excess(u.requestsPerDay * month, t.included.requests) / 1e6) * t.prices.requestsPerM,
    gbSeconds:
      (excess(u.gbSecondsPerDay * month, t.included.gbSeconds) / 1e6) * t.prices.gbSecondsPerM,
    rowsWritten:
      (excess(u.rowsWrittenPerDay * month, t.included.rowsWritten) / 1e6) *
      t.prices.rowsWrittenPerM,
    rowsRead: (excess(u.rowsReadPerDay * month, t.included.rowsRead) / 1e6) * t.prices.rowsReadPerM,
    storage: excess(monthStorageBytes / GB, t.included.storageGbMonth) * t.prices.storageGbMonth,
    turn: excess(u.turnGbPerMonth, t.included.turnGb) * t.prices.turnGb,
    workerRequests:
      (excess(u.workerRequestsPerDay * month, t.included.workerRequests) / 1e6) *
      t.prices.workerRequestsPerM,
  };
  const total = Object.values(items).reduce((s, n) => s + n, 0);
  return { ...items, total };
}

/** The database a month in: the log window's steady state plus a month of history. */
export const monthStorage = (u: Usage): number =>
  u.loggedBytesSteady + u.permanentBytesPerDay * MONTH_DAYS;

/** The paid month's total for `players`, with the daily allowances taken as spent. */
export function paidMonthUsd(m: Measured, t: Tables, players: number, a = ASSUMPTIONS): number {
  const u = usageOf(m, players, a);
  return billOf(u, t, monthStorage(u)).total;
}

/** The first limit of the free plan that `u` passes, or null; and the hours of a day it serves. */
export interface FreeVerdict {
  within: boolean;
  /** The meter that runs out first, and the share of a day (in hours) it lasts. */
  first: string | null;
  hours: number;
}

export function freeVerdict(u: Usage, t: Tables): FreeVerdict {
  const daily: [string, number, number][] = [
    ['requests', u.requestsPerDay, t.free.requestsPerDay],
    ['rows written', u.rowsWrittenPerDay, t.free.rowsWrittenPerDay],
    ['rows read', u.rowsReadPerDay, t.free.rowsReadPerDay],
    ['duration', u.gbSecondsPerDay, t.free.gbSecondsPerDay],
    ['worker requests', u.workerRequestsPerDay, t.free.workerRequestsPerDay],
    ['TURN', (u.turnGbPerMonth / MONTH_DAYS) * 1, t.free.turnGbPerMonth / MONTH_DAYS],
  ];
  let first: string | null = null;
  let hours = 24;
  for (const [name, used, allowed] of daily) {
    if (used <= 0) continue;
    const h = (24 * allowed) / used;
    if (h < hours) {
      hours = h;
      first = name;
    }
  }
  return { within: first === null, first, hours: Math.min(24, hours) };
}

/** What the free plan serves: the player-hours of a day, and the players around the clock. */
export function freeServes(m: Measured, t: Tables, a = ASSUMPTIONS) {
  const r = ratesOf(m, a);
  const capacity = objectCapacity(m, a);
  const meters: [string, number, number][] = [
    ['requests', t.free.requestsPerDay, r.requestsPerHour],
    ['rows written', t.free.rowsWrittenPerDay, r.rowsWrittenPerHour],
    ['rows read', t.free.rowsReadPerDay, r.rowsReadPerHour],
    ['worker requests', t.free.workerRequestsPerDay, r.workerRequestsPerHour],
  ];
  let playerHours = Infinity;
  let binding = '';
  for (const [name, allowed, perHour] of meters) {
    if (allowed / perHour < playerHours) {
      playerHours = allowed / perHour;
      binding = name;
    }
  }
  playerHours = Math.floor(playerHours);
  const around = Math.floor(playerHours / 24);
  return { playerHours, around, binding, objectCap: capOf(capacity), capacity };
}

/** The most concurrent players, around the clock, the paid plan serves within the ceiling. */
export function paidPlayers(m: Measured, t: Tables, a = ASSUMPTIONS): number {
  let low = 0;
  let high = 100_000;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (paidMonthUsd(m, t, mid, a) <= t.ceilingUsd) low = mid;
    else high = mid - 1;
  }
  return low;
}

/** The daily allowances a plan spends; admission's budget guard takes 90% of them. */
export interface Allowances {
  requestsPerDay: number;
  rowsWrittenPerDay: number;
  rowsReadPerDay: number;
}

export interface Derived {
  capacity: ObjectCapacity;
  free: Allowances & { sessions: number; around: number; playerHours: number };
  paid: Allowances & { sessions: number; around: number };
}

/** The one derivation `plan.ts` and the report share. */
export function derive(m: Measured, t: Tables, a: Assumptions = ASSUMPTIONS): Derived {
  const capacity = objectCapacity(m, a);
  const cap = capOf(capacity);
  const free = freeServes(m, t, a);
  const around = paidPlayers(m, t, a);
  const u = usageOf(m, around, a, {}, capacity);
  // The paid month is spent in equal daily allowances: each meter's included amount a day, or what
  // the affordable population uses if that is more (it then pays the overage, within the ceiling).
  const day = (included: number, used: number) =>
    Math.max(Math.floor(included / MONTH_DAYS), Math.floor(used));
  return {
    capacity,
    free: {
      requestsPerDay: t.free.requestsPerDay,
      rowsWrittenPerDay: t.free.rowsWrittenPerDay,
      rowsReadPerDay: t.free.rowsReadPerDay,
      sessions: Math.max(1, Math.min(free.around, cap)),
      around: free.around,
      playerHours: free.playerHours,
    },
    paid: {
      requestsPerDay: day(t.included.requests, u.requestsPerDay),
      rowsWrittenPerDay: day(t.included.rowsWritten, u.rowsWrittenPerDay),
      rowsReadPerDay: day(t.included.rowsRead, u.rowsReadPerDay),
      sessions: Math.max(1, Math.min(around, cap)),
      around,
    },
  };
}

/** Days the store lasts under a log window (the plan's store, the plan's full daily allowance in player-hours). */
export function storeDays(
  m: Measured,
  playerHours: number,
  storageBytes: number,
  keepDays: number,
  a: Assumptions = ASSUMPTIONS,
): number {
  const r = ratesOf(m, a);
  const logs = playerHours * r.loggedBytesPerHour * keepDays;
  const perDay = playerHours * r.permanentBytesPerHour;
  return Math.max(0, (storageBytes - logs) / perDay);
}

/** ADR 0067's storage lever: days the free plan's store must last at its full daily allowance. */
export const STORE_DAYS_MIN = 90;

/** The log window: 14 days (ADR 0056), or 7 if the free plan at its full allowance would fill its store sooner than `STORE_DAYS_MIN`. */
export function logWindowDays(m: Measured, t: Tables, a: Assumptions = ASSUMPTIONS): 7 | 14 {
  const { playerHours } = freeServes(m, t, a);
  return storeDays(m, playerHours, t.free.storageBytes, 14, a) >= STORE_DAYS_MIN ? 14 : 7;
}
