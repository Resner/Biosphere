// The area-of-interest report: `npm run report:aoi` writes `docs/perf/aoi.md` and prints it (M11 T10).
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
  const { runAoiReport } = await server.ssrLoadModule('/tools/aoi-report.ts');
  const text = runAoiReport();
  await writeFile(new URL('../docs/perf/aoi.md', import.meta.url), text);
  process.stdout.write(text);
} finally {
  await server.close();
}
