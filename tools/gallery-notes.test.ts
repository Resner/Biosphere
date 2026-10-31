import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseGalleryArgs } from './gallery-capture.mjs';
import { ASPECTS, REFERENCES, readPassNote, VERDICTS } from './gallery-notes';

const DIR = new URL('../docs/art/gallery/', import.meta.url);

const table = (cell: (aspect: string, ref: string) => string) =>
  [
    `| Aspect | ${REFERENCES.join(' | ')} |`,
    `| --- | ${REFERENCES.map(() => '---').join(' | ')} |`,
    ...ASPECTS.map((a) => `| ${a} | ${REFERENCES.map((r) => cell(a, r)).join(' | ')} |`),
  ].join('\n');
const GAPS = '## Largest gaps\n\n1. Bodies are all round.\n2. No organs.\n';
const note = (cell = (_a: string, _r: string) => '3: Far off.', gaps = GAPS) =>
  `# Look pass 9\n\n## Gap table\n\n${table(cell)}\n\n${gaps}`;

describe('look-pass notes', () => {
  it('reads every cell and the gaps list of a complete note', () => {
    const { note: read, problems } = readPassNote(
      note((a, r) => `${a === 'Palette' && r === '04' ? 1 : 3}: A sentence.`),
    );
    expect(problems).toEqual([]);
    expect(read.scores.Palette['04']).toBe(1);
    expect(read.scores.Lighting['05']).toBe(3);
    expect(read.gaps).toEqual(['Bodies are all round.', 'No organs.']);
  });

  it('fails on a missing cell, a score outside 0-3, a missing row or sentence', () => {
    const blank = readPassNote(note((a, r) => (a === 'Lighting' && r === '03' ? '' : '2: Off.')));
    expect(blank.problems.join('\n')).toMatch(/Lighting × 03/);
    const four = readPassNote(
      note((a, r) => (a === 'Palette' && r === '05' ? '4: Worse.' : '0: Fine.')),
    );
    expect(four.problems.join('\n')).toMatch(/Palette × 05/);
    const bare = readPassNote(note((a) => (a === 'Translucency' ? '3' : '1: Close.')));
    expect(bare.problems.join('\n')).toMatch(/Translucency × 02/);
    const short = readPassNote(note().replace(/^\| Rare glints .*$/m, ''));
    expect(short.problems.join('\n')).toMatch(/Rare glints is missing/);
    const extra = readPassNote(note().replace('| Lighting |', '| Mood |'));
    expect(extra.problems.join('\n')).toMatch(/unknown aspect "Mood"/);
  });

  it('fails without a "Largest gaps" list', () => {
    expect(readPassNote(note(undefined, '')).problems).toContain(
      'the "Largest gaps" list is missing',
    );
    expect(readPassNote(note(undefined, '## Largest gaps\n\nNone.\n')).problems).toContain(
      'the "Largest gaps" list is empty',
    );
  });

  it('holds for every committed pass note', () => {
    const passes = readdirSync(DIR).filter((f) => /^pass-\d+\.md$/.test(f));
    expect(passes).toContain('pass-0.md');
    for (const file of passes) {
      const pass = Number(/\d+/.exec(file)?.[0]);
      const { problems } = readPassNote(readFileSync(new URL(file, DIR), 'utf8'), pass);
      expect(problems, file).toEqual([]);
    }
  });
});

describe('the "Against pass 1" table (M6b T12, ADR 0034)', () => {
  const against = (cell: (aspect: string) => string = () => 'same: As in pass 1.') =>
    [
      '## Against pass 1',
      '',
      '| Aspect | Against pass 1 |',
      '| --- | --- |',
      ...ASPECTS.map((a) => `| ${a} | ${cell(a)} |`),
    ].join('\n');
  const pass6 = (table = against()) =>
    `# Look pass 6\n\n## Gap table\n\n${table6()}\n\n${table}\n\n${GAPS}`;
  const table6 = () => note().split('## Gap table\n\n')[1]?.split('\n\n## Largest')[0] ?? '';

  it('reads a verdict per aspect from pass 6 on', () => {
    const { note: read, problems } = readPassNote(
      pass6(against((a) => `${a === 'Palette' ? 'better' : 'same'}: A sentence.`)),
      6,
    );
    expect(problems).toEqual([]);
    expect(VERDICTS).toEqual(['better', 'same', 'worse']);
    expect(read.againstPass1?.Palette).toBe('better');
    expect(read.againstPass1?.Lighting).toBe('same');
  });

  it('fails on a missing table, a missing aspect, another word or no sentence', () => {
    expect(readPassNote(note(), 6).problems.join('\n')).toMatch(/Against pass 1/);
    const missing = readPassNote(pass6(against().replace(/^\| Rare glints .*$/m, '')), 6);
    expect(missing.problems.join('\n')).toMatch(/Rare glints/);
    const word = readPassNote(
      pass6(against((a) => (a === 'Lighting' ? 'close: Near.' : 'same: Ok.'))),
      6,
    );
    expect(word.problems.join('\n')).toMatch(/Lighting/);
    const bare = readPassNote(pass6(against((a) => (a === 'Palette' ? 'better' : 'same: Ok.'))), 6);
    expect(bare.problems.join('\n')).toMatch(/Palette/);
    const extra = readPassNote(pass6(against().replace('| Lighting |', '| Mood |')), 6);
    expect(extra.problems.join('\n')).toMatch(/Mood/);
  });

  it('is not asked of passes before 6', () => {
    expect(readPassNote(note(), 5).problems).toEqual([]);
    expect(readPassNote(note()).problems).toEqual([]);
  });
});

describe('npm run gallery arguments', () => {
  it('takes a whole pass number and an optional --no-build', () => {
    expect(parseGalleryArgs(['--pass', '0'])).toEqual({ pass: 0, build: true });
    expect(parseGalleryArgs(['--pass=3', '--no-build'])).toEqual({ pass: 3, build: false });
    expect(() => parseGalleryArgs([])).toThrow(/--pass/);
    expect(() => parseGalleryArgs(['--pass', '1.5'])).toThrow(/--pass/);
    expect(() => parseGalleryArgs(['--pass', '1', '--fast'])).toThrow(/--fast/);
  });
});
