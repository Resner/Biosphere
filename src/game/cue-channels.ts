// Colour never alone (M14 T9, DESIGN §10): every cue that carries meaning on screen, with the
// colours it draws with (each the literal as its source file writes it, which a test finds there)
// and the other channels that carry the same meaning. `CONFUSABLE` names the pairs that must stay
// apart: under protanopia, deuteranopia and tritanopia their colours keep a CIEDE2000 distance of at
// least `MIN_DISTANCE`, or the pair differs in a channel that isn't colour and says which.
// Read by tests only; the cues themselves live where they are drawn.

import { lerp } from '../sim/math';
import type { Rgb } from './colour-vision';
import { EDGE_LIGHTEN, MAP_COLOURS } from './map-relief';

/** The ways a cue says what it means. Colour is never the only one. */
export type Channel = 'shape' | 'pattern' | 'icon' | 'text' | 'position' | 'motion' | 'sound';

/** The channels that still show with motion reduced and the sound off: every cue needs one. */
export const STILL: readonly Channel[] = ['shape', 'pattern', 'icon', 'text', 'position'];

/** The least CIEDE2000 distance a confusable pair keeps under each deficiency. */
export const MIN_DISTANCE = 12;

/** One colour a cue draws with, as sRGB 0..1, and where it is written. */
export interface Paint {
  rgb: Rgb;
  /** The repository path of the file that holds it. */
  file: string;
  /** The literal as that file writes it, or the expression that works it out there. */
  text: string;
}

export interface Cue {
  id: string;
  /** What it tells the player. */
  means: string;
  colours: readonly Paint[];
  /** Each channel beside colour and how it carries the meaning. */
  channels: Partial<Record<Channel, string>>;
}

/** The water every translucent colour is seen over. */
const WATER: Rgb = [4 / 255, 9 / 255, 11 / 255];

/** Parses a colour literal: `#rrggbb`, `rgb(r g b / a)`, `vec3(r, g, b)` or `[r, g, b]` (0..1). */
export function parseColour(text: string): Rgb {
  const hex = /#([0-9a-f]{6})\b/i.exec(text);
  if (hex) {
    const n = Number.parseInt(hex[1] as string, 16);
    return [(n >> 16) / 255, ((n >> 8) & 0xff) / 255, (n & 0xff) / 255];
  }
  const rgb = /rgb\(\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)\s*(?:\/\s*([\d.]+))?\s*\)/.exec(text);
  if (rgb) {
    const alpha = rgb[4] === undefined ? 1 : Number(rgb[4]);
    // CSS blends translucent colours in sRGB, over the water here.
    return [1, 2, 3].map((i) =>
      lerp(WATER[i - 1] as number, Number(rgb[i]) / 255, alpha),
    ) as unknown as Rgb;
  }
  const triple = /(?:vec3\(|\[)\s*([\d.]+),\s*([\d.]+),\s*([\d.]+)\s*[)\]]/.exec(text);
  if (triple) return [Number(triple[1]), Number(triple[2]), Number(triple[3])];
  throw new Error(`not a colour: ${text}`);
}

const paint = (file: string, text: string): Paint => ({ rgb: parseColour(text), file, text });

const BASE = 'src/styles/base.css';
const OVERLAYS = 'src/styles/overlays.css';
const PANELS = 'src/styles/panels.css';
const SHADERS = 'src/render/shaders';

