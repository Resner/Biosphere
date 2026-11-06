import { describe, expect, it } from 'vitest';
import {
  DUEL_FRAMES,
  KEEP_DAYS,
  LOG_STEADY_LIMIT_BYTES,
  model,
  packedChars,
  type StorageMeasure,
  storageReport,
} from './storage-report';

const M: StorageMeasure = {
  hatchBytes: 2200,
  hourBytes: 2800,
  perKind: [{ kind: 'checkpoint', count: 8, bytes: 5600 }],
  commitment: { count: 5, bytes: 3700 },
  beaconBytes: 100,
  fight: { frames: 3, keptBytes: 3400, settlementBytes: 1100, prunedBytes: 1200 },
  witness: { commitBytes: 1500, attestBytes: 400 },
};

describe('the storage report', () => {
  it('packs a duel’s frames as 4-byte codes in base64', () => {
    expect(packedChars(DUEL_FRAMES)).toBe(3200);
  });

  it('puts the 200-player log steady state from the measured fixed part and the window', () => {
    const fixed = 3400 - 1100 - packedChars(3);
    const r = model(M, 200);
    expect(r.logBytes).toBe(fixed + 3200);
    expect(r.fightsPerHour).toBe(300);
    expect(r.logsSteady).toBe(300 * 24 * KEEP_DAYS * (r.logBytes + 1500));
    expect(r.logsSteady).toBeLessThan(LOG_STEADY_LIMIT_BYTES);
  });

  it('grows with the players and says when the limit is reached', () => {
    expect(model(M, 50).growthYear).toBeGreaterThan(model(M, 5).growthYear);
    expect(model(M, 200).daysToLimit).toBeLessThan(model(M, 5).daysToLimit);
  });

  it('charges every fight its witness commitment for the window and its attestation for good', () => {
    const plain = { ...M, witness: { commitBytes: 0, attestBytes: 0 } };
    expect(model(M, 200).logsSteady - model(plain, 200).logsSteady).toBe(
      300 * 24 * KEEP_DAYS * 1500,
    );
    expect(model(M, 200).growthYear - model(plain, 200).growthYear).toBe(300 * 24 * 365 * 400);
    const text = storageReport(M);
    expect(text).toContain('A witness commitment, a pool of 16');
    expect(text).toContain('An attestation (kept for good)');
  });

  it('writes a table row for 5, 50 and 200 players, and the verdict on the window', () => {
    const text = storageReport(M);
    for (const n of [5, 50, 200]) expect(text).toContain(`| ${n} |`);
    expect(text).toContain('so the 14-day window stands');
    expect(storageReport({ ...M, fight: { ...M.fight, keptBytes: 40_000 } })).toContain(
      'shorten `LOG_KEEP_DAYS`',
    );
  });
});
