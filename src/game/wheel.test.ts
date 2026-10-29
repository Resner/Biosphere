import { describe, expect, it } from 'vitest';
import {
  itemAt,
  keyItem,
  WHEEL,
  WHEEL_ITEMS,
  Wheel,
  type WheelPick,
  wheelCentre,
  wheelSpots,
} from './wheel';

const VIEW = { width: 960, height: 540 };

function setup() {
  const picks: WheelPick[] = [];
  const wheel = new Wheel((pick) => picks.push(pick));
  /** Opens with G at a cursor in the middle of the view; the world point is a stand-in. */
  const open = (now = 0, cursor = { x: 480, y: 270 }) =>
    wheel.press(cursor, { x: 100, y: 200 }, VIEW, now);
  return { open, picks, wheel };
}

/** The screen point of item `i` for a wheel centred at (480, 270). */
const spot = (i: number) => wheelSpots({ x: 480, y: 270 })[i] as { x: number; y: number };

describe('wheel items', () => {
  it('holds the 4 pings, then the 6 emotes, on the keys 1 to 0', () => {
    expect(WHEEL_ITEMS.map((i) => `${i.key}:${i.kind}:${i.id}:${i.name}`)).toEqual([
      '1:ping:0:look',
      '2:ping:1:danger',
      '3:ping:2:food',
      '4:ping:3:mate',
      '5:emote:0:wave',
      '6:emote:1:happy',
      '7:emote:2:love',
      '8:emote:3:angry',
      '9:emote:4:scared',
      '0:emote:5:question',
    ]);
    expect(keyItem('3')?.name).toBe('food');
    expect(keyItem('0')?.name).toBe('question');
    expect(keyItem('t')).toBeNull();
  });

  it('lays targets out at least 44 px wide without overlapping, for a later touch hold', () => {
    expect(WHEEL.item).toBeGreaterThanOrEqual(44);
    expect(2 * WHEEL.dead).toBeGreaterThanOrEqual(44);
    const spots = wheelSpots({ x: 0, y: 0 });
    expect(spots).toHaveLength(10);
    for (let i = 0; i < spots.length; i++) {
      const a = spots[i] as { x: number; y: number };
      const b = spots[(i + 1) % spots.length] as { x: number; y: number };
      expect(Math.hypot(a.x - b.x, a.y - b.y)).toBeGreaterThanOrEqual(WHEEL.item + 4);
      // Every item sits clear of the centre's cancel zone.
      expect(Math.hypot(a.x, a.y) - WHEEL.item / 2).toBeGreaterThan(WHEEL.dead);
    }
    // The first item is straight up, and they run clockwise.
    expect(spots[0]?.x).toBeCloseTo(0);
    expect(spots[0]?.y).toBeLessThan(0);
    expect(spots[1]?.x).toBeGreaterThan(0);
  });

  it('picks an item by its direction, nothing in the centre or far outside', () => {
    for (let i = 0; i < WHEEL_ITEMS.length; i++) {
      const s = wheelSpots({ x: 0, y: 0 })[i] as { x: number; y: number };
      expect(itemAt(s.x, s.y)).toBe(i);
      // Anywhere along the item's spoke, between the cancel zone and the outer edge.
      expect(itemAt(s.x * 0.5, s.y * 0.5)).toBe(i);
      expect(itemAt(s.x * 1.3, s.y * 1.3)).toBe(i);
    }
    expect(itemAt(0, 0)).toBeNull();
    expect(itemAt(WHEEL.dead - 1, 0)).toBeNull();
    expect(itemAt(WHEEL.outer + 1, 0)).toBeNull();
  });

  it('keeps the whole wheel on screen near an edge', () => {
    expect(wheelCentre({ x: 480, y: 270 }, VIEW)).toEqual({ x: 480, y: 270 });
    const c = wheelCentre({ x: 5, y: 530 }, VIEW);
    for (const s of wheelSpots(c)) {
      expect(s.x - WHEEL.item / 2).toBeGreaterThanOrEqual(0);
      expect(s.y + WHEEL.item / 2).toBeLessThanOrEqual(VIEW.height);
    }
  });
});

