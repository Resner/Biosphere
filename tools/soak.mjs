// The soak: `npm run soak -- --clients 20 --minutes 5` runs headless life clients against the E2E
// Worker under `wrangler dev` (port 8851) and checks what the hub holds at the end (M14 T13). Exits
// 1 when a check fails or a mating, fight, kill, restore or drop never happened. Localhost only.
import { createServer } from 'vite';

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  if (i < 0) return fallback;
  const value = Number(args[i + 1]);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`--${name} wants a positive number, not ${args[i + 1]}`);
  }
  return value;
};
const clients = flag('clients', 20);
const minutes = flag('minutes', 5);
const port = flag('port', 8851);
const dropEveryMs = args.includes('--drop-minutes') ? flag('drop-minutes', 10) * 60_000 : undefined;

const server = await createServer({
  configFile: false,
  appType: 'custom',
  logLevel: 'error',
  server: { middlewareMode: true },
  optimizeDeps: { noDiscovery: true, include: [] },
});
let failed = false;
try {
  const { runSoak, problems, missing } = await server.ssrLoadModule('/tools/soak-run.ts');
  const run = await runSoak({
    clients,
    minutes,
    port,
    ...(dropEveryMs ? { dropEveryMs } : {}),
    log: (line) => process.stderr.write(`${line}\n`),
  });
  process.stdout.write(`${JSON.stringify(run, null, 2)}\n`);
  const bad = [...problems(run), ...missing(run).map((k) => `no ${k} happened`)];
  if (bad.length > 0) {
    process.stderr.write(`FAILED:\n${bad.map((b) => `- ${b}`).join('\n')}\n`);
    failed = true;
  }
} finally {
  await server.close();
}
process.exit(failed ? 1 : 0);
