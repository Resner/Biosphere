// Engaging another creature (M7, ADR 0050): who might be engaged soon, the signed snapshots that
// lock a fight in, and spawn protection. DOM-free; `app-online.ts` wires it to the session.

import type { Identity } from '../ledger/identity';
import { encodeSignedFrame, signSnap } from '../ledger/snapshot-sig';
import type { ClientMsg } from '../net/protocol';
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
}

/**
 * The pond peers within ±1 size tier and within `CANDIDATE_RADII` × the larger radius of `self`:
 * the ones that might engage or be engaged soon, so they get signed snapshots. Refills `into`.
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
