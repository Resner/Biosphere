// Edge indicators (M6 T19): every pond player off screen gets an arrow on the screen's edge that
// points at them, with the distance in the player's body lengths, a shape for their size and a mark
// when they say they could mate. Pings nearby but off screen show the same way for their lifetime.
// Positions come from the pond snapshots the game already receives, so this costs no traffic.

import { clamp } from '../sim/math';
import { type SizeClass, sizeClass } from '../sim/size';
import { setText } from './dom';
import { showIcon } from './icons';
import { type LabelProjection, placeAt, screenX, screenY } from './labels';
import { PINGS } from './social-ui';

/** At most this many players get an indicator: the nearest. Pings come on top. */
export const MAX_PLAYER_INDICATORS = 6;
/** A ping shows on the edge within this many view radii (`viewRadius`) of the player. */
export const PING_REACH_VIEWS = 2;
/** Indicators sit this far inside the screen's edge, in CSS pixels, so their labels fit. */
export const EDGE_INSET_PX = 44;
/**
 * The corners the HUD uses (M6b T9), in CSS pixels from that corner: the menu button top left, the
 * stat bars and their chips bottom left. An indicator inside one slides along its edge out of it.
 */
export const HUD_CORNERS: readonly {
  corner: 'top-left' | 'bottom-left' | 'top-right' | 'bottom-right';
  w: number;
  h: number;
}[] = [
  { corner: 'top-left', w: 84, h: 84 },
  { corner: 'bottom-left', w: 280, h: 124 },
];
/** Within this many CSS pixels of a side, the label turns inwards. */
const LABEL_ROOM_PX = 96;
/** Players drawn fainter than this are going quiet (a hidden tab) and get no indicator. */
const MIN_ALPHA = 0.5;

export interface IndicatorPlayer {
  id: string;
  name: string;
  x: number;
  y: number;
  /** World units. */
  radius: number;
  alpha: number;
  /** The snapshot's ready-to-mate mark. */
  ready: boolean;
}

export interface IndicatorPing {
  from: string;
  kind: number;
  x: number;
  y: number;
}

export interface Indicator {
  kind: 'player' | 'ping';
  /** The player's id, or for a ping the id of whoever placed it. */
  id: string;
  /** The player's name; empty for a ping. */
  name: string;
  /** The ping's kind, or -1 for a player. */
  ping: number;
  /** World bearing from the player in degrees, counter-clockwise from east (−180 to 180). */
  angle: number;
  /** The distance in the player's body lengths (diameters), rounded. */
  lengths: number;
  /** Size against the player's own tier; null for a ping. */
  size: SizeClass | null;
  ready: boolean;
  /** Where it sits on screen, in CSS pixels. */
  x: number;
  y: number;
}

/** From the view's centre to a corner, in world units. */
export function viewRadius(p: LabelProjection): number {
  return Math.hypot(p.width, p.height) / 2 / p.pxPerWu;
}

export function lengthsText(lengths: number): string {
  const n = Math.max(1, lengths);
  if (n === 1) return '1 length';
  if (n < 1000) return `${n} lengths`;
  return `${(Math.floor(n / 100) / 10).toFixed(1)}k lengths`;
}

/**
 * The indicators to show: the nearest `MAX_PLAYER_INDICATORS` players with no part on screen,
 * nearest first, then every ping off screen within `PING_REACH_VIEWS` view radii.
 */
export function edgeIndicators(
  self: { x: number; y: number; radius: number },
  players: readonly IndicatorPlayer[],
  pings: readonly IndicatorPing[],
  p: LabelProjection,
): Indicator[] {
  const halfW = p.width / 2 / p.pxPerWu;
  const halfH = p.height / 2 / p.pxPerWu;
  const length = 2 * Math.max(self.radius, 1e-6);
  const offScreen = (x: number, y: number, r: number): boolean =>
    Math.abs(x - p.camX) - r > halfW || Math.abs(y - p.camY) - r > halfH;
  const make = (
    kind: Indicator['kind'],
    id: string,
    x: number,
    y: number,
    distance: number,
  ): Indicator => {
    const edge = edgePoint(x, y, p);
    return {
      kind,
      id,
      name: '',
      ping: -1,
      angle: (Math.atan2(y - self.y, x - self.x) * 180) / Math.PI,
      lengths: Math.round(distance / length),
      size: null,
      ready: false,
      x: edge.x,
      y: edge.y,
    };
  };

  const far: { player: IndicatorPlayer; distance: number }[] = [];
  for (const player of players) {
    if (player.alpha < MIN_ALPHA || !offScreen(player.x, player.y, player.radius)) continue;
    far.push({ player, distance: Math.hypot(player.x - self.x, player.y - self.y) });
  }
  far.sort((a, b) => a.distance - b.distance || (a.player.id < b.player.id ? -1 : 1));
  const out: Indicator[] = [];
  for (const { player, distance } of far.slice(0, MAX_PLAYER_INDICATORS)) {
    const indicator = make('player', player.id, player.x, player.y, distance);
    indicator.name = player.name;
    indicator.size = sizeClass(self.radius, player.radius);
    indicator.ready = player.ready;
    out.push(indicator);
  }
  const reach = PING_REACH_VIEWS * viewRadius(p);
  for (const ping of pings) {
    const distance = Math.hypot(ping.x - self.x, ping.y - self.y);
    if (distance > reach || !offScreen(ping.x, ping.y, 0)) continue;
    const indicator = make('ping', ping.from, ping.x, ping.y, distance);
    indicator.ping = ping.kind;
    out.push(indicator);
  }
  for (const i of out) keepClear(i, p);
  spread(out, p);
  for (const i of out) keepClear(i, p);
  return out;
}

