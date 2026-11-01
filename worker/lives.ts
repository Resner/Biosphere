// Genesis and life: hatching, progress and death, history and lineage, promotion and restore.
import { type Genome, genomeFromBase64url, genomeToBase64url } from '../src/genome/codec';
import { express } from '../src/genome/express';
import { speciesName } from '../src/genome/names';
import { type GenesisAsk, verifyGenesisAsk } from '../src/ledger/ask';
import { randomnessOf } from '../src/ledger/drand';
import { genesisFor, genesisRequest as genesisRecordRequest } from '../src/ledger/genesis';
import type { RecordRequest } from '../src/ledger/record';
import {
  type ClientMsg,
  type FallbackInfo,
  HISTORY_MAX,
  type HubMsg,
  LINEAGE_MAX,
  type LifeInfo,
  type LineageEntry,
  PEDIGREE_MAX,
  type PedigreeNode,
} from '../src/net/protocol';
import { lifespanMs } from '../src/sim/life';
import { RULES, RULES_VERSION } from '../src/sim/rules';
import type { DeathCause } from '../src/sim/types';
import { type Condition, conditionOf, type Exhaustion, type Head } from './ledger';
import {
  applyReport,
  bindLife,
  checkpointDue,
  creditTicks,
  isOld,
  type LifeState,
  unsaved,
} from './life';
import { fixtureScale, matureAtMsOf as matureAtOfLifespan } from './mating';
import { bornFor, deliverBirth } from './offspring';
import {
  type ActiveSession,
  activeSessions,
  causeOf,
  type Hub,
  type Session,
  sendIfOpen,
  signedOf,
} from './socket';

/** Starts a genesis request after any earlier one from the same player has finished. */
export function queueGenesis(
  hub: Hub,
  ws: WebSocket,
  session: ActiveSession,
  msg: ClientMsg & { t: 'genesis-request' },
): void {
  const earlier = hub.asking.get(session.playerId) ?? Promise.resolve();
  const run: Promise<void> = earlier
    .then(() => genesisRequest(hub, ws, session.playerId, msg))
    .catch(() => sendIfOpen(ws, { t: 'error', code: 'genesis-failed' }))
    .finally(() => {
      if (hub.asking.get(session.playerId) === run) hub.asking.delete(session.playerId);
    });
  hub.asking.set(session.playerId, run);
}

/**
 * ADR 0019: commits to a future round for the player's next creature. The same request returns the
 * same commitment, and a player who already has one waiting gets that one back, never a second round.
 */
export async function genesisRequest(
  hub: Hub,
  ws: WebSocket,
  owner: string,
  ask: GenesisAsk,
): Promise<void> {
  if (!verifyGenesisAsk(owner, ask)) {
    sendIfOpen(ws, { t: 'refused', reason: 'bad-signature' });
    return;
  }
  const data = { nonce: ask.nonce, sig: ask.sig };
  const bucket = hub.ledger.hatches(owner, Date.now());
  let hatchesLeft = bucket.left;
  let commit = hub.beacons.find('genesis', owner, data);
  if (
    commit &&
    commit.id !== hub.ledger.pendingCommit(owner) &&
    !isActiveBirth(hub, owner, commit.id)
  ) {
    // A signed ask is good for one creature: replaying it after that creature is gone gets nothing.
    sendIfOpen(ws, { t: 'refused', reason: 'used' });
    return;
  }
  if (!commit) {
    const waiting = hub.ledger.pendingCommit(owner);
    commit = waiting ? hub.beacons.commitment(waiting) : null;
  }
  if (!commit) {
    if (hub.ledger.active(owner)) {
      // The client may have missed it (a late genesis): the creature comes first, then the refusal.
      sendLife(hub, ws, owner);
      sendIfOpen(ws, { t: 'refused', reason: 'active' });
      return;
    }
    // Frozen ancestors with no life left end now, so only a real way back blocks a new genesis.
    fallbackAfter(hub, hub.ledger.lastDead(owner));
    if (hub.ledger.alive(owner)) {
      sendIfOpen(ws, { t: 'refused', reason: 'has-lineage' });
      return;
    }
    if (hatchesLeft < 1) {
      sendIfOpen(ws, { t: 'refused', reason: 'limit', genesisIn: bucket.genesisIn });
      return;
    }
    commit = await hub.beacons.commit('genesis', owner, data);
    hatchesLeft = hub.ledger.takeHatch(owner, commit.id, Date.now());
  }
  sendIfOpen(ws, { t: 'commit', commit: signedOf(commit), hatchesLeft });
  await deliverGenesis(hub, commit.id);
}

