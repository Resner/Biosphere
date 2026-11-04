// The netcode report: `npm run report:net` writes `docs/perf/netcode.md` and prints it.
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
  const { netReport } = await server.ssrLoadModule('/tools/net-report.ts');
  const text = netReport();
  await writeFile(new URL('../docs/perf/netcode.md', import.meta.url), text);
  process.stdout.write(text);
} finally {
  await server.close();
}
