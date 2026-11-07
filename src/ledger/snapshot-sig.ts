import {
  decodeSnapshot,
  PLAYER_KEY_BYTES,
  PROXY_FRAME_BYTES,
  SIGNATURE_BYTES,
  SIGNED_FRAME_BYTES,
  type SignedSnap,
  SNAPSHOT_BYTES,
  type Snapshot,
} from '../net/protocol';
import { fromBase64Url, type Identity, isPlayerKey, toBase64Url, verify } from './identity';

// Snapshots signed for lock-in (ADR 0050): the owner's key signs `bs/snap/v1 ‖ 0x0A ‖ pond id ‖
// 0x0A ‖ the 29 snapshot bytes`, so a snapshot from one pond never engages in another. Candidates
// receive it on the state channel as a 93-byte frame: the snapshot, then the signature. A proxy
// frame (ADR 0053) is 61 bytes: an away fighter's player key, then the snapshot a connected fighter
// relays for it from the encounter. It is unsigned: it moves a faded body and feeds nothing else.

export const SNAP_DOMAIN = 'bs/snap/v1';
const SEPARATOR = 0x0a;

function snapMessage(pondId: string, bytes: Uint8Array): Uint8Array {
  const pond = new TextEncoder().encode(pondId);
  const out = new Uint8Array(pond.length + 1 + bytes.length);
  out.set(pond);
  out[pond.length] = SEPARATOR;
  out.set(bytes, pond.length + 1);
  return out;
}

function unpack(s: SignedSnap): { bytes: Uint8Array; sig: Uint8Array } | null {
  if (typeof s?.snap !== 'string' || typeof s.sig !== 'string') return null;
  const bytes = fromBase64Url(s.snap);
  const sig = fromBase64Url(s.sig);
  return bytes?.length === SNAPSHOT_BYTES && sig?.length === SIGNATURE_BYTES
    ? { bytes, sig }
    : null;
}

/** Signs the 29 encoded snapshot bytes for `pondId`. */
export function signSnap(identity: Identity, pondId: string, bytes: Uint8Array): SignedSnap {
  return {
    snap: toBase64Url(bytes),
    sig: toBase64Url(identity.sign(SNAP_DOMAIN, snapMessage(pondId, bytes))),
  };
}

/** The snapshot `playerId` signed for `pondId`, or null for anything else. Never throws. */
export function verifySnap(playerId: string, pondId: string, s: SignedSnap): Snapshot | null {
  try {
    const parts = typeof pondId === 'string' ? unpack(s) : null;
    if (!parts) return null;
    const { bytes, sig } = parts;
    const snapshot = decodeSnapshot(bytes);
    return snapshot && verify(playerId, SNAP_DOMAIN, snapMessage(pondId, bytes), sig)
      ? snapshot
      : null;
  } catch {
    return null;
  }
}

/** The 93-byte state-channel frame of a signed snapshot; a RangeError if it is malformed. */
export function encodeSignedFrame(signed: SignedSnap): Uint8Array {
  const parts = unpack(signed);
  if (!parts) throw new RangeError('not a signed snapshot');
  const { bytes, sig } = parts;
  const out = new Uint8Array(SIGNED_FRAME_BYTES);
  out.set(bytes);
  out.set(sig, SNAPSHOT_BYTES);
  return out;
}

/** The 61-byte proxy frame of `playerId`'s away fighter; a RangeError for a bad player id or snapshot. */
export function encodeProxyFrame(playerId: string, snapshotBytes: Uint8Array): Uint8Array {
  const key = typeof playerId === 'string' ? fromBase64Url(playerId) : null;
  if (!key || !isPlayerKey(key)) throw new RangeError('not a player id');
  if (snapshotBytes.length !== SNAPSHOT_BYTES) throw new RangeError('not a snapshot');
  const out = new Uint8Array(PROXY_FRAME_BYTES);
  out.set(key);
  out.set(snapshotBytes, PLAYER_KEY_BYTES);
  return out;
}

/**
 * A state-channel frame: a plain 29-byte snapshot, a 93-byte signed one (`signed`, whose signature
 * is not checked here: `verifySnap` does) or a 61-byte proxy frame (`proxyFor`, the away player's
 * id). Null for anything else, a proxy key that is no player key included. Never throws.
 */
export function decodeStateFrame(
  bytes: Uint8Array,
): { snapshot: Snapshot; signed: SignedSnap | null; proxyFor: string | null } | null {
  if (!(bytes instanceof Uint8Array)) return null;
  if (bytes.length === PROXY_FRAME_BYTES) {
    const snapshot = decodeSnapshot(bytes.subarray(PLAYER_KEY_BYTES));
    const key = bytes.subarray(0, PLAYER_KEY_BYTES);
    return snapshot && isPlayerKey(key)
      ? { snapshot, signed: null, proxyFor: toBase64Url(key) }
      : null;
  }
  if (bytes.length !== SNAPSHOT_BYTES && bytes.length !== SIGNED_FRAME_BYTES) return null;
  const snap = bytes.subarray(0, SNAPSHOT_BYTES);
  const snapshot = decodeSnapshot(snap);
  if (!snapshot) return null;
  if (bytes.length === SNAPSHOT_BYTES) return { snapshot, signed: null, proxyFor: null };
  return {
    snapshot,
    signed: { snap: toBase64Url(snap), sig: toBase64Url(bytes.subarray(SNAPSHOT_BYTES)) },
    proxyFor: null,
  };
}
