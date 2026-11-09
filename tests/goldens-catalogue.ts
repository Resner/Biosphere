import { readdirSync, readFileSync } from 'node:fs';
import { decodeGenome, encodeGenome, type Genome, genomeToBase64url } from '../src/genome/codec';
import {
  GENOME_BYTES,
  HAPLOTYPE_BYTES,
  LOCI,
  MODULE_BYTES,
  MODULE_PARAMS,
} from '../src/genome/karyotype';
import { starterGenome } from '../src/genome/starter';
import { entryHash } from '../src/ledger/frozen';
import { createRng, seedFromString } from '../src/sim/prng';
import { ARCHETYPES, buildBytes, locus, withAlleles } from './archetypes';

// The golden catalogue (M14 T5, `docs/TESTING.md`): every file under `src/*/__golden__/` is either
// recomputed by a set in the page (`m14-goldens.spec.ts`, in each engine) or listed in `NODE_ONLY`
// with its reason. A set has the input the page is given, and the output the golden pins. A new
// golden file joins one or the other, or `goldens-catalogue.test.ts` fails.

const ROOT = new URL('../', import.meta.url);

/** A golden file's path relative to the repository, like `src/sim/__golden__/math.json`. */
export type GoldenPath = string;

export interface GoldenSet {
  /** The set's name in `src/game/goldens.ts`. */
  name: string;
  /** The files the set recomputes. */
  files: GoldenPath[];
  /** What the page is given (JSON). */
  input(): unknown;
  /** What the page must return, from the files (JSON). */
  expected(): unknown;
}

/** Golden files no page recomputes, each with the reason. */
export const NODE_ONLY: Record<GoldenPath, string> = {
  'src/genome/__golden__/tournament.json':
    "the ranking and hash of a tournament over the archetypes' simulated lives: a report summary of minutes of play, whose parts (development, stats, the sim) the other sets already recompute",
};

const sim = (n: string): GoldenPath => `src/sim/__golden__/${n}.json`;
const genome = (n: string): GoldenPath => `src/genome/__golden__/${n}.json`;
const ledger = (n: string): GoldenPath => `src/ledger/__golden__/${n}.json`;

interface Golden {
  [key: string]: unknown;
  log?: unknown;
  hash?: string;
  events?: unknown;
  results?: unknown;
  vectors?: Record<string, { genome: string; hash: string }>;
  hashes?: unknown;
  short?: Record<string, string>;
  rarity?: unknown;
  sentences?: unknown;
  table?: { seed: string; from: number; activeMs: number }[];
  subject?: unknown;
  keys?: unknown;
  fights?: Record<string, { settlement: unknown; records: { record: unknown; hash: string }[] }>;
}

const read = (path: GoldenPath): Golden => JSON.parse(readFileSync(new URL(path, ROOT), 'utf8'));
const hex = (bytes: Uint8Array): string => Buffer.from(bytes).toString('hex');

/** Every golden file in the repository. */
export function goldenFiles(): GoldenPath[] {
  const out: GoldenPath[] = [];
  for (const dir of readdirSync(new URL('src/', ROOT), { withFileTypes: true })) {
    if (!dir.isDirectory()) continue;
    const golden = new URL(`src/${dir.name}/__golden__/`, ROOT);
    let names: string[] = [];
    try {
      names = readdirSync(golden);
    } catch {
      continue;
    }
    for (const n of names) out.push(`src/${dir.name}/__golden__/${n}`);
  }
  return out.sort();
}

const REPLAYS = ['body-forage', 'forage-route', 'hazard-dash', 'idle-starve', 'mate', 'old-age'];
const ENCOUNTERS = ['approach', 'autopilot', 'duel', 'egg', 'escape', 'join', 'plume'].map(
  (n) => `encounter-${n}`,
);

const randomBytes = (seed: string, length: number): Uint8Array => {
  const r = createRng(seedFromString(seed), 'bytes');
  return Uint8Array.from({ length }, () => r.nextU32() & 0xff);
};

const moduleIds = LOCI.filter((l) => l.kind === 'module').map((l) => l.id);
const allModules = (value: number) =>
  Object.fromEntries(
    moduleIds.map((id) => [id, Object.fromEntries(MODULE_PARAMS.map((p) => [p, value]))]),
  );

