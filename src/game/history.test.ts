import { describe, expect, it } from 'vitest';
import type { PastLife } from '../net/protocol';
import { HISTORY_SHOWN, historyRows } from './history';

const NOW = 1_000_000_000_000;
const life = (over: Partial<PastLife> = {}): PastLife => ({
  creature: 'c'.repeat(64),
  species: 'Pale Drifter',
  cause: 'old-age',
  activeMs: 45_000,
  bornT: NOW - 3_600_000,
  diedT: NOW - 300_000,
  ...over,
});

describe('historyRows', () => {
  it('names the creature, how it died, how long it lived and when', () => {
    expect(historyRows([life()], NOW)).toEqual([
      { species: 'Pale Drifter', cause: 'Died of old age', lived: '45 s', when: '5 min ago' },
    ]);
    expect(historyRows([life({ cause: 'starved', activeMs: 125_000 })], NOW)[0]).toMatchObject({
      cause: 'Starved',
      lived: '2 min 5 s',
    });
  });

  it('keeps the order it was given and shows the last 10', () => {
    const lives = Array.from({ length: 14 }, (_, i) => life({ species: `S${i}` }));
    const rows = historyRows(lives, NOW);
    expect(rows).toHaveLength(HISTORY_SHOWN);
    expect(rows.map((r) => r.species)).toEqual(lives.slice(0, 10).map((l) => l.species));
  });

  it('is empty for no lives', () => {
    expect(historyRows([], NOW)).toEqual([]);
  });

  it('uses no technical words', () => {
    const text = JSON.stringify(historyRows([life(), life({ cause: 'toxin' })], NOW));
    expect(text).not.toMatch(/activeMs|checkpoint|ledger|hash|creature/i);
  });
});
