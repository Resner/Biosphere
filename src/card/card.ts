// What a creature card says (M9 T12): its facts, its story told from its records, the verdict line
// and the details, all from a proof bundle and the verifier's report. Pure and DOM-free, so the
// lines are unit-tested; `card-view.ts` writes them to the page. No player name appears anywhere:
// the owner shows only as a short fingerprint of their key, in the details.

import { DEATH_TEXT, livedText } from '../game/life-text';
import { parseGenomeText } from '../genome/codec';
import { speciesName } from '../genome/names';
import { type RarityTier, rarityOf } from '../genome/rarity';
import type { ProofBundle } from '../ledger/proof';
import type { StoredRecord } from '../ledger/record';
import { type Family, type LineageReport, type Problem, problemText } from '../ledger/verify';
import type { DeathCause } from '../sim/types';

/** Where a creature is, as its chain leaves it. */
export type CardStatus = 'active' | 'checkpoint' | 'pending' | 'dead';

export interface CardFacts {
  subject: string;
  species: string;
  tier: RarityTier;
  generation: number;
  status: CardStatus;
  /** The subject's genome text, which the card draws. */
  genome: string;
  /** The owner's key, shortened: the details show it, nothing else does. */
  owner: string;
  story: string[];
}

/** How long a fingerprint of the owner's key is. */
export const OWNER_PRINT = 8;

const creatureOf = (s: StoredRecord): string => s.record.creature || s.hash;

/** The subject's records in `seq` order. */
function chainOf(bundle: ProofBundle, id: string): StoredRecord[] {
  return bundle.records
    .filter((s) => creatureOf(s) === id)
    .sort((a, b) => a.record.seq - b.record.seq);
}

/** A held creature's species, or a plain stand-in for one outside the proof. */
export function speciesOf(bundle: ProofBundle, id: string): string | null {
  const text = bundle.creatures.find((c) => c.id === id)?.genome;
  const genome = text ? parseGenomeText(text) : null;
  return genome ? speciesName(genome) : null;
}

/** Where a chain leaves its creature, by the kinds of its records (ADR 0021). */
export function statusOf(chain: readonly StoredRecord[]): CardStatus {
  let status: CardStatus = 'active';
  for (const { record } of chain) {
    if (record.kind === 'genesis' || record.kind === 'restore') status = 'active';
    else if (record.kind === 'birth') status = 'pending';
    else if (record.kind === 'death') status = 'dead';
    else if (record.kind === 'promote')
      status = record.body.role === 'child' ? 'active' : 'checkpoint';
  }
  return status;
}

const int = (v: unknown): number | null => (Number.isSafeInteger(v) ? (v as number) : null);
const times = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;
const count = (n: number): string => (n === 1 ? 'once' : n === 2 ? 'twice' : `${n} times`);

/** The facts the card shows, or null when the bundle's subject has no genome the card can read. */
export function cardFacts(bundle: ProofBundle): CardFacts | null {
  const held = bundle.creatures.find((c) => c.id === bundle.subject);
  const genome = held ? parseGenomeText(held.genome) : null;
  if (!held || !genome) return null;
  const chain = chainOf(bundle, bundle.subject);
  return {
    subject: bundle.subject,
    species: speciesName(genome),
    tier: rarityOf(genome).tier,
    generation: int(chain[0]?.record.body.generation) ?? 0,
    status: statusOf(chain),
    genome: held.genome,
    owner: (chain[0]?.record.owner ?? '').slice(0, OWNER_PRINT),
    story: storyLines(bundle),
  };
}

/** The creature's fights from its records: how many, its kills and the eggs it ate. */
function fightsOf(bundle: ProofBundle, chain: readonly StoredRecord[]) {
  const encs = new Set<string>();
  for (const { record } of chain) {
    const enc = record.body.enc;
    if (typeof enc === 'string' && (record.kind === 'encounter' || record.kind === 'death'))
      encs.add(enc);
  }
  let kills = 0;
  let eggs = 0;
  for (const enc of encs) {
    const results = bundle.settlements.find((s) => s.settlement.enc === enc)?.settlement.results;
    const slot = results?.findIndex((r) => r.creature === bundle.subject) ?? -1;
    if (!results || slot < 0) continue;
    for (const r of results) {
      if (r.by === slot) kills++;
      if (r.egg === 'eaten' && r.eggBy === slot) eggs++;
    }
  }
  return { fights: encs.size, kills, eggs };
}

/** How the creature began: hatched from a round, or born from one to two parents. */
function originLine(bundle: ProofBundle, first: StoredRecord | undefined): string | null {
  const body = first?.record.body;
  const round = int(body?.round);
  const from = round === null ? '' : ` from drand round ${round}`;
  if (first?.record.kind === 'genesis') return `Hatched${from}, a first-generation cell`;
  if (first?.record.kind !== 'birth') return null;
  const parents = Array.isArray(body?.parents) ? (body.parents as string[]) : [];
  const names = parents.map((p) => speciesOf(bundle, p) ?? 'an ancestor not loaded');
  const to = names.length === 2 ? ` to ${names[0]} and ${names[1]}` : '';
  return `Born${from}${to}`;
}

