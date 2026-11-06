// Where a card's proof comes from (M9 T12): the creature id in `?c=`, the authority (the build's
// `AUTHORITY_URL`, or `?hub=` for a local one only, as the game takes it), and the two reads,
// `GET /v1/proof/<id>` and `GET /v1/fight/<enc>`, with each failure named in plain words.

import { hubSocketUrl } from '../game/online-config';
import {
  type FightProof,
  type ProofBundle,
  parseFightProof,
  parseProofBundle,
} from '../ledger/proof';
import { HEX64 } from '../ledger/record';
import { hubHttpUrl } from '../net/hub-client';

export type LoadError = 'not-found' | 'busy' | 'offline' | 'malformed';
/** A load error, or a browser that could not run the check (`unchecked`). */
export type CardError = LoadError | 'unchecked';

/** What the card says when there is no proof to check. */
export const ERROR_TEXT: Readonly<Record<CardError, string>> = {
  'not-found': 'No such creature',
  busy: 'The authority is busy, try again soon',
  offline: "Can't reach the authority",
  malformed: "This proof doesn't parse",
  unchecked: "This browser couldn't check the proof",
};

/** How long a read may take before the authority counts as unreachable. */
export const FETCH_TIMEOUT_MS = 15_000;

/** The creature id in the page's query, or null when it is not one. */
export function creatureParam(search: string): string | null {
  const c = new URLSearchParams(search).get('c')?.trim().toLowerCase() ?? '';
  return HEX64.test(c) ? c : null;
}

/** The authority's HTTP origin, or null when the page has none (a build without `AUTHORITY_URL`). */
export function authorityBase(search: string, buildUrl: string): string | null {
  const socket = hubSocketUrl(search, buildUrl);
  return socket ? hubHttpUrl(socket, '/').replace(/\/$/, '') : null;
}

export type Loaded<T> = { ok: true; value: T } | { ok: false; error: LoadError };

async function read(fetcher: typeof fetch, url: string): Promise<Loaded<unknown>> {
  let res: Response;
  try {
    res = await fetcher(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  } catch {
    return { ok: false, error: 'offline' };
  }
  if (res.status === 404 || res.status === 400) return { ok: false, error: 'not-found' };
  if (res.status === 503) return { ok: false, error: 'busy' };
  if (!res.ok) return { ok: false, error: 'offline' };
  try {
    return { ok: true, value: JSON.parse(await res.text()) as unknown };
  } catch {
    return { ok: false, error: 'malformed' };
  }
}

/** A creature's proof bundle, parsed as untrusted JSON. */
export async function loadProof(
  fetcher: typeof fetch,
  base: string,
  id: string,
): Promise<Loaded<ProofBundle>> {
  const got = await read(fetcher, `${base}/v1/proof/${id}`);
  if (!got.ok) return got;
  const bundle = parseProofBundle(got.value);
  return bundle && bundle.subject === id
    ? { ok: true, value: bundle }
    : { ok: false, error: 'malformed' };
}

/** A fight's log and settlement, or an error; a fight proof for another fight is malformed. */
export async function loadFight(
  fetcher: typeof fetch,
  base: string,
  enc: string,
): Promise<Loaded<FightProof>> {
  const got = await read(fetcher, `${base}/v1/fight/${enc}`);
  if (!got.ok) return got;
  const proof = parseFightProof(got.value);
  return proof?.settlement.settlement.enc === enc
    ? { ok: true, value: proof }
    : { ok: false, error: 'malformed' };
}
