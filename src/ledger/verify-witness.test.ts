import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { speedTest } from '../../tests/heavy';
import {
  AUTH_SECRET,
  commit,
  FIXTURE_KEY,
  identity,
  lineageHistory,
  PLAYERS,
  store,
  witnessSecret,
} from '../../tests/lineage-fixture';
import { KARYOTYPE_VERSION } from '../genome/karyotype';
import type { SignedCommit } from '../net/protocol-defs';
import { RULES_VERSION } from '../sim/rules';
import { type Beacon, randomnessOf, roundTime } from './drand';
import { commitmentId } from './genesis';
import { playerIdOf, publicKeyFromSecret } from './identity';
import type { ProofBundle } from './proof';
import { authoritySign, type StoredRecord } from './record';
import { type SettlementV2, type SignedSettlement, signSettlement } from './settlement';
import {
  FAMILY_TEXT,
  indexBundle,
  PROBLEM_TEXT,
  type Problem,
  problemText,
  verifyLineage,
} from './verify';
import { firstNamers, whereNamed } from './verify-chain';
import { verifyWitness } from './verify-witness';
import {
  type Attestation,
  dutyEvent,
  type SignedAttestation,
  signAttestation,
  type WitnessData,
  witnessOrder,
} from './witness';

// M10 T9: the witness family of the lineage verifier (ADR 0058) against the golden bundle, whose
// honest authority had A1's fight refereed by W from frame 40 and audited by V, the mating and
// A0's genesis audited, and B0's genesis authority-only. Each tamper re-signs what it changes
// (the authority's countersignature, a witness's signature), so only the check under test sees it.

const GOLDEN = new URL('./__golden__/lineage.json', import.meta.url);
const history = lineageHistory();
const { A0, A1, B0 } = history.ids;
const ENC = [...history.settlements.keys()][0] as string;
const MATE = commitmentId(
  (history.commits.get(history.chains.get(A1)?.[0]?.record.body.commit as string) as SignedCommit)
    .commitment,
);
const A0_COMMIT = history.chains.get(A0)?.[0]?.record.body.commit as string;
const B0_COMMIT = history.chains.get(B0)?.[0]?.record.body.commit as string;
const EVENTS = {
  enc: dutyEvent('enc', ENC),
  mating: dutyEvent('mating', MATE),
  a0: dutyEvent('genesis', A0_COMMIT),
  b0: dutyEvent('genesis', B0_COMMIT),
};

const golden = (): ProofBundle => JSON.parse(readFileSync(GOLDEN, 'utf8')) as ProofBundle;
const witnessProblems = (b: ProofBundle): Problem[] =>
  verifyLineage(b).problems.filter((p) => p.family === 'witness');
const codes = (b: ProofBundle): string[] => witnessProblems(b).map((p) => p.code);

/** Where an event's problems go: the record that first names it. */
function whereOf(b: ProofBundle, event: string): [string, number | null] {
  const index = indexBundle(b);
  const naming = firstNamers(index);
  if (event === EVENTS.enc) return whereNamed(index, naming.enc.get(ENC));
  if (event === EVENTS.mating) return whereNamed(index, naming.commit.get(MATE));
  return [event === EVENTS.a0 ? A0 : B0, 0];
}
/** The problem `code` on the event's record. */
const on = (b: ProofBundle, event: string, code: string): Problem => {
  const [creature, seq] = whereOf(b, event);
  return { creature, seq, family: 'witness', code };
};

const dataOf = (c: SignedCommit): WitnessData => c.commitment.data as unknown as WitnessData;
const commitOf = (b: ProofBundle, event: string): SignedCommit => {
  const c = b.witnessCommits.find((x) => dataOf(x).event === event);
  if (!c) throw new Error(`no witness commitment for ${event}`);
  return c;
};
const orderOf = (b: ProofBundle, c: SignedCommit): string[] =>
  witnessOrder(
    dataOf(c).pool,
    randomnessOf(b.beacons.find((x) => x.round === c.commitment.round) as Beacon),
    commitmentId(c.commitment),
  );
