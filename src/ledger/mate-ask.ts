import { type Canonical, canonicalize } from './canonical';
import { fromBase64Url, type Identity, isPlayerId, toBase64Url, verify } from './identity';
import { HEX64, REQUEST_DOMAIN } from './record';

// Mate asks (ADR 0021): one transaction touches two players' creatures, so each player signs an
// ask, as with genesis, instead of both signing one record. Kept apart from `mating.ts` so the app
// shell can sign an ask without loading the beacon code (BLS) that the birth checks pull in.

const NONCE_RE = /^[A-Za-z0-9_-]{22}$/;
const SIG_RE = /^[A-Za-z0-9_-]{86}$/;
const FIELDS = ['v', 'kind', 'creature', 'partner', 'partnerCreature', 'nonce', 'sig'];

/** A player's signed consent to mate: `creature` with `partner`'s `partnerCreature`. */
export interface MateAsk {
  v: 1;
  kind: 'mate';
  creature: string;
  partner: string;
  partnerCreature: string;
  nonce: string;
  sig: string;
}

function askMessage(a: Omit<MateAsk, 'sig'>): Uint8Array {
  return new TextEncoder().encode(canonicalize(a as unknown as Canonical));
}

export function signMateAsk(identity: Identity, a: Omit<MateAsk, 'v' | 'kind' | 'sig'>): MateAsk {
  const { creature, partner, partnerCreature, nonce } = a;
  const ask = { v: 1 as const, kind: 'mate' as const, creature, partner, partnerCreature, nonce };
  return { ...ask, sig: toBase64Url(identity.sign(REQUEST_DOMAIN, askMessage(ask))) };
}

export function isAsk(x: unknown): x is MateAsk {
  if (typeof x !== 'object' || x === null || Array.isArray(x)) return false;
  const a = x as Record<string, unknown>;
  const str = (k: string, ok: (s: string) => boolean) =>
    typeof a[k] === 'string' && ok(a[k] as string);
  return (
    Object.keys(a).every((k) => FIELDS.includes(k)) &&
    a.v === 1 &&
    a.kind === 'mate' &&
    str('creature', (s) => HEX64.test(s)) &&
    str('partnerCreature', (s) => HEX64.test(s)) &&
    str('partner', isPlayerId) &&
    str('nonce', (s) => NONCE_RE.test(s)) &&
    str('sig', (s) => SIG_RE.test(s))
  );
}

/** Whether `owner` signed the ask (the shape is the caller's to have checked). */
export function signedBy(owner: string, a: MateAsk): boolean {
  const { sig, ...rest } = a;
  const bytes = fromBase64Url(sig);
  return bytes !== null && verify(owner, REQUEST_DOMAIN, askMessage(rest), bytes);
}

/** Named failures; empty when each ask names the other and both are signed by their owners. Never throws. */
export function checkMatePair(a: MateAsk, aOwner: string, b: MateAsk, bOwner: string): string[] {
  try {
    if (!isAsk(a) || !isAsk(b)) return ['bad-ask'];
    const failures: string[] = [];
    if (aOwner === bOwner) failures.push('self');
    else if (
      a.partner !== bOwner ||
      b.partner !== aOwner ||
      a.partnerCreature !== b.creature ||
      b.partnerCreature !== a.creature ||
      a.nonce !== b.nonce
    ) {
      failures.push('pair-mismatch');
    }
    if (!signedBy(aOwner, a) || !signedBy(bOwner, b)) failures.push('bad-signature');
    return failures;
  } catch {
    return ['bad-ask'];
  }
}
