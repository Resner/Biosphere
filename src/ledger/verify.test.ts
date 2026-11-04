import { readFileSync, writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { speedTest } from '../../tests/heavy';
import {
  bundleOf,
  FIXTURE_KEY,
  lineageHistory,
  OWNER_SECRETS,
  PLAYERS,
  resign,
  store,
} from '../../tests/lineage-fixture';
import { KARYOTYPE_VERSION } from '../genome/karyotype';
import { RULES_VERSION } from '../sim/rules';
import type { AuthorityKey, ProofBundle } from './proof';
import { authorityKeyId, authorityPublicKey, type LedgerRecord, type StoredRecord } from './record';
import {
  FAMILY_TEXT,
  type Family,
  indexBundle,
  PROBLEM_TEXT,
  type Problem,
  problemText,
  verifyLineage,
} from './verify';
import { verifyChain, verifySignatures } from './verify-chain';

// M9 T3: the chain and signature families of the lineage verifier, against the golden bundle of
// the fixture's honest history (`tests/lineage-fixture.ts`), with A1 as its subject.

const GOLDEN = new URL('./__golden__/lineage.json', import.meta.url);
const history = lineageHistory();
const { A0, B0, A1 } = history.ids;

if (process.env.UPDATE_GOLDENS) {
  writeFileSync(GOLDEN, `${JSON.stringify(bundleOf(history, A1), null, 1)}\n`);
}

const golden = (): ProofBundle => JSON.parse(readFileSync(GOLDEN, 'utf8')) as ProofBundle;

/** The chain and signature problems only: the families T4–T6 add may name more on the same tamper. */
const ofT3 = (problems: readonly Problem[]): Problem[] =>
  problems.filter((p) => p.family === 'chain' || p.family === 'signature');
const problemsOf = (b: ProofBundle, keys?: readonly AuthorityKey[]): Problem[] =>
  ofT3(verifyLineage(b, keys ? { keys } : {}).problems);
const at = (creature: string, seq: number | null, family: Family, code: string): Problem => ({
  creature,
  seq,
  family,
  code,
});

/** Index of `creature`'s record `seq` in the bundle. */
function indexOf(b: ProofBundle, creature: string, seq: number): number {
  const i = b.records.findIndex(
    (s) => (s.record.creature || s.hash) === creature && s.record.seq === seq,
  );
  if (i < 0) throw new Error(`no record ${seq} of ${creature}`);
  return i;
}
const recordOf = (b: ProofBundle, creature: string, seq: number): StoredRecord =>
  b.records[indexOf(b, creature, seq)] as StoredRecord;
/**
 * Replaces a record with `change` applied, stored again (hash and signatures redone), and relinks
 * the records after it as a forger holding the key would, so only the change itself is wrong.
 */
function rewrite(
  b: ProofBundle,
  creature: string,
  seq: number,
  change: (r: LedgerRecord) => void,
): void {
  let i = indexOf(b, creature, seq);
  const s = b.records[i] as StoredRecord;
  const record = structuredClone(s.record);
  change(record);
  let prev = resign(s, record);
  b.records[i] = prev;
  for (let next = seq + 1; ; next++) {
    i = b.records.findIndex((x) => x.record.creature === creature && x.record.seq === next);
    if (i < 0) return;
    const later = b.records[i] as StoredRecord;
    prev = resign(later, { ...later.record, prev: prev.hash });
    b.records[i] = prev;
  }
}
/** A base64url signature with its first character changed: bytes that no longer verify. */
const flip = (sig: string): string => (sig[0] === 'A' ? 'B' : 'A') + sig.slice(1);

describe('the golden lineage', () => {
  it('is pinned, and rebuilds the same', () => {
    expect(golden()).toEqual(bundleOf(lineageHistory(), A1));
  });

  it('holds what the fixture promises: A1, then A0 and B0, nearest first', () => {
    const b = golden();
    expect(b.subject).toBe(A1);
    expect(b.creatures.map((c) => c.id)).toEqual([A1, ...[A0, B0].sort()]);
    const kinds = (id: string) =>
      b.records.filter((s) => (s.record.creature || s.hash) === id).map((s) => s.record.kind);
    expect(kinds(A1)).toEqual([
      'birth',
      'promote',
      'checkpoint',
      'encounter',
      'checkpoint',
      'death',
    ]);
    // A0 is both a parent and the chain parent: its prefix runs to the promote that names A1.
    expect(kinds(A0)).toEqual(['genesis', 'checkpoint', 'checkpoint', 'mate-commit', 'promote']);
    expect(kinds(B0)).toEqual(['genesis', 'checkpoint', 'checkpoint', 'mate-commit']);
    expect(b.commits.map((c) => c.commitment.kind).sort()).toEqual(['genesis', 'genesis', 'mate']);
    expect(b.beacons).toHaveLength(3);
    expect(b.settlements).toHaveLength(1);
    const results = b.settlements[0]?.settlement.results ?? [];
    expect(results.find((r) => r.creature === B0)).toMatchObject({
      outcome: 'killed',
      egg: 'eaten',
    });
    expect(results.find((r) => r.creature === A1)?.outcome).toBe('stood');
  });

  it('verifies with no problems', () => {
    const report = verifyLineage(golden());
    expect(report.problems).toEqual([]);
    expect(report).toMatchObject({
      subject: A1,
      held: 3,
      missing: [],
      scaled: false,
      keys: 'bundle',
    });
  });

  it('verifies against the same key pinned', () => {
    const report = verifyLineage(golden(), { keys: [FIXTURE_KEY] });
    expect(report.problems).toEqual([]);
    expect(report.keys).toBe('pinned');
  });

  it("verifies A0's whole chain, its restore included", () => {
    const b = bundleOf(history, A0);
    expect(b.records.at(-1)?.record.kind).toBe('restore');
    expect(verifyLineage(b).problems).toEqual([]);
  });

  it('builds the same story under test scales, and reports a scaled world', () => {
    const scaled = lineageHistory({ lifespan: 0.05, mating: 0.01 });
    const report = verifyLineage(bundleOf(scaled, scaled.ids.A1));
    expect(ofT3(report.problems)).toEqual([]);
    expect(report.scaled).toBe(true);
    const b = golden();
    b.world.scales = { lifespan: 1, mating: 0.5 };
    expect(verifyLineage(b).scaled).toBe(true);
  });

  it('never throws, and names a bundle it cannot read', () => {
    for (const bad of [null, {}, { subject: A1, creatures: 3 }, 'x']) {
      const report = verifyLineage(bad as unknown as ProofBundle);
      expect(report.problems.map((p) => p.code)).toEqual(['unreadable']);
    }
  });
});

describe('the chain family', () => {
  it('names a changed body field (hash)', () => {
    const b = golden();
    const s = recordOf(b, A1, 3);
    s.record.body.biomass = (s.record.body.biomass as number) + 1;
    expect(problemsOf(b)).toEqual([at(A1, 3, 'chain', 'hash')]);
  });

  it('names a changed prev', () => {
    const b = golden();
    rewrite(b, A1, 5, (r) => {
      r.prev = 'f'.repeat(64);
    });
    expect(problemsOf(b)).toEqual([at(A1, 5, 'chain', 'prev')]);
  });

  it('names a seq gap', () => {
    const b = golden();
    b.records.splice(indexOf(b, A1, 2), 1);
    expect(problemsOf(b)).toEqual([at(A1, 2, 'chain', 'seq-gap')]);
  });

  it('names a second record for one seq (fork)', () => {
    const b = golden();
    const i = indexOf(b, A1, 4);
    const s = b.records[i] as StoredRecord;
    const other = structuredClone(s.record);
    other.body.biomass = (other.body.biomass as number) - 100;
    b.records.splice(i + 1, 0, resign(s, other));
    expect(problemsOf(b)).toEqual([at(A1, 4, 'chain', 'fork')]);
  });

  it('names a creature id that is not its first record’s hash', () => {
    const b = golden();
    const forged = 'c'.repeat(64);
    let prev = recordOf(b, A0, 0).hash;
    for (const [i, s] of b.records.entries()) {
      if (s.record.creature !== A0) continue;
      b.records[i] = resign(s, { ...structuredClone(s.record), creature: forged, prev });
      prev = (b.records[i] as StoredRecord).hash;
    }
    for (const c of b.creatures) if (c.id === A0) c.id = forged;
    const problems = problemsOf(b);
    expect(problems).toContainEqual(at(forged, 0, 'chain', 'creature-id'));
    // Its true first record now belongs to no held creature.
    expect(problems).toContainEqual(at(A0, 0, 'chain', 'stray'));
    expect(problems).toHaveLength(2);
  });

  it('names another owner mid-chain', () => {
    const b = golden();
    rewrite(b, A1, 2, (r) => {
      r.owner = PLAYERS.B;
    });
    expect(problemsOf(b)).toEqual([at(A1, 2, 'chain', 'owner')]);
  });

  it('names a restore on an active creature (status:active)', () => {
    const b = bundleOf(history, A0);
    const promote = recordOf(b, A0, 4);
    const restoreRecord: LedgerRecord = {
      ...structuredClone(promote.record),
      kind: 'restore',
      body: { from: A1, ...withoutRole(promote.record.body) },
    };
    b.records.splice(indexOf(b, A0, 5), 1);
    b.records[indexOf(b, A0, 4)] = store(restoreRecord, OWNER_SECRETS.A);
    expect(problemsOf(b)).toEqual([at(A0, 4, 'chain', 'status:active')]);
  });

  it('names a record of rules this build does not know', () => {
    const b = golden();
    rewrite(b, A1, 2, (r) => {
      r.rules = RULES_VERSION + 1;
    });
    expect(problemsOf(b)).toEqual([at(A1, 2, 'chain', 'rules-unknown')]);
  });

  it('names a subject that is not the first creature, and a creature with no records', () => {
    const b = golden();
    b.creatures.reverse();
    expect(problemsOf(b)).toEqual([at(A1, null, 'chain', 'subject')]);
    const c = golden();
    c.records = c.records.filter((s) => (s.record.creature || s.hash) !== B0);
    expect(problemsOf(c)).toEqual([at(B0, null, 'chain', 'no-records')]);
  });
});

const withoutRole = ({ role: _r, child: _c, ...rest }: LedgerRecord['body']) => rest;

describe('the signature family', () => {
  it('names an owner signature on a checkpoint', () => {
    const b = golden();
    const i = indexOf(b, A1, 2);
    b.records[i] = store((b.records[i] as StoredRecord).record, OWNER_SECRETS.A);
    expect(problemsOf(b)).toEqual([at(A1, 2, 'signature', 'owner-sig-refused')]);
  });

  it('names a child promote without an owner signature, and with a bad one', () => {
    const b = golden();
    recordOf(b, A1, 1).ownerSig = null;
    expect(problemsOf(b)).toEqual([at(A1, 1, 'signature', 'owner-sig-missing')]);
    const c = golden();
    const s = recordOf(c, A1, 1);
    s.ownerSig = flip(s.ownerSig as string);
    expect(problemsOf(c)).toEqual([at(A1, 1, 'signature', 'owner-sig')]);
  });

  it('names a restore without an owner signature', () => {
    const b = bundleOf(history, A0);
    recordOf(b, A0, 5).ownerSig = null;
    expect(problemsOf(b)).toEqual([at(A0, 5, 'signature', 'owner-sig-missing')]);
  });

  it('names a flipped countersignature on a record, a commitment and a settlement', () => {
    const b = golden();
    const s = recordOf(b, A1, 2);
    s.authSig = flip(s.authSig);
    expect(problemsOf(b)).toEqual([at(A1, 2, 'signature', 'auth-sig')]);

    const c = golden();
    const mate = c.commits.find((x) => x.commitment.kind === 'mate');
    if (!mate) throw new Error('no mating commitment');
    mate.authSig = flip(mate.authSig);
    // On the earliest record that names it: A0's `mate-commit`, written with B0's at one time.
    expect(problemsOf(c)).toEqual([at(A0, 3, 'signature', 'commit-sig')]);

    const d = golden();
    const settled = d.settlements[0];
    if (!settled) throw new Error('no settlement');
    settled.authSig = flip(settled.authSig);
    expect(problemsOf(d)).toEqual([at(A1, 3, 'signature', 'settlement-sig')]);
  });

  it('names a key id that is not in force', () => {
    const b = golden();
    recordOf(b, A1, 2).keyId = 'AAAAAAAA';
    expect(problemsOf(b)).toEqual([at(A1, 2, 'signature', 'key-unknown')]);
  });

  it('names a key whose id does not derive from its public key', () => {
    const b = golden();
    const other = authorityPublicKey(new Uint8Array(32).fill(0x11));
    b.keys = [{ ...FIXTURE_KEY, publicKey: other }];
    expect(problemsOf(b)).toContainEqual(at(A1, 2, 'signature', 'key-unknown'));
  });

  it("names a key whose from is after a record's t, and a commitment's first use", () => {
    const b = golden();
    const t = recordOf(b, A1, 2).record.t;
    for (const k of b.keys) k.from = t + 1;
    const problems = problemsOf(b);
    expect(problems).toContainEqual(at(A1, 2, 'signature', 'key-not-yet'));
    expect(problems).toContainEqual(at(A0, 0, 'signature', 'key-not-yet'));
    expect(problems).toContainEqual(at(A0, 0, 'signature', 'commit-key-not-yet'));
    expect(problems).toContainEqual(at(A0, 3, 'signature', 'commit-key-not-yet'));
    // Later records, and the fight settled after, are signed in time.
    expect(problems).not.toContainEqual(at(A1, 3, 'signature', 'key-not-yet'));
    expect(problems.some((p) => p.code.startsWith('settlement-'))).toBe(false);
  });

  it("names every countersignature against pinned keys that lack the bundle's key", () => {
    const secret = new Uint8Array(32).fill(0x33);
    const publicKey = authorityPublicKey(secret);
    const pinned: AuthorityKey[] = [{ id: authorityKeyId(publicKey), publicKey, from: 0 }];
    const b = golden();
    const report = verifyLineage(b, { keys: pinned });
    expect(report.keys).toBe('pinned');
    const codes = new Set(report.problems.map((p) => p.code));
    expect([...codes].sort()).toEqual(
      ['commit-key-unknown', 'key-unknown', 'settlement-key-unknown'].sort(),
    );
    expect(report.problems.filter((p) => p.code === 'key-unknown')).toHaveLength(b.records.length);
  });
});

describe('problemText', () => {
  /** Every code the chain and signature families can name; T4–T6 add theirs to `PROBLEM_TEXT`. */
  const CODES = [
    'unreadable',
    'subject',
    'no-records',
    'stray',
    'shape',
    'rules-retired',
    'rules-unknown',
    'hash',
    'creature-id',
    'seq-gap',
    'fork',
    'prev',
    'owner',
    'role',
    ...['none', 'pending', 'active', 'checkpoint', 'dead'].map((s) => `status:${s}`),
    'owner-sig-missing',
    'owner-sig-refused',
    'owner-sig',
    'key-unknown',
    'key-not-yet',
    'auth-sig',
    ...['commit', 'settlement'].flatMap((d) =>
      ['key-unknown', 'key-not-yet', 'sig'].map((c) => `${d}-${c}`),
    ),
  ];

  it('lists a sentence for every code the families name', () => {
    expect(Object.keys(PROBLEM_TEXT).sort()).toEqual(expect.arrayContaining(CODES.sort()));
  });

  it('gives one plain sentence for every listed code and every family, with no raw code in it', () => {
    const families = Object.keys(FAMILY_TEXT) as Family[];
    const texts = [
      ...Object.keys(PROBLEM_TEXT).map((code) => [code, problemText(at(A1, 0, 'chain', code))]),
      ...families.map((f) => [`${f}:unlisted-code`, problemText(at(A1, 0, f, 'unlisted-code'))]),
    ];
    for (const [code, text] of texts as [string, string][]) {
      expect(text, code).toMatch(/^[A-Z][^:\n]*\.$/);
      expect(text.split(/[.!?] /), code).toHaveLength(1);
      if (/[-:]/.test(code)) expect(text, code).not.toContain(code);
    }
    expect(problemText(at(A1, 0, 'origin', 'unlisted-code'))).toBe(FAMILY_TEXT.origin);
  });
});

/** 64 genesis creatures with 400 countersigned records in all: 16 chains of 7 and 48 of 6. */
function bigBundle(): ProofBundle {
  const b = golden();
  const genome = (b.creatures[0] as ProofBundle['creatures'][number]).genome;
  const creatures: ProofBundle['creatures'] = [];
  const records: StoredRecord[] = [];
  for (let i = 0; i < 64; i++) {
    const owner = i % 2 === 0 ? PLAYERS.A : PLAYERS.B;
    const t0 = FIXTURE_KEY.from + 1_000_000 + i * 10_000;
    const first = store({
      v: 1,
      rules: RULES_VERSION,
      kind: 'genesis',
      creature: '',
      seq: 0,
      prev: '',
      owner,
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
    let head = first;
    const length = i < 16 ? 7 : 6;
    for (let seq = 1; seq < length; seq++) {
      head = store({
        v: 1,
        rules: RULES_VERSION,
        kind: 'checkpoint',
        creature: first.hash,
        seq,
        prev: head.hash,
        owner,
        t: t0 + seq * 1000,
        body: { activeMs: seq * 1000, biomass: 10_000, energy: 10_000, health: 10_000 },
      });
      records.push(head);
    }
  }
  return {
    ...b,
    subject: creatures[0]?.id as string,
    creatures,
    records,
    commits: [],
    beacons: [],
    settlements: [],
  };
}

describe('speed', () => {
  speedTest('checks chains and signatures of 64 creatures and 400 records in under 1 s', () => {
    const b = bigBundle();
    expect(b.records).toHaveLength(400);
    const started = performance.now();
    const index = indexBundle(b);
    const problems = [...verifyChain(index, {}), ...verifySignatures(index, {})];
    const ms = performance.now() - started;
    expect(problems).toEqual([]);
    console.log('SPEED', ms);
    expect(ms).toBeLessThan(1000);
  });
});
