// Combat inside one tick of a fight (ADR 0051): brace, landing strikes and rams, spines, kills and
// their rewards, then new windups. Damage is gathered first and applied together, so two fighters
// that hit each other on the same tick both land. Timers are absolute pond ticks.

import { RULES } from '../rules';
import { sizeTier } from '../size';
import { addBiomass, maxEnergy } from '../vitals';
import type { Impact } from './collide';
import { EGG_CODE, hasEgg, targetEgg } from './egg';
import { finish } from './outcome';
import { radiusOf, strikeReach } from './reach';
import { armourFactor, inStrikeCode, pickCode, strikeDamage } from './strike';
import type { Encounter, EncounterEvent, Fighter, FrameInput, HitKind } from './types';

const E = RULES.encounter;

interface Hit {
  victim: Fighter;
  by: Fighter;
  kind: HitKind;
  amount: number;
  blocked: boolean;
  /** The victim's egg is hit, not its body. */
  egg: boolean;
}

export function newFx(): Fighter['fx'] {
  return {
    windupEnd: -1,
    windupTarget: -1,
    readyTick: 0,
    staggerUntil: 0,
    braceUntil: -1,
    braceReady: 0,
    ramReady: Array.from({ length: E.maxFighters }, () => 0),
    stance: 'balanced',
  };
}

/** The thrust factor of a fighter's stance, cut while it is staggered. */
export function thrustMod(f: Fighter, tick: number): number {
  return E.stance[f.fx.stance].thrust * (tick < f.fx.staggerUntil ? E.brace.staggerThrust : 1);
}

function brace(f: Fighter, input: FrameInput | null, tick: number): void {
  if (input === null || !input.brace || tick < f.fx.braceReady) return;
  const cost = E.brace.energyPerBiomass * f.body.biomass;
  if (f.body.energy < cost) return;
  f.body.energy -= cost;
  f.fx.braceUntil = tick + E.brace.windowTicks;
  f.fx.braceReady = tick + E.brace.cooldownTicks;
}

/**
 * Queues a hit with brace and spines applied: a blocked hit is cut and staggers its attacker. A
 * brace shields the bracer's egg too; spines never answer a hit on an egg.
 */
function queue(
  hits: Hit[],
  by: Fighter,
  victim: Fighter,
  kind: HitKind,
  raw: number,
  t: number,
  egg = false,
) {
  const blocked = t <= victim.fx.braceUntil;
  const amount = blocked ? raw * (1 - E.brace.block) : raw;
  hits.push({ victim, by, kind, amount, blocked, egg });
  if (!egg && amount > 0 && victim.combat.spines > 0) {
    const back = E.spineReturn * victim.combat.spines * amount;
    hits.push({ victim: by, by: victim, kind: 'spines', amount: back, blocked: false, egg: false });
  }
}

function landStrike(enc: Encounter, f: Fighter, hits: Hit[], t: number): void {
  const code = f.fx.windupTarget;
  f.fx.windupEnd = -1;
  f.fx.readyTick = t + E.strike.recoverTicks;
  if (!inStrikeCode(enc, f, code, E.strike.tolerance * strikeReach(f))) return;
  if (code >= EGG_CODE) {
    const carrier = targetEgg(enc, f, code) as Fighter;
    queue(hits, f, carrier, 'strike', strikeDamage(enc, f, 1, t), t, true);
    return;
  }
  const target = enc.fighters[code] as Fighter;
  queue(hits, f, target, 'strike', strikeDamage(enc, f, armourFactor(target), t), t);
}

function ram(hits: Hit[], im: Impact, t: number): void {
  const r = E.ram;
  if (im.closing <= r.minSpeed) return;
  const by = im.aRams ? im.a : im.b;
  const victim = im.aRams ? im.b : im.a;
  if (t < (by.fx.ramReady[victim.slot] ?? 0)) return;
  by.fx.ramReady[victim.slot] = t + r.cooldownTicks;
  victim.fx.ramReady[by.slot] = t + r.cooldownTicks;
  const share = by.combat.mass / (by.combat.mass + victim.combat.mass);
  const power = Math.min(1, (im.closing - r.minSpeed) / r.speedSpan);
  const raw = r.perRadius * radiusOf(by.body) * power * 2 * share * armourFactor(victim, false);
  queue(hits, by, victim, 'ram', raw, t);
}

