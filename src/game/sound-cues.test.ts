import { describe, expect, it } from 'vitest';
import type { Cue } from '../audio/cues';
import type { StepEvent } from '../sim/types';
import { CUE_WATCH, CueWatch, nearestHazard } from './sound-cues';

function watch() {
  const played: { cue: Cue; at?: { x: number; y: number } }[] = [];
  const w = new CueWatch((cue, at) => played.push(at ? { cue, at } : { cue }));
  const names = () => played.map((p) => p.cue);
  return { w, played, names };
}

const hit = (cause: 'toxin' | 'uv' | 'pressure' | 'starved'): StepEvent => ({
  type: 'damage',
  creature: 'p',
  amount: 0.1,
  cause,
});

describe('CueWatch', () => {
  it('plays eat and dash on each event', () => {
    const { w, names } = watch();
    const events: StepEvent[] = [
      { type: 'eat', creature: 'p', food: 'f1', value: 1 },
      { type: 'dash', creature: 'p' },
      { type: 'eat', creature: 'p', food: 'f2', value: 1 },
    ];
    for (const e of events) w.onEvent(e, 1);
    expect(names()).toEqual(['eat', 'dash', 'eat']);
  });

  it('plays a hit at most every few ticks while damage goes on', () => {
    const { w, names } = watch();
    for (let t = 0; t < 30; t++) w.onEvent(hit('toxin'), t);
    const hurts = names().filter((c) => c === 'hurt').length;
    expect(hurts).toBe(Math.ceil(30 / CUE_WATCH.hurtGapTicks));
  });

  it('gives UV and pressure their own cue, and starvation the hit', () => {
    const { w, names } = watch();
    w.onEvent(hit('uv'), 0);
    w.onEvent(hit('pressure'), 0);
    w.onEvent(hit('starved'), 0);
    expect(names()).toEqual(['uv', 'pressure', 'hurt']);
    w.onEvent(hit('uv'), 1);
    expect(names()).toHaveLength(3);
    w.onEvent(hit('uv'), CUE_WATCH.zoneGapTicks);
    expect(names()).toEqual(['uv', 'pressure', 'hurt', 'uv']);
  });

  it('pulses low energy on entering it and slowly while it lasts', () => {
    const { w, names } = watch();
    w.vitals(0, 0.5, null);
    expect(names()).toEqual([]);
    w.vitals(1, 0.19, null);
    expect(names()).toEqual(['low-energy']);
    for (let t = 2; t < 1 + CUE_WATCH.lowGapTicks; t++) w.vitals(t, 0.1, null);
    expect(names()).toEqual(['low-energy']);
    w.vitals(1 + CUE_WATCH.lowGapTicks, 0.1, null);
    expect(names()).toEqual(['low-energy', 'low-energy']);
    // Fed again, then low again: it plays at once.
    w.vitals(200, 0.6, null);
    w.vitals(201, 0.1, null);
    expect(names()).toHaveLength(3);
  });

  it('rumbles once as a plume comes near, positioned at the plume', () => {
    const { w, played } = watch();
    const far = { x: 10, y: 0, gap: CUE_WATCH.nearGap + 5 };
    const near = { x: 10, y: 0, gap: CUE_WATCH.nearGap - 0.5 };
    w.vitals(0, 1, far);
    expect(played).toEqual([]);
    w.vitals(1, 1, near);
    expect(played).toEqual([{ cue: 'hazard-near', at: { x: 10, y: 0 } }]);
    for (let t = 2; t < 100; t++) w.vitals(t, 1, near);
    expect(played).toHaveLength(1);
    // Just past the near line is not clear yet: no flicker at the edge.
    w.vitals(100, 1, { ...near, gap: CUE_WATCH.nearGap + 0.1 });
    w.vitals(101, 1, near);
    expect(played).toHaveLength(1);
    w.vitals(102, 1, null);
    w.vitals(103 + CUE_WATCH.nearGapTicks, 1, near);
    expect(played).toHaveLength(2);
  });

  it('plays the death tone once per life, whatever the cause', () => {
    const { w, names } = watch();
    w.died();
    w.died();
    expect(names()).toEqual(['death']);
    w.reset();
    w.died();
    expect(names()).toEqual(['death', 'death']);
  });

  it('starts each life afresh', () => {
    const { w, names } = watch();
    w.onEvent(hit('toxin'), 100);
    w.vitals(100, 0.1, null);
    w.reset();
    // A new life's tick starts over at 0.
    w.onEvent(hit('toxin'), 0);
    w.vitals(0, 0.1, null);
    expect(names()).toEqual(['hurt', 'low-energy', 'hurt', 'low-energy']);
  });
});

describe('nearestHazard', () => {
  it('measures the gap between the edges in body radii and picks the nearest', () => {
    expect(nearestHazard([], 0, 0, 10)).toBeNull();
    const plumes = [
      { x: 100, y: 0, radius: 20 },
      { x: 0, y: -60, radius: 10 },
    ];
    // 60 - 10 - 10 = 40 wu, 4 radii; the first is 100 - 20 - 10 = 70 wu.
    expect(nearestHazard(plumes, 0, 0, 10)).toEqual({ x: 0, y: -60, gap: 4 });
    // Inside a plume the gap is negative.
    expect(nearestHazard(plumes, 100, 0, 10)?.gap).toBeLessThan(0);
  });
});
