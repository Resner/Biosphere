import { describe, expect, it } from 'vitest';
import { LifeFlow, wireCondition } from '../src/game/life';
import type { Genome } from '../src/genome/codec';
import { genesisGenome } from '../src/genome/genesis';
import { buildCreature } from '../src/genome/stats';
import {
  LIVE_SCALES,
  lifespanOf,
  matureAtOf,
  matureBiomassOf,
  reachAt,
  startOf,
  vitalsCap,
} from '../src/ledger/gates';
import type { ClientMsg, LifeInfo } from '../src/net/protocol';
import { createRng, seedFromString } from '../src/sim/prng';
import { RULES, TICK_HZ } from '../src/sim/rules';
import { ARCHETYPES } from '../tests/archetypes';
import { heavyTest } from '../tests/heavy';
import { simulateLife } from '../tools/pacing-report';
import { applyReport, bindLife, type Implausible, type LifeState } from './life';

// An honest page raises no plausibility flag (M14 T2): the real sim's creatures, reported by the
// real `LifeFlow.report` (after 5 s, then every 30 s, in hundredths, the ticks counted from each
// connection) and checked as the hub checks them (`applyReport`). A flag on one of these is a
// hair between the page and the hub, and a report the hub clamped leaves the player with less.

const FIRST_REPORT_TICKS = 5 * TICK_HZ;
const REPORT_EVERY_TICKS = 30 * TICK_HZ;
const MS_PER_TICK = 1000 / TICK_HZ;
const ARCHETYPE_NAMES = Object.keys(ARCHETYPES);
const CREATURE = 'c'.repeat(64);

/** The eleven archetypes, then genesis bodies. */
function bodyOf(i: number): Genome {
  const named = ARCHETYPES[ARCHETYPE_NAMES[i % (ARCHETYPE_NAMES.length + 1)] ?? ''];
  return named ?? genesisGenome(seedFromString(`honest-${i}`));
}

/** The hub's view of `life` as it tells a page that binds it. */
const infoOf = (life: LifeState): LifeInfo => ({
  creature: CREATURE,
  seq: 1,
  genome: 'G',
  biomass: life.biomass,
  energy: life.energy,
  health: life.health,
  activeMs: life.activeMs,
  lifespanMs: life.lifespanMs,
  matureAtMs: life.matureAtMs,
  cooldownUntilMs: 0,
});

interface Outcome {
  flags: Implausible[];
  reports: number;
  /** Reports after which the hub held something other than the body the page reported. */
  clamped: number;
  /** The most the hub's biomass lagged the body's, in hundredths, at any report. */
  lag: number;
}

async function honestLife(i: number, capMs: number): Promise<Outcome> {
  const rng = createRng(seedFromString(`honest-life-${i}`), 'honest');
  const genome = bodyOf(i);
  const { phys } = buildCreature(genome);
  const size = RULES.world.size;
  const at = { x: (0.1 + 0.8 * rng.next()) * size, y: (0.1 + 0.8 * rng.next()) * size };
  const reconnectAt = rng.next() < 0.1 ? Math.floor(rng.next() * (capMs / MS_PER_TICK)) : -1;
  const gates = {
    lifespanMs: lifespanOf(genome, LIVE_SCALES),
    matureAtMs: matureAtOf(genome, LIVE_SCALES),
    matureBiomass: matureBiomassOf(genome, LIVE_SCALES),
  };
  const head = (l: Pick<LifeState, 'activeMs' | 'biomass' | 'energy' | 'health'>) => ({
    id: CREATURE,
    cooldownUntilMs: 0,
    ...l,
  });
  const startWall = 1_000_000;
  let life = bindLife(
    head({ activeMs: 0, ...startOf('genesis', genome) }),
    genome,
    startWall,
    gates,
  );

  const sent: ClientMsg[] = [];
  const flow = new LifeFlow({
    identity: () => ({}) as never,
    nonce: () => '',
    verify: async () => [],
  });
  flow.attach({ send: (m) => sent.push(m) });
  flow.receive({ t: 'life', life: infoOf(life), genesisIn: 0 });
  await flow.hatch(1000);

  const out: Outcome = { flags: [], reports: 0, clamped: 0, lag: 0 };
  let nextReport = FIRST_REPORT_TICKS;
  let bodyBiomass = 0;
  simulateLife(`honest-${i}`, capMs, {
    mate: false,
    genome,
    at,
    onTick: (tick, c) => {
      bodyBiomass = Math.round(c.biomass * 100);
      if (tick === reconnectAt) {
        // The socket dropped and came back: the hub binds the creature again from what it holds,
        // and the page counts its ticks from that moment.
        const wall = startWall + tick * MS_PER_TICK;
        life = bindLife(head(life), genome, wall, gates);
        sent.length = 0;
        flow.attach({ send: (m) => sent.push(m) });
        flow.receive({ t: 'life', life: infoOf(life), genesisIn: 0 }, tick);
        nextReport = tick + FIRST_REPORT_TICKS;
      }
      if (tick < nextReport) return;
      nextReport = tick + REPORT_EVERY_TICKS;
      flow.report(tick, { ...c, phys });
      const msg = sent.pop();
      if (msg?.t !== 'progress') throw new Error('the page sent no report');
      const claim = { biomass: msg.biomass, energy: msg.energy, health: msg.health };
      const wall = startWall + tick * MS_PER_TICK;
      const res = applyReport(life, { n: msg.n, ticks: msg.ticks, ...claim }, wall);
      out.flags.push(...res.newFlags);
      life = res.life;
      out.reports++;
      if (
        life.biomass !== claim.biomass ||
        life.energy !== claim.energy ||
        life.health !== claim.health
      )
        out.clamped++;
      out.lag = Math.max(out.lag, bodyBiomass - life.biomass);
    },
  });
  return out;
}

