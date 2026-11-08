// One wrapper over the object's SQLite handle, which every module uses instead of the raw one
// (M13 T1, ADR 0067): it adds each statement's rows read and rows written to the usage meter,
// whatever the module counts for itself. It changes no answer.

/** Where the counts go: the meter's totals. */
export interface RowCounter {
  written: number;
  read: number;
}

/**
 * A cursor that adds its rows to `counter` as they are read: a statement's rows read grow while
 * it is iterated, so the difference since the last look is added after every call that consumes.
 */
function meteredCursor<T extends Record<string, SqlStorageValue>>(
  cursor: SqlStorageCursor<T>,
  counter: RowCounter,
): SqlStorageCursor<T> {
  let written = 0;
  let read = 0;
  const account = () => {
    counter.written += cursor.rowsWritten - written;
    counter.read += cursor.rowsRead - read;
    written = cursor.rowsWritten;
    read = cursor.rowsRead;
  };
  // A statement that writes has done its work when `exec` returns.
  account();
  const metered: SqlStorageCursor<T> = {
    next() {
      const step = cursor.next();
      account();
      return step;
    },
    toArray() {
      const rows = cursor.toArray();
      account();
      return rows;
    },
    one() {
      try {
        return cursor.one();
      } finally {
        account();
      }
    },
    raw<U extends SqlStorageValue[]>() {
      const inner = cursor.raw<U>();
      const counted: IterableIterator<U> = {
        next() {
          const step = inner.next();
          account();
          return step;
        },
        [Symbol.iterator]() {
          return counted;
        },
      };
      return counted;
    },
    get columnNames() {
      return cursor.columnNames;
    },
    get rowsRead() {
      return cursor.rowsRead;
    },
    get rowsWritten() {
      return cursor.rowsWritten;
    },
    [Symbol.iterator]() {
      return this;
    },
  } as SqlStorageCursor<T>;
  return metered;
}

/** `sql` with every statement counted into `counter`. */
export function meteredSql(sql: SqlStorage, counter: RowCounter): SqlStorage {
  return {
    exec<T extends Record<string, SqlStorageValue>>(query: string, ...bindings: unknown[]) {
      return meteredCursor(sql.exec<T>(query, ...bindings), counter);
    },
    get databaseSize() {
      return sql.databaseSize;
    },
    Cursor: sql.Cursor,
    Statement: sql.Statement,
  } as SqlStorage;
}

/** The storage handle modules take (`Storage` in the ledger, `BeaconsDeps.storage`): the counted `sql` and the object's transactions. */
export function meteredStorage(
  storage: Pick<DurableObjectStorage, 'transactionSync'>,
  sql: SqlStorage,
): { sql: SqlStorage; transactionSync<T>(fn: () => T): T } {
  return { sql, transactionSync: (fn) => storage.transactionSync(fn) };
}
