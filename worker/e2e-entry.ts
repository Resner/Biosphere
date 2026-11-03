import { isPlayerId } from '../src/ledger/identity';
import { Authority as LiveAuthority } from './authority';
import type { BeaconSource } from './beacons';
import { fixtureSource } from './fixture-beacons';
import live from './index';
import { recoverFights } from './recover';
import { type Session, sessionOf } from './socket';

// The Worker for local E2E (`worker/wrangler.e2e.jsonc`): the same code, but drand comes from the
// recorded rounds, so no test touches the network. Never deployed.

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
    recoverFights(this, this.clock.now());
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
    return live.fetch(request, env);
  },
} satisfies ExportedHandler<Env>;
