// Audits and attestations on the authority (ADR 0058). After a fight's settlement, a mating's two
// births or a genesis's record, the event's case goes to `hub.duties.offerAudit`, which offers it
// (now, or once the witness round resolves) to the next position in the order. An auditor that
// takes it has `ATTEST_MS` to send its signed attestation, else the next position is offered (at
// most 3). Its attestation must carry its signature, name the duty's commitment, its own position
// and the authority's own subject:
// - one that agrees is stored (one row) and the duty is done;
// - one that disagrees is stored too, as overruled: the authority's result stands, the auditor is
//   struck (`audit-overruled`) and the next position may audit;
// - a forged or misplaced one is dropped and its sender struck (`attest-forged`).
// When the event's duties end with no witness span and no agreeing attestation, the event is
// flagged `authority-only` once.

import type { Genome } from '../src/genome/codec';
import { genomeToBase64url } from '../src/genome/codec';
import type { StoredRecord } from '../src/ledger/record';
import type { FightLog, SignedSettlement } from '../src/ledger/settlement';
import { refereesOf } from '../src/ledger/settlement';
import {
  attestationSigned,
  type DutyKind,
  dutyEvent,
  parseSignedAttestation,
} from '../src/ledger/witness';
import { auditSubject } from '../src/net/audit';
import { AUTHORITY } from '../src/net/handover';
import type { AuditCase, ClientMsg } from '../src/net/protocol';
import type { SignedCommitment } from './beacons';
import type { ActiveSession, Hub } from './socket';
import { signedOf } from './socket';

/** How long an auditor that took its duty has to attest. */
export const ATTEST_MS = 60_000;

/** A fight is settled: its auditor re-plays the log against the settlement. */
export function auditFight(hub: Hub, log: FightLog, settlement: SignedSettlement): void {
  offer(hub, 'enc', settlement.settlement.enc, { kind: 'enc', log, settlement });
}

/** A genesis record is written: its auditor recomputes it from the commitment and the beacon. */
export function auditGenesis(
  hub: Hub,
  commit: SignedCommitment,
  record: StoredRecord,
  genome: Genome,
): void {
  offer(hub, 'genesis', commit.id, {
    kind: 'genesis',
    commitment: signedOf(commit),
    record,
    genome: genomeToBase64url(genome),
  });
}

/**
 * A mating's births are written: its auditor recomputes both from the commitment, the beacon, the
 * parents' genome texts and their `mate-commit`s (`a`'s first). `births` may come in any order.
 */
export function auditMating(
  hub: Hub,
  commit: SignedCommitment,
  births: readonly StoredRecord[],
  mates: [StoredRecord, StoredRecord],
  parents: [string, string],
): void {
  const [slot0, slot1] = [...births].sort(
    (x, y) => (x.record.body.slot as number) - (y.record.body.slot as number),
  );
  if (!slot0 || !slot1) return;
  offer(hub, 'mating', commit.id, {
    kind: 'mating',
    commitment: signedOf(commit),
    births: [slot0, slot1],
    mates,
    parents,
  });
}

/** Hands the case to the event's duties. A failure here never touches the event: it stays as the authority decided it. */
function offer(hub: Hub, kind: DutyKind, id: string, audit: AuditCase): void {
  try {
    hub.duties.offerAudit(dutyEvent(kind, id), audit);
  } catch (error) {
    console.error('audit offer failed', error);
  }
}

/** An auditor took its duty: it has `ATTEST_MS` to attest (`duty.onAuditor`). */
export function auditorTook(hub: Hub, event: string): void {
  hub.duties.awaitAttest(event, ATTEST_MS);
}

/**
 * An `attest`. From a player that holds no taken auditor duty it is dropped and counted (a late
 * one after its duty moved on); from an auditor it must hold, or it is dropped and the auditor
 * struck.
 */
export function attest(hub: Hub, session: ActiveSession, msg: ClientMsg & { t: 'attest' }): void {
  const player = session.playerId;
  const duty = hub.duties.auditing(player);
  if (!duty) {
    hub.duties.strays++;
    return;
  }
  const { event, position, order, commitId, audit } = duty;
  // The wire parsed it; parsing again keeps this handler safe on its own.
  const signed = parseSignedAttestation(msg.signed);
  const a = signed?.attestation;
  const holds =
    signed !== null &&
    a !== undefined &&
    a.event === event &&
    a.duty === commitId &&
    a.position === position &&
    a.witness === player &&
    order[position] === player &&
    a.subject === auditSubject(audit) &&
    attestationSigned(signed);
  if (!signed || !holds) {
    hub.duties.strike(player, 'attest-forged', event);
    hub.duties.reoffer(event, 'auditor');
    return;
  }
  const now = hub.clock.now();
  const cursor = hub.ctx.storage.sql.exec(
    'INSERT OR IGNORE INTO attestations (event, position, witness, json, t) VALUES (?, ?, ?, ?, ?)',
    event,
    position,
    player,
    JSON.stringify(signed),
    now,
  );
  hub.ledger.rowsWritten += cursor.rowsWritten;
  if (signed.attestation.agree) {
    hub.duties.end(event, 'auditor', 'done');
    return;
  }
  // Overruled: the authority's result stands, and another auditor may still agree with it.
  hub.duties.strike(player, 'audit-overruled', event);
  hub.duties.reoffer(event, 'auditor');
}

/**
 * The event's auditors are all spent (`duty.onAuditEnd`): with no witness span and no agreeing
 * attestation, it is flagged `authority-only` once.
 */
export function auditEnded(
  hub: Hub,
  event: string,
  audit: AuditCase | null,
  participants: readonly string[],
): void {
  const refereed =
    audit?.kind === 'enc' &&
    refereesOf(audit.settlement.settlement).some((s) => s.by !== AUTHORITY);
  if (refereed || agreed(hub, event)) return;
  hub.ledger.audit.raise('authority-only', {
    owner: participants[0] ?? '',
    creature: '',
    key: event,
    t: hub.clock.now(),
  });
}

/** Whether an attestation stored for the event agrees with the authority. */
function agreed(hub: Hub, event: string): boolean {
  return hub.ctx.storage.sql
    .exec<{ json: string }>('SELECT json FROM attestations WHERE event = ?', event)
    .toArray()
    .some((r) => parseSignedAttestation(JSON.parse(r.json))?.attestation.agree === true);
}
