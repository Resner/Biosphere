// The combat report (M7 T5, ADR 0051): `npm run report:combat` writes `docs/perf/combat.md` from the
// combat tournament (`tests/combat-tournament.ts`) and the pacing bot's foraging rate. The tuning
// gate is checked by `combat-report.test.ts`; the report is deterministic, so its hash is pinned per
// rules version.

import { Hasher } from '../src/sim/hash';
import { RULES_VERSION } from '../src/sim/rules';
import {
  ARCHETYPE_BIOMASS,
  GENESIS_BIOMASS,
  GENESIS_PAIRS,
  LAYOUTS,
  MIRROR_BIOMASS,
  MIRROR_GENOMES,
  runTournament,
  type Tournament,
} from '../tests/combat-tournament';
import { forageGainPerMinute, GROWTH_BAND } from './pacing-report';

/** The tuning gate: every line must hold (ADR 0051). */
export const GATE = {
  maxArchetypeRate: 0.7,
  minDecisivePairing: 0.65,
  mirrorEven: [0.4, 0.6],
  genesisMedianSeconds: [8, 25],
  mirrorBigger: { 1.5: 0.7, 2: 0.85 } as Record<number, number>,
  growthOverForaging: 1.5,
} as const;

export interface Measured extends Tournament {
  forage: number;
}

export const measure = (): Measured => ({ ...runTournament(), forage: forageGainPerMinute() });

const pct = (v: number): string => `${Math.round(v * 100)}%`;
const verdict = (ok: boolean): string => (ok ? 'met' : 'MISSED');

/** The gate lines, each with its measured value and whether it holds. */
export function gateLines(m: Measured): { line: string; value: string; ok: boolean }[] {
  const best = Math.max(...m.rates);
  const pairing = Math.max(...m.matrix.flat());
  const mirror = (ratio: number): number => m.mirror.find((r) => r.ratio === ratio)?.score ?? 0;
  const [lo, hi] = GATE.mirrorEven;
  const [from, to] = GATE.genesisMedianSeconds;
  return [
    {
      line: `No archetype wins more than ${pct(GATE.maxArchetypeRate)} overall`,
      value: pct(best),
      ok: best <= GATE.maxArchetypeRate,
    },
    {
      line: `One pairing is won ${pct(GATE.minDecisivePairing)} or more by one side`,
      value: pct(pairing),
      ok: pairing >= GATE.minDecisivePairing,
    },
    {
      line: `Mirror duels at 1 × go ${pct(lo)}-${pct(hi)}`,
      value: pct(mirror(1)),
      ok: mirror(1) >= lo && mirror(1) <= hi,
    },
    {
      line: `Equal genesis duels last a median of ${from}-${to} s`,
      value: `${m.genesis.medianSeconds.toFixed(1)} s`,
      ok: m.genesis.medianSeconds >= from && m.genesis.medianSeconds <= to,
    },
    ...Object.entries(GATE.mirrorBigger).map(([ratio, need]) => ({
      line: `At ${ratio} × the biomass a body wins ${pct(need)} or more of mirror duels`,
      value: pct(mirror(Number(ratio))),
      ok: mirror(Number(ratio)) >= need,
    })),
    {
      line: `Winners grow ${GATE.growthOverForaging} × as fast per minute as a forager`,
      value: `${(m.growthPerMinute / m.forage).toFixed(1)} ×`,
      ok: m.growthPerMinute >= GATE.growthOverForaging * m.forage,
    },
  ];
}

/** The report's text without its closing hash line. */
export function reportBody(m: Measured): string {
  const names = m.archetypes;
  const head = (): string => `| | ${names.join(' | ')} | overall |`;
  const rows = m.matrix.map(
    (row, i) =>
      `| **${names[i]}** | ${row.map((v, j) => (i === j ? '·' : pct(v))).join(' | ')} | **${pct(m.rates[i] as number)}** |`,
  );
  return [
    '# Combat report',
    '',
    `Written by \`npm run report:combat\` (\`tools/combat-report.ts\`); rules v${RULES_VERSION}. Every fighter flies the autopilot through the real encounter simulation, from fixed start layouts.`,
    '',
    '**Scoring.** A kill is the only win (1); an escape or the timeout leaves both standing and is a draw (½), because a fighter that gets away loses nothing.',
    '',
    '## Archetypes',
    '',
    `The ${names.length} archetypes of \`tests/archetypes.ts\` at ${ARCHETYPE_BIOMASS} biomass, every pair from ${LAYOUTS} start layouts and on both ends of the line (${2 * LAYOUTS} duels a pair). Each cell is the row's share against the column. The hand-built archetypes carry no behaviour genes: the armed or armoured ones fly the middling behaviour, the others a skittish one (aggression 0.2, caution and reflex 0.9).`,
    '',
    head(),
    `|---|${names.map(() => '---|').join('')}---|`,
    ...rows,
    '',
    '## Size',
    '',
    `Mirror duels: ${MIRROR_GENOMES} genesis bodies fight a copy of themselves of ${MIRROR_BIOMASS} biomass, on ${2 * LAYOUTS} layouts each. Both sides are stubborn (caution 0, no dashing in), so strikes alone show the size. Share of the bigger body:`,
    '',
    '| Biomass ratio | Bigger body wins |',
    '|---|---|',
    ...m.mirror.map((r) => `| ${r.ratio} × | ${pct(r.score)} |`),
    '',
    '## Fights between genesis pairs',
    '',
    `${GENESIS_PAIRS} duels between genesis bodies of ${GENESIS_BIOMASS} biomass, each flying its own behaviour genes.`,
    '',
    '| Measure | Value |',
    '|---|---|',
    `| Fight length (median, p10, p90) | ${m.genesis.medianSeconds.toFixed(1)} s, ${m.genesis.p10Seconds.toFixed(1)} s, ${m.genesis.p90Seconds.toFixed(1)} s |`,
    `| Fights that end in a kill | ${m.genesis.kills} of ${GENESIS_PAIRS} |`,
    '',
    '## Growth by kills',
    '',
    `The winners of those kills gained ${m.growthPerMinute.toFixed(0)} biomass per minute of fighting (the kill reward over the fight's length). A forager (the pacing bot, \`tools/pacing-report.ts\`, no mating, no carrion, median of 12 genesis bots) gains ${m.forage.toFixed(1)} biomass per minute between ${GROWTH_BAND[0]} and ${GROWTH_BAND[1]} biomass: killing grows ${(m.growthPerMinute / m.forage).toFixed(1)} × as fast.`,
    '',
    '## Gate',
    '',
    '| Line | Measured | Result |',
    '|---|---|---|',
    ...gateLines(m).map((g) => `| ${g.line} | ${g.value} | ${verdict(g.ok)} |`),
    '',
  ].join('\n');
}

/** A 64-bit hash of the report body, pinned per rules version by the test. */
export const reportHash = (body: string): string => new Hasher().str(body).digest();

/** The full text of `docs/perf/combat.md`. */
export function combatReport(m: Measured = measure()): string {
  const body = reportBody(m);
  return `${body}\nReport hash: \`${reportHash(body)}\` (rules v${RULES_VERSION}).\n`;
}
