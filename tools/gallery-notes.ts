// The look-pass notes (M6 T5, ADR 0024): every `docs/art/gallery/pass-<n>.md` holds a gap table,
// one row per aspect and one column per reference, each cell a score from 0 (holds up next to the
// reference) to 3 (far off) with a sentence, then a "Largest gaps" list. This checks the shape, so a
// pass cannot skip a cell; whether the scores are honest is for the reader to challenge. From pass 6
// on (M6b T12, ADR 0034) the note also judges each aspect against pass 1: `better`, `same` or `worse`.

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
export const VERDICTS = ['better', 'same', 'worse'] as const;
/** The first pass whose note holds the "Against pass 1" table (ADR 0034). */
const AGAINST_PASS_1_FROM = 6;

export type Aspect = (typeof ASPECTS)[number];
export type Reference = (typeof REFERENCES)[number];
export type Verdict = (typeof VERDICTS)[number];

export interface PassNote {
  scores: Record<Aspect, Record<Reference, number>>;
  /** Each aspect against pass 1 (passes 6 and on). */
  againstPass1?: Record<Aspect, Verdict>;
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

/** A verdict cell: the word, a colon and a sentence, as in `better: Clearer glass.` */
const VERDICT = /^([a-z]+)\s*:\s*(\S.*)$/;
const AGAINST_HEADER = ['Aspect', 'Against pass 1'].join('|');

/** The rows of the table under `header`, until the first line that is not a table row. */
function tableRows(lines: string[], header: number): string[][] {
  const rows: string[][] = [];
  for (let i = header + 2; i < lines.length && (lines[i] as string).trim().startsWith('|'); i++) {
    rows.push(cells(lines[i] as string));
  }
  return rows;
}

/** Reads the "Against pass 1" table: one known verdict and a sentence for every aspect. */
function readAgainstPass1(lines: string[], problems: string[]): Record<Aspect, Verdict> {
  const verdicts = {} as Record<Aspect, Verdict>;
  const header = lines.findIndex((l) => cells(l).join('|') === AGAINST_HEADER);
  if (header < 0) {
    problems.push('the "Against pass 1" table must start with | Aspect | Against pass 1 |');
    return verdicts;
  }
  for (const [aspect, cell, ...rest] of tableRows(lines, header)) {
    if (!ASPECTS.includes(aspect as Aspect)) {
      problems.push(`Against pass 1: unknown aspect "${aspect}"`);
      continue;
    }
    if (verdicts[aspect as Aspect]) problems.push(`Against pass 1: ${aspect} appears twice`);
    const match = VERDICT.exec(cell ?? '');
    const word = match?.[1] as Verdict | undefined;
    if (!word || !VERDICTS.includes(word) || rest.length > 0) {
      problems.push(
        `Against pass 1: ${aspect} needs "${VERDICTS.join('|')}: a sentence", not "${cell ?? ''}"`,
      );
    } else verdicts[aspect as Aspect] = word;
  }
  for (const aspect of ASPECTS) {
    if (!verdicts[aspect]) problems.push(`Against pass 1: the row for ${aspect} is missing`);
  }
  return verdicts;
}

/**
 * Reads a pass note; the problems list is empty when the tables and the gaps list are complete.
 * `pass` (when known) asks for the "Against pass 1" table from pass 6 on.
 */
export function readPassNote(
  markdown: string,
  pass?: number,
): { note: PassNote; problems: string[] } {
  const problems: string[] = [];
  const scores = {} as PassNote['scores'];
  const lines = markdown.split('\n');
  const gapHeader = ['Aspect', ...REFERENCES].join('|');
  const header = lines.findIndex((l) => cells(l).join('|') === gapHeader);
  if (header < 0) {
    problems.push(
      `the gap table must start with the header | Aspect | ${REFERENCES.join(' | ')} |`,
    );
  } else {
    for (const [aspect, ...row] of tableRows(lines, header)) {
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

  const againstPass1 =
    pass !== undefined && pass >= AGAINST_PASS_1_FROM
      ? readAgainstPass1(lines, problems)
      : undefined;

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
  return { note: { scores, ...(againstPass1 && { againstPass1 }), gaps }, problems };
}
