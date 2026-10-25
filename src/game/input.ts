import { angleToSteer, IDLE, type Input } from '../sim/input';
import { atan2, clamp, length } from '../sim/math';
import { RULES } from '../sim/rules';
import type { Vec2 as Point } from '../sim/types';

const { deadZoneRadii, fullThrottleRadii } = RULES.controls;
const MAX_THROTTLE = RULES.movement.maxThrottle;

/**
 * Cursor direction sets the heading, distance sets the throttle.
 * `pointer` and `creatureScreenPos` are in screen pixels (y down); `radius` is in world units.
 */
export function mouseToInput(
  pointer: Point,
  creatureScreenPos: Point,
  pxPerWu: number,
  radius: number,
): Input {
  const dx = pointer.x - creatureScreenPos.x;
  const dy = creatureScreenPos.y - pointer.y;
  const distance = length(dx, dy) / pxPerWu;
  const dead = deadZoneRadii * radius;
  const span = (fullThrottleRadii - deadZoneRadii) * radius;
  const throttle =
    distance <= dead
      ? 0
      : clamp(Math.ceil((MAX_THROTTLE * (distance - dead)) / span), 1, MAX_THROTTLE);
  return { steer: angleToSteer(atan2(dy, dx)), throttle, dash: false };
}

const KEY_DIRECTIONS: Readonly<Record<string, Point>> = {
  w: { x: 0, y: 1 },
  arrowup: { x: 0, y: 1 },
  s: { x: 0, y: -1 },
  arrowdown: { x: 0, y: -1 },
  a: { x: -1, y: 0 },
  arrowleft: { x: -1, y: 0 },
  d: { x: 1, y: 0 },
  arrowright: { x: 1, y: 0 },
};

/** WASD or arrows; `null` when no movement key is held, so the mouse stays in control. */
export function keysToInput(keys: ReadonlySet<string>): Input | null {
  let x = 0;
  let y = 0;
  let held = false;
  for (const key of keys) {
    const dir = KEY_DIRECTIONS[key.toLowerCase()];
    if (!dir) continue;
    held = true;
    x += dir.x;
    y += dir.y;
  }
  if (!held) return null;
  if (x === 0 && y === 0) return IDLE;
  return { steer: angleToSteer(atan2(y, x)), throttle: MAX_THROTTLE, dash: false };
}

const DASH_KEY = ' ';
/** Keys the page would otherwise scroll with. */
const SCROLL_KEYS: ReadonlySet<string> = new Set([
  DASH_KEY,
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
]);
/** Enter on the death screen waits this long, so a key held through the death does not rehatch. */
export const ENTER_DELAY_MS = 400;

/** Whether Enter hatches: at once from the title, after a short delay from the death screen. */
export function enterHatches(screen: 'title' | 'playing' | 'dead', shownMs: number): boolean {
  if (screen === 'title') return true;
  return screen === 'dead' && shownMs >= ENTER_DELAY_MS;
}

/** What the page does with keys and buttons beyond steering. */
export interface InputHooks {
  /** A fresh key press while not typing (never a repeat); the key as the browser names it. */
  key?(key: string): void;
  /** The middle button went down at this screen position. */
  middle?(x: number, y: number): void;
}

/** Turns raw pointer and keyboard events into one `Input` per sim tick. */
export class InputController {
  private readonly keys = new Set<string>();
  private readonly pointer: Point = { x: 0, y: 0 };
  private hasPointer = false;
  private dashQueued = false;
  /** While true (chat is open) keys belong to the text field: they neither steer nor reach hooks. */
  typing = false;

  /** The pointer's last position in screen pixels, or null before it has moved. */
  pointerAt(): Point | null {
    return this.hasPointer ? { x: this.pointer.x, y: this.pointer.y } : null;
  }

  keyDown(key: string): void {
    if (key === DASH_KEY) this.dashQueued = true;
    else this.keys.add(key.toLowerCase());
  }

  keyUp(key: string): void {
    this.keys.delete(key.toLowerCase());
  }

  pointerMove(x: number, y: number): void {
    this.pointer.x = x;
    this.pointer.y = y;
    this.hasPointer = true;
  }

  /** Forgets held keys, e.g. when the window loses focus. */
  reset(): void {
    this.keys.clear();
    this.dashQueued = false;
  }

  /** Reads this tick's input. A dash press fires once. */
  sample(creatureScreenPos: Point, pxPerWu: number, radius: number): Input {
    const steering =
      keysToInput(this.keys) ??
      (this.hasPointer ? mouseToInput(this.pointer, creatureScreenPos, pxPerWu, radius) : IDLE);
    const dash = this.dashQueued;
    this.dashQueued = false;
    return { ...steering, dash };
  }

  /**
   * Listens on the window and, for hidden tabs, the document; returns a function that detaches
   * again. `onEnter` fires on a fresh Enter press, never on a key repeat; `hooks` get the other
   * fresh presses and the middle button.
   */
  attach(target: Window, doc?: Document, onEnter?: () => void, hooks: InputHooks = {}): () => void {
    const down = (e: KeyboardEvent) => {
      if (this.typing) return;
      if (SCROLL_KEYS.has(e.key) || (e.key === 'Enter' && onEnter)) e.preventDefault();
      if (e.repeat) return;
      if (e.key === 'Enter') onEnter?.();
      else {
        this.keyDown(e.key);
        if (!e.ctrlKey && !e.metaKey && !e.altKey) hooks.key?.(e.key);
      }
    };
    const up = (e: KeyboardEvent) => {
      if (!this.typing) this.keyUp(e.key);
    };
    const noMiddle = (e: MouseEvent) => {
      if (e.button === 1) e.preventDefault();
    };
    const move = (e: PointerEvent) => this.pointerMove(e.clientX, e.clientY);
    const press = (e: PointerEvent) => {
      if (e.button !== 1 || this.typing) return;
      e.preventDefault();
      this.pointerMove(e.clientX, e.clientY);
      hooks.middle?.(e.clientX, e.clientY);
    };
    const blur = () => this.reset();
    const visibility = () => {
      if (doc?.hidden) this.reset();
    };
    target.addEventListener('keydown', down);
    target.addEventListener('keyup', up);
    target.addEventListener('pointermove', move);
    target.addEventListener('pointerdown', press);
    // The middle button would otherwise start the browser's autoscroll.
    target.addEventListener('mousedown', noMiddle);
    target.addEventListener('blur', blur);
    doc?.addEventListener('visibilitychange', visibility);
    return () => {
      target.removeEventListener('keydown', down);
      target.removeEventListener('keyup', up);
      target.removeEventListener('pointermove', move);
      target.removeEventListener('pointerdown', press);
      target.removeEventListener('mousedown', noMiddle);
      target.removeEventListener('blur', blur);
      doc?.removeEventListener('visibilitychange', visibility);
    };
  }
}
