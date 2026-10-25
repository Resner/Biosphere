// Runs wrangler for the Worker with the build version injected: `node tools/worker.mjs dev|deploy …`.
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { versionDefine } from './version.mjs';

const config = fileURLToPath(new URL('../worker/wrangler.jsonc', import.meta.url));
const defines = Object.entries(versionDefine()).flatMap(([key, value]) => [
  '--define',
  `${key}:${value}`,
]);
const [command, ...rest] = process.argv.slice(2);
const result = spawnSync('npx', ['wrangler', command, '-c', config, ...defines, ...rest], {
  stdio: 'inherit',
});
process.exit(result.status ?? 1);
