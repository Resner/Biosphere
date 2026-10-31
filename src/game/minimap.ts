// The minimap (M6b T10, DESIGN §9): a round, north-up map in the top-right corner, centred on the
// player and 6 view half-heights in radius. It shows the zones (the pond map's picture), the pond's
// edge when near, other players by size class, mate-ready hearts, live pings and the player as an
// arrow on its heading. A depth arc on its right rim marks the player's depth, the zone's name sits
// under it, and a UV or pressure icon sits on the rim while that hazard hurts; it replaces the
// depth gauge and the hazard overlays. A click on it (or M) opens the full pond map. It draws on a
// 2D canvas at most 10 times a second and allocates nothing per draw.

import type { Zone } from '../sim/bathymetry';
import { clamp, lerp, TAU } from '../sim/math';
import type { Seed } from '../sim/prng';
import { RULES } from '../sim/rules';
import { type SizeClass, sizeClass } from '../sim/size';
import { pick, setText } from './dom';
import { EDGE_LIGHTEN, MAP_COLOURS, zoneImage } from './pond-map';
import type { ZoneReadout } from './zone-readout';

export const MINIMAP = {
  /** Its side against the viewport's short side, and its least side in CSS pixels. */
  share: 0.12,
  minPx: 120,
  /** Its radius in view half-heights. */
  views: 6,
  /** The most it redraws per second. */
  hz: 10,
  /** CSS pixels from the top (below the online counter) and from the right. */
  top: 48,
  inset: 12,
  /** Room under it for the zone's name, in CSS pixels. */
  label: 20,
} as const;

/** The depth arc on the right rim: from the surface (upper right) down to the abyss floor (lower right), canvas radians. */
export const DEPTH_ARC = { from: -Math.PI / 3.6, to: Math.PI / 3.6 } as const;

export type MinimapMark = SizeClass | 'ready';
export type MinimapHazard = 'uv' | 'pressure';

/** The minimap's side in CSS pixels for a viewport: 12% of its short side, at least 120 px. */
export function minimapSide(width: number, height: number): number {
  return Math.max(MINIMAP.minPx, Math.round(MINIMAP.share * Math.min(width, height)));
}

/** The corner the minimap and its label take, for the edge indicators to keep out of. */
export function minimapCorner(
  width: number,
  height: number,
): { corner: 'top-right'; w: number; h: number } {
  const side = minimapSide(width, height);
  return {
    corner: 'top-right',
    w: MINIMAP.inset + side + 28,
    h: MINIMAP.top + side + MINIMAP.label + 16,
  };
}

/**
 * Where a world offset from the player (`dx` east, `dy` north, world units) sits on a minimap of
 * `side` CSS pixels covering `radiusWu`, and whether it is inside its disc. Writes into `out`.
 */
export function onMinimap(
  dx: number,
  dy: number,
  radiusWu: number,
  side: number,
  out: { x: number; y: number; inside: boolean },
): void {
  const half = side / 2;
  const k = half / radiusWu;
  out.x = half + dx * k;
  out.y = half - dy * k;
  out.inside = dx * dx + dy * dy <= radiusWu * radiusWu;
}

/** A player's mark: a heart when it could mate, else its size class against the player's. */
export function minimapMark(
  selfRadius: number,
  other: { radius: number; ready: boolean },
): MinimapMark {
  return other.ready ? 'ready' : sizeClass(selfRadius, other.radius);
}

/** The depth arc's angle for a depth (0 the surface, 1 the abyss floor), canvas radians. */
export function depthArcAngle(depth: number): number {
  return DEPTH_ARC.from + (DEPTH_ARC.to - DEPTH_ARC.from) * clamp(depth, 0, 1);
}

/** The hazard hurting the player now, if any. */
export function minimapHazard(readout: ZoneReadout): MinimapHazard | null {
  return readout.uv ? 'uv' : readout.pressure ? 'pressure' : null;
}

export interface MinimapPlayer {
  id: string;
  x: number;
  y: number;
  radius: number;
  ready: boolean;
  alpha: number;
}

export interface MinimapPing {
  from: string;
  kind: number;
  x: number;
  y: number;
}

/** What the minimap shows; the game reuses one object and refreshes it every frame. */
export interface MinimapView {
  seed: Seed;
  size: number;
  self: { x: number; y: number; heading: number; radius: number };
  /** The camera's half-height in world units. */
  halfHeight: number;
  /** The screen's width over its height, for the view's outline. */
  aspect: number;
  players: readonly MinimapPlayer[];
  pings: readonly MinimapPing[];
  readout: ZoneReadout | null;
}

/** A mark as drawn, for the test hook: CSS pixels inside the minimap. */
interface DrawnMark {
  id: string;
  x: number;
  y: number;
  size: SizeClass;
  ready: boolean;
}

