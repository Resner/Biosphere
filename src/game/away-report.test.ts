import { describe, expect, it } from 'vitest';
import type { FightReport, PastLife } from '../net/protocol';
import { AwayReport, EGG_EATEN_AWAY, reportLines, YOUR_CREATURE } from './away-report';

// M8 T12: a fight settled while the player was away is told once, in plain words.

const ENC = 'e'.repeat(64);
const report = (over: Partial<FightReport> = {}): FightReport => ({
  enc: ENC,
  outcome: 'stood',
  cause: null,
  by: null,
  egg: 'none',
  eggBy: null,
  frames: 120,
  ...over,
});
const past = (species: string): PastLife => ({
  creature: 'c'.repeat(64),
  species,
  cause: 'killed',
  activeMs: 1000,
  bornT: 0,
  diedT: 1,
});

describe('reportLines', () => {
  it('gives each kind its line', () => {
    expect(reportLines(report({ outcome: 'killed', cause: 'killed', by: 'Ada' }), 'Velo')).toEqual([
      'While you were away, Velo was killed by Ada',
    ]);
    expect(reportLines(report({ outcome: 'killed', cause: 'killed' }), 'Velo')).toEqual([
      'While you were away, Velo was killed',
    ]);
    expect(reportLines(report({ outcome: 'died', cause: 'starved' }), 'Velo')).toEqual([
      'While you were away, Velo died of hunger',
    ]);
    expect(reportLines(report({ outcome: 'died', cause: 'toxin' }), 'Velo')).toEqual([
      'While you were away, Velo died of poison',
    ]);
    expect(reportLines(report({ outcome: 'escaped' }), 'Velo')).toEqual([
      'While you were away, Velo escaped a fight',
    ]);
    expect(reportLines(report({ outcome: 'stood' }), 'Velo')).toEqual([
      'While you were away, Velo held its own in a fight',
    ]);
  });

  it('adds the eaten egg', () => {
    expect(reportLines(report({ egg: 'eaten', eggBy: 'Ada' }), 'Velo')).toEqual([
      'While you were away, Velo held its own in a fight',
      EGG_EATEN_AWAY,
    ]);
    expect(EGG_EATEN_AWAY).toBe('Your egg was eaten while you were away');
  });
});

describe('AwayReport', () => {
  it('tells a report once, and nothing for a life without one', () => {
    const shown: string[][] = [];
    const away = new AwayReport((lines) => shown.push(lines));
    expect(away.life(undefined, 'Velo')).toBe(false);
    expect(away.told).toBeNull();
    const r = report({ outcome: 'escaped' });
    expect(away.life(r, 'Velo')).toBe(true);
    expect(away.life(r, 'Velo')).toBe(false);
    expect(away.life(undefined, 'Velo')).toBe(false);
    expect(shown).toEqual([['While you were away, Velo escaped a fight']]);
    expect(away.told).toEqual({ ...r, lines: ['While you were away, Velo escaped a fight'] });
  });

  it('names a creature it did not know from the history that follows, once', () => {
    const shown: [string[], boolean][] = [];
    const away = new AwayReport((lines, fresh) => shown.push([lines, fresh]));
    away.history([past('Early')]);
    expect(shown).toEqual([]);
    away.life(report({ outcome: 'killed', cause: 'killed', by: 'Ada' }), null);
    expect(away.told?.lines).toEqual([`While you were away, ${YOUR_CREATURE} was killed by Ada`]);
    away.history([past('Velo'), past('Older')]);
    away.history([past('Other')]);
    expect(away.told?.lines).toEqual(['While you were away, Velo was killed by Ada']);
    expect(shown.map(([, fresh]) => fresh)).toEqual([true, false]);
  });

  it('a report told with its species keeps it', () => {
    const away = new AwayReport(() => {});
    away.life(report(), 'Velo');
    away.history([past('Other')]);
    expect(away.told?.lines).toEqual(['While you were away, Velo held its own in a fight']);
  });
});
