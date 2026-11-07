// The map (M6 T19, M11 T18, `M`): a square of the world centred on the player (`map-view.ts`),
// charted from its own depth window (`depth-chart.ts`): you ringed, linked players as dots with
// names (mate-ready players as hearts), players known but not linked as hollow marks fading with
// age, the spawn centre and the world's edge when in the square, and the live pings. It lies over
// the water without taking the pointer, so steering carries on under it; `M` or Esc closes it.

import type { Zone } from '../sim/bathymetry';
import { ChartCanvas, type ChartImage, mapChart } from './depth-chart';
import { pick, setText } from './dom';
import { showIcon } from './icons';
import { MAP_COLOURS } from './map-relief';
import { type MapMark, type MapView, mapMarks, mapSpot, squareShows } from './map-view';
import { DrawClock } from './minimap';
import { PINGS } from './social-ui';

/** The most the chart redraws per second (the marks move every frame). */
const MAP_HZ = 30;
const SVG_NS = 'http://www.w3.org/2000/svg';
/** You are a ring, linked players dots, ready ones hearts and sightings hollow rings: shape, not colour alone. */
const MARKS: Record<MapMark['mark'], string> = {
  self: '<circle class="map-ring" r="7"/><circle class="map-core" r="2.5"/>',
  player: '<circle class="map-core" r="4"/>',
  ready: '<path class="map-heart" d="M0 5 C-9 -1 -5 -9 0 -4 C5 -9 9 -1 0 5 Z"/>',
  known: '<circle class="map-hollow-shade" r="4.5"/><circle class="map-hollow" r="4.5"/>',
};
const BEYOND = '#020608';
const EDGE = 'rgb(227 244 240 / 0.6)';
const INK = '#e3f4f0';
const SHADOW = 'rgb(0 0 0 / 0.8)';

interface Dot {
  root: HTMLElement;
  svg: SVGSVGElement;
  label: HTMLElement;
  mark: MapMark['mark'] | '';
  opacity: string;
}

/** What the map showed last, for the test hook. */
export interface MapInfo {
  open: boolean;
  /** You and the linked players. */
  players: number;
  /** Players known but not linked (hollow marks). */
  known: number;
  pings: number;
  /** The square's side, wu. */
  side: number;
  /** Whether a chart covers the whole square (until then the last one shows where it lies). */
  chart: boolean;
  spawn: boolean;
  edge: boolean;
}

export class PondMap {
  private readonly panel = pick('[data-testid="pond-map"]');
  private readonly frame = pick('[data-testid="map-frame"]');
  private readonly canvas = pick<HTMLCanvasElement>('[data-testid="map-zones"]');
  private readonly context: CanvasRenderingContext2D | null;
  private readonly marks = pick('[data-testid="map-marks"]');
  private readonly dots = new Map<string, Dot>();
  private readonly pingEls: HTMLElement[] = [];
  private readonly chart = new ChartCanvas(mapChart());
  private readonly clock = new DrawClock(MAP_HZ);
  /** The frame's side in CSS pixels, measured when the map opens or the window resizes. */
  private side = 0;
  private dpr = 1;
  private shown: Omit<MapInfo, 'open'> = {
    players: 0,
    known: 0,
    pings: 0,
    side: 0,
    chart: false,
    spawn: false,
    edge: false,
  };

  constructor() {
    this.context = this.canvas.getContext('2d');
    for (const swatch of this.panel.querySelectorAll<HTMLElement>('[data-zone]')) {
      const colour = MAP_COLOURS[swatch.dataset.zone as Zone];
      if (colour)
        swatch.style.background = `rgb(${colour.map((c) => Math.round(c * 255)).join(' ')})`;
    }
    window.addEventListener('resize', () => {
      if (this.isOpen) this.measure();
    });
  }

  get isOpen(): boolean {
    return !this.panel.hidden;
  }

  toggle(): void {
    if (this.isOpen) this.close();
    else this.open();
  }

  open(): void {
    this.panel.hidden = false;
    this.measure();
  }

  close(): void {
    if (!this.panel.hidden) this.panel.hidden = true;
  }

  /** What it shows, for the test hook. */
  info(): MapInfo {
    if (!this.isOpen)
      return { ...this.shown, open: false, players: 0, known: 0, pings: 0, chart: false };
    return { ...this.shown, open: true };
  }

