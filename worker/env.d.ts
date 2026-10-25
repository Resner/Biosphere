declare const __VERSION__: string;

interface Env {
  AUTHORITY: DurableObjectNamespace<import('./authority').Authority>;
}

declare namespace Cloudflare {
  interface GlobalProps {
    mainModule: typeof import('./index');
  }
  interface Env extends globalThis.Env {}
}
