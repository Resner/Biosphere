// The bot-farm simulation's strategies and report (M10 T13, ADR 0059). `worker/farm.test.ts` drives
// scripted identities on a hub and prints each scenario's `FARM_MEASURE` line; this file holds what
// does not need a hub: the measurement types, the gates they must meet, the witness-duty share over
// the fixture's rounds and the report `npm run report:farm` writes to `docs/perf/farm.md`.

import { bytesToHex } from '@noble/hashes/utils.js';
import type { Beacon } from '../src/ledger/drand';
import { randomnessOf } from '../src/ledger/drand';
import { dutyEvent, firstPosition, poolOf, witnessOrder } from '../src/ledger/witness';
import { cooldownMs } from '../src/sim/mating';
import { RULES } from '../src/sim/rules';
import rounds from '../tests/fixtures/drand/rounds.json';

const MIN = 60_000;
/** One report: the resolution of every time the simulation measures. */
export const REPORT_MS = 30_000;
/** The honest forager's growth in biomass per minute across the growth band (`forageGainPerMinute`). */
export const HONEST_GAIN_PER_MIN = 69;
/** Bots that farm, by scenario. */
export const FARM_SIZES = [1, 4, 16] as const;
/** Honest witnesses in the duty-share gate. */
export const HONEST_WITNESSES = 8;
export const DUTY_EVENTS = 200;

/** One creature of the farmer's lineage: what its gates were and when it was ready and mated. */
export interface LifeLog {
  /** Ms after the scenario began that the creature started its life (hatch or promotion). */
  startedAt: number;
  /** Active ms from which it may mate (`matureAtMs` in its ack). */
  matureAtMs: number;
  /** Ms after `startedAt` until it was mature, fed and out of cooldown, or null. */
  readyAfterMs: number | null;
  /** Its active ms when it mated, or null. */
  matedAtMs: number | null;
  /** Children it has (one per mating). */
  children: number;
}

export interface KillLog {
  /** The bot identity killed (index), when and what it had played. */
  victim: number;
  atMs: number;
  victimPlayMs: number;
  /** Its worth as prey in the fight's start. */
  worth: number;
  /** Its size at the fight's start (wu). */
  victimBiomass: number;
  /** The killer's reward and the carrion's food, in wu of biomass. */
  reward: number;
  carrion: number;
}

export interface Measure {
  /** `honest` or `farm-<N>`. */
  name: string;
  bots: number;
  hours: number;
  /** Ms after the first hatch that the player's lineage reached generation 3, or null. */
  gen3AtMs: number | null;
  lives: LifeLog[];
  kills: KillLog[];
  /** Children of every identity of the scenario, and how many are rare or better. */
  children: number;
  rare: number;
  /** The sum of the children's rarity scores (bits). */
  rarityBits: number;
  /** Ms until a creature of the player first holds 95% of its genome's maximum size, or null. */
  maxSizeAtMs: number | null;
  /** What the pool and the witnesses' eligibility showed at 19 and 21 minutes (the one farm that checks). */
  eligibility: { before: number; after: number } | null;
}

export interface Gate {
  n: number;
  name: string;
  ok: boolean;
  detail: string;
}

const minutes = (ms: number): string => (ms / MIN).toFixed(1);

/** The mean time a creature of the lineage's first three spent beyond its time gate, waiting to grow. */
export function overheadMs(m: Measure): number {
  const first = m.lives.slice(0, 3);
  return (
    first.reduce((sum, l) => sum + Math.max(0, (l.readyAfterMs ?? 0) - l.matureAtMs), 0) /
    Math.max(1, first.length)
  );
}

/**
 * Over `events` fights (the fixture's rounds, the real pool and order): the share of referee and
 * auditor positions that `bots` eligible bot identities take among `honest` honest witnesses.
 */
export function dutyShare(bots: number, honest = HONEST_WITNESSES, events = DUTY_EVENTS): number {
  const ids = [
    ...Array.from({ length: bots }, (_, i) => `bot-${i}`),
    ...Array.from({ length: honest }, (_, i) => `honest-${i}`),
  ];
  const all = rounds.beacons as Beacon[];
  const positions = [firstPosition('enc', 'referee'), firstPosition('enc', 'auditor')] as number[];
  let taken = 0;
  for (let e = 0; e < events; e++) {
    const id = bytesToHex(new Uint8Array(32).fill(1).map((v, i) => (v + e * 7 + i) & 255));
    const event = dutyEvent('enc', id);
    const beacon = all[e % all.length] as Beacon;
    const order = witnessOrder(poolOf(ids, event), randomnessOf(beacon), id);
    for (const p of positions) if (order[p]?.startsWith('bot-')) taken += 1;
  }
  return taken / (events * positions.length);
}

