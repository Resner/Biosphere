import { describe, expect, it } from 'vitest';
import type { Ancestor, PastLife } from '../net/protocol';
import { missedDeath, type Opening } from './missed-death';

const life: PastLife = {
  creature: 'a'.repeat(64),
  species: 'Glassy Drifter',
  cause: 'starved',
  activeMs: 95_000,
  bornT: 1,
  diedT: 2,
};
const ancestor = { creature: 'b'.repeat(64) } as Ancestor;
const open = (over: Partial<Opening> = {}): Opening => ({
  screen: 'title',
  demo: true,
  idle: true,
  status: 'idle',
  fallback: { pending: true, ancestor: null },
  ...over,
});

describe('a death the page never saw (ADR 0076)', () => {
  it('opens on the death screen of the last life when there is something to fall back on', () => {
    expect(missedDeath(open(), [life])).toEqual({
      cause: 'starved',
      survivedSeconds: 95,
      peakBiomass: null,
      body: 'Glassy Drifter',
      by: null,
      creature: life.creature,
    });
    expect(missedDeath(open({ fallback: { pending: false, ancestor } }), [life])).not.toBeNull();
  });

  it('leaves the title alone with nothing to fall back on, or no past life', () => {
    expect(missedDeath(open({ fallback: null }), [life])).toBeNull();
    expect(missedDeath(open({ fallback: { pending: false, ancestor: null } }), [life])).toBeNull();
    expect(missedDeath(open(), [])).toBeNull();
  });

  it('never takes over a page that is playing, starting or waiting for a genesis', () => {
    for (const over of [
      { screen: 'playing' as const },
      { screen: 'dead' as const },
      { demo: false },
      { idle: false },
      { status: 'awaiting' as const },
      { status: 'practice' as const },
    ]) {
      expect(missedDeath(open(over), [life])).toBeNull();
    }
  });
});