const attestationOf = (b: ProofBundle, event: string): SignedAttestation => {
  const a = b.attestations.find((x) => x.attestation.event === event);
  if (!a) throw new Error(`no attestation for ${event}`);
  return a;
};
const settlementV2 = (b: ProofBundle): SettlementV2 =>
  (b.settlements[0] as SignedSettlement).settlement as SettlementV2;

/** An attestation signed again by its witness after `change`. */
const resignAttestation = (s: SignedAttestation, change: (a: Attestation) => void) => {
  const a = structuredClone(s.attestation);
  change(a);
  return signAttestation(identity(witnessSecret(a.witness)), a);
};
/** The fight's settlement countersigned again after `change`, and its auditor's attestation signed again over it. */
function resettle(b: ProofBundle, change: (s: SettlementV2) => void): void {
  const s = structuredClone(settlementV2(b));
  change(s);
  const signed = signSettlement(AUTH_SECRET, s);
  b.settlements = [signed];
  b.attestations = b.attestations.map((a) =>
    a.attestation.event === EVENTS.enc
      ? resignAttestation(a, (x) => {
          x.subject = signed.hash;
        })
      : a,
  );
}
/**
 * The event's witness commitment countersigned again after `change`, with everything that names
 * it moved to its new id: the settlement's duty and the attestations, each re-signed.
 */
function recommit(b: ProofBundle, event: string, change: (c: SignedCommit['commitment']) => void) {
  const old = commitOf(b, event);
  const oldId = commitmentId(old.commitment);
  const commitment = structuredClone(old.commitment);
  change(commitment);
  const id = commitmentId(commitment);
  const signed = { ...old, commitment, authSig: authoritySign(AUTH_SECRET, id) };
  b.witnessCommits = b.witnessCommits.map((c) => (c === old ? signed : c));
  b.attestations = b.attestations.map((a) =>
    a.attestation.duty === oldId
      ? resignAttestation(a, (x) => {
          x.duty = id;
        })
      : a,
  );
  if (event === EVENTS.enc) {
    resettle(b, (s) => {
      s.duty = id;
    });
  }
}

