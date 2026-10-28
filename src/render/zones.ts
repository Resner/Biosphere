// Depth zones on screen (M6 T16): the water takes its colour, brightness and fog from the
// bathymetry under each pixel, luminescent creatures light the dark water around them, and in the
// deep and the abyss the player sees clearly only within its detection ring. Presentation reads
// the sim's `depthAt` and never writes back.

import * as THREE from 'three';
import { depthAt, type Zone, zoneAt } from '../sim/bathymetry';
import type { Seed } from '../sim/prng';
import { RULES } from '../sim/rules';

type Rgb = readonly [number, number, number];

export const ZONES: readonly Zone[] = ['shallows', 'twilight', 'deep', 'abyss'];

export interface ZoneLook {
  /** The water's colour in its troughs and in its lighter haze (the slow body noise mixes them). */
  water: Rgb;
  haze: Rgb;
  /** How much the water and food beyond the sight ring dim: the zone's fog, 0..1. */
  dark: number;
  /** How strongly a creature's glow lights the water around it. */
  glow: number;
  /** The caustics' strength (T17 refines them). */
  caustic: number;
  /** The marine snow's brightness. */
  snow: number;
}

/**
 * The look of each zone: bright cyan-green shallows, blue twilight (exactly the dark teal-blue water
 * of reference-01 that the spawn had before zones), blue-black deep and a near-black abyss where
 * glow dominates.
 */
export const ZONE_LOOK: Readonly<Record<Zone, ZoneLook>> = {
  shallows: {
    water: [0.03, 0.1, 0.085],
    haze: [0.1, 0.27, 0.215],
    dark: 0,
    glow: 0.2,
    caustic: 1.4,
    snow: 1,
  },
  twilight: {
    water: [0.01, 0.026, 0.034],
    haze: [0.04, 0.1, 0.11],
    dark: 0,
    glow: 0.5,
    caustic: 1,
    snow: 1,
  },
  deep: {
    water: [0.003, 0.008, 0.02],
    haze: [0.01, 0.026, 0.056],
    dark: 0.5,
    glow: 1,
    caustic: 0.1,
    snow: 0.6,
  },
  abyss: {
    water: [0.001, 0.002, 0.004],
    haze: [0.003, 0.005, 0.011],
    dark: 0.75,
    glow: 1.2,
    caustic: 0,
    snow: 0.35,
  },
};

/**
 * Zones blend over this much depth either side of each edge (about 30 wu each way). Narrow enough
 * that the spawn's twilight disc (depth 0.26 to 0.54) keeps the pure twilight look.
 */
export const ZONE_BAND = 0.01;
/** Full sight within the ring, fading to the zone's fog by this many ring radii. */
export const SIGHT_FADE = 2;
/** The least sight radius in core radii, so even a blind cell sees around itself. */
export const SIGHT_MIN_RADII = 2.5;
/** A glow lights a pool this many core radii wide. */
export const LIGHT_RADII = 6;
/** Glows drawn at once: the player's first, then the luminous remotes in pond order. */
export const MAX_LIGHTS = 8;
/** The glow's colour added to the water at the pool's centre (before the zone's `glow`). */
export const LIGHT_WATER = 0.3;
/** Water depth the shaders assume with no pond loaded (the Lab): mid-twilight. */
const NEUTRAL_DEPTH = 0.4;
/** Texels per side of the depth map. */
export const ZONE_TEXTURE_SIZE = 256;

const smoothstep = (a: number, b: number, x: number): number => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/** Each zone's share of the look at this depth: 1 inside a zone, blended over the edge bands. */
export function zoneWeights(depth: number): [number, number, number, number] {
  const e = RULES.bathymetry.zones;
  const t = [e.shallows, e.twilight, e.deep].map((edge) =>
    smoothstep(edge - ZONE_BAND, edge + ZONE_BAND, depth),
  ) as [number, number, number];
  return [1 - t[0], t[0] - t[1], t[1] - t[2], t[2]];
}

