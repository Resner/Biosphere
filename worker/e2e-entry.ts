import { Authority as LiveAuthority } from './authority';
import type { BeaconSource } from './beacons';
import { fixtureSource } from './fixture-beacons';
import live from './index';

// The Worker for local E2E (`worker/wrangler.e2e.jsonc`): the same code, but drand comes from the
// recorded rounds, so no test touches the network. Never deployed.

const PLAYER_ID_RE = /^[A-Za-z0-9_-]{43}$/;

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
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const { pathname } = new URL(request.url);
    if (pathname === '/v1/e2e/pre-reset' && request.method === 'POST') {
      const { playerId } = (await request.json().catch(() => ({}))) as { playerId?: unknown };
      if (typeof playerId !== 'string' || !PLAYER_ID_RE.test(playerId)) {
        return new Response('bad player', { status: 400 });
      }
      const stub = env.AUTHORITY.get(env.AUTHORITY.idFromName('global')) as unknown as {
        preReset(id: string): Promise<void>;
      };
      await stub.preReset(playerId);
      return new Response(null, { status: 204 });
    }
    return live.fetch(request, env);
  },
} satisfies ExportedHandler<Env>;