/** Whether the player's active creature came from this commitment. */
export function isActiveBirth(hub: Hub, owner: string, commitId: string): boolean {
  const head = hub.ledger.active(owner);
  return head !== null && hub.ledger.chain(head.id)[0]?.record.body.commit === commitId;
}

/** Writes the genesis record once the commitment's beacon exists (idempotent) and sends it to the owner's open sessions. */
export async function deliverGenesis(hub: Hub, commitId: string): Promise<void> {
  const commit = hub.beacons.commitment(commitId);
  if (commit?.commitment.kind !== 'genesis') return;
  const beacon = await hub.beacons.beaconFor(commitId);
  if (!beacon) return;
  const owner = commit.commitment.owner;
  const genome = genesisFor(randomnessOf(beacon), commitId);
  const request = genesisRecordRequest(RULES_VERSION, commit.commitment, genome);
  const text = genomeToBase64url(genome);
  const accepted = hub.ledger.accept({ request, genome: text });
  if (!accepted.ok) {
    // Nothing will ever follow: give the hatch back and free the player to ask again instead of waiting on a dead commitment.
    hub.ledger.refundHatch(owner, commitId, Date.now());
    for (const [other, theirs] of activeSessions(hub)) {
      if (theirs.playerId === owner) sendIfOpen(other, { t: 'refused', reason: accepted.reason });
    }
    return;
  }
  const ask = commit.commitment.data as GenesisAsk;
  const msg: HubMsg = {
    t: 'genesis',
    record: accepted.stored,
    ownerRequest: { nonce: ask.nonce, sig: ask.sig },
    commit: signedOf(commit),
    beacon,
    genome: text,
  };
  const head = hub.ledger.head(accepted.stored.hash);
  for (const [other, theirs] of activeSessions(hub)) {
    if (theirs.playerId !== owner) continue;
    // A new creature starts its clock when it reaches the player; a repeat delivery leaves it be.
    if (head && theirs.life?.creature !== head.id) {
      const life = bindHead(hub, head, Date.now());
      other.serializeAttachment({ ...theirs, life } satisfies Session);
    }
    sendIfOpen(other, msg);
  }
}

/**
 * Credits a life report to the connection's creature (ADR 0019). It writes no record by itself:
 * the condition waits in the socket attachment until a checkpoint is due or the socket closes.
 */
export function progress(
  hub: Hub,
  ws: WebSocket,
  session: ActiveSession,
  msg: ClientMsg & { t: 'progress' },
  now: number,
): void {
  // No creature bound (none yet, or it is gone): nothing to credit.
  if (!session.life || msg.n <= session.life.n) return;
  if (session.life.over) {
    sendIfOpen(ws, { t: 'refused', reason: 'dead' });
    return;
  }
  const { life, newFlags } = applyReport(session.life, msg, now);
  for (const kind of newFlags) {
    hub.ledger.flagImplausible(kind, session.playerId, life.creature, now);
  }
  let next = checkpointDue(life) ? checkpoint(hub, life, session.playerId) : life;
  sendIfOpen(ws, {
    t: 'ack',
    n: msg.n,
    activeMs: next.activeMs,
    lifespanMs: next.lifespanMs,
    matureAtMs: next.matureAtMs,
    cooldownUntilMs: next.cooldownUntilMs,
  });
  // Old age is decided here, on the authority's clock: the client counts down, but never has the last word.
  if (isOld(next)) next = finish(hub, ws, next, session.playerId, 'old-age');
  ws.serializeAttachment({ ...session, life: next } satisfies Session);
}

