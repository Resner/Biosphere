// Engaging another creature (M7, ADR 0050): who might be engaged soon, the signed snapshots that
// lock a fight in, and spawn protection. DOM-free; `app-online.ts` wires it to the session.

import type { Identity } from '../ledger/identity';
import { encodeSignedFrame, signSnap } from '../ledger/snapshot-sig';
import type { ClientMsg } from '../net/protocol';
import { engageRange, type Reacher, strikeDistance } from '../sim/encounter/reach';
import type { Stance } from '../sim/encounter/types';
import { RULES } from '../sim/rules';
import { sizeTier } from '../sim/size';

/** A pond peer within this many times the larger radius is an engage candidate. */
export const CANDIDATE_RADII = 8;

export interface EngageSelf {
  x: number;
  y: number;
  biomass: number;
}

/** A remote as drawn (`RemoteView`): its radius is the root of its biomass. */
export interface EngagePeer {
  id: string;
  x: number;
  y: number;
  radius: number;
  /** Drawn from proxies or a fight while its player is away (M8 T11): never engaged. */
  away?: boolean;
}

/** A drawn remote fainter than this is not offered for an engage. */
const OFFER_ALPHA = 0.5;

/**
 * Whether a drawn remote may be offered for an engage: clearly visible, and moved by its own
 * snapshots. An away fighter, drawn from proxies or a fight (M8 T11), never is.
 */
export const offered = (r: { alpha: number; away?: boolean }): boolean =>
  r.alpha >= OFFER_ALPHA && r.away !== true;

/**
 * The pond peers within ±1 size tier and within `CANDIDATE_RADII` × the larger radius of `self`:
 * the ones that might engage or be engaged soon, so they get signed snapshots. Away fighters are
 * never candidates. Refills `into`.
 */
export function candidates(
  self: EngageSelf,
  remotes: readonly EngagePeer[],
  into = new Set<string>(),
): Set<string> {
  into.clear();
  const radius = Math.sqrt(Math.max(0, self.biomass));
  const tier = sizeTier(self.biomass);
  for (const r of remotes) {
    if (r.away) continue;
    if (Math.abs(sizeTier(r.radius * r.radius) - tier) > RULES.encounter.maxTierGap) continue;
    const reach = CANDIDATE_RADII * Math.max(radius, r.radius);
    const dx = r.x - self.x;
    const dy = r.y - self.y;
    if (dx * dx + dy * dy <= reach * reach) into.add(r.id);
  }
  return into;
}

/** Who signs, and for which pond; null while either is missing. */
export type SignKey = () => { identity: Identity; pondId: string } | null;

/** The signer `SnapshotSender.update` takes: signs for the engage candidates, and only when there are some. */
export class CandidateSigner {
  /** The candidates as of the last snapshot offered for signing. */
  readonly ids = new Set<string>();

  constructor(private readonly key: SignKey) {}

  /** Fills `ids`, and gives the 89-byte signed frame of `bytes` when any candidate is in. */
  sign(bytes: Uint8Array, self: EngageSelf, remotes: readonly EngagePeer[]): Uint8Array | null {
    candidates(self, remotes, this.ids);
    if (this.ids.size === 0) return null;
    const key = this.key();
    return key ? encodeSignedFrame(signSnap(key.identity, key.pondId, bytes)) : null;
  }
}

/** The answer to a `lock-ask`: `bytes`, the creature's snapshot now, signed for the pond. */
export function lockState(
  lock: string,
  bytes: Uint8Array,
  identity: Identity,
  pondId: string,
): Extract<ClientMsg, { t: 'lock-state' }> {
  return { t: 'lock-state', lock, mine: signSnap(identity, pondId, bytes) };
}

/**
 * Spawn protection as the own snapshot shows it (the authority decides, M7 T8): 15 s after a
 * genesis hatch, a promoted child's hatch or a restore, never after a resume, ended by an engage.
 */
export class SpawnShield {
  private until = Number.NEGATIVE_INFINITY;

  /** A protected hatch at `pondMs`. */
  start(pondMs: number): void {
    this.until = pondMs + RULES.encounter.protectionSeconds * 1000;
  }

  /** The creature engaged, or a life began that gives no protection. */
  end(): void {
    this.until = Number.NEGATIVE_INFINITY;
  }

  active(pondMs: number): boolean {
    return pondMs < this.until;
  }
}

// ---- Attack (M7 T11): which creature F engages, the hint beside it, and the combat keys ----

/** Why a creature cannot be engaged now, as the player is told. */
export type EngageRefusal = 'bigger' | 'smaller' | 'protected' | 'fighting' | 'full' | 'range';

/** A pond peer as the attack sees it: its drawn body for the reach rules, and its snapshot marks. */
export interface AttackPeer {
  id: string;
  /** The body as drawn (its radius from the snapshot's biomass) with its combat stats. */
  reacher: Reacher;
  protected: boolean;
  /** In a fight already: an engage joins it (M7 T15), which the authority refuses when it is full. */
  fighting: boolean;
  /** A verified signed snapshot of it is held, so an engage can carry its state. */
  signed: boolean;
}

