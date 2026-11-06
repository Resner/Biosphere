import { isPlayerId } from '../src/ledger/identity';
import { parseDutyEvent } from '../src/ledger/witness';
import { Authority as LiveAuthority } from './authority';
import type { BeaconSource } from './beacons';
import { type WitnessView, witnessView } from './duty';
import { fixtureSource } from './fixture-beacons';
import live from './index';
import { recoverFights } from './recover';
import { type Session, sessionOf } from './socket';

// The Worker for local E2E (`worker/wrangler.e2e.jsonc`): the same code, but drand comes from the
// recorded rounds, so no test touches the network. Never deployed.

/** A fight's state as `GET /v1/e2e/encounter/<id>` answers it. */
interface EncounterState {
  open: boolean;
  frames: number;
  settled: boolean;
}

const ENCOUNTER_PATH = '/v1/e2e/encounter/';
const WITNESS_PATH = '/v1/e2e/witness/';

export class Authority extends LiveAuthority {
  protected override beaconSource(): BeaconSource {
    return fixtureSource();
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
    for (const ws of this.ctx.getWebSockets()) {
      const session = sessionOf(ws);
      if (session) ws.serializeAttachment({ ...session, phase: 'retired' } satisfies Session);
      try {
        ws.close(1012, 'restart');
      } catch {
        // already closed
      }
    }
    this.fights.clear();
    // Every duty ends with the memory that held it (ADR 0058).
    this.duties.clear();
    recoverFights(this, this.clock.now());
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
    if (pathname === '/v1/e2e/restart' && request.method === 'POST') {
      const stub = env.AUTHORITY.get(env.AUTHORITY.idFromName('global')) as unknown as {
        restart(): Promise<void>;
      };
      await stub.restart();
      return new Response(null, { status: 204 });
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
