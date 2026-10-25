import { describe, expect, it, vi } from 'vitest';
import { createFieldSync } from './field';
import { createLoop } from './loop';

describe('createFieldSync', () => {
  it('refreshes once per rendered frame, whatever the number of catch-up ticks', () => {
    const refresh = vi.fn();
    const field = createFieldSync(refresh);
    field.now();
    refresh.mockClear();
    let t = 0;
    const loop = createLoop({
      now: () => t,
      tick: () => field.markDirty(),
      render: () => field.flush(),
    });
    loop.frame();
    t += (5 * 1000) / 30;
    loop.frame();
    expect(loop.stats().ticks).toBe(5);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('skips a frame that changed nothing, and now() clears the pending refresh', () => {
    const refresh = vi.fn();
    const field = createFieldSync(refresh);
    field.flush();
    field.flush();
    expect(refresh).toHaveBeenCalledTimes(1);
    field.markDirty();
    field.now();
    field.flush();
    expect(refresh).toHaveBeenCalledTimes(2);
  });
});
