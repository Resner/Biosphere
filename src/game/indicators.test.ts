import { describe, expect, it } from 'vitest';
import { sizeClass } from '../sim/size';
import {
  EDGE_INSET_PX,
  edgeIndicators,
  type Indicator,
  type IndicatorPlayer,
  lengthsText,
  MAX_PLAYER_INDICATORS,
  SPREAD_PX,
  viewRadius,
} from './indicators';
import type { LabelProjection } from './labels';

// A 960×540 view at 2 CSS px per world unit: 240 × 135 wu around the camera.
const view: LabelProjection = { camX: 4000, camY: 4000, pxPerWu: 2, width: 960, height: 540 };
const self = { x: 4000, y: 4000, radius: 5 };
const R = viewRadius(view);

const player = (id: string, x: number, y: number, over: Partial<IndicatorPlayer> = {}) => ({
  id,
  name: id,
  x,
  y,
  radius: 5,
  alpha: 1,
  ready: false,
  ...over,
});
const at = (distance: number, degrees: number) => ({
  x: self.x + distance * Math.cos((degrees * Math.PI) / 180),
  y: self.y + distance * Math.sin((degrees * Math.PI) / 180),
});

describe('edge indicators', () => {
  it('measures the view radius from the centre to a corner', () => {
    expect(R).toBeCloseTo(Math.hypot(240, 135), 6);
  });

  it('points at an off-screen player from the edge, with the distance in body lengths', () => {
    const b = at(3 * R, 20);
    const [one, ...rest] = edgeIndicators(self, [player('b', b.x, b.y)], [], view);
    expect(rest).toHaveLength(0);
    expect(one).toMatchObject({ kind: 'player', id: 'b', name: 'b', size: 'comparable' });
    expect(one?.angle).toBeCloseTo(20, 6);
    expect(one?.lengths).toBe(Math.round((3 * R) / 10));
    // On the inset frame: the right edge, since 20° leaves through the side at this aspect.
    expect(one?.x).toBeCloseTo(view.width - EDGE_INSET_PX, 6);
    // Screen y grows downwards, so a target above sits above the centre line.
    const rise = Math.tan(Math.PI / 9) * (view.width / 2 - EDGE_INSET_PX);
    expect(one?.y).toBeCloseTo(view.height / 2 - rise, 6);
  });

  it('leaves through the top for a player straight up or steeply above, and stays inside the frame', () => {
    const steep = at(3 * R, 30);
    const top = edgeIndicators(self, [player('s', steep.x, steep.y)], [], view)[0];
    expect(top?.y).toBeCloseTo(EDGE_INSET_PX, 6);
    expect(top?.x).toBeLessThan(view.width - EDGE_INSET_PX);
    const up = edgeIndicators(self, [player('u', self.x, self.y + 500)], [], view)[0];
    expect(up?.angle).toBeCloseTo(90, 6);
    expect(up?.x).toBeCloseTo(view.width / 2, 6);
    expect(up?.y).toBeCloseTo(EDGE_INSET_PX, 6);
    const p = at(2000, -150);
    const down = edgeIndicators(self, [player('d', p.x, p.y)], [], view)[0];
    expect(down?.angle).toBeCloseTo(-150, 6);
    expect(down?.x).toBeGreaterThanOrEqual(EDGE_INSET_PX - 1e-9);
    expect(down?.y).toBeLessThanOrEqual(view.height - EDGE_INSET_PX + 1e-9);
  });

  it('shows nobody whose body is on screen, even a big one with only its rim inside', () => {
    const near = player('near', self.x + 100, self.y);
    const rim = player('rim', self.x + 240 + 30, self.y, { radius: 40 });
    expect(edgeIndicators(self, [near, rim], [], view)).toEqual([]);
  });

  it('shows the nearest six, nearest first', () => {
    const many = Array.from({ length: 9 }, (_, i) => {
      const p = at(400 + 100 * (8 - i), 40 * i);
      return player(`p${i}`, p.x, p.y);
    });
    const shown = edgeIndicators(self, many, [], view);
    expect(MAX_PLAYER_INDICATORS).toBe(6);
    expect(shown.map((s) => s.id)).toEqual(['p8', 'p7', 'p6', 'p5', 'p4', 'p3']);
  });

  it('skips players fading away and keeps the ready mark', () => {
    const a = at(800, 0);
    const shown = edgeIndicators(
      self,
      [player('gone', a.x, a.y, { alpha: 0.2 }), player('r', a.x, a.y + 10, { ready: true })],
      [],
      view,
    );
    expect(shown.map((s) => [s.id, s.ready])).toEqual([['r', true]]);
  });

  it('classes size by tier: smaller, comparable or bigger', () => {
    // Tier edges are at radius 32, 128, 512 (biomass = radius²).
    expect(sizeClass(20, 25)).toBe('comparable');
    expect(sizeClass(20, 40)).toBe('bigger');
    expect(sizeClass(40, 20)).toBe('smaller');
    expect(sizeClass(200, 600)).toBe('bigger');
    const b = at(900, 0);
    expect(edgeIndicators(self, [player('big', b.x, b.y, { radius: 40 })], [], view)[0]?.size).toBe(
      'bigger',
    );
  });

  it('shows every off-screen ping within two view radii, beside the six players', () => {
    const players = Array.from({ length: 7 }, (_, i) => {
      const p = at(1000 + i, 10 * i);
      return player(`p${i}`, p.x, p.y);
    });
    const inReach = at(1.5 * R, 200);
    const tooFar = at(2.2 * R, 200);
    const onScreen = at(50, 0);
    const pings = [
      { from: 'p1', kind: 1, ...inReach },
      { from: 'p2', kind: 2, ...tooFar },
      { from: 'p3', kind: 3, ...onScreen },
      { from: 'p4', kind: 0, ...at(1.9 * R, -20) },
    ];
    const shown = edgeIndicators(self, players, pings, view);
    expect(shown.filter((s) => s.kind === 'player')).toHaveLength(6);
    const shownPings = shown.filter((s) => s.kind === 'ping');
    expect(shownPings.map((s) => [s.id, s.ping])).toEqual([
      ['p1', 1],
      ['p4', 0],
    ]);
    expect(shownPings[0]?.angle).toBeCloseTo(-160, 6);
    expect(shownPings[0]?.lengths).toBe(Math.round((1.5 * R) / 10));
  });

  it('moves indicators apart along the edge so their labels never overlap', () => {
    const p1 = at(3000, 0);
    const p2 = at(3000, 1);
    const p3 = at(3200, 90);
    const p4 = at(3300, 91);
    const ping = at(1.5 * R, 0.5);
    const shown = edgeIndicators(
      self,
      [
        player('a', p1.x, p1.y),
        player('b', p2.x, p2.y),
        player('c', p3.x, p3.y),
        player('d', p4.x, p4.y),
      ],
      [{ from: 'a', kind: 0, ...ping }],
      view,
    );
    expect(shown).toHaveLength(5);
    for (let i = 0; i < shown.length; i++) {
      const a = shown[i] as Indicator;
      expect(a.x).toBeGreaterThanOrEqual(EDGE_INSET_PX - 1e-9);
      expect(a.x).toBeLessThanOrEqual(view.width - EDGE_INSET_PX + 1e-9);
      expect(a.y).toBeGreaterThanOrEqual(EDGE_INSET_PX - 1e-9);
      expect(a.y).toBeLessThanOrEqual(view.height - EDGE_INSET_PX + 1e-9);
      for (let j = 0; j < i; j++) {
        const b = shown[j] as Indicator;
        const apart = Math.abs(a.x - b.x) >= SPREAD_PX.x || Math.abs(a.y - b.y) >= SPREAD_PX.y;
        expect(apart, `${a.id}/${a.kind} vs ${b.id}/${b.kind}`).toBe(true);
      }
    }
    // The bearing stays the true one; only the spot moves.
    expect(shown.find((s) => s.id === 'b')?.angle).toBeCloseTo(1, 6);
  });

  it('writes distances plainly', () => {
    expect(lengthsText(0)).toBe('1 length');
    expect(lengthsText(1)).toBe('1 length');
    expect(lengthsText(12)).toBe('12 lengths');
    expect(lengthsText(999)).toBe('999 lengths');
    expect(lengthsText(1234)).toBe('1.2k lengths');
  });
});
