// Lock-in on the authority (ADR 0050, M7 T8): an engage is checked against both signed snapshots,
// the target is asked for its own state, and both players get the same `enc-start`. Nothing here
// writes SQLite, except a flag when a snapshot claims more than the growth curve allows.

import { bytesToHex } from '@noble/hashes/utils.js';
import { genomeFromBase64url } from '../src/genome/codec';
import { fighterOf } from '../src/genome/fighter';
import { buildCreature } from '../src/genome/stats';
import { randomnessOf } from '../src/ledger/drand';
import { encounterId, encounterSeed } from '../src/ledger/encounter';
import { verifySnap } from '../src/ledger/snapshot-sig';
import type { EncStart } from '../src/net/encounter-start';
import { type ClientMsg, type FighterInfo, genomeRefOf, type Snapshot } from '../src/net/protocol';
import type { PhysStats } from '../src/sim/body';
import { currentAt } from '../src/sim/currents';
import { engageRange, type Reacher, strikeDistance } from '../src/sim/encounter/reach';
import type { FighterStart } from '../src/sim/encounter/types';
import { RULES, TICK_HZ } from '../src/sim/rules';
import { sizeTier } from '../src/sim/size';
import type { CreatureState, World } from '../src/sim/types';
import { maxEnergy, maxHealth } from '../src/sim/vitals';
import { createWorld } from '../src/sim/world';
import { admit, type Fight, joinable, type Lock, runFight } from './fights';
import type { Head } from './ledger';
import { type Condition, clampClaim, type LifeState } from './life';
import type { PondRow } from './schema';
import {
  type ActiveSession,
  type Hub,
  type Session,
  seated,
  sendIfOpen,
  sessionOf,
} from './socket';

const E = RULES.encounter;
const HUNDREDTHS = 100;
/** Clock slack either way on a snapshot's pond tick. */
const SLACK_TICKS = 3;
/** A snapshot's biomass is log-quantised (0.013%): a claim this close to its cap is clamped without a flag. */
const QUANTISED = 0.001;
/** Lock ids are 16 random bytes as hex. */
const LOCK_BYTES = 16;

/** One side of an engage, as checked: who, which creature, and the snapshot its start comes from. */
export interface Side {
  player: string;
  creature: string;
  /** The genome as text, sent in `enc-start`. */
  genome: string;
  stats: Pick<FighterStart, 'phys' | 'combat'>;
  snap: Snapshot;
  /** The snapshot's condition after the growth-curve clamp, in hundredths. */
  condition: Condition;
  life: LifeState;
}

/** What a lock keeps while the target's own state is awaited. */
export interface Asking {
  pond: Pick<PondRow, 'id' | 'seed' | 'epoch'>;
  attacker: Side;
  target: Side;
}

/** An engage into a running fight (M7 T15): the side that joins it, checked as at lock-in. */
interface Joining {
  pond: Asking['pond'];
  lock: Lock;
  fight: Fight;
  joiner: Side;
}

/** The pond tick at hub time `now`. */
const pondTick = (now: number, epoch: number): number =>
  Math.floor(((now - epoch) * TICK_HZ) / 1000);

/** Speed through the water at full thrust, plus the strongest current, in wu/s. */
function topSpeed(phys: PhysStats, biomass: number): number {
  const m = RULES.movement;
  const scale = (biomass / RULES.starter.biomass) ** m.thrustExp;
  return (m.thrust * phys.thrust * scale) / (m.drag * phys.drag) + RULES.currents.maxSpeed;
}

/** A snapshot's condition in hundredths (it carries energy and health as shares of their maximum). */
function claimOf(s: Snapshot): Condition {
  return {
    biomass: Math.floor(s.biomass * HUNDREDTHS),
    energy: Math.floor(s.energy * maxEnergy(s.biomass) * HUNDREDTHS),
    health: Math.floor(s.health * maxHealth(s.biomass) * HUNDREDTHS),
  };
}