describe('the golden lineage, witnessed', () => {
  it('holds the witness documents of an honest authority', () => {
    const b = golden();
    expect(b.v).toBe(2);
    expect(b.witnessCommits.map((c) => dataOf(c).event).sort()).toEqual(
      [EVENTS.enc, EVENTS.mating, EVENTS.a0].sort(),
    );
    expect(b.attestations.map((a) => a.attestation.event).sort()).toEqual(
      [EVENTS.enc, EVENTS.mating, EVENTS.a0].sort(),
    );
    const s = settlementV2(b);
    expect(s.v).toBe(2);
    expect(s.duty).toBe(commitmentId(commitOf(b, EVENTS.enc).commitment));
    expect(s.referees).toEqual([
      { by: 'authority', from: 0 },
      { by: history.witness.W, from: 40, position: 0 },
    ]);
    const order = orderOf(b, commitOf(b, EVENTS.enc));
    expect(order.slice(0, 2)).toEqual([history.witness.W, history.witness.V]);
    expect(attestationOf(b, EVENTS.enc).attestation).toMatchObject({
      witness: history.witness.V,
      position: 1,
      subject: (b.settlements[0] as SignedSettlement).hash,
      agree: true,
    });
  });

  it('verifies with no problems, and counts what the witnesses saw', () => {
    const report = verifyLineage(golden());
    expect(report.problems).toEqual([]);
    expect(report.witnessed).toEqual({
      events: 4,
      refereed: 1,
      audited: 3,
      authorityOnly: 1,
      overruled: 0,
      unchecked: 0,
    });
    const byEvent = new Map(report.events.map((e) => [e.event, e]));
    expect(byEvent.get(EVENTS.enc)).toMatchObject({
      refereed: true,
      audited: true,
      authorityOnly: false,
      selection: 'checked',
    });
    expect(byEvent.get(EVENTS.enc)?.creatures.sort()).toEqual([A1, B0].sort());
    expect(byEvent.get(EVENTS.mating)).toMatchObject({
      refereed: false,
      audited: true,
      selection: 'checked',
    });
    expect(byEvent.get(EVENTS.mating)?.creatures.sort()).toEqual([A0, A1, B0].sort());
    expect(byEvent.get(EVENTS.a0)).toMatchObject({ audited: true, creatures: [A0] });
    expect(byEvent.get(EVENTS.b0)).toEqual({
      event: EVENTS.b0,
      creatures: [B0],
      refereed: false,
      audited: false,
      overruled: false,
      authorityOnly: true,
      selection: 'none',
    });
  });

  it('counts a disagreeing attestation as overruled, which is no problem', () => {
    const b = golden();
    b.attestations = b.attestations.map((a) =>
      a.attestation.event === EVENTS.enc
        ? resignAttestation(a, (x) => {
            x.agree = false;
            x.code = 'root';
          })
        : a,
    );
    const report = verifyLineage(b);
    expect(report.problems).toEqual([]);
    expect(report.witnessed).toMatchObject({ audited: 2, overruled: 1, authorityOnly: 1 });
    // Still refereed by W, so not authority-only.
    expect(report.events.find((e) => e.event === EVENTS.enc)).toMatchObject({
      refereed: true,
      audited: false,
      overruled: true,
      authorityOnly: false,
    });
  });

  it('leaves every selection unchecked without the witness commitments, with no problem', () => {
    const b = golden();
    b.witnessCommits = [];
    const report = verifyLineage(b);
    expect(report.problems).toEqual([]);
    const selection = new Map(report.events.map((e) => [e.event, e.selection]));
    expect(selection).toEqual(
      new Map([
        [EVENTS.enc, 'unchecked'],
        [EVENTS.mating, 'unchecked'],
        [EVENTS.a0, 'unchecked'],
        [EVENTS.b0, 'none'],
      ]),
    );
    expect(report.witnessed).toMatchObject({ unchecked: 3, refereed: 1, audited: 3 });
  });

  it('counts a version 1 bundle as authority-only throughout', () => {
    const b = golden();
    b.witnessCommits = [];
    b.attestations = [];
    resettle(b, (s) => {
      s.referees = [{ by: 'authority', from: 0 }];
      s.duty = '';
    });
    const report = verifyLineage(b);
    expect(report.witnessed).toEqual({
      events: 4,
      refereed: 0,
      audited: 0,
      authorityOnly: 4,
      overruled: 0,
      unchecked: 0,
    });
  });
});

