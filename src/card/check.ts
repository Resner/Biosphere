// The card's check (M9 T12): the whole bundle verified once, then each settled fight replayed as
// its log arrives. A replay reruns only the fights family over the one log, against the bundle
// indexed once, so the drand and signature checks are never paid twice. Pure: the module worker
// (`verify-worker.ts`) runs it off the page's thread, and the tests run it in Node.

import type { ProofBundle } from '../ledger/proof';
import type { FightLog } from '../ledger/settlement';
import {
  type BundleIndex,
  indexBundle,
  type LineageReport,
  type Problem,
  type VerifyOptions,
  verifyLineage,
} from '../ledger/verify';
import { creatureOf } from '../ledger/verify-chain';
import { fightsOf, verifyFights } from '../ledger/verify-fights';

export type Replay = NonNullable<VerifyOptions['replay']>;

const keyOf = (p: Problem): string => `${p.creature}|${p.seq}|${p.family}|${p.code}`;

export class LineageCheck {
  /** Null when the bundle cannot be indexed, which its report already says. */
  private readonly index: BundleIndex | null = null;
  private readonly logs = new Map<string, FightLog | null>();
  private current: LineageReport;

  constructor(
    private readonly bundle: ProofBundle,
    private readonly replay: Replay,
  ) {
    this.current = verifyLineage(bundle);
    try {
      this.index = indexBundle(bundle);
    } catch {
      // `verifyLineage` reported the bundle unreadable.
    }
  }

  get report(): LineageReport {
    return this.current;
  }

  /**
   * The settlements to replay, the subject's own first: every fight a held record names, so a
   * verified card has replayed every fight it shows.
   */
  fights(): string[] {
    const own = new Set<string>();
    for (const s of this.bundle.records) {
      const enc = s.record.body.enc;
      if (creatureOf(s) === this.bundle.subject && typeof enc === 'string') own.add(enc);
    }
    const all = [...new Set(this.bundle.settlements.map((s) => s.settlement.enc))];
    return [...all.filter((e) => own.has(e)), ...all.filter((e) => !own.has(e))];
  }

  /** Adds one fight's log (null once pruned) and replays it; the report then counts it. */
  add(enc: string, log: FightLog | null): LineageReport {
    if (!this.index || this.logs.has(enc)) return this.current;
    this.logs.set(enc, log);
    let found: Problem[] = [];
    try {
      found = verifyFights(this.index, { logs: new Map([[enc, log]]), replay: this.replay });
    } catch {
      found = [{ creature: this.bundle.subject, seq: null, family: 'fights', code: 'replay' }];
    }
    const seen = new Set(this.current.problems.map(keyOf));
    const problems = [...this.current.problems];
    for (const p of found) {
      if (seen.has(keyOf(p))) continue;
      seen.add(keyOf(p));
      problems.push(p);
    }
    this.current = {
      ...this.current,
      problems,
      fights: fightsOf(this.index, { logs: this.logs, replay: this.replay }),
    };
    return this.current;
  }
}
