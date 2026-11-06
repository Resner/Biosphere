import { describe, expect, it } from 'vitest';
import {
  type Block,
  IMAGE_HEIGHT,
  IMAGE_WIDTH,
  type ImageText,
  imageFileName,
  imageLayout,
  type Measure,
  shareUrl,
  TEXT_LEFT,
  TEXT_RIGHT,
  URL_LEFT,
} from './card-image';

const id = 'ab'.repeat(32);
/** A wide, plain measure: every character 0.62 em, so a layout that fits here fits a real font. */
const measure: Measure = (text, font) => {
  const size = Number(/(\d+)px/.exec(font)?.[1] ?? 16);
  return text.length * size * 0.62;
};

const text = (over: Partial<ImageText> = {}): ImageText => ({
  species: 'Dabelothrix natans',
  stars: '★★☆☆',
  rarity: 'Uncommon',
  generation: 'Generation 3',
  verdict: 'verified',
  verdictText: 'Verified back to genesis',
  url: shareUrl(`https://resner.github.io/Biosphere/card.html?c=${id}&hub=x&quality=high`),
  ...over,
});

/** Every line of a block between `left` and `right`, and inside the image. */
function inside(block: Block, left: number, right: number): void {
  for (const line of block.lines) {
    expect(line.x).toBeGreaterThanOrEqual(left);
    expect(line.x + measure(line.text, block.font)).toBeLessThanOrEqual(right + 0.5);
    expect(line.y).toBeLessThanOrEqual(IMAGE_HEIGHT);
  }
}

const top = (b: Block): number => (b.lines[0]?.y ?? 0) - b.size;
const bottom = (b: Block): number => b.lines[b.lines.length - 1]?.y ?? 0;

function wellLaidOut(t: ImageText): ReturnType<typeof imageLayout> {
  const layout = imageLayout(t, measure);
  const blocks = [layout.kicker, layout.species, layout.meta, layout.verdict, layout.url];
  // The words in the column beside the creature; the URL across the foot of the image.
  for (const b of blocks.slice(0, -1)) inside(b, TEXT_LEFT, TEXT_RIGHT);
  inside(layout.url, URL_LEFT, IMAGE_WIDTH - URL_LEFT);
  // Top to bottom, never overlapping.
  for (let i = 1; i < blocks.length; i++)
    expect(top(blocks[i] as Block)).toBeGreaterThan(bottom(blocks[i - 1] as Block));
  return layout;
}

describe('the card image', () => {
  it('is 1200 × 630', () => {
    expect([IMAGE_WIDTH, IMAGE_HEIGHT]).toEqual([1200, 630]);
  });

  it('sets a short species name large, on one line', () => {
    const layout = wellLaidOut(text());
    expect(layout.species.lines.map((l) => l.text)).toEqual(['Dabelothrix natans']);
    expect(layout.species.size).toBeGreaterThanOrEqual(44);
    expect(layout.meta.lines[0]?.text).toBe('★★☆☆ Uncommon · Generation 3');
  });

  it('fits a long species name: smaller, on two lines, all of it kept', () => {
    const species = 'Kavelothrixomorphidella quadrilobatoserratiformis';
    const layout = wellLaidOut(text({ species }));
    expect(layout.species.lines.length).toBe(2);
    expect(layout.species.lines.map((l) => l.text).join(' ')).toBe(species);
    expect(layout.species.size).toBeLessThan(44);
  });

  it('shortens a species name too long for any size, and still fits', () => {
    const species = `${'Kavelothrixomorphidella'.repeat(3)} ${'quadrilobatoserratiformis'.repeat(3)}`;
    const layout = wellLaidOut(text({ species }));
    expect(layout.species.lines.length).toBeLessThanOrEqual(2);
    expect(layout.species.lines[layout.species.lines.length - 1]?.text.endsWith('…')).toBe(true);
  });

  it('prints a failed verdict, wrapped within the column', () => {
    const verdictText =
      'Not verified: A record has been changed since it was written, so nothing after it can be trusted.';
    const layout = wellLaidOut(text({ verdict: 'failed', verdictText }));
    expect(layout.verdict.mark).toBe('✗');
    expect(layout.verdict.lines.length).toBeGreaterThan(1);
    expect(layout.verdict.lines.map((l) => l.text).join(' ')).toBe(verdictText);
  });

  it('marks a verified verdict with a tick, a shape and not only a colour', () => {
    expect(imageLayout(text(), measure).verdict.mark).toBe('✓');
  });

  it('prints the card URL without the local hub or the preset', () => {
    const layout = wellLaidOut(text());
    expect(layout.url.lines[0]?.text).toBe(`resner.github.io/Biosphere/card.html?c=${id}`);
  });

  it('keeps the URL whole beside a long name and a long verdict', () => {
    const layout = wellLaidOut(
      text({
        species: 'Kavelothrixomorphidella quadrilobatoserratiformis',
        verdict: 'failed',
        verdictText: `Not verified: ${'a long problem line '.repeat(8)}`,
      }),
    );
    expect(layout.url.lines[0]?.text).toContain(id);
  });

  it('names the file after the species', () => {
    expect(imageFileName('Dabelothrix natans')).toBe('dabelothrix-natans-biosphere.png');
    expect(imageFileName('')).toBe('creature-biosphere.png');
  });
});
