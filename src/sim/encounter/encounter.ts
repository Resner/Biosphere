// The encounter simulation (ADR 0050): the one function the referee, every client and the tournament
// step. A frame is 3 ticks; the fighters live in plain pond water (currents, plumes, UV and pressure
// apply, food does not). Strikes come with T2, the autopilot with T4.

import { isPhysShape, sanitizeCombat, sanitizePhys } from '../body';
import { Hasher } from '../hash';
import { applyHazards } from '../hazards';
import { IDLE } from '../input';
import { applyMetabolism } from '../metabolism';
import { applyMovement } from '../physics';
import { RULES } from '../rules';
import { hashCreature, hashWorld } from '../state-hash';
import { stepCreature } from '../step';
import type { CreatureState, StepEvent } from '../types';
import { createWorld } from '../world';
import { sanitizeBehaviour } from './behaviour';
import { decodeFrameInput } from './codec';
import { collide } from './collide';
import { engageRange, strikeDistance } from './reach';
import type {
  Encounter,
  EncounterEvent,
  EncounterStart,
  Fighter,
  FighterResult,
  FighterStart,
  FrameInput,
  Outcome,
} from './types';

const E = RULES.encounter;

const NUMBERS = ['x', 'y', 'vx', 'vy', 'heading', 'biomass', 'energy', 'health'] as const;

function validate(start: EncounterStart): void {
  const n = start.fighters.length;
  if (n < 1 || n > E.maxFighters) throw new RangeError(`an encounter holds 1 to ${E.maxFighters}`);
  if (!Number.isFinite(start.size) || start.size <= 0) throw new RangeError('bad pond size');
  if (!Number.isInteger(start.t0) || start.t0 < 0) throw new RangeError('bad start tick');
  const seen = new Set<string>();
  for (const f of start.fighters) {
    for (const key of NUMBERS) {
      if (!Number.isFinite(f[key])) throw new RangeError(`fighter ${f.creature}: bad ${key}`);
    }
    if (f.biomass <= 0 || f.health < 0 || f.energy < 0) throw new RangeError('bad fighter vitals');
    if (!isPhysShape(f.phys)) throw new RangeError(`fighter ${f.creature}: not a body`);
    if (seen.has(f.creature)) throw new RangeError(`creature ${f.creature} fights twice`);
    seen.add(f.creature);
  }
}

function seatFighter(slot: number, f: FighterStart, t0: number): Fighter {
  const body: CreatureState = {
    id: f.creature,
    x: f.x,
    y: f.y,
    vx: f.vx,
    vy: f.vy,
    heading: f.heading,
    biomass: f.biomass,
    energy: f.energy,
    health: f.health,
    dashReadyTick: 0,
    alive: true,
    elder: f.elder,
    cause: null,
    bornTick: t0,
    phys: sanitizePhys(f.phys),
  };
  return {
    slot,
    player: f.player,
    creature: f.creature,
    body,
    combat: sanitizeCombat(f.combat),
    behaviour: sanitizeBehaviour(f.behaviour),
    egg: f.egg,
    status: 'in',
    outside: 0,
    result: null,
  };
}

/** Fighters take slots in creature-id order; the world starts at tick `t0`. */
export function createEncounter(start: EncounterStart): Encounter {
  validate(start);
  const world = createWorld({ seed: start.pondSeed, size: start.size });
  world.tick = start.t0;
  const ordered = [...start.fighters].sort((a, b) => (a.creature < b.creature ? -1 : 1));
  return {
    id: start.id,
    seed: [...start.seed] as Encounter['seed'],
    t0: start.t0,
    frame: 0,
    over: false,
    world,
    fighters: ordered.map((f, slot) => seatFighter(slot, f, start.t0)),
  };
}

function resultOf(f: Fighter, outcome: Outcome, by: number | null, frame: number): FighterResult {
  return {
    outcome,
    cause: f.body.cause,
    by,
    frame,
    egg: f.egg ? 'kept' : 'none',
    eggBy: null,
  };
}

function finish(enc: Encounter, f: Fighter, outcome: Outcome, by: number | null): void {
  f.status = outcome;
  f.result = resultOf(f, outcome, by, enc.frame);
}

const living = (enc: Encounter): Fighter[] => enc.fighters.filter((f) => f.status === 'in');

