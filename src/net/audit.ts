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
import type { Beacon } from '../ledger/drand';
import { checkGenesis } from '../ledger/genesis';
import { checkBirth } from '../ledger/mating';
import { type PubKey, recordHash } from '../ledger/record';
import { birthSubject } from '../ledger/witness';
import { verifyEncounter } from './encounter-verify';
import type { AuditCase } from './protocol';

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
