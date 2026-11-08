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
