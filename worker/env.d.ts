declare const __VERSION__: string;

interface Env {
  /** Worker secrets (TURN is optional: without them the hub offers STUN only). */
  CF_TURN_KEY_ID?: string;
  CF_TURN_KEY_API_TOKEN?: string;
  /** `fixture` in `wrangler.e2e.jsonc`: that entry serves recorded drand rounds (the production bundle has no fixture code). */
  DRAND_SOURCE?: string;
  /** A fraction in (0, 1] that shortens every lifespan for E2E; honoured only together with `DRAND_SOURCE=fixture`. */
  LIFESPAN_SCALE?: string;
  /** A fraction in (0, 1] that shortens maturity, cooldown and the repeat window for E2E; fixture mode only (ADR 0021). */
  MATING_SCALE?: string;
  /** Whole ms, at most 10 s: how long a fight everyone left waits before it is played out at once, for E2E; fixture mode only (ADR 0053). */
  AWAY_GRACE_MS?: string;
  /** Witnesses, for E2E and fixture mode only (ADR 0058): the play needed to witness (whole ms), and `off` to skip the IP check (every local context shares localhost). */
  WITNESS_PLAY_MS?: string;
  WITNESS_IP_CHECK?: string;
  /** The directory's leaf cap (1–16, M11 T6), so a few E2E pages make leaves; fixture mode only. */
  LEAF_MAX?: string;
  /** Crowd instances (M12 T5), fixture mode only: an instance's fill (1–16) and how long a crowd stays quiet before it merges (whole ms, at least 500). */
  INSTANCE_MAX?: string;
  QUIET_MS?: string;
  /** How long a player is alone before it may ride the current (whole ms, at least 1,000; M12 T7); fixture mode only. */
  RIDE_ALONE_MS?: string;
  /** Admission (DESIGN §8): sessions past `MAX_SESSIONS`, or past 90% of `DAILY_REQUEST_BUDGET` requests a day, wait in line. */
  MAX_SESSIONS?: string;
  DAILY_REQUEST_BUDGET?: string;
  AUTHORITY: DurableObjectNamespace<import('./authority').Authority>;
}

declare namespace Cloudflare {
  interface GlobalProps {
    mainModule: typeof import('./index');
  }
  interface Env extends globalThis.Env {}
}
