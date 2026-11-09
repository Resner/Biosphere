import { type Canonical, canonicalize, hashWithDomain } from './canonical';

// A commitment and its id, apart from `genesis.ts` so the page can name one without loading the
// beacon checks (BLS12-381) that genesis needs.

const COMMIT_DOMAIN = 'bs/commit/v1';

/** A commitment to a future drand round. `data` is the committed request. */
export interface Commitment {
  v: 1;
  kind: string;
  owner: string;
  round: number;
  /** Hash of the request, so a repeated request finds this commitment. */
  req: string;
  t: number;
  data: Canonical;
}

export function commitmentId(c: Commitment): string {
  return hashWithDomain(COMMIT_DOMAIN, canonicalize(c as unknown as Canonical));
}
