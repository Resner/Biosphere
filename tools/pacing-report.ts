// Pacing simulation (M5 T14): a food-seeking bot lives solo in the real sim with real genesis
// genomes and mates whenever the rules allow. `npm run sim:pacing -- --creatures 12 --minutes 120`.
// A test aid, not a player model: it never fights, never waits for a partner and takes the
// nearest food, so the owner judges the feel in the playtest.

import { genesisGenome } from '../src/genome/genesis';
import { buildCreature } from '../src/genome/stats';
import { foodNear } from '../src/sim/food';
import { plumesNear } from '../src/sim/hazards';
import { angleToSteer } from '../src/sim/input';
import { applyLife, lifeStage, lifespanMs } from '../src/sim/life';
import { atan2 } from '../src/sim/math';
import { cooldownMs } from '../src/sim/mating';
import { hashU32, seedFromString } from '../src/sim/prng';
import { RULES, TICK_HZ } from '../src/sim/rules';
import { step } from '../src/sim/step';
import { maxEnergy } from '../src/sim/vitals';
import { createWorld, spawnCreature } from '../src/sim/world';

export interface PacingOptions {
  creatures: number;
  /** Cap on the active minutes simulated per creature (a full life is its lifespan). */
  minutes: number;
}

const DEFAULTS: PacingOptions = { creatures: 12, minutes: 120 };

export function parseArgs(argv: readonly string[]): PacingOptions {
  const options = { ...DEFAULTS };
  for (let i = 0; i < argv.length; i += 2) {
    const key = (argv[i] ?? '').replace(/^--/, '');
    const value = Number(argv[i + 1]);
    if (!Object.hasOwn(DEFAULTS, key) || !Number.isInteger(value) || value < 1) {
      throw new Error(
        `Bad option ${argv[i]} ${argv[i + 1]}: use --creatures, --minutes with whole numbers`,
      );
    }
    options[key as keyof PacingOptions] = value;
  }
  return options;
}

export interface Life {
  /** Active ms when the creature first counted as mature, or null. */
  matureAtMs: number | null;
  /** Active ms when it was first mature, fed and out of cooldown. */
  firstEligibleMs: number | null;
  /** Active ms of every mating. */
  matingsMs: number[];
  /** Active ms at the end of the run, and how it ended. */
  endMs: number;
  end: 'old-age' | 'died' | 'cap';
}

const SENSE = 400;
/** How far from a cloud's edge the bot turns away (wu), on top of its own radius. */
const PLUME_MARGIN = 60;
const MS_PER_TICK = 1000 / TICK_HZ;

/** One bot life: seek the nearest food, wander when nothing is in sight, mate when allowed. */
export function simulateLife(name: string, capMs: number): Life {
  const { stats, phys } = buildCreature(genesisGenome(seedFromString(`pacing-${name}`)));
  const lifespan = lifespanMs(stats.physiology.lifespan);
  const world = createWorld({ seed: `pacing/${name}` });
  const me = spawnCreature(world, { id: 'bot', x: world.size / 2, y: world.size / 2, phys });
  const life: Life = {
    matureAtMs: null,
    firstEligibleMs: null,
    matingsMs: [],
    endMs: 0,
    end: 'cap',
  };
  let wander = 0;
  let cooldownUntil = 0;
  let target: { x: number; y: number } | null = null;
  let flee: { x: number; y: number; d: number } | null = null;
  for (;;) {
    const ms = world.tick * MS_PER_TICK;
    life.endMs = ms;
    if (ms >= lifespan) {
      life.end = 'old-age';
      break;
    }
    if (!me.alive) {
      life.end = 'died';
      break;
    }
    if (ms >= capMs) break;
    if (ms >= RULES.life.elderAt * lifespan) me.elder = true;
    if (world.tick % 6 === 0) {
      let bestD = Number.POSITIVE_INFINITY;
      target = null;
      // Swim away from a toxic cloud before reaching it, and ignore food inside one.
      const clouds = plumesNear(world, me.x, me.y, SENSE);
      const margin = Math.sqrt(me.biomass) + PLUME_MARGIN;
      flee = null;
      for (const p of clouds) {
        const d = Math.hypot(p.x - me.x, p.y - me.y) - p.radius;
        if (d < margin && (flee === null || d < flee.d)) flee = { x: p.x, y: p.y, d };
      }
      for (const f of foodNear(world, me.x, me.y, SENSE)) {
        if (clouds.some((p) => Math.hypot(p.x - f.x, p.y - f.y) < p.radius + margin)) continue;
        const d = (f.x - me.x) ** 2 + (f.y - me.y) ** 2;
        if (d < bestD) {
          bestD = d;
          target = f;
        }
      }
      if (target === null && world.tick % 180 === 0) {
        wander = (hashU32(world.tick, name.length) % 628) / 100;
      }
    }
    const aim =
      flee !== null
        ? atan2(me.y - flee.y, me.x - flee.x)
        : target === null
          ? wander
          : atan2(target.y - me.y, target.x - me.x);
    step(world, { bot: { steer: angleToSteer(aim), throttle: 15, dash: false } });

    const now = world.tick * MS_PER_TICK;
    if (
      life.matureAtMs === null &&
      lifeStage(now, lifespan, me.biomass, stats.maxBiomass) !== 'young'
    ) {
      life.matureAtMs = now;
    }
    const fed = me.energy >= RULES.mating.minEnergyShare * maxEnergy(me.biomass);
    if (life.matureAtMs !== null && now >= cooldownUntil && fed && me.alive) {
      life.firstEligibleMs ??= now;
      life.matingsMs.push(now);
      applyLife(world, 'bot', 'mate');
      // A new partner each time, so the pair doubling stays at zero here.
      cooldownUntil = now + cooldownMs(0);
    }
  }
  return life;
}

