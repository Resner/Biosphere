// The quick social wheel (M6 T24, #89): `G` opens a ring of the 4 pings and 6 emotes at the
// cursor. Holding `G` and releasing over an item sends it, a click sends it too, and while it is
// open `1`–`0` pick directly; Esc, a second `G` or releasing in the centre after a hold cancel. A
// ping lands where the cursor pointed when the wheel opened, an emote over the player's creature.
// Items are picked by direction from the centre, so the same layout takes a touch hold later;
// hovering only highlights.

import { pick as pickEl, setText } from './dom';
import { EMOTES, PINGS } from './social-ui';

export interface WheelItem {
  kind: 'ping' | 'emote';
  /** The ping kind or the emote id. */
  id: number;
  name: string;
  glyph: string;
  /** The number key that picks it while the wheel is open. */
  key: string;
}

/** The pings on 1–4, then the emotes on 5–0, clockwise from the top. */
export const WHEEL_ITEMS: readonly WheelItem[] = [
  ...PINGS.map((p, id) => ({ kind: 'ping' as const, id, name: p.name, glyph: p.glyph })),
  ...EMOTES.map((e, id) => ({ kind: 'emote' as const, id, name: e.name, glyph: e.glyph })),
].map((item, i) => ({ ...item, key: String((i + 1) % 10) }));

/** Sizes in CSS pixels. */
export const WHEEL = {
  /** Centre to an item's centre. */
  radius: 112,
  /** An item's diameter: a touch target of at least 44 px. */
  item: 56,
  /** The centre's cancel zone. */
  dead: 36,
  /** Beyond this from the centre nothing is picked. */
  outer: 168,
  /** A `G` released sooner than this, in the centre, was a tap: the wheel stays open. */
  holdMs: 250,
} as const;

/** How far the centre keeps from the screen's edges, so every item stays on screen. */
const MARGIN = WHEEL.radius + WHEEL.item / 2 + 8;
const STEP = (2 * Math.PI) / WHEEL_ITEMS.length;

export interface Point {
  x: number;
  y: number;
}

/** Each item's centre for a wheel centred at `centre` (screen pixels, y down). */
export function wheelSpots(centre: Point): Point[] {
  return WHEEL_ITEMS.map((_, i) => {
    const angle = -Math.PI / 2 + i * STEP;
    return {
      x: centre.x + WHEEL.radius * Math.cos(angle),
      y: centre.y + WHEEL.radius * Math.sin(angle),
    };
  });
}

/** The item in the direction (dx, dy) from the centre; null in the cancel zone or far outside. */
export function itemAt(dx: number, dy: number): number | null {
  const distance = Math.hypot(dx, dy);
  if (distance < WHEEL.dead || distance > WHEEL.outer) return null;
  const turns = Math.round((Math.atan2(dy, dx) + Math.PI / 2) / STEP);
  return ((turns % WHEEL_ITEMS.length) + WHEEL_ITEMS.length) % WHEEL_ITEMS.length;
}

/** The wheel's centre for a cursor, moved in from the edges so the whole ring is on screen. */
export function wheelCentre(cursor: Point, view: { width: number; height: number }): Point {
  const along = (v: number, size: number) =>
    size < 2 * MARGIN ? size / 2 : Math.min(Math.max(v, MARGIN), size - MARGIN);
  return { x: along(cursor.x, view.width), y: along(cursor.y, view.height) };
}

/** The item a number key picks, or null. */
export function keyItem(key: string): WheelItem | null {
  return WHEEL_ITEMS.find((item) => item.key === key) ?? null;
}

export interface WheelPick {
  item: WheelItem;
  /** Where the cursor pointed when the wheel opened, in world units. */
  world: Point;
}

/** `state().wheel`: items carry their screen centres while open. */
export interface WheelInfo {
  open: boolean;
  items: (Omit<WheelItem, 'glyph'> & Point)[];
  /** The world point a ping would land on. */
  at: Point | null;
  /** The wheel's centre and the cursor it opened at, in CSS pixels. */
  centre: Point | null;
  target: Point | null;
}

interface Opened {
  centre: Point;
  target: Point;
  world: Point;
  at: number;
  /** `G` is still down. */
  held: boolean;
}

/** The wheel's state, without any DOM, so it tests with plain numbers. */
export class Wheel {
  private opened: Opened | null = null;

  constructor(private readonly send: (pick: WheelPick) => void) {}

  get isOpen(): boolean {
    return this.opened !== null;
  }

  /** `G` went down at the cursor (screen pixels) over `world`: opens, or closes an open wheel. */
  press(cursor: Point, world: Point, view: { width: number; height: number }, now: number): void {
    if (this.opened) {
      this.cancel();
      return;
    }
    const target = { x: cursor.x, y: cursor.y };
    this.opened = {
      centre: wheelCentre(cursor, view),
      target,
      world: { x: world.x, y: world.y },
      at: now,
      held: true,
    };
  }

