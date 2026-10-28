// The look-pass notes (M6 T5, ADR 0024): every `docs/art/gallery/pass-<n>.md` holds a gap table,
// one row per aspect and one column per reference, each cell a score from 0 (holds up next to the
// reference) to 3 (far off) with a sentence, then a "Largest gaps" list. This checks the shape, so a
// pass cannot skip a cell; whether the scores are honest is for the reader to challenge.

export const ASPECTS = [
  'Silhouette variety',
  'Translucency',
  'Inner detail',
  'Fine appendages',
  'Palette',
  'Rare glints',
  'Lighting',
] as const;
export const REFERENCES = ['02', '03', '04', '05'] as const;

export type Aspect = (typeof ASPECTS)[number];
export type Reference = (typeof REFERENCES)[number];

export interface PassNote {
  scores: Record<Aspect, Record<Reference, number>>;
  gaps: string[];
}

/** A cell: the score, a colon and a sentence, as in `3: No body curves.` */
const CELL = /^([0-9]+)\s*:\s*(\S.*)$/;
const cells = (line: string): string[] =>
  line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((c) => c.trim());

/** Reads a pass note; the problems list is empty when the table and the gaps list are complete. */
export function readPassNote(markdown: string): { note: PassNote; problems: string[] } {
  const problems: string[] = [];
  const scores = {} as PassNote['scores'];
  const lines = markdown.split('\n');
  const header = lines.findIndex((l) => l.trim().startsWith('|'));
  if (
    header < 0 ||
    cells(lines[header] as string).join('|') !== ['Aspect', ...REFERENCES].join('|')
  ) {
    problems.push(
      `the gap table must start with the header | Aspect | ${REFERENCES.join(' | ')} |`,
    );
  } else {
    for (let i = header + 2; i < lines.length && (lines[i] as string).trim().startsWith('|'); i++) {
      const [aspect, ...row] = cells(lines[i] as string);
      if (!ASPECTS.includes(aspect as Aspect)) {
        problems.push(`unknown aspect "${aspect}"`);
        continue;
      }
      if (scores[aspect as Aspect]) problems.push(`${aspect} appears twice`);
      const scored = {} as Record<Reference, number>;
      for (const [k, ref] of REFERENCES.entries()) {
        const match = CELL.exec(row[k] ?? '');
        const score = Number(match?.[1]);
        if (!match || score > 3) {
          problems.push(`${aspect} × ${ref} needs "0-3: a sentence", not "${row[k] ?? ''}"`);
        } else scored[ref] = score;
      }
      if (row.length !== REFERENCES.length) problems.push(`${aspect} has ${row.length} cells`);
      scores[aspect as Aspect] = scored;
    }
    for (const aspect of ASPECTS) {
      if (!scores[aspect]) problems.push(`the row for ${aspect} is missing`);
    }
  }

  const gaps: string[] = [];
  const heading = lines.findIndex((l) => /^#+\s+Largest gaps\s*$/i.test(l.trim()));
  if (heading < 0) problems.push('the "Largest gaps" list is missing');
  else {
    for (let i = heading + 1; i < lines.length && !(lines[i] as string).startsWith('#'); i++) {
      const item = /^\s*(?:\d+\.|[-*])\s+(\S.*)$/.exec(lines[i] as string);
      if (item) gaps.push(item[1] as string);
    }
    if (gaps.length === 0) problems.push('the "Largest gaps" list is empty');
  }
  return { note: { scores, gaps }, problems };
}
