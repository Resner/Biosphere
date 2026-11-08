// The hub load: `npm run load:hub` joins 500 headless clients to the E2E Worker under `wrangler dev`
// for 10 minutes (2 joining, 6 held, 2 leaving), then writes `docs/perf/hub-load.md` and
// `hub-load.json` (M13 T7). `--clients N` and `--minutes M` give a quick mode (the 2:6:2 split of M
// minutes) that prints the report and writes nothing unless `--write` is given. Exits 1 when the
// run fails a check, and then writes nothing. Linux only for the CPU and memory figures.
import { writeFile } from 'node:fs/promises';
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
const quick = args.includes('--clients') || args.includes('--minutes');
const clients = flag('clients', 500);
const minutes = flag('minutes', 10);
const port = flag('port', 8850);
const write = !quick || args.includes('--write');

const server = await createServer({
  configFile: false,
  appType: 'custom',
  logLevel: 'error',
  server: { middlewareMode: true },
  optimizeDeps: { noDiscovery: true, include: [] },
});
let failed = false;
try {
  const { runHubLoad } = await server.ssrLoadModule('/tools/load-hub-run.ts');
  const { loadReport, problems, rounded } = await server.ssrLoadModule('/tools/load-hub-report.ts');
  const load = await runHubLoad({
    clients,
    joinMin: minutes * 0.2,
    holdMin: minutes * 0.6,
    leaveMin: minutes * 0.2,
    offersPerMinute: 2,
    port,
    log: (line) => process.stderr.write(`${line}\n`),
  });
  const text = loadReport(load);
  const bad = problems(load);
  // A run that fails a check is printed and never written over the committed report.
  if (write && bad.length === 0) {
    await writeFile(new URL('../docs/perf/hub-load.md', import.meta.url), text);
    await writeFile(
      new URL('../docs/perf/hub-load.json', import.meta.url),
      `${JSON.stringify(rounded(load), null, 2)}\n`,
    );
  }
  process.stdout.write(text);
  if (bad.length > 0) {
    process.stderr.write(`FAILED:\n${bad.map((b) => `- ${b}`).join('\n')}\n`);
    failed = true;
  }
} finally {
  await server.close();
}
process.exit(failed ? 1 : 0);
