import { describe, expect, it } from 'vitest';
import { withAlleles } from '../../tests/archetypes';
import { mateHints } from './hints';
import { punnett } from './punnett';
import { starterGenome } from './starter';

const base = starterGenome();

describe('mateHints', () => {
  it('lists nothing but the surprise line for two plain parents', () => {
    const h = mateHints(base, base);
    expect(h.shows).toEqual([]);
    expect(h.lines.at(-1)).toBe('Mutations can still surprise you.');
  });

  it('gives albino 25% for two hidden carriers, equal to punnett rounded', () => {
    const carrier = withAlleles(base, { albino: [0, 1] });
    const h = mateHints(carrier, carrier);
    const albino = punnett(carrier, carrier).traits.find((t) => t.id === 'albino');
    const chance = albino?.outcomes.find((o) => o.value === 'albino')?.chance ?? 0;
    expect(chance).toBe(0.25);
    expect(h.shows).toContainEqual({ word: 'albino', percent: 25 });
    expect(h.lines[0]).toContain('albino 25%');
  });

  it('every shown percent is a punnett chance rounded to whole percent', () => {
    const odd = withAlleles(base, { albino: [0, 1], luminescence: [0, 1] });
    const all = punnett(odd, base).traits.flatMap((t) =>
      t.outcomes.map((o) => Math.round(o.chance * 100)),
    );
    for (const s of mateHints(odd, base).shows) expect(all).toContain(s.percent);
  });

  it('weak-trait chance equals one minus the chance of no load pair', () => {
    const h = mateHints(base, base);
    const none = punnett(base, base).load.reduce((n, l) => n * (1 - l.chance), 1);
    expect(h.weakPercent).toBe(Math.round((1 - none) * 100));
  });

  it('uses no jargon', () => {
    const odd = withAlleles(base, { albino: [0, 1], luminescence: [0, 1] });
    expect(mateHints(odd, odd).lines.join(' ')).not.toMatch(
      /allele|locus|genotype|punnett|homozygous/i,
    );
  });
});

describe('mateHints wording', () => {
  it('names a skin blend as "between" and never joins ranks with a bare "and"', () => {
    const grainy = withAlleles(base, { texture: [1, 1] });
    const lines = mateHints(base, grainy).lines.join(' ');
    expect(lines).toMatch(/skin between smooth and grainy/);
  });
});
