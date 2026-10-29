// The ping and emote icons (M6 T25, #89): original glowing line art drawn for Biosphere on a 24 px
// grid with one line weight, round ends and joins, in the current text colour; `.icon` in
// style.css gives every one the same soft glow on the dark water. Every icon carries a <title> for
// screen readers.
//
// Shapes are told apart without colour: a hand, a heart, a speech bubble and three faces that
// differ in outline as well as features (round and smiling, bristling, small and shivering); for
// the pings an eye, a warning sign, three globules and a twisted double strand (genes mix when two
// creatures mate).

export const ICON_GRID = 24;
/** The line weight of every icon, in grid units. */
export const ICON_STROKE = 2;

export const ICON_NAMES = [
  'look',
  'danger',
  'food',
  'mate',
  'wave',
  'happy',
  'love',
  'angry',
  'scared',
  'question',
] as const;
export type IconName = (typeof ICON_NAMES)[number];

export interface IconDef {
  /** The name read by screen readers. */
  title: string;
  /** The shapes, in grid units; the root sets the stroke, so shapes carry geometry only. */
  body: string;
}

const path = (d: string) => `<path d="${d}"/>`;
const circle = (cx: number, cy: number, r: number) => `<circle cx="${cx}" cy="${cy}" r="${r}"/>`;
/** A dot is a line of no length: its round ends make a disc of the line's width. */
const dot = (x: number, y: number) => path(`M${x} ${y}h0`);
/** Short strokes standing out from (12, 12) between radii `from` and `to`, turned by `turn` degrees. */
function bristles(count: number, from: number, to: number, turn: number): string {
  const at = (r: number, a: number) =>
    `${round(12 + r * Math.cos(a))} ${round(12 + r * Math.sin(a))}`;
  let d = '';
  for (let i = 0; i < count; i++) {
    const a = ((turn + (360 * i) / count) * Math.PI) / 180;
    d += `M${at(from, a)}L${at(to, a)}`;
  }
  return path(d);
}
const round = (v: number) => Math.round(v * 100) / 100;

export const ICONS: Record<IconName, IconDef> = {
  look: {
    title: 'Look',
    body: [
      path('M2 12C5.5 5.5 18.5 5.5 22 12C18.5 18.5 5.5 18.5 2 12Z'),
      circle(12, 12, 3.5),
      dot(12, 12),
    ].join(''),
  },
  danger: {
    title: 'Danger',
    body: [path('M12 3L21.5 19.5H2.5Z'), path('M12 9.5V13.5'), dot(12, 16.75)].join(''),
  },
  food: {
    title: 'Food',
    body: [
      circle(9, 15, 5),
      path('M7 15A2 2 0 0 1 9 13'),
      circle(17, 7.5, 3),
      circle(18.5, 16, 1.75),
    ].join(''),
  },
  mate: {
    title: 'Mate',
    body: [
      path('M7 2.5C7 7.5 17 7.5 17 12C17 16.5 7 16.5 7 21.5'),
      path('M17 2.5C17 7.5 7 7.5 7 12C7 16.5 17 16.5 17 21.5'),
      path('M9.75 12H14.25'),
      path('M9.6 4.4H14.4'),
      path('M9.6 19.6H14.4'),
    ].join(''),
  },
  wave: {
    title: 'Wave',
    body: [
      path(
        'M8.5 13V8A2 2 0 0 1 12.5 8V11.5M12.5 11.5V6A2 2 0 0 1 16.5 6V12M16.5 12V9A2 2 0 0 1 20.5 9V15A7 7 0 0 1 13.5 22H12.5A5 5 0 0 1 8.7 20.2L5 15.9A1.8 1.8 0 0 1 7.9 13.8L8.5 14.5V13',
      ),
      path('M2 9A7 7 0 0 1 4.5 3'),
      path('M4.5 9.5A4.5 4.5 0 0 1 6 5.5'),
    ].join(''),
  },
  happy: {
    title: 'Happy',
    body: [
      circle(12, 12, 9.5),
      path('M7 10.5Q8.75 7.75 10.5 10.5'),
      path('M13.5 10.5Q15.25 7.75 17 10.5'),
      path('M7.5 14Q12 19.5 16.5 14'),
    ].join(''),
  },
  love: {
    title: 'Love',
    body: [
      path(
        'M12 20.5C5 16 2.5 12 2.5 8.5A4.75 4.75 0 0 1 12 6.6A4.75 4.75 0 0 1 21.5 8.5C21.5 12 19 16 12 20.5Z',
      ),
      path('M6 9A2.5 2.5 0 0 1 8.5 6.5'),
    ].join(''),
  },
  angry: {
    title: 'Angry',
    // A small face bristling all round, like a puffed-up pufferfish.
    body: [
      circle(12, 12, 7),
      bristles(12, 9.5, 10.75, 15),
      path('M8.25 9.75L10.75 11'),
      path('M15.75 9.75L13.25 11'),
      path('M9.25 15.5Q12 13.25 14.75 15.5'),
    ].join(''),
  },
  scared: {
    title: 'Scared',
    // A small face with wide eyes and a wobbling mouth, shivering.
    body: [
      circle(12, 12.5, 7.5),
      circle(9.25, 11, 1.25),
      circle(14.75, 11, 1.25),
      path('M8.75 16.25Q10.4 14.75 12 16.25T15.25 16.25'),
      path('M2.5 9.5Q1.5 12.5 2.5 15.5'),
      path('M21.5 9.5Q22.5 12.5 21.5 15.5'),
    ].join(''),
  },
  question: {
    title: 'Question',
    body: [
      path(
        'M5 3H19A2.5 2.5 0 0 1 21.5 5.5V15.5A2.5 2.5 0 0 1 19 18H12L7.5 21.5V18H5A2.5 2.5 0 0 1 2.5 15.5V5.5A2.5 2.5 0 0 1 5 3Z',
      ),
      path('M9.5 8.5A2.5 2.5 0 1 1 13.4 10.57C12.6 11.1 12 11.6 12 12.25'),
      dot(12, 15),
    ].join(''),
  },
};

/** The icon as SVG markup, its title first. */
export function iconMarkup(name: IconName): string {
  const { title, body } = ICONS[name];
  return (
    `<svg class="icon" data-icon="${name}" viewBox="0 0 ${ICON_GRID} ${ICON_GRID}" role="img" ` +
    `fill="none" stroke="currentColor" stroke-width="${ICON_STROKE}" stroke-linecap="round" ` +
    `stroke-linejoin="round"><title>${title}</title>${body}</svg>`
  );
}

const templates = new Map<IconName, SVGSVGElement>();

/** A new icon element; its markup is ours alone, parsed once per icon and cloned after that. */
export function makeIcon(name: IconName): SVGSVGElement {
  let template = templates.get(name);
  if (!template) {
    const holder = document.createElement('template');
    holder.innerHTML = iconMarkup(name);
    template = holder.content.firstElementChild as SVGSVGElement;
    templates.set(name, template);
  }
  return template.cloneNode(true) as SVGSVGElement;
}

/** Puts `icon` in `el` unless it already shows it; null empties it. */
export function showIcon(el: Element, icon: IconName | null): void {
  if ((el.firstElementChild?.getAttribute('data-icon') ?? null) === icon) return;
  if (icon) el.replaceChildren(makeIcon(icon));
  else el.replaceChildren();
}