/** A client's report that its creature died; the ticks since its last report are credited first. */
export function death(
  hub: Hub,
  ws: WebSocket,
  session: ActiveSession,
  msg: ClientMsg & { t: 'death' },
  now: number,
): void {
  if (msg.cause === 'old-age') {
    sendIfOpen(ws, { t: 'refused', reason: 'cause' });
    return;
  }
  if (!session.life) {
    // Nothing of this player's to end: note it once and say nothing.
    hub.ledger.flagStray(session.playerId, now);
    return;
  }
  if (session.life.over) {
    // A repeat gets the first answer, whatever cause it names.
    const record = hub.ledger.deathRecord(session.life.creature);
    if (record) {
      const fallback = fallbackAfter(hub, hub.ledger.head(session.life.creature));
      sendIfOpen(ws, { t: 'died', cause: causeOf(record.record.body.cause), record, fallback });
    }
    return;
  }
  // The checkpoint keeps what the last report said; the stretch since then is credited to the death.
  const saved = unsaved(session.life)
    ? checkpoint(hub, session.life, session.playerId)
    : session.life;
  // Ticks that spend the last of the lifespan are old age whatever the client says: the authority's clock decides.
  const credited = creditTicks(saved, msg.ticks, now);
  const cause = isOld(credited) ? 'old-age' : msg.cause;
  const life = finish(hub, ws, credited, session.playerId, cause);
  ws.serializeAttachment({ ...session, life } satisfies Session);
}

/**
 * Ends the creature's life: a checkpoint of its last condition (when it has played since the last
 * record), then the `death` record, and `died` to the owner. A ledger that refuses leaves the
 * creature as it was, and the next report or request tries again.
 */
export function finish(
  hub: Hub,
  ws: WebSocket,
  life: LifeState,
  owner: string,
  cause: DeathCause,
): LifeState {
  const saved = unsaved(life) ? checkpoint(hub, life, owner) : life;
  const head = hub.ledger.head(life.creature);
  if (head?.status !== 'active' || head.owner !== owner) return { ...saved, over: true };
  const accepted = hub.ledger.append(head, 'death', {
    cause,
    activeMs: saved.activeMs,
    biomass: saved.biomass,
  });
  if (!accepted.ok) return saved;
  const fallback = fallbackAfter(hub, hub.ledger.head(life.creature));
  sendIfOpen(ws, { t: 'died', cause, record: accepted.stored, fallback });
  return { ...saved, savedMs: saved.activeMs, savedN: saved.n, over: true };
}

/** The player's finished lives, newest first. */
export function history(hub: Hub, ws: WebSocket, playerId: string): void {
  // Field by field: this is a network message, so a column added to the row later isn't sent by accident.
  const lives = hub.ledger.history(playerId, HISTORY_MAX).flatMap((row) => {
    const genome = genomeFromBase64url(row.genome);
    if (!genome) return [];
    const { creature, activeMs, bornT, diedT } = row;
    return [
      {
        creature,
        species: speciesName(genome),
        cause: causeOf(row.cause),
        activeMs,
        bornT,
        diedT,
      },
    ];
  });
  sendIfOpen(ws, { t: 'history', lives });
}

/** What makes a frozen creature too old to restore: its lifespan and the least life worth coming back for. */
export function exhaustion(hub: Hub): Exhaustion {
  return {
    lifespanOf: (head) => {
      const genome = genomeFromBase64url(head.genome);
      return genome ? lifespanOf(hub, genome) : 0;
    },
    restoreMinMs: Math.round(
      RULES.mating.restoreMinMs * fixtureScale(hub.env, hub.env.MATING_SCALE),
    ),
  };
}

/**
 * What the player can fall back on after `dead`: a pending child and the nearest surviving ancestor.
 * Frozen creatures walked over with too little life left end here, with an `old-age` death.
 */
