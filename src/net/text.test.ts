import { describe, expect, it } from 'vitest';
import { filterText, isProfane, validName } from './text';
import { ENGLISH_TERMS, GERMAN_TERMS, INNOCENT_WORDS } from './text-words';

describe('validName', () => {
  it.each(['Cell1234', 'a-b_c', 'abc', 'a'.repeat(16)])('accepts %j', (name) => {
    expect(validName(name)).toBe(true);
  });

  it.each(['ab', 'a'.repeat(17), 'bad name', 'é', 'ümlaut', ''])('rejects %j', (name) => {
    expect(validName(name)).toBe(false);
  });

  it('rejects a profane name that has a valid shape', () => {
    expect(validName('Fuck')).toBe(false);
    expect(validName('f_u_c_k')).toBe(false);
    expect(validName('Arschloch')).toBe(false);
    expect(validName('Cell1234')).toBe(true);
  });
});

describe('word lists', () => {
  it.each([
    ['English', ENGLISH_TERMS],
    ['German', GERMAN_TERMS],
  ])('%s has at least 80 distinct lowercase ASCII terms', (_lang, terms) => {
    expect(new Set(terms).size).toBe(terms.length);
    expect(terms.length).toBeGreaterThanOrEqual(80);
    for (const t of terms) expect(t).toMatch(/^[a-z]{3,}$/);
  });

  it('keeps innocent words out of the term lists', () => {
    for (const w of INNOCENT_WORDS) expect(isProfane(w)).toBe(false);
  });
});

describe('filterText', () => {
  it('replaces profanity with asterisks of the same length', () => {
    expect(filterText('what the fuck')).toBe('what the ****');
    expect(filterText('Du Arschloch!')).toBe('Du *********!');
    expect(filterText('hello pond')).toBe('hello pond');
  });

  it('is case-insensitive', () => {
    expect(filterText('FuCk')).toBe('****');
    expect(filterText('SCHEISSE')).toBe('********');
  });

  it('sees through leetspeak', () => {
    expect(filterText('b0ll0cks')).toBe('********');
    expect(filterText('5h1t')).toBe('****');
    expect(filterText('@ssh0le')).toBe('*******');
    expect(filterText('$hit')).toBe('****');
    expect(filterText('sh!t')).toBe('****');
    expect(filterText('b17ch')).toBe('*****');
  });

  it('sees through repeated letters', () => {
    expect(filterText('fuuuck')).toBe('******');
    expect(filterText('shiiiit')).toBe('*******');
    expect(filterText('assss')).toBe('*****');
  });

  it('sees through separators between letters', () => {
    expect(filterText('f.u.c.k')).toBe('*******');
    expect(filterText('f u c k')).toBe('*******');
    expect(filterText('you f-u-c-k off')).toBe('you ******* off');
    expect(filterText('s_h_i_t')).toBe('*******');
  });

  it('sees through Unicode confusables, accents and fullwidth letters', () => {
    expect(filterText('ƒuck')).toBe('****');
    expect(filterText('fúck')).toBe('****');
    expect(filterText('ｆｕｃｋ')).toBe('****');
    expect(filterText('fuсk')).toBe('****'); // Cyrillic с
    expect(filterText('scheiße')).toBe('*******');
    expect(filterText('fu​ck')).toBe('*****');
  });

  it('matches long terms as stems and short terms only as whole words', () => {
    expect(filterText('motherfuckers')).toBe('*************');
    expect(filterText('assholery')).toBe('*********');
    expect(filterText('scheissegal')).toBe('***********');
    expect(filterText('fuckwad')).toBe('fuckwad');
  });

  it('keeps words the lists merely contain', () => {
    expect(filterText('fire retardant')).toBe('fire retardant');
  });

  it('finds several words in one message', () => {
    expect(filterText('fuck this shit')).toBe('**** this ****');
  });

  it('never throws and never lengthens random text', () => {
    let s = 0x2545f491;
    const next = (): number => {
      s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
      return s / 0x100000000;
    };
    const pools = [
      'abcdefghijklmnopqrstuvwxyz',
      'ABCXYZ 0123456789 .-_*@$!',
      'ƒéüßøłŧ​́ｆｕｃｋсо',
      '😀𐀀\udfff',
    ];
    for (let i = 0; i < 10_000; i++) {
      const len = Math.floor(next() * 140);
      let text = '';
      for (let j = 0; j < len; j++) {
        const pool = pools[Math.floor(next() * pools.length)] as string;
        text += pool[Math.floor(next() * pool.length)];
      }
      const out = filterText(text);
      expect(out.length).toBeLessThanOrEqual(text.length);
      isProfane(text);
    }
  });

  it('filters a 140-character message in well under a millisecond on average', () => {
    const text =
      'the quick brown fox jumps over the lazy dog while a school of tiny cells drifts by '.slice(
        0,
        140,
      );
    const start = performance.now();
    for (let i = 0; i < 200; i++) filterText(text);
    expect((performance.now() - start) / 200).toBeLessThan(1);
  });
});

describe('false positives', () => {
  const CLEAN = [
    'Scunthorpe is a town in England',
    'a classic move',
    'the assassin hid in the grass',
    'Arschivist is a made-up word',
    'I will pass the class',
    'please assume nothing',
    'Sussex and Essex are counties',
    'the title of the book',
    'a titan walks by',
    'cocktail party tonight',
    'shiitake mushrooms taste great',
    'analysis of the data',
    'bass guitar solo',
    'a hello from the pond',
    'Cockburn and Dickens wrote books',
    'I have 5 apples and 4 pears',
    'the score was 455 to 300',
    'my cell is hungry',
    'eat the green food',
    'dash away from the toxin',
    'what a lovely day',
    'follow me to the light',
    'we can mate later',
    'nice to meet you',
    'good game everyone',
    'I am a s tiny cell',
    'Maine coon cats are big',
    'the fire retardant worked',
    'passage through the reef',
    'a massive jellyfish',
    'compass and map',
    'Hancock and Mitchell',
    'grassland and bassoon',
    'the pickens family',
    'Penistone is in Yorkshire',
    'Lancaster, Middlesex, Essex',
    'schoen und gut',
    'Guten Tag, wie geht es dir?',
    'Das ist ein Archivist',
    'Wir spielen heute Abend',
    'Hurra, wir haben gewonnen',
    'Der Arzt kommt morgen',
    'Mose führte das Volk',
    'Die Kacheln sind blau',
    'Ich esse Kuchen',
    'Schwanzflosse und Rückenflosse',
    'Pennälerstreich',
    'Das Wetter ist schön',
    'ein Gespräch über Zellen',
    'Teichwasser ist klar',
  ];

  it('has a fixed corpus of 50 clean sentences', () => {
    expect(CLEAN).toHaveLength(50);
  });

  it.each(CLEAN)('leaves %j alone', (sentence) => {
    expect(filterText(sentence)).toBe(sentence);
    expect(isProfane(sentence)).toBe(false);
  });
});
