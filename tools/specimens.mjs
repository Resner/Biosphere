// Searches the specimens M6 T9 adds to the gallery (one per silhouette class, one per rarity tier) and
// prints them, or with `--write` stores them under tests/fixtures/gallery/ as numbered hex files:
// `npm run specimens -- --write --seed gallery-m6 --from 21`. Existing files are never replaced.
// `--features` searches the look-feature specimens of look pass 5 instead (ADR 0032):
// `npm run specimens -- --features --write --seed gallery-m6 --from 37`; `--feature <name>` searches
// only that one (M6b T6: `--features --feature s-worm --write --seed gallery-m6 --from 40`).
// After a world reset (ADR 0043), `--refresh --write --seed gallery-m6c` checks every class and tier
// specimen against the live rules, rewrites its comment, and searches again, in the same cell, only
// one that no longer shows what it stands for (a look-feature specimen that no longer shows its
// feature is only reported). `--evolved --write --seed gallery-m6c --from 7
// --count 14` stores the evolved cells: the last body of each lineage of the Lab's Evolved grids
// (M6c T5); delete the old cells first, since a write never replaces a file.
import { existsSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'vite';

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const at = args.indexOf(`--${name}`);
  return at >= 0 ? args[at + 1] : fallback;
};
const seed = flag('seed', 'gallery-m6');
const from = Number(flag('from', '21'));
const write = args.includes('--write');
const features = args.includes('--features');
const only = flag('feature', null);
const refresh = args.includes('--refresh');
const evolved = args.includes('--evolved');
const count = Number(flag('count', '14'));

const server = await createServer({
  configFile: false,
  appType: 'custom',
  logLevel: 'error',
  server: { middlewareMode: true },
  optimizeDeps: { noDiscovery: true, include: [] },
});
try {
  const {
    FEATURES,
    findFeature,
    findSpecimen,
    findTier,
    specimenFile,
    SPECIMEN_SILHOUETTES,
    SPECIMEN_TIERS,
    evolvedFile,
    evolvedPicks,
    specimenWhat,
    stillShows,
  } = await server.ssrLoadModule('/tools/specimen.ts');
  const { genomeHash } = await server.ssrLoadModule('/src/genome/codec.ts');
  const { parseSpecimen } = await server.ssrLoadModule('/src/lab/gallery.ts');
  const dir = new URL('../tests/fixtures/gallery/', import.meta.url);
  const stored = () =>
    readdirSync(dir)
      .filter((f) => f.endsWith('.hex'))
      .sort()
      .map((f) => {
        const specimen = parseSpecimen(f, readFileSync(new URL(f, dir), 'utf8'));
        if (!specimen) throw new Error(`${f}: not a gallery specimen`);
        return specimen;
      });
  if (refresh || evolved) {
    const all = stored();
    const taken = new Set(all.map((s) => genomeHash(s.genome)));
    const out = [];
    if (evolved) {
      const picks = evolvedPicks(seed, count, taken);
      out.push(...picks.map((pick, i) => ({ old: null, ...evolvedFile(from + i, pick) })));
    } else {
      for (const s of all) {
        const what = specimenWhat(s.file);
        if (what === null) continue;
        const index = Number(s.file.slice(0, 2));
        const kept = stillShows(what, s.genome);
        // The look-feature specimens are not class or tier specimens: ADR 0043 leaves them as stored.
        if (what in FEATURES) {
          if (!kept) process.stdout.write(`${s.file}: no longer shows ${what} (left as stored)\n`);
          continue;
        }
        const at = /search seed ([^)]+)\)/.exec(s.comment)?.[1] ?? seed;
        const found = kept
          ? { genome: s.genome }
          : what.startsWith('tier-')
            ? findTier(what.slice(5), seed, taken)
            : findSpecimen(what, seed, taken);
        if (!found) throw new Error(`no specimen found for ${what}`);
        taken.add(genomeHash(found.genome));
        process.stdout.write(`${s.file}: ${kept ? 'kept' : 'searched again'}\n`);
        out.push({ old: s.file, ...specimenFile(index, what, found.genome, kept ? at : seed) });
      }
    }
    for (const { old, name, text } of out) {
      process.stdout.write(`${name}\n`);
      if (!write) continue;
      if (old === null && existsSync(new URL(name, dir))) throw new Error(`${name} exists`);
      if (old !== null && old !== name) unlinkSync(new URL(old, dir));
      writeFileSync(new URL(name, dir), text);
    }
    process.exit(0);
  }
  // The specimens are all different genomes: each search skips what an earlier one took, and the
  // feature search also skips every specimen already in the gallery.
  const taken = new Set(
    features
      ? readdirSync(dir)
          .filter((f) => f.endsWith('.hex'))
          .map((f) => {
            const specimen = parseSpecimen(f, readFileSync(new URL(f, dir), 'utf8'));
            if (!specimen) throw new Error(`${f}: not a gallery specimen`);
            return genomeHash(specimen.genome);
          })
      : [],
  );
  const take = (found) => {
    if (found) taken.add(genomeHash(found.genome));
    return found;
  };
  const wanted = features
    ? Object.keys(FEATURES)
        .filter((f) => only === null || f === only)
        .map((f) => [f, take(findFeature(f, seed, taken))])
    : [
        ...SPECIMEN_SILHOUETTES.map((s) => [s, take(findSpecimen(s, seed, taken))]),
        ...SPECIMEN_TIERS.map((t) => [`tier-${t}`, take(findTier(t, seed, taken))]),
      ];
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