/** How it ended, or where it is now. */
function endLine(chain: readonly StoredRecord[], status: CardStatus): string {
  const last = chain[chain.length - 1]?.record;
  if (status === 'dead') {
    const cause = last?.body.cause as DeathCause | undefined;
    if (cause === 'killed') return 'Gone: killed in a fight';
    if (cause === 'eaten') return 'Gone: eaten as an egg in a fight';
    const name = cause && cause in DEATH_TEXT ? DEATH_TEXT[cause].name : 'Died';
    return `Gone: ${name.charAt(0).toLowerCase()}${name.slice(1)}`;
  }
  if (status === 'pending') return 'Still an egg, waiting to hatch';
  if (status === 'checkpoint') return 'Frozen, waiting to be brought back';
  return 'Alive and swimming';
}

/**
 * The creature's story from its own records: how it began, its matings and children, its fights
 * and kills, the time it lived, and how it ended or where it is now.
 */
export function storyLines(bundle: ProofBundle): string[] {
  const chain = chainOf(bundle, bundle.subject);
  const status = statusOf(chain);
  const lines: string[] = [];
  const origin = originLine(bundle, chain[0]);
  if (origin) lines.push(origin);
  if (chain.some((s) => s.record.kind === 'promote' && s.record.body.role === 'child'))
    lines.push('Hatched from its egg when its parent passed its life on');
  const matings = chain.filter((s) => s.record.kind === 'mate-commit').length;
  if (matings > 0) lines.push(`Mated ${count(matings)}`);
  const children = chain.filter(
    (s) => s.record.kind === 'promote' && s.record.body.role === 'parent',
  ).length;
  if (children > 0) lines.push(`Passed its life on to its child ${count(children)}`);
  const restores = chain.filter((s) => s.record.kind === 'restore').length;
  if (restores > 0) lines.push(`Brought back after its successor died ${count(restores)}`);
  const { fights, kills, eggs } = fightsOf(bundle, chain);
  if (fights > 0) {
    const won = [
      kills > 0 ? times(kills, 'kill') : '',
      eggs > 0 ? `${times(eggs, 'egg')} eaten` : '',
    ]
      .filter(Boolean)
      .join(', ');
    lines.push(`Fought ${count(fights)}${won ? `: ${won}` : ''}`);
  }
  let lived = 0;
  for (const { record } of chain) lived = Math.max(lived, int(record.body.activeMs) ?? 0);
  if (status !== 'pending' || lived > 0)
    lines.push(
      status === 'active' ? `Has lived ${livedText(lived)} so far` : `Lived ${livedText(lived)}`,
    );
  lines.push(endLine(chain, status));
  return lines;
}

/** What the card says before the details: the verdict in one line. */
export function verdictLine(report: LineageReport): string {
  const first = report.problems[0];
  if (first) return `Not verified: ${problemText(first)}`;
  const reach = report.toGenesis
    ? 'Verified back to genesis'
    : report.generations > 0
      ? `Verified ${times(report.generations, 'generation')} back`
      : 'Verified, but not back to its parents';
  return report.scaled ? `${reach} · a test world with shortened clocks` : reach;
}

const FAMILIES: readonly (readonly [Family, string, string])[] = [
  ['chain', 'Chains', 'every record follows on from the one before it'],
  ['signature', 'Signatures', "every record carries the authority's signature, under a key in use"],
  ['origin', 'Origins', 'every hatch and birth was recomputed from drand and both parents'],
  ['gates', 'Time, costs and growth', 'every life kept to the clock and the rules'],
  ['fights', 'Fights', 'every fight agrees with its signed result'],
];

/** Each family's result in plain words, then what was not checked. */
export function familyLines(report: LineageReport): string[] {
  const lines = FAMILIES.map(([family, name, holds]) => {
    const n = report.problems.filter((p) => p.family === family).length;
    return n === 0 ? `${name}: ${holds}.` : `${name}: ${times(n, 'problem')}.`;
  });
  const f = report.fights;
  if (f.settled > 0) {
    const parts = [`${times(f.settled, 'fight')} settled`, `${f.replayed} replayed`];
    if (f.pruned > 0) parts.push(`${f.pruned} pruned, so only the signed result remains`);
    if (f.unreplayed > 0) parts.push(`${f.unreplayed} not replayed`);
    lines.push(`Fight replays: ${parts.join(', ')}.`);
  }
  lines.push(`${times(report.held, 'creature')} checked.`);
  if (report.missing.length > 0)
    lines.push(`${times(report.missing.length, 'ancestor')} not loaded, so not checked.`);
  if (report.unchecked.length > 0)
    lines.push(
      `${times(report.unchecked.length, 'birth')} not recomputed: a parent is not loaded.`,
    );
  if (report.scaled) lines.push('A test world: lives and matings run on shortened clocks.');
  return lines;
}

/** Every problem as a plain sentence, with the creature (by species) and the record it is on. */
export function problemLines(bundle: ProofBundle, problems: readonly Problem[]): string[] {
  return problems.map((p) => {
    const who = speciesOf(bundle, p.creature) ?? 'a creature outside the proof';
    const where = p.seq === null ? '' : `, record ${p.seq + 1}`;
    return `${problemText(p)} (${who}${where})`;
  });
}
