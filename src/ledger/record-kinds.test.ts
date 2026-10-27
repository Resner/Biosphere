import { readFileSync, writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { RULES_VERSION } from '../sim/rules';
import {
  bodyProblems,
  type LedgerRecord,
  type RecordKind,
  recordHash,
  recordProblems,
  type Status,
  transitionOutcome,
} from './record';

const GOLDEN = new URL('./__golden__/kinds.json', import.meta.url);
const OWNER = '11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo';
const PARTNER = 'qrlqoNAN6mF3o4fT2RCvu0uJ8ZeXWk5eXbq5ZGCxXQs';
const H = (c: string) => c.repeat(64);

const mateCommit: LedgerRecord['body'] = {
  commit: H('1'),
  round: 12345,
  role: 'a',
  partner: PARTNER,
  partnerCreature: H('2'),
  genome: H('3'),
  partnerGenome: H('4'),
  generation: 2,
  activeMs: 900_000,
  biomass: 4200,
  energy: 5100,
  health: 10000,
  cooldownUntilMs: 1_260_000,
};
const birth: LedgerRecord['body'] = {
  commit: H('1'),
  round: 12345,
  slot: 0,
  parents: [H('5'), H('6')],
  mates: [H('7'), H('8')],
  genome: H('9'),
  generation: 3,
  karyotype: 1,
};
const promoteChild: LedgerRecord['body'] = { role: 'child', parent: H('5') };
const promoteParent: LedgerRecord['body'] = {
  role: 'parent',
  child: H('a'),
  activeMs: 900_000,
  biomass: 4200,
  energy: 5100,
  health: 9000,
  cooldownUntilMs: 1_260_000,
};
const restore: LedgerRecord['body'] = {
  from: H('b'),
  activeMs: 900_000,
  biomass: 4200,
  energy: 5100,
  health: 9000,
  cooldownUntilMs: 1_260_000,
};

const BODIES: [RecordKind, string, LedgerRecord['body']][] = [
  ['mate-commit', 'mate-commit', mateCommit],
  ['birth', 'birth', birth],
  ['promote', 'promote-child', promoteChild],
  ['promote', 'promote-parent', promoteParent],
  ['restore', 'restore', restore],
];

function record(kind: RecordKind, body: LedgerRecord['body']): LedgerRecord {
  const base = {
    v: 1 as const,
    rules: RULES_VERSION,
    kind,
    owner: OWNER,
    t: 1_700_000_000_000,
    body,
  };
  return kind === 'birth'
    ? { ...base, creature: '', seq: 0, prev: '' }
    : { ...base, creature: H('c'), seq: 3, prev: H('d') };
}

const RECORDS = Object.fromEntries(BODIES.map(([kind, name, body]) => [name, record(kind, body)]));

function golden() {
  return Object.fromEntries(
    Object.entries(RECORDS).map(([name, r]) => [name, { record: r, hash: recordHash(r) }]),
  );
}

describe('golden records of the M5 kinds', () => {
  if (process.env.UPDATE_GOLDENS) {
    writeFileSync(
      GOLDEN,
      `${JSON.stringify({ rulesVersion: RULES_VERSION, ...golden() }, null, 1)}\n`,
    );
  }

  it('hash to the committed values', () => {
    const file = JSON.parse(readFileSync(GOLDEN, 'utf8')) as Record<string, unknown>;
    expect(file).toEqual({ rulesVersion: RULES_VERSION, ...golden() });
  });

  it('are valid records', () => {
    for (const r of Object.values(RECORDS)) expect(recordProblems(r)).toEqual([]);
  });

  it('change their hash when any body field changes', () => {
    for (const [kind, name, body] of BODIES) {
      for (const key of Object.keys(body)) {
        const value = body[key];
        const changed =
          typeof value === 'number'
            ? value + 1
            : typeof value === 'string'
              ? `${value.slice(0, -1)}${value.endsWith('f') ? 'e' : 'f'}`
              : Array.isArray(value)
                ? [...value].reverse().concat('x')
                : value;
        expect(
          recordHash(record(kind, { ...body, [key]: changed } as LedgerRecord['body'])),
          `${name}.${key}`,
        ).not.toBe(recordHash(record(kind, body)));
      }
    }
  });
});

describe('record shape of the M5 kinds', () => {
  it('shapes birth like genesis and every other new kind like a chain record', () => {
    const b = RECORDS.birth as LedgerRecord;
    expect(recordProblems({ ...b, seq: 1 })).not.toEqual([]);
    expect(recordProblems({ ...b, prev: H('a') })).not.toEqual([]);
    expect(recordProblems({ ...b, creature: H('a') })).not.toEqual([]);
    for (const name of ['mate-commit', 'promote-child', 'promote-parent', 'restore']) {
      const r = RECORDS[name] as LedgerRecord;
      expect(recordProblems({ ...r, creature: '' }), name).not.toEqual([]);
      expect(recordProblems({ ...r, prev: '' }), name).not.toEqual([]);
      expect(recordProblems({ ...r, seq: 0 }), name).not.toEqual([]);
    }
  });

  it('reports a bad body through recordProblems', () => {
    expect(recordProblems({ ...(RECORDS.restore as LedgerRecord), body: {} })).toContain(
      'body:missing:from',
    );
  });
});

describe('bodyProblems', () => {
  it('accepts the golden bodies', () => {
    for (const [kind, name, body] of BODIES) expect(bodyProblems(kind, body), name).toEqual([]);
  });

  it('leaves the M4 kinds as they were', () => {
    for (const kind of ['genesis', 'checkpoint', 'death'] as const) {
      expect(bodyProblems(kind, { anything: 1 })).toEqual([]);
    }
  });

  it('names a missing field, an extra one, a wrong type, a negative and a non-hex id', () => {
    for (const [kind, name, body] of BODIES) {
      for (const [key, value] of Object.entries(body)) {
        const { [key]: _gone, ...without } = body;
        expect(bodyProblems(kind, without), `${name} without ${key}`).toContain(`missing:${key}`);
        const wrong =
          typeof value === 'number' ? 'x' : Array.isArray(value) ? 'x' : value === 'child' ? 3 : 7;
        expect(bodyProblems(kind, { ...body, [key]: wrong }), `${name}.${key} type`).not.toEqual(
          [],
        );
        if (typeof value === 'number') {
          expect(bodyProblems(kind, { ...body, [key]: -1 }), `${name}.${key} -1`).toContain(
            `bad:${key}`,
          );
          expect(bodyProblems(kind, { ...body, [key]: 1.5 }), `${name}.${key} 1.5`).toContain(
            `bad:${key}`,
          );
        }
        if (typeof value === 'string' && /^[0-9a-f]{64}$/.test(value)) {
          expect(bodyProblems(kind, { ...body, [key]: 'zz' }), `${name}.${key} hex`).toContain(
            `bad:${key}`,
          );
          expect(
            bodyProblems(kind, { ...body, [key]: value.toUpperCase().replace(/\d/g, 'A') }),
            `${name}.${key} upper`,
          ).toContain(`bad:${key}`);
        }
      }
      expect(bodyProblems(kind, { ...body, extra: 1 }), `${name} extra`).toContain('unknown:extra');
    }
  });

  it('checks roles, slots, parents and mates', () => {
    expect(bodyProblems('mate-commit', { ...mateCommit, role: 'c' })).toContain('bad:role');
    expect(bodyProblems('mate-commit', { ...mateCommit, partner: 'short' })).toContain(
      'bad:partner',
    );
    expect(bodyProblems('birth', { ...birth, slot: 256 })).toContain('bad:slot');
    expect(bodyProblems('birth', { ...birth, parents: [H('5')] })).toContain('bad:parents');
    expect(bodyProblems('birth', { ...birth, mates: [H('7'), 'zz'] })).toContain('bad:mates');
    expect(bodyProblems('promote', { role: 'sibling' })).toContain('bad:role');
    expect(bodyProblems('promote', {})).toContain('missing:role');
    expect(bodyProblems('promote', { ...promoteChild, child: H('a') })).toContain('unknown:child');
    expect(bodyProblems('promote', { ...promoteParent, parent: H('a') })).toContain(
      'unknown:parent',
    );
  });

  it('does not take inherited names for fields', () => {
    expect(bodyProblems('restore', { ...restore, constructor: 1 })).toContain(
      'unknown:constructor',
    );
  });

  it('never throws on junk', () => {
    for (const body of [null, 1, 'x', [], { role: {} }, { role: 'child', parent: [] }]) {
      for (const kind of ['mate-commit', 'birth', 'promote', 'restore'] as const) {
        expect(() => bodyProblems(kind, body as never)).not.toThrow();
        expect(bodyProblems(kind, body as never)).not.toEqual([]);
      }
    }
  });
});

describe('transition matrix (ADR 0021)', () => {
  type Cell = [RecordKind, string | null, Status | null, Status | null];
  const STATUSES: (Status | null)[] = [null, 'pending', 'active', 'checkpoint', 'dead'];
  const ALLOWED: Cell[] = [
    ['genesis', null, null, 'active'],
    ['birth', null, null, 'pending'],
    ['checkpoint', null, 'active', 'active'],
    ['mate-commit', null, 'active', 'active'],
    ['promote', 'child', 'pending', 'active'],
    ['promote', 'parent', 'active', 'checkpoint'],
    ['restore', null, 'checkpoint', 'active'],
    ['death', null, 'active', 'dead'],
    ['death', null, 'checkpoint', 'dead'],
  ];
  const CASES: [RecordKind, string | null][] = [
    ['genesis', null],
    ['birth', null],
    ['checkpoint', null],
    ['mate-commit', null],
    ['promote', 'child'],
    ['promote', 'parent'],
    ['restore', null],
    ['death', null],
  ];

  it('accepts exactly the allowed cells, with the next status', () => {
    for (const [kind, role] of CASES) {
      for (const status of STATUSES) {
        const allowed = ALLOWED.find((c) => c[0] === kind && c[1] === role && c[2] === status);
        const got = transitionOutcome(kind, role, status);
        const label = `${kind}/${role}/${status}`;
        if (allowed) expect(got, label).toEqual({ ok: true, next: allowed[3] });
        else expect(got, label).toEqual({ ok: false, reason: `status:${status ?? 'none'}` });
      }
    }
  });

  it('refuses a promote without a known role', () => {
    expect(transitionOutcome('promote', null, 'pending')).toEqual({ ok: false, reason: 'role' });
    expect(transitionOutcome('promote', 'sibling', 'pending')).toEqual({
      ok: false,
      reason: 'role',
    });
  });
});
