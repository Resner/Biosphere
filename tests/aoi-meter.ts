// What the load simulation measures beyond the gates (M13 T5): the hub's operations timed in Node,
// messages by type, link setups, bandwidth per client and the heap the directory holds. The harness
// (`tests/aoi-harness.ts`) calls it only when a scenario carries a `Meter`; the numbers are timings
// and counts, never part of a gate's verdict except the counts the load gates read.

/** Incoming authority messages by type. `gone` is a socket closing: counted, but not a budget message. */
export const MSG_TYPES = [
  'where',
  'whereCrowd',
  'spawn',
  'ride',
  'gone',
  'offer',
  'answer',
  'refuse',
  'resend',
] as const;
export type MsgType = (typeof MSG_TYPES)[number];

/** The hub's operations the load scenario times. */
export const OPS = ['where', 'place', 'signal', 'split', 'pool'] as const;
export type Op = (typeof OPS)[number];

export class Meter {
  readonly msgs = Object.fromEntries(MSG_TYPES.map((t) => [t, 0])) as Record<MsgType, number>;
  readonly ops = Object.fromEntries(OPS.map((o) => [o, [] as number[]])) as Record<Op, number[]>;
  /** Link setups (hellos, counted once per pair) and those an offer through a peer set up. */
  setups = 0;
  setupsRelayed = 0;
  /** Bytes a client uploaded and downloaded per second, summed over client-ticks (and their count). */
  upSum = 0;
  downSum = 0;
  rateSamples = 0;
  upMax = 0;
  downMax = 0;
  /** Heap held by a directory of the peak's members (bytes) and the members it held, or null. */
  heapBytes: number | null = null;
  heapMembers = 0;

  time<T>(op: Op, fn: () => T): T {
    const t0 = performance.now();
    try {
      return fn();
    } finally {
      this.ops[op].push(performance.now() - t0);
    }
  }

  rate(upBps: number, downBps: number): void {
    this.upSum += upBps;
    this.downSum += downBps;
    this.rateSamples++;
    this.upMax = Math.max(this.upMax, upBps);
    this.downMax = Math.max(this.downMax, downBps);
  }
}

/** A binary min-heap of the harness's events: ordered by time, then by the order they were added. */
export class EventQueue<T extends { t: number; seq: number }> {
  private readonly a: T[] = [];
  get size(): number {
    return this.a.length;
  }
  peek(): T | undefined {
    return this.a[0];
  }
  push(e: T): void {
    const a = this.a;
    let i = a.length;
    a.push(e);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!before(e, a[p] as T)) break;
      a[i] = a[p] as T;
      i = p;
    }
    a[i] = e;
  }
  pop(): T | undefined {
    const a = this.a;
    const top = a[0];
    const last = a.pop();
    if (top === undefined || last === undefined) return top;
    if (a.length === 0) return top;
    let i = 0;
    for (;;) {
      let c = 2 * i + 1;
      if (c >= a.length) break;
      if (c + 1 < a.length && before(a[c + 1] as T, a[c] as T)) c++;
      if (!before(a[c] as T, last)) break;
      a[i] = a[c] as T;
      i = c;
    }
    a[i] = last;
    return top;
  }
}

function before(x: { t: number; seq: number }, y: { t: number; seq: number }): boolean {
  return x.t < y.t || (x.t === y.t && x.seq < y.seq);
}
