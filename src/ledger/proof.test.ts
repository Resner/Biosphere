import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { heavyTest } from '../../tests/heavy';
import { lineageHistory } from '../../tests/lineage-fixture';
import { createRng, type Rng, seedFromString } from '../sim/prng';
import {
  type FightProof,
  PROOF_CAPS,
  PROOF_MAX_BYTES,
  PROOF_MAX_CREATURES,
  type ProofBundle,
  parseFightProof,
  parseProofBundle,
} from './proof';
import type { FightLog, SignedSettlement } from './settlement';

// M9 T3: proof bundles and fight proofs from untrusted JSON.

const GOLDEN_TEXT = readFileSync(new URL('./__golden__/lineage.json', import.meta.url), 'utf8');
const golden = (): ProofBundle => JSON.parse(GOLDEN_TEXT) as ProofBundle;

describe('parseProofBundle', () => {
  it('round-trips the golden, from its text and from its value', () => {
    expect(parseProofBundle(golden())).toEqual(golden());
    expect(parseProofBundle(GOLDEN_TEXT)).toEqual(golden());
  });

  it(`refuses ${PROOF_MAX_CREATURES + 1} creatures`, () => {
    const b = golden();
    const one = b.creatures[0] as ProofBundle['creatures'][number];
    expect(parseProofBundle({ ...b, creatures: Array(PROOF_MAX_CREATURES).fill(one) })).not.toBe(
      null,
    );
    expect(
      parseProofBundle({ ...b, creatures: Array(PROOF_MAX_CREATURES + 1).fill(one) }),
    ).toBeNull();
  });

  it('refuses a 600 KB string, and any bundle whose JSON is over the cap', () => {
    const b = golden();
    expect(parseProofBundle({ ...b, subject: 'a'.repeat(600_000) })).toBeNull();
    expect(parseProofBundle(JSON.stringify({ ...b, subject: 'a'.repeat(600_000) }))).toBeNull();
    // Records repeated past 512 KB, though far under the records' own cap: only the size refuses it.
    const copies = Math.ceil(PROOF_MAX_BYTES / JSON.stringify(b.records).length) + 1;
    const padded = { ...b, records: Array.from({ length: copies }, () => b.records).flat() };
    expect(padded.records.length).toBeLessThan(4096);
    expect(parseProofBundle(padded)).toBeNull();
    expect(parseProofBundle(JSON.stringify(padded))).toBeNull();
    const under = { ...b, records: Array.from({ length: copies - 4 }, () => b.records).flat() };
    expect(JSON.stringify(under).length).toBeLessThan(PROOF_MAX_BYTES);
    expect(parseProofBundle(under)).not.toBeNull();
  });

  it('refuses a non-hex id, wherever it is', () => {
    const upper = (s: string) => s.toUpperCase();
    const cases: ((b: ProofBundle) => void)[] = [
      (b) => {
        b.subject = upper(b.subject);
      },
      (b) => {
        (b.creatures[1] as ProofBundle['creatures'][number]).id = 'xyz';
      },
      (b) => {
        const r = (b.records[1] as ProofBundle['records'][number]).record;
        r.creature = upper(r.creature);
      },
      (b) => {
        (b.records[1] as ProofBundle['records'][number]).hash = 'g'.repeat(64);
      },
      (b) => {
        b.more = ['0'.repeat(63)];
      },
      (b) => {
        const s = b.settlements[0] as ProofBundle['settlements'][number];
        s.settlement.enc = upper(s.settlement.enc);
      },
    ];
    for (const [i, change] of cases.entries()) {
      const b = golden();
      change(b);
      expect(parseProofBundle(b), `case ${i}`).toBeNull();
    }
  });

  it('refuses a record that recordProblems refuses, an unknown field and a bad genome text', () => {
    const cases: ((b: ProofBundle) => void)[] = [
      (b) => {
        (b.records[2] as ProofBundle['records'][number]).record.body.extra = 1;
      },
      (b) => {
        (b as unknown as Record<string, unknown>).extra = 1;
      },
      (b) => {
        (b.creatures[0] as ProofBundle['creatures'][number]).genome = 'A'.repeat(594);
      },
      (b) => {
        (b.keys[0] as ProofBundle['keys'][number]).from = -1;
      },
      (b) => {
        b.world.scales.lifespan = 1.5;
      },
      (b) => {
        b.world.scales.mating = 0;
      },
      (b) => {
        (b.beacons[0] as ProofBundle['beacons'][number]).signature = 'ab';
      },
      (b) => {
        (b.commits[0] as ProofBundle['commits'][number]).commitment.data = { x: 0.5 };
      },
    ];
    for (const [i, change] of cases.entries()) {
      const b = golden();
      change(b);
      expect(parseProofBundle(b), `case ${i}`).toBeNull();
    }
  });

  it('reads a version 1 bundle as version 2 with no witness documents', () => {
    const { witnessCommits: _c, attestations: _a, ...rest } = golden();
    const v1 = { ...rest, v: 1 };
    expect(parseProofBundle(v1)).toEqual({ ...golden(), witnessCommits: [], attestations: [] });
    // Version 1 has neither list, and version 2 has both.
    expect(parseProofBundle({ ...golden(), v: 1 })).toBeNull();
    expect(parseProofBundle({ ...rest, v: 2 })).toBeNull();
    expect(parseProofBundle({ ...golden(), v: 3 })).toBeNull();
  });

  it('caps the witness lists: 1,024 commitments and 2,048 attestations', () => {
    const b = golden();
    const c = b.witnessCommits[0] as ProofBundle['witnessCommits'][number];
    const a = b.attestations[0] as ProofBundle['attestations'][number];
    expect(PROOF_CAPS.witnessCommits).toBe(1024);
    expect(PROOF_CAPS.attestations).toBe(2048);
    const commits = (n: number) => ({ ...b, witnessCommits: Array(n).fill(c) });
    const attestations = (n: number) => ({ ...b, attestations: Array(n).fill(a) });
    expect(parseProofBundle(commits(1025))).toBeNull();
    expect(parseProofBundle(commits(100))?.witnessCommits).toHaveLength(100);
    expect(parseProofBundle(attestations(2049))).toBeNull();
    expect(parseProofBundle(attestations(100))?.attestations).toHaveLength(100);
  });

  it('keeps witness commitments apart from genesis and mating ones, and checks attestations', () => {
    const cases: ((b: ProofBundle) => void)[] = [
      (b) => {
        b.commits.push(b.witnessCommits[0] as ProofBundle['commits'][number]);
      },
      (b) => {
        b.witnessCommits.push(b.commits[0] as ProofBundle['commits'][number]);
      },
      (b) => {
        (b.witnessCommits[0] as ProofBundle['commits'][number]).commitment.owner = 'x';
      },
      (b) => {
        (b.attestations[0] as ProofBundle['attestations'][number]).attestation.position = 16;
      },
      (b) => {
        (b.attestations[0] as unknown as Record<string, unknown>).extra = 1;
      },
      (b) => {
        const s = (b.settlements[0] as ProofBundle['settlements'][number]).settlement;
        (s as unknown as Record<string, unknown>).referee = 'authority';
      },
      (b) => {
        const s = (b.settlements[0] as ProofBundle['settlements'][number]).settlement;
        (s as unknown as Record<string, unknown>).duty = 'x';
      },
      (b) => {
        const s = (b.settlements[0] as ProofBundle['settlements'][number]).settlement;
        (s as unknown as Record<string, unknown>).referees = [];
      },
      (b) => {
        const s = (b.settlements[0] as ProofBundle['settlements'][number]).settlement;
        (s as unknown as Record<string, unknown>).referees = [{ by: 'someone', from: 0 }];
      },
      (b) => {
        const s = (b.settlements[0] as ProofBundle['settlements'][number]).settlement;
        (s as unknown as Record<string, unknown>).referees = [
          { by: 'authority', from: 0, extra: 1 },
        ];
      },
    ];
    for (const [i, change] of cases.entries()) {
      const b = golden();
      change(b);
      expect(parseProofBundle(b), `case ${i}`).toBeNull();
    }
  });

  heavyTest('never throws on 10k fuzzed JSON values', () => {
    const rng = createRng(seedFromString('proof-fuzz'), 'fuzz');
    const base = golden();
    let parsed = 0;
    for (let i = 0; i < 10_000; i++) {
      const value = i % 2 === 0 ? randomValue(rng, 3) : mutate(rng, structuredClone(base));
      const out = parseProofBundle(i % 4 === 1 ? JSON.stringify(value) : value);
      if (out) parsed++;
    }
    // Some mutations keep a valid shape: those parse, the rest are refused.
    expect(parsed).toBeGreaterThan(0);
    expect(parsed).toBeLessThan(5_000);
  });
});

