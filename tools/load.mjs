// The load report: `npm run sim:load` writes `docs/perf/load.md` and `docs/perf/load.json` (M13 T5)
// and exits non-zero when a gate fails. `LOAD_PLAYERS=n` runs a smaller world and writes nothing;
// run it with `--expose-gc` so the heap reading is taken after a collection (the script sets it).
import { writeFile } from 'node:fs/promises';
import { createServer } from 'vite';

const server = await createServer({
  configFile: false,
  appType: 'custom',
  logLevel: 'error',
  server: { middlewareMode: true },
  optimizeDeps: { noDiscovery: true, include: [] },
});
try {
  const { runLoadReport } = await server.ssrLoadModule('/tools/load-report.ts');
  const { FULL_LOAD, boxFor } = await server.ssrLoadModule('/tests/load.ts');
  const scaled = Number(process.env.LOAD_PLAYERS ?? 0);
  const shape = scaled > 0 ? { ...FULL_LOAD, name: 'load', players: scaled, boxHalf: boxFor(scaled) } : FULL_LOAD;
  const started = Date.now();
  const { text, measure } = runLoadReport(shape, undefined, () => (Date.now() - started) / 1000);
  if (scaled > 0) {
    process.stdout.write(text);
  } else {
    await writeFile(new URL('../docs/perf/load.md', import.meta.url), text);
    await writeFile(
      new URL('../docs/perf/load.json', import.meta.url),
      `${JSON.stringify(measure, null, 2)}\n`,
    );
    process.stdout.write(text);
  }
  process.stdout.write(`\nwall time: ${((Date.now() - started) / 60_000).toFixed(1)} minutes\n`);
  if (!measure.ok) process.exitCode = 1;
} finally {
  await server.close();
}