/**
 * Why `self` cannot engage `peer` now, or null when it can: the authority's checks in its order
 * (tier, protection, range); the range is the engage range on the bodies as drawn, and a peer with
 * no signed snapshot held counts as out of range. A peer already fighting can be engaged: the
 * engage joins its fight (M7 T15), and only the authority knows whether that fight is full.
 */
export function engageRefusal(self: Reacher, peer: AttackPeer): EngageRefusal | null {
  const gap = sizeTier(peer.reacher.body.biomass) - sizeTier(self.body.biomass);
  if (gap > RULES.encounter.maxTierGap) return 'bigger';
  if (gap < -RULES.encounter.maxTierGap) return 'smaller';
  if (peer.protected) return 'protected';
  if (!peer.signed) return 'range';
  return strikeDistance(self.body, peer.reacher.body) <= engageRange(self, peer.reacher)
    ? null
    : 'range';
}

/** The nearest peer `self` can engage now (by strike distance), or null: the one the "F" glyph marks. */
export function hintTarget(self: Reacher, peers: readonly AttackPeer[]): AttackPeer | null {
  let best: AttackPeer | null = null;
  let bestGap = Number.POSITIVE_INFINITY;
  for (const peer of peers) {
    if (engageRefusal(self, peer) !== null) continue;
    const gap = strikeDistance(self.body, peer.reacher.body);
    if (gap < bestGap) {
      bestGap = gap;
      best = peer;
    }
  }
  return best;
}

/** Where the cursor points in the world, and how far from a centre (wu) still picks a small creature. */
export interface Cursor {
  x: number;
  y: number;
  pick: number;
}

/** What F does: engage `target`, or tell why not (`none`: nobody is near). */
export type AttackChoice =
  | { target: AttackPeer; refusal: null }
  | { target: null; refusal: EngageRefusal | 'none'; peer: AttackPeer | null };

/** The peer under the cursor (the nearest centre within its radius or the pick distance), or null. */
export function peerUnder(cursor: Cursor | null, peers: readonly AttackPeer[]): AttackPeer | null {
  if (!cursor) return null;
  let best: AttackPeer | null = null;
  let bestGap = Number.POSITIVE_INFINITY;
  for (const peer of peers) {
    const { body } = peer.reacher;
    const gap = Math.hypot(body.x - cursor.x, body.y - cursor.y);
    if (gap > Math.max(Math.sqrt(body.biomass), cursor.pick) || gap >= bestGap) continue;
    bestGap = gap;
    best = peer;
  }
  return best;
}

/**
 * F's target: the creature under the cursor if it can be engaged, else the nearest that can.
 * Otherwise the reason the cursor's creature (or failing that the nearest) cannot be.
 */
export function chooseTarget(
  self: Reacher,
  peers: readonly AttackPeer[],
  cursor: Cursor | null,
): AttackChoice {
  const under = peerUnder(cursor, peers);
  if (under && engageRefusal(self, under) === null) return { target: under, refusal: null };
  const nearest = hintTarget(self, peers);
  if (nearest) return { target: nearest, refusal: null };
  let told = under;
  if (!told) {
    let bestGap = Number.POSITIVE_INFINITY;
    for (const peer of peers) {
      const { body } = peer.reacher;
      const gap = Math.hypot(body.x - self.body.x, body.y - self.body.y);
      if (gap < bestGap) {
        bestGap = gap;
        told = peer;
      }
    }
  }
  if (!told) return { target: null, refusal: 'none', peer: null };
  return { target: null, refusal: engageRefusal(self, told) ?? 'range', peer: told };
}

/** The toast for a refusal; `protectedLeftS` is the protection's seconds left, when known. */
export function refusalToast(
  refusal: EngageRefusal | 'none' | 'other',
  protectedLeftS: number | null = null,
): string {
  switch (refusal) {
    case 'bigger':
      return 'Too big to fight';
    case 'smaller':
      return 'Too small to fight';
    case 'protected':
      return protectedLeftS === null ? 'Protected' : `Protected for ${protectedLeftS} s`;
    case 'fighting':
      return 'Already fighting';
    case 'full':
      return 'That fight is full';
    case 'range':
      return 'Too far';
    case 'none':
      return 'Nobody in reach';
    default:
      return "Can't fight now";
  }
}

/** The authority's `engage:<why>` as the player is told it; `bigger` says which way a tier refusal went. */
export function authorityRefusal(reason: string, bigger: boolean): EngageRefusal | 'other' {
  switch (reason) {
    case 'engage:tier':
      return bigger ? 'bigger' : 'smaller';
    case 'engage:protected':
      return 'protected';
    case 'engage:locked':
      return 'fighting';
    case 'engage:full':
      return 'full';
    case 'engage:range':
      return 'range';
    default:
      return 'other';
  }
}

/**
 * How long each peer's protection has left, from when its snapshots first showed the mark: the
 * snapshot says only whether, so a peer first seen protected is taken as freshly hatched.
 */
export class ProtectionWatch {
  private readonly since = new Map<string, number>();

