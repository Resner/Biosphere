// Names and chat text: the shape check for names and a profanity filter (English and German),
// shared with the Worker, so it has no DOM, Node or network dependencies.

import { NAME_RE } from './protocol';
import { ENGLISH_TERMS, GERMAN_TERMS, INNOCENT_WORDS } from './text-words';

/** Terms of at least this many letters also match inside longer words. */
const STEM_MIN = 6;
/** The fewest single letters in a row (`f u c k`) that count as one spelled-out word. */
const SPELLED_MIN = 3;

const WHOLE = new Set([...ENGLISH_TERMS, ...GERMAN_TERMS]);
const STEMS = [...WHOLE].filter((t) => t.length >= STEM_MIN);
const INNOCENT = new Set(INNOCENT_WORDS);

const LEET: Readonly<Record<string, string>> = {
  '0': 'o',
  '1': 'i',
  '3': 'e',
  '4': 'a',
  '5': 's',
  '7': 't',
  '@': 'a',
  $: 's',
  '!': 'i',
};

// Letters that Unicode normalisation does not turn into ASCII, and look-alikes from other scripts.
const CONFUSABLE: Readonly<Record<string, string>> = {
  ƒ: 'f',
  ø: 'o',
  ł: 'l',
  đ: 'd',
  ħ: 'h',
  ı: 'i',
  ŧ: 't',
  ß: 'ss',
  æ: 'ae',
  œ: 'oe',
  а: 'a',
  в: 'b',
  е: 'e',
  к: 'k',
  м: 'm',
  н: 'h',
  о: 'o',
  р: 'p',
  с: 'c',
  т: 't',
  у: 'y',
  х: 'x',
  і: 'i',
  α: 'a',
  ε: 'e',
  ι: 'i',
  κ: 'k',
  ν: 'v',
  ο: 'o',
  ρ: 'p',
  τ: 't',
  υ: 'u',
};

/** A character of the text: where it sits in the original and what it counts as. */
interface Cell {
  start: number;
  end: number;
  /** Its letters (`ß` gives two), empty for a separator; `kind` says how it got there. */
  letters: string;
  kind: 'letter' | 'leet' | 'bang' | 'ignored' | 'separator';
}

const ASCII_LETTER = /^[a-z]+$/;
const COMBINING_MARK = /\p{M}/gu;

function classify(ch: string, start: number): Cell {
  const end = start + ch.length;
  // Zero-width characters and bare combining marks are invisible: they join the letters around them.
  if (/^[\p{M}\p{Cf}]+$/u.test(ch)) return { start, end, letters: '', kind: 'ignored' };
  const lower = ch.toLowerCase();
  const direct = CONFUSABLE[lower];
  const base = direct ?? lower.normalize('NFKD').replace(COMBINING_MARK, '');
  const mapped = base
    .split('')
    .map((c) => CONFUSABLE[c] ?? c)
    .join('');
  if (ASCII_LETTER.test(mapped)) return { start, end, letters: mapped, kind: 'letter' };
  if (ch === '!') return { start, end, letters: 'i', kind: 'bang' };
  const leet = LEET[ch];
  if (leet) return { start, end, letters: leet, kind: 'leet' };
  return { start, end, letters: '', kind: 'separator' };
}

function cellsOf(text: string): Cell[] {
  const cells: Cell[] = [];
  let at = 0;
  for (const ch of text) {
    cells.push(classify(ch, at));
    at += ch.length;
  }
  // `!` only stands for `i` inside a word (`sh!t`), not at its end (`shit!`).
  for (let i = 0; i < cells.length; i++) {
    const cell = cells[i] as Cell;
    if (cell.kind !== 'bang') continue;
    const inside = wordSide(cells, i, -1) && wordSide(cells, i, 1);
    if (!inside) {
      cell.kind = 'separator';
      cell.letters = '';
    }
  }
  return cells;
}

function wordSide(cells: Cell[], from: number, step: 1 | -1): boolean {
  for (let i = from + step; i >= 0 && i < cells.length; i += step) {
    const { kind } = cells[i] as Cell;
    if (kind === 'ignored') continue;
    return kind === 'letter' || kind === 'leet';
  }
  return false;
}

/** A run of letters between separators. */
interface Token {
  start: number;
  end: number;
  word: string;
  /** Written with at least one real letter (a bare `455` is a number, not `ass`). */
  hasLetter: boolean;
  /** Exactly one real letter and nothing else. */
  single: boolean;
}

function tokensOf(cells: Cell[]): Token[] {
  const tokens: Token[] = [];
  let run: Cell[] = [];
  const close = (): void => {
    const visible = run.filter((c) => c.kind !== 'ignored');
    if (visible.length > 0) {
      const word = visible.map((c) => c.letters).join('');
      const real = visible.filter((c) => c.kind === 'letter').length;
      tokens.push({
        start: (run[0] as Cell).start,
        end: (run[run.length - 1] as Cell).end,
        word,
        hasLetter: real > 0,
        single: visible.length === 1 && real === 1 && word.length === 1,
      });
    }
    run = [];
  };
  for (const cell of cells) {
    if (cell.kind === 'separator') close();
    else run.push(cell);
  }
  close();
  return tokens;
}

/** The word as typed, with each run of the same letter cut to two, then to one. */
function shortenedForms(word: string): string[] {
  const twice = word.replace(/(.)\1{2,}/g, '$1$1');
  const once = word.replace(/(.)\1+/g, '$1');
  return [word, twice, once];
}

function wordIsProfane(word: string): boolean {
  for (const form of shortenedForms(word)) {
    if (WHOLE.has(form)) return true;
    if (INNOCENT.has(form)) continue;
    for (const stem of STEMS) if (form.includes(stem)) return true;
  }
  return false;
}

/** Character ranges `[start, end)` of the original text that hold profanity. */
function profaneSpans(text: string): Array<[number, number]> {
  const tokens = tokensOf(cellsOf(text));
  const spans: Array<[number, number]> = [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i] as Token;
    if (token.hasLetter && wordIsProfane(token.word)) {
      spans.push([token.start, token.end]);
      continue;
    }
    if (!token.single) continue;
    // A word spelled letter by letter: look at every stretch of the single letters around here.
    let last = i;
    while (last + 1 < tokens.length && (tokens[last + 1] as Token).single) last++;
    for (let from = i; from + SPELLED_MIN <= last + 1; from++) {
      for (let to = last; to - from + 1 >= SPELLED_MIN; to--) {
        const word = tokens
          .slice(from, to + 1)
          .map((t) => t.word)
          .join('');
        if (wordIsProfane(word)) {
          spans.push([(tokens[from] as Token).start, (tokens[to] as Token).end]);
          break;
        }
      }
    }
    i = last;
  }
  return spans;
}

/** True when the text holds a word from the English or German lists. */
export function isProfane(text: string): boolean {
  return profaneSpans(text).length > 0;
}

/** The text with profanity replaced by `*`, one for each UTF-16 unit, so it never gets longer. */
export function filterText(text: string): string {
  const spans = profaneSpans(text);
  if (spans.length === 0) return text;
  const chars = text.split('');
  for (const [start, end] of spans) {
    for (let i = start; i < end; i++) chars[i] = '*';
  }
  return chars.join('');
}

/** A name the hub accepts: 3–16 characters of `A-Z a-z 0-9 _ -`, and nothing profane. */
export function validName(name: string): boolean {
  return NAME_RE.test(name) && !isProfane(name);
}