const developInputs = (): Record<string, string> => {
  const inputs: Record<string, Uint8Array> = {
    zero: new Uint8Array(GENOME_BYTES),
    ones: new Uint8Array(GENOME_BYTES).fill(0xff),
    alternating: Uint8Array.from({ length: GENOME_BYTES }, (_, i) => (i % 2 ? 0xff : 0)),
    modulesZero: buildBytes(allModules(0)),
    modulesFull: buildBytes(allModules(255)),
    eightSegmentsModulesFull: buildBytes(allModules(255), { segDrive1: 255, segDrive2: 255 }),
  };
  const r = createRng(seedFromString('genome-develop-golden'), 'bytes');
  for (let i = 0; i < 14; i++) {
    inputs[`random${i}`] = Uint8Array.from({ length: GENOME_BYTES }, () => r.nextU32() & 0xff);
  }
  return Object.fromEntries(Object.entries(inputs).map(([k, b]) => [k, hex(b)]));
};

/** zero, counter and seeded random bytes at one length. */
const threeInputs = (length: number): Record<string, Uint8Array> => ({
  zero: new Uint8Array(length),
  counter: Uint8Array.from({ length }, (_, i) => i & 0xff),
  random: randomBytes('genome-golden', length),
});

const withModule = (base: Genome, id: string): Genome => {
  const bytes = encodeGenome(base);
  for (let hap = 0; hap < 2; hap++) {
    const o = hap * HAPLOTYPE_BYTES + locus(id).offset;
    bytes[o] = 1;
    bytes[o + 1] = 100;
    bytes[o + 2] = 40;
    bytes[o + MODULE_BYTES - 1] = 0;
  }
  return decodeGenome(bytes);
};

const rarityInputs = (): Record<string, string> => {
  const plain = withAlleles(starterGenome(), {
    pattern: [0, 0],
    iridescence: [0, 0],
    albino: [0, 0],
    luminescence: [0, 0],
    texture: [0, 0],
  });
  const fixed: Record<string, Genome> = {
    starter: starterGenome(),
    plain,
    glowStripes: withAlleles(plain, { luminescence: [1, 1], pattern: [3, 0] }),
    iridescentAlbinoStriped: withAlleles(plain, {
      iridescence: [1, 1],
      albino: [1, 1],
      pattern: [3, 3],
    }),
    mutantBig: withAlleles(withModule(plain, 'M6'), { size1: [255, 255], texture: [2, 2] }),
  };
  return Object.fromEntries(Object.entries(fixed).map(([k, g]) => [k, genomeToBase64url(g)]));
};

const byName = <T>(names: string[], load: (n: string) => T): Record<string, T> =>
  Object.fromEntries(names.map((n) => [n, load(n)]));