  /** The peers drawn now, at `nowMs`; a peer that is gone or unprotected is forgotten. */
  update(peers: readonly { id: string; spawnProtected: boolean }[], nowMs: number): void {
    const protectedNow = new Set<string>();
    for (const p of peers) if (p.spawnProtected) protectedNow.add(p.id);
    for (const id of this.since.keys()) if (!protectedNow.has(id)) this.since.delete(id);
    for (const id of protectedNow) if (!this.since.has(id)) this.since.set(id, nowMs);
  }

  /** Whole seconds left (at least 1) of `id`'s protection, or null when it is not seen protected. */
  leftSeconds(id: string, nowMs: number): number | null {
    const since = this.since.get(id);
    if (since === undefined) return null;
    const left = RULES.encounter.protectionSeconds - (nowMs - since) / 1000;
    return Math.max(1, Math.ceil(left));
  }
}

/** A key's meaning in combat terms; null leaves it to the other keys. */
export type FightKey =
  | { t: 'attack' }
  | { t: 'stance'; stance: Stance }
  | { t: 'brace' }
  | { t: 'target' };

/** 1 aggressive, 2 balanced, 3 evasive (DESIGN §3). */
const STANCE_KEYS: Readonly<Record<string, Stance>> = {
  '1': 'aggressive',
  '2': 'balanced',
  '3': 'evasive',
};

/**
 * Routes a fresh key press. F attacks outside a fight; inside one, 1-3 set the stance, Shift
 * braces and Tab cycles the target (M7 T15), and nothing else is a combat key. The open social
 * wheel keeps its numbers.
 */
export function fightKey(key: string, locked: boolean, wheelOpen: boolean): FightKey | null {
  if (!locked) return key === 'f' || key === 'F' ? { t: 'attack' } : null;
  if (key === 'Shift') return { t: 'brace' };
  if (key === 'Tab') return { t: 'target' };
  const stance = STANCE_KEYS[key];
  return stance && !wheelOpen ? { t: 'stance', stance } : null;
}

/** What the attack reads of the game and does to it. */
export interface AttackHost {
  /** The own creature as the reach rules see it, or null when it cannot engage now. */
  self(): Reacher | null;
  /** The pond peers drawn now. */
  peers(): readonly AttackPeer[];
  /** Where the cursor points in the world, or null. */
  cursor(): Cursor | null;
  /** The signed `engage` for `target`, or null when it cannot be signed now. */
  engage(target: string): ClientMsg | null;
  send(msg: ClientMsg): void;
  /** The engage ring round the own creature, shown in this frame. */
  ring(): void;
  /** An engage ends the own spawn protection, as the authority's does. */
  endShield(): void;
  toast(text: string): void;
  nowMs(): number;
  /** Seconds left of a peer's protection, when known. */
  protectedLeft(id: string): number | null;
}

/** After an engage, F waits this long for the fight or a refusal before it can send another. */
export const ENGAGE_WAIT_MS = 1000;

/** F (or the Attack button): the engage, its ring in the same frame, and the refusals as toasts. */
export class Attack {
  /** The engage awaiting the authority's answer. */
  private pending: { target: string; bigger: boolean; until: number } | null = null;

  constructor(private readonly host: AttackHost) {}

  /** An engage is out and unanswered. */
  get waiting(): boolean {
    return this.pending !== null && this.host.nowMs() < this.pending.until;
  }

  /** F: engages `id` if given (the card's button), else the chosen creature; true when an engage went out. */
  press(id?: string): boolean {
    const { host } = this;
    const self = host.self();
    if (!self || this.waiting) return false;
    const peers = host.peers();
    let choice: AttackChoice;
    if (id === undefined) {
      choice = chooseTarget(self, peers, host.cursor());
    } else {
      const peer = peers.find((p) => p.id === id) ?? null;
      const refusal = peer ? engageRefusal(self, peer) : 'range';
      choice =
        peer && refusal === null
          ? { target: peer, refusal }
          : { target: null, refusal: refusal ?? 'range', peer };
    }
    if (!choice.target) {
      const { peer } = choice;
      const left = peer && choice.refusal === 'protected' ? host.protectedLeft(peer.id) : null;
      host.toast(refusalToast(choice.refusal, left));
      return false;
    }
    const msg = host.engage(choice.target.id);
    if (!msg) {
      host.toast(refusalToast('other'));
      return false;
    }
    host.ring();
    host.endShield();
    host.send(msg);
    this.pending = {
      target: choice.target.id,
      bigger: sizeTier(choice.target.reacher.body.biomass) > sizeTier(self.body.biomass),
      until: host.nowMs() + ENGAGE_WAIT_MS,
    };
    return true;
  }

  /** The authority's `refused` for an engage (`engage:<why>`). */
  refused(reason: string): void {
    const { pending, host } = this;
    this.pending = null;
    const refusal = authorityRefusal(reason, pending?.bigger ?? true);
    const left = refusal === 'protected' && pending ? host.protectedLeft(pending.target) : null;
    host.toast(refusalToast(refusal, left));
  }

  /** The fight began: the engage was answered. */
  started(): void {
    this.pending = null;
  }
}