describe('parseFightProof', () => {
  const history = lineageHistory();
  const [enc, settlement] = [...history.settlements][0] as [string, SignedSettlement];
  const proof = (): FightProof => ({
    settlement: structuredClone(settlement),
    log: structuredClone(history.logs.get(enc) ?? null),
  });

  it('round-trips a fight with its log, and one whose log was pruned', () => {
    expect(parseFightProof(proof())).toEqual(proof());
    expect(parseFightProof(JSON.stringify(proof()))).toEqual(proof());
    expect(parseFightProof({ ...proof(), log: null })).toEqual({ ...proof(), log: null });
  });

  it('refuses a bad input, a stray field, a short start and a join of another fight', () => {
    const cases: ((log: FightLog, p: FightProof) => void)[] = [
      (log) => {
        (log.frames[3] as (number | null)[])[0] = 2 ** 32;
      },
      (log) => {
        (log.frames as unknown[]).push('x');
      },
      (_, p) => {
        (p.settlement.settlement as unknown as Record<string, unknown>).extra = 1;
      },
      (log) => {
        log.start.fighters.pop();
      },
      (log) => {
        const fighter = log.start.fighters[0] as FightLog['start']['fighters'][number];
        log.joins.push({ t: 'enc-join', enc: '0'.repeat(64), f: 1, fighter });
      },
      (log) => {
        (log.start.fighters[0] as FightLog['start']['fighters'][number]).worth = 0.3;
      },
    ];
    for (const [i, change] of cases.entries()) {
      const p = proof();
      change(p.log as FightLog, p);
      expect(parseFightProof(p), `case ${i}`).toBeNull();
    }
  });

  it('never throws on fuzzed values', () => {
    const rng = createRng(seedFromString('fight-fuzz'), 'fuzz');
    for (let i = 0; i < 2_000; i++) {
      const value = i % 2 === 0 ? randomValue(rng, 3) : mutate(rng, proof());
      expect(() => parseFightProof(value)).not.toThrow();
    }
  });
});