export function fallbackAfter(hub: Hub, dead: Head | null): FallbackInfo {
  const rule = exhaustion(hub);
  const found = dead
    ? hub.ledger.fallback(dead.id, rule)
    : { pending: null, ancestor: null, exhausted: [] };
  for (const head of found.exhausted) hub.ledger.markExhausted(head.id, rule);
  return {
    pending: found.pending !== null,
    ancestor: found.ancestor ? { ...lifeOf(hub, found.ancestor), hash: found.ancestor.hash } : null,
  };
}

/** The player's creatures and their pedigree: no other player is named. */
export function lineage(hub: Hub, ws: WebSocket, owner: string): void {
  const heads = hub.ledger.creatures(owner, LINEAGE_MAX);
  const creatures = heads.flatMap((head): LineageEntry[] => {
    const genome = genomeFromBase64url(head.genome);
    if (!genome) return [];
    return [
      {
        creature: head.id,
        status: head.status,
        generation: head.generation,
        species: speciesName(genome),
        genome: head.genome,
        activeMs: head.activeMs,
        lifespanMs: lifespanOf(hub, genome),
        hash: head.hash,
        chainParent: head.chainParent,
      },
    ];
  });
  const pedigree: PedigreeNode[] = [];
  for (const [id, parents] of hub.ledger.pedigree(heads.map((h) => h.id))) {
    if (pedigree.length >= PEDIGREE_MAX) break;
    const genomeText = hub.ledger.head(id)?.genome;
    const genome = genomeText ? genomeFromBase64url(genomeText) : null;
    if (genomeText && genome) {
      pedigree.push({ id, parents, species: speciesName(genome), genome: genomeText });
    }
  }
  sendIfOpen(ws, { t: 'lineage', creatures, pedigree });
}

/** Whether the request names this connection's player as its owner; if not, the sender is told. */
export function owns(ws: WebSocket, session: ActiveSession, request: RecordRequest): boolean {
  if (request.owner === session.playerId) return true;
  sendIfOpen(ws, { t: 'refused', reason: 'wrong-owner' });
  return false;
}

/** Makes the pending child the active creature; the active parent, if any, is frozen with the condition this session last reported. */
export function promoteChild(
  hub: Hub,
  ws: WebSocket,
  session: ActiveSession,
  { request, sig }: ClientMsg & { t: 'promote' },
  now: number,
): void {
  const mine = session.life;
  const freeze: Condition | null =
    mine && !mine.over && mine.creature === request.body.parent ? conditionOf(mine) : null;
  const result = hub.ledger.promote(request, sig, freeze);
  const parent = result.ok ? result.frozen : null;
  takeOver(hub, ws, session, request, now, result, (life) => ({ t: 'promoted', life, parent }));
}

/** Brings the nearest surviving ancestor back with its saved condition and life clock. */
export function restoreAncestor(
  hub: Hub,
  ws: WebSocket,
  session: ActiveSession,
  { request, sig }: ClientMsg & { t: 'restore' },
  now: number,
): void {
  const result = hub.ledger.restore(request, sig, exhaustion(hub));
  takeOver(hub, ws, session, request, now, result, (life) => ({ t: 'restored', life }));
}

/** Answers a promotion or restore: a refusal, or the connection now plays `request.creature` (a repeat keeps its running clock). */
export function takeOver(
  hub: Hub,
  ws: WebSocket,
  session: ActiveSession,
  request: RecordRequest,
  now: number,
  result: { ok: true; fresh: boolean } | { ok: false; reason: string },
  reply: (life: LifeInfo) => HubMsg,
): void {
  if (!result.ok) {
    sendIfOpen(ws, { t: 'refused', reason: result.reason });
    return;
  }
  const head = hub.ledger.head(request.creature);
  if (!head) return;
  const mine = session.life;
  const life = !result.fresh && mine?.creature === head.id ? mine : bindHead(hub, head, now);
  ws.serializeAttachment({ ...session, life, court: undefined } satisfies Session);
  sendIfOpen(ws, reply(lifeOf(hub, head)));
}

