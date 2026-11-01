import type { Canonical } from '../src/ledger/canonical';
import { fromBase64Url, verify } from '../src/ledger/identity';
import {
  type LedgerRecord,
  type PubKey,
  REQUEST_DOMAIN,
  type RecordRequest,
  type Status,
  type StoredRecord,
} from '../src/ledger/record';

// Types, row mappers and pure helpers of the ledger store (ADR 0019); `ledger.ts` re-exports them.

export const SECRET_BYTES = 32;
/** The genesis bucket: a burst of 3 hatches that refills one per 5 minutes. */
export const HATCH_BUCKET = 3;
export const HATCH_REFILL_MS = 300_000;

export interface AcceptInput {
  request: RecordRequest;
  /** Base64url signature of `requestMessage(request)` when the owner started the transition. */
  ownerSig?: string | null;
  /** Genesis only: the genome text the record's genome hash names. */
  genome?: string;
}

export type AcceptResult =
  | { ok: true; stored: StoredRecord; fresh: boolean }
  | { ok: false; reason: string };

export interface Head {
  id: string;
  owner: string;
  status: Status;
  seq: number;
  hash: string;
  genome: string;
  activeMs: number;
  biomass: number;
  energy: number;
  health: number;
  bornT: number;
  diedT: number | null;
  generation: number;
  parentA: string | null;
  parentB: string | null;
  /** The creature that was active when this one was promoted (the checkpoint chain, ADR 0021). */
  chainParent: string | null;
  cooldownUntilMs: number;
}

/** What a record body saves of a creature's state. */
export interface Condition {
  activeMs: number;
  biomass: number;
  energy: number;
  health: number;
  cooldownUntilMs: number;
}

/** When a frozen creature has too little life left to be worth restoring (ADR 0021). */
export interface Exhaustion {
  lifespanOf(head: Head): number;
  restoreMinMs: number;
}

export interface MateInput {
  commit: string;
  round: number;
  /** A's then B's `mate-commit` request, already carrying the costs and the cooldown. */
  requests: [RecordRequest, RecordRequest];
}

/** The outcome of an operation that writes one record on each of two chains. */
export type PairResult =
  | { ok: true; stored: [StoredRecord, StoredRecord]; fresh: boolean }
  | { ok: false; reason: string };

export type MateResult = PairResult;

export interface BirthChild {
  request: RecordRequest;
  genome: string;
  /** The hatchling's condition; its `activeMs` and cooldown start at zero. */
  condition: Pick<Condition, 'biomass' | 'energy' | 'health'>;
}

export interface BirthInput {
  commit: string;
  /** The courting player's child, then the accepting player's. */
  children: [BirthChild, BirthChild];
}

export type BirthResult = PairResult;

export type PromoteResult =
  | { ok: true; stored: StoredRecord; frozen: StoredRecord | null; fresh: boolean }
  | { ok: false; reason: string };

export interface Fallback {
  pending: Head | null;
  ancestor: Head | null;
  /** Frozen creatures walked over that have too little life left; callers mark them dead. */
  exhausted: Head[];
}

export interface PastLifeRow {
  creature: string;
  genome: string;
  activeMs: number;
  bornT: number;
  diedT: number;
  cause: Canonical | null | undefined;
}

export interface Flag {
  kind: string;
  owner: string;
  creature: string;
  hash: string;
  t: number;
}

export interface KeyEntry extends PubKey {
  /** When the authority first used this key, ms. */
  from: number;
}

export type Row = Record<string, SqlStorageValue>;

export interface Storage {
  sql: SqlStorage;
  transactionSync<T>(fn: () => T): T;
}

export const asHead = (r: Row): Head => ({
  id: r.id as string,
  owner: r.owner as string,
  status: r.status as Head['status'],
  seq: r.seq as number,
  hash: r.hash as string,
  genome: r.genome as string,
  activeMs: r.active_ms as number,
  biomass: r.biomass as number,
  energy: r.energy as number,
  health: r.health as number,
  bornT: r.born_t as number,
  diedT: r.died_t as number | null,
  generation: r.generation as number,
  parentA: r.parent_a as string | null,
  parentB: r.parent_b as string | null,
  chainParent: r.chain_parent as string | null,
  cooldownUntilMs: r.cooldown_until_ms as number,
});

export const asStored = (r: Row): StoredRecord => ({
  record: JSON.parse(r.json as string) as LedgerRecord,
  hash: r.hash as string,
  ownerSig: r.owner_sig as string | null,
  authSig: r.auth_sig as string,
  keyId: r.key_id as string,
});

/** A condition field of a record body, or the head's current value when the body has none. */
export function field(body: LedgerRecord['body'], key: string, fallback: number): number {
  const value = body[key];
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : fallback;
}

/** The kinds `accept` takes: one record on one chain. The others have their own operations. */
export const SINGLE_RECORD_KINDS: readonly string[] = ['genesis', 'checkpoint', 'death'];

/** The five fields a record body saves of a creature; a `Head` and a connection's `LifeState` both carry them. */
export const conditionOf = (head: Condition): Condition => ({
  activeMs: head.activeMs,
  biomass: head.biomass,
  energy: head.energy,
  health: head.health,
  cooldownUntilMs: head.cooldownUntilMs,
});

/** Whether a frozen creature's remaining life is under the restore minimum. */
export const isExhausted = (head: Head, rule: Exhaustion): boolean =>
  rule.lifespanOf(head) - head.activeMs < rule.restoreMinMs;

export const FULL_BUCKET = { left: HATCH_BUCKET, genesisIn: 0 };

/** The bucket at `now` from what was stored: the count refilled, and the clock moved on by whole refills. */
export function reconcile(
  stored: number,
  storedT: number,
  now: number,
): { state: { left: number; genesisIn: number }; hatches: number; t: number } {
  if (stored >= HATCH_BUCKET) return { state: FULL_BUCKET, hatches: HATCH_BUCKET, t: now };
  const earned = Math.max(0, Math.floor((now - storedT) / HATCH_REFILL_MS));
  const left = Math.min(HATCH_BUCKET, stored + earned);
  const t = storedT + earned * HATCH_REFILL_MS;
  const genesisIn = left > 0 ? 0 : Math.max(0, t + HATCH_REFILL_MS - now);
  return { state: { left, genesisIn }, hatches: left, t };
}

export function refuse(reason: string): { ok: false; reason: string } {
  return { ok: false, reason };
}

export function verifySig(playerId: string, message: Uint8Array, sig: string): boolean {
  const bytes = fromBase64Url(sig);
  return bytes !== null && verify(playerId, REQUEST_DOMAIN, message, bytes);
}
