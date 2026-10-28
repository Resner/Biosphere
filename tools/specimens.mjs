// Searches the specimens M6 T9 adds to the gallery (one per silhouette class, one per rarity tier) and
// prints them, or with `--write` stores them under tests/fixtures/gallery/ as numbered hex files:
// `npm run specimens -- --write --seed gallery-m6 --from 21`. Existing files are never replaced.
import { existsSync, writeFileSync } from 'node:fs';
import { createServer } from 'vite';

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const at = args.indexOf(`--${name}`);
  return at >= 0 ? args[at + 1] : fallback;
};
const seed = flag('seed', 'gallery-m6');
const from = Number(flag('from', '21'));
const write = args.includes('--write');

const server = await createServer({
  configFile: false,
  appType: 'custom',
  logLevel: 'error',
  server: { middlewareMode: true },
  optimizeDeps: { noDiscovery: true, include: [] },
});
try {
  const { findSpecimen, findTier, specimenFile, SPECIMEN_SILHOUETTES, SPECIMEN_TIERS } =
    await server.ssrLoadModule('/tools/specimen.ts');
  const { genomeHash } = await server.ssrLoadModule('/src/genome/codec.ts');
  // The specimens are all different genomes: each search skips what an earlier one took.
  const taken = new Set();
  const take = (found) => {
    if (found) taken.add(genomeHash(found.genome));
    return found;
  };
  const wanted = [
    ...SPECIMEN_SILHOUETTES.map((s) => [s, take(findSpecimen(s, seed, taken))]),
    ...SPECIMEN_TIERS.map((t) => [`tier-${t}`, take(findTier(t, seed, taken))]),
  ];
  const dir = new URL('../tests/fixtures/gallery/', import.meta.url);
  // Check everything first, so a run never leaves a half-written set.
  const missing = wanted.filter(([, found]) => !found).map(([what]) => what);
  if (missing.length > 0) throw new Error(`no specimen found for ${missing.join(', ')}`);
  const files = wanted.map(([what, found], i) => specimenFile(from + i, what, found.genome, seed));
  const clash = files.filter(({ name }) => existsSync(new URL(name, dir)));
  if (write && clash.length > 0)
    throw new Error(`${clash[0].name} exists: specimens never replace one (ADR 0024)`);
  for (const { name, text } of files) {
    process.stdout.write(`${name}\n`);
    if (write) writeFileSync(new URL(name, dir), text);
  }
} finally {
  await server.close();
}
