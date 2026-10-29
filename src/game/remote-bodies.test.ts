import { describe, expect, it } from 'vitest';
import { GENOME_TEXT_LENGTH, genomeToBase64url } from '../genome/codec';
import { genesisGenome } from '../genome/genesis';
import { starterGenome } from '../genome/starter';
import type { RemoteView } from '../net/pond-sync';
import { GENOME_DATA_MAX_CHARS } from '../net/protocol';
import { seedFromString } from '../sim/prng';
import { hatchBody } from './body';
import { GENOME_WAIT_MS, RemoteBodies } from './remote-bodies';

const genome = (name: string) => genesisGenome(seedFromString(name));
const view = (genomeRef: number, id = 'a'): RemoteView => ({
  id,
  name: id,
  x: 0,
  y: 0,
  heading: 0,
  radius: 5,
  beat: 0,
  alpha: 1,
  hue: 0.5,
  genomeRef,
  ready: false,
  egg: false,
});

describe('RemoteBodies', () => {
  const g1 = genome('one');
  const g2 = genome('two');
  const b1 = hatchBody(g1);
  const b2 = hatchBody(g2);

  it('fits the genome text in a genome event', () => {
    expect(GENOME_TEXT_LENGTH).toBeLessThanOrEqual(GENOME_DATA_MAX_CHARS);
  });

  it('draws the body only when the snapshot ref matches the genome', () => {
    const bodies = new RemoteBodies();
    expect(bodies.resolve([view(b1.ref)], 0)[0]?.body).toBeNull();
    expect(bodies.add('a', genomeToBase64url(g1))).toBe(true);
    const [drawn] = bodies.resolve([view(b1.ref)], 10);
    expect(drawn?.body?.hash).toBe(b1.hash);
    expect(drawn?.genomeHash).toBe(b1.hash);
    expect(drawn?.species).toBe(b1.species);
    expect(drawn?.id).toBe('a');
    // A ref that matches nothing shows no body for a peer that never had one.
    expect(bodies.resolve([view(b1.ref ^ 1, 'z')], 20)[0]?.body).toBeNull();
  });

  it('keeps the old body for 5 s after the ref changes, then falls back', () => {
    const bodies = new RemoteBodies();
    bodies.add('a', genomeToBase64url(g1));
    expect(bodies.resolve([view(b1.ref)], 0)[0]?.genomeHash).toBe(b1.hash);
    const next = b1.ref ^ 0x00ff;
    expect(bodies.resolve([view(next)], 1000)[0]?.genomeHash).toBe(b1.hash);
    expect(bodies.resolve([view(next)], 1000 + GENOME_WAIT_MS)[0]?.genomeHash).toBe(b1.hash);
    expect(bodies.resolve([view(next)], 1001 + GENOME_WAIT_MS)[0]?.body).toBeNull();
  });

  it('switches to the new body when its genome arrives in time', () => {
    const bodies = new RemoteBodies();
    bodies.add('a', genomeToBase64url(g1));
    bodies.resolve([view(b1.ref)], 0);
    expect(bodies.resolve([view(b2.ref)], 100)[0]?.genomeHash).toBe(b1.hash);
    bodies.add('a', genomeToBase64url(g2));
    expect(bodies.resolve([view(b2.ref)], 200)[0]?.genomeHash).toBe(b2.hash);
    // The late-arriving old ref still resolves for a moment (an out-of-order snapshot).
    expect(bodies.resolve([view(b1.ref)], 300)[0]?.genomeHash).toBe(b1.hash);
  });

  it('counts text that is not a genome and does not throw on odd ones', () => {
    const bodies = new RemoteBodies();
    const hostile = [
      '_'.repeat(GENOME_TEXT_LENGTH),
      'A'.repeat(GENOME_TEXT_LENGTH),
      genomeToBase64url(starterGenome()).slice(0, 100),
      'not a genome',
      '',
    ];
    const accepted = hostile.map((text) => bodies.add('a', text));
    expect(accepted).toEqual([true, true, false, false, false]);
    expect(bodies.dropped).toBe(3);
  });

  it('forgets a peer that left', () => {
    const bodies = new RemoteBodies();
    bodies.add('a', genomeToBase64url(g1));
    bodies.remove('a');
    expect(bodies.resolve([view(b1.ref)], 0)[0]?.body).toBeNull();
  });
});