  /** `G` went up: sends the item under the pointer; in the centre a hold cancels, a tap stays open. */
  release(pointer: Point | null, now: number): void {
    const opened = this.opened;
    if (!opened?.held) return;
    opened.held = false;
    const index = this.highlighted(pointer);
    if (index !== null) this.choose(index);
    else if (now - opened.at >= WHEEL.holdMs) this.cancel();
  }

  /** A click: the item under it, or a cancel anywhere else. */
  click(pointer: Point): void {
    if (!this.opened) return;
    const index = this.highlighted(pointer);
    if (index === null) this.cancel();
    else this.choose(index);
  }

  /** A number key while open picks its item; false when the key is not the wheel's. */
  pick(key: string): boolean {
    if (!this.opened) return false;
    const index = WHEEL_ITEMS.findIndex((item) => item.key === key);
    if (index < 0) return false;
    this.choose(index);
    return true;
  }

  cancel(): void {
    this.opened = null;
  }

  /** The item under the pointer, if the wheel is open. */
  highlighted(pointer: Point | null): number | null {
    const opened = this.opened;
    if (!opened || !pointer) return null;
    return itemAt(pointer.x - opened.centre.x, pointer.y - opened.centre.y);
  }

  info(): WheelInfo {
    const opened = this.opened;
    if (!opened) return { open: false, items: [], at: null, centre: null, target: null };
    const spots = wheelSpots(opened.centre);
    return {
      open: true,
      items: WHEEL_ITEMS.map(({ glyph: _, ...item }, i) => ({ ...item, ...(spots[i] as Point) })),
      at: { ...opened.world },
      centre: { ...opened.centre },
      target: { ...opened.target },
    };
  }

  private choose(index: number): void {
    const opened = this.opened as Opened;
    this.opened = null;
    this.send({ item: WHEEL_ITEMS[index] as WheelItem, world: opened.world });
  }
}

/**
 * The wheel on screen: a layer over the water that takes the pointer only while open (a click
 * anywhere picks by direction or cancels), the ring of items with their glyph, name and key, a
 * hub naming the item under the pointer, and a mark where the ping would land.
 */
export class WheelUi {
  private readonly root = pickEl('[data-testid="wheel"]');
  private readonly ring = document.createElement('div');
  private readonly hub = document.createElement('span');
  private readonly mark = document.createElement('span');
  private readonly buttons: HTMLButtonElement[];
  private shownAt = '';
  private lit: number | null = null;

  constructor(private readonly wheel: Wheel) {
    this.ring.className = 'wheel-ring';
    this.hub.className = 'wheel-hub';
    this.mark.className = 'wheel-target';
    this.buttons = WHEEL_ITEMS.map((item, i) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.tabIndex = -1;
      button.className = 'wheel-item';
      button.dataset.testid = 'wheel-item';
      button.dataset.kind = item.kind;
      button.dataset.id = String(item.id);
      button.dataset.name = item.name;
      button.setAttribute('role', 'menuitem');
      button.setAttribute('aria-label', `${item.name} ${item.kind} (${item.key})`);
      const glyph = document.createElement('span');
      glyph.className = 'wheel-glyph';
      glyph.textContent = item.glyph;
      const name = document.createElement('span');
      name.className = 'wheel-name';
      name.textContent = item.name;
      const key = document.createElement('kbd');
      key.className = 'wheel-key';
      key.textContent = item.key;
      button.append(glyph, name, key);
      const spot = wheelSpots({ x: 0, y: 0 })[i] as Point;
      button.style.transform = `translate(${Math.round(spot.x - WHEEL.item / 2)}px, ${Math.round(spot.y - WHEEL.item / 2)}px)`;
      return button;
    });
    this.ring.append(this.hub, ...this.buttons);
    this.root.append(this.mark, this.ring);
    // A pressed button would take the focus, and Space (the dash) would press it again.
    this.root.addEventListener('mousedown', (e) => e.preventDefault());
    this.root.addEventListener('click', (e) => wheel.click({ x: e.clientX, y: e.clientY }));
  }

  /** Once a frame: shows or hides the wheel and lights the item under the pointer. */
  update(pointer: Point | null): void {
    const info = this.wheel.info();
    if (this.root.hidden !== !info.open) this.root.hidden = !info.open;
    if (!info.open || !info.centre || !info.target) {
      this.shownAt = '';
      return;
    }
    const { centre, target } = info;
    const at = `${centre.x},${centre.y},${target.x},${target.y}`;
    if (at !== this.shownAt) {
      this.shownAt = at;
      this.ring.style.transform = `translate(${Math.round(centre.x)}px, ${Math.round(centre.y)}px)`;
      this.mark.style.transform = `translate(${Math.round(target.x)}px, ${Math.round(target.y)}px)`;
    }
    const lit = this.wheel.highlighted(pointer);
    if (lit !== this.lit) {
      if (this.lit !== null) delete (this.buttons[this.lit] as HTMLElement).dataset.lit;
      if (lit !== null) (this.buttons[lit] as HTMLElement).dataset.lit = 'true';
      this.lit = lit;
    }
    const item = lit === null ? null : WHEEL_ITEMS[lit];
    setText(this.hub, item ? `${item.name} ${item.kind}` : 'Esc cancels');
  }
}