export const SETS: GoldenSet[] = [
  {
    name: 'math',
    files: [sim('math')],
    input: () =>
      Object.fromEntries(
        Object.entries(read(sim('math')) as unknown as Record<string, string[][]>).map(
          ([fn, rows]) => [fn, rows.map((row) => row.slice(0, -1))],
        ),
      ),
    expected: () =>
      Object.fromEntries(
        Object.entries(read(sim('math')) as unknown as Record<string, string[][]>).map(
          ([fn, rows]) => [fn, rows.map((row) => row[row.length - 1])],
        ),
      ),
  },
  {
    name: 'replay',
    files: REPLAYS.map(sim),
    input: () => byName(REPLAYS, (n) => read(sim(n)).log),
    expected: () =>
      byName(REPLAYS, (n) => {
        const { hash, events } = read(sim(n));
        return { hash, events };
      }),
  },
  {
    name: 'encounter',
    files: ENCOUNTERS.map(sim),
    input: () => byName(ENCOUNTERS, (n) => read(sim(n)).log),
    expected: () =>
      byName(ENCOUNTERS, (n) => {
        const { hash, results } = read(sim(n));
        return { hash, results };
      }),
  },
  {
    name: 'develop',
    files: [genome('develop')],
    input: developInputs,
    expected: () => read(genome('develop')).vectors,
  },
  {
    name: 'express',
    files: [genome('express')],
    input: () =>
      byName(['zero', 'counter', 'random'], (n) => hex(threeInputs(GENOME_BYTES)[n] as Uint8Array)),
    expected: () => read(genome('express')).vectors,
  },
  {
    name: 'stats',
    files: [genome('stats')],
    input: () =>
      Object.fromEntries(
        Object.entries(read(genome('stats')).vectors ?? {}).map(([k, v]) => [k, v.genome]),
      ),
    expected: () => read(genome('stats')).vectors,
  },
  {
    name: 'genesis',
    files: [genome('genesis')],
    input: () => ['alpha', 'beta', 'gamma'],
    expected: () => read(genome('genesis')).hashes,
  },
  {
    name: 'genome-hash',
    files: [genome('genome-hash')],
    input: () => ({
      ...Object.fromEntries(Object.entries(threeInputs(GENOME_BYTES)).map(([k, b]) => [k, hex(b)])),
      ...Object.fromEntries(
        Object.entries(threeInputs(328)).map(([k, b]) => [`short-${k}`, hex(b)]),
      ),
    }),
    expected: () => {
      const g = read(genome('genome-hash'));
      return {
        ...Object.fromEntries(Object.entries(g.vectors ?? {}).map(([k, v]) => [k, v.hash])),
        ...Object.fromEntries(Object.entries(g.short ?? {}).map(([k, h]) => [`short-${k}`, h])),
      };
    },
  },
  {
    name: 'inherit',
    files: [genome('inherit')],
    input: () =>
      Object.fromEntries(
        [0, 1, 2].map((i) => [
          `child-${i}`,
          {
            a: `inherit-parent-${i}`,
            b: `inherit-parent-${i + 100}`,
            fill: i,
            label: `golden-${i}`,
          },
        ]),
      ),
    expected: () => read(genome('inherit')).hashes,
  },
  {
    name: 'offspring',
    files: [genome('offspring')],
    input: () => ({
      beacons: JSON.parse(readFileSync(new URL('tests/fixtures/drand/rounds.json', ROOT), 'utf8'))
        .beacons,
      rounds: [1, 2, 3],
      pairs: [0, 1],
    }),
    expected: () => read(genome('offspring')).vectors,
  },
  {
    name: 'rarity',
    files: [genome('rarity')],
    input: rarityInputs,
    expected: () => read(genome('rarity')).rarity,
  },
  {
    name: 'describe',
    files: [genome('describe')],
    input: () =>
      Object.fromEntries(
        [
          ['starter', starterGenome()],
          ['armoured', ARCHETYPES.armoured as Genome],
          ['hunter', ARCHETYPES.hunter as Genome],
        ].map(([k, g]) => [k as string, genomeToBase64url(g as Genome)]),
      ),
    expected: () => read(genome('describe')).sentences,
  },
  {
    name: 'records',
    files: [ledger('records')],
    input: () => {
      const { rulesVersion: _unused, ...rest } = read(ledger('records'));
      return Object.fromEntries(
        Object.entries(rest).map(([k, v]) => [k, (v as { record: unknown }).record]),
      );
    },
    expected: () => {
      const { rulesVersion: _unused, ...rest } = read(ledger('records'));
      return rest;
    },
  },
  {
    name: 'kinds',
    files: [ledger('kinds')],
    input: () => {
      const { rulesVersion: _unused, ...rest } = read(ledger('kinds'));
      return Object.fromEntries(
        Object.entries(rest).map(([k, v]) => [k, (v as { record: unknown }).record]),
      );
    },
    expected: () => {
      const { rulesVersion: _unused, ...rest } = read(ledger('kinds'));
      return rest;
    },
  },
  {
    name: 'settlement',
    files: [ledger('settlement')],
    input: () => {
      const g = read(ledger('settlement'));
      return {
        keys: g.keys,
        fights: Object.fromEntries(
          Object.entries(g.fights ?? {}).map(([k, f]) => [
            k,
            { settlement: f.settlement, records: f.records },
          ]),
        ),
      };
    },
    expected: () =>
      Object.fromEntries(
        Object.entries(read(ledger('settlement')).fights ?? {}).map(([k, f]) => [
          k,
          { signature: [], records: [], hashes: f.records.map((r) => r.hash) },
        ]),
      ),
  },
  {
    name: 'lineage',
    files: [ledger('lineage')],
    input: () => read(ledger('lineage')),
    expected: () => ({
      problems: [],
      subject: read(ledger('lineage')).subject,
      held: 3,
      missing: [],
      scaled: false,
      keys: 'bundle',
    }),
  },
  {
    name: 'growth-reach',
    files: [ledger('growth-reach')],
    input: () =>
      (
        read(ledger('growth-reach')).table as { seed: string; from: number; activeMs: number }[]
      ).map(({ seed, from, activeMs }) => ({ seed, from, activeMs })),
    expected: () => read(ledger('growth-reach')).table,
  },
  {
    name: 'frozen',
    files: [ledger('frozen')],
    input: () => {
      const manifest = read(ledger('frozen')) as unknown as Record<string, Record<string, string>>;
      const paths = Object.keys(Object.values(manifest).at(-1) ?? {});
      return {
        files: Object.fromEntries(paths.map((p) => [p, readFileSync(new URL(p, ROOT), 'utf8')])),
        entries: manifest,
      };
    },
    expected: () => {
      const manifest = read(ledger('frozen')) as unknown as Record<string, Record<string, string>>;
      const live = Object.values(manifest).at(-1) ?? {};
      return {
        files: live,
        entries: Object.fromEntries(Object.entries(manifest).map(([v, e]) => [v, entryHash(e)])),
      };
    },
  },
];