/**
 * One of the zone look's scalars at a depth, blended over the edge bands as the shaders blend
 * them (`zoneWeights`), without allocating: the scene asks it every frame.
 */
export function zoneBlend(depth: number, key: 'dark' | 'glow' | 'caustic' | 'snow'): number {
  const e = RULES.bathymetry.zones;
  const t0 = smoothstep(e.shallows - ZONE_BAND, e.shallows + ZONE_BAND, depth);
  const t1 = smoothstep(e.twilight - ZONE_BAND, e.twilight + ZONE_BAND, depth);
  const t2 = smoothstep(e.deep - ZONE_BAND, e.deep + ZONE_BAND, depth);
  const L = ZONE_LOOK;
  return (
    L.shallows[key] * (1 - t0) +
    L.twilight[key] * (t0 - t1) +
    L.deep[key] * (t1 - t2) +
    L.abyss[key] * t2
  );
}

/**
 * How clearly the player sees a point (the shaders' `zoneSight`, for a whole body at once): 1
 * within the sight ring or where glow (`lit`, 0..1) lights it, falling to 1 − the zone's fog by
 * `SIGHT_FADE` rings away.
 */
export function sightAt(depth: number, distance: number, ring: number, lit: number): number {
  const dark = zoneBlend(depth, 'dark');
  if (dark <= 0) return 1;
  const beyond = smoothstep(ring, ring * SIGHT_FADE, distance);
  return 1 - dark * beyond * (1 - Math.min(1, Math.max(0, lit)));
}

/** The share of a glow of `reach` wu and `strength` that lights a point `distance` away (`zoneLight`). */
export function glowAt(distance: number, reach: number, strength: number): number {
  const k = 1 - smoothstep(0, reach, distance);
  return k * k * strength;
}

/** The sight radius in wu: the detection ring (`stats.sense` core radii), at least the minimum. */
export const sightRadius = (sense: number, radius: number): number =>
  Math.max(sense, SIGHT_MIN_RADII) * radius;

export interface Light {
  /** World units. */
  radius: number;
  strength: number;
  color: Rgb;
}

/** A creature's glow, from its material's luminescence; null when it has none. */
export function lightOf(
  params: { luminescence: number; lumColor: Rgb },
  radius: number,
): Light | null {
  if (!(params.luminescence > 0)) return null;
  return { radius: LIGHT_RADII * radius, strength: params.luminescence, color: params.lumColor };
}

/** Depth at the centre of each of `n` × `n` texels over the world, a byte each (row = y). */
export function depthGrid(seed: Seed, size: number, n = ZONE_TEXTURE_SIZE): Uint8Array {
  const grid = new Uint8Array(n * n);
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const depth = depthAt(seed, ((i + 0.5) * size) / n, ((j + 0.5) * size) / n);
      grid[j * n + i] = Math.round(depth * 255);
    }
  }
  return grid;
}

/** How far inside a zone's depth range `wellInside` asks for (the abyss and shallows' outer sides excepted). */
const INSIDE_MARGIN = 0.04;
/** `wellInside` also asks the zone of the points this far away on each axis. */
const INSIDE_REACH = 64;
/** The search steps out in rings this far apart, with points at most this far apart on each. */
const SEARCH_STEP = 32;
/** The search keeps this far from the world's walls. */
const SEARCH_INSET = 256;

/** Whether a point lies well inside a zone: clear of its depth edges, and so is its surround. */
export function wellInside(seed: Seed, x: number, y: number, zone: Zone): boolean {
  const e = RULES.bathymetry.zones;
  const edges = [0, e.shallows, e.twilight, e.deep, 1];
  const i = ZONES.indexOf(zone);
  const lo = edges[i] as number;
  const hi = edges[i + 1] as number;
  const depth = depthAt(seed, x, y);
  if (depth < (lo > 0 ? lo + INSIDE_MARGIN : 0) || depth > (hi < 1 ? hi - INSIDE_MARGIN : 1)) {
    return false;
  }
  const r = INSIDE_REACH;
  return (
    zoneAt(seed, x + r, y) === zone &&
    zoneAt(seed, x - r, y) === zone &&
    zoneAt(seed, x, y + r) === zone &&
    zoneAt(seed, x, y - r) === zone
  );
}

