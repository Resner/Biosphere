import type { ProofBundle } from '../ledger/proof';
import type { FightLog } from '../ledger/settlement';
import type { LineageReport } from '../ledger/verify';
import type { FromWorker, ToWorker } from './verify-worker';

// The card page's side of its verifier worker (`verify-worker.ts`): each message gets one report
// back. A worker that fails to load, or fails partway, settles whatever the page waits on, so the
// check ends `unchecked` instead of hanging (M10 T16).

/** What the card uses of a `Worker`, so a test can pass a fake. */
export interface VerifierWorker {
  postMessage(message: ToWorker): void;
  terminate(): void;
  addEventListener(type: 'message', listener: (e: { data: FromWorker }) => void): void;
  addEventListener(type: 'error', listener: (e: { message: string }) => void): void;
}

/** One question to the worker at a time; any failure of the worker rejects it, now or later. */
export class VerifierLink {
  private waiting: { resolve: (msg: FromWorker) => void; reject: (e: Error) => void } | null = null;
  private failure: Error | null = null;

  constructor(private readonly worker: VerifierWorker) {
    worker.addEventListener('message', (e) => {
      const w = this.waiting;
      this.waiting = null;
      w?.resolve(e.data);
    });
    // A script that fails to load fires this too, possibly before anything was asked.
    worker.addEventListener('error', (e) => this.broke(new Error(e.message || 'no verifier')));
  }

  /** The worker's answer to `msg`; rejected if the worker has failed or fails before it answers. */
  ask(msg: ToWorker): Promise<FromWorker> {
    if (this.failure) return Promise.reject(this.failure);
    return new Promise((resolve, reject) => {
      this.waiting = { resolve, reject };
      this.worker.postMessage(msg);
    });
  }

  close(): void {
    this.worker.terminate();
  }

  private broke(error: Error): void {
    if (this.failure) return;
    this.failure = error;
    console.error('the verifier did not run', error.message);
    this.close();
    const w = this.waiting;
    this.waiting = null;
    w?.reject(error);
  }
}

/** What the page does as the check goes. */
export interface CheckSteps {
  /** Each report: the whole bundle's, then the one after each fight replayed. */
  report(report: LineageReport): void;
  /** Fight `i` (from 0) of `n` is being fetched and replayed. */
  replaying(i: number, n: number): void;
  /** A fight's log (null: pruned), or undefined when its proof can't be had: it stays unreplayed. */
  log(enc: string): Promise<FightLog | null | undefined>;
}

/**
 * Checks `bundle` in the worker, then replays each fight it names, one by one; `unchecked` when the
 * worker fails at any point. The worker is ended either way.
 */
export async function checkInWorker(
  link: VerifierLink,
  bundle: ProofBundle,
  steps: CheckSteps,
): Promise<'done' | 'unchecked'> {
  const answer = (msg: ToWorker): Promise<FromWorker | null> => link.ask(msg).catch(() => null);
  try {
    const first = await answer({ t: 'verify', bundle });
    if (!first) return 'unchecked';
    steps.report(first.report);
    for (const [i, enc] of first.fights.entries()) {
      steps.replaying(i, first.fights.length);
      const log = await steps.log(enc);
      if (log === undefined) continue;
      const msg = await answer({ t: 'fight', enc, log });
      if (!msg) return 'unchecked';
      steps.report(msg.report);
    }
    return 'done';
  } finally {
    link.close();
  }
}
