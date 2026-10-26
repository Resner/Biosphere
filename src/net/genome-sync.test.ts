import { describe, expect, it } from 'vitest';
import { genomeToBase64url } from '../genome/codec';
import { genesisGenome } from '../genome/genesis';
import { seedFromString } from '../sim/prng';
import { GENOME_MIN_INTERVAL_MS, GenomeSync } from './genome-sync';
import { EVENT_MAX_BYTES, type PeerEvent, parsePeerEvent } from './protocol';

function setup(open: string[] = ['b']) {
  const sent: [string, PeerEvent][] = [];
  const taken: [string, string][] = [];
  const sync = new GenomeSync({
    send: (id, event) => sent.push([id, event]),
    broadcast: (event) => {
      for (const id of open) sent.push([id, event]);
    },
    hasLink: (id) => open.includes(id),
    accept: (id, data) => {
      if (data === 'bad') return false;
      taken.push([id, data]);
      return true;
    },
  });
  return { sync, sent, open, taken };
}

const g = (data: string): PeerEvent => ({ t: 'genome', data });

describe('GenomeSync', () => {
  it('sends the own genome once to a link that opens', () => {
    const { sync, sent } = setup();
    sync.peerOpen('b');
    expect(sent).toEqual([]);
    sync.setOwn('AAAA');
    sent.length = 0;
    sync.peerOpen('b');
    expect(sent).toEqual([['b', g('AAAA')]]);
  });

  it('sends a rehatched genome to every open link', () => {
    const { sync, sent } = setup(['b', 'c']);
    sync.setOwn('AAAA');
    sync.setOwn('BBBB');
    expect(sent).toEqual([
      ['b', g('AAAA')],
      ['c', g('AAAA')],
      ['b', g('BBBB')],
      ['c', g('BBBB')],
    ]);
    sent.length = 0;
    sync.peerOpen('d');
    expect(sent).toEqual([['d', g('BBBB')]]);
  });

  it('takes one genome per peer per 2 s and counts the rest', () => {
    const { sync, taken } = setup(['b', 'c']);
    sync.receive('b', g('AAAA'), 1000);
    sync.receive('b', g('BBBB'), 1000 + GENOME_MIN_INTERVAL_MS - 1);
    expect(sync.dropped).toBe(1);
    // Another peer has its own allowance, and a dropped event does not extend the wait.
    sync.receive('c', g('CCCC'), 1500);
    sync.receive('b', g('BBBB'), 1000 + GENOME_MIN_INTERVAL_MS);
    expect(sync.dropped).toBe(1);
    expect(taken).toEqual([
      ['b', 'AAAA'],
      ['c', 'CCCC'],
      ['b', 'BBBB'],
    ]);
  });

  it('ignores a genome from a peer with no link', () => {
    const { sync, taken } = setup(['b']);
    sync.receive('stranger', g('AAAA'), 0);
    expect(sync.dropped).toBe(1);
    expect(taken).toEqual([]);
  });

  it('does not charge a peer for text that is no genome', () => {
    const { sync, taken } = setup();
    sync.receive('b', g('bad'), 0);
    sync.receive('b', g('AAAA'), 10);
    expect(taken).toEqual([['b', 'AAAA']]);
    expect(sync.dropped).toBe(0);
  });

  it('starts a peer afresh when its link reopens', () => {
    const { sync, taken } = setup();
    sync.receive('b', g('AAAA'), 0);
    sync.peerOpen('b');
    sync.receive('b', g('BBBB'), 10);
    expect(taken.map(([, data]) => data)).toEqual(['AAAA', 'BBBB']);
  });

  it('ignores other events', () => {
    const { sync, taken } = setup();
    sync.receive('b', { t: 'emote', id: 1 }, 0);
    expect(taken).toEqual([]);
    expect(sync.dropped).toBe(0);
  });

  it('fits a real genome in one event', () => {
    const text = genomeToBase64url(genesisGenome(seedFromString('wire')));
    const raw = JSON.stringify(g(text));
    expect(raw.length).toBeLessThan(EVENT_MAX_BYTES);
    expect(parsePeerEvent(raw)).toEqual(g(text));
  });
});
