import * as ed from '@noble/ed25519';
import { sha512 } from '@noble/hashes/sha2.js';
import { decodeRecoveryCode, encodeRecoveryCode } from './recovery';

// Browser identity (ADR 0009): an Ed25519 seed per profile, `playerId` = base64url of the public
// key. Runs in browsers, Node and workerd, so it uses only the synchronous noble API.
ed.hashes.sha512 = sha512;

const SEED_BYTES = 32;
const KEY_BYTES = 32;
const SIG_BYTES = 64;
const SEPARATOR = 0x0a;

/** Domain tag of the signed hello (ADR 0009). */
export const HELLO_DOMAIN = 'bs/hello/v1';

export interface KeyStore {
  load(): Promise<Uint8Array | null>;
  save(seed: Uint8Array): Promise<void>;
}

export interface Identity {
  playerId: string;
  /** Signs `domain ‖ 0x0A ‖ message`. */
  sign(domain: string, message: Uint8Array): Uint8Array;
  /** The seed as a recovery code. Call it only when the player asks for the code. */
  exportRecoveryCode(): string;
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
    playerId: playerIdOf(publicKeyFromSecret(secret)),
    sign: (domain, message) => signWithSecret(secret, domain, message),
    exportRecoveryCode: () => encodeRecoveryCode(secret),
  };
}

/** Replaces the stored seed with the one a recovery code names; the old identity is gone. */
export async function importRecoveryCode(store: KeyStore, code: string): Promise<Identity> {
  const seed = decodeRecoveryCode(code);
  if (!seed) throw new Error('not a valid recovery code');
  await store.save(seed);
  return createIdentity(store);
}

/** Signs with a bare secret; for keys that are not a player's, such as the authority's. */
export function signWithSecret(
  secret: Uint8Array,
  domain: string,
  message: Uint8Array,
): Uint8Array {
  return ed.sign(signedBytes(domain, message), secret);
}

export function publicKeyFromSecret(secret: Uint8Array): Uint8Array {
  return ed.getPublicKey(secret);
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

/** True when `text` is the canonical playerId of some public key. */
export function isPlayerId(text: string): boolean {
  return publicKeyOf(text) !== null;
}

/** The public key a playerId names, or null when it is not 43 base64url characters. */
function publicKeyOf(playerId: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]{43}$/.test(playerId)) return null;
  const bytes = fromBase64Url(playerId);
  return bytes?.length === KEY_BYTES ? bytes : null;
}

/** What a hello signs: the hub's challenge nonce bytes followed by the UTF-8 name. */
export function helloMessage(nonce: string, name: string): Uint8Array | null {
  const nonceBytes = fromBase64Url(nonce);
  if (!nonceBytes) return null;
  const nameBytes = new TextEncoder().encode(name);
  const out = new Uint8Array(nonceBytes.length + nameBytes.length);
  out.set(nonceBytes);
  out.set(nameBytes, nonceBytes.length);
  return out;
}

/** Decodes unpadded base64url, or null when the text isn't the canonical encoding of some bytes. */
export function fromBase64Url(text: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]*$/.test(text) || text.length % 4 === 1) return null;
  const binary = atob(text.replace(/-/g, '+').replace(/_/g, '/'));
  const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
  // Spare bits in the last character must be zero, or one key would have several playerIds.
  return toBase64Url(bytes) === text ? bytes : null;
}

export function toBase64Url(bytes: Uint8Array): string {
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
