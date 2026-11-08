// The hub cost report: `npm run report:hub` runs the measuring test (`worker/hub-cost.test.ts`),
// reads the `HUB_COST` line it prints, and writes `docs/perf/hub.md` and `docs/perf/hub.json`
// (M13 T6, ADR 0067).
import { spawnSync } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { createServer } from 'vite';

const run = spawnSync(
  'npx',
  ['vitest', 'run', '--project', 'worker', 'worker/hub-cost.test.ts', '--reporter=verbose'],
  { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
);
const line = `${run.stdout}\n${run.stderr}`.split('\n').find((l) => l.startsWith('HUB_COST '));
if (run.status !== 0 || !line) {
  process.stderr.write(`${run.stdout}\n${run.stderr}\n`);
  throw new Error('the hub cost test did not pass and print its measurements');
}
const cost = JSON.parse(line.slice('HUB_COST '.length));

const server = await createServer({
  configFile: false,
  appType: 'custom',
  logLevel: 'error',
  server: { middlewareMode: true },
  optimizeDeps: { noDiscovery: true, include: [] },
});
try {
  const { hubReport, rounded } = await server.ssrLoadModule('/tools/hub-report.ts');
  const text = hubReport(cost);
  await writeFile(new URL('../docs/perf/hub.md', import.meta.url), text);
  await writeFile(
    new URL('../docs/perf/hub.json', import.meta.url),
    `${JSON.stringify(rounded(cost), null, 2)}\n`,
  );
  process.stdout.write(text);
} finally {
  await server.close();
}
