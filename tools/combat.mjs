// The combat report: `npm run report:combat` writes `docs/perf/combat.md` and prints it.
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
  const { combatReport } = await server.ssrLoadModule('/tools/combat-report.ts');
  const text = combatReport();
  await writeFile(new URL('../docs/perf/combat.md', import.meta.url), text);
  process.stdout.write(text);
} finally {
  await server.close();
}