  /** Redraws the marks, and the chart at most `MAP_HZ` times a second; call each frame while open. */
  update(now: number, view: MapView): void {
    if (!this.isOpen) return;
    const { self, side } = view;
    const seen = new Set<string>();
    let players = 0;
    let known = 0;
    for (const mark of mapMarks(view)) {
      seen.add(mark.id);
      if (mark.mark === 'known') known++;
      else players++;
      this.dot(mark);
    }
    for (const [id, dot] of this.dots) {
      if (seen.has(id)) continue;
      dot.root.remove();
      this.dots.delete(id);
    }
    let pings = 0;
    for (const ping of view.pings) {
      const at = mapSpot(ping.x, ping.y, self.x, self.y, side);
      if (!at.inside) continue;
      let el = this.pingEls[pings];
      if (!el) {
        el = document.createElement('span');
        el.className = 'map-ping';
        el.dataset.testid = 'map-ping';
        this.marks.append(el);
        this.pingEls[pings] = el;
      }
      const kind = PINGS[ping.kind];
      showIcon(el, kind?.name ?? null);
      el.dataset.kind = String(ping.kind);
      el.setAttribute('aria-label', `${kind?.name ?? ''} ping`);
      el.style.transform = this.place(at.u, at.v);
      el.hidden = false;
      pings++;
    }
    for (let i = pings; i < this.pingEls.length; i++)
      (this.pingEls[i] as HTMLElement).hidden = true;
    // The chart does a frame's work every frame, and is drawn at most `MAP_HZ` times a second.
    const image = this.chart.update(view.seed, view.size, self.x, self.y, side);
    const shows = squareShows(self.x, self.y, side, view.size);
    const h = side / 2;
    const chart =
      image !== null &&
      image.x <= self.x - h &&
      image.y <= self.y - h &&
      image.x + image.side >= self.x + h &&
      image.y + image.side >= self.y + h;
    this.shown = { players, known, pings, side, chart, ...shows };
    if (this.clock.due(now)) this.draw(view, image, shows);
  }

  private dot(mark: MapMark): void {
    let dot = this.dots.get(mark.id);
    if (!dot) {
      const root = document.createElement('span');
      root.className = 'map-dot';
      root.dataset.testid = 'map-dot';
      root.dataset.id = mark.id;
      const svg = document.createElementNS(SVG_NS, 'svg');
      svg.setAttribute('viewBox', '-10 -10 20 20');
      svg.setAttribute('aria-hidden', 'true');
      const label = document.createElement('span');
      label.className = 'map-label';
      root.append(svg, label);
      this.marks.append(root);
      dot = { root, svg, label, mark: '', opacity: '' };
      this.dots.set(mark.id, dot);
    }
    if (dot.mark !== mark.mark) {
      dot.mark = mark.mark;
      dot.svg.innerHTML = MARKS[mark.mark];
      dot.root.dataset.mark = mark.mark;
      dot.root.dataset.self = String(mark.mark === 'self');
      dot.root.dataset.ready = String(mark.mark === 'ready');
    }
    // Names come from other players: text only.
    const who = mark.mark === 'self' ? 'You' : mark.name;
    setText(dot.label, mark.mark === 'ready' ? `${who} · ready` : who);
    const opacity = mark.alpha >= 1 ? '' : mark.alpha.toFixed(2);
    if (opacity !== dot.opacity) {
      dot.opacity = opacity;
      dot.root.style.opacity = opacity;
    }
    dot.root.style.transform = this.place(mark.u, mark.v);
  }

  /** A transform that centres a mark on a spot of the map, on whole pixels. */
  private place(u: number, v: number): string {
    return `translate(${Math.round(u * this.side)}px, ${Math.round(v * this.side)}px)`;
  }

  private measure(): void {
    this.side = this.frame.clientWidth;
    this.dpr = window.devicePixelRatio || 1;
    const px = Math.max(1, Math.round(this.side * this.dpr));
    if (this.canvas.width !== px) {
      this.canvas.width = px;
      this.canvas.height = px;
    }
    this.clock.reset();
  }

  /** The chart, the world's edge and the spawn centre, north up around the player. */
  private draw(view: MapView, image: ChartImage | null, shows: { spawn: boolean; edge: boolean }) {
    const ctx = this.context;
    const px = this.side;
    if (!ctx || !(px > 0)) return;
    const { self, side, size } = view;
    const k = px / side;
    // Screen x and y of a world point.
    const sx = (x: number) => px / 2 + (x - self.x) * k;
    const sy = (y: number) => px / 2 - (y - self.y) * k;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.fillStyle = BEYOND;
    ctx.fillRect(0, 0, px, px);
    if (image) {
      ctx.imageSmoothingEnabled = true;
      ctx.drawImage(
        image.image,
        sx(image.x),
        sy(image.y + image.side),
        image.side * k,
        image.side * k,
      );
    }
    if (shows.edge) {
      ctx.strokeStyle = EDGE;
      ctx.lineWidth = 1.5;
      ctx.strokeRect(sx(0), sy(size), size * k, size * k);
    }
    if (shows.spawn) {
      // A diamond with its name: no player mark is square.
      const x = sx(size / 2);
      const y = sy(size / 2);
      ctx.beginPath();
      ctx.moveTo(x, y - 6);
      ctx.lineTo(x + 6, y);
      ctx.lineTo(x, y + 6);
      ctx.lineTo(x - 6, y);
      ctx.closePath();
      ctx.lineWidth = 3.5;
      ctx.strokeStyle = SHADOW;
      ctx.stroke();
      ctx.lineWidth = 1.4;
      ctx.strokeStyle = INK;
      ctx.stroke();
      // Its name to the left, where no mark's name goes.
      ctx.font = '11px system-ui, sans-serif';
      ctx.textAlign = 'right';
      ctx.textBaseline = 'middle';
      ctx.lineWidth = 3;
      ctx.strokeStyle = SHADOW;
      ctx.strokeText('Spawn', x - 9, y);
      ctx.fillStyle = INK;
      ctx.fillText('Spawn', x - 9, y);
    }
  }
}
