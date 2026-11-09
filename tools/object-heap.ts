// The authority object's own JS heap, read from workerd's inspector after a forced collection (M14
// T14c). The workerd processes' resident memory is no measure of what the hub keeps: it holds
// wrangler's proxy (a second workerd that forwards every socket), the runtime's native buffers and
// V8's garbage until the next major collection (up to the isolate's 128 MB). Linux and `wrangler
// dev` only: the hub's runtime is found through /proc.

import { readdirSync, readFileSync, readlinkSync } from 'node:fs';
import { workerd } from './load-hub-run';

/** The ports in LISTEN state among `/proc/<pid>/net/tcp`'s rows whose socket the process holds. */
export function listeningPorts(tcp: string, inodes: ReadonlySet<string>): number[] {
  const out: number[] = [];
  for (const line of tcp.split('\n').slice(1)) {
    const cells = line.trim().split(/\s+/);
    const [, local, , state] = cells;
    const inode = cells[9];
    if (state !== '0A' || !local || !inode || !inodes.has(inode)) continue;
    const port = Number.parseInt(local.split(':')[1] ?? '', 16);
    if (Number.isInteger(port)) out.push(port);
  }
  return out;
}

/** The user worker's debugger URL in an inspector's `/json/list` answer, or null. */
export function userTarget(list: unknown): string | null {
  if (!Array.isArray(list)) return null;
  for (const t of list as { id?: unknown; webSocketDebuggerUrl?: unknown }[]) {
    if (
      typeof t?.id === 'string' &&
      t.id.startsWith('core:user:') &&
      typeof t.webSocketDebuggerUrl === 'string'
    )
      return t.webSocketDebuggerUrl;
  }
  return null;
}

function socketInodes(pid: number): Set<string> {
  const out = new Set<string>();
  for (const fd of readdirSync(`/proc/${pid}/fd`)) {
    try {
      const m = /^socket:\[(\d+)\]$/.exec(readlinkSync(`/proc/${pid}/fd/${fd}`));
      if (m?.[1]) out.add(m[1]);
    } catch {
      // closed meanwhile
    }
  }
  return out;
}

/** The debugger URL of the user worker under `root`: the workerd started with an inspector. */
async function findTarget(root: number): Promise<string | null> {
  for (const p of workerd(root)) {
    try {
      if (!readFileSync(`/proc/${p.pid}/cmdline`, 'utf8').includes('--inspector-addr')) continue;
      const tcp = readFileSync(`/proc/${p.pid}/net/tcp`, 'utf8');
      for (const port of listeningPorts(tcp, socketInodes(p.pid))) {
        const list = await fetch(`http://127.0.0.1:${port}/json/list`, {
          signal: AbortSignal.timeout(2_000),
        }).then(
          (r) => (r.ok ? r.json() : null),
          () => null,
        );
        const url = userTarget(list);
        if (url) return url;
      }
    } catch {
      // gone, or not ours to read
    }
  }
  return null;
}

/**
 * One inspector session: a forced collection, then the heap's used size in bytes. The collection runs
 * on the isolate's thread when it next runs something, so `wake` sends it a request; the usage is
 * asked only once the collection has answered (the inspector answers it at once, from its own thread).
 */
function heapAfterGc(url: string, wake: () => void, timeoutMs: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const done = (fn: () => void) => {
      clearTimeout(timer);
      ws.onmessage = null;
      ws.onerror = null;
      ws.close();
      fn();
    };
    const timer = setTimeout(
      () => done(() => reject(new Error('the inspector did not answer'))),
      timeoutMs,
    );
    ws.onopen = () => {
      ws.send(JSON.stringify({ id: 1, method: 'HeapProfiler.collectGarbage' }));
      wake();
    };
    ws.onmessage = (e) => {
      const m = JSON.parse(String(e.data)) as { id?: number; result?: { usedSize?: number } };
      if (m.id === 1) ws.send(JSON.stringify({ id: 2, method: 'Runtime.getHeapUsage' }));
      if (m.id !== 2) return;
      const used = m.result?.usedSize;
      done(() => (typeof used === 'number' ? resolve(used) : reject(new Error('no heap usage'))));
    };
    ws.onerror = () => done(() => reject(new Error('the inspector refused')));
  });
}

/** The authority's live JS heap after a forced collection, minute by minute; null where it can't be read. */
export class ObjectHeap {
  private url: string | null = null;
  /** `root` is the hub's process; `wake` sends the hub any request (its health). */
  constructor(
    private readonly root: number,
    private readonly wake: () => void,
  ) {}

  async now(): Promise<number | null> {
    for (let attempt = 0; attempt < 2; attempt++) {
      this.url ??= await findTarget(this.root);
      if (!this.url) return null;
      try {
        return await heapAfterGc(this.url, this.wake, 30_000);
      } catch {
        // a restarted runtime listens elsewhere: look again once
        this.url = null;
      }
    }
    return null;
  }
}
