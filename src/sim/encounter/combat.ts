// Combat inside one tick of a fight (ADR 0051): brace, landing strikes and rams, spines, kills and
// their rewards, then new windups. Damage is gathered first and applied together, so two fighters
// that hit each other on the same tick both land. Timers are absolute pond ticks.

import { RULES } from '../rules';
import { sizeTier } from '../size';
import { maxEnergy } from '../vitals';
import { finish } from './outcome';
import { radiusOf, strikeReach } from './reach';
import { inStrike, pickTarget, strikeDamage } from './strike';
import type { Encounter, EncounterEvent, Fighter, FrameInput, HitKind } from './types';

const E = RULES.encounter;

/** A pair pressed together in a tick: the fighters, the closing speed, and whether `a` is the rammer. */
export interface Impact {
  a: Fighter;
  b: Fighter;
  closing: number;
  aRams: boolean;
}

interface Hit {
  victim: Fighter;
  by: Fighter;
  kind: HitKind;
  amount: number;
  blocked: boolean;
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

/** Queues a hit with brace and spines applied: a blocked hit is cut and staggers its attacker. */
function queue(hits: Hit[], by: Fighter, victim: Fighter, kind: HitKind, raw: number, t: number) {
  const blocked = t <= victim.fx.braceUntil;
  const amount = blocked ? raw * (1 - E.brace.block) : raw;
  hits.push({ victim, by, kind, amount, blocked });
  if (amount > 0 && victim.combat.spines > 0) {
    const back = E.spineReturn * victim.combat.spines * amount;
    hits.push({ victim: by, by: victim, kind: 'spines', amount: back, blocked: false });
  }
}

function landStrike(enc: Encounter, f: Fighter, hits: Hit[], t: number): void {
  const target = enc.fighters[f.fx.windupTarget];
  f.fx.windupEnd = -1;
  f.fx.readyTick = t + E.strike.recoverTicks;
  if (target === undefined || target.status !== 'in') return;
  if (!inStrike(f, target, E.strike.tolerance * strikeReach(f))) return;
  queue(hits, f, target, 'strike', strikeDamage(enc, f, target, t), t);
}

function ram(hits: Hit[], im: Impact, t: number): void {
  const [by, victim] = im.aRams ? [im.a, im.b] : [im.b, im.a];
  const r = E.ram;
  if (im.closing <= r.minSpeed || t < (by.fx.ramReady[victim.slot] ?? 0)) return;
  by.fx.ramReady[victim.slot] = t + r.cooldownTicks;
  victim.fx.ramReady[by.slot] = t + r.cooldownTicks;
  const share = by.combat.mass / (by.combat.mass + victim.combat.mass);
  const power = Math.min(1, (im.closing - r.minSpeed) / r.speedSpan);
  const raw =
    r.perRadius *
    radiusOf(by.body) *
    power *
    2 *
    share *
    (1 - E.damage.armour * victim.combat.armour);
  queue(hits, by, victim, 'ram', raw, t);
}

function apply(hits: Hit[], t: number, out: EncounterEvent[]): void {
  for (const h of hits) {
    h.victim.body.health -= h.amount;
    h.victim.lastBy = h.by.slot;
    out.push({
      type: 'hit',
      tick: t,
      slot: h.victim.slot,
      by: h.by.slot,
      kind: h.kind,
      amount: h.amount,
      blocked: h.blocked,
    });
    if (h.blocked) {
      h.by.fx.staggerUntil = t + E.brace.staggerTicks;
      h.by.fx.windupEnd = -1;
    }
  }
}

/** The killer takes a share of the victim's biomass as biomass, the overflow as energy (ADR 0051). */
function reward(killer: Fighter, victimBiomass: number): void {
  const rw = E.reward;
  const mine = sizeTier(killer.body.biomass);
  const theirs = sizeTier(victimBiomass);
  const tier = theirs < mine ? rw.smallerTier : theirs > mine ? rw.biggerTier : 1;
  const gain = rw.share * victimBiomass * tier;
  const b = killer.body;
  const before = b.biomass;
  const grown = Math.min(gain, Math.max(0, b.phys.maxBiomass - before));
  b.biomass = before + grown;
  b.energy = Math.min(maxEnergy(b.biomass), b.energy + (gain - grown) * rw.energyPerBiomass);
  b.health += RULES.creature.healthPerRadius * (Math.sqrt(b.biomass) - Math.sqrt(before));
}

function kills(enc: Encounter, alive: Fighter[], out: EncounterEvent[]): void {
  const dead: Fighter[] = [];
  for (const f of alive) {
    if (f.status !== 'in' || f.body.health > 0) continue;
    f.body.health = 0;
    f.body.alive = false;
    f.body.cause = 'killed';
    finish(enc, f, 'killed', f.lastBy >= 0 ? f.lastBy : null);
    dead.push(f);
    out.push({ type: 'death', slot: f.slot, cause: 'killed', by: f.lastBy >= 0 ? f.lastBy : null });
  }
  for (const f of dead) {
    const killer = enc.fighters[f.lastBy];
    if (killer !== undefined && killer.status === 'in') reward(killer, f.body.biomass);
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
    const target = pickTarget(enc, f, inputs[f.slot] ?? null);
    if (target === null || !inStrike(f, target, strikeReach(f))) continue;
    fx.windupEnd = t + E.strike.windupTicks;
    fx.windupTarget = target.slot;
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
  for (const f of alive) if (f.status === 'in') brace(f, inputs[f.slot] ?? null, t);
  const hits: Hit[] = [];
  for (const f of alive) if (f.status === 'in' && f.fx.windupEnd === t) landStrike(enc, f, hits, t);
  for (const im of impacts) ram(hits, im, t);
  apply(hits, t, out);
  kills(enc, alive, out);
  startWindups(enc, alive, inputs, t);
}
