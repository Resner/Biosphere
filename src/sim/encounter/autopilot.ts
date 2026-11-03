// The combat autopilot (ADR 0051, DESIGN §7): the input a fighter without a live player sends. It
// is pure and total: it reads only the encounter's state at the start of the frame and the
// fighter's own behaviour genes, so the referee, the clients and the tournament all derive the same
// frame. The output is always encodable (`encodeFrameInput` accepts it).

import { angleToSteer } from '../input';
import { atan2 } from '../math';
import { RULES } from '../rules';
import { maxHealth } from '../vitals';
import { aimAtEgg, EGG_CODE, hasEgg } from './egg';
import { aim, aimAt, radiusOf, strikeReach } from './reach';
import { armourFactor, pickTarget, strikePower } from './strike';
import type { Encounter, Fighter, FrameInput, TargetPref } from './types';

const E = RULES.encounter;
const A = E.autopilot;

/** The codec's top throttle. */
const FULL = 15;

const standing = (f: Fighter): boolean => f.status === 'in';

/** The living opponents of `f`, in slot order. */
function opponents(enc: Encounter, f: Fighter): Fighter[] {
  return enc.fighters.filter((o) => o !== f && standing(o));
}

/** A target's value under a preference: lower is better. Eggs have none under `largest` and `strongest`. */
function score(
  pref: TargetPref,
  f: Fighter,
  o: Fighter,
  egg: boolean,
  distance: number,
): number | null {
  switch (pref) {
    case 'nearest':
      return distance;
    case 'weakest':
      return egg ? (o.eggBody as NonNullable<Fighter['eggBody']>).health : o.body.health;
    case 'largest':
      return egg ? null : -o.body.biomass;
    case 'strongest':
      // What one of its strikes does to `f`: its radius, its strike power and `f`'s armour.
      return egg
        ? null
        : -(
            E.damage.perRadius *
            Math.sqrt(o.body.biomass) *
            strikePower(o) *
            armourFactor(f, false)
          );
  }
}

/** The target code the fighter's preference picks among living opponents and their whole eggs; -1 for none. */
function pickByPreference(enc: Encounter, f: Fighter, foes: readonly Fighter[]): number {
  const pref = f.behaviour.targetPref;
  let best = -1;
  let bestScore = Number.POSITIVE_INFINITY;
  // Slot order, body before egg; only a strictly better score replaces the leader.
  for (const o of foes) {
    aimAt(f.body, o.body, false);
    const body = score(pref, f, o, false, aim.distance);
    if (body !== null && body < bestScore) {
      bestScore = body;
      best = o.slot;
    }
    if (!hasEgg(o)) continue;
    aimAtEgg(f, o.eggBody as NonNullable<Fighter['eggBody']>);
    const egg = score(pref, f, o, true, aim.distance);
    if (egg !== null && egg < bestScore) {
      bestScore = egg;
      best = EGG_CODE + o.slot;
    }
  }
  return best;
}

/** Whether a windup aimed at `f` or its egg lands within `braceTicks` ticks. */
function incoming(enc: Encounter, f: Fighter, tick: number): boolean {
  for (const o of enc.fighters) {
    if (o === f || !standing(o) || o.fx.windupEnd < tick) continue;
    if (o.fx.windupEnd - tick > A.braceTicks) continue;
    if (o.fx.windupTarget === f.slot || o.fx.windupTarget === EGG_CODE + f.slot) return true;
  }
  return false;
}

/** Whether `f` should run: badly hurt for its caution, or facing a much bigger body. */
function shouldFlee(f: Fighter, foes: readonly Fighter[]): boolean {
  const b = f.behaviour;
  if (f.body.health < b.caution * A.fleeHealth * maxHealth(f.body.biomass)) return true;
  if (b.caution <= A.fleeCaution) return false;
  return foes.some((o) => o.body.biomass > A.fleeSize * f.body.biomass);
}

/** The steer for a heading, offset in rad. */
const steerFor = (dx: number, dy: number, offset = 0): number =>
  angleToSteer(atan2(dy, dx) + offset);

/** The frame input of the fighter in `slot`, from the state at the start of the frame. */
export function autopilot(enc: Encounter, slot: number): FrameInput {
  const f = enc.fighters[slot] as Fighter;
  const b = f.behaviour;
  const tick = enc.world.tick;
  const foes = opponents(enc, f);
  const stance =
    b.aggression >= A.aggressiveAt
      ? 'aggressive'
      : b.caution >= A.evasiveAt
        ? 'evasive'
        : 'balanced';
  if (foes.length === 0) {
    return {
      steer: angleToSteer(f.body.heading),
      throttle: 0,
      dash: false,
      stance,
      target: 0,
      brace: false,
    };
  }

  const brace =
    b.reflex >= A.braceReflex &&
    tick >= f.fx.braceReady &&
    f.body.energy >= E.brace.energyPerBiomass * f.body.biomass &&
    incoming(enc, f, tick);
  const dashReady = tick >= f.body.dashReadyTick;

  if (shouldFlee(f, foes)) {
    const nearest = pickTarget(enc, f, null) as Fighter;
    aimAt(f.body, nearest.body, false);
    return {
      steer: steerFor(-aim.dx, -aim.dy),
      throttle: FULL,
      dash: dashReady && b.reflex >= A.fleeDashReflex,
      stance: 'evasive',
      target: nearest.slot,
      brace,
    };
  }

  const code = pickByPreference(enc, f, foes);
  const carrier = code >= EGG_CODE ? (enc.fighters[code - EGG_CODE] as Fighter) : null;
  if (carrier !== null) aimAtEgg(f, carrier.eggBody as NonNullable<Fighter['eggBody']>);
  else aimAt(f.body, (enc.fighters[code] as Fighter).body, false);
  const reach = strikeReach(f);
  const distance = aim.distance;
  const offset = (b.curiosity - 0.5) * A.circle;
  return {
    steer: steerFor(aim.dx, aim.dy, offset),
    throttle: distance > A.closeIn * reach ? FULL : A.cruise,
    dash:
      dashReady &&
      b.aggression >= A.dashAggression &&
      distance > A.dashMin * reach &&
      distance < A.dashMax * reach,
    stance,
    target: code,
    brace,
  };
}