const ATOMS = (rng: Rng): unknown[] => [
  null,
  true,
  0,
  -1,
  1.5,
  2 ** 53,
  Number.NaN,
  '',
  'x',
  '0'.repeat(64),
  'A'.repeat(rng.int(0, 700)),
  [],
  {},
];

/** A random JSON-like value. */
function randomValue(rng: Rng, depth: number): unknown {
  const kind = depth <= 0 ? 0 : rng.int(0, 2);
  if (kind === 0) {
    const atoms = ATOMS(rng);
    return atoms[rng.int(0, atoms.length - 1)];
  }
  if (kind === 1) return Array.from({ length: rng.int(0, 4) }, () => randomValue(rng, depth - 1));
  const keys = ['v', 'kind', 'subject', 'records', 'record', 'body', 'settlement', 'log', 't'];
  const out: Record<string, unknown> = {};
  for (let i = rng.int(0, 4); i > 0; i--) {
    out[keys[rng.int(0, keys.length - 1)] as string] = randomValue(rng, depth - 1);
  }
  return out;
}

/** `value` with one random leaf or member replaced or removed, somewhere down its tree. */
function mutate<T>(rng: Rng, value: T): T {
  let node: unknown = value;
  for (let depth = 0; depth < 8; depth++) {
    if (typeof node !== 'object' || node === null) break;
    const keys = Object.keys(node);
    if (keys.length === 0) break;
    const key = keys[rng.int(0, keys.length - 1)] as string;
    const child = (node as Record<string, unknown>)[key];
    if (typeof child !== 'object' || child === null || rng.next() < 0.2) {
      if (rng.next() < 0.3) delete (node as Record<string, unknown>)[key];
      else (node as Record<string, unknown>)[key] = randomValue(rng, 1);
      break;
    }
    node = child;
  }
  return value;
}
