import { describe, expect, it } from 'vitest';
import { RELAY_KB_MAX } from './protocol';
import { type LinkRead, RelayStats, type RtcStat, selectedPair } from './relay-stats';

// M13 T4: the page's relay report from each link's `getStats()`, with fake stats.

/** A link's stats: a transport naming its selected pair, the pair and its local candidate. */
function statsOf(
  pairs: { id: string; type: string; bytes: number }[],
  selected: string | null,
): RtcStat[] {
  const out: RtcStat[] = [];
  if (selected !== null)
    out.push({ type: 'transport', id: 'T1', selectedCandidatePairId: selected });
  for (const p of pairs) {
    out.push({ type: 'local-candidate', id: `L${p.id}`, candidateType: p.type });
    out.push({ type: 'remote-candidate', id: `R${p.id}`, candidateType: 'host' });
    out.push({
      type: 'candidate-pair',
      id: p.id,
      localCandidateId: `L${p.id}`,
      remoteCandidateId: `R${p.id}`,
      nominated: true,
      state: 'succeeded',
      bytesReceived: p.bytes,
    });
  }
  return out;
}

const link = (
  id: string,
  type: string,
  bytes: number,
  pair = `CP${id}`,
  closed = false,
): LinkRead => ({
  id,
  stats: statsOf([{ id: pair, type, bytes }], pair),
  closed,
});

describe('selectedPair', () => {
  it('follows the transport’s selected pair and its local candidate type', () => {
    const stats = statsOf(
      [
        { id: 'A', type: 'host', bytes: 10 },
        { id: 'B', type: 'relay', bytes: 20 },
      ],
      'B',
    );
    expect(selectedPair(stats)).toEqual({ id: 'B', relay: true, bytes: 20 });
  });

  it('falls back to the nominated pair that succeeded without a transport', () => {
    const stats = statsOf([{ id: 'A', type: 'relay', bytes: 30 }], null);
    expect(selectedPair(stats)).toEqual({ id: 'A', relay: true, bytes: 30 });
    const waiting = stats.map((s) =>
      s.type === 'candidate-pair' ? { ...s, state: 'in-progress' } : s,
    );
    expect(selectedPair(waiting)).toBeNull();
  });

  it('is null with no pair, and reads bad numbers as 0 bytes', () => {
    expect(selectedPair([])).toBeNull();
    const stats = statsOf([{ id: 'A', type: 'host', bytes: Number.NaN }], 'A');
    expect(selectedPair(stats)).toEqual({ id: 'A', relay: false, bytes: 0 });
  });
});

describe('RelayStats', () => {
  it('counts a host pair as a link, not relayed', () => {
    const r = new RelayStats();
    r.read([link('a', 'host', 50_000), link('b', 'srflx', 20_000)]);
    expect(r.take()).toEqual({ links: 2, relayed: 0, kb: 0 });
  });

  it('counts a pair on a local relay candidate with the delta of its bytes', () => {
    const r = new RelayStats();
    r.read([link('a', 'relay', 5_000), link('b', 'host', 9_000)]);
    expect(r.take()).toEqual({ links: 2, relayed: 1, kb: 5 });
    r.read([link('a', 'relay', 12_000), link('b', 'host', 90_000)]);
    expect(r.take()).toEqual({ links: 2, relayed: 1, kb: 7 });
  });

  it('counts a pair that switches from host to relay from the switch', () => {
    const r = new RelayStats();
    r.read([link('a', 'host', 50_000, 'CP1')]);
    expect(r.take()).toEqual({ links: 1, relayed: 0, kb: 0 });
    r.read([
      {
        id: 'a',
        stats: statsOf(
          [
            { id: 'CP1', type: 'host', bytes: 51_000 },
            { id: 'CP2', type: 'relay', bytes: 3_000 },
          ],
          'CP2',
        ),
        closed: false,
      },
    ]);
    expect(r.take()).toEqual({ links: 1, relayed: 1, kb: 3 });
  });

  it('counts what a link closed between two reads had', () => {
    const r = new RelayStats();
    r.read([link('a', 'relay', 4_000)]);
    expect(r.take()).toEqual({ links: 1, relayed: 1, kb: 4 });
    // Closed before the next read: its last stats count once, then it is forgotten.
    r.read([link('a', 'relay', 9_000, 'CPa', true)]);
    expect(r.take()).toEqual({ links: 1, relayed: 1, kb: 5 });
    r.read([]);
    expect(r.take()).toEqual({ links: 0, relayed: 0, kb: 0 });
    // The same peer linked again starts afresh.
    r.read([link('a', 'relay', 2_000)]);
    expect(r.take()).toEqual({ links: 1, relayed: 1, kb: 2 });
  });

  it('counts a counter that restarts from zero', () => {
    const r = new RelayStats();
    r.read([link('a', 'relay', 9_000)]);
    r.take();
    r.read([link('a', 'relay', 2_000)]);
    expect(r.take()).toEqual({ links: 1, relayed: 1, kb: 2 });
  });

  it('totals the reads since the last report: the most links, and every KB', () => {
    const r = new RelayStats();
    expect(r.take()).toBeNull();
    r.read([link('a', 'relay', 1_500), link('b', 'host', 0), link('c', 'host', 0)]);
    r.read([link('a', 'relay', 2_100)]);
    r.read([link('a', 'relay', 2_100), link('d', 'relay', 0)]);
    // 2,100 bytes: 2 KB now, and the 100 left over carries.
    expect(r.take()).toEqual({ links: 3, relayed: 2, kb: 2 });
    expect(r.take()).toBeNull();
    r.read([link('a', 'relay', 3_000)]);
    expect(r.take()).toEqual({ links: 1, relayed: 1, kb: 1 });
  });

  it('keeps a report within the wire’s ranges', () => {
    const r = new RelayStats();
    const many = Array.from({ length: 40 }, (_, i) => link(`p${i}`, 'relay', 1_000_000));
    r.read(many);
    const report = r.take();
    expect(report).toEqual({ links: 32, relayed: 32, kb: RELAY_KB_MAX });
  });
});
