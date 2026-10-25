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
