// Prints the diversity report: `npm run report:diversity -- --genesis 2000 --bred 2000 --generations 6`.
// The sources import each other without extensions, so Vite loads them (as the build does).
import { createServer } from 'vite';

const server = await createServer({
  configFile: false,
  appType: 'custom',
  logLevel: 'error',
  server: { middlewareMode: true },
  optimizeDeps: { noDiscovery: true, include: [] },
});
try {
  const { diversityReport, parseArgs } = await server.ssrLoadModule('/tools/diversity-report.ts');
  const report = diversityReport(parseArgs(process.argv.slice(2)));
  process.stdout.write(`${report}\n`);
  // Every body must be valid: a regression fails the run.
  if (!report.includes('(0 invalid)')) process.exitCode = 1;
} finally {
  await server.close();
}
