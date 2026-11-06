import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PROBLEM_TEXT } from '../src/ledger/verify';
import { bundleOf, indexOf, lineageHistory } from '../tests/lineage-fixture';
import { nodeIo, runVerify } from './verify-lineage';

// M9 T11: the CLI verifier, run against files from the fixture's honest history, never a live hub.

const history = lineageHistory();
const { A0, A1 } = history.ids;
const [ENC, LOG] = [...history.logs][0] as [string, unknown];

const dir = mkdtempSync(join(tmpdir(), 'verify-lineage-'));
const put = (name: string, value: unknown): string => {
  const path = join(dir, name);
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, JSON.stringify(value));
  return path;
};
const run = (...args: string[]) => runVerify(args, nodeIo({ AUTHORITY_URL: '' }));

const golden = bundleOf(history, A1);
const goldenFile = put('golden/bundle.json', golden);

const tampered = structuredClone(bundleOf(history, A1));
(tampered.records[indexOf(tampered, A0, 1)] as { record: { t: number } }).record.t += 1;
const tamperedFile = put('tampered.json', tampered);

describe('npm run verify:lineage', () => {
  it('exits 0 on the golden, with the verdict first and on one screen', async () => {
    const r = await run(goldenFile);
    expect(r.code).toBe(0);
    const lines = r.out.trimEnd().split('\n');
    expect(lines[0]).toMatch(
      /^Verified back to genesis: [A-Z][a-z]+ [a-z]+, generation 1, 3 creatures, 0 fights replayed$/,
    );
    expect(lines.length).toBeLessThanOrEqual(24);
    expect(r.out).toContain('Not checked');
    expect(r.out).not.toMatch(/\b[0-9a-f]{16,}\b/);
  });

  it('exits 1 on a tampered copy and names the problem in plain words', async () => {
    const r = await run(tamperedFile);
    expect(r.code).toBe(1);
    expect(r.out.split('\n')[0]).toMatch(/^Not verified: /);
    expect(r.out).toContain(PROBLEM_TEXT.hash);
    expect(r.out).not.toMatch(/\b[0-9a-f]{16,}\b/);
  });

  it('--json prints a LineageReport', async () => {
    const r = await run(goldenFile, '--json');
    expect(r.code).toBe(0);
    const report = JSON.parse(r.out);
    expect(report).toMatchObject({ subject: A1, problems: [], toGenesis: true, held: 3 });
    const bad = JSON.parse((await run(tamperedFile, '--json')).out);
    expect(bad.problems.map((p: { code: string }) => p.code)).toContain('hash');
  });

  it('--replay replays the fights whose logs were saved beside the bundle', async () => {
    put('saved/bundle.json', golden);
    put(`saved/fights/${ENC}.json`, { settlement: golden.settlements[0], log: LOG });
    const r = await run(join(dir, 'saved/bundle.json'), '--replay');
    expect(r.code).toBe(0);
    expect(r.out.split('\n')[0]).toContain('1 fight replayed');
    const without = await run(goldenFile, '--replay');
    expect(without.code).toBe(0);
    expect(without.out).toContain('could not be replayed');
  });

  it('--replay reads a pruned log as pruned, and a log that disagrees as a problem', async () => {
    put('pruned/bundle.json', golden);
    put(`pruned/fights/${ENC}.json`, { settlement: golden.settlements[0], log: null });
    const pruned = await run(join(dir, 'pruned/bundle.json'), '--replay');
    expect(pruned.code).toBe(0);
    expect(pruned.out).toContain('pruned');
    const log = structuredClone(LOG) as { frames: unknown[][] };
    log.frames.pop();
    put('cut/bundle.json', golden);
    put(`cut/fights/${ENC}.json`, { settlement: golden.settlements[0], log });
    const cut = await run(join(dir, 'cut/bundle.json'), '--replay');
    expect(cut.code).toBe(1);
  });

  it('exits 1 when the pinned keys lack the bundle’s key', async () => {
    const other = [{ id: 'k'.repeat(16), publicKey: 'a'.repeat(64), from: 0 }];
    const keys = put('other-keys.json', other);
    const r = await run(goldenFile, '--keys', keys);
    expect(r.code).toBe(1);
    expect(r.out).toContain('pinned');
    const same = put('same-keys.json', { keys: golden.keys });
    const ok = await run(goldenFile, '--keys', same);
    expect(ok.code).toBe(0);
    expect(ok.out).toContain('pinned');
  });

  it('exits 2 for nothing to verify', async () => {
    expect((await run()).code).toBe(2);
    expect((await run(join(dir, 'missing.json'))).code).toBe(2);
    expect((await run(put('junk.json', { hello: 1 }))).code).toBe(2);
    expect((await run(goldenFile, '--keys', join(dir, 'missing-keys.json'))).code).toBe(2);
    expect((await run(goldenFile, '--wat')).code).toBe(2);
    expect((await run('abc')).code).toBe(2);
  });

  it('exits 2 for an unreachable hub (a closed local port)', async () => {
    const server = createServer();
    await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
    const port = (server.address() as { port: number }).port;
    await new Promise((ok) => server.close(ok));
    const r = await run(A1, '--hub', `http://127.0.0.1:${port}`);
    expect(r.code).toBe(2);
    expect(r.out).toMatch(/reach/i);
  });

  it('fetches a bundle and its fights from a hub, and --save writes them for offline checks', async () => {
    const hits: string[] = [];
    const fetcher = (async (url: string | URL | Request) => {
      const path = new URL(String(url)).pathname;
      hits.push(path);
      if (path === `/v1/proof/${A1}`) return new Response(JSON.stringify(golden));
      if (path === `/v1/fight/${ENC}`)
        return new Response(JSON.stringify({ settlement: golden.settlements[0], log: LOG }));
      return new Response('{}', { status: 404 });
    }) as typeof fetch;
    const io = { ...nodeIo({}), fetch: fetcher };
    const out = join(dir, 'out');
    const r = await runVerify([A1, '--hub', 'http://hub.test/', '--replay', '--save', out], io);
    expect(r.code).toBe(0);
    expect(r.out.split('\n')[0]).toContain('1 fight replayed');
    expect(hits).toEqual([`/v1/proof/${A1}`, `/v1/fight/${ENC}`]);
    expect(JSON.parse(readFileSync(join(out, 'bundle.json'), 'utf8')).subject).toBe(A1);
    expect(JSON.parse(readFileSync(join(out, `fights/${ENC}.json`), 'utf8')).log).not.toBeNull();
    const again = await run(join(out, 'bundle.json'), '--keys', join(out, 'keys.json'), '--replay');
    expect(again.code).toBe(0);
    expect(again.out.split('\n')[0]).toContain('1 fight replayed');
  });

  it('reads a 404 and a busy hub as nothing to verify', async () => {
    for (const status of [404, 503]) {
      const io = {
        ...nodeIo({}),
        fetch: (async () => new Response('', { status })) as typeof fetch,
      };
      const r = await runVerify([A1, '--hub', 'http://hub.test'], io);
      expect(r.code).toBe(2);
    }
    const asks = nodeIo({ AUTHORITY_URL: 'http://env.test' });
    const seen: string[] = [];
    asks.fetch = (async (url: string | URL | Request) => {
      seen.push(String(url));
      return new Response('', { status: 404 });
    }) as typeof fetch;
    await runVerify([A1], asks);
    expect(seen).toEqual([`http://env.test/v1/proof/${A1}`]);
  });
});