/** A body for the reach rules, at the snapshot's place and the clamped size. */
function reacher(side: Side): Reacher {
  const s = side.snap;
  const body: CreatureState = {
    id: side.creature,
    x: s.x,
    y: s.y,
    vx: s.vx,
    vy: s.vy,
    heading: s.heading,
    biomass: side.condition.biomass / HUNDREDTHS,
    energy: side.condition.energy / HUNDREDTHS,
    health: side.condition.health / HUNDREDTHS,
    dashReadyTick: 0,
    alive: true,
    elder: false,
    cause: null,
    bornTick: 0,
    phys: side.stats.phys,
  };
  return { body, combat: side.stats.combat };
}

/** Whether the snapshot is from the last `snapshotMaxAge` ticks of pond time (with clock slack either way). */
const fresh = (s: Snapshot, nowTick: number): boolean =>
  s.tick >= nowTick - E.snapshotMaxAge - SLACK_TICKS && s.tick <= nowTick + SLACK_TICKS;

/**
 * A side from its verified snapshot: null when the snapshot is not of the player's living, active
 * creature. The clamp's new flags are noted once per connection, and kept in its attachment.
 */
function sideOf(
  hub: Hub,
  ws: WebSocket,
  life: LifeState,
  head: Head,
  snap: Snapshot,
  now: number,
): Side | null {
  const genome = genomeFromBase64url(head.genome);
  if (!genome || !snap.alive) return null;
  const creature = buildCreature(genome);
  if (genomeRefOf(creature.hash) !== snap.genomeRef) return null;
  const { condition, flagged, newFlags } = clampClaim(life, claimOf(snap), now, QUANTISED);
  for (const kind of newFlags) hub.ledger.flagImplausible(kind, head.owner, head.id, now);
  let kept = life;
  if (flagged !== life.flagged) {
    kept = { ...life, flagged };
    const session = sessionOf(ws);
    if (session?.phase === 'active' && session.life?.creature === life.creature) {
      ws.serializeAttachment({ ...session, life: { ...session.life, flagged } } satisfies Session);
    }
  }
  return {
    player: head.owner,
    creature: head.id,
    genome: head.genome,
    stats: fighterOf(creature),
    snap,
    condition,
    life: kept,
  };
}

/** The player's living creature on this connection, when the ledger has it active. */
function liveHead(hub: Hub, session: ActiveSession): { life: LifeState; head: Head } | null {
  const life = session.life;
  if (!life || life.over) return null;
  const head = hub.ledger.head(life.creature);
  return head?.status === 'active' && head.owner === session.playerId ? { life, head } : null;
}

/**
 * `engage` (ADR 0050): the checks, then both are locked and the target is asked for its own
 * state. The attacker's spawn protection ends here, whatever comes of the engage.
 */
export function engage(
  hub: Hub,
  ws: WebSocket,
  session: ActiveSession,
  msg: ClientMsg & { t: 'engage' },
): void {
  if (session.protectedUntil !== undefined) {
    ws.serializeAttachment({ ...session, protectedUntil: undefined } satisfies Session);
  }
  const checked = check(hub, ws, session, msg, hub.clock.now());
  if (typeof checked === 'string') {
    sendIfOpen(ws, { t: 'refused', reason: checked });
    return;
  }
  if ('joining' in checked) {
    const { pond, lock, fight, joiner } = checked.joining;
    const world = createWorld({ seed: pond.seed, size: RULES.world.size });
    if (!admit(hub, lock, fight, (tick) => fighterInfo(hub, joiner, world, tick))) {
      sendIfOpen(ws, { t: 'refused', reason: 'engage:stale' });
    }
    return;
  }
  const { asking, targetWs } = checked;
  const { attacker, target } = asking;
  const id = bytesToHex(crypto.getRandomValues(new Uint8Array(LOCK_BYTES)));
  const lock = hub.fights.open(
    id,
    [attacker.player, target.player],
    [attacker.creature, target.creature],
    E.lockAnswerMs,
    () => start(hub, id),
  );
  lock.asking = asking;
  sendIfOpen(targetWs, { t: 'lock-ask', lock: id });
}