/** The five gates of ADR 0059 for one farm, against the honest pair's measurement. */
export function gatesOf(farm: Measure, honest: Measure): Gate[] {
  const gen3 = farm.gen3AtMs;
  const gates = farm.lives.slice(0, 3).reduce((s, l) => s + l.matureAtMs, 0);
  const minimum = Math.max(3 * RULES.life.matureMinMs, gates);
  const lead = overheadMs(honest) - overheadMs(farm);
  const cooldown = cooldownMs(0);
  const overChildren = farm.lives.filter(
    (l) =>
      l.matedAtMs !== null &&
      l.children > 1 + Math.floor(Math.max(0, l.matedAtMs - l.matureAtMs) / cooldown),
  );
  const pay = (k: KillLog) => k.reward + k.carrion;
  const victims = farm.kills.reduce((s, k) => s + k.victimBiomass, 0);
  const gained = farm.kills.reduce((s, k) => s + pay(k), 0);
  const byBot = new Map<number, number>();
  for (const k of farm.kills) byBot.set(k.victim, (byBot.get(k.victim) ?? 0) + k.worth);
  // Kills past the halvings' cap pay the floor, 2^-maxHalvings each (ADR 0059's explicit limit).
  const floor = 0.5 ** RULES.encounter.farming.maxHalvings;
  const killsOf = (bot: number) => farm.kills.filter((k) => k.victim === bot).length;
  const worstBot = Math.max(
    0,
    ...[...byBot].map(([bot, worth]) => worth - floor * Math.max(0, killsOf(bot) - 7)),
  );
  const young = farm.kills.filter((k) => k.victimPlayMs < RULES.encounter.farming.youngPlayMs);
  const share = dutyShare(farm.bots);
  const fair = farm.bots / (farm.bots + HONEST_WITNESSES) + 0.1;
  const elig = farm.eligibility;
  return [
    {
      n: 1,
      name: 'No time shortcut',
      ok:
        gen3 !== null &&
        gen3 >= minimum &&
        // A farmer's creatures wait for growth at most one report less than the honest pair's.
        lead <= REPORT_MS,
      detail: `generation 3 at ${gen3 === null ? 'never' : minutes(gen3)} min (least the gates allow ${minutes(minimum)}); a creature of the honest pair waits ${minutes(overheadMs(honest))} min beyond its own gate, the farmer's ${minutes(overheadMs(farm))}`,
    },
    {
      n: 2,
      name: 'No breeding shortcut',
      ok: overChildren.length === 0,
      detail: `${farm.lives.length} creatures, none with more than one child per ${minutes(cooldown)} min cooldown after maturity (${farm.children} children in ${farm.hours} h)`,
    },
    {
      n: 3,
      name: 'No biomass from nothing',
      ok:
        gained <= victims &&
        farm.kills.every((k) => pay(k) <= k.victimBiomass * k.worth + 0.01) &&
        worstBot <= 2,
      detail: `${farm.kills.length} kill${farm.kills.length === 1 ? '' : 's'} paid ${gained.toFixed(0)} wu from ${victims.toFixed(0)} wu of victims; one bot identity's kills were worth ${worstBot.toFixed(2)} full kills at most, the floor aside`,
    },
    {
      n: 4,
      name: 'Young bots pay half',
      ok:
        farm.bots === 0 ||
        (young.length > 0 &&
          young.every((k) => k.worth <= 0.5 && pay(k) <= 0.5 * k.victimBiomass + 0.01)),
      detail: `${young.length} kill${young.length === 1 ? '' : 's'} of identities under ${RULES.encounter.farming.youngPlayMs / MIN} min of play, each worth at most 0.5`,
    },
    {
      n: 5,
      name: 'Sybil witnesses get their share',
      ok: share <= fair && elig !== null && elig.before === 0 && elig.after >= 1,
      detail: `${farm.bots} bots among ${HONEST_WITNESSES} honest witnesses took ${(share * 100).toFixed(0)}% of ${DUTY_EVENTS} events' duties (at most ${(fair * 100).toFixed(0)}%); eligible bots at 19 min: ${elig?.before ?? 'unchecked'}, at 21 min: ${elig?.after ?? 'unchecked'}`,
    },
  ];
}

const round1 = (n: number): number => Math.round(n * 10) / 10;

/** `docs/perf/farm.md` for the scenarios. The first is the honest pair. */
export function farmReport(all: readonly Measure[]): string {
  const honest = all.find((m) => m.name === 'honest');
  if (!honest) throw new Error('no honest baseline');
  const farms = all.filter((m) => m !== honest);
  const out = [
    '# Bot-farm report',
    '',
    'Reproduce with `npm run report:farm`. Scripted identities drive one hub on a hand-moved clock under the',
    'live rules and scales for 3 hours of play (`worker/farm.test.ts`, ADR 0059); they never join the live world.',
    "The honest pair forages at the pacing bot's pace and mates as soon as it may; a farmer reports the most",
    "growth the authority accepts, mates with its bots in turn, kills them through the authority's referee and",
    'sets its bots available as witnesses. Times are minutes after the first hatch, at one report (30 s) of resolution.',
    '',
    '## Gates',
    '',
    '| Farm | Gate | Result | Measured |',
    '|---|---|---|---|',
    ...farms.flatMap((f) =>
      gatesOf(f, honest).map(
        (g) =>
          `| ${f.bots} bot${f.bots === 1 ? '' : 's'} | ${g.n}. ${g.name} | ${g.ok ? 'met' : 'MISSED'} | ${g.detail} |`,
      ),
    ),
    '',
    '## What farming buys (no gate)',
    '',
    'The extra attempts the brief allows: a farmer reaches its genetic maximum size sooner, and its identities',
    'draw more genomes in the same time.',
    '',
    '| Scenario | Generation 3 (min) | Maximum size (min) | Children | Rare or better | Mean rarity (bits) | Children per hour |',
    '|---|---|---|---|---|---|---|',
    ...all.map(
      (m) =>
        `| ${m.name} | ${m.gen3AtMs === null ? 'never' : minutes(m.gen3AtMs)} | ${m.maxSizeAtMs === null ? 'not within the run' : minutes(m.maxSizeAtMs)} | ${m.children} | ${m.rare} | ${round1(m.rarityBits / Math.max(1, m.children))} | ${round1(m.children / m.hours)} |`,
    ),
    '',
  ];
  return out.join('\n');
}
