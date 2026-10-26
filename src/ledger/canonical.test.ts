import { describe, expect, it } from 'vitest';
import { type Canonical, canonicalize, hashWithDomain } from './canonical';

describe('canonicalize', () => {
  it('sorts keys by UTF-16 code units (the RFC 8785 example)', () => {
    const keys = ['\r', '1', '\u0080', 'ö', '€', '\u{1F600}', 'דּ'];
    const shuffled = [keys[4], keys[6], keys[1], keys[5], keys[0], keys[3], keys[2]] as string[];
    const value: Record<string, Canonical> = {};
    shuffled.forEach((k, i) => {
      value[k] = i;
    });
    // JSON.parse would reorder integer-like keys, so compare the text itself.
    const expected = keys.map((k) => `${JSON.stringify(k)}:${shuffled.indexOf(k)}`).join(',');
    expect(canonicalize(value)).toBe(`{${expected}}`);
  });

  it('escapes exactly the characters the RFC names', () => {
    expect(canonicalize('"\\\b\f\n\r\t')).toBe('"\\"\\\\\\b\\f\\n\\r\\t"');
    expect(canonicalize('\u0000\u001f\u007f')).toBe('"\\u0000\\u001f\u007f"');
    expect(canonicalize('a/b ö €\u{1F600}')).toBe('"a/b ö €\u{1F600}"');
    expect(canonicalize(' ')).toBe('" "');
  });

  it('writes no whitespace and nests arrays and objects', () => {
    expect(canonicalize({ b: [1, { d: 'x', c: [] }, ''], a: {} })).toBe(
      '{"a":{},"b":[1,{"c":[],"d":"x"},""]}',
    );
    expect(canonicalize([0, -5, 9007199254740991, -9007199254740991])).toBe(
      '[0,-5,9007199254740991,-9007199254740991]',
    );
  });

  it('rejects everything that is not an integer or a string', () => {
    const sparse: unknown[] = [1];
    sparse[2] = 3;
    const bad: unknown[] = [
      -0,
      2 ** 53,
      -(2 ** 53),
      1.5,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      true,
      false,
      null,
      undefined,
      10n,
      () => 1,
      { a: undefined },
      new Date(0),
      new Map(),
      sparse,
      { a: 1.25 },
      [null],
    ];
    for (const value of bad) {
      expect(() => canonicalize(value as Canonical), String(value)).toThrow(RangeError);
    }
  });

  it('rejects lone surrogates in strings and keys', () => {
    for (const s of ['\ud800', 'a\udc00b', '\ud83d', '\ude00\ud83d']) {
      expect(() => canonicalize(s)).toThrow(RangeError);
      expect(() => canonicalize({ [s]: 1 })).toThrow(RangeError);
    }
    expect(canonicalize('😀')).toBe('"\u{1F600}"');
  });

  it('does not depend on key insertion order', () => {
    const entries: [string, Canonical][] = [
      ['id', 'abc'],
      ['seq', 7],
      ['body', { z: 1, y: [2, 3], x: 'é' }],
      ['kind', 'checkpoint'],
      ['€', 0],
    ];
    const outputs = new Set<string>();
    let state = 12345;
    for (let i = 0; i < 100; i++) {
      const order = entries.slice();
      for (let j = order.length - 1; j > 0; j--) {
        state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
        const k = state % (j + 1);
        [order[j], order[k]] = [order[k] as [string, Canonical], order[j] as [string, Canonical]];
      }
      outputs.add(canonicalize(Object.fromEntries(order)));
    }
    expect(outputs.size).toBe(1);
  });

  it('keeps a __proto__ key as data', () => {
    const value = JSON.parse('{"__proto__":1,"a":2}') as Canonical;
    expect(canonicalize(value)).toBe('{"__proto__":1,"a":2}');
  });
});

describe('hashWithDomain', () => {
  it('is SHA-256 of the domain, a newline and the UTF-8 text', () => {
    // sha256("bs/test/v1\nhello"), computed independently.
    expect(hashWithDomain('bs/test/v1', 'hello')).toBe(
      'a6aa9faf6b9c8d95dc415ac20d83547c2dc97bfd036733ce9b8c66d3782e0202',
    );
  });

  it('separates domains and texts', () => {
    expect(hashWithDomain('a', 'b')).not.toBe(hashWithDomain('b', 'a'));
    expect(hashWithDomain('a', 'b')).not.toBe(hashWithDomain('a\nb', ''));
    expect(hashWithDomain('a', 'ö')).toMatch(/^[0-9a-f]{64}$/);
  });
});
