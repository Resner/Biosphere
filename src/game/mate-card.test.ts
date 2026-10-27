import { describe, expect, it } from 'vitest';
import { withAlleles } from '../../tests/archetypes';
import { genomeToBase64url } from '../genome/codec';
import { mateHints } from '../genome/hints';
import { speciesName } from '../genome/names';
import { starterGenome } from '../genome/starter';
import { buildCreature } from '../genome/stats';
import { inspectCard } from './mate-card';

const base = starterGenome();
const carrier = withAlleles(base, { albino: [0, 1] });
const info = {
  t: 'mate-info' as const,
  partner: 'p',
  creature: 'c',
  reason: null,
  kinship: 0,
  generation: 3,
  tier: 1,
  cooldownLeftMs: 0,
};
const input = {
  name: 'Ana',
  radius: 40,
  species: speciesName(carrier),
  body: buildCreature(carrier),
  genomeText: genomeToBase64url(carrier),
  ownGenomeText: genomeToBase64url(carrier),
  info: null,
};
const BANNED = /allele|locus|genotype|punnett|homozygous|commit|ledger|checkpoint|nonce/i;

describe('inspectCard', () => {
  it('shows species, rarity, size and traits for an arrived body', () => {
    const card = inspectCard(input);
    expect(card.species).toBe(speciesName(carrier));
    expect(card.rarity).not.toBe('');
    expect(card.meta).toBe('Size 1');
    expect(card.traits.length).toBe(3);
    expect(card.verdict).toBe('');
  });

  it('says "Still arriving" for a tinted cell and shows no hints', () => {
    const card = inspectCard({ ...input, body: null, genomeText: null, species: null });
    expect(card.traits).toEqual(['Still arriving']);
    expect(card.hints).toBeNull();
  });

  it('hints equal the exact numbers from mateHints', () => {
    expect(inspectCard(input).hints).toEqual(mateHints(carrier, carrier));
  });

  it('adds generation, kinship words and the verdict once the check answers', () => {
    const ok = inspectCard({ ...input, info });
    expect(ok.meta).toBe('Size 1 · generation 3');
    expect(ok.kinship).toMatch(/Not related/);
    expect(ok.verdict).toBe('You can mate now');
    expect(ok.canMate).toBe(true);
    const no = inspectCard({
      ...input,
      info: { ...info, reason: 'partner-not-mature', kinship: 0.3 },
    });
    expect(no.verdict).toBe('Ana: Not mature yet');
    expect(no.kinship).toMatch(/Very close relatives/);
    expect(no.canMate).toBe(false);
  });

  it('uses no jargon', () => {
    const card = inspectCard({ ...input, info: { ...info, kinship: 0.15 } });
    const text = [
      card.species,
      card.meta,
      ...card.traits,
      card.kinship,
      card.verdict,
      ...(card.hints?.lines ?? []),
    ].join(' ');
    expect(text).not.toMatch(BANNED);
  });
});
