import { describe, expect, it } from 'vitest';
import { commitmentId } from '../src/ledger/genesis';
import { type MateAsk, signMateAsk } from '../src/ledger/mating';
import type { StoredRecord } from '../src/ledger/record';
import { type Attestation, birthSubject, signAttestation } from '../src/ledger/witness';
import { auditVerdict } from '../src/net/audit';
import type { HubMsg } from '../src/net/protocol';
import { ATTEST_MS } from './attest';
import { OFFER_MS, witnessView } from './duty';
import {
  advance,
  authority,
  fighters,
  join,
  killB,
  type Player,
  rehatch,
  setEnv,
  useFightHub,
  within,
} from './fight-test-kit';
import { ask, CALM, flush, freshNonce, nextOf, publish, report, sql } from './test-hub';
import {
  byPlayer,
  orderOf,
  useWitnessHub,
  type Witness,
  witnessCommit,
  witnesses,
} from './witness-test-kit';

// M10 T8: auditors re-check a fight, a mating or a genesis and sign an attestation (ADR 0058). The
// authority stores one that holds (overruled when it disagrees, its auditor struck), drops a forged
// or misplaced one and strikes its sender, replaces a silent auditor, and flags the event
// `authority-only` once when its duties end with no witness span and no agreeing attestation.

useFightHub();
useWitnessHub();

type AuditorDuty = Extract<HubMsg, { t: 'duty'; role: 'auditor' }>;

interface Audited {
  ws: Witness[];
  event: string;
  /** The witness at each position of the order. */
  at: (position: number) => Witness;
}

/** The event's witness commitment, once the object has written it. */
async function committed(event: string) {
  for (let i = 0; i < 50; i++) {
    const found = await witnessCommit(event);
    if (found) return found;
  }
  throw new Error(`no witness commitment for ${event}`);
}

async function auditorDuty(w: Witness): Promise<AuditorDuty> {
  const duty = await within(nextOf(w.c, 'duty'), 'an auditor duty');
  if (duty.role !== 'auditor') throw new Error('not an auditor duty');
  return duty;
}

/** The witness's attestation of its duty, as its verdict says, with `over` changed. */
function attestationOf(
  w: Witness,
  duty: AuditorDuty,
  keys: { id: string; publicKey: string }[] = [],
  over: Partial<Attestation> = {},
) {
  const v = auditVerdict(duty.audit, duty.beacon, keys);
  return signAttestation(w.id, {
    v: 1,
    kind: 'attest',
    event: duty.event,
    duty: commitmentId(duty.commit.commitment),
    position: duty.position,
    witness: w.id.playerId,
    subject: v.subject,
    agree: v.agree,
    ...(v.code === undefined ? {} : { code: v.code }),
    ...over,
  });
}

const flags = async (kind: string, event: string) =>
  (
    await sql<{ n: number }>(
      'SELECT COUNT(*) AS n FROM flags WHERE kind = ? AND hash = ?',
      kind,
      event,
    )
  )[0]?.n ?? 0;
const view = (event: string) => authority((o) => witnessView(o, event));
const offersOf = async (event: string) =>
  (await view(event))?.offers.map((o) => [o.position, o.outcome]);
const types = (msgs: HubMsg[]) => msgs.map((m) => m.t);

/** A genesis with `n` eligible witnesses online: its record is written, and its auditor offered. */
async function genesisAudit(n: number): Promise<Audited & { record: StoredRecord }> {
  const ws = await witnesses(n);
  const p = await join();
  const { commit } = await ask(p.c, p.id);
  const event = `genesis:${commitmentId(commit.commitment)}`;
  const wc = await committed(event);
  const order = orderOf(wc, wc.id);
  await publish(commit.commitment.round);
  const { record } = await nextOf(p.c, 'genesis');
  return { ws, event, record, at: (pos) => byPlayer(ws, order[pos]) };
}

