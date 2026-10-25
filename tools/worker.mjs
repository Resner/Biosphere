// Runs wrangler for the Worker with the build version injected: `node tools/worker.mjs dev|deploy …`.
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const version = readFileSync(new URL('../VERSION', import.meta.url), 'utf8').trim();
const config = fileURLToPath(new URL('../worker/wrangler.jsonc', import.meta.url));
const [command, ...rest] = process.argv.slice(2);
const result = spawnSync(
  'npx',
  ['wrangler', command, '-c', config, '--define', `__VERSION__:${JSON.stringify(version)}`, ...rest],
  { stdio: 'inherit' },
);
process.exit(result.status ?? 1);
