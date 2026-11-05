import { type Genome, genomeFromBase64url } from '../genome/codec';
import { buildCreature } from '../genome/stats';
import {
  CLOCK_SLACK_MS,
  type Condition,
  cooldownsOf,
  hasMatingEnergy,
  lifespanOf,
  matureAtOf,
  matureBiomassFrom,
  paidFor,
  reachAt,
  restoreMinOf,
  type Scales,
  startFrom,
  vitalsCap,
} from './gates';
import type { StoredRecord } from './record';
import type { BundleIndex, Problem, VerifyOptions } from './verify';

// The gates family of `verifyLineage` (ADR 0055): the life clock, matings' maturity, cooldowns and
// costs, growth, and freezes and returns, record by record under the bundle's scales and the one
// rulebook (`gates.ts`). Every bound is inclusive, as the authority's are. A fight's own records
// (its `encounter`, its deaths and the checkpoint a settlement writes before a death) get their
// clock and growth bounds from the fights family; here they only keep the clock from going back.

/** What a creature's chain has established by a record: its clock, its condition, its cooldown. */
interface State {
  /** The wall time the clock was last read at; null while the creature is a pending child. */
  t: number | null;
  activeMs: number;
  condition: Condition;
  cooldownUntilMs: number;
  /** Put aside by a parent's promote, until a restore. */
  frozen: boolean;
}

/** The rulebook's values for one genome, under the bundle's scales. */
interface Rules {
  /** The genome's adult size (wu), for the start of a birth. */
  maxBiomass: number;
  /** The genome's growth multiplier, for the reach. */
  growth: number;
  lifespan: number;
  matureAt: number;
  matureSize: number;
  restoreMin: number;
  cooldowns: readonly number[];
}

const int = (v: unknown): number | null => (Number.isSafeInteger(v) ? (v as number) : null);

/** The condition a body names, with `suffix` (`…Before` for a mating's), or null when one is missing. */
function conditionIn(body: StoredRecord['record']['body'], suffix = ''): Condition | null {
  const biomass = int(body[`biomass${suffix}`]);
  const energy = int(body[`energy${suffix}`]);
  const health = int(body[`health${suffix}`]);
  return biomass === null || energy === null || health === null
    ? null
    : { biomass, energy, health };
}

const sameCondition = (a: Condition, b: Condition): boolean =>
  a.biomass === b.biomass && a.energy === b.energy && a.health === b.health;

/** A death the fight's settlement wrote: a kill, an eaten egg, or a hazard inside the fight. */
const fightDeath = (s: StoredRecord | undefined): boolean =>
  s?.record.kind === 'death' && typeof s.record.body.enc === 'string';

/** Whether the fights family bounds this record's clock: a fight's record, or a settlement's checkpoint before its death. */
const ofFight = (s: StoredRecord, next: StoredRecord | undefined): boolean =>
  s.record.kind === 'encounter' ||
  fightDeath(s) ||
  (s.record.kind === 'checkpoint' && fightDeath(next) && next?.record.t === s.record.t);

export function verifyGates(index: BundleIndex, _opts: VerifyOptions): Problem[] {
  const scales = index.bundle.world.scales;
  const out: Problem[] = [];
  for (const [id, text] of index.creatures) {
    const genome = genomeFromBase64url(text);
    // A genome that does not read is the origin family's to name; there is nothing to gate against.
    if (!genome) continue;
    out.push(...gatesOf(id, rulesOf(genome, scales), index.records.get(id) ?? []));
  }
  return out;
}

function rulesOf(genome: Genome, s: Scales): Rules {
  const { phys } = buildCreature(genome); // once per creature: the rulebook's other readers each build it again
  return {
    maxBiomass: phys.maxBiomass,
    growth: phys.growth,
    lifespan: lifespanOf(genome, s),
    matureAt: matureAtOf(genome, s),
    matureSize: matureBiomassFrom(phys.maxBiomass),
    restoreMin: restoreMinOf(s),
    cooldowns: cooldownsOf(s),
  };
}

/** One creature's records, in `seq` order, from its first. */
function gatesOf(id: string, rules: Rules, chain: readonly StoredRecord[]): Problem[] {
  const out: Problem[] = [];
  const first = chain[0]?.record;
  if (first?.seq !== 0 || (first.kind !== 'genesis' && first.kind !== 'birth')) return out;
  const state: State = {
    t: first.kind === 'genesis' ? first.t : null,
    activeMs: 0,
    condition: startFrom(first.kind, rules.maxBiomass),
    cooldownUntilMs: 0,
    frozen: false,
  };
  for (let i = 1; i < chain.length; i++) {
    const s = chain[i] as StoredRecord;
    // A fork or a gap is the chain family's; the gates read the chain as far as it runs on.
    if (s.record.seq !== (chain[i - 1] as StoredRecord).record.seq + 1) break;
    const at = (code: string) =>
      out.push({ creature: id, seq: s.record.seq, family: 'gates', code });
    step(state, rules, s, chain[i + 1], at);
  }
  return out;
}

