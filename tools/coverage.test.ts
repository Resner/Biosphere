import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// The brief, line by line (M14 T17): `docs/COVERAGE.md` has a row for every requirement of the
// roadmap's Brief coverage table, each with a status and evidence that exists. The checks are pure
// functions of the page text so that the tests below can show each failure.

const root = new URL('..', import.meta.url).pathname;
const read = (path: string): string => readFileSync(join(root, path), 'utf8');

type Row = { req: string; claim: string; status: string; evidence: string };

const STATUSES = ['met', 'met, owner check remains', 'after 1.0'];

/** A table's data rows, as cells; `|` inside a backtick span is not a separator in these pages. */
const tableRows = (text: string): string[][] =>
  text
    .split('\n')
    .filter((l) => l.startsWith('|'))
    .slice(2)
    .map((l) =>
      l
        .trim()
        .replace(/^\||\|$/g, '')
        .split('|')
        .map((c) => c.trim()),
    );

/** The roadmap's requirements, in order, without its section rows. */
function roadmapRequirements(roadmap: string): string[] {
  const table = roadmap.split('## Brief coverage')[1] ?? '';
  return tableRows(table)
    .map((c) => c[0] ?? '')
    .filter((r) => r && !r.startsWith('**'));
}

/** The coverage rows; a `″` repeats the requirement above. */
function coverageRows(page: string): Row[] {
  const rows: Row[] = [];
  let req = '';
  for (const c of tableRows(page)) {
    const [r = '', claim = '', status = '', evidence = ''] = c;
    if (r.startsWith('**')) continue;
    if (r !== '″') req = r;
    rows.push({ req, claim, status, evidence });
  }
  return rows;
}

const norm = (s: string): string => s.replace(/[’‘]/g, "'");

/** Everything wrong with the page, one sentence each. */
function problems(
  page: string,
  roadmap: string,
  has: (path: string) => boolean,
  contains: (path: string, title: string) => boolean,
  adrs: (n: string) => boolean,
): string[] {
  const out: string[] = [];
  const rows = coverageRows(page);
  for (const req of roadmapRequirements(roadmap)) {
    if (!rows.some((r) => r.req === req)) out.push(`no row for: ${req}`);
  }
  for (const r of rows) {
    const at = `${r.req.slice(0, 40)} / ${r.claim.slice(0, 40)}`;
    if (!STATUSES.includes(r.status)) {
      out.push(`${at}: unknown status "${r.status}"`);
      continue;
    }
    if (r.status === 'after 1.0' && !/mobile/i.test(r.claim)) {
      out.push(`${at}: only what the brief puts after 1.0 (mobile) may wait`);
    }
    const spans = [...r.evidence.matchAll(/`([^`]+)`/g)].map((m) => m[1] as string);
    const named = [...r.evidence.matchAll(/ADR (\d{4})/g)].map((m) => m[1] as string);
    if (r.status === 'met' && spans.length + named.length === 0) {
      out.push(`${at}: met with no evidence`);
    }
    if (r.status === 'met, owner check remains') {
      if (!/Playtest/.test(r.evidence) && !/owner/.test(r.evidence)) {
        out.push(`${at}: owner check remains but names no owner check`);
      }
      if (spans.length === 0) out.push(`${at}: owner check remains with no automated evidence`);
    }
    for (const span of spans) {
      const [path = '', title] = span.split('::');
      if (!/^[\w./-]+\.\w+$/.test(path) || !has(path)) {
        out.push(`${at}: no such file: ${path}`);
      } else if (title !== undefined && !contains(path, title)) {
        out.push(`${at}: no test titled "${title}" in ${path}`);
      }
    }
    for (const n of named) if (!adrs(n)) out.push(`${at}: no ADR ${n}`);
  }
  return out;
}

const roadmapText = read('docs/ROADMAP.md');
const page = read('docs/COVERAGE.md');
const has = (path: string): boolean => existsSync(join(root, path));
const contains = (path: string, title: string): boolean => norm(read(path)).includes(norm(title));
const adrs = (n: string): boolean =>
  readdirSync(join(root, 'docs/decisions')).some((f) => f.startsWith(`${n}-`));

describe('docs/COVERAGE.md', () => {
  it('holds every row of the roadmap, and every row has existing evidence', () => {
    expect(problems(page, roadmapText, has, contains, adrs)).toEqual([]);
  });

  it('has a row for every roadmap requirement', () => {
    expect(roadmapRequirements(roadmapText).length).toBeGreaterThan(40);
  });

  it('is linked from the roadmap', () => {
    expect(roadmapText).toContain('COVERAGE.md');
  });

  it('is judged by pure checks that name each failure', () => {
    const map =
      '## Brief coverage\n\n| Req | M |\n|---|---|\n| **G** | |\n| Alpha | M1 |\n| Beta | M2 |\n';
    const head = '| Req | Claim | Status | Evidence |\n|---|---|---|---|\n';
    const yes = () => true;
    const none = () => false;
    const good = `${head}| Alpha | a | met | \`x/y.ts::t\` |\n| Beta | b | met | ADR 0001 |\n`;
    expect(problems(good, map, yes, yes, yes)).toEqual([]);
    // a requirement without a row
    expect(problems(`${head}| Alpha | a | met | \`x.ts\` |\n`, map, yes, yes, yes)).toEqual([
      'no row for: Beta',
    ]);
    // an evidence path that does not exist, and a title not in the file
    expect(problems(good, map, none, yes, yes).join('\n')).toContain('no such file: x/y.ts');
    expect(problems(good, map, yes, none, yes).join('\n')).toContain('no test titled "t"');
    expect(problems(good, map, yes, yes, none).join('\n')).toContain('no ADR 0001');
    // met with no evidence
    expect(
      problems(
        `${head}| Alpha | a | met | nothing |\n| Beta | b | met | ADR 0001 |\n`,
        map,
        yes,
        yes,
        yes,
      ).join('\n'),
    ).toContain('met with no evidence');
    // after 1.0 for anything but mobile
    expect(
      problems(
        `${head}| Alpha | a | after 1.0 | x |\n| Beta | b | met | ADR 0001 |\n`,
        map,
        yes,
        yes,
        yes,
      ).join('\n'),
    ).toContain('only what the brief puts after 1.0');
    // a repeated requirement and a section row
    const split = `${head}| **G** | | | |\n| Alpha | a | met | \`x.ts\` |\n| ″ | a2 | after 1.0 | mobile |\n| Beta | b | met | ADR 0001 |\n`;
    expect(coverageRows(split).map((r) => r.req)).toEqual(['Alpha', 'Alpha', 'Beta']);
    // an unknown status
    expect(
      problems(
        `${head}| Alpha | a | maybe | \`x.ts\` |\n| Beta | b | met | ADR 0001 |\n`,
        map,
        yes,
        yes,
        yes,
      ).join('\n'),
    ).toContain('unknown status');
  });
});

