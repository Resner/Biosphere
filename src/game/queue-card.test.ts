import { describe, expect, it } from 'vitest';
import { cardWords, lineText, ordinal, placeText, reopenText, waitText } from './queue-card';

// 2026-11-08 15:30 UTC: the next 00:00 UTC is 8.5 h away.
const NOW = Date.UTC(2026, 10, 8, 15, 30);
const UTC = () => 0;
const CET = () => 60;

describe('waitText', () => {
  it('rounds the wait to a minute, then to an hour', () => {
    expect(waitText(0)).toBe('under a minute');
    expect(waitText(59)).toBe('under a minute');
    expect(waitText(60)).toBe('about 1 min');
    expect(waitText(150)).toBe('about 3 min');
    expect(waitText(3_599)).toBe('about 1 h');
    expect(waitText(7_200)).toBe('about 2 h');
  });
});

describe('reopenText', () => {
  it('names the next 00:00 UTC in local time', () => {
    expect(reopenText(NOW, UTC)).toBe('opens at 00:00');
    expect(reopenText(NOW, CET)).toBe('opens at 01:00');
    expect(reopenText(NOW, () => -300)).toBe('opens at 19:00');
    expect(reopenText(NOW, () => 330)).toBe('opens at 05:30');
  });

  it('reads the offset at the reopening, not now (a clock change in between)', () => {
    const next = Date.UTC(2026, 10, 9);
    expect(reopenText(NOW, (ms) => (ms >= next ? 60 : 120))).toBe('opens at 01:00');
  });

  it('at 00:00 UTC exactly, names the next day', () => {
    expect(reopenText(Date.UTC(2026, 10, 9), CET)).toBe('opens at 01:00');
  });
});

describe('cardWords', () => {
  it('gives the reason, the place and the wait for each reason', () => {
    expect(cardWords({ position: 2, etaS: 150, why: 'full' }, NOW, CET)).toEqual({
      reason: 'The water is full',
      place: '2nd in line',
      wait: 'about 3 min',
    });
    expect(cardWords({ position: 1, etaS: 30_600, why: 'budget' }, NOW, CET)).toEqual({
      reason: "Today's room is used up",
      place: '1st in line',
      wait: 'opens at 01:00',
    });
    expect(cardWords({ position: 3, etaS: 0, why: 'storage' }, NOW, CET)).toEqual({
      reason: 'No room for new players right now',
      place: '3rd in line',
      wait: '',
    });
  });

  it('names each place', () => {
    expect([1, 2, 3, 4, 11, 12, 13, 21, 22, 103].map(placeText)).toEqual([
      '1st in line',
      '2nd in line',
      '3rd in line',
      '4th in line',
      '11th in line',
      '12th in line',
      '13th in line',
      '21st in line',
      '22nd in line',
      '103rd in line',
    ]);
    expect(ordinal(111)).toBe('111th');
  });
});

describe('lineText', () => {
  it('is the place and the wait in one line, as the status chip shows it', () => {
    expect(lineText({ position: 2, etaS: 60, why: 'full' }, NOW, CET)).toBe(
      '2nd in line · about 1 min',
    );
    expect(lineText({ position: 1, etaS: 30_600, why: 'budget' }, NOW, CET)).toBe(
      '1st in line · opens at 01:00',
    );
    expect(lineText({ position: 4, etaS: 0, why: 'storage' }, NOW, CET)).toBe('4th in line');
  });
});
