import { describe, expect, it } from 'vitest';
import { FIXTURE_KEY, lineageHistory } from '../../tests/lineage-fixture';
import type { Beacon } from '../ledger/drand';
import type { StoredRecord } from '../ledger/record';
import type { FightLog, SignedSettlement } from '../ledger/settlement';
import { birthSubject } from '../ledger/witness';
import { auditSubject, auditVerdict } from './audit';
import type { AuditCase } from './protocol';

// M10 T8: an auditor's verdict on the honest history of `tests/lineage-fixture.ts` (ADR 0058).

const h = lineageHistory();
const keys = [FIXTURE_KEY];
const first = (id: string) => h.chains.get(id)?.[0] as StoredRecord;
const beaconOfCommit = (commit: string): Beacon => {
  const c = h.commits.get(commit);
  return h.beacons.get(c?.commitment.round as number) as Beacon;
};

const [enc, settlement] = [...h.settlements.entries()][0] as [string, SignedSettlement];
const log = h.logs.get(enc) as FightLog;
const fight: AuditCase = { kind: 'enc', log, settlement };
const encBeacon = [...h.beacons.values()][0] as Beacon;

const a0 = first(h.ids.A0);
const genesis: AuditCase = {
  kind: 'genesis',
  commitment: h.commits.get(a0.record.body.commit as string) as never,
  record: a0,
  genome: h.genomes.get(h.ids.A0) as string,
};
const genesisBeacon = beaconOfCommit(a0.record.body.commit as string);

const births = [first(h.ids.A1), first(h.ids.B1)].sort(
  (x, y) => (x.record.body.slot as number) - (y.record.body.slot as number),
) as [StoredRecord, StoredRecord];
const mateId = births[0].record.body.commit as string;
const mateOf = (creature: string) =>
  h.chains
    .get(creature)
    ?.find(
      (r) => r.record.kind === 'mate-commit' && r.record.body.commit === mateId,
    ) as StoredRecord;
const mating: AuditCase = {
  kind: 'mating',
  commitment: h.commits.get(mateId) as never,
  births,
  mates: [mateOf(h.ids.A0), mateOf(h.ids.B0)],
  parents: [h.genomes.get(h.ids.A0) as string, h.genomes.get(h.ids.B0) as string],
};
const mateBeacon = beaconOfCommit(mateId);

describe('auditVerdict', () => {
  it('agrees with the honest fight, A0’s genesis and the mating, naming each subject', () => {
    expect(auditVerdict(fight, encBeacon, keys)).toEqual({ subject: settlement.hash, agree: true });
    expect(auditVerdict(genesis, genesisBeacon, keys)).toEqual({ subject: a0.hash, agree: true });
    expect(auditVerdict(mating, mateBeacon, keys)).toEqual({
      subject: birthSubject(births[0].hash, births[1].hash),
      agree: true,
    });
  });

  it('disagrees with code root when one frame of the log changed', () => {
    const frames = log.frames.map((f) => [...f]);
    // Nobody steered in the fixture's fight: frame 10's first slot gets an idle input instead.
    (frames[10] as (number | null)[])[0] = 0;
    const v = auditVerdict({ ...fight, log: { ...log, frames } }, encBeacon, keys);
    expect(v).toEqual({ subject: settlement.hash, agree: false, code: 'root' });
  });

  it('disagrees with a genesis whose beacon has a byte flipped', () => {
    const sig = genesisBeacon.signature;
    const flipped = `${sig.slice(0, 10)}${sig[10] === '0' ? '1' : '0'}${sig.slice(11)}`;
    const v = auditVerdict(genesis, { ...genesisBeacon, signature: flipped }, keys);
    expect(v.agree).toBe(false);
    expect(v.subject).toBe(a0.hash);
    expect(v.code).toBeTruthy();
  });

  it('disagrees with a mating whose parents are swapped', () => {
    const swapped: AuditCase = { ...mating, parents: [mating.parents[1], mating.parents[0]] };
    const v = auditVerdict(swapped, mateBeacon, keys);
    expect(v.agree).toBe(false);
    expect(v.code).toBeTruthy();
    expect(auditSubject(swapped)).toBe(auditSubject(mating));
  });

  it('disagrees with births out of slot order, and never throws on a broken case', () => {
    const turned: AuditCase = { ...mating, births: [births[1], births[0]] };
    expect(auditVerdict(turned, mateBeacon, keys).agree).toBe(false);
    const broken = { ...genesis, record: { ...a0, record: null } } as unknown as AuditCase;
    expect(auditVerdict(broken, genesisBeacon, keys)).toMatchObject({ agree: false });
  });
});
