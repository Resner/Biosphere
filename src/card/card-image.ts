// The card as an image (M9 T14): "Save image" makes a 1200 × 630 PNG, the size link previews use,
// with the creature's render on the left, its species, stars, generation and verdict line beside
// it, and the card's URL across the foot. It is drawn on a 2D canvas from one WebGL frame. The
// layout is pure, with the text measure handed in, so its fit is unit-tested; `drawCardImage`
// paints it. There is no image without a verdict, and a failed verdict is printed like any other.

export const IMAGE_WIDTH = 1200;
export const IMAGE_HEIGHT = 630;
/** The band across the foot that holds the URL. */
export const FOOT_TOP = 568;
/** The creature's render: the left of the image above the foot. */
export const ART_WIDTH = 600;
export const ART_HEIGHT = FOOT_TOP;
/** The column of words beside the creature. */
export const TEXT_LEFT = 620;
export const TEXT_RIGHT = 1164;
/** The URL's margin on either side. */
export const URL_LEFT = 40;

const SANS = 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
const MONO = 'ui-monospace, "SF Mono", Menlo, Consolas, monospace';
const SPECIES_MAX = 64;
/** Below this a name takes two lines rather than shrinking further on one. */
const SPECIES_ONE_LINE_MIN = 44;
const SPECIES_MIN = 28;
const SPECIES_TOP = 122;
const META_SIZE = 26;
const VERDICT_SIZE = 24;
const VERDICT_LINE = 1.3;
/** The verdict box's padding, and the room its mark takes at the left. */
const VERDICT_PAD = 18;
const MARK_ROOM = 36;
const URL_MAX = 20;
const URL_MIN = 10;

/** The width of `text` set in `font`: `CanvasRenderingContext2D.measureText`, or a stand-in in tests. */
export type Measure = (text: string, font: string) => number;

export interface ImageText {
  species: string;
  /** `starsText(tier).text`. */
  stars: string;
  /** The rarity in words ("Rare"). */
  rarity: string;
  /** "Generation 3". */
  generation: string;
  verdict: 'verified' | 'failed';
  /** The verdict line as the card shows it. */
  verdictText: string;
  /** The card's URL as printed (`shareUrl`). */
  url: string;
}

export interface Line {
  text: string;
  /** The left edge and the baseline. */
  x: number;
  y: number;
}

export interface Block {
  font: string;
  size: number;
  lines: Line[];
}

export interface ImageLayout {
  kicker: Block;
  species: Block;
  /** The stars, then the rarity and the generation, on one line. */
  meta: Block;
  verdict: Block & { mark: '✓' | '✗'; box: { x: number; y: number; w: number; h: number } };
  url: Block;
}

/** The card's URL as printed on the image: host, path and the creature, nothing a local test adds. */
export function shareUrl(href: string): string {
  const url = new URL(href);
  const c = url.searchParams.get('c') ?? '';
  return `${url.host}${url.pathname}?c=${c}`;
}

/** The PNG's file name, from the species. */
export function imageFileName(species: string): string {
  const slug = species
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return `${slug || 'creature'}-biosphere.png`;
}

/** `text` in lines no wider than `width`, broken at spaces; a word wider than a line breaks anywhere. */
function wrap(text: string, font: string, width: number, measure: Measure): string[] {
  const lines: string[] = [];
  let line = '';
  for (const word of text.split(/\s+/).filter(Boolean)) {
    const next = line ? `${line} ${word}` : word;
    if (measure(next, font) <= width) {
      line = next;
      continue;
    }
    if (line) lines.push(line);
    line = word;
    while (line.length > 1 && measure(line, font) > width) {
      let n = line.length - 1;
      while (n > 1 && measure(line.slice(0, n), font) > width) n--;
      lines.push(line.slice(0, n));
      line = line.slice(n);
    }
  }
  if (line) lines.push(line);
  return lines;
}

/** The first `max` lines, the last ending in "…" when any were left out. */
function clip(lines: string[], max: number, font: string, width: number, measure: Measure) {
  if (lines.length <= max) return lines;
  const kept = lines.slice(0, max);
  let last = kept[max - 1] ?? '';
  while (last.length > 0 && measure(`${last}…`, font) > width) last = last.slice(0, -1).trimEnd();
  kept[max - 1] = `${last}…`;
  return kept;
}

const speciesFont = (size: number): string => `italic 400 ${size}px ${SANS}`;

