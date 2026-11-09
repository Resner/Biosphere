// The balance report (M14 T10, ADR 0079): `npm run sim:balance` runs the population through whole
// lives (`tests/balance.ts`) and writes `docs/perf/balance.md` and `balance.json` from the scores.
// This module is the pure part: the gates and the Markdown, built from the JSON.

import { seedFromString } from '../src/sim/prng';
import type { BalanceRun, BodyResult } from '../tests/balance';

/** The gates (M14 T10): the top share of bodies must hold enough kinds, and no kind may hold most of it. */
export const GATE = { topShare: 0.1, minArchetypes: 3, maxShare: 0.5 } as const;

const median = (values: readonly number[]): number => {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length === 0
    ? Number.NaN
    : sorted.length % 2 === 1
      ? (sorted[mid] as number)
      : ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2;
};

/**
 * Best first. A life's matings are capped by the cooldown, so many bodies tie at the ceiling:
 * ties go to the body that won more fights, then to a fixed hash of its id, never to its name.
 */
const byScore = (a: BodyResult, b: BodyResult): number =>
  b.score - a.score || b.kills - a.kills || hashId(a.id) - hashId(b.id) || (a.id < b.id ? -1 : 1);

const hashId = (id: string): number => seedFromString(`balance-tie/${id}`)[0];

/** The run's archetype bodies (not the genesis reference). */
export const gated = (run: BalanceRun): BodyResult[] =>
  run.bodies.filter((b) => b.archetype !== 'genesis');

/** The top share of the archetype bodies, best first. */
export function topBodies(run: BalanceRun): BodyResult[] {
  const bodies = gated(run).sort(byScore);
  return bodies.slice(0, Math.ceil(GATE.topShare * bodies.length));
}

export interface ArchetypeRow {
  archetype: string;
  bodies: number;
  median: number;
  best: number;
  inTop: number;
}

export function archetypeRows(run: BalanceRun): ArchetypeRow[] {
  const top = topBodies(run);
  const names = [...new Set(gated(run).map((b) => b.archetype))];
  return names.map((archetype) => {
    const mine = gated(run).filter((b) => b.archetype === archetype);
    return {
      archetype,
      bodies: mine.length,
      median: median(mine.map((b) => b.score)),
      best: Math.max(...mine.map((b) => b.score)),
      inTop: top.filter((b) => b.archetype === archetype).length,
    };
  });
}

export interface Gate {
  line: string;
  value: string;
  ok: boolean;
}

export function gates(run: BalanceRun): Gate[] {
  const top = topBodies(run);
  const rows = archetypeRows(run);
  const kinds = rows.filter((r) => r.inTop > 0).length;
  const most = rows.reduce((a, r) => (r.inTop > a.inTop ? r : a), rows[0] as ArchetypeRow);
  return [
    {
      line: `The top ${GATE.topShare * 100}% (${top.length} bodies) holds at least ${GATE.minArchetypes} archetypes`,
      value: `${kinds} archetypes`,
      ok: kinds >= GATE.minArchetypes,
    },
    {
      line: `No archetype holds more than ${GATE.maxShare * 100}% of the top`,
      value: `${most.archetype} holds ${most.inTop} of ${top.length}`,
      ok: most.inTop <= GATE.maxShare * top.length,
    },
  ];
}

const fixed = (v: number, digits = 2): string => (Number.isNaN(v) ? 'n/a' : v.toFixed(digits));

/** Counts of a field over bodies, as `a 12, b 3`, most first. */
function tally(values: readonly string[]): string {
  const counts = new Map<string, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  return (
    [...counts]
      .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
      .map(([k, n]) => `${k} ${n}`)
      .join(', ') || 'none'
  );
}

/** Deaths by cause over every life of the given bodies. */
function causes(bodies: readonly BodyResult[]): string {
  const counts = new Map<string, number>();
  for (const b of bodies)
    for (const [k, n] of Object.entries(b.ends)) counts.set(k, (counts.get(k) ?? 0) + n);
  return [...counts]
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
    .map(([k, n]) => `${k} ${n}`)
    .join(', ');
}

export function balanceReport(run: BalanceRun): string {
  const top = topBodies(run);
  const rows = archetypeRows(run).sort(
    (a, b) => b.median - a.median || (a.archetype < b.archetype ? -1 : 1),
  );
  const best = top[0]?.score ?? 0;
  const genesis = run.bodies.filter((b) => b.archetype === 'genesis').sort(byScore);
  const lines = [
    '# Balance',
    '',
    `Rules version ${run.rules}. ${gated(run).length} bodies (${run.variants} variants of each archetype), ${run.lives} lives each, on the real rules (\`tests/balance.ts\`, ADR 0079). A life's score is its matings; a body's score is the mean over its lives.`,
    '',
    '## Gates',
    '',
    '| Gate | Measured | |',
    '|---|---|---|',
    ...gates(run).map((g) => `| ${g.line} | ${g.value} | ${g.ok ? 'met' : 'MISSED'} |`),
    '',
    `${gated(run).filter((b) => b.score === best).length} bodies share the top score ${fixed(best)}; ties go to kills, then to a hash of the id.`,
    '',
    '## Archetypes',
    '',
    '| Archetype | Median score | Best score | Best ÷ top score | In the top |',
    '|---|---|---|---|---|',
    ...rows.map(
      (r) =>
        `| ${r.archetype} | ${fixed(r.median)} | ${fixed(r.best)} | ${fixed(best > 0 ? r.best / best : Number.NaN)} | ${r.inTop} |`,
    ),
    '',
    '## The top',
    '',
    '| Body | Archetype | Score | Zone |',
    '|---|---|---|---|',
    ...top.map((b) => `| ${b.id} | ${b.archetype} | ${fixed(b.score)} | ${b.zone} |`),
    '',
    '## Zones chosen',
    '',
    `All bodies: ${tally(gated(run).map((b) => b.zone))}.`,
    '',
    '## Lives ended by',
    '',
    `${causes(gated(run))}.`,
    '',
    '## Genesis reference',
    '',
    `${genesis.length} genesis bodies (not gated): median score ${fixed(median(genesis.map((b) => b.score)))}, best ${fixed(genesis[0]?.score ?? Number.NaN)}. Zones: ${tally(genesis.map((b) => b.zone))}. Lives ended by ${causes(genesis) || 'none'}.`,
    '',
  ];
  return lines.join('\n');
}

/** Joins the parts of a sharded run into one run, bodies in a fixed order. */
export function mergeRuns(parts: readonly BalanceRun[]): BalanceRun {
  const first = parts[0] as BalanceRun;
  const bodies = parts.flatMap((p) => p.bodies);
  bodies.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return { ...first, bodies };
}
