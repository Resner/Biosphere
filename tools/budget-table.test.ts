import { describe, expect, it } from 'vitest';
import { type BudgetRow, budgetReport, overBudget } from './budget-table';

const row = (over: Partial<BudgetRow>): BudgetRow => ({
  preset: 'medium',
  scene: 'crowded',
  calls: 50,
  triangles: 75_000,
  targets: 6,
  targetBytes: 26_244_480,
  passes: ['scene', 'refraction', 'dof', 'bloom', 'grade', 'vignette'],
  bodies: 25,
  ...over,
});
const META = { date: '2026-10-29', commit: 'abc1234', browser: 'Chromium 140' };

describe('budget report', () => {
  const rows: BudgetRow[] = (['low', 'medium', 'high'] as const).flatMap((preset) =>
    (['empty', 'crowded', 'abyss'] as const).map((scene) =>
      row({
        preset,
        scene,
        ...(preset === 'low' ? { targets: 0, targetBytes: 0, passes: [] } : {}),
      }),
    ),
  );

  it('has a table per preset with every scene, and a verdict', () => {
    const text = budgetReport(rows, META);
    for (const heading of ['# Budget report', '## Low', '## Medium', '## High', '## Verdict']) {
      expect(text).toContain(heading);
    }
    expect(text).toContain('2026-10-29 at abc1234 (Chromium 140)');
    expect(text.match(/^\| (empty|crowded|abyss) \|/gm)).toHaveLength(9);
    expect(text).toContain('| crowded | 25 | 50 (33%) | 75,000 (25%) | 6 | 26.2 | yes |');
    expect(text).toContain(
      '80 calls, 150,000 triangles, no render target. Passes: none (direct to the canvas).',
    );
    expect(text).toContain('150 calls, 300,000 triangles, 48.0 MB of render targets.');
    expect(text).toContain('Every preset is within its budgets in every scene.');
  });

  it('names every budget a row breaks', () => {
    const bad = row({ preset: 'low', calls: 81, triangles: 150_001, targetBytes: 1 });
    expect(overBudget([bad])).toEqual([
      'low crowded: 81 calls > 80',
      'low crowded: 150001 triangles > 150000',
      'low crowded: 1 bytes of targets > 0',
    ]);
    expect(overBudget([row({ preset: 'medium', calls: 150, triangles: 300_000 })])).toEqual([]);
    const text = budgetReport([bad], META);
    expect(text).toContain('| **no** |');
    expect(text).toContain('- Over budget: low crowded: 81 calls > 80');
  });
});
