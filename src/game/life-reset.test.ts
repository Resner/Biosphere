import { describe, expect, test } from 'vitest';
import { InputController } from './input';
import { resetLife } from './life-reset';
import { createLoop } from './loop';

describe('resetLife', () => {
  test('a slewed loop runs at real time again', () => {
    let clock = 0;
    let ticks = 0;
    const loop = createLoop({ now: () => clock, tick: () => ticks++, render: () => {} });
    loop.frame();
    loop.setSpeed(1.5);
    resetLife({ setSpeed: (s) => loop.setSpeed(s), closeChat: () => {} });
    clock += 100;
    loop.frame();
    expect(ticks).toBe(3);
  });

  test('an open chat input is closed, so one Enter hatches again', () => {
    const controller = new InputController();
    let enters = 0;
    const target = new EventTarget();
    controller.attach(target as Window, undefined, () => enters++);
    controller.typing = true;
    resetLife({ setSpeed: () => {}, closeChat: () => (controller.typing = false) });
    target.dispatchEvent(Object.assign(new Event('keydown'), { key: 'Enter', repeat: false }));
    expect(controller.typing).toBe(false);
    expect(enters).toBe(1);
  });
});
