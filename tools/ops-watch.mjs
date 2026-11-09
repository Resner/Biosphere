// The operator's watch (M14 T15): `npm run ops:watch -- --url <authority>` polls `/v1/metrics`
// every 60 s (its edge cache) and `/v1/audit` every 5 minutes, prints one status line per poll and
// a warning line when an action of `docs/OPERATIONS.md` applies, and saves every answer under
// `ops/<UTC date>/` (git-ignored), where `npm run report:capacity -- --metrics <file>` can take it.
//   --once      one poll of both, one status line, then exit (1 when an answer could not be read)
//   --dir <d>   where answers are saved (default ops)
//   --every <s> the metrics interval in seconds (default 60; the audit is every 5th poll)
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { createServer } from 'vite';

const args = process.argv.slice(2);
const value = (name) => {
  const i = args.indexOf(`--${name}`);
  return i < 0 ? undefined : args[i + 1];
};
const url = value('url');
if (!url || !/^https?:\/\//.test(url)) {
  process.stderr.write('usage: npm run ops:watch -- --url <authority URL> [--once] [--dir ops] [--every 60]\n');
  process.exit(2);
}
const once = args.includes('--once');
const dir = value('dir') ?? 'ops';
const every = Number(value('every') ?? 60);
if (!Number.isFinite(every) || every <= 0) {
  process.stderr.write('--every wants a positive number of seconds\n');
  process.exit(2);
}
const base = url.replace(/\/+$/, '');
const AUDIT_EVERY = 5;

const server = await createServer({
  configFile: false,
  appType: 'custom',
  logLevel: 'error',
  server: { middlewareMode: true },
  optimizeDeps: { noDiscovery: true, include: [] },
});
const w = await server.ssrLoadModule('/tools/ops-lines.ts');

/** Fetches a JSON answer: `{ ok, value }` or `{ ok: false, error }`; never throws. */
async function get(path) {
  try {
    const res = await fetch(`${base}${path}`, { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) return { ok: false, error: `${path} answered ${res.status}` };
    return { ok: true, value: await res.json() };
  } catch (e) {
    return { ok: false, error: `${path} failed: ${e instanceof Error ? e.message : String(e)}` };
  }
}

async function save(kind, at, raw) {
  const file = w.savePath(dir, kind, at);
  try {
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, `${JSON.stringify(raw, null, 2)}\n`);
  } catch (e) {
    process.stdout.write(`${w.errorLine(at, `could not save ${file}: ${e.message}`)}\n`);
  }
}

let before;
let audit = null;
let bad = false;

async function poll(n) {
  const at = Date.now();
  bad = false;
  if (once || n % AUDIT_EVERY === 0) {
    const got = await get('/v1/audit');
    const parsed = got.ok ? w.parseAudit(got.value) : got;
    if (parsed.ok) {
      audit = parsed.value;
      await save('audit', at, got.value);
    } else {
      bad = true;
      process.stdout.write(`${w.errorLine(at, parsed.error)}\n`);
    }
  }
  const got = await get('/v1/metrics');
  const parsed = got.ok ? w.parseMetrics(got.value) : got;
  if (!parsed.ok) {
    bad = true;
    process.stdout.write(`${w.errorLine(at, parsed.error)}\n`);
    return;
  }
  const m = parsed.value;
  await save('metrics', at, got.value);
  process.stdout.write(`${w.statusLine(m, audit, before)}\n`);
  for (const warning of w.warnings(m, audit, before)) {
    process.stdout.write(`${w.warningLine(m.now, warning)}\n`);
  }
  before = m;
}

try {
  if (once) {
    await poll(0);
    process.exitCode = bad ? 1 : 0;
  } else {
    for (let n = 0; ; n++) {
      await poll(n);
      await new Promise((r) => setTimeout(r, every * 1000));
    }
  }
} finally {
  await server.close();
}