describe('tampered witness documents', () => {
  it("names a span's witness the draw did not pick for its place", () => {
    const b = golden();
    const other = orderOf(b, commitOf(b, EVENTS.enc))[2] as string;
    resettle(b, (s) => {
      (s.referees[1] as SettlementV2['referees'][number]).by = other;
    });
    expect(witnessProblems(b)).toEqual([on(b, EVENTS.enc, 'referee-position')]);
  });

  it('names spans out of order, not from frame 0, past the end or without a position', () => {
    const W = history.witness.W;
    const cases: [SettlementV2['referees'], string][] = [
      [
        [
          { by: 'authority', from: 0 },
          { by: W, from: 40, position: 0 },
          { by: 'authority', from: 30 },
        ],
        'spans-order',
      ],
      [
        [
          { by: 'authority', from: 5 },
          { by: W, from: 40, position: 0 },
        ],
        'spans-start',
      ],
      [
        [
          { by: W, from: 0, position: 0 },
          { by: 'authority', from: 40 },
        ],
        'spans-start',
      ],
      [
        [
          { by: 'authority', from: 0 },
          { by: W, from: 57, position: 0 },
        ],
        'spans-frames',
      ],
      [
        [
          { by: 'authority', from: 0 },
          { by: W, from: 40 },
        ],
        'spans-position',
      ],
    ];
    for (const [referees, code] of cases) {
      const b = golden();
      resettle(b, (s) => {
        s.referees = referees;
      });
      expect(codes(b), code).toContain(code);
      expect(witnessProblems(b)).toContainEqual(on(b, EVENTS.enc, code));
    }
  });

  it("names a witness commitment's countersignature that does not verify", () => {
    const b = golden();
    const c = commitOf(b, EVENTS.a0);
    const flipped = (c.authSig[0] === 'A' ? 'B' : 'A') + c.authSig.slice(1);
    b.witnessCommits = b.witnessCommits.map((x) => (x === c ? { ...c, authSig: flipped } : x));
    expect(witnessProblems(b)).toEqual([on(b, EVENTS.a0, 'witness-commit-sig')]);
    const unknown = golden();
    unknown.witnessCommits = unknown.witnessCommits.map((x) =>
      dataOf(x).event === EVENTS.a0 ? { ...x, keyId: 'AAAAAAAAAAA' } : x,
    );
    expect(codes(unknown)).toEqual(['witness-commit-key-unknown']);
  });

  it('names a pool out of order or longer than 16', () => {
    const b = golden();
    recommit(b, EVENTS.a0, (c) => {
      (c.data as unknown as WitnessData).pool.reverse();
    });
    expect(witnessProblems(b)).toEqual([on(b, EVENTS.a0, 'witness-data:pool-order')]);
    const long = golden();
    recommit(long, EVENTS.a0, (c) => {
      const data = c.data as unknown as WitnessData;
      const more = Array.from({ length: 17 - data.pool.length }, (_, i) =>
        playerIdOf(publicKeyFromSecret(new Uint8Array(32).fill(0xd0 + i))),
      );
      data.pool = [...data.pool, ...more].sort();
    });
    expect(witnessProblems(long)).toEqual([on(long, EVENTS.a0, 'witness-data:pool-size')]);
  });

  it('names a witness round already published when it was committed', () => {
    const b = golden();
    recommit(b, EVENTS.enc, (c) => {
      c.t = roundTime(c.round) + 1;
    });
    expect(witnessProblems(b)).toContainEqual(on(b, EVENTS.enc, 'witness-round-not-future'));
  });

  it("names a mating's witness round that is not the mating's", () => {
    const b = golden();
    const round = commitOf(b, EVENTS.mating).commitment.round + 1;
    const recorded = JSON.parse(
      readFileSync(new URL('../../tests/fixtures/drand/rounds.json', import.meta.url), 'utf8'),
    ) as { beacons: Beacon[] };
    b.beacons = [...b.beacons, recorded.beacons.find((x) => x.round === round) as Beacon];
    recommit(b, EVENTS.mating, (c) => {
      c.round = round;
    });
    expect(witnessProblems(b)).toContainEqual(on(b, EVENTS.mating, 'witness-round'));
  });

  it("names a witness round's missing or forged beacon", () => {
    const b = golden();
    const round = commitOf(b, EVENTS.enc).commitment.round;
    b.beacons = b.beacons.filter((x) => x.round !== round);
    expect(witnessProblems(b)).toEqual([on(b, EVENTS.enc, 'witness-beacon-missing')]);
    const forged = golden();
    forged.beacons = forged.beacons.map((x) =>
      x.round === round
        ? { ...x, signature: `${x.signature.slice(0, 95)}${x.signature.endsWith('0') ? '1' : '0'}` }
        : x,
    );
    expect(codes(forged)).toEqual(['witness-bad-beacon']);
  });

  it("names an attestation's signature, position and subject", () => {
    const sig = golden();
    sig.attestations = sig.attestations.map((a) =>
      a.attestation.event === EVENTS.mating
        ? { ...a, sig: (a.sig[0] === 'A' ? 'B' : 'A') + a.sig.slice(1) }
        : a,
    );
    expect(witnessProblems(sig)).toEqual([on(sig, EVENTS.mating, 'attest-sig')]);
    expect(verifyLineage(sig).witnessed).toMatchObject({ audited: 2, authorityOnly: 2 });

    const position = golden();
    position.attestations = position.attestations.map((a) =>
      a.attestation.event === EVENTS.enc
        ? resignAttestation(a, (x) => {
            x.position = 2;
          })
        : a,
    );
    expect(witnessProblems(position)).toEqual([on(position, EVENTS.enc, 'attest-position')]);

    // An attestation of another fight's settlement, re-signed under this event.
    const subject = golden();
    const other = structuredClone(settlementV2(subject));
    other.t += 1;
    const otherHash = signSettlement(AUTH_SECRET, other).hash;
    subject.attestations = subject.attestations.map((a) =>
      a.attestation.event === EVENTS.enc
        ? resignAttestation(a, (x) => {
            x.subject = otherHash;
          })
        : a,
    );
    expect(witnessProblems(subject)).toEqual([on(subject, EVENTS.enc, 'attest-subject')]);
    expect(verifyLineage(subject).witnessed).toMatchObject({ audited: 2, refereed: 1 });
  });

  it('names an attestation of another duty', () => {
    const b = golden();
    b.attestations = b.attestations.map((a) =>
      a.attestation.event === EVENTS.a0
        ? resignAttestation(a, (x) => {
            x.duty = 'ab'.repeat(32);
          })
        : a,
    );
    expect(witnessProblems(b)).toEqual([on(b, EVENTS.a0, 'attest-duty')]);
  });

  it('names one position used twice', () => {
    // W, the referee at position 0, also audits at position 0.
    const b = golden();
    const audit = attestationOf(b, EVENTS.enc);
    b.attestations.push(
      resignAttestation(audit, (x) => {
        x.position = 0;
        x.witness = history.witness.W;
      }),
    );
    expect(witnessProblems(b)).toEqual([on(b, EVENTS.enc, 'position-twice')]);
  });

  it('names a witness span or attestation where no witness was drawn', () => {
    const b = golden();
    b.witnessCommits = b.witnessCommits.filter((c) => dataOf(c).event !== EVENTS.enc);
    resettle(b, (s) => {
      s.duty = '';
    });
    expect(codes(b).sort()).toEqual(['attest-duty', 'referee-unselected']);
  });

  it("names a settlement's duty other than its event's commitment, and two commitments for one event", () => {
    const b = golden();
    resettle(b, (s) => {
      s.duty = '';
    });
    b.attestations = b.attestations.filter((a) => a.attestation.event !== EVENTS.enc);
    expect(codes(b)).toContain('witness-duty');

    const twice = golden();
    const c = commitOf(twice, EVENTS.a0);
    twice.witnessCommits.push(
      commit('witness', '', c.commitment.data, c.commitment.round, c.commitment.t + 1),
    );
    expect(witnessProblems(twice)).toContainEqual(on(twice, EVENTS.a0, 'witness-commit-duplicate'));

    // The settlement names the mating's commitment: one made for another event.
    const elsewhere = golden();
    const mating = commitmentId(commitOf(elsewhere, EVENTS.mating).commitment);
    resettle(elsewhere, (s) => {
      s.duty = mating;
    });
    expect(codes(elsewhere)).toContain('witness-event');
  });
});

