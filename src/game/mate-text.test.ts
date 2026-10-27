import { describe, expect, it } from 'vitest';
import type { MateRefusal } from '../sim/mating';
import { bandWords, readyText, refusalText } from './mate-text';

const BANNED = /commit|ledger|checkpoint|nonce|\brecords?\b|signature|hash|genesis|beacon round/i;
const OWN: MateRefusal[] = [
  'not-active',
  'locked',
  'in-flight',
  'pending',
  'not-mature',
  'cooldown',
  'low-energy',
  'tier',
  'self',
];
const HUB = [
  'not-here',
  'pair-mismatch',
  'used',
  'expired',
  'no-court',
  'bad-signature',
  'no-creature',
  'weird-reason-9',
];

describe('refusalText', () => {
  it('says the plain reasons the spec lists', () => {
    expect(refusalText('not-mature')).toBe('Not mature yet');
    expect(refusalText('cooldown', 200_000)).toBe('Rest for 3:20');
    expect(refusalText('tier')).toBe('Too big or too small');
    expect(refusalText('low-energy')).toBe('Needs more energy');
    expect(refusalText('pending')).toBe('Already has an offspring waiting');
  });
  it('keeps the same words for a partner and names whose they are', () => {
    expect(refusalText('partner-not-mature', 0, 'Mira')).toBe('Mira: Not mature yet');
    expect(refusalText('partner-cooldown', 61_000, 'Mira')).toBe('Mira: Rest for 1:01');
    expect(refusalText('partner-pending')).toBe('Already has an offspring waiting');
  });
  it('has jargon-free words for every reason, known or not', () => {
    for (const r of [...OWN, ...OWN.map((o) => `partner-${o}`), ...HUB]) {
      const text = refusalText(r, 5000, 'Mira');
      expect(text.length).toBeGreaterThan(0);
      expect(text).not.toMatch(BANNED);
      expect(text).not.toContain('partner-');
    }
  });
});

describe('cooldown and ready words', () => {
  it('rounds the wait up to whole seconds', () => {
    expect(refusalText('cooldown', 1)).toBe('Rest for 0:01');
    expect(refusalText('cooldown', 360_000)).toBe('Rest for 6:00');
  });
  it('reads Ready to mate, or Ready in m:ss', () => {
    expect(readyText(0)).toBe('Ready to mate');
    expect(readyText(-5)).toBe('Ready to mate');
    expect(readyText(90_500)).toBe('Ready in 1:31');
  });
});

describe('bandWords', () => {
  it('turns kinship into the inbreeding words', () => {
    expect(bandWords(0)).toContain('Not related');
    expect(bandWords(0.25)).toContain('Very close');
    expect(bandWords(0.1)).not.toMatch(BANNED);
  });
});
