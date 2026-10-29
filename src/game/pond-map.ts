// The pond map (M6 T19, `M`): the pond's bounds and depth zones, every player as a dot (the player
// ringed, mate-ready players as hearts) and the live pings. It lies over the water without taking
// the pointer, so steering carries on under it; `M` or Esc closes it.

import { depthGrid, ZONE_TEXTURE_SIZE } from '../render/zones';
import { type Zone, zoneOfDepth } from '../sim/bathymetry';
import { clamp } from '../sim/math';
import type { Seed } from '../sim/prng';
import { pick, setText } from './dom';
import { showIcon } from './icons';
import { PINGS } from './social-ui';

/** How far an edge texel is lightened, so zones are told apart by a line as well as a colour. */
const EDGE_LIGHTEN = 0.45;

/**
 * Each zone's colour on the map: its water brightened to read on a small picture, getting darker
 * with depth so brightness alone separates them (the legend names them too).
 */
export const MAP_COLOURS: Readonly<Record<Zone, readonly [number, number, number]>> = {
  shallows: [0.3, 0.66, 0.54],
  twilight: [0.1, 0.3, 0.36],
  deep: [0.04, 0.1, 0.22],
  abyss: [0.02, 0.025, 0.06],
};

/** A world position on the map, 0..1 from the left and from the top (north up). */
export function mapSpot(x: number, y: number, size: number): { u: number; v: number } {
  return { u: clamp(x / size, 0, 1), v: clamp(1 - y / size, 0, 1) };
}

/**
 * RGBA pixels for a depth grid of `n` × `n` bytes (row = y, south first, as `depthGrid` gives):
 * row 0 of the picture is the north edge, and a texel beside another zone is drawn lighter.
 */
export function zonePixels(grid: Uint8Array, n: number): Uint8ClampedArray<ArrayBuffer> {
  const zones: Zone[] = Array.from(grid, (d) => zoneOfDepth(d / 255));
  const zoneAt = (i: number, j: number): Zone | null =>
    i < 0 || j < 0 || i >= n || j >= n ? null : (zones[j * n + i] as Zone);
  const out = new Uint8ClampedArray(new ArrayBuffer(n * n * 4));
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const zone = zoneAt(i, j) as Zone;
      const edge = [zoneAt(i + 1, j), zoneAt(i - 1, j), zoneAt(i, j + 1), zoneAt(i, j - 1)].some(
        (z) => z !== null && z !== zone,
      );
      const o = ((n - 1 - j) * n + i) * 4;
      MAP_COLOURS[zone].forEach((c, k) => {
        out[o + k] = Math.round((edge ? c + (1 - c) * EDGE_LIGHTEN : c) * 255);
      });
      out[o + 3] = 255;
    }
  }
  return out;
}

export interface MapPlayer {
  id: string;
  name: string;
  x: number;
  y: number;
  ready: boolean;
}

export interface MapView {
  seed: Seed;
  size: number;
  self: MapPlayer;
  players: readonly MapPlayer[];
  pings: readonly { kind: number; x: number; y: number }[];
}

const SVG_NS = 'http://www.w3.org/2000/svg';
/** The player is a ring, others dots, and players ready to mate hearts: shape, not colour alone. */
const MARKS = {
  self: '<circle class="map-ring" r="7"/><circle class="map-core" r="2.5"/>',
  other: '<circle class="map-core" r="4"/>',
  ready: '<path class="map-heart" d="M0 5 C-9 -1 -5 -9 0 -4 C5 -9 9 -1 0 5 Z"/>',
} as const;

interface Dot {
  root: HTMLElement;
  svg: SVGSVGElement;
  label: HTMLElement;
  mark: keyof typeof MARKS | '';
}

export class PondMap {
  private readonly panel = pick('[data-testid="pond-map"]');
  private readonly frame = pick('[data-testid="map-frame"]');
  private readonly canvas = pick<HTMLCanvasElement>('[data-testid="map-zones"]');
  private readonly marks = pick('[data-testid="map-marks"]');
  private readonly dots = new Map<string, Dot>();
  private readonly pingEls: HTMLElement[] = [];
  private zonesKey = '';
  /** The frame's side in CSS pixels, measured when the map opens or the window resizes. */
  private side = 0;

