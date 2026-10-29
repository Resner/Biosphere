// The budget report's text (M6 T26): `npm run report:budget` (`budget-report.mjs`) stages the budget
// scenes (`budget-scene.mjs`) on every preset, and this turns what `render.info()` read into `docs/perf/budget.md`.

import { capitalise } from '../src/game/badge';
import { PRESET_NAMES, PRESETS, type PresetName } from '../src/render/presets';

export type BudgetSceneName = 'empty' | 'crowded' | 'abyss';

/** One preset in one scene, as `render.info()` read it. */
export interface BudgetRow {
  preset: PresetName;
  scene: BudgetSceneName;
  calls: number;
  triangles: number;
  /** Render targets alive, and their colour memory in bytes. */
  targets: number;
  targetBytes: number;
  passes: readonly string[];
  /** Bodies drawn: the player's and the remotes'. */
  bodies: number;
}

export interface BudgetMeta {
  date: string;
  commit: string;
  browser: string;
}

const SCENES: Record<BudgetSceneName, string> = {
  empty: 'the twilight spawn, the player alone',
  crowded: 'the shallows (caustics, god rays), 24 bodies, a plume, carried eggs, size outlines',
  abyss: 'the abyss (glow pools, vent crystals, dark-zone sight), the same 24 bodies',
};

const MB = 1e6;
const mb = (bytes: number): string => (bytes / MB).toFixed(1);
const thousands = (n: number): string => n.toLocaleString('en-US');

/** The rows that break their preset's calls, triangles or render-target memory budget. */
export function overBudget(rows: readonly BudgetRow[]): string[] {
  const over: string[] = [];
  for (const row of rows) {
    const b = PRESETS[row.preset].budget;
    const label = `${row.preset} ${row.scene}`;
    if (row.calls > b.calls) over.push(`${label}: ${row.calls} calls > ${b.calls}`);
    if (row.triangles > b.triangles)
      over.push(`${label}: ${row.triangles} triangles > ${b.triangles}`);
    if (row.targetBytes > b.targetBytes)
      over.push(
        `${label}: ${thousands(row.targetBytes)} bytes of targets > ${thousands(b.targetBytes)}`,
      );
  }
  return over;
}

/** `docs/perf/budget.md`: per preset, each scene's draw calls, triangles, targets and memory. */
export function budgetReport(rows: readonly BudgetRow[], meta: BudgetMeta): string {
  const out: string[] = [
    '# Budget report',
    '',
    `Written by \`npm run report:budget\` on ${meta.date} at ${meta.commit} (${meta.browser}). ` +
      'Each scene is the game at a 1920×1080 drawing buffer (pixel ratio 1) with the world frozen, ' +
      'read from `render.info()` once every body is drawn. The budgets are DESIGN §12; the ' +
      'render-target memory budget holds for that drawing buffer. CI and cloud sessions render in ' +
      'software, so this is no measure of frame rate: 60 fps at the default preset is the ' +
      "owner's check on real hardware. The same scenes are asserted by `m6-budget.spec.ts`.",
    '',
    'Scenes:',
    '',
  ];
  for (const [name, text] of Object.entries(SCENES)) out.push(`- **${name}**: ${text}.`);
  for (const preset of PRESET_NAMES) {
    const b = PRESETS[preset].budget;
    const mine = rows.filter((r) => r.preset === preset);
    if (mine.length === 0) continue;
    out.push(
      '',
      `## ${capitalise(preset)}`,
      '',
      `Budget: ${b.calls} calls, ${thousands(b.triangles)} triangles, ${b.targetBytes > 0 ? `${mb(b.targetBytes)} MB of render targets` : 'no render target'}. ` +
        `Passes: ${mine[0]?.passes.length ? mine[0].passes.join(', ') : 'none (direct to the canvas)'}.`,
      '',
      '| Scene | Bodies | Draw calls | Triangles | Targets | Target memory (MB) | Within budget |',
      '|-------|--------|------------|-----------|---------|--------------------|---------------|',
    );
    for (const r of mine) {
      const ok = overBudget([r]).length === 0;
      out.push(
        `| ${r.scene} | ${r.bodies} | ${r.calls} (${Math.round((100 * r.calls) / b.calls)}%) | ` +
          `${thousands(r.triangles)} (${Math.round((100 * r.triangles) / b.triangles)}%) | ` +
          `${r.targets} | ${mb(r.targetBytes)} | ${ok ? 'yes' : '**no**'} |`,
      );
    }
  }
  const over = overBudget(rows);
  out.push('', '## Verdict', '');
  if (over.length === 0) out.push('Every preset is within its budgets in every scene.');
  else for (const line of over) out.push(`- Over budget: ${line}`);
  return `${out.join('\n')}\n`;
}
