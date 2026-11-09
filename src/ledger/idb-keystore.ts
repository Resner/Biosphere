import type { KeyStore } from './identity';

// Browser only: kept apart from `identity.ts` so the Worker bundle and its types stay DOM-free.

const DB_NAME = 'biosphere-identity';
const STORE = 'keys';
const SEED_KEY = 'seed';

/**
 * The seed in IndexedDB, bound to the site's origin. A write resolves only once its transaction has
 * committed, flushed to disk where the engine offers `durability: 'strict'` (ADR 0076): a tab killed
 * after a recovery import says done comes back with the imported identity.
 */
export function indexedDbKeyStore(): KeyStore {
  const open = () =>
    new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, 1);
      request.onupgradeneeded = () => request.result.createObjectStore(STORE);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  const run = async <T>(mode: IDBTransactionMode, op: (s: IDBObjectStore) => IDBRequest<T>) => {
    const db = await open();
    try {
      return await new Promise<T>((resolve, reject) => {
        // An engine that doesn't know the option ignores it.
        const tx = db.transaction(STORE, mode, { durability: 'strict' });
        const request = op(tx.objectStore(STORE));
        tx.oncomplete = () => resolve(request.result);
        tx.onerror = () => reject(tx.error ?? request.error);
        tx.onabort = () => reject(tx.error ?? new Error('aborted'));
      });
    } finally {
      db.close();
    }
  };
  return {
    load: async () => {
      const value = await run('readonly', (s) => s.get(SEED_KEY));
      return value instanceof Uint8Array ? value : null;
    },
    save: async (seed) => {
      await run('readwrite', (s) => s.put(seed, SEED_KEY));
    },
  };
}