/** The head as the client resumes it. */
export function lifeOf(hub: Hub, head: Head): LifeInfo {
  const genome = genomeFromBase64url(head.genome);
  return {
    creature: head.id,
    seq: head.seq,
    genome: head.genome,
    biomass: head.biomass,
    energy: head.energy,
    health: head.health,
    activeMs: head.activeMs,
    lifespanMs: genome ? lifespanOf(hub, genome) : 0,
    matureAtMs: genome ? matureAtMsOf(hub, genome) : 0,
    cooldownUntilMs: head.cooldownUntilMs,
  };
}

/** The active time from which a creature of this genome may mate, shortened by `MATING_SCALE` in fixture mode only. */
export function matureAtMsOf(hub: Hub, genome: Genome): number {
  return matureAtOfLifespan(
    lifespanMs(express(genome).physiology.lifespan),
    fixtureScale(hub.env, hub.env.MATING_SCALE),
  );
}

/** The lifespan this object gives a genome: its trait, shortened by `LIFESPAN_SCALE` in fixture mode only. */
export function lifespanOf(hub: Hub, genome: Genome): number {
  const shortened = fixtureScale(hub.env, hub.env.LIFESPAN_SCALE);
  return Math.round(lifespanMs(express(genome).physiology.lifespan) * shortened);
}

/** The player's active creature as a fresh connection state, or undefined without one. */
export function bind(hub: Hub, playerId: string, now: number): LifeState | undefined {
  const head = hub.ledger.active(playerId);
  return head ? bindHead(hub, head, now) : undefined;
}

/** A connection's state for `head`; none when its genome doesn't decode, so nothing is credited to it. */
export function bindHead(hub: Hub, head: Head, now: number): LifeState | undefined {
  const genome = genomeFromBase64url(head.genome);
  return genome
    ? bindLife(head, genome, now, lifespanOf(hub, genome), matureAtMsOf(hub, genome))
    : undefined;
}

/** Writes the creature's condition as a checkpoint record; the state comes back marked saved only if the ledger took it. */
export function checkpoint(hub: Hub, life: LifeState, owner: string): LifeState {
  const head = hub.ledger.head(life.creature);
  if (head?.status !== 'active' || head.owner !== owner) return life;
  const accepted = hub.ledger.append(head, 'checkpoint', {
    biomass: life.biomass,
    energy: life.energy,
    health: life.health,
    activeMs: life.activeMs,
  });
  return accepted.ok ? { ...life, savedMs: life.activeMs, savedN: life.n } : life;
}

/** The player's active creature (null for a new player) and when the next recorded hatch is allowed. */
export function sendLife(hub: Hub, ws: WebSocket, playerId: string): void {
  const head = hub.ledger.active(playerId);
  const { left, genesisIn } = hub.ledger.hatches(playerId, Date.now());
  const child = hub.ledger.pending(playerId);
  const pending = child ? bornFor(hub, child) : null;
  const fallback = head ? null : fallbackAfter(hub, hub.ledger.lastDead(playerId));
  sendIfOpen(ws, {
    t: 'life',
    life: head ? lifeOf(hub, head) : null,
    genesisIn,
    ...(pending ? { pending } : {}),
    ...(fallback && (fallback.pending || fallback.ancestor) ? { fallback } : {}),
    ...(hub.ledger.takeRenewal(playerId) ? { renewed: true as const } : {}),
  });
  // A mating whose children were never written (an eviction between its round and the write) is finished now.
  for (const id of hub.ledger.openMatingCommits(playerId)) {
    if (hub.beacons.status(id) === 'ready') deliverBirth(hub, id).catch(() => {});
  }
  // A genesis still waiting on its round is announced again, and its creature follows when the round comes.
  const waiting = hub.ledger.pendingCommit(playerId);
  const commit = waiting ? hub.beacons.commitment(waiting) : null;
  if (commit) {
    sendIfOpen(ws, {
      t: 'commit',
      commit: signedOf(commit),
      hatchesLeft: left,
    });
    deliverGenesis(hub, commit.id).catch(() => {});
  }
}
