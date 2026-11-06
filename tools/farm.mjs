// The bot-farm report: `npm run report:farm` runs the farm simulation on a hub (`worker/farm.test.ts`),
// reads the `FARM_MEASURE` line each scenario prints, and writes `docs/perf/farm.md` (ADR 0059).
import { spawnSync } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { createServer } from 'vite';

const run = spawnSync(
  'npx',
  [
    'vitest',
    'run',
    '--project',
    'worker',
    'worker/farm.test.ts',
    '--reporter=verbose',
    '--disable-console-intercept',
  ],
  { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
);
const lines = `${run.stdout}\n${run.stderr}`.split('\n').filter((l) => l.startsWith('FARM_MEASURE '));
if (run.status !== 0 || lines.length === 0) {
  process.stderr.write(`${run.stdout}\n${run.stderr}\n`);
  throw new Error('the farm simulation did not pass and print its measurements');
}
const measures = lines.map((l) => JSON.parse(l.slice('FARM_MEASURE '.length)));

const server = await createServer({
  configFile: false,
  appType: 'custom',
  logLevel: 'error',
  server: { middlewareMode: true },
  optimizeDeps: { noDiscovery: true, include: [] },
});
try {
  const { farmReport } = await server.ssrLoadModule('/tools/farm-sim.ts');
  const text = farmReport(measures);
  await writeFile(new URL('../docs/perf/farm.md', import.meta.url), text);
  process.stdout.write(text);
} finally {
  await server.close();
}
