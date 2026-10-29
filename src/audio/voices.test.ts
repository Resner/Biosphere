import { describe, expect, it } from 'vitest';
import { POLYPHONY, VoicePool } from './voices';

describe('VoicePool', () => {
  it('caps voices at 4 per cue and 16 in all', () => {
    expect(POLYPHONY).toEqual({ perCue: 4, total: 16 });
  });

  it('steals the oldest voice of a cue past 4', () => {
    const pool = new VoicePool();
    const ids = [0, 1, 2, 3].map((t) => pool.acquire('eat', t, 10).id);
    expect(pool.active('eat', 4)).toBe(4);
    const fifth = pool.acquire('eat', 4, 10);
    expect(fifth.stolen).toEqual([ids[0]]);
    expect(pool.active('eat', 4)).toBe(4);
    expect(pool.active(undefined, 4)).toBe(4);
  });

  it('steals the oldest voice of any cue past 16', () => {
    const pool = new VoicePool();
    const cues = ['eat', 'hurt', 'dash', 'ping'] as const;
    const first: number[] = [];
    for (let i = 0; i < 16; i++) {
      const v = pool.acquire(cues[i % 4] as string, i, 100);
      if (i === 0) first.push(v.id);
    }
    expect(pool.active(undefined, 16)).toBe(16);
    const next = pool.acquire('chat', 16, 100);
    expect(next.stolen).toEqual(first);
    expect(pool.active(undefined, 16)).toBe(16);
    expect(pool.active('chat', 16)).toBe(1);
  });

  it('frees voices once they end', () => {
    const pool = new VoicePool();
    for (let i = 0; i < 4; i++) pool.acquire('eat', 0, 1);
    expect(pool.active('eat', 0.5)).toBe(4);
    const later = pool.acquire('eat', 2, 3);
    expect(later.stolen).toEqual([]);
    expect(pool.active('eat', 2)).toBe(1);
  });

  it('releases a voice by id', () => {
    const pool = new VoicePool();
    const v = pool.acquire('eat', 0, 10);
    pool.release(v.id);
    expect(pool.active('eat', 1)).toBe(0);
  });
});