/** Whether `f` is outside the escape range of every living opponent; a lone fighter never is. */
function outsideAll(enc: Encounter, f: Fighter): boolean {
  let any = false;
  for (const o of enc.fighters) {
    if (o === f || o.status !== 'in') continue;
    any = true;
    if (strikeDistance(o.body, f.body) <= E.escapeFactor * engageRange(o, f)) return false;
  }
  return any;
}

/** One fighter's tick: the shared creature tick without eating, at its stance's thrust. */
function stepFighter(enc: Encounter, f: Fighter, input: FrameInput | null): StepEvent[] {
  const boost = E.stance[input?.stance ?? 'balanced'].thrust;
  return stepCreature(enc.world, f.body, input ?? IDLE, {
    feeding: false,
    mods: { thrust: boost, turn: boost },
  });
}

const speedOf = (f: Fighter): number => f.body.vx * f.body.vx + f.body.vy * f.body.vy;

/** Steps one frame: 3 ticks. `null` is the fallback marker (idle until the autopilot, T4). No-op once over. */
export function stepFrame(enc: Encounter, inputs: readonly (number | null)[]): EncounterEvent[] {
  const out: EncounterEvent[] = [];
  if (enc.over) return out;
  enc.frame++;
  const decoded = enc.fighters.map((_, slot) => {
    const code = inputs[slot] ?? null;
    return code === null ? null : decodeFrameInput(code);
  });

  for (let tick = 0; tick < E.frameTicks && !enc.over; tick++) {
    for (const f of enc.fighters) {
      if (f.status !== 'in') continue;
      for (const e of stepFighter(enc, f, decoded[f.slot] ?? null)) {
        if (e.type !== 'death') continue;
        finish(enc, f, 'died', null);
        out.push({ type: 'death', slot: f.slot, cause: e.cause });
      }
    }
    const alive = living(enc);
    collide(alive);
    const escaping: Fighter[] = [];
    for (const f of alive) {
      f.outside = outsideAll(enc, f) ? f.outside + 1 : 0;
      if (f.outside >= E.escapeTicks) escaping.push(f);
    }
    // Two fighters drifting apart are outside each other's range at once: the faster one escapes
    // (ties by slot) and the fight ends with the other standing.
    if (escaping.length > 1) escaping.sort((a, b) => speedOf(b) - speedOf(a) || a.slot - b.slot);
    let remaining = alive.length;
    for (const f of escaping) {
      if (remaining < 2) break;
      finish(enc, f, 'escaped', null);
      out.push({ type: 'escape', slot: f.slot });
      remaining--;
    }
    enc.world.tick++;
    // The fight ends once someone has left and fewer than two remain.
    if (remaining < 2 && remaining < enc.fighters.length) end(enc, out);
  }
  if (!enc.over && enc.frame >= E.timeoutFrames) end(enc, out);
  return out;
}

/** Everyone still in stands; the fight never changes again. */
function end(enc: Encounter, out: EncounterEvent[]): void {
  enc.over = true;
  for (const f of living(enc)) finish(enc, f, 'stood', null);
  out.push({ type: 'end', frame: enc.frame });
}

/** One result per slot; a fighter still in reads as standing at the current frame. */
export function results(enc: Encounter): FighterResult[] {
  return enc.fighters.map((f) => f.result ?? resultOf(f, 'stood', null, enc.frame));
}

export function hashEncounter(enc: Encounter): string {
  const h = new Hasher();
  h.str(enc.id)
    .u32(enc.t0)
    .u32(enc.frame)
    .u32(enc.over ? 1 : 0)
    .str(hashWorld(enc.world));
  for (const lane of enc.seed) h.u32(lane);
  h.u32(enc.fighters.length);
  for (const f of enc.fighters) {
    h.u32(f.slot).str(f.player).str(f.creature);
    hashCreature(h, f.body);
    const c = f.combat;
    h.f64(c.reach).f64(c.arc).f64(c.power).f64(c.armour).f64(c.spines).f64(c.mass);
    const b = f.behaviour;
    h.f64(b.aggression).f64(b.caution).f64(b.curiosity).f64(b.reflex).str(b.targetPref);
    h.u32(f.egg ? 1 : 0)
      .str(f.status)
      .u32(f.outside);
    const r = f.result;
    h.u32(r === null ? 0 : 1);
    if (r !== null) {
      h.str(r.outcome)
        .str(r.cause ?? '')
        .i32(r.by ?? -1)
        .u32(r.frame);
      h.str(r.egg).i32(r.eggBy ?? -1);
    }
  }
  return h.digest();
}
