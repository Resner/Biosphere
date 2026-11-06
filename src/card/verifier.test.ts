import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { ProofBundle } from '../ledger/proof';
import type { LineageReport } from '../ledger/verify';
import { type CheckSteps, checkInWorker, VerifierLink, type VerifierWorker } from './verifier';
import type { FromWorker, ToWorker } from './verify-worker';

// M10 T16: the card's side of its verifier worker. A worker that fails to load, or fails partway,
// settles whatever the page waits on, so the check ends `unchecked` instead of hanging.

const BUNDLE = JSON.parse(
  readFileSync(new URL('../ledger/__golden__/lineage.json', import.meta.url), 'utf8'),
) as ProofBundle;
const REPORT = { subject: BUNDLE.subject, problems: [] } as unknown as LineageReport;
const ENC = '1'.repeat(64);

/** A worker the test drives: it answers each message with a report, until it is made to fail. */
class FakeWorker implements VerifierWorker {
  readonly posted: ToWorker[] = [];
  terminated = false;
  /** Answer each message with a report; false leaves it waiting. */
  answers = true;
  /** The fights the first report names. */
  fights: string[] = [];
  private readonly listeners = {
    message: [] as ((e: { data: FromWorker }) => void)[],
    error: [] as ((e: { message: string }) => void)[],
  };

  addEventListener(type: 'message', listener: (e: { data: FromWorker }) => void): void;
  addEventListener(type: 'error', listener: (e: { message: string }) => void): void;
  addEventListener(type: 'message' | 'error', listener: (e: never) => void): void {
    (this.listeners[type] as unknown[]).push(listener);
  }

  postMessage(message: ToWorker): void {
    this.posted.push(message);
    if (!this.answers) return;
    const fights = message.t === 'verify' ? this.fights : [];
    queueMicrotask(() => {
      for (const l of this.listeners.message) l({ data: { t: 'report', report: REPORT, fights } });
    });
  }

  terminate(): void {
    this.terminated = true;
  }

  /** The worker's script failed to load or threw. */
  fail(): void {
    for (const l of this.listeners.error) l({ message: 'failed to load' });
  }
}

const steps = (log: CheckSteps['log'] = async () => null) => {
  const reports: LineageReport[] = [];
  const replaying: [number, number][] = [];
  const s: CheckSteps = {
    report: (r) => reports.push(r),
    replaying: (i, n) => replaying.push([i, n]),
    log,
  };
  return { s, reports, replaying };
};

describe('the card verifier worker', () => {
  it('checks the bundle, then replays each fight, and ends the worker', async () => {
    const w = new FakeWorker();
    w.fights = [ENC, '2'.repeat(64)];
    const { s, reports, replaying } = steps(async (enc) => (enc === ENC ? null : undefined));
    expect(await checkInWorker(new VerifierLink(w), BUNDLE, s)).toBe('done');
    // The second fight's proof could not be had: it is not posted, and stays unreplayed.
    expect(w.posted.map((m) => m.t)).toEqual(['verify', 'fight']);
    expect(reports).toHaveLength(2);
    expect(replaying).toEqual([
      [0, 2],
      [1, 2],
    ]);
    expect(w.terminated).toBe(true);
  });

  it('ends unchecked when the worker failed to load before the bundle came', async () => {
    const w = new FakeWorker();
    const link = new VerifierLink(w);
    w.fail();
    const { s, reports } = steps();
    expect(await checkInWorker(link, BUNDLE, s)).toBe('unchecked');
    expect(reports).toEqual([]);
    expect(w.terminated).toBe(true);
  });

  it('ends unchecked when the worker fails while the bundle is checked', async () => {
    const w = new FakeWorker();
    w.answers = false;
    const { s, reports } = steps();
    const done = checkInWorker(new VerifierLink(w), BUNDLE, s);
    await Promise.resolve();
    expect(w.posted.map((m) => m.t)).toEqual(['verify']);
    w.fail();
    expect(await done).toBe('unchecked');
    expect(reports).toEqual([]);
    expect(w.terminated).toBe(true);
  });

  it('ends unchecked when the worker fails during a replay, keeping the report so far', async () => {
    const w = new FakeWorker();
    w.fights = [ENC];
    const { s, reports } = steps(async () => {
      w.answers = false;
      return null;
    });
    const done = checkInWorker(new VerifierLink(w), BUNDLE, s);
    while (w.posted.length < 2) await new Promise((r) => setTimeout(r, 0));
    w.fail();
    expect(await done).toBe('unchecked');
    expect(reports).toHaveLength(1);
  });
});