/** Slides an indicator on the inset frame along its edge, out of the HUD's corners. */
function keepClear(i: { x: number; y: number }, p: LabelProjection): void {
  const lo = EDGE_INSET_PX;
  const hiX = Math.max(lo, p.width - EDGE_INSET_PX);
  const hiY = Math.max(lo, p.height - EDGE_INSET_PX);
  for (const c of HUD_CORNERS) {
    const left = c.corner.endsWith('left');
    const top = c.corner.startsWith('top');
    const dx = left ? i.x : p.width - i.x;
    const dy = top ? i.y : p.height - i.y;
    if (dx >= c.w || dy >= c.h) continue;
    // On a side it moves up or down that side; on the top or bottom it moves across.
    const side = Math.abs(i.x - lo) < 0.5 || Math.abs(i.x - hiX) < 0.5;
    if (side) i.y = clamp(top ? c.h : p.height - c.h, lo, hiY);
    else i.x = clamp(left ? c.w : p.width - c.w, lo, hiX);
  }
}

/**
 * Indicators closer than this (CSS pixels, both axes) would overlap their labels: an arrow over
 * two lines of text, about 9rem wide.
 */
export const SPREAD_PX = { x: 150, y: 64 } as const;

/**
 * Moves each indicator that overlaps an earlier one along its edge (down or up a side, across the
 * top or bottom), so nearer players keep their true spot. The bearing is left as it is.
 */
function spread(list: Indicator[], p: LabelProjection): void {
  const lo = EDGE_INSET_PX;
  const hiX = Math.max(lo, p.width - EDGE_INSET_PX);
  const hiY = Math.max(lo, p.height - EDGE_INSET_PX);
  for (let i = 1; i < list.length; i++) {
    const a = list[i] as Indicator;
    const side = Math.abs(a.x - lo) < 0.5 || Math.abs(a.x - hiX) < 0.5;
    for (let tries = 0; tries < 2 * list.length; tries++) {
      let hit: Indicator | undefined;
      for (let j = 0; j < i && !hit; j++) {
        const b = list[j] as Indicator;
        if (Math.abs(a.x - b.x) < SPREAD_PX.x && Math.abs(a.y - b.y) < SPREAD_PX.y) hit = b;
      }
      if (!hit) break;
      if (side) a.y = nudge(a.y, hit.y, SPREAD_PX.y, lo, hiY);
      else a.x = nudge(a.x, hit.x, SPREAD_PX.x, lo, hiX);
    }
  }
}

/** One step clear of `other`, on the side `v` is on, or the other side when that runs out of room. */
function nudge(v: number, other: number, gap: number, lo: number, hi: number): number {
  const away = v >= other ? other + gap : other - gap;
  if (away >= lo && away <= hi) return away;
  const back = v >= other ? other - gap : other + gap;
  return Math.min(hi, Math.max(lo, back));
}

/** Where the line from the screen's centre to a world point leaves the inset frame, in CSS pixels. */
function edgePoint(x: number, y: number, p: LabelProjection): { x: number; y: number } {
  const dx = screenX(x, p) - p.width / 2;
  const dy = screenY(y, p) - p.height / 2;
  const halfW = Math.max(1, p.width / 2 - EDGE_INSET_PX);
  const halfH = Math.max(1, p.height / 2 - EDGE_INSET_PX);
  const t = Math.min(
    dx === 0 ? Infinity : halfW / Math.abs(dx),
    dy === 0 ? Infinity : halfH / Math.abs(dy),
  );
  return { x: p.width / 2 + dx * t, y: p.height / 2 + dy * t };
}

// ---------------------------------------------------------------------------------------------
// On screen. Every shape is our own markup; names from other players go in as text only.

const SVG_NS = 'http://www.w3.org/2000/svg';

/**
 * The arrow's shape (pointing east, turned by the bearing) says the size: an open chevron for a
 * smaller creature, a solid head for a comparable one and a doubled, larger head for a bigger one.
 * A ping is a ring in its kind's dash pattern with a pointer on its rim.
 */