/**
 * The nearest point to (x, y) well inside `zone` (`wellInside`), searched in rings of
 * `SEARCH_STEP`; (x, y) itself when it already is. For `debug.setZone`: it can take a few
 * hundred thousand depth samples, so it never runs per frame.
 */
export function nearestInZone(
  seed: Seed,
  size: number,
  x: number,
  y: number,
  zone: Zone,
): { x: number; y: number } {
  if (wellInside(seed, x, y, zone)) return { x, y };
  const lo = SEARCH_INSET;
  const hi = size - SEARCH_INSET;
  for (let r = SEARCH_STEP; r < size * 1.5; r += SEARCH_STEP) {
    const n = Math.max(8, Math.ceil((2 * Math.PI * r) / SEARCH_STEP));
    for (let k = 0; k < n; k++) {
      const a = (k / n) * 2 * Math.PI;
      const px = x + r * Math.cos(a);
      const py = y + r * Math.sin(a);
      if (px < lo || px > hi || py < lo || py > hi) continue;
      if (wellInside(seed, px, py, zone)) return { x: px, y: py };
    }
  }
  return { x, y };
}

const f = (v: number): string => v.toFixed(4);
const vec3 = ([r, g, b]: Rgb): string => `vec3(${f(r)}, ${f(g)}, ${f(b)})`;
const perZone = (key: 'dark' | 'glow' | 'caustic'): string =>
  `vec4(${ZONES.map((z) => f(ZONE_LOOK[z][key])).join(', ')})`;

/**
 * The GLSL that the water, food and creature shaders share, generated from the table above so
 * the shaders and the tests read the same numbers.
 */
export function zoneGlsl(): string {
  const e = RULES.bathymetry.zones;
  return `
#define ZONE_LIGHTS ${MAX_LIGHTS}
uniform sampler2D tZoneDepth;
uniform float uZoneOn;
uniform float uZoneWorld;
uniform vec3 uViewer;
uniform vec4 uLights[ZONE_LIGHTS];
uniform vec3 uLightColors[ZONE_LIGHTS];
uniform float uLightCount;
const vec3 ZONE_EDGES = vec3(${f(e.shallows)}, ${f(e.twilight)}, ${f(e.deep)});
const float ZONE_BAND = ${f(ZONE_BAND)};
const float ZONE_NEUTRAL = ${f(NEUTRAL_DEPTH)};
const float SIGHT_FADE = ${f(SIGHT_FADE)};
const vec4 ZONE_DARK = ${perZone('dark')};
const vec4 ZONE_GLOW = ${perZone('glow')};
const vec4 ZONE_CAUSTIC = ${perZone('caustic')};
${ZONES.map((z, i) => `const vec3 ZONE_WATER_${i} = ${vec3(ZONE_LOOK[z].water)};\nconst vec3 ZONE_HAZE_${i} = ${vec3(ZONE_LOOK[z].haze)};`).join('\n')}

// Depth under a world point, from the pond's depth map; mid-twilight with no pond loaded.
float zoneDepth(vec2 w) {
  return uZoneOn > 0.5 ? texture2D(tZoneDepth, w / uZoneWorld).r : ZONE_NEUTRAL;
}

// Each zone's share at a depth: 1 inside a zone, blended across the edge bands.
vec4 zoneWeights(float d) {
  vec3 t = smoothstep(ZONE_EDGES - ZONE_BAND, ZONE_EDGES + ZONE_BAND, vec3(d));
  return vec4(1.0 - t.x, t.x - t.y, t.y - t.z, t.z);
}

vec3 zoneMix(vec4 w, vec3 a, vec3 b, vec3 c, vec3 d) {
  return a * w.x + b * w.y + c * w.z + d * w.w;
}

// The creatures' glow reaching a world point: its colour summed, and the strongest share in a.
vec4 zoneLight(vec2 w) {
  vec4 sum = vec4(0.0);
  for (int i = 0; i < ZONE_LIGHTS; i++) {
    if (float(i) >= uLightCount) break;
    vec4 l = uLights[i];
    float k = 1.0 - smoothstep(0.0, l.z, length(w - l.xy));
    k = k * k * l.w;
    sum.rgb += uLightColors[i] * k;
    sum.a = max(sum.a, k);
  }
  return sum;
}

// 1 within the viewer's sight ring or where glow lights the water, falling to 1 - the zone's fog
// (\`dark\`) beyond it. The glow is only looked up where the fog applies.
float zoneSight(vec2 w, float dark) {
  if (uZoneOn < 0.5 || dark <= 0.0) return 1.0;
  float beyond = smoothstep(uViewer.z, uViewer.z * SIGHT_FADE, length(w - uViewer.xy));
  if (beyond <= 0.0) return 1.0;
  return 1.0 - dark * beyond * (1.0 - clamp(zoneLight(w).a, 0.0, 1.0));
}
`;
}

