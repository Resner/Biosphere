import type { Flag, Row } from './ledger-types';
import { dayStartOf } from './usage';

// The authority's audit (ADR 0055): one catalogue of the flags it raises, one row per kind and
// creature (or request) however often the same thing repeats, and the counts `GET /v1/audit`
// serves. A creature's flags travel in its proof bundle (`worker/proof.ts`).

/**
 * Every flag kind, where it is raised, and what makes two raises the same row: the request (or the
 * encounter, or the player) it names, or the creature.
 */
export const FLAG_KINDS = {
  /** A request whose `seq` and `prev` don't follow the creature's head (`ledger.ts`). */
  conflict: 'request',
  /** A request naming someone else's creature (`ledger.ts`). */
  'wrong-owner': 'request',
  /**
   * A signed thing used again: an owner-signed request for a head the chain has moved on from
   * (`ledger.ts`), a genesis ask whose creature already came (`lives.ts`), or a mate ask whose
   * nonce a commitment already used (`offspring.ts`).
   */
  replay: 'request',
  /** A death report with no creature of the player's to end, keyed by the player (`lives.ts`). */
  'stray-death': 'request',
  /** A fight whose settlement threw, keyed by the encounter (`settle.ts`). */
  'settle-failed': 'request',
  /** A saved fight that no longer rebuilds, keyed by the encounter (`recover.ts`). */
  'recover-failed': 'request',
  /** A report's biomass past what the genome allows (`life.ts`). */
  'biomass-over-max': 'creature',
  /** A report's biomass past the growth reach since the last record (`life.ts`). */
  'growth-too-fast': 'creature',
  /** A report's energy or health past what its biomass holds (`life.ts`). */
  'energy-over': 'creature',
  'health-over': 'creature',
  /** A report claiming more ticks than the wall time since its connection bound the creature (`life.ts`). */
  'clock-too-fast': 'creature',
  /** A lock-in claim clamped past its tolerance (`life.ts`, through `engage.ts`). */
  'claim-over': 'creature',
  /**
   * A fight, mating or genesis that no witness can see, keyed by its event (`dutyEvent`): its
   * pool was empty when it was committed (`commitWitnesses` in `witness-pool.ts`).
   */
  'authority-only': 'request',
} as const satisfies Record<string, 'request' | 'creature'>;

export type FlagKind = keyof typeof FLAG_KINDS;
export const FLAG_KIND_NAMES = Object.keys(FLAG_KINDS) as FlagKind[];

/** The kinds that are one row per creature: what a report or a lock-in claim can raise (`life.ts`). */
export type CreatureFlag = {
  [K in FlagKind]: (typeof FLAG_KINDS)[K] extends 'creature' ? K : never;
}[FlagKind];
export const CREATURE_FLAGS = FLAG_KIND_NAMES.filter(
  (k): k is CreatureFlag => FLAG_KINDS[k] === 'creature',
);

/** A raise: who, which creature (or ''), the request, encounter or player it is about, and when. */
export interface Raise {
  owner: string;
  creature: string;
  key?: string;
  t: number;
}

/** Counts by kind, every kind of the catalogue present. */
export type FlagCounts = Record<FlagKind, number>;

/** `GET /v1/audit`: counts by kind for the UTC day so far and since the world's renewal, with no ids. */
export interface AuditReport {
  since: number;
  /** The database's size (as the day's usage row records it) against the free plan's limit (ADR 0056). */
  storage: { bytes: number; limit: number };
  day: FlagCounts;
  total: FlagCounts;
}

type Run = (query: string, ...bindings: SqlStorageValue[]) => Row[];

/** The flags table, written through the ledger's own `run`, so its rows count with the ledger's. */
export class Audit {
  constructor(private readonly run: Run) {}

  /** Notes `kind` once: a second raise of the same kind for the same request or creature adds nothing. */
  raise(kind: FlagKind, { owner, creature, key = '', t }: Raise): void {
    const by = FLAG_KINDS[kind] === 'creature' ? 'creature' : 'hash';
    this.run(
      `INSERT INTO flags (kind, owner, creature, hash, t)
       SELECT ?1, ?2, ?3, ?4, ?5 WHERE NOT EXISTS (SELECT 1 FROM flags WHERE kind = ?1 AND ${by} = ?6)`,
      kind,
      owner,
      creature,
      key,
      t,
      by === 'hash' ? key : creature,
    );
  }

  /** The creature a genesis commitment made, or '' (a replayed ask names it, `lives.ts`). */
  creatureOf(commit: string): string {
    const row = this.run(
      `SELECT creature FROM records WHERE seq = 0 AND kind = 'genesis'
       AND json_extract(json, '$.body.commit') = ? LIMIT 1`,
      commit,
    )[0];
    return (row?.creature as string | undefined) ?? '';
  }

  /** A creature's flags, oldest first. */
  flags(creature: string): Flag[] {
    return this.run('SELECT * FROM flags WHERE creature = ? ORDER BY id', creature).map((r) => ({
      kind: r.kind as string,
      owner: r.owner as string,
      creature: r.creature as string,
      hash: r.hash as string,
      t: r.t as number,
    }));
  }

  /** The counts by kind of the flags raised at `since` or later. */
  counts(since: number): FlagCounts {
    const out = Object.fromEntries(FLAG_KIND_NAMES.map((k) => [k, 0])) as FlagCounts;
    for (const r of this.run(
      'SELECT kind, COUNT(*) AS n FROM flags WHERE t >= ? GROUP BY kind',
      since,
    )) {
      const kind = r.kind as string;
      if (Object.hasOwn(FLAG_KINDS, kind)) out[kind as FlagKind] = r.n as number;
    }
    return out;
  }

  /** The audit as `GET /v1/audit` serves it at `now`: since the renewal (`world.reset_at`) and for the UTC day. */
  report(now: number): Omit<AuditReport, 'storage'> {
    const since = (this.run('SELECT reset_at FROM world')[0]?.reset_at as number | undefined) ?? 0;
    return { since, day: this.counts(Math.max(dayStartOf(now), since)), total: this.counts(since) };
  }
}
