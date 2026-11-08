// Runs wrangler for the Worker with the build version injected: `node tools/worker.mjs dev|deploy …`.
//
// Wrangler's CLI runs as this process's one child, with no `npx` or `.bin` shim between: each shim is
// a resident Node process, and the E2E run keeps three dozen hubs up at once (about 100 MB of a
// 16 GB runner for each hub that the shims held).
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { versionDefine } from './version.mjs';
import { withInspectorPort } from './worker-args.mjs';

const [command, ...args] = process.argv.slice(2);
// `--e2e` selects the config whose Worker serves recorded drand rounds (never deployed).
const e2e = args.includes('--e2e');
const rest = withInspectorPort(
  command,
  args.filter((arg) => arg !== '--e2e'),
);
const config = fileURLToPath(
  new URL(`../worker/wrangler${e2e ? '.e2e' : ''}.jsonc`, import.meta.url),
);
const defines = Object.entries(versionDefine()).flatMap(([key, value]) => [
  '--define',
  `${key}:${value}`,
]);
// `wrangler/bin/wrangler.js` only starts `wrangler-dist/cli.js` with `--no-warnings`.
const cli = createRequire(import.meta.url).resolve('wrangler');
const child = spawn(
  process.execPath,
  ['--no-warnings', cli, command, '-c', config, ...defines, ...rest],
  { stdio: 'inherit' },
);
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, () => child.kill(signal));
child.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
