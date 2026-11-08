// The population wave report: `npm run sim:wave` writes `docs/perf/wave.md` and prints it (M12 T9).
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
  const { runWaveReport } = await server.ssrLoadModule('/tools/wave-report.ts');
  const text = runWaveReport();
  await writeFile(new URL('../docs/perf/wave.md', import.meta.url), text);
  process.stdout.write(text);
} finally {
  await server.close();
}
