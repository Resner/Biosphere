import type { KeyStore } from './identity';

// Browser only: kept apart from `identity.ts` so the Worker bundle and its types stay DOM-free.

const DB_NAME = 'biosphere-identity';
const STORE = 'keys';
const SEED_KEY = 'seed';

/** The seed in IndexedDB, bound to the site's origin. */
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
        const request = op(db.transaction(STORE, mode).objectStore(STORE));
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
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