// The colours more than one cue draws with.
const TEXT = paint(BASE, '--text: #e3f4f0');
const MUTED = paint(BASE, '--muted: #7fa39c');
const STAT_ICON = paint(BASE, 'color: rgb(227 244 240 / 0.7)');
const HEALTH = paint(BASE, 'background: #e8b04a');
const GROWTH = paint(BASE, 'background: #8de88a');
const LIFE = paint(BASE, 'background: #9cc7bf');
const LOW = paint(BASE, 'color: #f0c870');
const HURT = paint(BASE, 'color: #ff9a8a');
const PINGS = [
  paint('src/game/minimap.ts', "colour: '#c8f2ff'"),
  paint('src/game/minimap.ts', "colour: '#f0b44a'"),
  paint('src/game/minimap.ts', "colour: '#8de88a'"),
  paint('src/game/minimap.ts', "colour: '#ff8fc8'"),
] as const;
const PING_NAMES = ['look', 'danger', 'food', 'mate'] as const;
/** Rarity's colours: common takes the muted text, the others `--tier`. */
const TIERS = [
  MUTED,
  paint(PANELS, '--tier: #8de88a'),
  paint(PANELS, '--tier: #7ac8ff'),
  paint(PANELS, '--tier: #ffd27a'),
] as const;
const TIER_NAMES = ['common', 'uncommon', 'rare', 'exotic'] as const;
const ZONE_NAMES = ['shallows', 'twilight', 'deep', 'abyss'] as const;
/** The depth gauge's bands: the map's colours lifted toward white (`gaugeBands`). */
const GAUGE = ZONE_NAMES.map(
  (zone): Paint => ({
    rgb: MAP_COLOURS[zone].map((c) => lerp(c, 1, EDGE_LIGHTEN)) as unknown as Rgb,
    file: 'src/game/depth-gauge.ts',
    text: 'lerp(c, 1, EDGE_LIGHTEN)',
  }),
);

