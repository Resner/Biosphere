// Mating and offspring: the mate card, courtship and acceptance, and the two births.
import { genomeFromBase64url, genomeToBase64url } from '../src/genome/codec';
import { offspringPair } from '../src/genome/offspring';
import { buildCreature } from '../src/genome/stats';
import type { Canonical } from '../src/ledger/canonical';
import { randomnessOf } from '../src/ledger/drand';
import { birthRequest, checkMatePair, type MateAsk, signedBy } from '../src/ledger/mating';
import { kinship } from '../src/ledger/pedigree';
import { retired, type StoredRecord } from '../src/ledger/record';
import type { Born } from '../src/net/protocol';
import { hatchling } from '../src/sim/mating';
import { sizeTier } from '../src/sim/size';
import { maxHealth } from '../src/sim/vitals';
import type { BirthChild, Head } from './ledger';
import type { LifeState } from './life';
import {
  askLive,
  type Court,
  cooldownFor,
  fixtureScale,
  mateRequests,
  refusalFor,
  repeatWindowMs,
  viewOf,
} from './mating';
import {
  type ActiveSession,
  activeSessions,
  type Hub,
  type Session,
  sendIfOpen,
  sessionOf,
  signedOf,
} from './socket';

/**
 * Writes a mating's two `birth` records once its round is published (idempotent) and sends each
 * owner their child. The children are recomputed from the beacon and the parents' genomes, never
 * taken from anywhere else.
 */
export async function deliverBirth(hub: Hub, commitId: string): Promise<void> {
  const commit = hub.beacons.commitment(commitId);
  if (commit?.commitment.kind !== 'mate') return;
  const beacon = await hub.beacons.beaconFor(commitId);
  if (!beacon) return;
  const { a: askA, b: askB } = commit.commitment.data as unknown as { a: MateAsk; b: MateAsk };
  const owners: [string, string] = [commit.commitment.owner, askA.partner];
  const parentIds: [string, string] = [askA.creature, askB.creature];
  const heads = parentIds.map((id) => hub.ledger.head(id));
  const [headA, headB] = heads;
  const genomes = heads.map((h) => (h ? genomeFromBase64url(h.genome) : null));
  const [genomeA, genomeB] = genomes;
  if (!headA || !headB || !genomeA || !genomeB) return;
  const mates = parentIds.map((id) => mateRecord(hub, id, commitId));
  if (!mates[0] || !mates[1]) return;
  // The births take the rules version the mate-commits were written under (checkBirth requires
  // it); a mating of a retired version (ADR 0040) never resolves.
  const rules = mates[0].record.rules;
  if (mates[1].record.rules !== rules || retired(mates[0].record)) return;
  const { children, slots } = offspringPair(randomnessOf(beacon), commitId, genomeA, genomeB);
  const generation = Math.max(headA.generation, headB.generation) + 1;
  const mateHashes: [string, string] = [mates[0].hash, mates[1].hash];
  const result = hub.ledger.birth({
    commit: commitId,
    children: children.map((child, i) => {
      const { biomass, energy } = hatchling(buildCreature(child).phys.maxBiomass);
      return {
        request: birthRequest(
          rules,
          commit.commitment,
          mateHashes,
          slots[i] as number,
          parentIds,
          child,
          generation,
          owners[i] as string,
        ),
        genome: genomeToBase64url(child),
        condition: {
          biomass: Math.floor(biomass * 100),
          energy: Math.floor(energy * 100),
          health: Math.floor(maxHealth(biomass) * 100),
        },
      };
    }) as [BirthChild, BirthChild],
  });
  if (!result.ok || !result.fresh) return;
  for (const [i, stored] of result.stored.entries()) {
    const child = hub.ledger.head(stored.hash);
    const born = child ? bornFor(hub, child) : null;
    if (!born) continue;
    for (const [other, theirs] of activeSessions(hub)) {
      if (theirs.playerId === owners[i]) sendIfOpen(other, { t: 'born', ...born });
    }
  }
}

/** The `mate-commit` record the creature's chain holds for this commitment. */
export function mateRecord(hub: Hub, creature: string, commitId: string): StoredRecord | undefined {
  return hub.ledger
    .chain(creature)
    .find((r) => r.record.kind === 'mate-commit' && r.record.body.commit === commitId);
}

/** Everything a client needs to check a pending child: its record, commitment, beacon and both parents. */
export function bornFor(hub: Hub, child: Head): Born | null {
  const record = hub.ledger.chain(child.id)[0];
  const commitId = record?.record.kind === 'birth' ? String(record.record.body.commit) : '';
  const commit = hub.beacons.commitment(commitId);
  const beacon = commit ? hub.beacons.stored(commit.commitment.round) : null;
  const ids = record?.record.body.parents as [string, string] | undefined;
  if (!record || !commit || !beacon || !ids) return null;
  const parents = ids.map((id) => hub.ledger.head(id)?.genome);
  const mates = ids.map((id) => mateRecord(hub, id, commitId));
  const [p0, p1] = parents;
  const [m0, m1] = mates;
  return p0 && p1 && m0 && m1
    ? {
        record,
        commit: signedOf(commit),
        beacon,
        genome: child.genome,
        parents: [p0, p1],
        mates: [m0, m1],
      }
    : null;
}

