// `npm run goldens:manifest`: rewrites the live rules version's entry of
// `src/ledger/__golden__/frozen.json` from the golden files as they are (ADR 0074). It formats the
// golden files first, as `npm run check` wants them, so the hashes are of the committed bytes. A
// released version's entry never changes: this refuses once the live version is in `RELEASED`.
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

const root = fileURLToPath(new URL('..', import.meta.url));
const dirs = readdirSync(`${root}/src`)
  .map((area) => `src/${area}/__golden__`)
  .filter((dir) => existsSync(`${root}/${dir}`));
const biome = (paths) => {
  const run = spawnSync('npx', ['biome', 'format', '--write', ...paths], {
    cwd: root,
    encoding: 'utf8',
  });
  if (run.status !== 0) throw new Error(`biome format failed:\n${run.stdout}\n${run.stderr}`);
};
biome(dirs);

const server = await createServer({
  configFile: false,
  appType: 'custom',
  logLevel: 'error',
  server: { middlewareMode: true },
  optimizeDeps: { noDiscovery: true, include: [] },
});
try {
  const { writeManifest, MANIFEST } = await server.ssrLoadModule('/tools/goldens-manifest.ts');
  const next = writeManifest(root);
  biome([MANIFEST]);
  const counts = Object.entries(next).map(
    ([v, entry]) => `rules ${v}: ${Object.keys(entry).length} files`,
  );
  process.stdout.write(`${MANIFEST}: ${counts.join(', ')}\n`);
} finally {
  await server.close();
}
