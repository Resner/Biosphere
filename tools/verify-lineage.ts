import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { parseGenomeText } from '../src/genome/codec';
import { speciesName } from '../src/genome/names';
import {
  type AuthorityKey,
  type FightProof,
  type ProofBundle,
  parseFightProof,
  parseProofBundle,
} from '../src/ledger/proof';
import { HEX64 } from '../src/ledger/record';
import type { FightLog } from '../src/ledger/settlement';
import { type LineageReport, type Problem, problemText, verifyLineage } from '../src/ledger/verify';
import { verifyEncounter } from '../src/net/encounter-verify';

// The command-line verifier (M9 T11, ADR 0055): `npm run verify:lineage -- <creature id | bundle.json>`
// checks a creature's lineage with `verifyLineage`, trusting the authority only for its keys. This
// file is the logic, with its input and output passed in; `tools/lineage.mjs` loads it through Vite.

const USAGE = `Usage: npm run verify:lineage -- <creature id | bundle.json> [options]
  --hub <url>    the authority to fetch from (default $AUTHORITY_URL)
  --replay       fetch (or read) each settled fight's log and replay it
  --keys <file>  check against these authority keys instead of the bundle's
  --save <dir>   write the bundle, fight logs and keys for offline checks
  --json         print the report as JSON
Exit codes: 0 verified, 1 a problem, 2 nothing to verify.`;

/** What the command touches outside itself, so tests run it on files and a fake `fetch`. */
export interface Io {
  fetch: typeof fetch;
  readFile: (path: string) => Promise<string>;
  writeFile: (path: string, text: string) => Promise<void>;
  env: Record<string, string | undefined>;
}

export const nodeIo = (env: Record<string, string | undefined> = process.env): Io => ({
  fetch: (input, init) => fetch(input, init),
  readFile: (path) => readFile(path, 'utf8'),
  writeFile: async (path, text) => {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, text);
  },
  env,
});

export interface Outcome {
  code: 0 | 1 | 2;
  out: string;
}

interface Args {
  target: string;
  hub: string | null;
  replay: boolean;
  keys: string | null;
  save: string | null;
  json: boolean;
}

function parseArgs(argv: readonly string[], env: Io['env']): Args | string {
  const args: Args = {
    target: '',
    hub: env.AUTHORITY_URL?.trim() || null,
    replay: false,
    keys: null,
    save: null,
    json: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    if (a === '--replay') args.replay = true;
    else if (a === '--json') args.json = true;
    else if (a === '--hub' || a === '--keys' || a === '--save') {
      const value = argv[++i];
      if (!value || value.startsWith('--')) return `${a} needs a value.`;
      args[a.slice(2) as 'hub' | 'keys' | 'save'] = value;
    } else if (a.startsWith('--')) return `Unknown option ${a}.`;
    else if (args.target) return 'Give one creature id or bundle file.';
    else args.target = a;
  }
  return args.target ? args : 'Give a creature id or a bundle file.';
}

const stop = (message: string): Outcome => ({ code: 2, out: `Nothing to verify: ${message}\n` });

const hubBase = (hub: string): string => hub.replace(/\/+$/, '');

async function getJson(io: Io, url: string): Promise<{ text: string } | { error: string }> {
  try {
    const res = await io.fetch(url, { signal: AbortSignal.timeout(15_000) });
    if (res.status === 404) return { error: 'the authority has no record of it.' };
    if (res.status === 503) return { error: 'the authority is busy; try again shortly.' };
    if (!res.ok) return { error: `the authority answered ${res.status}.` };
    return { text: await res.text() };
  } catch {
    return { error: `could not reach the authority at ${new URL(url).origin}.` };
  }
}

function keysOf(text: string): AuthorityKey[] | null {
  try {
    const v = JSON.parse(text) as unknown;
    const list = Array.isArray(v) ? v : (v as { keys?: unknown } | null)?.keys;
    if (!Array.isArray(list)) return null;
    const ok = list.every(
      (k) =>
        k &&
        typeof k.id === 'string' &&
        typeof k.publicKey === 'string' &&
        Number.isSafeInteger(k.from),
    );
    return ok
      ? list.map((k) => ({ id: k.id, publicKey: k.publicKey, from: k.from }) as AuthorityKey)
      : null;
  } catch {
    return null;
  }
}

/** Where saved fight logs sit beside a bundle file (`--save`'s layout). */
const fightFile = (bundleFile: string, enc: string): string =>
  join(dirname(bundleFile), 'fights', `${enc}.json`);

/**
 * The logs of every settled fight, by encounter id: fetched from the hub for a creature id, read
 * from beside the bundle for a file. A fight whose log cannot be had is left out (unreplayed); a
 * pruned one is null.
 */
async function logsOf(
  bundle: ProofBundle,
  io: Io,
  hub: string | null,
  bundleFile: string | null,
): Promise<{ logs: Map<string, FightLog | null>; proofs: Map<string, FightProof> }> {
  const logs = new Map<string, FightLog | null>();
  const proofs = new Map<string, FightProof>();
  for (const { settlement } of bundle.settlements) {
    const enc = settlement.enc;
    let text: string | null = null;
    try {
      if (bundleFile) text = await io.readFile(fightFile(bundleFile, enc));
      else if (hub) {
        const got = await getJson(io, `${hubBase(hub)}/v1/fight/${enc}`);
        text = 'text' in got ? got.text : null;
      }
    } catch {
      text = null;
    }
    const proof = text === null ? null : parseFightProof(text);
    if (!proof || proof.settlement.settlement.enc !== enc) continue;
    proofs.set(enc, proof);
    logs.set(enc, proof.log);
  }
  return { logs, proofs };
}