/** The other seated session of `playerId` in the sender's pond, or null. */
export function peerOf(hub: Hub, ws: WebSocket, session: ActiveSession, playerId: string) {
  for (const [other, theirs] of activeSessions(hub, ws)) {
    if (theirs.pondId === session.pondId && theirs.playerId === playerId) {
      return { ws: other, session: theirs };
    }
  }
  return null;
}

/** The peer, when it is playing a creature (the `life` is narrowed for the caller). */
export function partnerOf(hub: Hub, ws: WebSocket, session: ActiveSession, playerId: string) {
  const peer = peerOf(hub, ws, session, playerId);
  return peer?.session.life
    ? { ws: peer.ws, session: peer.session, life: peer.session.life }
    : null;
}

/** Why these two sessions' creatures cannot mate now (the first player's view first), or null. */
export function mateRefusal(
  hub: Hub,
  a: { playerId: string; life?: LifeState | undefined },
  b: { playerId: string; life?: LifeState | undefined },
): string | null {
  if (!a.life || !b.life) return 'no-creature';
  const view = (s: { playerId: string }, life: LifeState) =>
    viewOf(life, s.playerId, hub.ledger.head(life.creature), {
      pending: hub.ledger.pending(s.playerId) !== null,
      inFlight: hub.ledger.hasOpenMating(s.playerId),
    });
  return refusalFor(view(a, a.life), view(b, b.life));
}

/** What the mate card shows about a partner: kinship, generation and size tier, and the longer cooldown left. */
export function cardOf(hub: Hub, a: LifeState, b: LifeState) {
  const pedigree = hub.ledger.pedigree([a.creature, b.creature]);
  return {
    kinship: kinship(pedigree, a.creature, b.creature),
    generation: hub.ledger.head(b.creature)?.generation ?? 0,
    tier: sizeTier(b.biomass / 100),
    cooldownLeftMs: Math.max(0, a.cooldownUntilMs - a.activeMs, b.cooldownUntilMs - b.activeMs),
  };
}

export function mateCheck(
  hub: Hub,
  ws: WebSocket,
  session: ActiveSession,
  partnerId: string,
): void {
  const other = session.life ? partnerOf(hub, ws, session, partnerId) : null;
  if (!session.life || !other) {
    sendIfOpen(ws, {
      t: 'mate-info',
      partner: partnerId,
      creature: null,
      reason: 'not-here',
      kinship: 0,
      generation: 0,
      tier: 0,
      cooldownLeftMs: 0,
    });
    return;
  }
  sendIfOpen(ws, {
    t: 'mate-info',
    partner: partnerId,
    creature: other.life.creature,
    reason: mateRefusal(hub, session, other.session),
    ...cardOf(hub, session.life, other.life),
  });
}

/** The courting player offers a mating: kept in the session's attachment until the partner answers. */
export function court(
  hub: Hub,
  ws: WebSocket,
  session: ActiveSession,
  ask: MateAsk,
  now: number,
): boolean {
  const refuse = (reason: string): false => {
    sendIfOpen(ws, { t: 'refused', reason });
    return false;
  };
  if (!session.life) return refuse('no-creature');
  if (ask.partner === session.playerId) return refuse('self');
  if (ask.creature !== session.life.creature || !signedBy(session.playerId, ask)) {
    return refuse('bad-signature');
  }
  const other = partnerOf(hub, ws, session, ask.partner);
  if (!other) return refuse('not-here');
  if (ask.partnerCreature !== other.life.creature) return refuse('pair-mismatch');
  if (hub.ledger.nonceUsed(ask.nonce)) return refuse('used');
  const reason = mateRefusal(hub, session, other.session);
  if (reason) return refuse(reason);
  // A second court replaces the first: the earlier invitation is void.
  ws.serializeAttachment({ ...session, court: { ask, sentAt: now } } satisfies Session);
  const card = cardOf(hub, session.life, other.life);
  sendIfOpen(other.ws, {
    t: 'invite',
    from: session.playerId,
    ask,
    kinship: card.kinship,
    generation: hub.ledger.head(session.life.creature)?.generation ?? 0,
  });
  return true;
}

export function decline(hub: Hub, ws: WebSocket, session: ActiveSession, courter: string): void {
  const peer = peerOf(hub, ws, session, courter);
  const court = peer?.session.court;
  if (peer && court && 'ask' in court && court.ask.partner === session.playerId) {
    peer.ws.serializeAttachment({ ...peer.session, court: undefined } satisfies Session);
    sendIfOpen(peer.ws, { t: 'declined', by: session.playerId });
  }
}

/** Runs an acceptance after any earlier one has finished. */
export function queueAccept(hub: Hub, ws: WebSocket, ask: MateAsk): void {
  const run = hub.matingQueue
    .then(async () => {
      await accept(hub, ws, ask);
    })
    .catch(() => sendIfOpen(ws, { t: 'error', code: 'mate-failed' }));
  hub.matingQueue = run;
}