const percentile = (sorted: readonly number[], p: number): number =>
  sorted.length === 0
    ? Number.NaN
    : (sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] as number);
const min = (ms: number): string => (Number.isNaN(ms) ? 'n/a' : (ms / 60_000).toFixed(1));
const ascending = (a: number, b: number): number => a - b;

export function pacingReport(options: PacingOptions): string {
  const lives = Array.from({ length: options.creatures }, (_, i) =>
    simulateLife(String(i), options.minutes * 60_000),
  );
  const first = lives
    .flatMap((l) => (l.firstEligibleMs === null ? [] : [l.firstEligibleMs]))
    .sort(ascending);
  const gaps = lives
    .flatMap((l) => l.matingsMs.slice(1).map((t, i) => t - (l.matingsMs[i] as number)))
    .sort(ascending);
  const full = lives.filter((l) => l.end === 'old-age');
  const perLife = (full.length > 0 ? full : lives).map((l) => l.matingsMs.length).sort(ascending);
  const hours = lives.reduce((sum, l) => sum + l.endMs, 0) / 3_600_000;
  const matings = lives.reduce((sum, l) => sum + l.matingsMs.length, 0);
  const base = RULES.mating.cooldownMs;
  const medianFirst = percentile(first, 0.5);
  const medianLife = percentile(perLife, 0.5);
  const verdict = (ok: boolean): string => (ok ? 'met' : 'MISSED');
  return [
    '# Pacing report',
    '',
    `Lives: ${lives.length} (${full.length} ran to old age, ${lives.filter((l) => l.end === 'died').length} died, cap ${options.minutes} min). Times are active minutes.`,
    '',
    '## Measured',
    '',
    '| Measure | Value |',
    '|---|---|',
    `| Hatch to first eligibility (median, p10, p90) | ${min(medianFirst)}, ${min(percentile(first, 0.1))}, ${min(percentile(first, 0.9))} |`,
    `| Mating to eligible again (median, p10, p90) | ${min(percentile(gaps, 0.5))}, ${min(percentile(gaps, 0.1))}, ${min(percentile(gaps, 0.9))} |`,
    `| Matings per full life (median, min, max) | ${medianLife}, ${perLife[0] ?? 'n/a'}, ${perLife[perLife.length - 1] ?? 'n/a'} |`,
    `| Children per hour of active time (one per mating) | ${(matings / hours).toFixed(2)} |`,
    '',
    '## Targets',
    '',
    '| Target | Result |',
    '|---|---|',
    `| Median hatch to first eligibility between 14 and 25 min | ${verdict(medianFirst >= 14 * 60_000 && medianFirst <= 25 * 60_000)} |`,
    `| 4 to 9 matings possible in a life (median) | ${verdict(medianLife >= 4 && medianLife <= 9)} |`,
    `| A pair's 4th mating within 24 h waits at least 8× the base cooldown | ${verdict(cooldownMs(3) >= 8 * base)} |`,
    '',
    '## Repeated matings',
    '',
    `Wait after a mating with the same partner within ${RULES.mating.repeatWindowMs / 3_600_000} h (base ${min(base)} min).`,
    '',
    '| Mating | Cooldown | Wait (min) |',
    '|---|---|---|',
    ...Array.from({ length: RULES.mating.repeatMaxDoublings + 1 }, (_, n) => {
      const ordinal = ['1st', '2nd', '3rd'][n] ?? `${n + 1}th`;
      return `| ${ordinal} | ${cooldownMs(n) / base}× | ${min(cooldownMs(n))} |`;
    }),
    '',
  ].join('\n');
}
