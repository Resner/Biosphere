// The capacity report: `npm run report:capacity` writes `docs/CAPACITY.md` from the committed
// measurements in `docs/perf/` and `worker/plan.ts` (M13 T8, ADR 0067). Flags:
//   --measured       print `MEASURED` as TypeScript for `worker/plan.ts` and write nothing
//   --write-measured rewrite `MEASURED` in `worker/plan.ts` from the measurements
//   --metrics <file> a saved `/v1/metrics` answer: its per-player numbers replace the assumptions they measure
import { readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'vite';

const args = process.argv.slice(2);
const read = async (name) =>
  JSON.parse(await readFile(new URL(`../docs/perf/${name}.json`, import.meta.url), 'utf8'));
const inputs = {
  load: await read('load'),
  hub: await read('hub'),
  hubLoad: await read('hub-load'),
  storage: await read('storage'),
  witness: await read('witness'),
};
const flag = args.indexOf('--metrics');
const metrics = flag >= 0 ? JSON.parse(await readFile(args[flag + 1], 'utf8')) : null;

const server = await createServer({
  configFile: false,
  appType: 'custom',
  logLevel: 'error',
  server: { middlewareMode: true },
  optimizeDeps: { noDiscovery: true, include: [] },
});
try {
  const { measuredFrom, measuredSource } = await server.ssrLoadModule('/tools/capacity-measure.ts');
  if (args.includes('--measured') || args.includes('--write-measured')) {
    const source = measuredSource(measuredFrom(inputs));
    if (args.includes('--measured')) {
      process.stdout.write(source);
    } else {
      const file = new URL('../worker/plan.ts', import.meta.url);
      const text = await readFile(file, 'utf8');
      const next = text.replace(
        /( {2}\/\/ MEASURED-BEGIN\n)[\s\S]*?( {2}\/\/ MEASURED-END)/,
        `$1${source}$2`,
      );
      await writeFile(file, next);
    }
  } else {
    const { capacityReport } = await server.ssrLoadModule('/tools/capacity-report.ts');
    const text = capacityReport(inputs, metrics);
    await writeFile(new URL('../docs/CAPACITY.md', import.meta.url), text);
    process.stdout.write(text);
  }
} finally {
  await server.close();
}