/**
 * ADR 0021: the accepting player's ask turns the courtship into one commitment to a future round
 * and two `mate-commit` records. Nothing is written until every check passes, and nothing reverses it.
 */
export async function accept(hub: Hub, ws: WebSocket, ask: MateAsk): Promise<boolean> {
  const refuse = (reason: string): false => {
    sendIfOpen(ws, { t: 'refused', reason });
    return false;
  };
  const me = sessionOf(ws);
  if (me?.phase !== 'active' || !me.life) return refuse('no-creature');
  if (ask.partner === me.playerId) return refuse('self');
  if (ask.creature !== me.life.creature || !signedBy(me.playerId, ask)) {
    return refuse('bad-signature');
  }
  const found = peerOf(hub, ws, me, ask.partner);
  if (!found) return refuse('no-court');
  const { court } = found.session;
  if (court && 'done' in court) {
    // The same acceptance again: the same commitment, nothing written.
    if (court.nonce !== ask.nonce) return refuse('no-court');
    resend(hub, ws, me.life.creature, court.done);
    return true;
  }
  if (!court || court.ask.partner !== me.playerId) return refuse('no-court');
  if (!askLive(court.sentAt, Date.now())) return refuse('expired');
  if (hub.ledger.nonceUsed(ask.nonce)) return refuse('used');
  const failures = checkMatePair(court.ask, found.session.playerId, ask, me.playerId);
  if (failures.length > 0) return refuse(failures[0] as string);
  const reason = mateRefusal(hub, me, found.session);
  if (reason) return refuse(reason);

  const scale = fixtureScale(hub.env, hub.env.MATING_SCALE);
  const prior = hub.ledger.pairMatings(
    found.session.playerId,
    me.playerId,
    Date.now() - repeatWindowMs(scale),
  );
  const data = { a: court.ask, b: ask } as unknown as Canonical;
  const commit = await hub.beacons.commit('mate', found.session.playerId, data);

  // The network call let others in: read both sessions and their creatures again.
  const [mine, theirs] = [sessionOf(ws), sessionOf(found.ws)];
  if (mine?.phase !== 'active' || theirs?.phase !== 'active' || !mine.life || !theirs.life) {
    return refuse('not-here');
  }
  const again = theirs.court;
  // The same offer, and the same two creatures: a re-court, a decline or a death during the wait voids it.
  if (!again || 'done' in again || again.sentAt !== court.sentAt) return refuse('no-court');
  if (mine.life.creature !== ask.creature || theirs.life.creature !== court.ask.creature) {
    return refuse('pair-mismatch');
  }
  const stale = mateRefusal(hub, mine, theirs);
  if (stale) return refuse(stale);
  const [headA, headB] = [
    hub.ledger.head(theirs.life.creature),
    hub.ledger.head(mine.life.creature),
  ];
  const [genomeA, genomeB] = [headA, headB].map((h) => (h ? genomeFromBase64url(h.genome) : null));
  if (!headA || !headB || !genomeA || !genomeB) return refuse('unknown-creature');
  const cooldown = cooldownFor(prior, scale);
  const requests = mateRequests(
    { id: commit.id, round: commit.commitment.round },
    { head: headA, life: theirs.life, genome: genomeA },
    { head: headB, life: mine.life, genome: genomeB },
    cooldown,
  );
  const result = hub.ledger.mate({
    commit: commit.id,
    round: commit.commitment.round,
    requests,
  });
  if (!result.ok) {
    sendIfOpen(found.ws, { t: 'refused', reason: result.reason });
    return refuse(result.reason);
  }
  const signed = signedOf(commit);
  const settle = (socket: WebSocket, s: ActiveSession, i: 0 | 1, court?: Court) => {
    const body = (requests[i] as { body: Record<string, number> }).body;
    const life = s.life as LifeState;
    socket.serializeAttachment({
      ...s,
      court,
      life: {
        ...life,
        biomass: body.biomass as number,
        energy: body.energy as number,
        health: body.health as number,
        cooldownUntilMs: body.cooldownUntilMs as number,
        // The record covers everything reported so far.
        savedMs: life.activeMs,
        savedN: life.n,
      },
    } satisfies Session);
    sendIfOpen(socket, { t: 'mating', commit: signed, record: result.stored[i] });
  };
  if (result.fresh) {
    settle(found.ws, theirs, 0, { done: commit.id, nonce: ask.nonce });
    settle(ws, mine, 1);
  } else {
    resend(hub, ws, mine.life.creature, commit.id);
  }
  return true;
}

/** Sends a player the commitment and their `mate-commit` record of an earlier mating again. */
export function resend(hub: Hub, ws: WebSocket, creature: string, commitId: string): void {
  const commit = hub.beacons.commitment(commitId);
  const record = hub.ledger
    .chain(creature)
    .find((r) => r.record.kind === 'mate-commit' && r.record.body.commit === commitId);
  if (commit && record) sendIfOpen(ws, { t: 'mating', commit: signedOf(commit), record });
}
