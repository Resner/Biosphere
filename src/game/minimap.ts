// The minimap (M6b T10, DESIGN §9): a round, north-up map in the top-right corner, centred on the
// player and 6 view half-heights in radius. It shows the zones (the pond map's picture), the pond's
// edge when near, other players by size class, mate-ready hearts, live pings and the player as an
// arrow on its heading. The zone's name sits under it, and a slim depth gauge (M6c T12,
// `depth-gauge.ts`) left of it, with a UV or pressure icon beside the gauge while that hazard
// hurts; they replace the HUD's depth bar and the hazard overlays. A click on it (or M) opens the
// full pond map. The map draws on a 2D canvas at most 30 times a second; the arrow is its own
// CSS-rotated layer, turned every frame. Neither allocates per frame.

import type { Zone } from '../sim/bathymetry';
import { TAU } from '../sim/math';
import type { Seed } from '../sim/prng';
import { type SizeClass, sizeClass } from '../sim/size';
import { DepthGauge } from './depth-gauge';
import { pick, setText } from './dom';
import { zoneImage } from './pond-map';
import type { ZoneReadout } from './zone-readout';

export const MINIMAP = {
  /** Its side against the viewport's short side, and its least side in CSS pixels. */
  share: 0.12,
  minPx: 120,
  /** Its radius in view half-heights. */
  views: 6,
  /** The most the map redraws per second (the arrow turns every frame). */
  hz: 30,
  /** CSS pixels from the top (below the online counter) and from the right. */
  top: 48,
  inset: 12,
  /** Room under it for the zone's name, in CSS pixels. */
  label: 20,
  /** The depth gauge's width left of it, with its gap, in CSS pixels (`.minimap-depth`). */
  gauge: 50,
} as const;

/** The arrow layer's rotations, one every half degree, built once so a turn allocates nothing. */
const ARROW_STEPS = 720;
const ARROW_TRANSFORMS: readonly string[] = Array.from(
  { length: ARROW_STEPS },
  (_, i) => `rotate(${i === 0 ? 0 : -(360 * i) / ARROW_STEPS}deg)`,
);

/**
 * The player's arrow (M6c T12): an element over the canvas, rotated to the heading on every frame
 * so it turns smoothly between the map's draws. Writes its transform only when the step changes.
 */
export class ArrowLayer {
  private step = -1;

  constructor(private readonly el: { style: { transform: string } }) {}

  /** `heading` in radians, counter-clockwise from east (any turn count). */
  set(heading: number): void {
    const turns = heading / TAU;
    const step = Math.round((turns - Math.floor(turns)) * ARROW_STEPS) % ARROW_STEPS;
    if (step === this.step) return;
    this.step = step;
    this.el.style.transform = ARROW_TRANSFORMS[step] as string;
  }
}

/**
 * When the map draws: on a grid of `1 / hz` seconds, so a frame rate that is not a multiple of it
 * still draws at most `hz` times a second (plus one), and a long frame brings no catch-up burst.
 */
export class DrawClock {
  private next = -Infinity;

  constructor(private readonly hz: number) {}

  /** Whether to draw at `now` (milliseconds); a true answer books the next draw. */
  due(now: number): boolean {
    // Half a millisecond of slack keeps a frame that lands on the grid from slipping one.
    if (now < this.next - 0.5) return false;
    const period = 1000 / this.hz;
    this.next += period;
    if (this.next <= now) this.next = now + period;
    return true;
  }

  /** Draws on the next frame whatever its timing. */
  reset(): void {
    this.next = -Infinity;
  }
}

export type MinimapMark = SizeClass | 'ready';
export type MinimapHazard = 'uv' | 'pressure';

/** The minimap's side in CSS pixels for a viewport: 12% of its short side, at least 120 px. */
export function minimapSide(width: number, height: number): number {
  return Math.max(MINIMAP.minPx, Math.round(MINIMAP.share * Math.min(width, height)));
}

/** The corner the minimap, its depth gauge and its label take, for the edge indicators to keep out of. */
export function minimapCorner(
  width: number,
  height: number,
): { corner: 'top-right'; w: number; h: number } {
  const side = minimapSide(width, height);
  return {
    corner: 'top-right',
    w: MINIMAP.inset + side + MINIMAP.gauge + 28,
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
  /** The heading the arrow shows, radians (the drawn cell's, this frame). */
  heading: number;
  /** The round marks the last draw painted: other players and pings, nothing else (M6c T12). */
  marks: { players: number; pings: number };
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
const INK = '#e3f4f0';
const SHADOW = 'rgb(0 0 0 / 0.75)';
const HEART = '#ff8fc8';

export class Minimap {
  private readonly frame = pick('.minimap');
  private readonly root = pick<HTMLButtonElement>('[data-testid="minimap"]');
  private readonly canvas = pick<HTMLCanvasElement>('[data-testid="minimap-canvas"]');
  private readonly zoneLabel = pick('[data-testid="minimap-zone"]');
  private readonly hazardIcon = pick('[data-testid="minimap-hazard"]');
  private readonly hazardText = pick('[data-testid="hud-zone-warning"]');
  private readonly context: CanvasRenderingContext2D | null;
  private readonly arrow = new ArrowLayer(pick<SVGSVGElement>('[data-testid="minimap-arrow"]'));
  private readonly gauge = new DepthGauge();
  private readonly clock = new DrawClock(MINIMAP.hz);
  private heading = 0;
  private side = 0;
  private dpr = 1;
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
  private glaze: CanvasGradient | null = null;
  private image: HTMLCanvasElement | null = null;
  private imageSeed: Seed | null = null;
  private imageSize = 0;

  constructor(onOpen: () => void) {
    this.context = this.canvas.getContext('2d');
    this.heart =
      typeof Path2D === 'function'
        ? new Path2D('M0 3.6 C-6.4 -0.8 -3.6 -6.4 0 -2.8 C3.6 -6.4 6.4 -0.8 0 3.6 Z')
        : null;
    this.root.addEventListener('click', () => {
      // A clicked button keeps no focus, so Space stays the dash key.
      this.root.blur();
      onOpen();
    });
    window.addEventListener('resize', () => this.measure());
    this.measure();
  }

  /** Turns the arrow every frame and redraws the map at most `MINIMAP.hz` times a second; `now` in milliseconds. */
  update(now: number, view: MinimapView): void {
    this.heading = view.self.heading;
    this.arrow.set(view.self.heading);
    if (!this.clock.due(now)) return;
    this.radiusWu = MINIMAP.views * view.halfHeight;
    this.setReadout(view.readout);
    this.draw(view);
  }

  /** Draws on the next update whatever its timing (a new life, a resize). */
  invalidate(): void {
    this.clock.reset();
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
      heading: this.heading,
      marks: { players: this.markCount, pings: this.pingCount },
      players,
      pings,
    };
  }

  private setReadout(readout: ZoneReadout | null): void {
    this.zone = readout?.zone ?? null;
    this.depth = readout?.depth ?? null;
    this.gauge.set(this.depth);
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
      this.image = zoneImage(view.seed, view.size);
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
    ctx.restore();

    // The rim.
    ctx.strokeStyle = 'rgb(200 240 255 / 0.35)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(half, half, half - 0.5, 0, TAU);
    ctx.stroke();
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
