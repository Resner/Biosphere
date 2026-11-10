// The soak: `npm run soak -- --clients 20 --minutes 5` runs headless life clients against the E2E
// Worker under `wrangler dev` (port 8851) and checks what the hub holds at the end (M14 T13). Exits
// 1 when a check fails or a mating, fight, kill, restore or drop never happened. Localhost only.
//
// `--model-mix` plays the capacity model's mix (30-minute sessions, about 3 fights an hour) without the pages.
//
// `npm run soak -- --full` is the one-hour soak (M14 T14): 200 clients joining over 5 minutes, two
// Chromium pages among them (the built `dist/`, served on port 8852), a sample every minute, and
// `docs/perf/soak.md` and `soak.json` written to `--out`. About 70 minutes.
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createServer, preview } from 'vite';

const args = process.argv.slice(2);
const full = args.includes('--full');
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  if (i < 0) return fallback;
  const value = Number(args[i + 1]);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`--${name} wants a positive number, not ${args[i + 1]}`);
  }
  return value;
};
const clients = flag('clients', full ? 200 : 20);
const minutes = flag('minutes', full ? 60 : 5);
const port = flag('port', 8851);
const sitePort = flag('site-port', 8852);
const pages = flag('pages', 2);
const joinMinutes = flag('join-minutes', full ? 5 : 1);
const outAt = args.indexOf('--out');
const out = outAt >= 0 ? args[outAt + 1] : full ? 'docs/perf' : null;
const dropEveryMs = args.includes('--drop-minutes') ? flag('drop-minutes', 10) * 60_000 : undefined;

const server = await createServer({
  configFile: false,
  appType: 'custom',
  logLevel: 'error',
  server: { middlewareMode: true },
  optimizeDeps: { noDiscovery: true, include: [] },
});
let site = null;
let failed = false;
try {
  const { runSoak, problems, missing } = await server.ssrLoadModule('/tools/soak-run.ts');
  const { failures, reportOf, mixLine } = await server.ssrLoadModule('/tools/soak-report.ts');
  if (full) {
    // The built game, on the loopback address as the E2E pages are.
    site = await preview({
      configFile: false,
      logLevel: 'error',
      root: process.cwd(),
      preview: { port: sitePort, strictPort: true, host: '127.0.0.1' },
    });
  }
  const run = await runSoak({
    clients,
    minutes,
    port,
    ...(dropEveryMs ? { dropEveryMs } : {}),
    ...(args.includes('--model-mix') ? { modelMix: true } : {}),
    ...(full ? { full: { site: `http://127.0.0.1:${sitePort}/`, pages, joinMinutes } } : {}),
    log: (line) => process.stderr.write(`${line}\n`),
  });
  process.stdout.write(`${JSON.stringify(run, null, 2)}\n`);
  const mixed = mixLine(run);
  if (mixed) process.stderr.write(`${mixed}\n`);
  const bad = [
    ...new Set([...problems(run), ...failures(run), ...missing(run).map((k) => `no ${k} happened`)]),
  ];
  if (out) {
    await mkdir(out, { recursive: true });
    await writeFile(join(out, 'soak.md'), reportOf(run));
    await writeFile(join(out, 'soak.json'), `${JSON.stringify(run, null, 2)}\n`);
  }
  if (bad.length > 0) {
    process.stderr.write(`FAILED:\n${bad.map((b) => `- ${b}`).join('\n')}\n`);
    failed = true;
  }
} finally {
  await site?.close();
  await server.close();
}
process.exit(failed ? 1 : 0);
