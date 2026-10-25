import { describe, expect, it } from 'vitest';
import { ENTER_DELAY_MS, enterHatches, InputController, keysToInput, mouseToInput } from './input';

const centre = { x: 400, y: 300 };

describe('mouseToInput', () => {
  it('steers east at full throttle for a far cursor', () => {
    const i = mouseToInput({ x: 700, y: 300 }, centre, 2, 10);
    expect(i).toEqual({ steer: 0, throttle: 15, dash: false });
  });

  it('coasts inside the dead zone', () => {
    expect(mouseToInput({ x: 402, y: 301 }, centre, 2, 10).throttle).toBe(0);
    expect(mouseToInput(centre, centre, 2, 10).throttle).toBe(0);
  });

  it('flips screen y into world y', () => {
    expect(mouseToInput({ x: 300, y: 200 }, centre, 2, 10).steer).toBe(96);
    expect(mouseToInput({ x: 400, y: 100 }, centre, 2, 10).steer).toBe(64);
    expect(mouseToInput({ x: 400, y: 500 }, centre, 2, 10).steer).toBe(192);
  });

  it('ramps throttle with distance', () => {
    const at = (px: number) => mouseToInput({ x: 400 + px, y: 300 }, centre, 2, 10).throttle;
    expect(at(12)).toBeGreaterThan(0);
    expect(at(12)).toBeLessThan(at(40));
    expect(at(40)).toBeLessThan(at(100));
    expect(at(100)).toBe(15);
  });
});

describe('keysToInput', () => {
  it('maps WASD to headings', () => {
    expect(keysToInput(new Set(['w']))).toEqual({ steer: 64, throttle: 15, dash: false });
    expect(keysToInput(new Set(['a']))?.steer).toBe(128);
    expect(keysToInput(new Set(['s']))?.steer).toBe(192);
    expect(keysToInput(new Set(['d']))?.steer).toBe(0);
  });

  it('blends diagonals', () => {
    expect(keysToInput(new Set(['w', 'd']))?.steer).toBe(32);
    expect(keysToInput(new Set(['w', 'a']))?.steer).toBe(96);
  });

  it('accepts arrow keys', () => {
    expect(keysToInput(new Set(['ArrowUp']))?.steer).toBe(64);
  });

  it('gives null when no movement key is held', () => {
    expect(keysToInput(new Set())).toBeNull();
    expect(keysToInput(new Set([' ', 'x']))).toBeNull();
  });

  it('coasts when opposite keys cancel', () => {
    expect(keysToInput(new Set(['w', 's']))?.throttle).toBe(0);
  });
});

describe('InputController', () => {
  const sample = (c: InputController) => c.sample(centre, 2, 10);

  it('follows the mouse until a key is held', () => {
    const c = new InputController();
    c.pointerMove(700, 300);
    expect(sample(c)).toEqual({ steer: 0, throttle: 15, dash: false });
    c.keyDown('w');
    expect(sample(c).steer).toBe(64);
    c.keyUp('w');
    expect(sample(c).steer).toBe(0);
  });

  it('coasts before the pointer has ever moved', () => {
    expect(sample(new InputController()).throttle).toBe(0);
  });

  it('latches a dash press for exactly one sample', () => {
    const c = new InputController();
    c.keyDown(' ');
    c.keyUp(' ');
    expect(sample(c).dash).toBe(true);
    expect(sample(c).dash).toBe(false);
  });

  it('ignores key repeat and letter case', () => {
    const c = new InputController();
    c.keyDown('W');
    expect(sample(c).steer).toBe(64);
    c.keyUp('w');
    expect(sample(c).throttle).toBe(0);
  });

  it('drops held keys on reset', () => {
    const c = new InputController();
    c.keyDown('d');
    c.reset();
    c.pointerMove(400, 100);
    expect(sample(c).steer).toBe(64);
  });
});

describe('InputController events', () => {
  const setup = () => {
    const win = new EventTarget();
    const doc = Object.assign(new EventTarget(), { hidden: false });
    const controller = new InputController();
    const enters: number[] = [];
    controller.attach(win as unknown as Window, doc as unknown as Document, () => enters.push(1));
    const key = (type: 'keydown' | 'keyup', k: string, repeat = false) => {
      const event = Object.assign(new Event(type, { cancelable: true }), { key: k, repeat });
      win.dispatchEvent(event);
      return event;
    };
    const held = () => controller.sample({ x: 0, y: 0 }, 1, 10);
    return { controller, doc, key, held, enters };
  };

  it('ignores auto-repeated keydowns', () => {
    const { key, held, enters } = setup();
    key('keydown', ' ', true);
    expect(held().dash).toBe(false);
    key('keydown', 'Enter', true);
    expect(enters).toHaveLength(0);
    key('keydown', ' ');
    expect(held().dash).toBe(true);
    key('keydown', 'Enter');
    expect(enters).toHaveLength(1);
  });

  it('stops the page scrolling on Space and the arrow keys only', () => {
    const { key } = setup();
    for (const k of [' ', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight']) {
      expect(key('keydown', k).defaultPrevented).toBe(true);
    }
    expect(key('keydown', 'w').defaultPrevented).toBe(false);
  });

  it('releases held keys when the tab is hidden', () => {
    const { key, held, doc } = setup();
    key('keydown', 'w');
    expect(held().throttle).toBeGreaterThan(0);
    doc.hidden = true;
    doc.dispatchEvent(new Event('visibilitychange'));
    expect(held().throttle).toBe(0);
  });
});

describe('enterHatches', () => {
  it('hatches at once from the title, after a short delay from the death screen, never in play', () => {
    expect(enterHatches('title', 0)).toBe(true);
    expect(enterHatches('dead', ENTER_DELAY_MS - 1)).toBe(false);
    expect(enterHatches('dead', ENTER_DELAY_MS)).toBe(true);
    expect(enterHatches('playing', 10_000)).toBe(false);
  });
});
