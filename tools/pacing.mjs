// Prints the pacing report: `npm run sim:pacing -- --creatures 12 --minutes 120`.
import { createServer } from 'vite';

const server = await createServer({
  configFile: false,
  appType: 'custom',
  logLevel: 'error',
  server: { middlewareMode: true },
  optimizeDeps: { noDiscovery: true, include: [] },
});
try {
  const { pacingReport, parseArgs } = await server.ssrLoadModule('/tools/pacing-report.ts');
  process.stdout.write(`${pacingReport(parseArgs(process.argv.slice(2)))}\n`);
} finally {
  await server.close();
}
