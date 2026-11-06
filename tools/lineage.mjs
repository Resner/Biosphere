// The lineage verifier: `npm run verify:lineage -- <creature id | bundle.json> [options]`.
import { createServer } from 'vite';

const server = await createServer({
  configFile: false,
  appType: 'custom',
  logLevel: 'error',
  server: { middlewareMode: true },
  optimizeDeps: { noDiscovery: true, include: [] },
});
try {
  const { nodeIo, runVerify } = await server.ssrLoadModule('/tools/verify-lineage.ts');
  const { code, out } = await runVerify(process.argv.slice(2), nodeIo());
  (code === 2 ? process.stderr : process.stdout).write(out);
  process.exitCode = code;
} finally {
  await server.close();
}
