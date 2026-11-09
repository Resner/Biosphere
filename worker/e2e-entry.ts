import { isPlayerId } from '../src/ledger/identity';
import { parseDutyEvent } from '../src/ledger/witness';
import { Authority as LiveAuthority } from './authority';
import type { BeaconSource } from './beacons';
import { type WitnessView, witnessView } from './duty';
import { fixtureSource } from './fixture-beacons';
import live from './index';
import { consistent, type Inconsistency } from './interrupt-kit';
import { HATCH_BUCKET } from './ledger-types';
import { recoverFights } from './recover';
import { type Session, socketsOf } from './socket';
import {
  armCrowds,
  type DirectoryView,
  directoryView,
  rebuildCrowds,
  rebuildDirectory,
} from './where';

// The Worker for local E2E (`worker/wrangler.e2e.jsonc`): the same code, but drand comes from the
// recorded rounds, so no test touches the network. Never deployed.

/** A fight's state as `GET /v1/e2e/encounter/<id>` answers it. */
interface EncounterState {
  open: boolean;
  frames: number;
  settled: boolean;
}

/** One seated session as `GET /v1/e2e/sessions` shows it (M13 T7). */
export interface SeatedView {
  id: string;
  name: string;
  /** Wall time the socket opened. */
  seatedAt: number;
  /** Messages the object received on this socket. */
  received: number;
  /** The same by `ClientMsg['t']` (`bad` for one that does not parse). */
  byType: Record<string, number>;
}

const ENCOUNTER_PATH = '/v1/e2e/encounter/';
const WITNESS_PATH = '/v1/e2e/witness/';

export class Authority extends LiveAuthority {
  /**
   * The wall time the recorded rounds stand still at while a scenario holds them (M14 T4); unset,
   * they run on. Read lazily: the base constructor asks for the source before this field is set.
   */
  private heldAt: number | null = null;

  protected override beaconSource(): BeaconSource {
    return fixtureSource(Date.now(), () => this.heldAt ?? Date.now());
  }

  /**
   * Holds the recorded rounds where they are, or lets them run on (M14 T4): a commitment made while
   * held waits for its round however long a scenario takes to reopen a page, and on release the
   * rounds catch up with the wall clock at once.
   */
  async holdBeacons(hold: boolean): Promise<void> {
    this.heldAt = hold ? (this.heldAt ?? Date.now()) : null;
    await this.rearm();
  }

  /** Sets a player's hatch bucket to `left` hatches, refilling from now (M14 T4). */
  setHatches(playerId: string, left: number): void {
    const now = Date.now();
    this.sql.exec(
      `INSERT INTO players (id, first_seen, last_seen, hatches, hatch_t) VALUES (?1, ?2, ?2, ?3, ?2)
       ON CONFLICT (id) DO UPDATE SET hatches = ?3, hatch_t = ?2`,
      playerId,
      now,
      left,
    );
  }

  /** Messages received by each socket, for `sessions()`; memory only. */
  private readonly receivedBy = new WeakMap<WebSocket, Record<string, number>>();

