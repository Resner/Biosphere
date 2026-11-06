import { bytesToHex } from '@noble/hashes/utils.js';
import { beforeEach } from 'vitest';
import { randomnessOf } from '../src/ledger/drand';
import type { Identity } from '../src/ledger/identity';
import { type WitnessData, witnessOrder } from '../src/ledger/witness';
import type { HubMsg, PondInfo, SignedCommit } from '../src/net/protocol';
import type { SignedCommitment } from './beacons';
import { authority, clock } from './fight-test-kit';
import type { Session } from './socket';
import { beaconOf, type Client, flush, nextOf, signIn, sql } from './test-hub';
import { eligible, WITNESS_PLAY_MS } from './witness-pool';

// Shared by the witness hub tests (M10 T4, T5): sessions that can witness (play, `avail`, their
// own IP), the pool the object would draw now, and the order a commitment's round draws. Use it
// with `useFightHub()` (the hand clock); `useWitnessHub()` adds a clean slate of duties.

export interface Witness {
  c: Client;
  id: Identity;
  pond: PondInfo;
  ip: string;
}

/** Each test starts with no duty in memory (the object outlives a test). Call after `useFightHub()`. */
export function useWitnessHub(): void {
  beforeEach(() => authority((a) => a.duties.clear()));
}

let ips = 0;
/** A fresh address for a session's `CF-Connecting-IP`. */
export const nextIp = () => `10.4.${(++ips >> 8) & 255}.${ips & 255}`;

/** Credits `ms` of play to the player: a finished creature of its own that lived that long. */
export const credit = (player: string, ms: number) =>
  sql(
    `INSERT INTO creatures (id, owner, status, seq, hash, genome, active_ms, biomass, energy, health, born_t, died_t)
     VALUES (?, ?, 'dead', 0, '', '', ?, 0, 0, 0, 0, 0)`,
    bytesToHex(crypto.getRandomValues(new Uint8Array(32))),
    player,
    ms,
  );

/** Sends `avail` and waits until the object has taken it. */
export async function setAvail(c: Client, on: boolean): Promise<HubMsg[]> {
  c.send({ t: 'avail', on });
  return flush(c);
}

/**
 * A seated session that may witness: `playMs` of play (20 minutes by default), `avail` on unless
 * told otherwise, and its own IP unless one is given.
 */
export async function witness(
  opts: { playMs?: number; avail?: boolean; ip?: string } = {},
): Promise<Witness> {
  const ip = opts.ip ?? nextIp();
  const { c, id } = await signIn(undefined, undefined, ip);
  const { pond } = await nextOf(c, 'welcome');
  await nextOf(c, 'life');
  await credit(id.playerId, opts.playMs ?? WITNESS_PLAY_MS);
  if (opts.avail ?? true) await setAvail(c, true);
  return { c, id, pond, ip };
}

/** `n` witnesses. */
export async function witnesses(n: number): Promise<Witness[]> {
  const out: Witness[] = [];
  for (let i = 0; i < n; i++) out.push(await witness());
  return out;
}

/** Who the object would pool now for an event whose participants are `exclude`. */
export const poolNow = (exclude: readonly { id: Identity }[] = []) =>
  authority((a) =>
    eligible(
      a,
      exclude.map((p) => p.id.playerId),
      clock.now(),
    ),
  );

/** Edits a session's attachment on the object. */
export const editWitness = (
  w: { id: Identity },
  edit: (s: Session & { phase: 'active' }) => Session,
) =>
  authority((a) => {
    for (const ws of a.ctx.getWebSockets()) {
      const s = ws.deserializeAttachment() as Session | null;
      if (s?.phase === 'active' && s.playerId === w.id.playerId) ws.serializeAttachment(edit(s));
    }
  });

/** The event's witness commitment on the object, or null. */
export const witnessCommit = (event: string) =>
  authority((a): SignedCommitment | null => a.beacons.find('witness', '', { event }));

/** The order a witness commitment's round draws, from the recorded beacon. */
export function orderOf(commit: SignedCommit | SignedCommitment, id: string): string[] {
  const data = commit.commitment.data as unknown as WitnessData;
  return witnessOrder(data.pool, randomnessOf(beaconOf(commit.commitment.round)), id);
}

/** The witness whose player is `player`, of `ws`. */
export function byPlayer(ws: readonly Witness[], player: string | undefined): Witness {
  const found = ws.find((w) => w.id.playerId === player);
  if (!found) throw new Error(`no witness ${player}`);
  return found;
}