interface DrawnPing {
  id: string;
  kind: number;
  x: number;
  y: number;
}

export interface MinimapInfo {
  shown: boolean;
  radiusWu: number;
  zone: Zone | null;
  depth: number | null;
  hazard: MinimapHazard | null;
  players: DrawnMark[];
  pings: DrawnPing[];
}

/** Players fainter than this are going quiet (a hidden tab) and are left off, as on the edge. */
const MIN_ALPHA = 0.5;
const HAZARD_TEXT: Record<MinimapHazard, string> = { uv: 'UV burns', pressure: 'Pressure crushes' };
/** Each ping kind's colour and line pattern (look, danger, food, mate): never colour alone. */
const PING_STYLE: readonly { colour: string; dash: number[] }[] = [
  { colour: '#c8f2ff', dash: [] },
  { colour: '#f0b44a', dash: [3, 2] },
  { colour: '#8de88a', dash: [1.2, 2.2] },
  { colour: '#ff8fc8', dash: [5, 2, 1.2, 2] },
];
const NO_DASH: number[] = [];
/** Canvas filters for the zone picture's blur, by whole CSS pixels (built once, not per draw). */
const BLURS: readonly string[] = [
  'none',
  ...Array.from({ length: 10 }, (_, i) => `blur(${i + 1}px)`),
];
const ZONE_EDGES: readonly number[] = [
  0,
  RULES.bathymetry.zones.shallows,
  RULES.bathymetry.zones.twilight,
  RULES.bathymetry.zones.deep,
  1,
];
const INK = '#e3f4f0';
const SHADOW = 'rgb(0 0 0 / 0.75)';
const HEART = '#ff8fc8';
/** The zones' colours on the depth arc: the map's, lifted so the darkest still reads on glass. */
const ARC_COLOURS: readonly string[] = (['shallows', 'twilight', 'deep', 'abyss'] as const).map(
  (zone) =>
    `rgb(${MAP_COLOURS[zone].map((c) => Math.round(lerp(c, 1, EDGE_LIGHTEN) * 255)).join(' ')})`,
);

export class Minimap {
  private readonly frame = pick('.minimap');
  private readonly root = pick<HTMLButtonElement>('[data-testid="minimap"]');
  private readonly canvas = pick<HTMLCanvasElement>('[data-testid="minimap-canvas"]');
  private readonly zoneLabel = pick('[data-testid="minimap-zone"]');
  private readonly hazardIcon = pick('[data-testid="minimap-hazard"]');
  private readonly hazardText = pick('[data-testid="hud-zone-warning"]');
  private readonly context: CanvasRenderingContext2D | null;
  private side = 0;
  private dpr = 1;
  private lastDraw = -Infinity;
  private radiusWu = 0;
  private zone: Zone | null = null;
  private depth: number | null = null;
  private hazard: MinimapHazard | null = null;
  private readonly marks: DrawnMark[] = [];
  private markCount = 0;
  private readonly pingMarks: DrawnPing[] = [];
  private pingCount = 0;
  private readonly at = { x: 0, y: 0, inside: false };
  private readonly heart: Path2D | null;
  private readonly arrow: Path2D | null;
  private glaze: CanvasGradient | null = null;
  private image: HTMLCanvasElement | null = null;
  private imageSeed: Seed | null = null;
  private imageSize = 0;

  constructor(onOpen: () => void) {
    this.context = this.canvas.getContext('2d');
    const path2d = typeof Path2D === 'function';
    this.heart = path2d
      ? new Path2D('M0 3.6 C-6.4 -0.8 -3.6 -6.4 0 -2.8 C3.6 -6.4 6.4 -0.8 0 3.6 Z')
      : null;
    // Points east; turned by the heading.
    this.arrow = path2d ? new Path2D('M7 0 L-4.5 -4.6 L-2.2 0 L-4.5 4.6 Z') : null;
    this.root.addEventListener('click', () => {
      // A clicked button keeps no focus, so Space stays the dash key.
      this.root.blur();
      onOpen();
    });
    window.addEventListener('resize', () => this.measure());
    this.measure();
  }

  /** Redraws, at most `MINIMAP.hz` times a second; `now` in milliseconds. */
  update(now: number, view: MinimapView): void {
    if (now - this.lastDraw < 1000 / MINIMAP.hz) return;
    this.lastDraw = now;
    this.radiusWu = MINIMAP.views * view.halfHeight;
    this.setReadout(view.readout);
    this.draw(view);
  }

  /** Draws on the next update whatever its timing (a new life, a resize). */
  invalidate(): void {
    this.lastDraw = -Infinity;
  }