  override webSocketMessage(ws: WebSocket, data: string | ArrayBuffer): void {
    const counts = this.receivedBy.get(ws) ?? {};
    this.receivedBy.set(ws, counts);
    const type = typeof data === 'string' ? /^\{"t":"([a-z0-9_-]+)"/.exec(data)?.[1] : undefined;
    counts[type ?? 'other'] = (counts[type ?? 'other'] ?? 0) + 1;
    super.webSocketMessage(ws, data);
  }

  /** Each seated session with its count of received messages, for a load run to check against the meter (M13 T7). */
  sessions(): SeatedView[] {
    const out: SeatedView[] = [];
    for (const [ws, s] of socketsOf(this)) {
      if (s?.phase !== 'active') continue;
      const byType = { ...this.receivedBy.get(ws) };
      out.push({
        id: s.playerId,
        name: s.name,
        seatedAt: s.openedAt,
        received: Object.values(byType).reduce((n, c) => n + c, 0),
        byType,
      });
    }
    return out;
  }

  /** Sets today's request-equivalents, so a scenario can spend or refill the day's budget (M13 T12). */
  setUsage(requests: number): void {
    this.usage.setRequests(Date.now(), requests);
  }

  /** Messages dropped without closing the socket, by type (the cost check, M13 T7). */
  droppedByType(): Record<string, number> {
    return Object.fromEntries(this.dropped);
  }

  /**
   * Makes an identity look as if it had played before the world renewal (M6c T2): `wrangler dev`
   * always starts migrated, so a returning player is otherwise impossible to stage.
   */
  preReset(playerId: string): void {
    this.ctx.storage.sql.exec(
      `INSERT INTO players (id, first_seen, last_seen)
         SELECT ?1, reset_at - 1, reset_at - 1 FROM world WHERE true
       ON CONFLICT (id) DO UPDATE SET first_seen = excluded.first_seen, epoch_seen = 0`,
      playerId,
    );
  }

  /**
   * Acts out an authority restart (M8 T5): every socket is closed with 1012 (as a deploy closes
   * them, with no handler of this object running for them), the in-memory fights and locks are
   * discarded, and the open fights are rebuilt from their saved logs as a new object would.
   */
  restart(): void {
    for (const [ws, session] of socketsOf(this)) {
      if (session) ws.serializeAttachment({ ...session, phase: 'retired' } satisfies Session);
      try {
        ws.close(1012, 'restart');
      } catch {
        // already closed
      }
    }
    // The indexes are rebuilt as a new object would (now empty).
    this.rebuildSeats();
    this.fights.clear();
    // Every duty ends with the memory that held it (ADR 0058).
    this.duties.clear();
    // ... and so does the directory: a new object rebuilds it from the attachments (now none).
    this.directory = rebuildDirectory(this);
    this.crowds = rebuildCrowds(this);
    this.crowdsKept.clear();
    armCrowds(this);
    recoverFights(this, this.clock.now());
  }

  /** The directory for a scenario to read (M11 T6): the leaves, each member's leaf, report and instance, the relays by pair, the crowds (M12 T5). */
  directoryState(): DirectoryView {
    return directoryView(this);
  }

  /**
   * A fight's state for a scenario to wait on (M8 T9): whether its row is open, the frames final so
   * far and whether its settlement is stored; null for an unknown fight.
   */
  encounter(id: string): EncounterState | null {
    const row = this.fightStore.read(id);
    if (!row) return null;
    const running = this.fights.get(id)?.fight;
    return {
      open: row.open,
      frames: running ? running.referee.next : row.persisted,
      settled: row.settlement !== null,
    };
  }

  /** The invariants every interrupted transaction must leave, for a scenario or a soak to read (M14 T13); empty when they hold. */
  consistency(): Inconsistency[] {
    return consistent(this);
  }

  /** An event's witnesses for a scenario to wait on (M10 T4); null without a witness commitment. */
  witness(event: string): WitnessView | null {
    return witnessView(this, event);
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const { pathname } = new URL(request.url);
    if (pathname === '/v1/e2e/pre-reset' && request.method === 'POST') {
      const { playerId } = (await request.json().catch(() => ({}))) as { playerId?: unknown };
      if (typeof playerId !== 'string' || !isPlayerId(playerId)) {
        return new Response('bad player', { status: 400 });
      }
      const stub = env.AUTHORITY.get(env.AUTHORITY.idFromName('global')) as unknown as {
        preReset(id: string): Promise<void>;
      };
      await stub.preReset(playerId);
      return new Response(null, { status: 204 });
    }
    if (pathname === '/v1/e2e/hatches' && request.method === 'POST') {
      const { player, left } = (await request.json().catch(() => ({}))) as {
        player?: unknown;
        left?: unknown;
      };
      if (typeof player !== 'string' || !isPlayerId(player)) {
        return new Response('bad player', { status: 400 });
      }
      if (typeof left !== 'number' || !Number.isInteger(left) || left < 0 || left > HATCH_BUCKET) {
        return new Response('bad left', { status: 400 });
      }
      const stub = env.AUTHORITY.get(env.AUTHORITY.idFromName('global')) as unknown as {
        setHatches(id: string, left: number): Promise<void>;
      };
      await stub.setHatches(player, left);
      return new Response(null, { status: 204 });
    }
    if (pathname === '/v1/e2e/beacons' && request.method === 'POST') {
      const { hold } = (await request.json().catch(() => ({}))) as { hold?: unknown };
      if (typeof hold !== 'boolean') return new Response('bad hold', { status: 400 });
      const stub = env.AUTHORITY.get(env.AUTHORITY.idFromName('global')) as unknown as {
        holdBeacons(hold: boolean): Promise<void>;
      };
      await stub.holdBeacons(hold);
      return new Response(null, { status: 204 });
    }
    if (pathname === '/v1/e2e/restart' && request.method === 'POST') {
      const stub = env.AUTHORITY.get(env.AUTHORITY.idFromName('global')) as unknown as {
        restart(): Promise<void>;
      };
      await stub.restart();
      return new Response(null, { status: 204 });
    }
    if (pathname === '/v1/e2e/metrics' && request.method === 'GET') {
      // `/v1/metrics`'s answer, uncached, for scenarios to read.
      const stub = env.AUTHORITY.get(env.AUTHORITY.idFromName('global')) as unknown as {
        metrics(): Promise<unknown>;
      };
      return Response.json(await stub.metrics());
    }
    if (pathname === '/v1/e2e/sessions' && request.method === 'GET') {
      const stub = env.AUTHORITY.get(env.AUTHORITY.idFromName('global')) as unknown as {
        sessions(): Promise<SeatedView[]>;
      };
      return Response.json(await stub.sessions());
    }
    if (pathname === '/v1/e2e/usage' && request.method === 'POST') {
      const { requests } = (await request.json().catch(() => ({}))) as { requests?: unknown };
      if (typeof requests !== 'number' || !Number.isFinite(requests) || requests < 0) {
        return new Response('bad requests', { status: 400 });
      }
      const stub = env.AUTHORITY.get(env.AUTHORITY.idFromName('global')) as unknown as {
        setUsage(requests: number): Promise<void>;
      };
      await stub.setUsage(requests);
      return new Response(null, { status: 204 });
    }
    if (pathname === '/v1/e2e/consistency' && request.method === 'GET') {
      const stub = env.AUTHORITY.get(env.AUTHORITY.idFromName('global')) as unknown as {
        consistency(): Promise<Inconsistency[]>;
      };
      return Response.json(await stub.consistency());
    }
    if (pathname === '/v1/e2e/dropped' && request.method === 'GET') {
      const stub = env.AUTHORITY.get(env.AUTHORITY.idFromName('global')) as unknown as {
        droppedByType(): Promise<Record<string, number>>;
      };
      return Response.json(await stub.droppedByType());
    }
    if (pathname === '/v1/e2e/audit' && request.method === 'GET') {
      // `/v1/audit`'s answer, uncached (the public one is cached at the edge for 5 minutes).
      const stub = env.AUTHORITY.get(env.AUTHORITY.idFromName('global')) as unknown as {
        audit(): Promise<unknown>;
      };
      return Response.json(await stub.audit());
    }
    if (pathname === '/v1/e2e/directory' && request.method === 'GET') {
      const stub = env.AUTHORITY.get(env.AUTHORITY.idFromName('global')) as unknown as {
        directoryState(): Promise<DirectoryView>;
      };
      return Response.json(await stub.directoryState());
    }
    const enc = pathname.startsWith(ENCOUNTER_PATH) ? pathname.slice(ENCOUNTER_PATH.length) : '';
    if (/^[0-9a-f]{64}$/.test(enc) && request.method === 'GET') {
      const stub = env.AUTHORITY.get(env.AUTHORITY.idFromName('global')) as unknown as {
        encounter(id: string): Promise<EncounterState | null>;
      };
      const state = await stub.encounter(enc);
      return state ? Response.json(state) : new Response('no such encounter', { status: 404 });
    }
    const event = pathname.startsWith(WITNESS_PATH)
      ? decodeURIComponent(pathname.slice(WITNESS_PATH.length))
      : '';
    if (parseDutyEvent(event) && request.method === 'GET') {
      const stub = env.AUTHORITY.get(env.AUTHORITY.idFromName('global')) as unknown as {
        witness(event: string): Promise<WitnessView | null>;
      };
      const state = await stub.witness(event);
      return state ? Response.json(state) : new Response('no such event', { status: 404 });
    }
    return live.fetch(request, env);
  },
} satisfies ExportedHandler<Env>;