/** The species at the largest size that fits: one line, else two broken at a space, else shortened. */
function fitSpecies(name: string, measure: Measure): { size: number; lines: string[] } {
  const width = TEXT_RIGHT - TEXT_LEFT;
  for (let size = SPECIES_MAX; size >= SPECIES_ONE_LINE_MIN; size -= 2)
    if (measure(name, speciesFont(size)) <= width) return { size, lines: [name] };
  const words = name.split(/\s+/).filter(Boolean);
  for (let size = SPECIES_MAX; size >= SPECIES_MIN; size -= 2) {
    const font = speciesFont(size);
    const lines = wrap(name, font, width, measure);
    // Two lines broken only between words.
    if (lines.length <= 2 && words.every((w) => measure(w, font) <= width)) return { size, lines };
  }
  const font = speciesFont(SPECIES_MIN);
  return {
    size: SPECIES_MIN,
    lines: clip(wrap(name, font, width, measure), 2, font, width, measure),
  };
}

const block = (font: string, size: number, x: number, top: number, lines: string[], lh = 1.15) => ({
  font,
  size,
  lines: lines.map((text, i) => ({ text, x, y: Math.round(top + size + i * size * lh) })),
});

const last = (b: Block): number => b.lines[b.lines.length - 1]?.y ?? 0;

export function imageLayout(t: ImageText, measure: Measure): ImageLayout {
  const kicker = block(`600 17px ${SANS}`, 17, TEXT_LEFT, 74, ['BIOSPHERE CREATURE']);
  const species = fitSpecies(t.species, measure);
  const name = block(
    speciesFont(species.size),
    species.size,
    TEXT_LEFT,
    SPECIES_TOP,
    species.lines,
    1.12,
  );
  const metaFont = `400 ${META_SIZE}px ${SANS}`;
  const metaWidth = TEXT_RIGHT - TEXT_LEFT;
  const metaText = clip(
    wrap(`${t.stars} ${t.rarity} · ${t.generation}`, metaFont, metaWidth, measure),
    1,
    metaFont,
    metaWidth,
    measure,
  );
  const meta = block(metaFont, META_SIZE, TEXT_LEFT, last(name) + 24, metaText);

  // The verdict in its box, as many lines as the room above the foot allows.
  const verdictFont = `500 ${VERDICT_SIZE}px ${SANS}`;
  const boxTop = last(meta) + 40;
  const textX = TEXT_LEFT + VERDICT_PAD + MARK_ROOM;
  const textWidth = TEXT_RIGHT - VERDICT_PAD - textX;
  const step = VERDICT_SIZE * VERDICT_LINE;
  const room = FOOT_TOP - 28 - boxTop - 2 * VERDICT_PAD - VERDICT_SIZE;
  const maxLines = Math.max(1, Math.floor(room / step) + 1);
  const verdictLines = clip(
    wrap(t.verdictText, verdictFont, textWidth, measure),
    maxLines,
    verdictFont,
    textWidth,
    measure,
  );
  const verdictBlock = block(
    verdictFont,
    VERDICT_SIZE,
    textX,
    boxTop + VERDICT_PAD - 4,
    verdictLines,
    VERDICT_LINE,
  );
  const boxHeight = last(verdictBlock) - boxTop + VERDICT_PAD + 6;

  // The URL across the foot, as large as fits on one line.
  const urlWidth = IMAGE_WIDTH - 2 * URL_LEFT;
  let urlSize = URL_MAX;
  const urlFont = (size: number): string => `400 ${size}px ${MONO}`;
  while (urlSize > URL_MIN && measure(t.url, urlFont(urlSize)) > urlWidth) urlSize--;
  const font = urlFont(urlSize);
  const urlLines = clip(wrap(t.url, font, urlWidth, measure), 1, font, urlWidth, measure);
  const urlTop = FOOT_TOP + (IMAGE_HEIGHT - FOOT_TOP - urlSize) / 2 - 3;

  return {
    kicker,
    species: name,
    meta,
    verdict: {
      ...verdictBlock,
      mark: t.verdict === 'verified' ? '✓' : '✗',
      box: { x: TEXT_LEFT, y: boxTop, w: TEXT_RIGHT - TEXT_LEFT, h: boxHeight },
    },
    url: block(urlFont(urlSize), urlSize, URL_LEFT, urlTop, urlLines),
  };
}

const WATER = '#04090b';
const TEXT = '#e3f4f0';
const MUTED = '#7fa39c';
const VERDICT_STYLE = {
  verified: { fill: 'rgb(110 220 160 / 0.12)', line: 'rgb(110 220 160 / 0.4)', mark: '#8de8b0' },
  failed: { fill: 'rgb(240 110 100 / 0.13)', line: 'rgb(240 110 100 / 0.45)', mark: '#ff9c90' },
} as const;

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
) {
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, r);
}

