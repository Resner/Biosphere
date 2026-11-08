import { describe, expect, it } from 'vitest';
import type { Fix } from './gossip';
import { CROWD_EVERY_MS } from './instance';
import type { Leaf } from './protocol';
import { type ClientMsg, parseClientMsg } from './protocol';
import { crowdList, LEAF_SLACK_WU, WHERE_EVERY_MS, WHERE_MIN_GAP_MS, WhereReporter } from './where';

const LEAF: Leaf = { x: 1024, y: 1024, size: 1024 };
const swim = (now: number, x = 1500, y = 1500, r = 10, aoi = 233) => ({
  inWater: true,
  x,
  y,
  r,
  aoi,
  now,
});
const ashore = (now: number) => ({ inWater: false, x: 0, y: 0, r: 10, aoi: 233, now });

/** A reporter already in the water at t = 0 inside `LEAF`. */
function started(): WhereReporter {
  const w = new WhereReporter();
  expect(w.update(swim(0), null)).toEqual({ t: 'where', x: 1500, y: 1500, r: 10, aoi: 233 });
  return w;
}

describe('WhereReporter', () => {
  it('sends nothing out of the water, and a where on entering it', () => {
    const w = new WhereReporter();
    expect(w.update(ashore(0), null)).toBeNull();
    expect(w.update(ashore(40_000), LEAF)).toBeNull();
    expect(w.update(swim(41_000), LEAF)).toEqual({
      t: 'where',
      x: 1500,
      y: 1500,
      r: 10,
      aoi: 233,
    });
  });

  it('stays quiet inside the leaf for 30 s, then reports', () => {
    const w = started();
    for (let t = 100; t < WHERE_EVERY_MS; t += 100) {
      expect(w.update(swim(t, 1500 + (t % 400), 1500), LEAF)).toBeNull();
    }
    expect(w.update(swim(WHERE_EVERY_MS, 1600, 1500), LEAF)?.t).toBe('where');
    expect(w.update(swim(WHERE_EVERY_MS + 100), LEAF)).toBeNull();
  });

  it('reports when the centre leaves the leaf by more than 64 wu, and only once for it', () => {
    expect(LEAF_SLACK_WU).toBe(64);
    const edge = LEAF.x + LEAF.size;
    for (const [x, y] of [
      [edge + 63, 1500],
      [LEAF.x - 63, 1500],
      [1500, LEAF.y - 63],
    ] as const) {
      expect(started().update(swim(5000, x, y), LEAF)).toBeNull();
    }
    for (const [x, y] of [
      [edge + 65, 1500],
      [LEAF.x - 65, 1500],
      [1500, edge + 65],
    ] as const) {
      const w = started();
      expect(w.update(swim(5000, x, y), LEAF)).toEqual({ t: 'where', x, y, r: 10, aoi: 233 });
      // Until the answer names the new leaf, the old one doesn't trigger again.
      expect(w.update(swim(8000, x + 10, y), LEAF)).toBeNull();
      expect(w.update(swim(9000, x + 10, y), { x: 2048, y: 1024, size: 1024 })).toBeNull();
    }
  });

  it('reports a tier change and an AoI change of more than a quarter', () => {
    const tier = started();
    expect(tier.update(swim(5000, 1500, 1500, 31), LEAF)).toBeNull();
    expect(tier.update(swim(6000, 1500, 1500, 33), LEAF)?.t).toBe('where');
    const aoi = started();
    expect(aoi.update(swim(5000, 1500, 1500, 10, 290), LEAF)).toBeNull();
    expect(aoi.update(swim(6000, 1500, 1500, 10, 176), LEAF)).toBeNull();
    expect(aoi.update(swim(7000, 1500, 1500, 10, 300), LEAF)).toEqual({
      t: 'where',
      x: 1500,
      y: 1500,
      r: 10,
      aoi: 300,
    });
  });

  it('holds a second trigger 1 s after the first until 2 s have passed', () => {
    const w = started();
    expect(w.update(swim(10_000, 1500, 1500, 40), LEAF)?.t).toBe('where');
    // The centre leaves the leaf 1 s later: the report waits.
    expect(w.update(swim(11_000, 2200, 1500, 40), LEAF)).toBeNull();
    expect(w.update(swim(11_500, 1500, 1500, 40), LEAF)).toBeNull();
    expect(w.update(swim(10_000 + WHERE_MIN_GAP_MS - 1, 1500, 1500, 40), LEAF)).toBeNull();
    expect(w.update(swim(10_000 + WHERE_MIN_GAP_MS, 1500, 1500, 40), LEAF)).toEqual({
      t: 'where',
      x: 1500,
      y: 1500,
      r: 40,
      aoi: 233,
    });
    expect(w.update(swim(13_000, 1500, 1500, 40), LEAF)).toBeNull();
  });

  it('sends gone once on a death, never within 2 s of the last message, and none after a respawn', () => {
    const w = started();
    expect(w.update(ashore(1000), LEAF)).toBeNull();
    expect(w.update(ashore(2000), LEAF)).toEqual({ t: 'gone' });
    expect(w.update(ashore(3000), LEAF)).toBeNull();
    expect(w.update(ashore(60_000), LEAF)).toBeNull();
    expect(w.update(swim(61_000), LEAF)?.t).toBe('where');
    // Back in the water before a pending gone went out: a where takes its place.
    expect(w.update(ashore(61_500), LEAF)).toBeNull();
    expect(w.update(swim(62_500), LEAF)).toBeNull();
    expect(w.update(swim(63_000), LEAF)?.t).toBe('where');
    expect(w.update(swim(64_000), LEAF)).toBeNull();
  });

  it('reports as soon as the gap allows after a nudge, and only in the water (M12 T7)', () => {
    const w = started();
    w.nudge();
    expect(w.update(swim(WHERE_MIN_GAP_MS - 100), LEAF)).toBeNull();
    expect(w.update(swim(WHERE_MIN_GAP_MS), LEAF)?.t).toBe('where');
    expect(w.update(swim(WHERE_MIN_GAP_MS * 3), LEAF)).toBeNull();
    const ashoreNow = new WhereReporter();
    ashoreNow.nudge();
    expect(ashoreNow.update(ashore(10_000), LEAF)).toBeNull();
  });

  it('keeps its reports within the wire’s ranges', () => {
    const w = new WhereReporter();
    const msg = w.update({ inWater: true, x: -3, y: 2 ** 30, r: 0.4, aoi: 42_000, now: 0 }, null);
    expect(msg).not.toBeNull();
    expect(parseClientMsg(JSON.stringify(msg))).toEqual(msg);
    const big = new WhereReporter().update(swim(0, 10, 10, 5000, 0.5), null);
    expect(parseClientMsg(JSON.stringify(big))).toEqual(big);
  });
});

