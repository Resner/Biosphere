import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { creatureParam } from '../src/card/load';
import { parsePubKeys } from '../src/game/fight-verify';
import { Guide } from '../src/game/guide';
import { hubSocketUrl, loadName, type Store } from '../src/game/online-config';
import { loadBench, loadSettings, qualityFromSearch, worldFromSearch } from '../src/game/settings';
import { MuteList } from '../src/game/social';
import {
  decodeGenome,
  genomeFromBase64url,
  genomeToBase64url,
  parseGenomeText,
} from '../src/genome/codec';
import { starterGenome } from '../src/genome/starter';
import { parseAuthorityKeys, parseFightProof, parseProofBundle } from '../src/ledger/proof';
import { decodeRecoveryCode, encodeRecoveryCode } from '../src/ledger/recovery';
import { parseSignedSeat } from '../src/ledger/seat-doc';
import { parseRefereeSpans } from '../src/ledger/settlement';
import { decodeStateFrame } from '../src/ledger/snapshot-sig';
import { parseDutyEvent, parseSignedAttestation } from '../src/ledger/witness-doc';
import { bodyFromText } from '../src/net/encounter-start';
import { decodeSnapshot, parseClientMsg, parseHubMsg, parsePeerEvent } from '../src/net/protocol';
import {
  genesisAsk,
  mateAsk,
  parseBeacon,
  signedCommit,
  storedRecord,
} from '../src/net/protocol-docs';
import { filterText, isProfane, validName } from '../src/net/text';
import { decodeFrameInput } from '../src/sim/encounter/codec';
import { parseFoodId } from '../src/sim/food';
import { decodeInput } from '../src/sim/input';
import { createRng, type Rng, seedFromString } from '../src/sim/prng';

// Every parser of untrusted input (M14 T16, docs/SECURITY.md "Parsers"): 10,000 fuzzed values
// each, and none throws. Untrusted is anything a player, a peer, the authority's answer, a URL or
// a damaged browser store can hand the code. A new exported `parse…` or `decode…` joins `PARSERS`
// or `NOT_UNTRUSTED` with its reason.

type Kind = 'text' | 'json' | 'bytes' | 'number';

interface Parser {
  /** What hands it the value. */
  from: string;
  kind: Kind;
  run: (value: never) => unknown;
  /** Valid inputs whose mutations reach past the first check. */
  samples?: () => string[];
}

/** A browser store whose every key holds `text`. */
const storeOf = (text: string): Store & Storage =>
  ({
    getItem: () => text,
    setItem: () => {},
    removeItem: () => {},
    clear: () => {},
    key: () => null,
    length: 1,
  }) as Store & Storage;

const genomeText = () => [genomeToBase64url(starterGenome())];
const recoveryText = () => [encodeRecoveryCode(new Uint8Array(32).fill(7))];

