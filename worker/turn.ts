import type { IceServer } from '../src/net/protocol';

/** Lifetime requested for minted credentials. */
export const TURN_TTL_S = 86_400;
/** A cached entry is replaced once less than this remains. */
export const TURN_REFRESH_MARGIN_MS = 3_600_000;
/** The welcome never waits longer than this for Cloudflare. */
export const TURN_TIMEOUT_MS = 2_000;
export const STUN_SERVERS: IceServer[] = [
  { urls: 'stun:stun.cloudflare.com:3478' },
  { urls: 'stun:stun.l.google.com:19302' },
];

export interface TurnSecrets {
  CF_TURN_KEY_ID?: string;
  CF_TURN_KEY_API_TOKEN?: string;
}

interface Cached {
  entries: IceServer[];
  expires: number;
}

/**
 * The ICE list for a welcome: STUN plus Cloudflare TURN credentials, cached in memory.
 * Any failure (missing secrets, network, bad answer, timeout) degrades to STUN only.
 * Nothing here logs, and no error text from the request is ever kept or returned.
 */
export class TurnCredentials {
  private cached: Cached | null = null;
  private inflight: Promise<IceServer[] | null> | null = null;

  async ice(secrets: TurnSecrets): Promise<{ ice: IceServer[]; turn: boolean }> {
    const turn = await this.turnEntries(secrets);
    return turn
      ? { ice: [...STUN_SERVERS, ...turn], turn: true }
      : { ice: STUN_SERVERS, turn: false };
  }

  reset(): void {
    this.cached = null;
  }

  private turnEntries(secrets: TurnSecrets): Promise<IceServer[] | null> {
    const { CF_TURN_KEY_ID: keyId, CF_TURN_KEY_API_TOKEN: token } = secrets;
    if (!keyId || !token) return Promise.resolve(null);
    if (this.cached && this.cached.expires - Date.now() > TURN_REFRESH_MARGIN_MS) {
      return Promise.resolve(this.cached.entries);
    }
    this.inflight ??= mint(keyId, token)
      .then((entries) => {
        // A failed refresh keeps serving the old credentials while they are still valid.
        if (entries) this.cached = { entries, expires: Date.now() + TURN_TTL_S * 1000 };
        else if (this.cached && this.cached.expires <= Date.now()) this.cached = null;
        return entries ?? this.cached?.entries ?? null;
      })
      .finally(() => {
        this.inflight = null;
      });
    return this.inflight;
  }
}

async function mint(keyId: string, token: string): Promise<IceServer[] | null> {
  try {
    const res = await fetch(
      `https://rtc.live.cloudflare.com/v1/turn/keys/${encodeURIComponent(keyId)}/credentials/generate-ice-servers`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ ttl: TURN_TTL_S }),
        signal: AbortSignal.timeout(TURN_TIMEOUT_MS),
      },
    );
    if (!res.ok) return null;
    return turnEntries(await res.json());
  } catch {
    return null;
  }
}

/** The entries that carry credentials: Cloudflare's answer also lists a plain STUN entry, which we already have. */
function turnEntries(body: unknown): IceServer[] | null {
  const list = (body as { iceServers?: unknown } | null)?.iceServers;
  if (!Array.isArray(list)) return null;
  const entries: IceServer[] = [];
  for (const item of list as Array<Record<string, unknown> | null>) {
    const { urls, username, credential } = item ?? {};
    const okUrls =
      typeof urls === 'string' || (Array.isArray(urls) && urls.every((u) => typeof u === 'string'));
    if (okUrls && typeof username === 'string' && typeof credential === 'string') {
      entries.push({ urls: urls as string | string[], username, credential });
    }
  }
  return entries.length > 0 ? entries : null;
}
