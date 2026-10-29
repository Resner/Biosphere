import { describe, expect, it } from 'vitest';
import { ICON_GRID, ICON_NAMES, ICON_STROKE, ICONS, iconMarkup } from './icons';
import { EMOTES, PINGS } from './social-ui';

/** Every number in a piece of SVG markup's attributes, path data included. */
function numbersIn(markup: string): number[] {
  const values: number[] = [];
  for (const [, value] of markup.matchAll(/\s(?:d|cx|cy|r|x1|x2|y1|y2|points)="([^"]*)"/g)) {
    for (const n of (value as string).match(/-?\d*\.?\d+(?:e-?\d+)?/g) ?? [])
      values.push(Number(n));
  }
  return values;
}

describe('icons (M6 T25)', () => {
  it('draws the 10 pings and emotes, by the names the social layer uses', () => {
    expect(ICON_NAMES).toHaveLength(10);
    expect([...PINGS, ...EMOTES].map((item) => item.name).sort()).toEqual([...ICON_NAMES].sort());
  });

  it('gives every icon a title for screen readers', () => {
    for (const name of ICON_NAMES) {
      const title = ICONS[name].title;
      expect(title.trim()).not.toBe('');
      expect(iconMarkup(name)).toContain(`<title>${title}</title>`);
    }
  });

  it('draws every icon on one 24 px grid with one line weight, as line art', () => {
    for (const name of ICON_NAMES) {
      const markup = iconMarkup(name);
      expect(markup).toContain(`viewBox="0 0 ${ICON_GRID} ${ICON_GRID}"`);
      expect(markup).toContain(`stroke-width="${ICON_STROKE}"`);
      // Line art: nothing filled, no text glyphs, no images and no per-shape weights.
      expect(markup).toContain('fill="none"');
      expect(ICONS[name].body).not.toMatch(/<text|<image|<use|stroke-width|fill=|style=/);
      // Every shape stays inside the grid with room for half a line at the edge.
      for (const n of numbersIn(ICONS[name].body)) {
        expect(Math.abs(n), `${name}: ${n}`).toBeLessThanOrEqual(ICON_GRID - ICON_STROKE / 2);
      }
    }
  });

  it('draws each icon differently', () => {
    const bodies = new Set(ICON_NAMES.map((name) => ICONS[name].body));
    expect(bodies.size).toBe(ICON_NAMES.length);
  });

  it('keeps the old text glyphs out of the social layer', () => {
    for (const item of [...PINGS, ...EMOTES]) expect(item).not.toHaveProperty('glyph');
  });
});
