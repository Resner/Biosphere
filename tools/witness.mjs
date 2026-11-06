// The witness cost report: `npm run report:witness` runs the measuring hub test
// (`worker/witness-cost.test.ts`), reads the `WITNESS_MEASURE` and `WITNESS_CPU` lines it prints,
// and writes `docs/perf/witness.md` (ADR 0058).
import { spawnSync } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { createServer } from 'vite';

const run = spawnSync(
  'npx',
  ['vitest', 'run', '--project', 'worker', 'worker/witness-cost.test.ts', '--reporter=verbose'],
  { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
);
const lines = `${run.stdout}\n${run.stderr}`.split('\n');
const read = (tag) => {
  const line = lines.find((l) => l.startsWith(`${tag} `));
  return line ? JSON.parse(line.slice(tag.length + 1)) : null;
};
const measure = read('WITNESS_MEASURE');
const cpu = read('WITNESS_CPU');
if (run.status !== 0 || !measure || !cpu) {
  process.stderr.write(`${run.stdout}\n${run.stderr}\n`);
  throw new Error('the witness cost test did not pass and print its measurements');
}

const server = await createServer({
  configFile: false,
  appType: 'custom',
  logLevel: 'error',
  server: { middlewareMode: true },
  optimizeDeps: { noDiscovery: true, include: [] },
});
try {
  const { witnessReport } = await server.ssrLoadModule('/tools/witness-report.ts');
  const text = witnessReport({ ...measure, ...cpu });
  await writeFile(new URL('../docs/perf/witness.md', import.meta.url), text);
  process.stdout.write(text);
} finally {
  await server.close();
}
