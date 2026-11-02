// The depth gauge (M6c T12, DESIGN §9): a slim vertical bar left of the minimap, the four zones as
// bands from the surface (top) to the abyss floor (bottom), with a "◂" marker at the player's depth
// and the depth in metres beside it. Its strings are built once, so a frame allocates nothing.

import { clamp, lerp } from '../sim/math';
import { RULES } from '../sim/rules';
import { pick, setText } from './dom';
import { EDGE_LIGHTEN, MAP_COLOURS } from './pond-map';

export const DEPTH_GAUGE = {
  /** Metres at the abyss floor: the depth (0 the surface, 1 the floor) times this. */
  metres: 1000,
} as const;

const ZONES = ['shallows', 'twilight', 'deep', 'abyss'] as const;
const EDGES: readonly number[] = [
  0,
  RULES.bathymetry.zones.shallows,
  RULES.bathymetry.zones.twilight,
  RULES.bathymetry.zones.deep,
  1,
];
const TEXTS: readonly string[] = Array.from({ length: DEPTH_GAUGE.metres + 1 }, (_, m) => `${m} m`);
const TOPS: readonly string[] = Array.from(
  { length: DEPTH_GAUGE.metres + 1 },
  (_, m) => `${(100 * m) / DEPTH_GAUGE.metres}%`,
);

/** The depth in whole metres, 0 at the surface. */
export function depthMetres(depth: number): number {
  return Math.round(clamp(depth, 0, 1) * DEPTH_GAUGE.metres);
}

/** "12 m". */
export function metresText(metres: number): string {
  return TEXTS[metres] as string;
}

/** The marker's top within the gauge, as a CSS percentage. */
export function markerTop(metres: number): string {
  return TOPS[metres] as string;
}

/** The zones as hard bands from top to bottom: the map's colours, lifted so the darkest still reads on glass. */
export function gaugeBands(): string {
  const stops = ZONES.map((zone, i) => {
    const rgb = MAP_COLOURS[zone].map((c) => Math.round(lerp(c, 1, EDGE_LIGHTEN) * 255)).join(' ');
    const from = Math.round((EDGES[i] as number) * 1000) / 10;
    const to = Math.round((EDGES[i + 1] as number) * 1000) / 10;
    return `rgb(${rgb}) ${from}%, rgb(${rgb}) ${to}%`;
  });
  return `linear-gradient(to bottom, ${stops.join(', ')})`;
}

export class DepthGauge {
  private readonly root = pick('[data-testid="minimap-depth"]');
  private readonly marker = pick('[data-testid="minimap-depth-marker"]');
  private readonly text = pick('[data-testid="minimap-depth-text"]');
  private metres = -1;

  constructor() {
    pick('.minimap-depth-bands').style.background = gaugeBands();
  }

  /** Shows the depth (0 the surface, 1 the abyss floor), or nothing on the title's water. */
  set(depth: number | null): void {
    const hidden = depth === null;
    if (this.root.hidden !== hidden) this.root.hidden = hidden;
    if (depth === null) return;
    const metres = depthMetres(depth);
    if (metres === this.metres) return;
    this.metres = metres;
    this.marker.style.top = markerTop(metres);
    setText(this.text, metresText(metres));
  }
}
