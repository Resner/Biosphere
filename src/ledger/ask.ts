import { canonicalize } from './canonical';
import { fromBase64Url, type Identity, toBase64Url, verify } from './identity';
import { REQUEST_DOMAIN } from './record';

// The owner's signed ask for a genesis creature. It lives apart from `genesis.ts` so the game
// shell can sign one without loading the BLS code that `genesis.ts` pulls in through drand.

/** The owner's signed ask for a genesis creature: `nonce` makes each ask distinct. */
export type GenesisAsk = { nonce: string; sig: string };

/** What the owner signs (under `bs/req/v1`) to ask for a genesis creature. */
export function genesisAskMessage(owner: string, nonce: string): Uint8Array {
  return new TextEncoder().encode(canonicalize({ v: 1, kind: 'genesis', owner, nonce }));
}

export function signGenesisAsk(identity: Identity, nonce: string): GenesisAsk {
  const sig = identity.sign(REQUEST_DOMAIN, genesisAskMessage(identity.playerId, nonce));
  return { nonce, sig: toBase64Url(sig) };
}

export function verifyGenesisAsk(owner: string, ask: GenesisAsk): boolean {
  const sig = fromBase64Url(ask.sig);
  return sig !== null && verify(owner, REQUEST_DOMAIN, genesisAskMessage(owner, ask.nonce), sig);
}