describe('WhereReporter.nudge (M12 T8)', () => {
  it('asks for a where after an instance change, held to the 2 s gap', () => {
    const w = started();
    expect(w.update(swim(5000), LEAF)).toBeNull();
    w.nudge();
    expect(w.update(swim(5100), LEAF)).not.toBeNull();
    w.nudge();
    expect(w.update(swim(5100 + WHERE_MIN_GAP_MS - 1), LEAF)).toBeNull();
    expect(w.update(swim(5100 + WHERE_MIN_GAP_MS), LEAF)).not.toBeNull();
  });

  it('is nothing while the directory holds no one', () => {
    const w = new WhereReporter();
    w.nudge();
    expect(w.update(ashore(0), null)).toBeNull();
    expect(w.update(swim(100), LEAF)).not.toBeNull();
    expect(w.update(swim(2500), LEAF)).toBeNull();
  });
});

describe('WhereReporter with a crowd (M12 T3)', () => {
  const CROWD = ['P1', 'P2'];
  const crowdIn = (msg: ClientMsg | null) => (msg?.t === 'where' ? msg.crowd : undefined);

  it('reports at once when the page turns crowded, then every 10 s while it stays so', () => {
    const w = started();
    expect(w.update(swim(5000), LEAF, CROWD)).toEqual({
      t: 'where',
      x: 1500,
      y: 1500,
      r: 10,
      aoi: 233,
      crowd: CROWD,
    });
    for (let t = 5100; t < 5000 + CROWD_EVERY_MS; t += 100) {
      expect(w.update(swim(t), LEAF, CROWD)).toBeNull();
    }
    expect(crowdIn(w.update(swim(5000 + CROWD_EVERY_MS), LEAF, ['P3']))).toEqual(['P3']);
    // No longer crowded: back to the usual reports, which carry no crowd.
    expect(w.update(swim(16_000), LEAF, null)).toBeNull();
    expect(w.update(swim(15_000 + WHERE_EVERY_MS), LEAF, null)).toEqual({
      t: 'where',
      x: 1500,
      y: 1500,
      r: 10,
      aoi: 233,
    });
  });

  it('turning crowded within 2 s of the last report waits for the gap', () => {
    const w = started();
    expect(w.update(swim(1000), LEAF, CROWD)).toBeNull();
    expect(w.update(swim(WHERE_MIN_GAP_MS - 1), LEAF, CROWD)).toBeNull();
    expect(crowdIn(w.update(swim(WHERE_MIN_GAP_MS), LEAF, CROWD))).toEqual(CROWD);
  });

  it('a report that goes for another reason while crowded carries the crowd too', () => {
    const w = started();
    expect(crowdIn(w.update(swim(3000), LEAF, CROWD))).toEqual(CROWD);
    expect(crowdIn(w.update(swim(6000, 2200, 1500), LEAF, CROWD))).toEqual(CROWD);
    // A crowd that turns off and on again within 10 s of the last one sent waits for the 10 s.
    expect(w.update(swim(8000, 2200, 1500), { x: 2048, y: 1024, size: 1024 }, null)).toBeNull();
    expect(w.update(swim(9000, 2200, 1500), { x: 2048, y: 1024, size: 1024 }, CROWD)).toBeNull();
    expect(
      crowdIn(
        w.update(swim(6000 + CROWD_EVERY_MS, 2200, 1500), { x: 2048, y: 1024, size: 1024 }, CROWD),
      ),
    ).toEqual(CROWD);
  });

  it('a crowded report parses on the wire', () => {
    const w = new WhereReporter();
    const list = Array.from(
      { length: 32 },
      (_, i) => `P${String(i).padStart(3, '0')}${'x'.repeat(39)}`,
    );
    const msg = w.update(swim(0), null, list);
    expect(parseClientMsg(JSON.stringify(msg))).toEqual(msg);
  });
});