const LIVES = Number(process.env.LIVES ?? 240);
const LIFE_MS = Number(process.env.LIFE_MS ?? 100_000);

describe('honest pages', () => {
  it('a few foragers raise no flag', async () => {
    const out = await Promise.all(Array.from({ length: 6 }, (_, i) => honestLife(i, 2 * 60_000)));
    expect(out.flatMap((o) => o.flags)).toEqual([]);
  });

  it('rounds to a body the hub accepts at the adult size and at full health', () => {
    const genome = bodyOf(0);
    const { maxBiomass } = buildCreature(genome).phys;
    // Just under the maximum, with energy and health at their caps: each rounds up to a hundredth
    // above the floored cap unless the report holds to it.
    for (const biomass of [maxBiomass - 0.001, maxBiomass, 100.004, 173.2049, 12.345]) {
      const w = wireCondition(
        { biomass, energy: 2 * biomass, health: 10 * Math.sqrt(biomass) },
        maxBiomass,
      );
      const cap = vitalsCap(w.biomass);
      expect(w.biomass).toBeLessThanOrEqual(Math.floor(maxBiomass * 100));
      expect(w.energy).toBeLessThanOrEqual(cap.energy);
      expect(w.health).toBeLessThanOrEqual(cap.health);
    }
  });

  it('still flags a report one hundredth past the growth reach, 2·b or 10·r', () => {
    const genome = bodyOf(1);
    const { growth } = buildCreature(genome).phys;
    const gates = { lifespanMs: 1e12, matureAtMs: 0, matureBiomass: 0 };
    const base = startOf('genesis', genome);
    const bound = () =>
      bindLife({ id: CREATURE, activeMs: 0, cooldownUntilMs: 0, ...base }, genome, 0, gates);
    const ticks = 30 * TICK_HZ;
    const reach = reachAt(base.biomass, growth, (ticks * 1000) / TICK_HZ);
    const at = { biomass: reach, energy: base.energy, health: base.health };
    const kinds = (claim: typeof at) =>
      applyReport(bound(), { n: 1, ticks, ...claim }, 30_000).newFlags;
    expect(kinds(at)).toEqual([]);
    expect(kinds({ ...at, biomass: reach + 1 })).toContain('growth-too-fast');
    const cap = vitalsCap(reach);
    expect(kinds({ ...at, energy: cap.energy })).toEqual([]);
    expect(kinds({ ...at, energy: cap.energy + 1 })).toContain('energy-over');
    expect(kinds({ ...at, health: cap.health })).toEqual([]);
    expect(kinds({ ...at, health: cap.health + 1 })).toContain('health-over');
  });

  heavyTest('seeded honest lives raise no plausibility flag and are never clamped', async () => {
    const flags: Record<string, number> = {};
    let reports = 0;
    let clamped = 0;
    for (let i = 0; i < LIVES; i++) {
      const o = await honestLife(i, LIFE_MS);
      reports += o.reports;
      clamped += o.clamped;
      for (const f of o.flags) flags[f] = (flags[f] ?? 0) + 1;
    }
    expect(reports).toBeGreaterThan(LIVES * 2);
    expect(flags).toEqual({});
    expect(clamped).toBe(0);
  });
});

// A tick of the real sim costs about 65 µs, so the 120 s a heavy test gets pays for this many
// lives of this length (2,000 lives of 150 s took 9 minutes); `LIVES=2000 LIFE_MS=150000` runs the full sweep.
