import { afterEach, describe, expect, it, vi } from 'vitest';
import { indexedDbKeyStore } from './idb-keystore';

// A stand-in for IndexedDB that holds each transaction open until the test commits it, so the store
// shows whether a write resolves on its request's success or on its transaction's commit.

interface FakeTx {
  options: unknown;
  oncomplete: (() => void) | null;
  onerror: (() => void) | null;
  onabort: (() => void) | null;
  error: Error | null;
}

function fakeIndexedDb() {
  const data = new Map<string, unknown>();
  const transactions: FakeTx[] = [];
  const request = <T>(value: () => T) => {
    const req = { result: undefined as T | undefined, onsuccess: null as (() => void) | null };
    queueMicrotask(() => {
      req.result = value();
      req.onsuccess?.();
    });
    return req;
  };
  const db = {
    close: () => {},
    createObjectStore: () => {},
    transaction: (_store: string, _mode: string, options?: unknown) => {
      const tx: FakeTx = { options, oncomplete: null, onerror: null, onabort: null, error: null };
      transactions.push(tx);
      return {
        set oncomplete(fn: () => void) {
          tx.oncomplete = fn;
        },
        set onerror(fn: () => void) {
          tx.onerror = fn;
        },
        set onabort(fn: () => void) {
          tx.onabort = fn;
        },
        get error() {
          return tx.error;
        },
        objectStore: () => ({
          get: (key: string) => request(() => data.get(key)),
          put: (value: unknown, key: string) => request(() => data.set(key, value)),
        }),
      };
    },
  };
  const indexedDB = {
    open: () => {
      const req = {
        result: db,
        onsuccess: null as (() => void) | null,
        onupgradeneeded: null as (() => void) | null,
      };
      queueMicrotask(() => req.onsuccess?.());
      return req;
    },
  };
  return { indexedDB, transactions, data };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('the IndexedDB key store (ADR 0076)', () => {
  it('resolves a save only once its transaction has committed, asking for a strict flush', async () => {
    const fake = fakeIndexedDb();
    vi.stubGlobal('indexedDB', fake.indexedDB);
    const store = indexedDbKeyStore();
    let saved = false;
    const seed = new Uint8Array([1, 2, 3]);
    const done = store.save(seed).then(() => {
      saved = true;
    });
    await settle();
    // The put succeeded, but the transaction has not committed: the save is not done.
    expect(fake.data.get('seed')).toBe(seed);
    expect(saved).toBe(false);
    const [tx] = fake.transactions;
    expect(tx?.options).toEqual({ durability: 'strict' });
    tx?.oncomplete?.();
    await done;
    expect(saved).toBe(true);
  });

  it('fails a save whose transaction aborts', async () => {
    const fake = fakeIndexedDb();
    vi.stubGlobal('indexedDB', fake.indexedDB);
    const done = indexedDbKeyStore().save(new Uint8Array([9]));
    await settle();
    const [tx] = fake.transactions;
    if (tx) tx.error = new Error('quota');
    tx?.onabort?.();
    await expect(done).rejects.toThrow('quota');
  });

  it('reads the seed back once the read has completed', async () => {
    const fake = fakeIndexedDb();
    vi.stubGlobal('indexedDB', fake.indexedDB);
    const seed = new Uint8Array([4, 5]);
    fake.data.set('seed', seed);
    const loaded = indexedDbKeyStore().load();
    await settle();
    fake.transactions[0]?.oncomplete?.();
    expect(await loaded).toBe(seed);
  });
});