  info(): MinimapInfo {
    const players: DrawnMark[] = [];
    for (let i = 0; i < this.markCount; i++) players.push({ ...(this.marks[i] as DrawnMark) });
    const pings: DrawnPing[] = [];
    for (let i = 0; i < this.pingCount; i++) pings.push({ ...(this.pingMarks[i] as DrawnPing) });
    return {
      shown: this.root.checkVisibility(),
      radiusWu: this.radiusWu,
      zone: this.zone,
      depth: this.depth,
      hazard: this.hazard,
      players,
      pings,
    };
  }

  private setReadout(readout: ZoneReadout | null): void {
    this.zone = readout?.zone ?? null;
    this.depth = readout?.depth ?? null;
    setText(this.zoneLabel, readout?.name ?? '');
    const hazard = readout ? minimapHazard(readout) : null;
    if (hazard === this.hazard) return;
    this.hazard = hazard;
    this.hazardIcon.hidden = hazard === null;
    if (hazard) this.hazardIcon.dataset.hazard = hazard;
    else delete this.hazardIcon.dataset.hazard;
    const text = hazard ? HAZARD_TEXT[hazard] : '';
    setText(this.hazardText, text);
    this.hazardIcon.setAttribute('aria-label', text);
    this.hazardIcon.setAttribute('title', text);
  }

  private measure(): void {
    const side = minimapSide(window.innerWidth, window.innerHeight);
    const dpr = window.devicePixelRatio || 1;
    if (side === this.side && dpr === this.dpr) return;
    this.side = side;
    this.dpr = dpr;
    this.frame.style.setProperty('--minimap-side', `${side}px`);
    this.canvas.width = Math.round(side * dpr);
    this.canvas.height = Math.round(side * dpr);
    this.glaze = null;
    this.invalidate();
  }

  private draw(view: MinimapView): void {
    const ctx = this.context;
    const side = this.side;
    const half = side / 2;
    const radiusWu = this.radiusWu;
    this.markCount = 0;
    this.pingCount = 0;
    if (!ctx || !(radiusWu > 0)) return;
    const k = half / radiusWu;
    const { self } = view;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, side, side);

    ctx.save();
    ctx.beginPath();
    ctx.arc(half, half, half - 1, 0, TAU);
    ctx.clip();
    // Beyond the pond: the darkest water.
    ctx.fillStyle = '#020608';
    ctx.fillRect(0, 0, side, side);
    // The zones, from the pond map's picture (north up), softened by smoothing.
    // The picture is looked up only when the pond changes (its key is a new string).
    if (view.seed !== this.imageSeed || view.size !== this.imageSize || !this.image) {
      this.imageSeed = view.seed;
      this.imageSize = view.size;
      this.image = zoneImage(view.seed, view.size, 'plain');
    }
    const image = this.image;
    // A blur of about half a texel rounds the picture's steps into the zones' soft edges.
    const texel = (view.size / image.width) * k;
    ctx.imageSmoothingEnabled = true;
    ctx.filter = BLURS[Math.min(BLURS.length - 1, Math.round(texel * 0.6))] as string;
    ctx.globalAlpha = 0.85;
    ctx.drawImage(
      image,
      half - self.x * k,
      half - (view.size - self.y) * k,
      view.size * k,
      view.size * k,
    );
    ctx.globalAlpha = 1;
    ctx.filter = 'none';
    // The glass: darker toward the rim so the marks read.
    if (!this.glaze) {
      this.glaze = ctx.createRadialGradient(half, half, half * 0.35, half, half, half);
      this.glaze.addColorStop(0, 'rgb(4 12 16 / 0.12)');
      this.glaze.addColorStop(1, 'rgb(4 12 16 / 0.55)');
    }
    ctx.fillStyle = this.glaze;
    ctx.fillRect(0, 0, side, side);
    // The pond's edge, when near.
    ctx.strokeStyle = 'rgb(227 244 240 / 0.6)';
    ctx.lineWidth = 1.5;
    ctx.setLineDash(NO_DASH);
    ctx.strokeRect(
      half - self.x * k,
      half - (view.size - self.y) * k,
      view.size * k,
      view.size * k,
    );
    // What the screen shows, faintly, for scale.
    const viewW = view.halfHeight * view.aspect * k;
    const viewH = view.halfHeight * k;
    ctx.strokeStyle = 'rgb(227 244 240 / 0.2)';
    ctx.lineWidth = 1;
    ctx.strokeRect(half - viewW, half - viewH, 2 * viewW, 2 * viewH);

    this.drawPings(ctx, view);
    this.drawPlayers(ctx, view);
    // The player: an arrow on its heading, at the centre.
    if (this.arrow) {
      ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
      ctx.translate(half, half);
      ctx.rotate(-self.heading);
      ctx.fillStyle = '#7fffe0';
      ctx.strokeStyle = SHADOW;
      ctx.lineWidth = 1.5;
      ctx.stroke(this.arrow);
      ctx.fill(this.arrow);
      ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    }
    ctx.restore();

