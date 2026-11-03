// An encounter's results as records (M7 T13, ADR 0052): what the authority writes at a fight's
// end, in the one transaction `Ledger.settle` opens. Kept apart from `ledger.ts`, which is near
// its size limit; the ledger hands in the few chain operations this needs.

import {
  type LedgerRecord,
  type RecordKind,
  recordProblems,
  type StoredRecord,
  transitionOutcome,
} from '../src/ledger/record';
import { type Outcome, survivedOutcome } from '../src/sim/encounter/types';
import type { DeathCause } from '../src/sim/types';
import type { Head } from './ledger-types';
import type { Condition } from './life';

/** One fighter's part of a settlement. Creatures are ids; amounts are hundredths. */
export interface FighterRecord {
  owner: string;
  creature: string;
  outcome: Outcome;
  cause: DeathCause | null;
  /** The killer's creature, for a kill. */
  by: string | null;
  /** Frames fought until its outcome. */
  frames: number;
  /** Its condition at the end. */
  condition: Condition;
  /** The biomass its kills and eaten eggs were worth. */
  reward: number;
  /** Its life clock at the end (the head's when it was away). */
  activeMs: number;
  /** A dead fighter's last report that no record holds yet: written as a checkpoint first. */
  unsaved: Condition | null;
  /** The eater's creature when its egg was eaten. */
  eggBy: string | null;
}

export interface FightRecords {
  enc: string;
  fighters: readonly FighterRecord[];
}

/** `fresh` is false when the encounter was settled before, and nothing was written. */
export interface SettleResult {
  fresh: boolean;
  stored: StoredRecord[];
}

/** What the settlement needs of the ledger, inside its transaction. */
export interface ChainOps {
  head(creature: string): Head | null;
  pending(owner: string): Head | null;
  /** Whether the creature's chain already holds a record of encounter `enc`. */
  holds(creature: string, enc: string): boolean;
  /** Stores an attested record on top of `head` and moves the head to `next`. */
  write(head: Head, record: LedgerRecord, next: Head['status']): StoredRecord;
  now(): number;
  rules: number;
}

/** Whether a creature's chain holds a record of an encounter (bindings: creature, encounter id). */
export const HOLDS_ENCOUNTER =
  "SELECT 1 FROM records WHERE creature = ? AND json_extract(json, '$.body.enc') = ? LIMIT 1";

/**
 * Writes the encounter's records: an `encounter` record per survivor; per dead fighter a checkpoint
 * if its last report is unsaved, then its `death`; per eaten egg the pending child's `death`. A
 * fighter whose creature is no longer the active one is skipped. Settling the same encounter again
 * writes nothing. Throws on a record the rules refuse, so the caller's transaction rolls back whole.
 */
export function settleRecords(ops: ChainOps, input: FightRecords): SettleResult {
  const { enc } = input;
  if (input.fighters.some((f) => ops.holds(f.creature, enc))) return { fresh: false, stored: [] };
  const stored: StoredRecord[] = [];
  const append = (head: Head, kind: RecordKind, body: LedgerRecord['body']): Head => {
    const record: LedgerRecord = {
      v: 1,
      rules: ops.rules,
      kind,
      creature: head.id,
      seq: head.seq + 1,
      prev: head.hash,
      owner: head.owner,
      t: ops.now(),
      body,
    };
    const problems = recordProblems(record);
    const cause = kind === 'death' ? String(body.cause) : null;
    const outcome = transitionOutcome(kind, cause, head.status);
    if (problems.length > 0 || !outcome.ok) {
      throw new Error(`settle ${kind}: ${[...problems, outcome.ok ? '' : outcome.reason]}`);
    }
    stored.push(ops.write(head, record, outcome.next));
    return ops.head(head.id) as Head;
  };
  const settleFighter = (start: Head, f: FighterRecord): void => {
    const { condition } = f;
    if (survivedOutcome(f.outcome)) {
      append(start, 'encounter', {
        enc,
        outcome: f.outcome,
        frames: f.frames,
        ...condition,
        reward: f.reward,
      });
      return;
    }
    const head = f.unsaved
      ? append(start, 'checkpoint', { ...f.unsaved, activeMs: f.activeMs })
      : start;
    append(head, 'death', {
      cause: f.cause ?? 'killed',
      activeMs: f.activeMs,
      biomass: condition.biomass,
      enc,
      ...(f.by !== null ? { by: f.by } : {}),
    });
  };
  for (const f of input.fighters) {
    const head = ops.head(f.creature);
    if (head?.status === 'active' && head.owner === f.owner) settleFighter(head, f);
    // The pending child goes with its egg, whatever became of the carrier.
    if (f.eggBy !== null) {
      const child = ops.pending(f.owner);
      if (child) append(child, 'death', { cause: 'eaten', enc, by: f.eggBy });
    }
  }
  return { fresh: true, stored };
}