/**
 * The uniforms every zone-aware material shares (the shader chunk's): the depth map, where the
 * viewer is and how far it sees, and the glows. `GameScene` writes them each frame; with
 * `uZoneOn` 0 (the Lab) the shaders see mid-twilight water and full sight.
 */
export const ZONE_UNIFORMS: {
  readonly tZoneDepth: THREE.IUniform<THREE.Texture | null>;
  readonly uZoneOn: THREE.IUniform<number>;
  readonly uZoneWorld: THREE.IUniform<number>;
  readonly uViewer: THREE.IUniform<THREE.Vector3>;
  readonly uLights: THREE.IUniform<THREE.Vector4[]>;
  readonly uLightColors: THREE.IUniform<THREE.Vector3[]>;
  readonly uLightCount: THREE.IUniform<number>;
} = {
  tZoneDepth: { value: null },
  uZoneOn: { value: 0 },
  uZoneWorld: { value: RULES.world.size },
  uViewer: { value: new THREE.Vector3(0, 0, 1) },
  uLights: { value: Array.from({ length: MAX_LIGHTS }, () => new THREE.Vector4()) },
  uLightColors: { value: Array.from({ length: MAX_LIGHTS }, () => new THREE.Vector3()) },
  uLightCount: { value: 0 },
};

/** The pond's depth map as a texture: built once per seed, filtered so the zones blend. */
export class ZoneMap {
  private texture: THREE.DataTexture | null = null;
  private key = '';

  /** Loads this pond's map (a no-op for the pond already loaded) and turns the zones on. */
  set(seed: Seed, size: number): void {
    const key = `${seed.join('.')}/${size}`;
    if (key !== this.key) {
      this.dispose();
      const n = ZONE_TEXTURE_SIZE;
      const texture = new THREE.DataTexture(depthGrid(seed, size, n), n, n, THREE.RedFormat);
      texture.magFilter = THREE.LinearFilter;
      texture.minFilter = THREE.LinearFilter;
      texture.wrapS = THREE.ClampToEdgeWrapping;
      texture.wrapT = THREE.ClampToEdgeWrapping;
      texture.needsUpdate = true;
      this.texture = texture;
      this.key = key;
    }
    ZONE_UNIFORMS.tZoneDepth.value = this.texture;
    ZONE_UNIFORMS.uZoneWorld.value = size;
    ZONE_UNIFORMS.uZoneOn.value = 1;
  }

  dispose(): void {
    this.texture?.dispose();
    this.texture = null;
    this.key = '';
    ZONE_UNIFORMS.tZoneDepth.value = null;
    ZONE_UNIFORMS.uZoneOn.value = 0;
    ZONE_UNIFORMS.uLightCount.value = 0;
  }
}