// The brief's two rules that need no feature to check, only the shipped sources (the gaps T17 found).

const sourceFiles = (dir: string, keep: (name: string) => boolean): string[] => {
  const out: string[] = [];
  const walk = (at: string) => {
    for (const name of readdirSync(join(root, at))) {
      const path = `${at}/${name}`;
      if (statSync(join(root, path)).isDirectory()) {
        if (name !== 'node_modules' && !name.startsWith('.wrangler') && name !== '__golden__') {
          walk(path);
        }
      } else if (keep(name)) out.push(path);
    }
  };
  walk(dir);
  return out;
};

const shipped = (name: string): boolean =>
  /\.(ts|mjs|html|css)$/.test(name) && !name.includes('.test.');

describe('the brief rules the shipped sources show', () => {
  it('names no Spore or EA product, asset or trademark', () => {
    const files = [
      ...sourceFiles('src', shipped),
      ...sourceFiles('worker', shipped),
      ...['index.html', 'lab.html', 'card.html'].filter(has),
    ];
    expect(files.length).toBeGreaterThan(100);
    const hits = files.filter((f) =>
      /\bspore\b|electronic arts|\bmaxis\b|\bEA Games\b/i.test(read(f)),
    );
    expect(hits).toEqual([]);
  });

  it('uses no blockchain or cryptocurrency package', () => {
    const pkg = JSON.parse(read('package.json')) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const names = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies });
    const chain = /ethers|web3|viem|solana|bitcoin|hardhat|wagmi|metamask|ipfs|nft/i;
    expect(names.filter((n) => chain.test(n))).toEqual([]);
  });

  it('ships no headless client, recording or simulated population', () => {
    // The live world has no NPCs: nothing the pages or the Worker ship reaches the test harnesses or
    // the load tools (`tests/`, `tools/`), which hold the headless clients. The walk follows every
    // relative import from the pages' entries and the Worker's.
    const seen = new Set<string>();
    const todo = ['src/main.ts', 'src/lab/main.ts', 'src/card/main.ts', 'worker/index.ts'];
    const spec = /(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/g;
    while (todo.length > 0) {
      const file = todo.pop() as string;
      if (seen.has(file)) continue;
      seen.add(file);
      for (const m of read(file).matchAll(spec)) {
        const target = (m[1] as string).replace(/\?.*$/, '');
        if (!target.startsWith('.') && !target.startsWith('/src/')) continue;
        const base = target.startsWith('/') ? target.slice(1) : join(file, '..', target);
        const hit = [base, `${base}.ts`, `${base}/index.ts`].find((c) => /\.ts$/.test(c) && has(c));
        if (hit) todo.push(hit.replace(/^\.\//, ''));
      }
    }
    expect(seen.size).toBeGreaterThan(100);
    expect([...seen].filter((f) => /^(tests|tools)\//.test(f))).toEqual([]);
  });
});
