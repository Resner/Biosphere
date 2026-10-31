import { describe, expect, it } from 'vitest';
import { ALONE_AFTER_MS, ALONE_SHOW_MS, AloneHint } from './alone-hint';

describe('AloneHint', () => {
  it('shows after 8 s alone in a pond and clears when someone joins', () => {
    const hint = new AloneHint();
    expect(hint.update(0, true, 0)).toBe(false);
    expect(hint.update(ALONE_AFTER_MS - 1, true, 0)).toBe(false);
    expect(hint.update(ALONE_AFTER_MS, true, 0)).toBe(true);
    expect(hint.update(ALONE_AFTER_MS + 5000, true, 1)).toBe(false);
  });

  it('shows for 8 s and then leaves the screen clear, as a toast does (M6b T9)', () => {
    const hint = new AloneHint();
    hint.update(0, true, 0);
    expect(ALONE_SHOW_MS).toBe(8000);
    expect(hint.update(ALONE_AFTER_MS + ALONE_SHOW_MS - 1, true, 0)).toBe(true);
    expect(hint.update(ALONE_AFTER_MS + ALONE_SHOW_MS, true, 0)).toBe(false);
    expect(hint.update(600_000, true, 0)).toBe(false);
  });

  it('starts counting again when the others leave', () => {
    const hint = new AloneHint();
    hint.update(0, true, 2);
    expect(hint.update(20_000, true, 0)).toBe(false);
    expect(hint.update(20_000 + ALONE_AFTER_MS, true, 0)).toBe(true);
  });

  it('never shows outside a pond, and restarts on the next one', () => {
    const hint = new AloneHint();
    expect(hint.update(0, false, 0)).toBe(false);
    expect(hint.update(60_000, false, 0)).toBe(false);
    hint.update(61_000, true, 0);
    expect(hint.update(61_000 + ALONE_AFTER_MS - 1, true, 0)).toBe(false);
    expect(hint.update(61_000 + ALONE_AFTER_MS, true, 0)).toBe(true);
    hint.update(100_000, false, 0);
    expect(hint.update(100_001, true, 0)).toBe(false);
  });
});