describe('Wheel', () => {
  it('a tap of G near an edge, where the ring is pushed inward, does not pick the item under the cursor', () => {
    const { picks, wheel } = setup();
    // At y=100 the ring centres at y=148, so the unmoved cursor sits 48 px from it, over an item.
    wheel.press({ x: 480, y: 100 }, { x: 1, y: 2 }, VIEW, 0);
    expect(wheel.highlighted({ x: 480, y: 100 })).not.toBeNull();
    wheel.release({ x: 480, y: 100 }, 40);
    expect(picks).toEqual([]);
    expect(wheel.isOpen).toBe(true);
  });

  it('a tap of G opens it and leaves it open; a number then picks directly', () => {
    const { open, picks, wheel } = setup();
    expect(wheel.pick('3')).toBe(false);
    open(0);
    wheel.release({ x: 480, y: 270 }, 100);
    expect(wheel.isOpen).toBe(true);
    expect(wheel.pick('3')).toBe(true);
    expect(wheel.isOpen).toBe(false);
    expect(picks).toEqual([{ item: WHEEL_ITEMS[2], world: { x: 100, y: 200 } }]);
    // Closed again, a number is not the wheel's.
    expect(wheel.pick('4')).toBe(false);
  });

  it('holding G and releasing over an item sends it', () => {
    const { open, picks, wheel } = setup();
    open(0);
    wheel.release(spot(5), 600);
    expect(picks.map((p) => p.item.name)).toEqual(['happy']);
    expect(wheel.isOpen).toBe(false);
  });

  it('releasing in the centre after a hold cancels', () => {
    const { open, picks, wheel } = setup();
    open(0);
    wheel.release({ x: 482, y: 268 }, WHEEL.holdMs + 1);
    expect(wheel.isOpen).toBe(false);
    expect(picks).toEqual([]);
  });

  it('a click sends the item under it, and a click in the centre or outside cancels', () => {
    const { open, picks, wheel } = setup();
    open(0);
    wheel.release(null, 50);
    wheel.click(spot(9));
    expect(picks.map((p) => p.item.name)).toEqual(['question']);
    open(1000);
    wheel.release(null, 1050);
    wheel.click({ x: 480, y: 270 });
    expect(wheel.isOpen).toBe(false);
    open(2000);
    wheel.release(null, 2050);
    wheel.click({ x: 10, y: 10 });
    expect(wheel.isOpen).toBe(false);
    expect(picks).toHaveLength(1);
  });

  it('Esc (cancel) and a second G close it without sending', () => {
    const { open, picks, wheel } = setup();
    open(0);
    wheel.cancel();
    expect(wheel.isOpen).toBe(false);
    open(1000);
    wheel.release(null, 1050);
    open(2000);
    expect(wheel.isOpen).toBe(false);
    // The second G's key-up finds it closed and does nothing.
    wheel.release(spot(0), 2100);
    expect(picks).toEqual([]);
  });

  it('sends the world point under the cursor even when the wheel is moved on screen', () => {
    const { picks, wheel } = setup();
    wheel.press({ x: 5, y: 5 }, { x: 7, y: 8 }, VIEW, 0);
    const info = wheel.info();
    expect(info.open).toBe(true);
    expect(info.target).toEqual({ x: 5, y: 5 });
    expect(info.centre?.x).toBeGreaterThan(5);
    expect(info.at).toEqual({ x: 7, y: 8 });
    expect(wheel.pick('1')).toBe(true);
    expect(picks[0]?.world).toEqual({ x: 7, y: 8 });
  });

  it('reports its items with screen positions while open, and nothing while closed', () => {
    const { open, wheel } = setup();
    expect(wheel.info()).toEqual({ open: false, items: [], at: null, centre: null, target: null });
    open(0);
    const { items } = wheel.info();
    expect(items).toHaveLength(10);
    expect(items[5]).toMatchObject({ name: 'happy', kind: 'emote', id: 1, key: '6', ...spot(5) });
    expect(wheel.highlighted(spot(5))).toBe(5);
    expect(wheel.highlighted({ x: 480, y: 270 })).toBeNull();
  });
});