function apply(enc: Encounter, hits: Hit[], t: number, out: EncounterEvent[]): void {
  for (const h of hits) {
    const egg = h.egg ? h.victim.eggBody : null;
    if (egg !== null) egg.health -= h.amount;
    else {
      h.victim.body.health -= h.amount;
      h.victim.lastBy = h.by.slot;
    }
    out.push({
      type: 'hit',
      tick: t,
      slot: h.victim.slot,
      by: h.by.slot,
      kind: h.kind,
      amount: h.amount,
      blocked: h.blocked,
      egg: egg !== null,
    });
    if (egg !== null && egg.by < 0 && egg.health <= 0) eatEgg(enc, h.victim, h.by.slot, out);
    if (h.blocked) {
      h.by.fx.staggerUntil = t + E.brace.staggerTicks;
      h.by.fx.windupEnd = -1;
    }
  }
}

/** The eater takes a share of the victim's biomass as biomass, the overflow as energy (ADR 0051). */
function reward(killer: Fighter, victimBiomass: number, share: number): void {
  const rw = E.reward;
  const mine = sizeTier(killer.body.biomass);
  const theirs = sizeTier(victimBiomass);
  const tier = theirs < mine ? rw.smallerTier : theirs > mine ? rw.biggerTier : 1;
  const gain = share * victimBiomass * tier;
  const b = killer.body;
  const grown = addBiomass(b, gain);
  b.energy = Math.min(maxEnergy(b.biomass), b.energy + (gain - grown) * rw.energyPerBiomass);
}

/** Marks `carrier`'s egg as eaten by slot `by`; an eater still in the fight is fed (ADR 0052). */
function eatEgg(enc: Encounter, carrier: Fighter, by: number, out: EncounterEvent[]): void {
  const egg = carrier.eggBody;
  if (egg === null || egg.by >= 0) return;
  egg.by = by;
  egg.health = 0;
  out.push({ type: 'egg', slot: carrier.slot, by });
  const eater = enc.fighters[by];
  if (eater !== undefined && eater.status === 'in') {
    reward(eater, carrier.body.biomass, E.egg.eatShare);
  }
}

function kills(enc: Encounter, alive: Fighter[], out: EncounterEvent[]): void {
  const dead: Fighter[] = [];
  for (const f of alive) {
    if (f.body.health > 0) continue;
    const by = f.lastBy >= 0 ? f.lastBy : null;
    f.body.health = 0;
    f.body.alive = false;
    f.body.cause = 'killed';
    if (by !== null && hasEgg(f)) eatEgg(enc, f, by, out);
    finish(enc, f, 'killed', by);
    dead.push(f);
    out.push({ type: 'death', slot: f.slot, cause: 'killed', by });
  }
  for (const f of dead) {
    const killer = enc.fighters[f.lastBy];
    if (killer !== undefined && killer.status === 'in')
      reward(killer, f.body.biomass, E.reward.share);
  }
}

function startWindups(
  enc: Encounter,
  alive: Fighter[],
  inputs: readonly (FrameInput | null)[],
  t: number,
): void {
  for (const f of alive) {
    const fx = f.fx;
    if (f.status !== 'in' || fx.windupEnd >= 0 || t < fx.readyTick || t < fx.staggerUntil) continue;
    const code = pickCode(enc, f, inputs[f.slot] ?? null);
    if (code < 0 || !inStrikeCode(enc, f, code, strikeReach(f))) continue;
    fx.windupEnd = t + E.strike.windupTicks;
    fx.windupTarget = code;
  }
}

/**
 * The combat of one tick, after movement and collisions. `alive` are the fighters that were in at
 * the start of the tick, in slot order; `inputs` is indexed by slot.
 */
export function combatTick(
  enc: Encounter,
  alive: Fighter[],
  inputs: readonly (FrameInput | null)[],
  impacts: readonly Impact[],
  out: EncounterEvent[],
): void {
  const t = enc.world.tick;
  for (const f of alive) brace(f, inputs[f.slot] ?? null, t);
  const hits: Hit[] = [];
  for (const f of alive) if (f.fx.windupEnd === t) landStrike(enc, f, hits, t);
  for (const im of impacts) ram(hits, im, t);
  apply(enc, hits, t, out);
  kills(enc, alive, out);
  startWindups(enc, alive, inputs, t);
}
