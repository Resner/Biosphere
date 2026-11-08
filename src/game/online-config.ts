// Where the hub is and what the player is called: small, DOM-free helpers for the online session.

import type { HubStatus, QueuePlace } from '../net/hub-client';
import { validName } from '../net/text';
import { lineText } from './queue-card';

const NAME_KEY = 'bs.name';
const LOCAL_HOST = /^(localhost|127\.0\.0\.1)$/;

/**
 * The hub WebSocket URL. `?hub=` selects a local authority (E2E, `wrangler dev`) and is ignored for
 * any other host, so a shared link cannot send players to someone else's hub; otherwise the URL
 * baked in at build time (`AUTHORITY_URL`) is used. Neither means the game runs offline.
 */
export function hubSocketUrl(search: string, buildUrl: string): string | null {
  const wanted = new URLSearchParams(search).get('hub');
  const local = wanted ? socketUrl(wanted, true) : null;
  return local ?? (buildUrl ? socketUrl(buildUrl, false) : null);
}

function socketUrl(raw: string, localOnly: boolean): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (!/^(https?|wss?):$/.test(url.protocol)) return null;
  if (localOnly && !LOCAL_HOST.test(url.hostname)) return null;
  const secure = url.protocol === 'https:' || url.protocol === 'wss:';
  return `${secure ? 'wss' : 'ws'}://${url.host}/v1/hub`;
}

/** `Cell` and four digits. */
export function defaultName(random: () => number = Math.random): string {
  const n = Math.min(9999, Math.floor(random() * 10000));
  return `Cell${String(n).padStart(4, '0')}`;
}

/** A typed name, trimmed; null when the hub would refuse it (bad shape or profane). */
export function cleanName(typed: string): string | null {
  const name = typed.trim();
  return validName(name) ? name : null;
}

/** The slice of `localStorage` the game uses. */
export interface Store {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** Runs `connect`; a throw or rejection means no hub, so the caller plays in a local pond. */
export async function tryOnline<T>(connect: () => Promise<T | null>): Promise<T | null> {
  try {
    return await connect();
  } catch (error) {
    console.warn('online session failed, playing in a local pond', error);
    return null;
  }
}

/**
 * Adopts the pond a welcome names. A running life stays in `life` only while the pond is the same:
 * in a different pond it carries on in a local one (`life` null).
 */
export function switchPond<P extends { id: string }>(
  current: P | null,
  life: P | null,
  nextId: string,
  make: () => P,
): { pond: P; life: P | null; changed: boolean } {
  if (current && current.id === nextId) return { pond: current, life, changed: false };
  return { pond: make(), life: null, changed: true };
}

/** The remembered name, or a new default that is remembered from now on. */
export function loadName(store: Store | null, random: () => number = Math.random): string {
  try {
    const kept = cleanName(store?.getItem(NAME_KEY) ?? '');
    if (kept) return kept;
  } catch {
    // storage blocked: fall through to a name for this visit
  }
  const name = defaultName(random);
  saveName(store, name);
  return name;
}

export function saveName(store: Store | null, name: string): void {
  try {
    store?.setItem(NAME_KEY, name);
  } catch {
    // storage blocked: the name lasts for this visit
  }
}

/**
 * The play screen's offline dot (M6b T9): a hub is set but this life cannot use it (unreachable,
 * replaced or outdated), or the life runs apart in a local pond. Connecting shows nothing.
 */
export const offlineChip = (hub: boolean, status: HubStatus | 'none', apart: boolean): boolean =>
  hub && (apart || (status !== 'online' && status !== 'connecting'));

/**
 * The status chip's text. `count` is the players linked to this one (M11 T14: there is no pond to
 * count); `queue` is the place in the admission line while the hub keeps this session waiting,
 * shown with the wait in words (M13 T10).
 */
export function statusText(
  status: HubStatus | 'none',
  count: number,
  queue: QueuePlace | null = null,
  now = Date.now(),
): string {
  if (queue && status === 'connecting') return lineText(queue, now);
  switch (status) {
    case 'online':
      return `Online · ${count} nearby`;
    case 'connecting':
      return 'Connecting…';
    case 'replaced':
      return 'Playing in another tab';
    case 'outdated':
      return 'Update available, reload';
    default:
      return 'Offline · playing alone';
  }
}