  constructor() {
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

  /** Counts for the test hook. */
  info(): { open: boolean; players: number; pings: number } {
    let players = 0;
    for (const dot of this.dots.values()) if (!dot.root.hidden) players++;
    const pings = this.pingEls.filter((el) => !el.hidden).length;
    return {
      open: this.isOpen,
      players: this.isOpen ? players : 0,
      pings: this.isOpen ? pings : 0,
    };
  }

  /** Redraws the marks; call each frame while the map is open. */
  update(view: MapView): void {
    if (!this.isOpen) return;
    this.drawZones(view.seed, view.size);
    const seen = new Set<string>();
    this.dot(view.self, true, view.size);
    seen.add(view.self.id);
    for (const player of view.players) {
      if (seen.has(player.id)) continue;
      seen.add(player.id);
      this.dot(player, false, view.size);
    }
    for (const [id, dot] of this.dots) {
      if (seen.has(id)) continue;
      dot.root.remove();
      this.dots.delete(id);
    }
    view.pings.forEach((ping, i) => {
      let el = this.pingEls[i];
      if (!el) {
        el = document.createElement('span');
        el.className = 'map-ping';
        el.dataset.testid = 'map-ping';
        this.marks.append(el);
        this.pingEls[i] = el;
      }
      const kind = PINGS[ping.kind];
      showIcon(el, kind?.name ?? null);
      el.dataset.kind = String(ping.kind);
      el.setAttribute('aria-label', `${kind?.name ?? ''} ping`);
      el.style.transform = this.place(ping.x, ping.y, view.size);
      el.hidden = false;
    });
    for (let i = view.pings.length; i < this.pingEls.length; i++) {
      (this.pingEls[i] as HTMLElement).hidden = true;
    }
  }

  private dot(player: MapPlayer, self: boolean, size: number): void {
    let dot = this.dots.get(player.id);
    if (!dot) {
      const root = document.createElement('span');
      root.className = 'map-dot';
      root.dataset.testid = 'map-dot';
      root.dataset.id = player.id;
      const svg = document.createElementNS(SVG_NS, 'svg');
      svg.setAttribute('viewBox', '-10 -10 20 20');
      svg.setAttribute('aria-hidden', 'true');
      const label = document.createElement('span');
      label.className = 'map-label';
      root.append(svg, label);
      this.marks.append(root);
      dot = { root, svg, label, mark: '' };
      this.dots.set(player.id, dot);
    }
    const mark = self ? 'self' : player.ready ? 'ready' : 'other';
    if (dot.mark !== mark) {
      dot.mark = mark;
      dot.svg.innerHTML = MARKS[mark];
    }
    dot.root.dataset.self = String(self);
    dot.root.dataset.ready = String(player.ready);
    // Names come from other players: text only.
    const who = self ? 'You' : player.name;
    setText(dot.label, player.ready ? `${who} · ready` : who);
    dot.root.style.transform = this.place(player.x, player.y, size);
  }

  /** A transform that centres a mark on a world position, on whole pixels. */
  private place(x: number, y: number, size: number): string {
    const { u, v } = mapSpot(x, y, size);
    return `translate(${Math.round(u * this.side)}px, ${Math.round(v * this.side)}px)`;
  }

  private measure(): void {
    this.side = this.frame.clientWidth;
  }

  private drawZones(seed: Seed, size: number): void {
    const key = `${seed.join('.')}/${size}`;
    if (key === this.zonesKey) return;
    this.zonesKey = key;
    const n = ZONE_TEXTURE_SIZE;
    this.canvas.width = n;
    this.canvas.height = n;
    const context = this.canvas.getContext('2d');
    if (!context) return;
    const pixels = zonePixels(depthGrid(seed, size, n), n);
    context.putImageData(new ImageData(pixels, n, n), 0, 0);
  }
}
