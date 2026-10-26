export interface PondRow extends Record<string, SqlStorageValue> {
  id: string;
  seed: string;
  epoch: number;
  cx: number;
  cy: number;
  created: number;
}

/** Append-only; entry `i` is migration `i + 1`. */
const MIGRATIONS = [
  `CREATE TABLE ponds (
    id TEXT PRIMARY KEY,
    seed TEXT NOT NULL,
    epoch INTEGER NOT NULL,
    cx REAL NOT NULL,
    cy REAL NOT NULL,
    created INTEGER NOT NULL
  )`,
  // The ledger (ADR 0019): one head row per creature, an append-only record chain, and the tables
  // the beacon service, the usage meter and the flag log fill in later tasks.
  `CREATE TABLE players (
    id TEXT PRIMARY KEY,
    first_seen INTEGER NOT NULL,
    last_seen INTEGER NOT NULL
  ) WITHOUT ROWID;
  CREATE TABLE creatures (
    id TEXT PRIMARY KEY,
    owner TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('active', 'dead')),
    seq INTEGER NOT NULL,
    hash TEXT NOT NULL,
    genome TEXT NOT NULL,
    active_ms INTEGER NOT NULL,
    biomass INTEGER NOT NULL,
    energy INTEGER NOT NULL,
    health INTEGER NOT NULL,
    born_t INTEGER NOT NULL,
    died_t INTEGER
  ) WITHOUT ROWID;
  CREATE UNIQUE INDEX creatures_one_active ON creatures (owner) WHERE status = 'active';
  CREATE TABLE records (
    creature TEXT NOT NULL,
    seq INTEGER NOT NULL,
    hash TEXT NOT NULL,
    req TEXT NOT NULL,
    kind TEXT NOT NULL,
    owner TEXT NOT NULL,
    t INTEGER NOT NULL,
    json TEXT NOT NULL,
    owner_sig TEXT,
    auth_sig TEXT NOT NULL,
    key_id TEXT NOT NULL,
    PRIMARY KEY (creature, seq)
  ) WITHOUT ROWID;
  CREATE TABLE commitments (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    owner TEXT NOT NULL,
    round INTEGER NOT NULL,
    req TEXT NOT NULL UNIQUE,
    json TEXT NOT NULL,
    auth_sig TEXT NOT NULL,
    key_id TEXT NOT NULL,
    created INTEGER NOT NULL,
    resolved INTEGER
  ) WITHOUT ROWID;
  CREATE TABLE beacons (
    round INTEGER PRIMARY KEY,
    signature TEXT NOT NULL
  );
  CREATE TABLE keys (
    id TEXT PRIMARY KEY,
    public_key TEXT NOT NULL,
    secret BLOB NOT NULL,
    from_t INTEGER NOT NULL
  ) WITHOUT ROWID;
  CREATE TABLE usage (
    day TEXT PRIMARY KEY,
    requests INTEGER NOT NULL,
    messages INTEGER NOT NULL,
    rows_written INTEGER NOT NULL
  ) WITHOUT ROWID;
  CREATE TABLE flags (
    id INTEGER PRIMARY KEY,
    kind TEXT NOT NULL,
    owner TEXT NOT NULL,
    creature TEXT NOT NULL,
    hash TEXT NOT NULL,
    t INTEGER NOT NULL
  );
  CREATE TABLE genesis_log (
    req TEXT PRIMARY KEY,
    creature TEXT NOT NULL,
    owner TEXT NOT NULL,
    t INTEGER NOT NULL
  ) WITHOUT ROWID`,
  // The genesis bucket (ADR 0019): hatches left, when the count was last reconciled, and the
  // commitment the player's next genesis is waiting on.
  `ALTER TABLE players ADD COLUMN hatches INTEGER NOT NULL DEFAULT 3;
  ALTER TABLE players ADD COLUMN hatch_t INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE players ADD COLUMN pending TEXT NOT NULL DEFAULT ''`,
];

/** Applies pending migrations, recorded in `migrations` (`PRAGMA user_version` is not permitted in a Durable Object). */
export function migrate(sql: SqlStorage): void {
  sql.exec('CREATE TABLE IF NOT EXISTS migrations (version INTEGER PRIMARY KEY)');
  const applied = sql
    .exec<{ v: number }>('SELECT COALESCE(MAX(version), 0) AS v FROM migrations')
    .one().v;
  MIGRATIONS.slice(applied).forEach((statement, i) => {
    sql.exec(statement);
    sql.exec('INSERT INTO migrations (version) VALUES (?)', applied + i + 1);
  });
}
