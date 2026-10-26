import { describe, expect, it } from 'vitest';
import { countdownText, livedText, remainingText, stageWord, whenText } from './life-text';

const BANNED = /activeMs|checkpoint|ledger|\brecords?\b|\bseq\b|hash|genesis|beacon/i;

describe('stageWord', () => {
  it('names the three stages in plain words', () => {
    expect(stageWord('young')).toBe('Young');
    expect(stageWord('mature')).toBe('Mature');
    expect(stageWord('old')).toBe('Old');
  });
});

describe('remainingText', () => {
  const MIN = 60_000;
  it('stays quiet until the last 10 minutes', () => {
    expect(remainingText(10 * MIN + 1)).toBe('');
    expect(remainingText(60 * MIN)).toBe('');
  });
  it('rounds to whole minutes below that', () => {
    expect(remainingText(10 * MIN)).toBe('About 10 min left');
    expect(remainingText(7.5 * MIN)).toBe('About 8 min left');
    expect(remainingText(61_000)).toBe('About 1 min left');
  });
  it('counts seconds in the last minute', () => {
    expect(remainingText(59_000)).toBe('About 59 s left');
    expect(remainingText(1_600)).toBe('About 2 s left');
    expect(remainingText(0)).toBe('About 0 s left');
    expect(remainingText(-5)).toBe('About 0 s left');
  });
});

describe('countdownText', () => {
  it('reads m:ss and rounds up so it never shows 0:00 early', () => {
    expect(countdownText(222_000)).toBe('Next recorded hatch in 3:42');
    expect(countdownText(59_001)).toBe('Next recorded hatch in 1:00');
    expect(countdownText(1)).toBe('Next recorded hatch in 0:01');
    expect(countdownText(3_725_000)).toBe('Next recorded hatch in 62:05');
  });
});

describe('livedText', () => {
  it('uses seconds, then minutes', () => {
    expect(livedText(0)).toBe('0 s');
    expect(livedText(42_900)).toBe('42 s');
    expect(livedText(60_000)).toBe('1 min');
    expect(livedText(125_000)).toBe('2 min 5 s');
    expect(livedText(45 * 60_000)).toBe('45 min');
    expect(livedText(75 * 60_000 + 30_000)).toBe('1 h 15 min');
  });
});

describe('whenText', () => {
  it('says how long ago in plain words', () => {
    expect(whenText(0)).toBe('just now');
    expect(whenText(30_000)).toBe('just now');
    expect(whenText(5 * 60_000)).toBe('5 min ago');
    expect(whenText(3 * 3_600_000)).toBe('3 h ago');
    expect(whenText(2 * 86_400_000)).toBe('2 days ago');
    expect(whenText(-10)).toBe('just now');
  });
});

describe('wording', () => {
  it('uses no technical words', () => {
    const lines = [
      ...(['young', 'mature', 'old'] as const).map(stageWord),
      remainingText(300_000),
      countdownText(1000),
      livedText(1_000_000),
      whenText(1_000_000),
    ];
    for (const line of lines) expect(line).not.toMatch(BANNED);
  });
});
