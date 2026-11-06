// The storage report: `npm run report:storage` runs the measuring hub test (`worker/storage.test.ts`),
// reads the `STORAGE_MEASURE` line it prints, and writes `docs/perf/storage.md` (ADR 0056).
import { spawnSync } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { createServer } from 'vite';

const run = spawnSync(
  'npx',
  ['vitest', 'run', '--project', 'worker', 'worker/storage.test.ts', '--reporter=verbose'],
  { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
);
const line = `${run.stdout}\n${run.stderr}`.split('\n').find((l) => l.startsWith('STORAGE_MEASURE '));
if (run.status !== 0 || !line) {
  process.stderr.write(`${run.stdout}\n${run.stderr}\n`);
  throw new Error('the storage test did not pass and print its measurements');
}
const measure = JSON.parse(line.slice('STORAGE_MEASURE '.length));

const server = await createServer({
  configFile: false,
  appType: 'custom',
  logLevel: 'error',
  server: { middlewareMode: true },
  optimizeDeps: { noDiscovery: true, include: [] },
});
try {
  const { storageReport } = await server.ssrLoadModule('/tools/storage-report.ts');
  const text = storageReport(measure);
  await writeFile(new URL('../docs/perf/storage.md', import.meta.url), text);
  process.stdout.write(text);
} finally {
  await server.close();
}
