// The balance simulation: `npm run sim:balance` runs every body's lives on the real rules, split over
// the machine's cores, and writes `docs/perf/balance.md` and `balance.json` (M14 T10, ADR 0078).
// `--variants n --lives n --genesis n` scale it down (and write nothing); a child is `--shard i/n --out file`.
import { spawn } from 'node:child_process';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { cpus, tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'vite';

const args = process.argv.slice(2);
const flag = (name) => {
  const at = args.indexOf(`--${name}`);
  return at < 0 ? undefined : args[at + 1];
};

const server = await createServer({
  configFile: false,
  appType: 'custom',
  logLevel: 'error',
  server: { middlewareMode: true },
  optimizeDeps: { noDiscovery: true, include: [] },
});
try {
  const B = await server.ssrLoadModule('/tests/balance.ts');
  const R = await server.ssrLoadModule('/tools/balance-report.ts');
  const { RULES_VERSION } = await server.ssrLoadModule('/src/sim/rules.ts');
  const variants = Number(flag('variants') ?? B.VARIANTS);
  const genesis = Number(flag('genesis') ?? B.GENESIS_BODIES);
  const lives = Number(flag('lives') ?? B.LIVES);
  const shard = flag('shard');
  const bodies = B.population(variants, genesis);
  if (shard !== undefined) {
    const [i, n] = shard.split('/').map(Number);
    const mine = bodies.filter((_, k) => k % n === i - 1);
    const done = mine.map((body, k) => {
      process.stderr.write(`shard ${i}: ${k + 1}/${mine.length} ${body.id}\n`);
      return B.scoreBody(body, lives, { opponents: bodies });
    });
    await writeFile(flag('out'), JSON.stringify(done));
  } else {
    const started = Date.now();
    const shards = Math.max(1, cpus().length);
    const files = Array.from({ length: shards }, (_, k) => join(tmpdir(), `balance-${process.pid}-${k}.json`));
    const common = ['--variants', variants, '--genesis', genesis, '--lives', lives];
    await Promise.all(
      files.map(
        (out, k) =>
          new Promise((resolve, reject) => {
            const child = spawn(
              process.execPath,
              [process.argv[1], ...common, '--shard', `${k + 1}/${shards}`, '--out', out].map(String),
              { stdio: ['ignore', 'inherit', 'inherit'] },
            );
            child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`shard ${k + 1} exited ${code}`))));
          }),
      ),
    );
    const parts = await Promise.all(files.map(async (f) => JSON.parse(await readFile(f, 'utf8'))));
    await Promise.all(files.map((f) => rm(f)));
    const run = R.mergeRuns(parts.map((b) => ({ rules: RULES_VERSION, variants, genesis, lives, bodies: b })));
    const text = R.balanceReport(run);
    const full = variants === B.VARIANTS && genesis === B.GENESIS_BODIES && lives === B.LIVES;
    if (full) {
      await writeFile(new URL('../docs/perf/balance.md', import.meta.url), text);
      await writeFile(new URL('../docs/perf/balance.json', import.meta.url), `${JSON.stringify(run, null, 2)}\n`);
    }
    process.stdout.write(text);
    process.stdout.write(`\nwall time: ${((Date.now() - started) / 60_000).toFixed(1)} minutes on ${shards} processes\n`);
  }
} finally {
  await server.close();
}