const ARROWS: Record<SizeClass | 'ping', string> = {
  smaller: '<path class="edge-line" d="M0 -6 L8 0 L0 6"/>',
  comparable: '<path class="edge-fill" d="M-5 -8 L11 0 L-5 8 L-1 0 Z"/>',
  bigger:
    '<path class="edge-line" d="M-14 -11 L-6 0 L-14 11"/><path class="edge-fill" d="M-7 -12 L15 0 L-7 12 L-2 0 Z"/>',
  ping: '<circle class="edge-ring" r="13"/><path class="edge-fill" d="M15 -5 L21 0 L15 5 Z"/>',
};
/** A heart beside the arrow: the creature says it could mate. */
const HEART = '<path class="edge-heart" d="M0 4 C-7 -1 -4 -7 0 -3 C4 -7 7 -1 0 4 Z"/>';

interface Shown {
  root: HTMLElement;
  turn: SVGGElement;
  heart: SVGGElement;
  glyph: HTMLElement;
  name: HTMLElement;
  detail: HTMLElement;
  shape: string;
}

export class EdgeIndicatorsUi {
  private readonly shown: Shown[] = [];

  constructor(private readonly root: HTMLElement) {}

  update(list: readonly Indicator[], p: LabelProjection): void {
    for (let i = 0; i < list.length; i++) this.draw(this.at(i), list[i] as Indicator, p);
    for (let i = list.length; i < this.shown.length; i++) {
      const el = (this.shown[i] as Shown).root;
      if (!el.hidden) el.hidden = true;
    }
  }

  private draw(s: Shown, ind: Indicator, p: LabelProjection): void {
    const shape = ind.kind === 'ping' ? 'ping' : (ind.size ?? 'comparable');
    if (s.shape !== shape) {
      s.shape = shape;
      s.turn.innerHTML = ARROWS[shape];
      s.root.dataset.size = shape;
    }
    s.root.dataset.kind = ind.kind;
    s.root.dataset.id = ind.id;
    if (ind.kind === 'ping') s.root.dataset.ping = String(ind.ping);
    else delete s.root.dataset.ping;
    s.turn.setAttribute('transform', `rotate(${Math.round(-ind.angle)})`);
    s.heart.style.display = ind.ready ? '' : 'none';
    s.root.dataset.ready = String(ind.ready);
    const ping = ind.kind === 'ping' ? PINGS[ind.ping] : undefined;
    showIcon(s.glyph, ping?.name ?? null);
    const lengths = lengthsText(ind.lengths);
    const name = ping ? `${ping.name} ping` : ind.name;
    const detail = [lengths];
    if (ind.size && ind.size !== 'comparable') detail.push(ind.size);
    if (ind.ready) detail.push('ready');
    setText(s.name, name);
    setText(s.detail, detail.join(' · '));
    const label = `${name}, ${detail.join(', ')}`;
    if (s.root.getAttribute('aria-label') !== label) s.root.setAttribute('aria-label', label);
    // The label sits under the arrow, or over it at the bottom edge, and keeps inside the sides.
    s.root.dataset.label = ind.y > p.height - LABEL_ROOM_PX ? 'above' : 'below';
    s.root.dataset.align =
      ind.x < LABEL_ROOM_PX ? 'start' : ind.x > p.width - LABEL_ROOM_PX ? 'end' : 'centre';
    if (s.root.hidden) s.root.hidden = false;
    placeAt(s.root, ind.x, ind.y, 'centre');
  }

  private at(i: number): Shown {
    let s = this.shown[i];
    if (!s) {
      const root = document.createElement('div');
      root.className = 'edge';
      root.dataset.testid = 'edge-indicator';
      root.setAttribute('role', 'img');
      const icon = document.createElement('div');
      icon.className = 'edge-icon';
      const svg = document.createElementNS(SVG_NS, 'svg');
      svg.setAttribute('viewBox', '-20 -20 40 40');
      svg.setAttribute('aria-hidden', 'true');
      const turn = document.createElementNS(SVG_NS, 'g');
      const heart = document.createElementNS(SVG_NS, 'g');
      heart.setAttribute('transform', 'translate(13 -13)');
      heart.innerHTML = HEART;
      svg.append(turn, heart);
      const glyph = document.createElement('span');
      glyph.className = 'edge-glyph';
      icon.append(svg, glyph);
      const text = document.createElement('div');
      text.className = 'edge-text';
      const name = document.createElement('span');
      name.className = 'edge-name';
      const detail = document.createElement('span');
      detail.className = 'edge-detail';
      const plate = document.createElement('div');
      plate.className = 'edge-plate';
      plate.append(name, detail);
      text.append(plate);
      root.append(icon, text);
      this.root.append(root);
      s = { root, turn, heart, glyph, name, detail, shape: '' };
      this.shown[i] = s;
    }
    return s;
  }
}