/** The checks of an engage in order: the refusal reason (`engage:<why>`) of the first that fails, or both sides. */
function check(
  hub: Hub,
  ws: WebSocket,
  session: ActiveSession,
  msg: ClientMsg & { t: 'engage' },
  now: number,
): string | { asking: Asking; targetWs: WebSocket } | { joining: Joining } {
  const mine = liveHead(hub, session);
  if (!mine) return 'no-creature';
  if (msg.target === session.playerId) return 'engage:self';
  const found = seated(hub, msg.target);
  const theirs = found ? liveHead(hub, found[1]) : null;
  if (!found || !theirs) return 'engage:target';
  const [targetWs, targetSession] = found;
  if (targetSession.pondId !== session.pondId) return 'engage:pond';
  const pond = hub.ctx.storage.sql
    .exec<PondRow>('SELECT id, seed, epoch FROM ponds WHERE id = ?', session.pondId)
    .toArray()[0];
  if (!pond) return 'engage:pond';

  const ownSnap = verifySnap(session.playerId, pond.id, msg.mine);
  const targetSnap = verifySnap(msg.target, pond.id, msg.theirs);
  if (!ownSnap || !targetSnap) return 'engage:signature';
  const nowTick = pondTick(now, pond.epoch);
  if (!fresh(ownSnap, nowTick) || !fresh(targetSnap, nowTick)) return 'engage:stale';
  const attacker = sideOf(hub, ws, mine.life, mine.head, ownSnap, now);
  const target = sideOf(hub, targetWs, theirs.life, theirs.head, targetSnap, now);
  if (!attacker || !target) return 'engage:stale';

  const tierGap = Math.abs(
    sizeTier(attacker.condition.biomass / HUNDREDTHS) -
      sizeTier(target.condition.biomass / HUNDREDTHS),
  );
  if (tierGap > E.maxTierGap) return 'engage:tier';
  if ((targetSession.protectedUntil ?? 0) > now) return 'engage:protected';
  const fights = hub.fights;
  const lockOf = (s: Side) => fights.ofPlayer(s.player) ?? fights.ofCreature(s.creature);
  const attackerLock = lockOf(attacker);
  const targetLock = lockOf(target);
  // One side already fighting: the other joins that fight (M7 T15); both locked, nobody joins.
  const lock = attackerLock ?? targetLock;
  if (attackerLock && targetLock) return 'engage:locked';
  if (lock && (!lock.fight || lock.fight.enc.over)) return 'engage:locked';
  if (lock?.fight && !joinable(lock.fight)) return 'engage:full';
  if (!inRange(attacker, target, nowTick)) return 'engage:range';
  const ponded = { id: pond.id, seed: pond.seed, epoch: pond.epoch };
  if (lock?.fight) {
    const joiner = attackerLock ? target : attacker;
    return { joining: { pond: ponded, lock, fight: lock.fight, joiner } };
  }
  return { asking: { pond: ponded, attacker, target }, targetWs };
}

/** Within the attacker's engage range of the target, with slack for how far either may have swum since its snapshot. */
function inRange(attacker: Side, target: Side, nowTick: number): boolean {
  const a = reacher(attacker);
  const b = reacher(target);
  const age = Math.max(0, nowTick - Math.min(attacker.snap.tick, target.snap.tick)) / TICK_HZ;
  const speed = Math.max(
    topSpeed(a.body.phys, a.body.biomass),
    topSpeed(b.body.phys, b.body.biomass),
  );
  return strikeDistance(a.body, b.body) <= engageRange(a, b) + 2 * speed * age;
}

/**
 * The target's `lock-state`: its own signed state replaces the attacker's copy and the fight
 * starts at once. Anything else (another lock, a late, stale or older answer) is dropped, and the
 * window's end uses the attacker's copy.
 */
