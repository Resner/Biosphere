import { RELAY_KB_MAX, RELAY_LINKS_MAX, type RelayReport } from './protocol-defs';

// The page's relay report (M13 T4, ADR 0067), pure: from each link's `getStats()`, the links held,
// those whose selected candidate pair runs over a local TURN relay candidate, and the bytes received
// over those pairs since the last read. `LifeFlow.report` carries the totals of the reads since its
// last report, which the authority clamps and meters. No DOM: the mesh hands the stats in.

/** How often the page reads its links' stats while it holds any. */
export const RELAY_READ_MS = 10_000;
/** A KB as Cloudflare bills it. */
const KB = 1000;

/** One entry of an `RTCStatsReport`. */
export interface RtcStat {
  readonly type: string;
  readonly id: string;
  readonly [key: string]: unknown;
}

/** One link's stats: an open link's now, or a closed link's last (read as it closed). */
export interface LinkRead {
  id: string;
  stats: readonly RtcStat[];
  closed: boolean;
}

/** A link's selected candidate pair: its id, whether its local candidate is a relay, its bytes received. */
export interface SelectedPair {
  id: string;
  relay: boolean;
  bytes: number;
}

const bytesOf = (v: unknown): number =>
  typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0;

/**
 * The pair the transport selected (`selectedCandidatePairId`), else the nominated pair that
 * succeeded (or one a browser marks `selected`); null before one is.
 */
export function selectedPair(stats: readonly RtcStat[]): SelectedPair | null {
  const byId = new Map<string, RtcStat>();
  let chosen: string | null = null;
  for (const s of stats) {
    byId.set(s.id, s);
    if (s.type === 'transport' && typeof s.selectedCandidatePairId === 'string')
      chosen ??= s.selectedCandidatePairId;
  }
  let pair = chosen === null ? undefined : byId.get(chosen);
  if (pair?.type !== 'candidate-pair') {
    pair = stats.find(
      (s) =>
        s.type === 'candidate-pair' &&
        (s.selected === true || (s.nominated === true && s.state === 'succeeded')),
    );
  }
  if (!pair) return null;
  const local = typeof pair.localCandidateId === 'string' ? byId.get(pair.localCandidateId) : null;
  return {
    id: pair.id,
    relay: local?.candidateType === 'relay',
    bytes: bytesOf(pair.bytesReceived),
  };
}

/** The reads since the last report: the most links and relayed links of any read, and the bytes. */
interface Totals {
  links: number;
  relayed: number;
  bytes: number;
}

export class RelayStats {
  /** Each link's pairs and the bytes each had at the last read, so a read counts only what is new. */
  private readonly seen = new Map<string, Map<string, number>>();
  private totals: Totals | null = null;
  /** Bytes under a whole KB, carried to the next report. */
  private carry = 0;

  /** Counts one read of the links: open ones now, and the last stats of those closed since. */
  read(links: readonly LinkRead[]): void {
    let held = 0;
    let relayed = 0;
    let bytes = 0;
    const present = new Set<string>();
    for (const link of links) {
      const pair = selectedPair(link.stats);
      held++;
      if (!link.closed) present.add(link.id);
      if (!pair) {
        if (link.closed) this.seen.delete(link.id);
        continue;
      }
      let pairs = this.seen.get(link.id);
      if (!pairs) {
        pairs = new Map();
        this.seen.set(link.id, pairs);
      }
      const before = pairs.get(pair.id);
      // A new pair counts from its start (a switch); a counter that went back has restarted.
      const delta = before === undefined || pair.bytes < before ? pair.bytes : pair.bytes - before;
      pairs.set(pair.id, pair.bytes);
      if (pair.relay) {
        relayed++;
        bytes += delta;
      }
      if (link.closed) this.seen.delete(link.id);
    }
    // A link gone without its last stats counts what it had at the last read.
    for (const id of [...this.seen.keys()]) if (!present.has(id)) this.seen.delete(id);
    const t = this.totals ?? { links: 0, relayed: 0, bytes: 0 };
    this.totals = {
      links: Math.max(t.links, held),
      relayed: Math.max(t.relayed, relayed),
      bytes: t.bytes + bytes,
    };
  }

  /** The totals of the reads since the last call, within the wire's ranges; null with no read. */
  take(): RelayReport | null {
    const t = this.totals;
    if (!t) return null;
    this.totals = null;
    const bytes = t.bytes + this.carry;
    const kb = Math.floor(bytes / KB);
    this.carry = kb > RELAY_KB_MAX ? 0 : bytes - kb * KB;
    const links = Math.min(RELAY_LINKS_MAX, t.links);
    return { links, relayed: Math.min(links, t.relayed), kb: Math.min(RELAY_KB_MAX, kb) };
  }
}
