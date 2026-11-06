import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { bundleOf, lineageHistory, rewrite } from '../../tests/lineage-fixture';
import { parseGenomeText } from '../genome/codec';
import { speciesName } from '../genome/names';
import { rarityOf } from '../genome/rarity';
import type { ProofBundle } from '../ledger/proof';
import type { FightLog } from '../ledger/settlement';
import { verifyLineage } from '../ledger/verify';
import { verifyEncounter } from '../net/encounter-verify';
import {
  cardFacts,
  familyLines,
  OWNER_PRINT,
  problemLines,
  speciesOf,
  storyLines,
  verdictLine,
} from './card';
import { LineageCheck } from './check';

// M9 T12: the card's words from the golden bundle (A1, which was born to A0 and B0, took over
// from A0, killed B0 and ate B1's egg, then died of a toxin) and from tampered, scaled and
// partial ones.

const GOLDEN = new URL('../ledger/__golden__/lineage.json', import.meta.url);
const golden = (): ProofBundle => JSON.parse(readFileSync(GOLDEN, 'utf8')) as ProofBundle;
const history = lineageHistory();
const { A0, A1, B0, B1 } = history.ids;
const [ENC, LOG] = [...history.logs][0] as [string, FightLog];
const nameOf = (b: ProofBundle, id: string): string => speciesOf(b, id) as string;
/** No line on a card may show a raw code, a field name or a hash. */
const RAW = /[a-z]+:[a-z]|[0-9a-f]{16}|activeMs|biomass|checkpoint|mate-commit|seq\b/;

describe('the facts and the story', () => {
  it('tell the golden subject from its own records', () => {
    const b = golden();
    const facts = cardFacts(b);
    const genome = parseGenomeText(b.creatures[0]?.genome ?? '');
    if (!facts || !genome) throw new Error('the golden has no subject genome');
    expect(facts).toMatchObject({
      subject: A1,
      species: speciesName(genome),
      tier: rarityOf(genome).tier,
      generation: 1,
      status: 'dead',
    });
    expect(facts.owner).toHaveLength(OWNER_PRINT);
    const round = b.records.find((s) => s.hash === A1)?.record.body.round;
    expect(facts.story).toEqual([
      `Born from drand round ${round} to ${nameOf(b, A0)} and ${nameOf(b, B0)}`,
      'Hatched from its egg when its parent passed its life on',
      'Fought once: 1 kill, 1 egg eaten',
      expect.stringMatching(/^Lived \d+ min( \d+ s)?$/),
      'Gone: poisoned',
    ]);
    for (const line of facts.story) expect(line).not.toMatch(RAW);
  });

  it('tell a genesis parent that mated, passed its life on and came back', () => {
    const b = bundleOf(history, A0);
    const round = b.records.find((s) => s.hash === A0)?.record.body.round;
    expect(storyLines(b)).toEqual([
      `Hatched from drand round ${round}, a first-generation cell`,
      'Mated once',
      'Passed its life on to its child once',
      'Brought back after its successor died once',
      expect.stringMatching(/^Has lived \d+ min( \d+ s)? so far$/),
      'Alive and swimming',
    ]);
    expect(cardFacts(b)?.status).toBe('active');
    expect(familyLines(verifyLineage(b))).toContain('Fights: none in this history.');
  });

  it('tell a victim and an eaten egg', () => {
    expect(storyLines(bundleOf(history, B0)).slice(-3)).toEqual([
      'Fought once',
      expect.stringMatching(/^Lived /),
      'Gone: killed in a fight',
    ]);
    const egg = storyLines(bundleOf(history, B1));
    expect(egg[0]).toMatch(/^Born from drand round \d+ to /);
    expect(egg.at(-1)).toBe('Gone: eaten as an egg in a fight');
    expect(cardFacts(bundleOf(history, B1))?.generation).toBe(1);
  });

  it('name a parent outside the proof plainly', () => {
    const b = bundleOf(history, A1, [A0]);
    expect(storyLines(b)[0]).toMatch(/ to an ancestor not loaded and /);
  });

  it('give no facts for a bundle whose subject has no genome', () => {
    const b = golden();
    b.creatures = b.creatures.slice(1);
    expect(cardFacts(b)).toBeNull();
  });
});

