// The drand quicknet chain and its clock (ADR 0010), without the BLS code: the game shell and the
// witness documents (`witness.ts`) name rounds without loading `drand.ts`.

export const QUICKNET = {
  chain: '52db9ba70e0cc0f6eaf7803dd07447a1f5477735fd3f661792ba94600c84e971',
  publicKey:
    '83cf0f2896adee7eb8b5f01fcad3912212c437e0073e911fb90022d3e760183c8c4b450b6a0a6c3ac6a5776a2d1064510d1fec758c921cc22b0e17e63aaf4bcb5ed66304de9cf809bd274ca73bab4af5a6e9c76a4bc09e76eae8991ef5ece45a',
  genesis: 1692803367,
  period: 3,
} as const;

/** The round that is current at a wall-clock time (0 before the chain started). */
export function roundAt(ms: number): number {
  if (!Number.isFinite(ms)) throw new RangeError(`not a time: ${ms}`);
  const rounds = Math.floor((ms - QUICKNET.genesis * 1000) / (QUICKNET.period * 1000)) + 1;
  return Math.max(0, rounds);
}

/** The wall-clock time (ms) at which a round is produced. */
export function roundTime(round: number): number {
  return (QUICKNET.genesis + (round - 1) * QUICKNET.period) * 1000;
}
