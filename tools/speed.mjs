// Prints the speed report: `npm run report:speed -- --bodies 1000 --generations 6`.
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
  const { speedReport, parseArgs } = await server.ssrLoadModule('/tools/speed-report.ts');
  const report = speedReport(parseArgs(process.argv.slice(2)));
  process.stdout.write(`${report}\n`);
} finally {
  await server.close();
}