describe('the witness family', () => {
  it('has a sentence for every code it names', () => {
    const all = [
      'spans-start',
      'spans-order',
      'spans-frames',
      'spans-position',
      'witness-commit-key-unknown',
      'witness-commit-key-not-yet',
      'witness-commit-sig',
      'witness-data',
      'witness-data:pool-size',
      'witness-data:pool-order',
      'witness-data:pool-id',
      'witness-data:event',
      'witness-data:unknown:x',
      'witness-event',
      'witness-duty',
      'witness-commit-duplicate',
      'witness-round-not-future',
      'witness-round',
      'witness-beacon-missing',
      'witness-bad-beacon',
      'referee-unselected',
      'referee-position',
      'attest-sig',
      'attest-duty',
      'attest-position',
      'attest-subject',
      'position-twice',
    ];
    for (const code of all) {
      const text = problemText({ creature: A1, seq: null, family: 'witness', code });
      expect(text, code).not.toBe(FAMILY_TEXT.witness);
      expect(text).not.toContain(code);
    }
    for (const code of Object.keys(PROBLEM_TEXT)) {
      if (/^(spans|witness|referee|attest|position)-/.test(code)) expect(all).toContain(code);
    }
  });

  speedTest('checks 64 creatures and 64 witnessed fights in under 1 s', () => {
    const b = bigWitnessed();
    expect(b.creatures).toHaveLength(64);
    expect(b.settlements).toHaveLength(64);
    verifyWitness(indexBundle(golden()), {}); // warm the pairing tables
    const started = performance.now();
    const report = verifyWitness(indexBundle(b), {});
    const ms = performance.now() - started;
    expect(report.problems).toEqual([]);
    expect(report.witnessed).toMatchObject({ refereed: 64, audited: 64, unchecked: 0 });
    console.info(`witness family: ${ms.toFixed(0)} ms for 64 fights`);
    expect(ms).toBeLessThan(1000);
  });
});

