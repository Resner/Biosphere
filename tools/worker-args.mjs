// Wrangler picks a dev server's inspector port by probing from 9229 and binds it a moment later, so
// the dozens of hubs the E2E run starts together can take the same one, and one dies with "Address
// already in use (socket direct:1:default)". A hub started with `--port N` gets inspector port N+1000
// (the hub ports are 8787 to 8838, so the two ranges never meet), unless the caller chose one.
export function withInspectorPort(command, args) {
  if (command !== 'dev' || args.includes('--inspector-port')) return args;
  const at = args.indexOf('--port');
  const port = Number(args[at + 1]);
  if (at < 0 || !Number.isInteger(port)) return args;
  return [...args, '--inspector-port', String(port + 1000)];
}

// `wrangler dev` attaches miniflare's local trace store to the Worker by default: every message the
// object takes becomes spans kept by a never-evicted object in the hub's own workerd process, which
// held 280 MB more by the soak's minute 6 and grew 400 MB an hour (M14 T14c). The deployed Worker has
// no such store, so a dev hub runs without it unless the caller sets `X_LOCAL_OBSERVABILITY` itself.
export function devEnv(command, env) {
  if (command !== 'dev' || env.X_LOCAL_OBSERVABILITY !== undefined) return env;
  return { ...env, X_LOCAL_OBSERVABILITY: 'false' };
}
