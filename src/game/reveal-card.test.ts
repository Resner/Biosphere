import { describe, expect, it } from 'vitest';
import { RARITY_TIERS } from '../genome/rarity';
import { SILHOUETTES } from '../genome/silhouette';
import {
  CARD_MS,
  RevealCardClock,
  revealCardText,
  STARS,
  shapeName,
  starsText,
} from './reveal-card';

describe('the result card', () => {
  it('gives each rarity one to four stars, in text and in words', () => {
    const tiers = RARITY_TIERS.map(([tier]) => tier);
    expect(tiers.map((t) => STARS[t])).toEqual([1, 2, 3, 4]);
    expect(starsText('common')).toEqual({ text: '★☆☆☆', label: '1 of 4 stars' });
    expect(starsText('exotic')).toEqual({ text: '★★★★', label: '4 of 4 stars' });
  });

  it('names every silhouette class in plain words', () => {
    expect(shapeName('spiny-larva')).toBe('Spiny larva');
    expect(shapeName('fan-tail')).toBe('Fan tail');
    expect(shapeName('copepod')).toBe('Copepod');
    for (const s of SILHOUETTES) expect(shapeName(s)).toMatch(/^[A-Z][a-z ]+$/);
  });

  it('reads the species, the rarity with its stars and the shape', () => {
    expect(
      revealCardText({ species: 'Velella minor', rarity: 'rare', silhouette: 'shrimp' }),
    ).toEqual({
      name: 'Velella minor',
      rarity: 'Rare',
      stars: '★★★☆',
      starsLabel: '3 of 4 stars',
      shape: 'Shrimp',
      tier: 'rare',
    });
  });

  it('shows for 3 s, or until a click or a key', () => {
    const clock = new RevealCardClock();
    expect(clock.shown(0)).toBe(false);
    clock.show(1000);
    expect(clock.shown(1000)).toBe(true);
    expect(clock.shown(1000 + CARD_MS - 1)).toBe(true);
    expect(clock.shown(1000 + CARD_MS)).toBe(false);
    clock.show(5000);
    clock.dismiss();
    expect(clock.shown(5001)).toBe(false);
  });
});
