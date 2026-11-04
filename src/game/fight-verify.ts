// The settlement checked on the client (M8 T12, ADR 0054). At `enc-end`, the authority's signed
// document is held against what this page saw: its countersignature under a key `GET /v1/pubkeys`
// lists (fetched once per page and kept), the Merkle root of the frame bundles this client holds,
// and the encounter hash it reached itself. The check runs in a task of its own after the end, off
// the frame loop. DOM-free: the app hands it the fetch.

import type { PubKey } from '../ledger/record';
import { checkSettlementSig, type SignedSettlement } from '../ledger/settlement';
import { framesRoot } from '../net/encounter-verify';

/** A fight as this client holds it at its end. */
export interface HeldFight {
  enc: string;
  /** Every frame bundle from frame 0, as the referee sent them. */
  frames: readonly (readonly (number | null)[])[];
  /** The local `hashEncounter` at the end; null when this client played no part to the end. */
  hash: string | null;
}

/**
 * What disagrees between a settlement and the fight this client holds; empty when it holds. The
 * problems: `key` and `signature` (the countersignature), `enc`, `frames` (a count that is not the
 * held one), `root` and `hash`. Never throws.
 */
export function settlementProblems(
  s: SignedSettlement,
  held: HeldFight,
  keys: readonly PubKey[],
): string[] {
  const problems = checkSettlementSig(s, keys);
  try {
    const doc = s.settlement;
    if (doc.enc !== held.enc) problems.push('enc');
    if (doc.frames !== held.frames.length) problems.push('frames');
    if (doc.root !== framesRoot(held.frames)) {
      problems.push('root');
    }
    if (held.hash === null || doc.hash !== held.hash) problems.push('hash');
  } catch {
    problems.push('root');
  }
  return problems;
}

/** The keys in a `/v1/pubkeys` body, or null when it is not one. */
export function parsePubKeys(body: unknown): PubKey[] | null {
  const keys = (body as { keys?: unknown } | null)?.keys;
  if (!Array.isArray(keys) || keys.length > 64) return null;
  const out: PubKey[] = [];
  for (const k of keys) {
    const { id, publicKey } = (k ?? {}) as { id?: unknown; publicKey?: unknown };
    if (typeof id !== 'string' || typeof publicKey !== 'string') return null;
    if (id.length > 64 || publicKey.length > 64) return null;
    out.push({ id, publicKey });
  }
  return out;
}

/**
 * The authority's keys, fetched at the first ask and kept (they are never rotated). A failed
 * fetch is forgotten, so the next fight asks again.
 */
export function cachedKeys(fetchKeys: () => Promise<unknown>): () => Promise<PubKey[] | null> {
  let kept: Promise<PubKey[] | null> | null = null;
  return () => {
    kept ??= fetchKeys().then(
      (body) => {
        const keys = parsePubKeys(body);
        if (!keys) kept = null;
        return keys;
      },
      () => {
        kept = null;
        return null;
      },
    );
    return kept;
  };
}

export interface FightVerifyDeps {
  /** The authority's keys; null when they could not be had. */
  keys(): Promise<readonly PubKey[] | null>;
  /** Runs the check in a later task of its own (default: a zero-delay timeout). */
  later?(run: () => void): void;
}

/** `state().encounter.verified`: the client's check of each fight's settlement. */
export class FightVerify {
  private enc: string | null = null;
  private result: boolean | null = null;
  /** Checks run so far (a fight's end starts one). */
  runs = 0;

  constructor(private readonly deps: FightVerifyDeps) {}

  /**
   * The fight `enc`'s verdict: true when its settlement held, false when it did not, null before
   * the check is done, for a fight with no settlement (one that failed) or when no keys came.
   */
  verdict(enc: string): boolean | null {
    return this.enc === enc ? this.result : null;
  }

  /** A fight's end: its settlement, if it came, is checked later against what `held` gives then. */
  check(settlement: SignedSettlement | undefined, held: HeldFight): void {
    this.enc = held.enc;
    this.result = null;
    if (!settlement) return;
    const enc = held.enc;
    const later = this.deps.later ?? ((run: () => void) => setTimeout(run, 0));
    // A copy of the frames as they are now: later bundles of another fight never reach them.
    const frames = held.frames.map((inputs) => [...inputs]);
    const snapshot: HeldFight = { enc, frames, hash: held.hash };
    void this.deps.keys().then((keys) => {
      later(() => {
        if (this.enc !== enc) return;
        this.runs++;
        this.result = keys ? settlementProblems(settlement, snapshot, keys).length === 0 : null;
      });
    });
  }
}
