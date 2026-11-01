export interface PondRow extends Record<string, SqlStorageValue> {
  id: string;
  seed: string;
  epoch: number;
  cx: number;
  cy: number;
  created: number;
}

/** A migration that needs a value from the moment it runs (the reset time). */
type Step = string | ((sql: SqlStorage, now: number) => void);

/** Append-only; entry `i` is migration `i + 1`. */
const MIGRATIONS: Step[] = [
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
  // A player's finished lives, newest first (the history list).
  `CREATE INDEX creatures_dead ON creatures (owner, died_t) WHERE status = 'dead'`,
  // Mating (ADR 0021): two more statuses, which needs a rebuild (SQLite cannot alter a CHECK), the
  // lineage columns, at most one pending creature per player, and the matings awaiting their round.
  `CREATE TABLE creatures_v5 (
    id TEXT PRIMARY KEY,
    owner TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('active', 'pending', 'checkpoint', 'dead')),
    seq INTEGER NOT NULL,
    hash TEXT NOT NULL,
    genome TEXT NOT NULL,
    active_ms INTEGER NOT NULL,
    biomass INTEGER NOT NULL,
    energy INTEGER NOT NULL,
    health INTEGER NOT NULL,
    born_t INTEGER NOT NULL,
    died_t INTEGER,
    generation INTEGER NOT NULL DEFAULT 0,
    parent_a TEXT,
    parent_b TEXT,
    chain_parent TEXT,
    cooldown_until_ms INTEGER NOT NULL DEFAULT 0
  ) WITHOUT ROWID;
  INSERT INTO creatures_v5
    (id, owner, status, seq, hash, genome, active_ms, biomass, energy, health, born_t, died_t)
    SELECT id, owner, status, seq, hash, genome, active_ms, biomass, energy, health, born_t, died_t
    FROM creatures;
  DROP TABLE creatures;
  ALTER TABLE creatures_v5 RENAME TO creatures;
  CREATE UNIQUE INDEX creatures_one_active ON creatures (owner) WHERE status = 'active';
  CREATE UNIQUE INDEX creatures_one_pending ON creatures (owner) WHERE status = 'pending';
  CREATE INDEX creatures_dead ON creatures (owner, died_t) WHERE status = 'dead';
  CREATE TABLE matings (
    commit_id TEXT PRIMARY KEY,
    owner_a TEXT NOT NULL,
    owner_b TEXT NOT NULL,
    creature_a TEXT NOT NULL,
    creature_b TEXT NOT NULL,
    round INTEGER NOT NULL,
    t INTEGER NOT NULL,
    resolved INTEGER NOT NULL DEFAULT 0,
    child_a TEXT,
    child_b TEXT
  ) WITHOUT ROWID;
  CREATE INDEX matings_open ON matings (round) WHERE resolved = 0`,
  // The world renewal of v0.7.2 (ADR 0040): rules 8 retires every older version, so the world starts
  // again. Identities, keys, usage, flags, beacons and ponds stay; what pointed at the deleted rows
  // (a pending commitment) is cleared and every hatch bucket refilled. `world` holds the epoch and
  // when it began, and `epoch_seen` the last epoch each player was told about.
  (sql, now) => {
    sql.exec(`DELETE FROM creatures;
      DELETE FROM records;
      DELETE FROM commitments;
      DELETE FROM matings;
      DELETE FROM genesis_log;
      UPDATE players SET pending = '', hatches = 3, hatch_t = 0;
      ALTER TABLE players ADD COLUMN epoch_seen INTEGER NOT NULL DEFAULT 0;
      CREATE TABLE world (epoch INTEGER NOT NULL, reset_at INTEGER NOT NULL)`);
    sql.exec('INSERT INTO world (epoch, reset_at) VALUES (2, ?)', now);
  },
];

/**
 * Applies pending migrations (up to `upTo`, for tests of an old database), recorded in `migrations`
 * (`PRAGMA user_version` is not permitted in a Durable Object). The caller runs it in one
 * transaction (`Authority`), so a migration and its version row land together or not at all.
 */
export function migrate(
  sql: SqlStorage,
  upTo: number = MIGRATIONS.length,
  now: number = Date.now(),
): void {
  sql.exec('CREATE TABLE IF NOT EXISTS migrations (version INTEGER PRIMARY KEY)');
  const applied = sql
    .exec<{ v: number }>('SELECT COALESCE(MAX(version), 0) AS v FROM migrations')
    .one().v;
  MIGRATIONS.slice(applied, upTo).forEach((step, i) => {
    if (typeof step === 'string') sql.exec(step);
    else step(sql, now);
    sql.exec('INSERT INTO migrations (version) VALUES (?)', applied + i + 1);
  });
}