const PARSERS: Readonly<Record<string, Parser>> = {
  parseClientMsg: { from: 'hub messages (the authority)', kind: 'text', run: parseClientMsg },
  parseHubMsg: { from: 'hub messages (a page)', kind: 'text', run: parseHubMsg },
  parsePeerEvent: { from: 'peer events', kind: 'text', run: parsePeerEvent },
  decodeSnapshot: { from: 'snapshots', kind: 'bytes', run: decodeSnapshot },
  decodeStateFrame: {
    from: 'snapshots, signed and proxy frames',
    kind: 'bytes',
    run: decodeStateFrame,
  },
  decodeInput: { from: 'a peer’s input code', kind: 'number', run: decodeInput },
  decodeFrameInput: {
    from: 'fight inputs and witness batches',
    kind: 'number',
    run: decodeFrameInput,
  },
  parseFoodId: { from: 'peer claims', kind: 'text', run: parseFoodId },
  bodyFromText: {
    from: 'a fighter’s genome text',
    kind: 'text',
    run: bodyFromText,
    samples: genomeText,
  },
  genomeFromBase64url: {
    from: 'genome text',
    kind: 'text',
    run: genomeFromBase64url,
    samples: genomeText,
  },
  parseGenomeText: {
    from: '?genome= and the Lab’s paste box',
    kind: 'text',
    run: parseGenomeText,
    samples: genomeText,
  },
  decodeGenome: { from: 'genome bytes', kind: 'bytes', run: decodeGenome },
  parseBeacon: { from: 'beacons in hub messages and proofs', kind: 'json', run: parseBeacon },
  genesisAsk: { from: 'genesis asks', kind: 'json', run: genesisAsk },
  mateAsk: { from: 'mate asks', kind: 'json', run: mateAsk },
  signedCommit: { from: 'commitments', kind: 'json', run: signedCommit },
  storedRecord: { from: 'records', kind: 'json', run: storedRecord },
  parseRefereeSpans: { from: 'settlements', kind: 'json', run: parseRefereeSpans },
  parseDutyEvent: { from: 'witness duties', kind: 'json', run: parseDutyEvent },
  parseSignedAttestation: {
    from: 'witness attestations',
    kind: 'json',
    run: parseSignedAttestation,
  },
  parseSignedSeat: { from: 'seat tickets in peer hellos', kind: 'json', run: parseSignedSeat },
  parsePubKeys: { from: 'GET /v1/pubkeys', kind: 'json', run: parsePubKeys },
  parseAuthorityKeys: { from: 'a proof’s keys', kind: 'json', run: parseAuthorityKeys },
  parseProofBundle: { from: 'GET /v1/proof', kind: 'json', run: parseProofBundle },
  parseFightProof: { from: 'GET /v1/fight', kind: 'json', run: parseFightProof },
  creatureParam: {
    from: 'the card’s ?c=',
    kind: 'text',
    run: (s: string) => creatureParam(`?c=${s}`),
  },
  hubSocketUrl: {
    from: '?hub=',
    kind: 'text',
    run: (s: string) => [hubSocketUrl(`?hub=${s}`, ''), hubSocketUrl(s, s)],
    samples: () => ['http://localhost:8790', 'ws://127.0.0.1:1/x', 'https://evil.example'],
  },
  qualityFromSearch: {
    from: '?quality=',
    kind: 'text',
    run: (s: string) => qualityFromSearch(`?quality=${s}`),
  },
  worldFromSearch: {
    from: '?world=',
    kind: 'text',
    run: (s: string) => worldFromSearch(`?world=${s}`),
  },
  decodeRecoveryCode: {
    from: 'the recovery import',
    kind: 'text',
    run: decodeRecoveryCode,
    samples: recoveryText,
  },
  validName: { from: 'names', kind: 'text', run: validName },
  filterText: { from: 'chat', kind: 'text', run: filterText },
  isProfane: { from: 'names and chat', kind: 'text', run: isProfane },
  loadSettings: {
    from: 'a damaged store: bs.settings',
    kind: 'text',
    run: (s: string) => loadSettings(storeOf(s)),
  },
  loadBench: {
    from: 'a damaged store: bs.bench',
    kind: 'text',
    run: (s: string) => loadBench(storeOf(s), 'gpu'),
  },
  loadName: {
    from: 'a damaged store: bs.name',
    kind: 'text',
    run: (s: string) => loadName(storeOf(s), () => 0.5),
  },
  MuteList: {
    from: 'a damaged store: bs.muted',
    kind: 'text',
    run: (s: string) => new MuteList(storeOf(s)),
  },
  Guide: {
    from: 'a damaged store: bs.guide',
    kind: 'text',
    run: (s: string) => new Guide(storeOf(s)),
  },
};

/** Exported parsers and decoders that read nothing untrusted, with why. */
const NOT_UNTRUSTED: Readonly<Record<string, string>> = {
  parseColour: 'reads the colour literals of the game’s own source (cue-channels.test.ts)',
  parseSpecimen: 'reads the gallery’s committed specimen files (the Lab)',
  unpackFrames: 'reads fight logs the authority wrote to its own database',
};

const ALPHABET = '{}[]":,0123456789abcdefABCDEF_-.+=/\\ \n\t%?&#xé€😀\u0000‮<>\'`';
const KEYS = [
  't',
  'v',
  'id',
  'keys',
  'publicKey',
  'kind',
  'round',
  'signature',
  'records',
  'creatures',
  'subject',
  'owner',
  'sig',
  'json',
  '__proto__',
  'constructor',
  'enc',
  'from',
  'to',
  'event',
];

function fuzzText(rng: Rng, samples: readonly string[]): string {
  if (samples.length > 0 && rng.next() < 0.5) {
    const chars = [...(samples[rng.int(0, samples.length - 1)] as string)];
    for (let e = rng.int(1, 4); e > 0; e--) {
      const at = rng.int(0, chars.length);
      const c = ALPHABET[rng.int(0, ALPHABET.length - 1)] as string;
      const op = rng.int(0, 2);
      if (op === 0) chars.splice(at, 1);
      else if (op === 1) chars.splice(at, 0, c);
      else chars[at] = c;
    }
    return chars.join('');
  }
  if (rng.next() < 0.3) return JSON.stringify(fuzzJson(rng, 3));
  let s = '';
  for (let n = rng.int(0, rng.next() < 0.05 ? 3000 : 80); n > 0; n--) {
    s += ALPHABET[rng.int(0, ALPHABET.length - 1)];
  }
  return s;
}

