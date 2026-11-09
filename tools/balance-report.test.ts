import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { BalanceRun } from '../tests/balance';
import { heavyTest } from '../tests/heavy';
import { archetypeRows, balanceReport, GATE, gates, mergeRuns, topBodies } from './balance-report';

const sample = JSON.parse(
  readFileSync(new URL('../tests/fixtures/balance-sample.json', import.meta.url), 'utf8'),
) as BalanceRun;

describe('the balance report', () => {
  it('takes the top tenth of the archetype bodies, not the genesis reference', () => {
    const top = topBodies(sample);
    expect(top).toHaveLength(Math.ceil(GATE.topShare * 22));
    expect(top.map((b) => b.id)).toEqual(['flagellate-0', 'flagellate-1', 'ciliate-0']);
    expect(top.some((b) => b.archetype === 'genesis')).toBe(false);
  });

  it('judges both gates: kinds in the top, and no kind over half of it', () => {
    const [kinds, share] = gates(sample);
    expect(kinds?.ok).toBe(false); // flagellate and ciliate only
    expect(share?.ok).toBe(false); // flagellate holds 2 of 3
    const mixed: BalanceRun = {
      ...sample,
      bodies: sample.bodies.map((b) =>
        ['swimmer-0', 'armoured-0', 'hunter-0'].includes(b.id)
          ? { ...b, score: 9 + b.score / 10 }
          : b,
      ),
    };
    expect(gates(mixed).map((g) => g.ok)).toEqual([true, true]);
  });

  it('breaks ties by kills, then by a hash of the id, whatever the order of the bodies', () => {
    const tied: BalanceRun = { ...sample, bodies: sample.bodies.map((b) => ({ ...b, score: 3 })) };
    const reversed: BalanceRun = { ...tied, bodies: [...tied.bodies].reverse() };
    expect(topBodies(reversed).map((b) => b.id)).toEqual(topBodies(tied).map((b) => b.id));
    expect(topBodies(tied).every((b) => b.kills === 1)).toBe(true);
  });

  it('rows give each archetype its median, best and share of the top', () => {
    const rows = archetypeRows(sample);
    const flagellate = rows.find((r) => r.archetype === 'flagellate');
    expect(flagellate).toEqual({
      archetype: 'flagellate',
      bodies: 2,
      median: 4.375,
      best: 4.5,
      inTop: 2,
    });
    expect(rows.reduce((n, r) => n + r.inTop, 0)).toBe(3);
  });

  it('is the same text from the same JSON, and names the gates', () => {
    const text = balanceReport(sample);
    expect(balanceReport(structuredClone(sample))).toBe(text);
    expect(text).toContain('# Balance');
    expect(text).toContain('MISSED');
    expect(text).toContain('Genesis reference');
  });

  it('merges the parts of a sharded run into one fixed order', () => {
    const half = Math.floor(sample.bodies.length / 2);
    const merged = mergeRuns([
      { ...sample, bodies: sample.bodies.slice(half).reverse() },
      { ...sample, bodies: sample.bodies.slice(0, half) },
    ]);
    expect(merged.bodies).toHaveLength(sample.bodies.length);
    expect(new Set(merged.bodies.map((b) => b.id))).toEqual(
      new Set(sample.bodies.map((b) => b.id)),
    );
    expect(balanceReport(merged)).toBe(balanceReport(sample));
  });

  it('passes both gates on the committed run (the tuning gate, M14 T11)', () => {
    const run = JSON.parse(
      readFileSync(new URL('../docs/perf/balance.json', import.meta.url), 'utf8'),
    ) as BalanceRun;
    expect(gates(run).map((g) => `${g.line}: ${g.value}: ${g.ok}`)).toEqual([
      expect.stringMatching(/: true$/),
      expect.stringMatching(/: true$/),
    ]);
  });

  heavyTest('is what the committed report says', () => {
    const read = (name: string) =>
      readFileSync(new URL(`../docs/perf/${name}`, import.meta.url), 'utf8');
    expect(balanceReport(JSON.parse(read('balance.json')) as BalanceRun)).toBe(read('balance.md'));
  });
});
