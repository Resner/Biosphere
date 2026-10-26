// Records drand quicknet fixtures (M4 T3): `npm run record:drand`. The only code that reaches the
// network for beacons; every test replays `tests/fixtures/drand/` instead (ADR 0010).

import { DRAND_HOSTS, fetchBeacon, QUICKNET } from '../src/ledger/drand';

export interface ChainInfo {
  public_key: string;
  period: number;
  genesis_time: number;
  hash: string;
  schemeID: string;
}

export interface RoundsFixture {
  first: number;
  last: number;
  beacons: { round: number; signature: string }[];
}

const RECORDED_ROUNDS = 600;
const BATCH = 20;

export async function fetchInfo(f: typeof fetch, hosts: readonly string[] = DRAND_HOSTS) {
  for (const host of hosts) {
    try {
      const res = await f(`${host}/${QUICKNET.chain}/info`, { signal: AbortSignal.timeout(5000) });
      if (!res.ok) continue;
      const { public_key, period, genesis_time, hash, schemeID } = (await res.json()) as ChainInfo;
      return { public_key, period, genesis_time, hash, schemeID } satisfies ChainInfo;
    } catch {}
  }
  throw new Error('no drand host served /info');
}

/** The newest published round minus a margin, and the 600 rounds up to it; each one verified. */
export async function recordRounds(
  f: typeof fetch,
  count = RECORDED_ROUNDS,
  hosts: readonly string[] = DRAND_HOSTS,
): Promise<RoundsFixture> {
  const latest = await fetchBeacon('latest', f, hosts);
  const last = latest.round - 2;
  const first = last - count + 1;
  const beacons: RoundsFixture['beacons'] = [];
  for (let from = first; from <= last; from += BATCH) {
    const rounds = Array.from({ length: Math.min(BATCH, last - from + 1) }, (_, i) => from + i);
    beacons.push(...(await Promise.all(rounds.map((r) => fetchBeacon(r, f, hosts)))));
  }
  return { first, last, beacons };
}
