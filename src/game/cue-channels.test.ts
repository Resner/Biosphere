import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { DEFICIENCIES, distance } from './colour-vision';
import {
  type Channel,
  CONFUSABLE,
  CUES,
  MIN_DISTANCE,
  type Paint,
  parseColour,
  STILL,
} from './cue-channels';

const read = (file: string) =>
  readFileSync(fileURLToPath(new URL(`../../${file}`, import.meta.url)), 'utf8');

/** The least distance between a pair's colours under the three deficiencies. */
const least = (a: Paint, b: Paint) =>
  Math.min(...DEFICIENCIES.map((d) => distance(a.rgb, b.rgb, d)));

describe('the cue inventory', () => {
  it('names the cues the spec lists, each once', () => {
    const ids = CUES.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of [
      'bar-health',
      'bar-energy',
      'bar-size',
      'bar-life',
      'low-energy',
      'damage-hit',
      'outline-bigger',
      'outline-smaller',
      'attack-glyph',
      'target-ring',
      'windup',
      'block',
      'mate-ready',
      'pings',
      'emotes',
      'egg-tier',
      'result-stars',
      'rarity-badge',
      'depth-gauge',
      'minimap-zones',
      'minimap-players',
      'hazard',
      'witness-mark',
      'away-fighter',
      'queue-card',
      'status-chip',
      'guide',
    ])
      expect(ids).toContain(id);
  });

  it.each(CUES.map((c) => [c.id, c] as const))(
    '%s carries its meaning in a channel that isn’t colour and still shows with motion and sound off',
    (_, cue) => {
      const still = (Object.keys(cue.channels) as Channel[]).filter((ch) => STILL.includes(ch));
      expect(still.length).toBeGreaterThan(0);
      for (const how of Object.values(cue.channels)) expect(how.length).toBeGreaterThan(0);
    },
  );

  it('takes every colour from the code that draws it', () => {
    for (const cue of CUES) {
      expect(cue.colours.length, cue.id).toBeGreaterThan(0);
      for (const p of cue.colours) {
        expect(read(p.file), `${cue.id} in ${p.file}`).toContain(p.text);
        for (const c of p.rgb) {
          expect(c).toBeGreaterThanOrEqual(0);
          expect(c).toBeLessThanOrEqual(1);
        }
      }
    }
  });

  it('reads each way the code writes a colour', () => {
    expect(parseColour('background: #e8b04a;')).toEqual([0xe8 / 255, 0xb0 / 255, 0x4a / 255]);
    expect(parseColour('vec3(1.0, 0.62, 0.42)')).toEqual([1, 0.62, 0.42]);
    expect(parseColour('rare: [0.48, 0.78, 1]')).toEqual([0.48, 0.78, 1]);
    // A translucent colour is taken over the water (#04090b).
    const [r] = parseColour('rgb(255 255 255 / 0.5)');
    expect(r).toBeCloseTo((4 / 255 + 1) / 2, 6);
    expect(() => parseColour('var(--text)')).toThrow();
  });
});

describe('pairs that must stay apart', () => {
  it.each(CONFUSABLE.map((c) => [c.what, c] as const))('%s', (_, pair) => {
    if (least(pair.a, pair.b) >= MIN_DISTANCE) return;
    // Too close under some deficiency: another channel that still shows tells them apart, carried
    // by a cue drawn with one of these colours (a damage hit cracks the cross; health keeps it).
    const apart = pair.apart;
    expect(apart, 'a channel beside colour').toBeDefined();
    if (!apart) return;
    expect(STILL).toContain(apart.channel);
    const holds = (p: Paint) =>
      CUES.some((c) => c.colours.includes(p) && c.channels[apart.channel] !== undefined);
    expect(holds(pair.a) || holds(pair.b), apart.channel).toBe(true);
  });

  it('says which pairs colour alone does not keep apart', () => {
    // Every other pair keeps at least 12 under protanopia, deuteranopia and tritanopia.
    const leaning = CONFUSABLE.filter((c) => least(c.a, c.b) < MIN_DISTANCE).map((c) => [
      c.what,
      c.apart?.channel,
    ]);
    expect(leaning).toEqual([
      ['the health and size bars', 'icon'],
      ['the energy and life bars', 'icon'],
      ['the size and life bars', 'icon'],
      ['health against a damage hit', 'shape'],
      ['the look and food pings', 'pattern'],
      ['the look and mate pings', 'pattern'],
      ['the danger and food pings', 'pattern'],
      ['the danger and mate pings', 'pattern'],
      ['the uncommon and rare tiers', 'text'],
      ['the uncommon and exotic tiers', 'text'],
      ['the twilight and deep bands of the depth gauge', 'position'],
      ['the deep and abyss bands of the depth gauge', 'position'],
    ]);
  });

  it('covers the bars, low energy, damage, every ping kind, rarity tier and gauge band', () => {
    const whats = CONFUSABLE.map((c) => c.what);
    expect(whats.filter((w) => w.endsWith('bars'))).toHaveLength(6);
    expect(whats.filter((w) => w.endsWith('pings'))).toHaveLength(6);
    expect(whats.filter((w) => w.endsWith('tiers'))).toHaveLength(6);
    expect(whats.filter((w) => w.endsWith('depth gauge'))).toHaveLength(6);
    expect(whats).toContain('low against normal energy');
    expect(whats).toContain('health against a damage hit');
  });
});
