import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { lineageHistory } from '../../tests/lineage-fixture';
import type { ProofBundle } from '../ledger/proof';
import { authorityBase, creatureParam, ERROR_TEXT, loadFight, loadProof } from './load';

// M9 T12: where the card reads its proof, and each failure in its own words.

const GOLDEN = readFileSync(new URL('../ledger/__golden__/lineage.json', import.meta.url), 'utf8');
const SUBJECT = (JSON.parse(GOLDEN) as ProofBundle).subject;
const BASE = 'http://localhost:8818';

const answering =
  (status: number, body: string): typeof fetch =>
  async () =>
    new Response(body, { status });

describe('the query', () => {
  it('takes a 64-hex creature id only', () => {
    expect(creatureParam(`?c=${SUBJECT}`)).toBe(SUBJECT);
    expect(creatureParam(`?c=${SUBJECT.toUpperCase()}`)).toBe(SUBJECT);
    expect(creatureParam('?c=xyz')).toBeNull();
    expect(creatureParam('')).toBeNull();
  });

  it('honours ?hub= for a local authority only, else the build URL', () => {
    expect(authorityBase('?hub=http://localhost:8818', '')).toBe(BASE);
    expect(authorityBase('?hub=https://evil.example', 'https://auth.example')).toBe(
      'https://auth.example',
    );
    expect(authorityBase('', 'wss://auth.example')).toBe('https://auth.example');
    expect(authorityBase('?hub=https://evil.example', '')).toBeNull();
  });
});

describe('the reads', () => {
  it('parse the golden bundle', async () => {
    const got = await loadProof(answering(200, GOLDEN), BASE, SUBJECT);
    expect(got.ok && got.value.subject).toBe(SUBJECT);
  });

  it('name each failure', async () => {
    const id = SUBJECT;
    expect(await loadProof(answering(404, '{"error":"not-found"}'), BASE, id)).toEqual({
      ok: false,
      error: 'not-found',
    });
    expect(await loadProof(answering(503, '{"error":"busy"}'), BASE, id)).toMatchObject({
      error: 'busy',
    });
    expect(await loadProof(answering(413, '{"error":"too-big"}'), BASE, id)).toEqual({
      ok: false,
      error: 'too-big',
    });
    expect(ERROR_TEXT['too-big']).toBe("This creature's history is too long to check here");
    const offline: typeof fetch = async () => {
      throw new TypeError('Failed to fetch');
    };
    expect(await loadProof(offline, BASE, id)).toMatchObject({ error: 'offline' });
    expect(await loadProof(answering(200, '{"v":1'), BASE, id)).toMatchObject({
      error: 'malformed',
    });
    expect(await loadProof(answering(200, '{"v":1}'), BASE, id)).toMatchObject({
      error: 'malformed',
    });
    // Another creature's bundle is not this one's proof.
    expect(await loadProof(answering(200, GOLDEN), BASE, '0'.repeat(64))).toMatchObject({
      error: 'malformed',
    });
  });

  it('read a fight proof only for its own fight', async () => {
    const h = lineageHistory();
    const [enc, log] = [...h.logs][0] ?? [];
    if (!enc || !log) throw new Error('no fight');
    const body = JSON.stringify({ settlement: h.settlements.get(enc), log });
    const got = await loadFight(answering(200, body), BASE, enc);
    expect(got.ok && got.value.log?.frames.length).toBe(log.frames.length);
    expect(await loadFight(answering(200, body), BASE, '1'.repeat(64))).toMatchObject({
      error: 'malformed',
    });
  });
});
