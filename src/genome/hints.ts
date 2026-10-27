// Plain-words mating hints (M5 T12): the exact `punnett` chances, named for a player. Like
// `describe.ts` and `explain.ts` this is user-facing wording: it says "chance the offspring will
// show", never how DNA is encoded. The numbers are `punnett`'s, rounded to whole percent.

import type { Genome } from './codec';
import { type PunnettHints, type PunnettOutcome, punnett } from './punnett';

export interface HintItem {
  word: string;
  /** Whole percent, 1-100. */
  percent: number;
}

export interface MateHints {
  /** The things the child may show, for traits where a parent carries something beyond the plain form. */
  shows: HintItem[];
  /** The chance of a weak trait, in whole percent (0 when neither parent carries one). */
  weakPercent: number;
  /** Ready-to-print lines; the last always says mutations can surprise. */
  lines: string[];
}

/** The plain form of each trait: not worth listing as a chance. */
const PLAIN: ReadonlySet<string> = new Set(['plain', 'smooth', 'none', 'normal', 'off', 'nearest']);

const WORDS: Readonly<Record<string, string>> = {
  iridescent: 'an iridescent sheen',
  oil: 'an oil-slick sheen',
  grainy: 'grainy skin',
  ridged: 'ridged skin',
  weakest: 'a taste for the weakest prey',
  largest: 'a taste for the largest prey',
  strongest: 'a taste for the strongest prey',
  rings: 'rings',
  spots: 'spots',
  stripes: 'stripes',
  bands: 'bands',
  albino: 'albino',
  pale: 'pale',
  on: 'a steady glow',
  pulse: 'a pulsing glow',
};

/** A blend of two ranks ("smooth to grainy") reads as "between"; two shown forms join with "and". */
function wordOf(value: string): string {
  if (value.includes(' to ')) return `skin between ${value.replace(' to ', ' and ')}`;
  return value
    .split('+')
    .map((part) => WORDS[part] ?? part)
    .join(' and ');
}

const percent = (chance: number): number => Math.round(chance * 100);

function isPlain(o: PunnettOutcome): boolean {
  return o.value.split(/\+| to /).every((part) => PLAIN.has(part));
}

/** What a cross of `a` and `b` may show, from the exact enumeration in `punnett`. */
export function mateHints(a: Genome, b: Genome, hints: PunnettHints = punnett(a, b)): MateHints {
  const shows: HintItem[] = [];
  for (const trait of hints.traits) {
    if (trait.outcomes.every(isPlain)) continue;
    for (const o of trait.outcomes) {
      if (isPlain(o)) continue;
      const pct = percent(o.chance);
      if (pct > 0) shows.push({ word: wordOf(o.value), percent: pct });
    }
  }
  const weakPercent = percent(1 - hints.load.reduce((none, l) => none * (1 - l.chance), 1));
  const lines: string[] = [];
  if (shows.length > 0) {
    lines.push(
      `Chance the offspring will show: ${shows.map((s) => `${s.word} ${s.percent}%`).join(', ')}`,
    );
  }
  if (weakPercent > 0) lines.push(`Chance of a weak trait: ${weakPercent}%`);
  lines.push('Mutations can still surprise you.');
  return { shows, weakPercent, lines };
}