/**
 * 64 genesis creatures with 64 fights, each the golden's settlement under its own encounter id,
 * with its own witness commitment on its own recorded round, a witness span and an attestation.
 */
function bigWitnessed(): ProofBundle {
  const b = golden();
  const genome = (b.creatures[0] as ProofBundle['creatures'][number]).genome;
  const recorded = JSON.parse(
    readFileSync(new URL('../../tests/fixtures/drand/rounds.json', import.meta.url), 'utf8'),
  ) as { beacons: Beacon[] };
  const base = settlementV2(b);
  const pool = dataOf(commitOf(b, EVENTS.enc)).pool;
  const creatures: ProofBundle['creatures'] = [];
  const records: StoredRecord[] = [];
  const settlements: SignedSettlement[] = [];
  const witnessCommits: SignedCommit[] = [];
  const attestations: SignedAttestation[] = [];
  const beacons: Beacon[] = [];
  for (let i = 0; i < 64; i++) {
    const t0 = FIXTURE_KEY.from + 1_000_000 + i * 10_000;
    const first = store({
      v: 1,
      rules: RULES_VERSION,
      kind: 'genesis',
      creature: '',
      seq: 0,
      prev: '',
      owner: i % 2 === 0 ? PLAYERS.A : PLAYERS.B,
      t: t0,
      body: {
        commit: i.toString(16).padStart(64, '0'),
        round: 1 + i,
        genome: 'e'.repeat(64),
        generation: 0,
        karyotype: KARYOTYPE_VERSION,
      },
    });
    creatures.push({ id: first.hash, genome });
    records.push(first);
    const beacon = recorded.beacons[200 + i] as Beacon;
    beacons.push(beacon);
    const enc = (i + 1).toString(16).padStart(64, 'f');
    const event = dutyEvent('enc', enc);
    const c = commit('witness', '', { event, pool }, beacon.round, roundTime(beacon.round) - 1000);
    const duty = commitmentId(c.commitment);
    witnessCommits.push(c);
    const order = witnessOrder(pool, randomnessOf(beacon), duty);
    const signed = signSettlement(AUTH_SECRET, {
      ...structuredClone(base),
      enc,
      duty,
      referees: [
        { by: 'authority', from: 0 },
        { by: order[0] as string, from: 40, position: 0 },
      ],
    });
    settlements.push(signed);
    const witness = order[1] as string;
    attestations.push(
      signAttestation(identity(witnessSecret(witness)), {
        v: 1,
        kind: 'attest',
        event,
        duty,
        position: 1,
        witness,
        subject: signed.hash,
        agree: true,
      }),
    );
  }
  return {
    ...b,
    subject: creatures[0]?.id as string,
    creatures,
    records,
    commits: [],
    beacons,
    settlements,
    witnessCommits,
    attestations,
  };
}
