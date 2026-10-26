import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';

// Canonical JSON for records (ADR 0009): RFC 8785 restricted to integers and strings, so there
// is no number formatting to get wrong. No DOM, no Node-only APIs.

export type Canonical =
  | string
  | number
  | readonly Canonical[]
  | { readonly [key: string]: Canonical };

const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;

/** The RFC 8785 text of `value`; throws RangeError for anything but safe integers and strings. */
export function canonicalize(value: Canonical): string {
  switch (typeof value) {
    case 'string':
      return quote(value);
    case 'number':
      if (!Number.isSafeInteger(value) || Object.is(value, -0)) {
        throw new RangeError(`not a canonical integer: ${String(value)}`);
      }
      return String(value);
    case 'object': {
      if (value === null) break;
      if (Array.isArray(value)) {
        // `map` skips holes, which would silently drop them from the text.
        if (Object.keys(value).length !== value.length) throw new RangeError('sparse array');
        return `[${value.map(canonicalize).join(',')}]`;
      }
      const proto = Object.getPrototypeOf(value);
      if (proto !== Object.prototype && proto !== null) throw new RangeError('not a plain object');
      const object = value as { readonly [key: string]: Canonical };
      // Default sort compares UTF-16 code units, which is the order RFC 8785 asks for.
      const members = Object.keys(object)
        .sort()
        .map((key) => `${quote(key)}:${canonicalize(object[key] as Canonical)}`);
      return `{${members.join(',')}}`;
    }
  }
  throw new RangeError(`not canonical: ${String(value)}`);
}

function quote(text: string): string {
  if (LONE_SURROGATE.test(text)) throw new RangeError('lone surrogate in string');
  // JSON.stringify escapes exactly what RFC 8785 lists, with lower-case \u00xx.
  return JSON.stringify(text);
}

/** Hex SHA-256 of `domain`, a newline and the UTF-8 text. */
export function hashWithDomain(domain: string, text: string): string {
  return bytesToHex(sha256(new TextEncoder().encode(`${domain}\n${text}`)));
}
