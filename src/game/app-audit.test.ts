import { describe, expect, it } from 'vitest';
import { identity, lineageHistory, witnessSecret } from '../../tests/lineage-fixture';
import type { Beacon } from '../ledger/drand';
import { randomnessOf } from '../ledger/drand';
import { commitmentId } from '../ledger/genesis';
import type { StoredRecord } from '../ledger/record';
import { attestationSigned, dutyEvent, witnessOrder } from '../ledger/witness';
import { auditJob } from '../net/audit';
import type { ClientMsg, SignedCommit } from '../net/protocol';
import { AuditDuties, type AuditHost, type AuditorDuty, type AuditRunner } from './app-audit';

// M10 T8: the page's auditor duty, on the honest history's A0 genesis audit (its witness commitment
// and beacon), with the worker's jobs run inline.

const h = lineageHistory();
const a0 = h.chains.get(h.ids.A0)?.[0] as StoredRecord;
const genesisCommit = h.commits.get(a0.record.body.commit as string) as SignedCommit;
const event = dutyEvent('genesis', commitmentId(genesisCommit.commitment));
const [wid, wc] = [...h.witnessCommits.entries()].find(
  ([, c]) => (c.commitment.data as { event: string }).event === event,
) as [string, SignedCommit];
const beacon = h.beacons.get(wc.commitment.round) as Beacon;
const order = witnessOrder(
  (wc.commitment.data as { pool: string[] }).pool,
  randomnessOf(beacon),
  wid,
);

const duty = (position = 0): AuditorDuty => ({
  t: 'duty',
  event,
  role: 'auditor',
  position,
  commit: wc,
  beacon,
  audit: {
    kind: 'genesis',
    commitment: genesisCommit,
    record: a0,
    genome: h.genomes.get(h.ids.A0) as string,
  },
});

const inline: AuditRunner = {
  run: async (job) => auditJob({ ...job, id: 0 } as never) as never,
};

function page(over: Partial<AuditHost> = {}, me = order[0] as string) {
  const sent: ClientMsg[] = [];
  const host: AuditHost = {
    identity: () => identity(witnessSecret(me)),
    keys: async () => [],
    sendHub: (m) => sent.push(m),
    runner: inline,
    perfNow: () => 0,
    ...over,
  };
  return { audits: new AuditDuties(host), sent };
}

describe('AuditDuties', () => {
  it('takes a duty it is selected for, then sends a signed agreeing attestation', async () => {
    const p = page();
    await p.audits.offer(duty());
    expect(p.sent.map((m) => m.t)).toEqual(['duty-ok', 'attest']);
    const attest = p.sent[1];
    if (attest?.t !== 'attest') throw new Error('no attestation');
    expect(attestationSigned(attest.signed)).toBe(true);
    expect(attest.signed.attestation).toEqual({
      v: 1,
      kind: 'attest',
      event,
      duty: wid,
      position: 0,
      witness: order[0],
      subject: a0.hash,
      agree: true,
    });
    expect(p.audits.audits).toMatchObject([{ event, agree: true }]);
    expect(p.audits.auditing).toBeNull();
  });

  it('declines a duty whose selection does not check: another position, or a bad beacon', async () => {
    const p = page();
    await p.audits.offer(duty(1));
    const sig = beacon.signature;
    const bad = {
      ...duty(),
      beacon: { ...beacon, signature: `${sig[0] === '0' ? '1' : '0'}${sig.slice(1)}` },
    };
    await p.audits.offer(bad);
    expect(p.sent).toEqual([
      { t: 'duty-no', event },
      { t: 'duty-no', event },
    ]);
  });

  it('declines a fight’s audit when the authority’s keys could not be had', async () => {
    const p = page({ keys: async () => null });
    const settlement = [...h.settlements.values()][0];
    const log = [...h.logs.values()][0];
    if (!settlement || !log) throw new Error('no fight');
    await p.audits.offer({ ...duty(), audit: { kind: 'enc', log, settlement } });
    expect(p.sent).toEqual([{ t: 'duty-no', event }]);
  });

  it('sends nothing when its duty ends while the verdict is worked out', async () => {
    let audits: AuditDuties | null = null;
    const slow: AuditRunner = {
      run: async (job) => {
        if (job.t === 'verdict') audits?.end({ t: 'duty-end', event, why: 'replaced' });
        return auditJob({ ...job, id: 0 } as never) as never;
      },
    };
    const p = page({ runner: slow });
    audits = p.audits;
    await p.audits.offer(duty());
    expect(p.sent.map((m) => m.t)).toEqual(['duty-ok']);
  });

  it('declines when the worker fails before duty-ok, and stays silent when it fails after', async () => {
    const failing = (at: 'select' | 'verdict'): AuditRunner => ({
      run: async (job) => {
        if (job.t === at) throw new Error('worker lost');
        return auditJob({ ...job, id: 0 } as never) as never;
      },
    });
    const early = page({ runner: failing('select') });
    await early.audits.offer(duty());
    expect(early.sent).toEqual([{ t: 'duty-no', event }]);
    const late = page({ runner: failing('verdict') });
    await late.audits.offer(duty());
    expect(late.sent.map((m) => m.t)).toEqual(['duty-ok']);
  });
});
