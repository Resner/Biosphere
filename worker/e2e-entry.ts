import { Authority as LiveAuthority } from './authority';
import type { BeaconSource } from './beacons';
import { fixtureSource } from './fixture-beacons';

// The Worker for local E2E (`worker/wrangler.e2e.jsonc`): the same code, but drand comes from the
// recorded rounds, so no test touches the network. Never deployed.

export { default } from './index';

export class Authority extends LiveAuthority {
  protected override beaconSource(): BeaconSource {
    return fixtureSource();
  }
}
