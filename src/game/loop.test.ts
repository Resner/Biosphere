import { describe, expect, it } from 'vitest';
import { attachVisibilityPause, createLoop } from './loop';

function harness(maxTicksPerFrame?: number) {
  let t = 0;
  let ticks = 0;
  const alphas: number[] = [];
  const loop = createLoop({
    now: () => t,
    tick: () => {
      ticks++;
    },
    render: (alpha) => alphas.push(alpha),
    ...(maxTicksPerFrame === undefined ? {} : { maxTicksPerFrame }),
  });
  return {
    loop,
    alphas,
    advance: (ms: number) => {
      t += ms;
      loop.frame();
    },
    ticks: () => ticks,
  };
}

describe('createLoop', () => {
  it('runs exactly 30 ticks per second of 60 fps frames, with alpha in [0, 1)', () => {
    const h = harness();
    h.advance(0);
    for (let i = 0; i < 60; i++) h.advance(1000 / 60);
    expect(h.ticks()).toBe(30);
    expect(h.alphas).toHaveLength(61);
    for (const a of h.alphas) {
      expect(a).toBeGreaterThanOrEqual(0);
      expect(a).toBeLessThan(1);
    }
  });

  it('runs ticks faster or slower when the speed changes', () => {
    const h = harness();
    h.advance(0);
    h.loop.setSpeed(1.02);
    for (let i = 0; i < 600; i++) h.advance(1000 / 60);
    expect(h.ticks()).toBe(306);
    h.loop.setSpeed(0.98);
    for (let i = 0; i < 600; i++) h.advance(1000 / 60);
    expect(h.ticks()).toBe(306 + 294);
  });

  it('caps a long frame at 5 ticks and reports the dropped time', () => {
    const h = harness();
    h.advance(0);
    h.advance(2000);
    expect(h.ticks()).toBe(5);
    expect(h.loop.stats().ticks).toBe(5);
    expect(h.loop.stats().skippedMs).toBeCloseTo(1833.3, 0);
    h.advance(1000 / 30);
    expect(h.ticks()).toBe(6);
  });

  it('never catches up faster than real time after a 2 s stall (M6b T1)', () => {
    const h = harness();
    h.advance(0);
    h.advance(2000);
    for (let i = 0; i < 60; i++) h.advance(1000 / 60);
    // 5 ticks for the stalled frame, then 30 per second of real time, never a burst of more.
    expect(h.ticks()).toBe(5 + 30);
  });

  it('honours a custom tick cap', () => {
    const h = harness(2);
    h.advance(0);
    h.advance(1000);
    expect(h.ticks()).toBe(2);
  });

  it('ignores a clock that runs backwards', () => {
    const h = harness();
    h.advance(0);
    h.advance(100);
    const before = h.ticks();
    h.advance(-50);
    expect(h.ticks()).toBe(before);
  });

  it('does not tick while paused and does not catch up on resume', () => {
    const h = harness();
    h.advance(0);
    h.loop.pause();
    h.advance(10_000);
    expect(h.ticks()).toBe(0);
    expect(h.alphas).toHaveLength(1);
    h.loop.resume();
    h.advance(1000 / 30);
    expect(h.ticks()).toBe(0);
    h.advance(1000 / 30);
    expect(h.ticks()).toBe(1);
    expect(h.loop.stats().skippedMs).toBe(0);
  });
});

describe('attachVisibilityPause', () => {
  it('pauses the loop while the tab is hidden', () => {
    const target = new EventTarget();
    const doc = Object.assign(target, { hidden: false });
    const h = harness();
    const detach = attachVisibilityPause(doc, h.loop);
    h.advance(0);
    doc.hidden = true;
    doc.dispatchEvent(new Event('visibilitychange'));
    h.advance(1000);
    expect(h.ticks()).toBe(0);
    doc.hidden = false;
    doc.dispatchEvent(new Event('visibilitychange'));
    h.advance(0);
    h.advance(1000 / 30);
    expect(h.ticks()).toBe(1);
    detach();
    doc.hidden = true;
    doc.dispatchEvent(new Event('visibilitychange'));
    h.advance(1000);
    expect(h.ticks()).toBe(6); // detached: hiding no longer pauses (capped burst of 5)
  });
});
