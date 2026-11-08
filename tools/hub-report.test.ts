import { describe, expect, it } from 'vitest';
import { flat, type HubCost, hubReport, rounded, spawnSlope } from './hub-report';

const COST: HubCost = {
  sessions: [50, 200, 500],
  msPerMessage: {
    ping: [0.015, 0.01, 0.01],
    where: [0.08, 0.09, 0.1234],
    spawn: [1.4, 1.5, 4.3],
    batch: [6.8, 6.8, 7.2],
  },
  frameMs: [0.17, 0.11, 0.11],
  attachmentBytes: { median: 569, p95: 569, max: 593 },
  clockStepMs: 1,
};

describe('the hub cost report', () => {
  it('judges a type flat when its largest size is within 1.5 times its smallest plus 0.02 ms', () => {
    expect(flat([0.08, 0.09, 0.14])).toBe(true);
    expect(flat([0.08, 0.09, 0.141])).toBe(false);
    expect(flat([0, 0, 0.02])).toBe(true);
  });

  it('rounds every time to a thousandth of a millisecond', () => {
    expect(rounded(COST).msPerMessage.where).toEqual([0.08, 0.09, 0.123]);
  });

  it('puts a row for each type, the frame step and the attachment sizes in the table', () => {
    const text = hubReport(COST);
    for (const t of ['ping', 'where', 'spawn', 'batch', 'frame step'])
      expect(text).toContain(`| ${t}`);
    expect(text).toContain('| Message | 50 seated | 200 seated | 500 seated |');
    expect(text).toContain('| 569 B | 569 B | 593 B |');
    expect(text).toContain('Every type stays within its budget');
  });

  it('states the clock’s resolution and that production cannot measure it', () => {
    const text = hubReport(COST);
    expect(text).toContain('steps by 1 ms');
    expect(text).toContain('Production cannot measure this');
  });

  it('names a type over the budget', () => {
    const text = hubReport({
      ...COST,
      msPerMessage: { ...COST.msPerMessage, ping: [0.01, 0.01, 0.2] },
    });
    expect(text).toContain('Over the budget: ping.');
    expect(text).toContain('(over the budget)');
  });

  it('prices a spawn on a line through the smallest and largest size', () => {
    const s = spawnSlope(COST);
    expect(s?.perThousand).toBeCloseTo(6.44, 1);
    expect(s?.at10k).toBeCloseTo(1.4 + (2.9 / 450) * 9950, 1);
    expect(hubReport(COST)).toContain('`spawn` is the one type that grows with the population');
  });
});