describe('audits', () => {
  it('stores an honest genesis attestation (one row) and raises no flag', async () => {
    const g = await genesisAudit(3);
    const duty = await auditorDuty(g.at(0));
    // The audit arrives after the record, and carries it.
    expect(duty).toMatchObject({ event: g.event, position: 0 });
    expect(duty.audit).toMatchObject({ kind: 'genesis', record: g.record });
    g.at(0).c.send({ t: 'duty-ok', event: g.event });
    await flush(g.at(0).c);
    const signed = attestationOf(g.at(0), duty);
    expect(signed.attestation).toMatchObject({ agree: true, subject: g.record.hash });
    const rows = await authority((o) => o.ledger.rowsWritten);
    g.at(0).c.send({ t: 'attest', signed });
    expect((await nextOf(g.at(0).c, 'duty-end')).why).toBe('done');
    expect((await view(g.event))?.attestations).toEqual([signed]);
    expect((await authority((o) => o.ledger.rowsWritten)) - rows).toBe(1);
    for (const kind of ['audit-overruled', 'attest-forged', 'authority-only'])
      expect(await flags(kind, g.event)).toBe(0);
    expect((await view(g.event))?.struck).toEqual([]);
    // Nobody else is offered it.
    for (const p of [1, 2]) expect(types(await flush(g.at(p).c))).not.toContain('duty');
  });

  it('stores a disagreeing attestation as overruled, strikes its auditor and flags audit-overruled', async () => {
    const g = await genesisAudit(3);
    const duty = await auditorDuty(g.at(0));
    g.at(0).c.send({ t: 'duty-ok', event: g.event });
    const signed = attestationOf(g.at(0), duty, [], { agree: false, code: 'body-mismatch' });
    g.at(0).c.send({ t: 'attest', signed });
    expect((await nextOf(g.at(0).c, 'duty-end')).why).toBe('struck');
    const seen = await view(g.event);
    expect(seen?.attestations).toEqual([signed]);
    expect(seen?.struck).toEqual([g.at(0).id.playerId]);
    expect(await flags('audit-overruled', g.event)).toBe(1);
    expect(await flags('attest-forged', g.event)).toBe(0);
  });

  it.each([
    ['a forged signature', (s: ReturnType<typeof attestationOf>) => ({ ...s, sig: flip(s.sig) })],
    [
      'a wrong position',
      (_s: ReturnType<typeof attestationOf>, w: Witness, d: AuditorDuty) =>
        attestationOf(w, d, [], { position: d.position + 1 }),
    ],
    [
      'another subject',
      (_s: ReturnType<typeof attestationOf>, w: Witness, d: AuditorDuty) =>
        attestationOf(w, d, [], { subject: 'ab'.repeat(32) }),
    ],
  ])('drops an attestation with %s and strikes its sender', async (_what, change) => {
    const g = await genesisAudit(3);
    const duty = await auditorDuty(g.at(0));
    g.at(0).c.send({ t: 'duty-ok', event: g.event });
    const signed = change(attestationOf(g.at(0), duty), g.at(0), duty);
    g.at(0).c.send({ t: 'attest', signed });
    expect((await nextOf(g.at(0).c, 'duty-end')).why).toBe('struck');
    const seen = await view(g.event);
    expect(seen?.attestations).toEqual([]);
    expect(seen?.struck).toEqual([g.at(0).id.playerId]);
    expect(await flags('attest-forged', g.event)).toBe(1);
    // The next position audits instead.
    expect((await auditorDuty(g.at(1))).position).toBe(1);
  });

  it('drops an attestation from someone holding no auditor duty, striking nobody', async () => {
    const g = await genesisAudit(3);
    const duty = await auditorDuty(g.at(0));
    const strays = await authority((o) => o.duties.strays);
    g.at(2).c.send({ t: 'attest', signed: attestationOf(g.at(2), duty) });
    await flush(g.at(2).c);
    expect(await authority((o) => o.duties.strays)).toBe(strays + 1);
    expect((await view(g.event))?.struck).toEqual([]);
    expect(await flags('attest-forged', g.event)).toBe(0);
  });

  it('flags authority-only once when three auditors stay silent', async () => {
    const g = await genesisAudit(4);
    await auditorDuty(g.at(0));
    // The first takes the duty and never attests; the next two never answer.
    g.at(0).c.send({ t: 'duty-ok', event: g.event });
    await flush(g.at(0).c);
    await advance(ATTEST_MS);
    expect((await nextOf(g.at(0).c, 'duty-end')).why).toBe('replaced');
    await auditorDuty(g.at(1));
    await advance(OFFER_MS);
    await auditorDuty(g.at(2));
    await advance(OFFER_MS);
    expect(await offersOf(g.event)).toEqual([
      [0, 'silent'],
      [1, 'silent'],
      [2, 'silent'],
    ]);
    expect(types(await flush(g.at(3).c))).not.toContain('duty');
    expect(await flags('authority-only', g.event)).toBe(1);
    // Struck: nobody (silence only replaces an auditor).
    expect((await view(g.event))?.struck).toEqual([]);
  });

  it('offers a mating’s audit once both births are written, with both births in slot order', async () => {
    await setEnv(true);
    const [a, b] = [await adult(), await adult()];
    const ws = await witnesses(2);
    const commit = await mate(a, b);
    const event = `mating:${commitmentId(commit.commitment)}`;
    const wc = await committed(event);
    const order = orderOf(wc, wc.id);
    await publish(commit.commitment.round);
    const born = await Promise.all([nextOf(a.c, 'born'), nextOf(b.c, 'born')]);
    const w = byPlayer(ws, order[0]);
    const duty = await auditorDuty(w);
    if (duty.audit.kind !== 'mating') throw new Error('not a mating audit');
    const births = born
      .map((m) => m.record)
      .sort((x, y) => (x.record.body.slot as number) - (y.record.body.slot as number));
    expect(duty.audit.births).toEqual(births);
    w.c.send({ t: 'duty-ok', event });
    const signed = attestationOf(w, duty);
    expect(signed.attestation).toMatchObject({
      agree: true,
      subject: birthSubject(births[0]?.hash as string, births[1]?.hash as string),
    });
    w.c.send({ t: 'attest', signed });
    expect((await nextOf(w.c, 'duty-end')).why).toBe('done');
    expect((await view(event))?.attestations).toEqual([signed]);
  });

  it('audits a fight after its settlement, and offers position 2 after 60 s of silence', async () => {
    const [a, b] = await fighters();
    const ws = await witnesses(4);
    const { start, end } = await killB(a, b);
    const event = `enc:${start.enc}`;
    const wc = await committed(event);
    const order = orderOf(wc, wc.id);
    // The round comes after the end: no referee was offered, and the auditor is offered now.
    await publish(wc.commitment.round);
    const at = (p: number) => byPlayer(ws, order[p]);
    expect(types(await flush(at(0).c))).not.toContain('duty');
    const duty = await auditorDuty(at(1));
    expect(duty.position).toBe(1);
    if (duty.audit.kind !== 'enc') throw new Error('not a fight audit');
    expect(duty.audit.settlement).toEqual(end.settlement);
    const keys = await authority((o) => o.pubkeys());
    expect(attestationOf(at(1), duty, keys).attestation).toMatchObject({
      agree: true,
      subject: end.settlement?.hash,
    });
    at(1).c.send({ t: 'duty-ok', event });
    await flush(at(1).c);
    await advance(ATTEST_MS);
    expect((await nextOf(at(1).c, 'duty-end')).why).toBe('replaced');
    const next = await auditorDuty(at(2));
    expect(next.position).toBe(2);
    at(2).c.send({ t: 'duty-ok', event });
    at(2).c.send({ t: 'attest', signed: attestationOf(at(2), next, keys) });
    expect((await nextOf(at(2).c, 'duty-end')).why).toBe('done');
    expect((await view(event))?.attestations.map((s) => s.attestation.position)).toEqual([2]);
    expect(await flags('authority-only', event)).toBe(0);
  });
});

function flip(sig: string): string {
  return `${sig[0] === 'A' ? 'B' : 'A'}${sig.slice(1)}`;
}

/** A hatched player, grown up under `MATING_SCALE`. */
async function adult(): Promise<Player> {
  const j = await join();
  const p = await rehatch(j);
  await advance(12_000);
  report(p.c, 12 * 30, CALM);
  await nextOf(p.c, 'ack');
  return p;
}

const askOf = (from: Player, to: Player, nonce = freshNonce()): MateAsk =>
  signMateAsk(from.id, {
    creature: from.creature,
    partner: to.id.playerId,
    partnerCreature: to.creature,
    nonce,
  });

async function mate(a: Player, b: Player) {
  const askA = askOf(a, b);
  a.c.send({ t: 'court', ask: askA });
  await nextOf(b.c, 'invite');
  b.c.send({ t: 'accept', ask: askOf(b, a, askA.nonce) });
  const [ma] = await Promise.all([nextOf(a.c, 'mating'), nextOf(b.c, 'mating')]);
  return ma.commit;
}