describe('the verdict line', () => {
  it('is verified back to genesis for the golden', () => {
    const r = verifyLineage(golden());
    expect(verdictLine(r)).toBe('Verified back to genesis');
    expect(familyLines(r)).toContain('Chains: every record follows on from the one before it.');
    expect(familyLines(r)).toContain('Fight replays: 1 fight settled, 0 replayed, 1 not replayed.');
    for (const line of familyLines(r)) expect(line).not.toMatch(RAW);
  });

  it('names the first problem of a tampered bundle in plain words', () => {
    const b = golden();
    const i = b.records.findIndex(
      (s) => s.record.creature === A1 && s.record.kind === 'checkpoint',
    );
    const s = b.records[i];
    if (!s) throw new Error('no checkpoint');
    b.records[i] = {
      ...s,
      record: {
        ...s.record,
        body: { ...s.record.body, biomass: Number(s.record.body.biomass) + 1 },
      },
    };
    const r = verifyLineage(b);
    expect(verdictLine(r)).toBe('Not verified: A record has been changed since it was written.');
    expect(familyLines(r)).toContain('Chains: 1 problem.');
    const lines = problemLines(b, r.problems);
    expect(lines[0]).toBe(
      `A record has been changed since it was written. (${nameOf(b, A1)}, record ${s.record.seq + 1})`,
    );
    for (const line of lines) expect(line).not.toMatch(RAW);
  });

  it('says a scaled world is a test world', () => {
    const scaled = lineageHistory({ lifespan: 0.05, mating: 0.01 });
    const r = verifyLineage(bundleOf(scaled, scaled.ids.A1));
    expect(r.problems).toEqual([]);
    expect(verdictLine(r)).toBe('Verified back to genesis · a test world with shortened clocks');
    expect(familyLines(r)).toContain('A test world: lives and matings run on shortened clocks.');
  });

  it('counts the generations it reached when ancestors are left out', () => {
    // A parent left out stops the count at the birth it leaves unchecked.
    const r = verifyLineage(bundleOf(history, A1, [B0]));
    expect(r.toGenesis).toBe(false);
    expect(verdictLine(r)).toBe('Verified, but not back to its parents');
    expect(familyLines(r)).toContain('1 ancestor not loaded, so not checked.');
    expect(familyLines(r)).toContain('1 birth not recomputed: a parent is not loaded.');
    // A deeper lineage whose oldest ancestors are left out reaches some generations.
    expect(verdictLine({ ...r, generations: 3 })).toBe('Verified 3 generations back');
    expect(verdictLine({ ...r, generations: 1, scaled: true })).toBe(
      'Verified 1 generation back · a test world with shortened clocks',
    );
  });
});

describe('the check', () => {
  it('verifies, then replays each fight as its log arrives', () => {
    const check = new LineageCheck(golden(), verifyEncounter);
    expect(check.report.problems).toEqual([]);
    expect(check.fights()).toEqual([ENC]);
    const r = check.add(ENC, LOG);
    expect(r.problems).toEqual([]);
    expect(r.fights).toEqual({ settled: 1, replayed: 1, pruned: 0, unreplayed: 0 });
    expect(verdictLine(r)).toBe('Verified back to genesis');
  });

  it('counts a pruned log, and names a log that does not match its settlement', () => {
    expect(new LineageCheck(golden(), verifyEncounter).add(ENC, null).fights).toMatchObject({
      pruned: 1,
      replayed: 0,
    });
    const log = structuredClone(LOG);
    const row = log.frames.find((f) => f.length > 0) as (number | null)[];
    row[0] = 7;
    const r = new LineageCheck(golden(), verifyEncounter).add(ENC, log);
    expect(r.problems.map((p) => p.code)).toContain('replay:root');
    expect(verdictLine(r)).toMatch(/^Not verified: A fight's log /);
  });

  it('keeps the first report of a tampered bundle through a replay', () => {
    const b = golden();
    rewrite(b, A1, 2, (r) => {
      r.body.biomass = Number(r.body.biomass) + 100_000;
    });
    const check = new LineageCheck(b, verifyEncounter);
    const before = check.report.problems.length;
    expect(before).toBeGreaterThan(0);
    expect(check.add(ENC, LOG).problems.length).toBeGreaterThanOrEqual(before);
  });
});
