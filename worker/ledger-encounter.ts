// An encounter's results as records (M7 T13, ADR 0052) and its countersigned settlement document
// (M8, ADR 0054): what the authority writes at a fight's end, in the one transaction
// `Ledger.settle` opens. Kept apart from `ledger.ts`, which is near its size limit; the ledger hands
// in the few chain operations this needs, and the fight's log (`fight-store.ts`) where the
// document goes.

import {
  type LedgerRecord,
  type RecordKind,
  recordProblems,
  type StoredRecord,
  transitionOutcome,
} from '../src/ledger/record';
import { type Settlement, type SignedSettlement, settlementHash } from '../src/ledger/settlement';
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
  /** Its life clock at the end: its clock at its start or join plus the frames it was locked in (M8). */
  activeMs: number;
  /** A dead fighter's last report that no record holds yet: written as a checkpoint first. */
  unsaved: Condition | null;
  /** The eater's creature when its egg was eaten. */
  eggBy: string | null;
}

export interface FightRecords {
  enc: string;
  fighters: readonly FighterRecord[];
  /** The document to countersign (`settlementOf`), and the fight's log that keeps it. */
  settlement: Settlement;
  log: SettlementLog;
}

/**
 * `fresh` is false when the encounter was settled before, and nothing was written; `settlement` is
 * the countersigned document, the stored one then (null for a fight whose records predate it).
 */
export interface SettleResult {
  fresh: boolean;
  stored: StoredRecord[];
  settlement: SignedSettlement | null;
}

/** Where the fight's settlement document lives: its row in the saved log (`fight-store.ts`). */
export interface SettlementLog {
  /** The document stored for the fight, once it is settled. */
  stored(): SignedSettlement | null;
  /** Writes the document with the log's tail and closes the row; throws when it can't. */
  seal(signed: SignedSettlement): void;
}

/** What the settlement needs of the ledger, inside its transaction. */
export interface ChainOps {
  head(creature: string): Head | null;
  pending(owner: string): Head | null;
  /** Whether the creature's chain already holds a record of encounter `enc`. */
  holds(creature: string, enc: string): boolean;
  /** Stores an attested record on top of `head` and moves the head to `next`. */
  write(head: Head, record: LedgerRecord, next: Head['status']): StoredRecord;
  /** The authority's countersignature over a hash, with its key id. */
  countersign(hash: string): { authSig: string; keyId: string };
  now(): number;
  rules: number;
}

/** Whether a creature's chain holds a record of an encounter (bindings: creature, encounter id). */
export const HOLDS_ENCOUNTER =
  "SELECT 1 FROM records WHERE creature = ? AND json_extract(json, '$.body.enc') = ? LIMIT 1";

/**
 * Writes the encounter's records: an `encounter` record per survivor; per dead fighter a checkpoint
 * if its last report is unsaved, then its `death`; per eaten egg the pending child's `death`. A
 * fighter whose creature is no longer the active one is skipped. Then the countersigned document
 * goes into the fight's log with its tail (`log.seal`). Settling the same encounter again writes nothing
 * and returns the stored document. Throws on a record the rules refuse or a seal that fails, so the
 * caller's transaction rolls back whole.
 */
export function settleRecords(ops: ChainOps, input: FightRecords): SettleResult {
  const { enc, log } = input;
  const done = log.stored();
  if (done || input.fighters.some((f) => ops.holds(f.creature, enc))) {
    return { fresh: false, stored: [], settlement: done };
  }
  const stored: StoredRecord[] = [];
  // One date for the whole settlement: the verifier ties a checkpoint to its death by their equal `t`.
  const t = ops.now();
  const append = (head: Head, kind: RecordKind, body: LedgerRecord['body']): Head => {
    const record: LedgerRecord = {
      v: 1,
      rules: ops.rules,
      kind,
      creature: head.id,
      seq: head.seq + 1,
      prev: head.hash,
      owner: head.owner,
      t,
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
        activeMs: f.activeMs,
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
      if (child) {
        const { activeMs, biomass } = child;
        append(child, 'death', { cause: 'eaten', activeMs, biomass, enc, by: f.eggBy });
      }
    }
  }
  const hash = settlementHash(input.settlement);
  const settlement = { settlement: input.settlement, hash, ...ops.countersign(hash) };
  log.seal(settlement);
  return { fresh: true, stored, settlement };
}
