// An auditor's verdict (ADR 0058): what a witness re-checks of a decision the authority made, and the
// subject its attestation names. Pure and shared: the page runs it in a module worker
// (`src/game/audit-worker.ts`), and the authority names the same subject (`worker/attest.ts`).
// - a fight: the log replayed against the settlement (`verifyEncounter`); its subject is the
//   settlement's hash;
// - a genesis: the record recomputed from its commitment and beacon, and the genome text against
//   it (`checkGenesis`); its subject is the record's hash;
// - a mating: both births recomputed from the commitment, the beacon, both parents' genomes and
//   both `mate-commit`s (`checkBirth`); its subject is `birthSubject` of both births in slot order.

import { type Genome, genomeFromBase64url } from '../genome/codec';
import { type Beacon, randomnessOf, verifyBeacon } from '../ledger/drand';
import { checkGenesis, commitmentId } from '../ledger/genesis';
import { checkBirth } from '../ledger/mating';
import { type PubKey, recordHash } from '../ledger/record';
import {
  birthSubject,
  type WitnessData,
  witnessDataProblems,
  witnessOrder,
} from '../ledger/witness';
import { verifyEncounter } from './encounter-verify';
import type { AuditCase, HubMsg } from './protocol';

export interface AuditVerdict {
  subject: string;
  agree: boolean;
  /** The first problem; only when `agree` is false. */
  code?: string;
}

/** The subject an attestation of `c` names: the settlement's hash, the genesis record's, or `birthSubject` of both births. */
export function auditSubject(c: AuditCase): string {
  switch (c.kind) {
    case 'enc':
      return c.settlement.hash;
    case 'genesis':
      return c.record.hash;
    case 'mating':
      return birthSubject(c.births[0].hash, c.births[1].hash);
  }
}

/** Why the authority's decision in `c` does not hold under `beacon` (its witness round's) and `keys`; empty when it holds. Never throws. */
export function auditProblems(c: AuditCase, beacon: Beacon, keys: readonly PubKey[]): string[] {
  try {
    if (c.kind === 'enc') return verifyEncounter(c.settlement, c.log, keys);
    if (c.kind === 'genesis') {
      const { record } = c;
      if (record.hash !== recordHash(record.record)) return ['record-hash'];
      return checkGenesis(record.record, c.commitment.commitment, beacon, c.genome);
    }
    const parents = c.parents.map(genomeFromBase64url);
    if (!parents[0] || !parents[1]) return ['parent-genome'];
    const problems: string[] = [];
    for (const [slot, birth] of c.births.entries()) {
      if (birth.hash !== recordHash(birth.record)) problems.push('record-hash');
      if (birth.record.body.slot !== slot) problems.push('slot-order');
      problems.push(
        ...checkBirth(
          birth.record,
          c.commitment.commitment,
          beacon,
          parents as [Genome, Genome],
          c.mates,
        ),
      );
    }
    return problems;
  } catch {
    return ['unreadable'];
  }
}

/** The verdict an auditor signs: the subject, and whether the decision holds (with its first problem when not). */
export function auditVerdict(c: AuditCase, beacon: Beacon, keys: readonly PubKey[]): AuditVerdict {
  const subject = auditSubject(c);
  const [code] = auditProblems(c, beacon, keys);
  return code === undefined ? { subject, agree: true } : { subject, agree: false, code };
}

/**
 * Whether `me` holds the duty's position: the event's witness commitment on the beacon's round, its
 * pool well formed, the beacon valid, and the drand order of the pool naming `me` there. Never throws.
 */
export function dutySelected(duty: Extract<HubMsg, { t: 'duty' }>, me: string): boolean {
  try {
    const { commitment } = duty.commit;
    const data = commitment.data as unknown;
    if (commitment.kind !== 'witness' || witnessDataProblems(data).length > 0) return false;
    const { event, pool } = data as WitnessData;
    if (event !== duty.event || commitment.round !== duty.beacon.round) return false;
    if (!verifyBeacon(duty.beacon)) return false;
    const order = witnessOrder(pool, randomnessOf(duty.beacon), commitmentId(commitment));
    return order[duty.position] === me;
  } catch {
    return false;
  }
}

type AuditorDuty = Extract<HubMsg, { t: 'duty'; role: 'auditor' }>;

/** A job for the page's audit worker (`src/game/audit-worker.ts`): the selection check, or the verdict. */
export type AuditJob =
  | { id: number; t: 'select'; duty: AuditorDuty; me: string }
  | { id: number; t: 'verdict'; audit: AuditCase; beacon: Beacon; keys: PubKey[] };

export type AuditReply =
  | { id: number; t: 'select'; ok: boolean }
  | { id: number; t: 'verdict'; verdict: AuditVerdict };

/** Runs one job, as the audit worker does. */
export function auditJob(job: AuditJob): AuditReply {
  if (job.t === 'select') return { id: job.id, t: 'select', ok: dutySelected(job.duty, job.me) };
  return { id: job.id, t: 'verdict', verdict: auditVerdict(job.audit, job.beacon, job.keys) };
}
