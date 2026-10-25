import * as ed from '@noble/ed25519';
import { sha512 } from '@noble/hashes/sha2.js';

// Browser identity (ADR 0009): an Ed25519 seed per profile, `playerId` = base64url of the public
// key. Runs in browsers, Node and workerd, so it uses only the synchronous noble API.
ed.hashes.sha512 = sha512;

const SEED_BYTES = 32;
const KEY_BYTES = 32;
const SIG_BYTES = 64;
const SEPARATOR = 0x0a;

export interface KeyStore {
  load(): Promise<Uint8Array | null>;
  save(seed: Uint8Array): Promise<void>;
}

export interface Identity {
  playerId: string;
  /** Signs `domain ‖ 0x0A ‖ message`. */
  sign(domain: string, message: Uint8Array): Uint8Array;
}

/** Loads the stored seed, or makes and stores a new one. The seed never leaves this closure. */
export async function createIdentity(store: KeyStore): Promise<Identity> {
  let seed = await store.load();
  if (seed?.length !== SEED_BYTES) {
    seed = crypto.getRandomValues(new Uint8Array(SEED_BYTES));
    await store.save(seed);
  }
  const secret = seed.slice();
  return {
    playerId: playerIdOf(ed.getPublicKey(secret)),
    sign: (domain, message) => ed.sign(signedBytes(domain, message), secret),
  };
}

export function verify(
  playerId: string,
  domain: string,
  message: Uint8Array,
  sig: Uint8Array,
): boolean {
  try {
    const publicKey = publicKeyOf(playerId);
    if (!publicKey || sig.length !== SIG_BYTES) return false;
    return ed.verify(sig, signedBytes(domain, message), publicKey, { zip215: false });
  } catch {
    return false;
  }
}

export function playerIdOf(publicKey: Uint8Array): string {
  return toBase64Url(publicKey);
}

/** The public key a playerId names, or null when it is not 43 base64url characters. */
function publicKeyOf(playerId: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]{43}$/.test(playerId)) return null;
  const bytes = Uint8Array.from(atob(playerId.replace(/-/g, '+').replace(/_/g, '/')), (c) =>
    c.charCodeAt(0),
  );
  return bytes.length === KEY_BYTES ? bytes : null;
}

function toBase64Url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function signedBytes(domain: string, message: Uint8Array): Uint8Array {
  const prefix = new TextEncoder().encode(domain);
  const out = new Uint8Array(prefix.length + 1 + message.length);
  out.set(prefix);
  out[prefix.length] = SEPARATOR;
  out.set(message, prefix.length + 1);
  return out;
}

export function memoryKeyStore(initial: Uint8Array | null = null): KeyStore {
  let seed = initial?.slice() ?? null;
  return {
    load: async () => seed?.slice() ?? null,
    save: async (next) => {
      seed = next.slice();
    },
  };
}
