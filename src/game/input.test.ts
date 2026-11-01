import { describe, expect, it } from 'vitest';
import {
  ENTER_DELAY_MS,
  enterHatches,
  InputController,
  keysToInput,
  mouseToInput,
  wheelInput,
} from './input';

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

  it('coasts after the last movement key is released until the pointer moves again', () => {
    const c = new InputController();
    c.pointerMove(700, 300);
    c.keyDown('w');
    c.keyUp('w');
    expect(sample(c).throttle).toBe(0);
    c.pointerMove(701, 300);
    expect(sample(c)).toEqual({ steer: 0, throttle: 15, dash: false });
  });

  it('keeps a held key above the pointer, and the pointer wins back once the key is released and it has moved', () => {
    const c = new InputController();
    c.keyDown('d');
    c.pointerMove(400, 100);
    expect(sample(c).steer).toBe(0);
    c.keyUp('d');
    expect(sample(c).steer).toBe(64);
  });

  it('stops following a pointer that left the window', () => {
    const c = new InputController();
    c.pointerMove(700, 300);
    c.pointerLeave();
    expect(sample(c).throttle).toBe(0);
    expect(c.pointerAt()).toBeNull();
    c.pointerMove(700, 300);
    expect(sample(c).throttle).toBe(15);
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
    const key = (
      type: 'keydown' | 'keyup',
      k: string,
      repeat = false,
      target?: { tagName: string },
    ) => {
      const event = Object.assign(new Event(type, { cancelable: true }), { key: k, repeat });
      if (target) Object.defineProperty(event, 'target', { value: target });
      win.dispatchEvent(event);
      return event;
    };
    const held = () => controller.sample({ x: 0, y: 0 }, 1, 10);
    return { controller, doc, key, held, enters };
  };

  it('leaves editing keys to a text field', () => {
    const { key, held, enters } = setup();
    for (const tag of ['INPUT', 'TEXTAREA']) {
      for (const k of ['ArrowLeft', 'a', ' ', 'Backspace']) {
        const down = key('keydown', k, false, { tagName: tag });
        expect(down.defaultPrevented).toBe(false);
        key('keyup', k, false, { tagName: tag });
      }
    }
    expect(held()).toEqual({ steer: 0, throttle: 0, dash: false });
    // Enter still hatches from the name field.
    key('keydown', 'Enter', false, { tagName: 'INPUT' });
    expect(enters).toHaveLength(1);
    // The page itself still steers, and a key released over a field is not left held.
    key('keydown', 'a');
    key('keyup', 'a', false, { tagName: 'INPUT' });
    expect(held().throttle).toBe(0);
    key('keydown', 'a');
    expect(held().throttle).toBeGreaterThan(0);
  });

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

  it('coasts when the pointer leaves the page', () => {
    const { controller, doc } = setup();
    controller.pointerMove(700, 300);
    expect(controller.sample({ x: 0, y: 0 }, 1, 10).throttle).toBeGreaterThan(0);
    doc.dispatchEvent(Object.assign(new Event('mouseout'), { relatedTarget: null }));
    expect(controller.sample({ x: 0, y: 0 }, 1, 10).throttle).toBe(0);
  });

  it('keeps following the pointer when it only crosses between elements', () => {
    const { controller, doc } = setup();
    controller.pointerMove(700, 300);
    doc.dispatchEvent(Object.assign(new Event('mouseout'), { relatedTarget: {} }));
    expect(controller.sample({ x: 0, y: 0 }, 1, 10).throttle).toBeGreaterThan(0);
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

describe('InputController social hooks', () => {
  const setup = () => {
    const win = new EventTarget();
    const controller = new InputController();
    const keys: string[] = [];
    const ups: string[] = [];
    const stamps: number[] = [];
    const middles: number[][] = [];
    controller.attach(win as unknown as Window, undefined, undefined, {
      key: (k, at) => {
        keys.push(k);
        stamps.push(at);
      },
      keyUp: (k, at) => {
        ups.push(k);
        stamps.push(at);
      },
      middle: (x, y) => middles.push([x, y]),
    });
    const key = (type: 'keydown' | 'keyup', k: string, repeat = false, timeStamp?: number) => {
      const event = Object.assign(new Event(type, { cancelable: true }), { key: k, repeat });
      if (timeStamp !== undefined) Object.defineProperty(event, 'timeStamp', { value: timeStamp });
      win.dispatchEvent(event);
      return event;
    };
    const pointer = (button: number, x = 0, y = 0) =>
      win.dispatchEvent(
        Object.assign(new Event('pointerdown', { cancelable: true }), {
          button,
          clientX: x,
          clientY: y,
        }),
      );
    return { controller, key, keys, middles, pointer, stamps, ups, win };
  };

  it('reports key releases (the wheel sends on releasing G), but not while typing', () => {
    const { controller, key, ups } = setup();
    key('keydown', 'g');
    key('keyup', 'g');
    controller.typing = true;
    key('keyup', 'x');
    expect(ups).toEqual(['g']);
  });

  it("hands the hooks the browser's event time, so a busy frame cannot stretch a tap of G", () => {
    const { key, stamps } = setup();
    key('keydown', 'g', false, 1000);
    key('keyup', 'g', false, 1040);
    expect(stamps).toEqual([1000, 1040]);
  });

  it('reports fresh key presses, not repeats', () => {
    const { key, keys } = setup();
    key('keydown', 't');
    key('keydown', 't', true);
    key('keydown', '2');
    expect(keys).toEqual(['t', '2']);
  });

  it('does not report presses with Ctrl, Cmd or Alt held', () => {
    const { key, keys, win } = setup();
    for (const mod of ['ctrlKey', 'metaKey', 'altKey']) {
      win.dispatchEvent(
        Object.assign(new Event('keydown', { cancelable: true }), {
          key: 'g',
          repeat: false,
          [mod]: true,
        }),
      );
    }
    expect(keys).toEqual([]);
    key('keydown', 'g');
    expect(keys).toEqual(['g']);
  });

  it('while typing, ignores keys, leaves Space alone and releases held keys', () => {
    const { controller, key, keys } = setup();
    key('keydown', 'w');
    controller.typing = true;
    controller.reset();
    expect(key('keydown', ' ').defaultPrevented).toBe(false);
    key('keydown', 'd');
    key('keydown', 't');
    controller.typing = false;
    const input = controller.sample({ x: 0, y: 0 }, 1, 10);
    expect(input.dash).toBe(false);
    expect(input.throttle).toBe(0);
    expect(keys).toEqual(['w']);
  });

  it('turns the middle button into a ping position and tracks the pointer', () => {
    const { controller, middles, pointer } = setup();
    expect(controller.pointerAt()).toBeNull();
    pointer(0, 5, 5);
    expect(middles).toEqual([]);
    pointer(1, 40, 60);
    expect(middles).toEqual([[40, 60]]);
    expect(controller.pointerAt()).toEqual({ x: 40, y: 60 });
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

describe('wheelInput', () => {
  const held = { steer: 10, throttle: 12, dash: false };
  const sampled = { steer: 90, throttle: 3, dash: true };

  it('hands steering to the cursor while the wheel is closed', () => {
    expect(wheelInput(false, held, sampled, null)).toEqual(sampled);
    expect(wheelInput(false, held, sampled, { steer: 64, throttle: 15, dash: false })).toEqual(
      sampled,
    );
  });

  it('keeps the held steering and throttle while it is open and no key is down', () => {
    expect(wheelInput(true, held, sampled, null)).toEqual({ ...held, dash: true });
  });

  it('lets WASD steer live while it is open', () => {
    const keys = keysToInput(new Set(['w']));
    expect(wheelInput(true, held, sampled, keys)).toEqual({ steer: 64, throttle: 15, dash: true });
  });

  it('keeps the dash of this tick, and never one from the held input', () => {
    expect(wheelInput(true, { ...held, dash: true }, { ...sampled, dash: false }, null).dash).toBe(
      false,
    );
  });
});

describe('InputController.keyInput', () => {
  it('reports the held movement keys only', () => {
    const c = new InputController();
    expect(c.keyInput()).toBeNull();
    c.keyDown('d');
    expect(c.keyInput()?.steer).toBe(0);
    c.keyUp('d');
    expect(c.keyInput()).toBeNull();
  });
});