function fuzzNumber(rng: Rng): number {
  const special = [
    0,
    -0,
    1,
    -1,
    NaN,
    Infinity,
    -Infinity,
    2 ** 31,
    2 ** 32,
    2 ** 53,
    -(2 ** 53),
    0.5,
  ];
  if (rng.next() < 0.3) return special[rng.int(0, special.length - 1)] as number;
  return rng.next() < 0.5 ? rng.nextU32() : (rng.next() - 0.5) * 2 ** rng.int(0, 70);
}

function fuzzJson(rng: Rng, depth: number): unknown {
  const pick = rng.int(0, depth > 0 ? 7 : 4);
  if (pick === 0) return null;
  if (pick === 1) return rng.next() < 0.5;
  if (pick === 2) return fuzzNumber(rng);
  if (pick === 3) return fuzzText(rng, []).slice(0, 70);
  if (pick === 4) return 'a'.repeat(rng.int(0, 1) ? 64 : 43);
  if (pick === 5) return Array.from({ length: rng.int(0, 6) }, () => fuzzJson(rng, depth - 1));
  const o: Record<string, unknown> = {};
  for (let n = rng.int(0, 8); n > 0; n--) {
    o[KEYS[rng.int(0, KEYS.length - 1)] as string] = fuzzJson(rng, depth - 1);
  }
  return o;
}

function fuzzBytes(rng: Rng): Uint8Array {
  const sizes = [0, 1, 28, 29, 30, 60, 61, 62, 92, 93, 94, 256];
  const n = rng.next() < 0.5 ? (sizes[rng.int(0, sizes.length - 1)] as number) : rng.int(0, 300);
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) out[i] = rng.int(0, 255);
  return out;
}

const FUZZ_VALUES = 10_000;

describe('every parser of untrusted input', () => {
  it.each(Object.keys(PARSERS))('%s never throws on 10,000 fuzzed values', (name) => {
    const parser = PARSERS[name] as Parser;
    const rng = createRng(seedFromString(`fuzz-${name}`), 'fuzz');
    const samples = parser.samples?.() ?? [];
    const run = parser.run as (v: unknown) => unknown;
    const thrown: string[] = [];
    for (let i = 0; i < FUZZ_VALUES; i++) {
      const value =
        parser.kind === 'text'
          ? fuzzText(rng, samples)
          : parser.kind === 'json'
            ? fuzzJson(rng, 4)
            : parser.kind === 'bytes'
              ? fuzzBytes(rng)
              : fuzzNumber(rng);
      try {
        run(value);
      } catch (error) {
        if (thrown.length < 3) thrown.push(`${JSON.stringify(value)?.slice(0, 120)}: ${error}`);
      }
    }
    expect(thrown).toEqual([]);
  });
});

const ROOT = new URL('..', import.meta.url).pathname;

describe('the parsers’ list', () => {
  it('holds every exported parser and decoder of the shipped code', () => {
    const exported = ['src', 'worker'].flatMap((dir) =>
      readdirSync(join(ROOT, dir), { withFileTypes: true, recursive: true })
        .filter((e) => e.isFile() && e.name.endsWith('.ts') && !/\.test\.ts$|kit\.ts$/.test(e.name))
        .flatMap((e) =>
          [
            ...readFileSync(join(e.parentPath, e.name), 'utf8').matchAll(
              /^export (?:async )?(?:function|const) ((?:parse|decode|unpack)[A-Z]\w*)/gm,
            ),
          ].map((m) => `${m[1]} (${relative(ROOT, join(e.parentPath, e.name))})`),
        ),
    );
    const known = new Set([...Object.keys(PARSERS), ...Object.keys(NOT_UNTRUSTED)]);
    expect(exported.filter((e) => !known.has(e.split(' ')[0] as string))).toEqual([]);
  });

  it('is the one docs/SECURITY.md names', () => {
    const doc = readFileSync(join(ROOT, 'docs/SECURITY.md'), 'utf8');
    const start = doc.indexOf('## Parsers');
    expect(start).toBeGreaterThan(0);
    const section = doc.slice(start, doc.indexOf('\n## ', start + 1));
    const named = [...section.matchAll(/^\| `(\w+)`/gm)].map((m) => m[1]).sort();
    expect(named).toEqual(Object.keys(PARSERS).sort());
  });
});