    // The rim, and the depth arc on its right side: the zones in order, the player's depth marked.
    ctx.strokeStyle = 'rgb(200 240 255 / 0.35)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(half, half, half - 0.5, 0, TAU);
    ctx.stroke();
    const arcR = half - 5;
    ctx.lineWidth = 3;
    ctx.lineCap = 'butt';
    for (let i = 0; i < 4; i++) {
      ctx.strokeStyle = ARC_COLOURS[i] as string;
      ctx.beginPath();
      ctx.arc(
        half,
        half,
        arcR,
        depthArcAngle(ZONE_EDGES[i] as number),
        depthArcAngle(ZONE_EDGES[i + 1] as number),
      );
      ctx.stroke();
    }
    if (this.depth !== null) {
      const a = depthArcAngle(this.depth);
      const x = half + arcR * Math.cos(a);
      const y = half + arcR * Math.sin(a);
      ctx.fillStyle = INK;
      ctx.strokeStyle = SHADOW;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(x, y, 3.5, 0, TAU);
      ctx.stroke();
      ctx.fill();
      // A notch pointing in from the rim, so the mark reads without its colour.
      ctx.strokeStyle = INK;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(x - 6 * Math.cos(a), y - 6 * Math.sin(a));
      ctx.lineTo(x - 11 * Math.cos(a), y - 11 * Math.sin(a));
      ctx.stroke();
    }
  }

  private drawPings(ctx: CanvasRenderingContext2D, view: MinimapView): void {
    for (const ping of view.pings) {
      onMinimap(ping.x - view.self.x, ping.y - view.self.y, this.radiusWu, this.side, this.at);
      if (!this.at.inside) continue;
      const style = PING_STYLE[ping.kind] ?? (PING_STYLE[0] as (typeof PING_STYLE)[number]);
      ctx.strokeStyle = style.colour;
      ctx.lineWidth = 1.6;
      ctx.setLineDash(style.dash);
      ctx.beginPath();
      ctx.arc(this.at.x, this.at.y, 6, 0, TAU);
      ctx.stroke();
      ctx.setLineDash(NO_DASH);
      ctx.fillStyle = style.colour;
      ctx.beginPath();
      ctx.arc(this.at.x, this.at.y, 1.6, 0, TAU);
      ctx.fill();
      const mark = this.pingMarks[this.pingCount] ?? { id: '', kind: 0, x: 0, y: 0 };
      this.pingMarks[this.pingCount++] = mark;
      mark.id = ping.from;
      mark.kind = ping.kind;
      mark.x = this.at.x;
      mark.y = this.at.y;
    }
  }

  private drawPlayers(ctx: CanvasRenderingContext2D, view: MinimapView): void {
    const { self } = view;
    for (const player of view.players) {
      if (player.alpha < MIN_ALPHA) continue;
      onMinimap(player.x - self.x, player.y - self.y, this.radiusWu, this.side, this.at);
      if (!this.at.inside) continue;
      const kind = minimapMark(self.radius, player);
      const { x, y } = this.at;
      ctx.strokeStyle = SHADOW;
      ctx.fillStyle = INK;
      ctx.lineWidth = 1.5;
      if (kind === 'ready' && this.heart) {
        ctx.setTransform(this.dpr, 0, 0, this.dpr, this.dpr * x, this.dpr * y);
        ctx.fillStyle = HEART;
        ctx.stroke(this.heart);
        ctx.fill(this.heart);
        ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
      } else if (kind === 'smaller') {
        // An open ring: smaller than you.
        ctx.beginPath();
        ctx.arc(x, y, 3.2, 0, TAU);
        ctx.lineWidth = 3;
        ctx.stroke();
        ctx.strokeStyle = INK;
        ctx.lineWidth = 1.4;
        ctx.stroke();
      } else {
        // A solid dot: comparable; ringed again: bigger.
        ctx.beginPath();
        ctx.arc(x, y, 3.6, 0, TAU);
        ctx.stroke();
        ctx.fill();
        if (kind === 'bigger') {
          ctx.beginPath();
          ctx.arc(x, y, 7, 0, TAU);
          ctx.lineWidth = 3;
          ctx.stroke();
          ctx.strokeStyle = INK;
          ctx.lineWidth = 1.4;
          ctx.stroke();
        }
      }
      const mark = this.marks[this.markCount] ?? {
        id: '',
        x: 0,
        y: 0,
        size: 'comparable' as SizeClass,
        ready: false,
      };
      this.marks[this.markCount++] = mark;
      mark.id = player.id;
      mark.x = x;
      mark.y = y;
      mark.size = sizeClass(self.radius, player.radius);
      mark.ready = player.ready;
    }
  }
}
