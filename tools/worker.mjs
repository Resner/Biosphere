// Runs wrangler for the Worker with the build version injected: `node tools/worker.mjs dev|deploy …`.
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { versionDefine } from './version.mjs';

const [command, ...args] = process.argv.slice(2);
// `--e2e` selects the config whose Worker serves recorded drand rounds (never deployed).
const e2e = args.includes('--e2e');
const rest = args.filter((arg) => arg !== '--e2e');
const config = fileURLToPath(
  new URL(`../worker/wrangler${e2e ? '.e2e' : ''}.jsonc`, import.meta.url),
);
const defines = Object.entries(versionDefine()).flatMap(([key, value]) => [
  '--define',
  `${key}:${value}`,
]);
const result = spawnSync('npx', ['wrangler', command, '-c', config, ...defines, ...rest], {
  stdio: 'inherit',
});
process.exit(result.status ?? 1);