const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

function subjectLine(bundle: ProofBundle): string {
  const genome = bundle.creatures[0]?.genome;
  const g = genome ? parseGenomeText(genome) : null;
  const first = bundle.records.find((s) => (s.record.creature || s.hash) === bundle.subject);
  const generation = first?.record.body.generation;
  return [g ? speciesName(g) : 'unknown creature', `generation ${generation ?? '?'}`].join(', ');
}

function nameOf(bundle: ProofBundle, id: string): string {
  const genome = bundle.creatures.find((c) => c.id === id)?.genome;
  const g = genome ? parseGenomeText(genome) : null;
  return g ? speciesName(g) : 'a creature outside the proof';
}

function problemLine(bundle: ProofBundle, p: Problem): string {
  const where = p.seq === null ? '' : `, record ${p.seq}`;
  return `  - ${problemText(p)} (${nameOf(bundle, p.creature)}${where})`;
}

/** The report in words: the verdict first, then problems, then what was not checked. */
export function formatReport(bundle: ProofBundle, r: LineageReport): string {
  const lines: string[] = [];
  const fights = r.fights;
  if (r.problems.length > 0) {
    lines.push(
      `Not verified: ${plural(r.problems.length, 'problem')} found in the history of ${subjectLine(bundle)}`,
    );
    const shown = r.problems.slice(0, 8);
    lines.push('', 'Problems:', ...shown.map((p) => problemLine(bundle, p)));
    if (r.problems.length > shown.length)
      lines.push(`  …and ${r.problems.length - shown.length} more (use --json for all)`);
  } else {
    const counts = `${subjectLine(bundle)}, ${plural(r.held, 'creature')}, ${plural(fights.replayed, 'fight')} replayed`;
    lines.push(
      r.toGenesis
        ? `Verified back to genesis: ${counts}`
        : `No problems found, but not traced back to genesis: ${counts}`,
    );
  }
  const unchecked: string[] = [];
  if (r.missing.length > 0)
    unchecked.push(
      `${plural(r.missing.length, 'ancestor')} left out of the proof, so ${r.missing.length === 1 ? 'it was' : 'they were'} not checked`,
    );
  if (r.unchecked.length > 0)
    unchecked.push(
      `${plural(r.unchecked.length, 'birth')} not recomputed, because a parent is not in the proof`,
    );
  if (fights.unreplayed > 0)
    unchecked.push(
      `${plural(fights.unreplayed, 'fight')} could not be replayed (no log; use --replay)`,
    );
  if (fights.pruned > 0)
    unchecked.push(`${plural(fights.pruned, 'fight')} pruned: only the signed settlement remains`);
  if (r.scaled) unchecked.push('this is a test world, with shortened lives and matings');
  unchecked.push(
    r.keys === 'pinned'
      ? 'the authority keys you pinned were used'
      : "the authority's keys came from the proof itself (pin them with --keys)",
  );
  unchecked.push('who plays a creature, and whether two players colluded');
  lines.push('', 'Not checked:', ...unchecked.map((u) => `  - ${u}`));
  return `${lines.join('\n')}\n`;
}

/** Runs the command. Never throws: every failure is an exit code and a sentence. */
export async function runVerify(argv: readonly string[], io: Io): Promise<Outcome> {
  const args = parseArgs(argv, io.env);
  if (typeof args === 'string') return { code: 2, out: `${args}\n${USAGE}\n` };

  let pinned: AuthorityKey[] | undefined;
  if (args.keys) {
    let text: string;
    try {
      text = await io.readFile(args.keys);
    } catch {
      return stop(`the keys file ${args.keys} could not be read.`);
    }
    const keys = keysOf(text);
    if (!keys) return stop(`the keys file ${args.keys} holds no authority keys.`);
    pinned = keys;
  }

  let text: string;
  let bundleFile: string | null = null;
  if (HEX64.test(args.target)) {
    if (!args.hub) return stop('give --hub <url> or set AUTHORITY_URL to fetch a creature.');
    const got = await getJson(io, `${hubBase(args.hub)}/v1/proof/${args.target}`);
    if ('error' in got) return stop(got.error);
    text = got.text;
  } else {
    bundleFile = args.target;
    try {
      text = await io.readFile(bundleFile);
    } catch {
      return stop(`${args.target} is neither a creature id nor a readable file.`);
    }
  }
  const bundle = parseProofBundle(text);
  if (!bundle) return stop('the proof is malformed, or larger than a proof may be.');

  const wantLogs = args.replay || args.save !== null;
  const fights = wantLogs ? await logsOf(bundle, io, args.hub, bundleFile) : null;
  const report = verifyLineage(bundle, {
    ...(pinned ? { keys: pinned } : {}),
    ...(args.replay && fights ? { logs: fights.logs, replay: verifyEncounter } : {}),
  });

  if (args.save) {
    await io.writeFile(join(args.save, 'bundle.json'), `${JSON.stringify(bundle)}\n`);
    await io.writeFile(join(args.save, 'keys.json'), `${JSON.stringify(bundle.keys)}\n`);
    for (const [enc, proof] of fights?.proofs ?? [])
      await io.writeFile(join(args.save, 'fights', `${enc}.json`), `${JSON.stringify(proof)}\n`);
  }

  const code = report.problems.length > 0 ? 1 : 0;
  return {
    code,
    out: args.json ? `${JSON.stringify(report, null, 2)}\n` : formatReport(bundle, report),
  };
}