/** Checks one record against what the chain established before it, then takes its values on. */
function step(
  state: State,
  rules: Rules,
  s: StoredRecord,
  next: StoredRecord | undefined,
  at: (code: string) => void,
): void {
  const { kind, body, t } = s.record;
  if (kind === 'promote' && body.role === 'child') {
    // The child's life clock starts with its promotion.
    state.t = t;
    return;
  }
  const activeMs = int(body.activeMs);
  if (activeMs === null) return; // A record without a clock is malformed: the chain family's.
  if (state.t === null) {
    // A pending child has no clock: whatever happens to it before its promotion happens at 0.
    if (activeMs !== 0) at('pending-clock');
    return;
  }
  const fight = ofFight(s, next);
  const gained = activeMs - state.activeMs;
  if (gained < 0) at('clock-back');
  else if (!fight && gained > t - state.t + CLOCK_SLACK_MS) at('clock-fast');
  if (kind !== 'death' && activeMs > rules.lifespan) at('after-lifespan');
  const left = rules.lifespan - activeMs;
  const condition = conditionIn(body);
  /** Whether `biomass` is beyond the growth reach from the condition before, over the time gained. */
  const outgrown = (biomass: number) =>
    biomass > reachAt(state.condition.biomass, rules.growth, Math.max(0, gained));
  /** `c` against the vitals its biomass allows. */
  const capped = (c: Condition) => {
    const cap = vitalsCap(c.biomass);
    if (c.energy > cap.energy || c.health > cap.health) at('vitals');
  };
  /** `c` against the growth reach and the vitals its biomass allows. */
  const grown = (c: Condition) => {
    if (outgrown(c.biomass)) at('growth');
    capped(c);
  };

  switch (kind) {
    case 'mate-commit': {
      const before = conditionIn(body, 'Before');
      const cooldownUntilMs = int(body.cooldownUntilMs);
      if (!before || !condition || cooldownUntilMs === null) return;
      grown(before);
      if (activeMs < rules.matureAt) at('mature-time');
      if (before.biomass < rules.matureSize) at('mature-size');
      if (!hasMatingEnergy(before)) at('mate-energy');
      if (activeMs < state.cooldownUntilMs) at('cooldown');
      if (!rules.cooldowns.includes(cooldownUntilMs - activeMs)) at('cooldown-length');
      if (!sameCondition(condition, paidFor(before))) at('cost');
      state.cooldownUntilMs = cooldownUntilMs;
      break;
    }
    case 'restore': {
      const cooldownUntilMs = int(body.cooldownUntilMs);
      if (
        !condition ||
        activeMs !== state.activeMs ||
        !sameCondition(condition, state.condition) ||
        cooldownUntilMs !== state.cooldownUntilMs
      )
        at('restore-changed');
      if (left < rules.restoreMin) at('restore-exhausted');
      state.frozen = false;
      break;
    }
    case 'death': {
      const biomass = int(body.biomass);
      if (state.frozen) {
        // Put aside, it neither ages nor changes: it dies as it was frozen.
        if (activeMs !== state.activeMs || biomass !== state.condition.biomass)
          at('frozen-changed');
      } else if (!fight && biomass !== null && outgrown(biomass)) {
        at('growth');
      }
      const exhausted = state.frozen && left < rules.restoreMin;
      if (body.cause === 'old-age' && left > 0 && !exhausted) at('old-age-early');
      break;
    }
    default: {
      // A checkpoint, a parent's promote or a fight's encounter. A settlement's checkpoint grows
      // within the fight's bound (the fights family's), but holds no more than its body allows.
      if (!condition) return;
      if (kind === 'checkpoint' && fight) capped(condition);
      else if (kind !== 'encounter') grown(condition);
      if (kind === 'promote') {
        // The parent is frozen as it was last reported; its cooldown runs on unchanged.
        if (int(body.cooldownUntilMs) !== state.cooldownUntilMs) at('promote-cooldown');
        state.frozen = true;
      }
    }
  }
  state.t = t;
  state.activeMs = activeMs;
  if (condition) state.condition = condition;
}
