// The strike profile of ADR 0051: what a body's anatomy lets it hit, how far, and how hard.

import { cos } from '../math';
import { hashU32 } from '../prng';
import { RULES } from '../rules';
import { aimAtEgg, EGG_CODE, targetEgg } from './egg';
import { aim, aimAt, radiusOf } from './reach';
import type { Encounter, Fighter, FrameInput } from './types';

const E = RULES.encounter;
/** Slack for distances that rounding leaves a hair past the boundary (bodies pressed together). */
const EPS = 1e-9;

/** The half-angle of the strike cone: the wider of the weapon arc and the mouth's arc, at least `minArc`. */
const strikeArc = (f: Fighter): number =>
  Math.max(f.combat.arc, f.body.phys.mouth.arc, E.strike.minArc);

/** Every mouth nips; a weapon adds up to `powerWeapon` on top (saturating in the weapon power). */
export function strikePower(f: Fighter): number {
  const d = E.damage;
  const w = f.combat.power;
  return d.powerBase + (d.powerWeapon * w) / (w + d.powerHalf);
}

/** Whether `target` lies within `reach` of `attacker` and inside its strike cone. */
export function inStrike(attacker: Fighter, target: Fighter, reach: number): boolean {
  aimAt(attacker.body, target.body);
  return aim.distance <= reach + EPS && aim.cos >= cos(strikeArc(attacker));
}

/** The fighter's target code: the frame input's, if it names a living opponent or a whole egg, else the nearest opponent's slot; -1 for none. */
export function pickCode(enc: Encounter, f: Fighter, input: FrameInput | null): number {
  const want = input === null ? -1 : input.target;
  if (want >= EGG_CODE && targetEgg(enc, f, want) !== null) return want;
  return pickTarget(enc, f, input)?.slot ?? -1;
}

/** Whether the target `code` (a body, or an egg from `EGG_CODE`) lies within `reach` and the strike cone. */
export function inStrikeCode(enc: Encounter, attacker: Fighter, code: number, reach: number) {
  const carrier = code >= EGG_CODE ? targetEgg(enc, attacker, code) : enc.fighters[code];
  if (carrier === undefined || carrier === null) return false;
  if (code < EGG_CODE) return carrier.status === 'in' && inStrike(attacker, carrier, reach);
  aimAtEgg(attacker, carrier.eggBody as NonNullable<Fighter['eggBody']>);
  return aim.distance <= reach + EPS && aim.cos >= cos(strikeArc(attacker));
}

/** The fighter's target body: the frame input's, if it names a living opponent, else the nearest. */
export function pickTarget(enc: Encounter, f: Fighter, input: FrameInput | null): Fighter | null {
  const want = input === null ? -1 : input.target;
  if (want >= 0 && want < E.maxFighters && want !== f.slot) {
    const named = enc.fighters[want];
    if (named !== undefined && named.status === 'in') return named;
  }
  let best: Fighter | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const o of enc.fighters) {
    if (o === f || o.status !== 'in') continue;
    aimAt(f.body, o.body, false);
    if (aim.distance < bestDistance) {
      bestDistance = aim.distance;
      best = o;
    }
  }
  return best;
}

/** The ±`spread` variation of one strike: a hash of the fight's seed, the tick and the striker. */
export function spread(enc: Encounter, tick: number, slot: number): number {
  const u = hashU32(enc.seed[0], enc.seed[1], tick, slot) / 4294967296;
  return 1 + E.damage.spread * (2 * u - 1);
}

/** What armour lets through: 1 - cap x armour, x the target's stance factor for strikes (not rams). */
export const armourFactor = (target: Fighter, stanced = true): number =>
  1 - E.damage.armour * target.combat.armour * (stanced ? E.stance[target.fx.stance].armour : 1);

/** A strike's damage before brace; `armour` is what the target lets through (1 for an egg). */
export function strikeDamage(enc: Encounter, a: Fighter, armour: number, tick: number): number {
  return (
    E.damage.perRadius *
    radiusOf(a.body) *
    strikePower(a) *
    E.stance[a.fx.stance].dealt *
    armour *
    spread(enc, tick, a.slot)
  );
}
