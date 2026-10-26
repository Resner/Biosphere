declare const __VERSION__: string;

interface Env {
  /** Worker secrets (TURN is optional: without them the hub offers STUN only). */
  CF_TURN_KEY_ID?: string;
  CF_TURN_KEY_API_TOKEN?: string;
  /** `fixture` in `wrangler.e2e.jsonc`: that entry serves recorded drand rounds (the production bundle has no fixture code). */
  DRAND_SOURCE?: string;
  AUTHORITY: DurableObjectNamespace<import('./authority').Authority>;
}

declare namespace Cloudflare {
  interface GlobalProps {
    mainModule: typeof import('./index');
  }
  interface Env extends globalThis.Env {}
}
