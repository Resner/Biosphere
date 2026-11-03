import {
  decodeSnapshot,
  SIGNATURE_BYTES,
  SIGNED_FRAME_BYTES,
  type SignedSnap,
  SNAPSHOT_BYTES,
  type Snapshot,
} from '../net/protocol';
import { fromBase64Url, type Identity, toBase64Url, verify } from './identity';

// Snapshots signed for lock-in (ADR 0050): the owner's key signs `bs/snap/v1 ‖ 0x0A ‖ pond id ‖
// 0x0A ‖ the 25 snapshot bytes`, so a snapshot from one pond never engages in another. Candidates
// receive it on the state channel as an 89-byte frame: the snapshot, then the signature.

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

/** Signs the 25 encoded snapshot bytes for `pondId`. */
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

/** The 89-byte state-channel frame of a signed snapshot; a RangeError if it is malformed. */
export function encodeSignedFrame(signed: SignedSnap): Uint8Array {
  const parts = unpack(signed);
  if (!parts) throw new RangeError('not a signed snapshot');
  const { bytes, sig } = parts;
  const out = new Uint8Array(SIGNED_FRAME_BYTES);
  out.set(bytes);
  out.set(sig, SNAPSHOT_BYTES);
  return out;
}

/**
 * A state-channel frame: a plain 25-byte snapshot (`signed` null) or an 89-byte signed one, whose
 * signature is not checked here (`verifySnap` does). Null for anything else. Never throws.
 */
export function decodeStateFrame(
  bytes: Uint8Array,
): { snapshot: Snapshot; signed: SignedSnap | null } | null {
  if (!(bytes instanceof Uint8Array)) return null;
  if (bytes.length !== SNAPSHOT_BYTES && bytes.length !== SIGNED_FRAME_BYTES) return null;
  const snap = bytes.subarray(0, SNAPSHOT_BYTES);
  const snapshot = decodeSnapshot(snap);
  if (!snapshot) return null;
  if (bytes.length === SNAPSHOT_BYTES) return { snapshot, signed: null };
  return {
    snapshot,
    signed: { snap: toBase64Url(snap), sig: toBase64Url(bytes.subarray(SNAPSHOT_BYTES)) },
  };
}