export const CUES: readonly Cue[] = [
  {
    id: 'bar-health',
    means: 'how much damage the creature can still take',
    colours: [HEALTH],
    channels: { icon: 'a cross at the bar’s left', position: 'the first of the bars' },
  },
  {
    id: 'bar-energy',
    means: 'how much it can still spend before it starves',
    colours: [TEXT],
    channels: { icon: 'a bolt at the bar’s left', position: 'the second bar' },
  },
  {
    id: 'bar-size',
    means: 'how far it has grown toward its adult size',
    colours: [GROWTH],
    channels: {
      icon: 'four arrows pointing out, at the bar’s left',
      pattern: 'a tick at the maturity size',
      position: 'the third bar',
    },
  },
  {
    id: 'bar-life',
    means: 'how much of its lifespan is left',
    colours: [LIFE, paint(BASE, '#9aa5a3 0 4px')],
    channels: {
      icon: 'an hourglass at the bar’s left',
      pattern: 'dashed once old',
      position: 'the last bar',
    },
  },
  {
    id: 'low-energy',
    means: 'energy under 20%: eat or starve',
    colours: [LOW],
    channels: {
      shape: 'the bolt goes hollow',
      motion: 'the bar pulses',
      sound: 'the low-energy cue',
      text: 'the guide’s “Hungry” line, once',
    },
  },
  {
    id: 'damage-hit',
    means: 'a hit landed on the player',
    colours: [HURT, paint(`${SHADERS}/creature.frag.glsl`, 'vec3(1.0, 0.07, 0.04)')],
    channels: {
      shape: 'a crack across the health cross',
      motion: 'the body jolts, the camera kicks and the health bar flashes',
      sound: 'a thud',
    },
  },
  {
    id: 'outline-bigger',
    means: 'a creature a tier bigger: keep away',
    colours: [paint(`${SHADERS}/outline.frag.glsl`, 'vec3(1.0, 0.62, 0.42)')],
    channels: { shape: 'a broken ring of 8 dashes', motion: 'it swells with a pulse' },
  },
  {
    id: 'outline-smaller',
    means: 'a creature a tier smaller',
    colours: [paint(`${SHADERS}/outline.frag.glsl`, 'vec3(0.78, 0.93, 1.0)')],
    channels: { pattern: 'a still ring of 16 dots' },
  },
  {
    id: 'attack-glyph',
    means: 'the creature F would attack',
    colours: [paint(OVERLAYS, 'color: #ffe2c4')],
    channels: { text: 'the letter F in a key cap', position: 'beside that creature' },
  },
  {
    id: 'target-ring',
    means: 'the fighter the player’s strikes aim at',
    colours: [paint(`${SHADERS}/telegraph.frag.glsl`, 'vec3(0.85, 0.95, 1.0)')],
    channels: { shape: 'a thin ring with four brackets on the diagonals' },
  },
  {
    id: 'windup',
    means: 'a strike is coming',
    colours: [
      paint(`${SHADERS}/telegraph.frag.glsl`, 'vec3(1.0, 0.7, 0.34)'),
      paint(`${SHADERS}/telegraph.frag.glsl`, 'vec3(1.0, 0.4, 0.16)'),
    ],
    channels: {
      shape: 'a bloom that grows on the weapon as the strike nears',
      position: 'on the attacker’s front and weapon tips',
      sound: 'a tick when it is aimed at the player',
    },
  },
  {
    id: 'block',
    means: 'a strike was blocked',
    colours: [paint(`${SHADERS}/telegraph.frag.glsl`, 'vec3(0.78, 0.93, 1.0)')],
    channels: {
      shape: 'a spark of eight rays and a ring',
      motion: 'the staggered attacker wobbles',
      sound: 'a clink',
    },
  },
  {
    id: 'fighting-ring',
    means: 'a creature fighting in another fight',
    colours: [paint(`${SHADERS}/telegraph.frag.glsl`, 'vec3(1.0, 0.6, 0.45)')],
    channels: { shape: 'a broken ring of six dashes' },
  },
  {
    id: 'mate-ready',
    means: 'mature, rested and free to mate',
    colours: [
      paint(BASE, 'color: #ff9db3'),
      paint(OVERLAYS, 'fill: #ff9cc0'),
      paint('src/game/minimap.ts', "HEART = '#ff8fc8'"),
    ],
    channels: {
      icon: 'a heart: the chip, beside an edge arrow, on the minimap and the map',
      text: '“Ready to mate” on the chip and in the menu',
    },
  },
  {
    id: 'pings',
    means: 'look, danger, food or mate, from another player',
    colours: PINGS,
    channels: {
      icon: 'an eye, a warning sign, globules or a double strand',
      pattern: 'a solid, dashed, dotted or double ring (on the minimap, its own dash)',
    },
  },
  {
    id: 'emotes',
    means: 'what another player feels',
    colours: [TEXT],
    channels: { icon: 'a hand, a heart, a bubble or a face, each its own outline' },
  },
  {
    id: 'egg-tier',
    means: 'how rare the child in the egg is',
    colours: [
      paint('src/render/egg.ts', 'common: [0.8, 0.9, 0.95]'),
      paint('src/render/egg.ts', 'uncommon: [0.55, 0.91, 0.54]'),
      paint('src/render/egg.ts', 'rare: [0.48, 0.78, 1]'),
      paint('src/render/egg.ts', 'exotic: [1, 0.82, 0.48]'),
    ],
    channels: {
      text: 'the result card names the tier when the egg cracks',
      shape: 'its stars, one to four',
    },
  },
  {
    id: 'result-stars',
    means: 'how rare the new creature is',
    colours: TIERS,
    channels: { shape: 'filled stars out of four', text: 'the tier in words' },
  },
  {
    id: 'rarity-badge',
    means: 'a creature’s rarity on the inspect card, the invitation and the creature’s card',
    colours: TIERS,
    channels: { text: 'the tier’s word' },
  },
  {
    id: 'depth-gauge',
    means: 'which zone the player is in, by depth',
    colours: GAUGE,
    channels: {
      position: 'the zones as bands from the surface down, the marker at the player’s depth',
      text: 'the depth in metres beside the marker',
    },
  },
  {
    id: 'minimap-zones',
    means: 'where each zone lies around the player',
    colours: ZONE_NAMES.map((z) =>
      paint('src/game/map-relief.ts', `${z}: [${MAP_COLOURS[z].join(', ')}]`),
    ),
    channels: {
      pattern: 'a light line along each zone’s edge',
      text: 'the zone’s name under the minimap',
    },
  },
  {
    id: 'minimap-players',
    means: 'other players around, by size and readiness',
    colours: [paint('src/game/minimap.ts', "HEART = '#ff8fc8'"), TEXT],
    channels: { shape: 'a heart when ready, else a mark for its size against the player’s' },
  },
  {
    id: 'hazard',
    means: 'UV, pressure or a toxic plume is hurting the player',
    colours: [
      paint(BASE, '--hazard: #d9c8ff'),
      paint(BASE, '--hazard: #9fc0ff'),
      paint(`${SHADERS}/plume.frag.glsl`, 'vec3(1.0, 0.55, 0.85)'),
    ],
    channels: {
      icon: 'a sun for UV, a squeeze for pressure, beside the depth gauge',
      pattern: 'a plume’s dashed rim',
      text: 'the guide’s hazard line, once',
    },
  },
  {
    id: 'witness-mark',
    means: 'a witness referees this fight, or this page referees one',
    colours: [paint(OVERLAYS, 'color: rgb(190 227 242 / 0.85)'), paint(BASE, 'color: #bfe3f2')],
    channels: { icon: 'an eye', text: '“Witnessing a fight” on the chip' },
  },
  {
    id: 'away-fighter',
    means: 'a fighter whose player left during the fight',
    colours: [TEXT],
    channels: { text: '“away” after its name' },
  },
  {
    id: 'queue-card',
    means: 'the world is full: the player waits in line',
    colours: [TEXT, MUTED],
    channels: { text: 'the reason, the place in line and the wait' },
  },
  {
    id: 'status-chip',
    means: 'how the page is connected',
    colours: [TEXT],
    channels: { text: 'the status in words' },
  },
  {
    id: 'offline-chip',
    means: 'the page is offline',
    colours: [MUTED],
    channels: { icon: 'a struck-through circle', text: 'its name and tooltip' },
  },
  {
    id: 'guide',
    means: 'the first-life guide’s next lesson',
    colours: [TEXT],
    channels: { text: 'one line of words' },
  },
];