export function lockAnswer(
  hub: Hub,
  ws: WebSocket,
  session: ActiveSession,
  msg: ClientMsg & { t: 'lock-state' },
): void {
  const lock = hub.fights.get(msg.lock);
  const asking = lock?.asking;
  if (!lock || !asking || asking.target.player !== session.playerId) return;
  const now = hub.clock.now();
  const snap = verifySnap(session.playerId, asking.pond.id, msg.mine);
  if (!snap || snap.tick < asking.target.snap.tick) return;
  if (!fresh(snap, pondTick(now, asking.pond.epoch))) return;
  const head = hub.ledger.head(asking.target.creature);
  const side = head ? sideOf(hub, ws, asking.target.life, head, snap, now) : null;
  if (!side) return;
  asking.target = side;
  start(hub, msg.lock);
}

/** Decides the lock: both get the same `enc-start`, frame 0 `startDelayMs` from now. */
function start(hub: Hub, id: string): void {
  const lock = hub.fights.get(id);
  const asking = lock?.asking;
  if (!lock || !asking) return;
  lock.asking = null;
  const now = hub.clock.now();
  const at = now + E.startDelayMs;
  const t0 = pondTick(at, asking.pond.epoch);
  const world = createWorld({ seed: asking.pond.seed, size: RULES.world.size });
  const sides = [asking.attacker, asking.target];
  const fighters = sides
    .map((side) => fighterInfo(hub, side, world, t0))
    .sort((a, b) => (a.creature < b.creature ? -1 : 1));
  const heads = sides.map((s) => hub.ledger.head(s.creature)?.hash ?? s.creature);
  const enc = encounterId(heads, now);
  const beacon = hub.beacons.newestKnown();
  const seed = encounterSeed(beacon ? randomnessOf(beacon) : new Uint8Array(0), enc);
  const msg: EncStart = { t: 'enc-start', enc, seed, round: beacon?.round ?? 0, t0, at, fighters };
  if (!runFight(hub, lock, msg, asking.pond.seed)) {
    hub.fights.release(id);
    return;
  }
  for (const player of lock.players) {
    const found = seated(hub, player);
    if (found) sendIfOpen(found[0], msg);
  }
}

/** A side's start: its snapshot carried in a straight line (velocity plus the current) to tick `t0` (frame 0's, or a join's). */
function fighterInfo(hub: Hub, side: Side, world: World, t0: number): FighterInfo {
  const s = side.snap;
  world.tick = s.tick;
  const current = currentAt(world, s.x, s.y);
  const dt = (t0 - s.tick) / TICK_HZ;
  const inside = (v: number) => Math.min(world.size, Math.max(0, v));
  const life = side.life;
  return {
    player: side.player,
    creature: side.creature,
    genome: side.genome,
    x: inside(s.x + (s.vx + current.x) * dt),
    y: inside(s.y + (s.vy + current.y) * dt),
    vx: s.vx,
    vy: s.vy,
    heading: s.heading,
    biomass: side.condition.biomass / HUNDREDTHS,
    energy: side.condition.energy / HUNDREDTHS,
    health: side.condition.health / HUNDREDTHS,
    elder: life.activeMs >= RULES.life.elderAt * life.lifespanMs,
    egg: hub.ledger.pending(side.player) !== null,
  };
}

/** The messages that change a player's life, refused `locked` while it is in a fight. */
export const LOCK_BARRED: ReadonlySet<ClientMsg['t']> = new Set<ClientMsg['t']>([
  'genesis-request',
  'promote',
  'restore',
]);

/** Refuses a promotion, restore or genesis while the player is locked in a fight; true when it did. */
export function lockedOut(hub: Hub, ws: WebSocket, session: ActiveSession): boolean {
  if (!hub.fights.playerLocked(session.playerId)) return false;
  sendIfOpen(ws, { t: 'refused', reason: 'locked' });
  return true;
}
