// Writes tests/fixtures/drand/{info,rounds}.json from the live drand hosts.
// The sources import each other without extensions, so Vite loads them (as in diversity.mjs).
import { mkdirSync, writeFileSync } from 'node:fs';
import { createServer } from 'vite';

const dir = new URL('../tests/fixtures/drand/', import.meta.url);
const server = await createServer({
  configFile: false,
  appType: 'custom',
  logLevel: 'error',
  server: { middlewareMode: true },
  optimizeDeps: { noDiscovery: true, include: [] },
});
try {
  const { fetchInfo, recordFrom, recordRounds, SOAK_ROUNDS } = await server.ssrLoadModule(
    '/tools/record-drand.ts',
  );
  if (process.argv.includes('--soak')) {
    // The soak outlasts the 30 minutes of `rounds.json`: the same first round, so the shared rounds
    // are the very same signatures, and 80 minutes of them (`soak-rounds.json`, E2E Worker only).
    const { readFileSync } = await import('node:fs');
    const { first } = JSON.parse(readFileSync(new URL('rounds.json', dir), 'utf8'));
    const rounds = await recordFrom(fetch, first, SOAK_ROUNDS);
    mkdirSync(dir, { recursive: true });
    writeFileSync(new URL('soak-rounds.json', dir), `${JSON.stringify(rounds)}\n`);
    process.stdout.write(`recorded soak rounds ${rounds.first}..${rounds.last} (${rounds.beacons.length})\n`);
  } else {
    const info = await fetchInfo(fetch);
    const rounds = await recordRounds(fetch);
    mkdirSync(dir, { recursive: true });
    writeFileSync(new URL('info.json', dir), `${JSON.stringify(info, null, 2)}\n`);
    writeFileSync(new URL('rounds.json', dir), `${JSON.stringify(rounds)}\n`);
    process.stdout.write(`recorded rounds ${rounds.first}..${rounds.last} (${rounds.beacons.length})\n`);
  }
} finally {
  await server.close();
}