/** Two colours that mean different things where they meet, and what keeps them apart besides. */
export interface Confusable {
  what: string;
  a: Paint;
  b: Paint;
  /** The channel that tells them apart when the colours alone don't, and how. */
  apart?: { channel: Channel; how: string };
}

const pairs = <T>(xs: readonly T[]): [T, T, number, number][] =>
  xs.flatMap((a, i) => xs.slice(i + 1).map((b, k): [T, T, number, number] => [a, b, i, i + 1 + k]));

const BARS = [
  { name: 'health', paint: HEALTH, icon: 'a cross' },
  { name: 'energy', paint: TEXT, icon: 'a bolt' },
  { name: 'size', paint: GROWTH, icon: 'outward arrows' },
  { name: 'life', paint: LIFE, icon: 'an hourglass' },
] as const;

export const CONFUSABLE: readonly Confusable[] = [
  ...pairs(BARS).map(
    ([a, b]): Confusable => ({
      what: `the ${a.name} and ${b.name} bars`,
      a: a.paint,
      b: b.paint,
      apart: { channel: 'icon', how: `${a.icon} against ${b.icon}, and their places` },
    }),
  ),
  {
    what: 'low against normal energy',
    a: LOW,
    b: STAT_ICON,
    apart: { channel: 'shape', how: 'the bolt goes hollow' },
  },
  {
    what: 'health against a damage hit',
    a: HEALTH,
    b: HURT,
    apart: { channel: 'shape', how: 'a crack across the health cross' },
  },
  ...pairs(PINGS).map(
    ([a, b, i, k]): Confusable => ({
      what: `the ${PING_NAMES[i]} and ${PING_NAMES[k]} pings`,
      a,
      b,
      apart: { channel: 'pattern', how: 'each kind’s own ring and icon' },
    }),
  ),
  ...pairs(TIERS).map(
    ([a, b, i, k]): Confusable => ({
      what: `the ${TIER_NAMES[i]} and ${TIER_NAMES[k]} tiers`,
      a,
      b,
      apart: { channel: 'text', how: 'the tier’s word and its stars' },
    }),
  ),
  ...pairs(GAUGE).map(
    ([a, b, i, k]): Confusable => ({
      what: `the ${ZONE_NAMES[i]} and ${ZONE_NAMES[k]} bands of the depth gauge`,
      a,
      b,
      apart: { channel: 'position', how: 'the bands lie in depth order, the depth beside them' },
    }),
  ),
];