describe('crowdList (M12 T3)', () => {
  const me = 'ME';
  const fix = (x: number, r = 10, n?: number): Fix => ({
    x,
    y: 0,
    r,
    at: 0,
    ...(n !== undefined && { n }),
  });

  it('lists the linked creatures within 8 × the larger radius that share water, nearest first', () => {
    const fixes = new Map<string, Fix>([
      ['far', fix(81)],
      ['near', fix(50)],
      ['nearer', fix(-20)],
      ['edge', fix(80)], // 8 × 10
      ['big', fix(120, 30)], // 8 × 30 = 240: within
      ['giant', fix(10, 400)], // two tiers up: no link
      ['other', fix(30, 10, 2)], // another instance
      ['open', fix(40, 10, 0)],
      ['mine', fix(45, 10, 1)],
    ]);
    expect(crowdList(me, { x: 0, y: 0, r: 10, n: 1 }, fixes)).toEqual([
      'nearer',
      'open',
      'mine',
      'near',
      'edge',
      'big',
    ]);
    // In the open water every instance shares its water.
    expect(crowdList(me, { x: 0, y: 0, r: 10 }, fixes)).toContain('other');
  });

  it('holds at most 32, and the sender alone when no creature is that close', () => {
    const fixes = new Map<string, Fix>(
      Array.from({ length: 40 }, (_, i) => [`c${String(i).padStart(2, '0')}`, fix(i * 2)]),
    );
    const list = crowdList(me, { x: 0, y: 0, r: 10 }, fixes);
    expect(list).toHaveLength(32);
    expect(list[0]).toBe('c00');
    expect(list[31]).toBe('c31');
    expect(crowdList(me, { x: 0, y: 0, r: 10 }, new Map([['far', fix(500)]]))).toEqual([me]);
  });
});