function fillLines(ctx: CanvasRenderingContext2D, b: Block, colour: string): void {
  ctx.font = b.font;
  ctx.fillStyle = colour;
  for (const line of b.lines) ctx.fillText(line.text, line.x, line.y);
}

/**
 * Paints the card image on a 1200 × 630 context: the water, the creature's render (`art`, drawn
 * at `ART_WIDTH` × `ART_HEIGHT`, or nothing), the words, and the URL. `tier` is the rarity colour.
 */
export function drawCardImage(
  ctx: CanvasRenderingContext2D,
  art: CanvasImageSource | null,
  t: ImageText,
  tier: string,
): void {
  const measure: Measure = (text, font) => {
    ctx.font = font;
    return ctx.measureText(text).width;
  };
  const layout = imageLayout(t, measure);
  ctx.save();
  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = WATER;
  ctx.fillRect(0, 0, IMAGE_WIDTH, IMAGE_HEIGHT);
  // The page's light in the water, behind the words.
  const glow = ctx.createRadialGradient(900, 220, 0, 900, 220, 520);
  glow.addColorStop(0, 'rgb(40 92 104 / 0.3)');
  glow.addColorStop(1, 'rgb(40 92 104 / 0)');
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, IMAGE_WIDTH, IMAGE_HEIGHT);

  if (art) ctx.drawImage(art, 0, 0, ART_WIDTH, ART_HEIGHT);
  // The render's edge fades into the water.
  const fade = ctx.createLinearGradient(ART_WIDTH - 90, 0, ART_WIDTH, 0);
  fade.addColorStop(0, 'rgb(4 9 11 / 0)');
  fade.addColorStop(1, 'rgb(4 9 11 / 1)');
  ctx.fillStyle = fade;
  ctx.fillRect(ART_WIDTH - 90, 0, 90, ART_HEIGHT);
  const foot = ctx.createLinearGradient(0, ART_HEIGHT - 60, 0, ART_HEIGHT);
  foot.addColorStop(0, 'rgb(4 9 11 / 0)');
  foot.addColorStop(1, 'rgb(4 9 11 / 1)');
  ctx.fillStyle = foot;
  ctx.fillRect(0, ART_HEIGHT - 60, ART_WIDTH, 60);

  // The foot: a hairline, then the URL.
  ctx.fillStyle = 'rgb(200 240 255 / 0.03)';
  ctx.fillRect(0, FOOT_TOP, IMAGE_WIDTH, IMAGE_HEIGHT - FOOT_TOP);
  ctx.fillStyle = 'rgb(200 240 255 / 0.12)';
  ctx.fillRect(URL_LEFT, FOOT_TOP, IMAGE_WIDTH - 2 * URL_LEFT, 1);
  fillLines(ctx, layout.url, MUTED);

  ctx.letterSpacing = '3px';
  fillLines(ctx, layout.kicker, MUTED);
  ctx.letterSpacing = '0px';
  fillLines(ctx, layout.species, TEXT);

  // The stars in the rarity's colour, then the rest muted.
  const metaLine = layout.meta.lines[0];
  if (metaLine) {
    ctx.font = layout.meta.font;
    const stars = metaLine.text.startsWith(t.stars) ? t.stars : '';
    ctx.fillStyle = tier;
    ctx.fillText(stars, metaLine.x, metaLine.y);
    ctx.fillStyle = MUTED;
    ctx.fillText(
      metaLine.text.slice(stars.length),
      metaLine.x + ctx.measureText(stars).width,
      metaLine.y,
    );
  }

  // The verdict in its box: a tick or a cross, as well as a colour.
  const v = layout.verdict;
  const style = VERDICT_STYLE[t.verdict];
  roundRect(ctx, v.box.x, v.box.y, v.box.w, v.box.h, 14);
  ctx.fillStyle = style.fill;
  ctx.fill();
  ctx.strokeStyle = style.line;
  ctx.lineWidth = 1.5;
  ctx.stroke();
  ctx.font = `700 ${VERDICT_SIZE + 2}px ${SANS}`;
  ctx.fillStyle = style.mark;
  ctx.fillText(v.mark, v.box.x + VERDICT_PAD, v.lines[0]?.y ?? 0);
  fillLines(ctx, v, TEXT);

  // The card's edge, in the rarity's colour as on the page.
  roundRect(ctx, 8, 8, IMAGE_WIDTH - 16, IMAGE_HEIGHT - 16, 20);
  ctx.strokeStyle = tier;
  ctx.globalAlpha = 0.45;
  ctx.lineWidth = 2;
  ctx.stroke();
  ctx.restore();
}

/** The image as a PNG. */
export function imageBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) =>
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('no PNG'))), 'image/png'),
  );
}
