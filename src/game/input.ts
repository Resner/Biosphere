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

/** Turns raw pointer and keyboard events into one `Input` per sim tick. */
export class InputController {
  private readonly keys = new Set<string>();
  private readonly pointer: Point = { x: 0, y: 0 };
  private hasPointer = false;
  private dashQueued = false;

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

  /** Listens on the window; returns a function that detaches again. */
  attach(target: Window): () => void {
    const down = (e: KeyboardEvent) => {
      if (e.repeat) return;
      this.keyDown(e.key);
    };
    const up = (e: KeyboardEvent) => this.keyUp(e.key);
    const move = (e: PointerEvent) => this.pointerMove(e.clientX, e.clientY);
    const blur = () => this.reset();
    target.addEventListener('keydown', down);
    target.addEventListener('keyup', up);
    target.addEventListener('pointermove', move);
    target.addEventListener('blur', blur);
    return () => {
      target.removeEventListener('keydown', down);
      target.removeEventListener('keyup', up);
      target.removeEventListener('pointermove', move);
      target.removeEventListener('blur', blur);
    };
  }
}
